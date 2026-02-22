/**
 * user-profile.ts — Agent-generated user profile for passive context injection.
 *
 * Phase 8.4.2: When agentBrowsingDataAccess is enabled, generate a compact
 * ≤200-token user profile JSON from browsing history + bookmarks, and inject
 * it into the agent system prompt for passive context.
 *
 * Storage: ~/.tappi-browser/user_profile.json
 */

import { generateText } from 'ai';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { createModel, type LLMConfig } from './llm-client';

const CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.tappi-browser');

function getUserProfilePath(): string {
  try {
    const { profileManager } = require('./profile-manager');
    return profileManager.getUserProfilePath();
  } catch {
    return path.join(CONFIG_DIR, 'user_profile.json');
  }
}

// PROFILE_PATH kept for backward compat in deleteProfile()
const PROFILE_PATH = path.join(CONFIG_DIR, 'user_profile.json');

// Rough token estimate: 1 token ≈ 4 chars
const MAX_TOKENS = 200;
const MAX_CHARS = MAX_TOKENS * 4;

export interface UserProfile {
  interests: string[];
  frequent_sites: string[];
  work_context: string;
  preferred_sources: string[];
  shopping_patterns: string[];
  locale_hints: string[];
  updated_at: string;
}

/**
 * Load the user profile from disk. Returns null if not found or invalid.
 */
export function loadProfile(): UserProfile | null {
  try {
    const profilePath = getUserProfilePath();
    if (!fs.existsSync(profilePath)) return null;
    const raw = fs.readFileSync(profilePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed.updated_at) return null;
    return parsed as UserProfile;
  } catch (e) {
    console.error('[user-profile] Failed to load profile:', e);
    return null;
  }
}

/**
 * Check if the profile is stale (older than 24 hours).
 */
export function isStale(profile: UserProfile): boolean {
  const updated = new Date(profile.updated_at).getTime();
  const now = Date.now();
  return now - updated > 24 * 60 * 60 * 1000;
}

/**
 * Delete the user profile file (called when privacy is turned off).
 */
export function deleteProfile(): void {
  try {
    const profilePath = getUserProfilePath();
    if (fs.existsSync(profilePath)) {
      fs.unlinkSync(profilePath);
      console.log('[user-profile] Profile deleted (browsing data access disabled)');
    }
  } catch (e) {
    console.error('[user-profile] Failed to delete profile:', e);
  }
}

/**
 * Estimate token count for a string (~4 chars per token).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Query browsing data and format it for the LLM.
 */
function getBrowsingDataSummary(db: Database.Database): string | null {
  try {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    // Top 100 by frequency (domain visit count)
    const topByFrequency = db.prepare(`
      SELECT domain, COUNT(*) as cnt, MAX(title) as title
      FROM history
      WHERE visit_time > ? AND domain != ''
      GROUP BY domain
      ORDER BY cnt DESC
      LIMIT 100
    `).all(sevenDaysAgo) as Array<{ domain: string; cnt: number; title: string }>;

    // Top 50 most recent
    const recentVisits = db.prepare(`
      SELECT url, title, domain, visit_time
      FROM history
      WHERE visit_time > ? AND domain != ''
      ORDER BY visit_time DESC
      LIMIT 50
    `).all(sevenDaysAgo) as Array<{ url: string; title: string; domain: string; visit_time: number }>;

    // All bookmarks
    const bookmarks = db.prepare(`
      SELECT url, title, folder FROM bookmarks ORDER BY created_at DESC LIMIT 100
    `).all() as Array<{ url: string; title: string; folder: string }>;

    // If no data at all, skip generation
    if (topByFrequency.length === 0 && recentVisits.length === 0 && bookmarks.length === 0) {
      return null;
    }

    const parts: string[] = [];

    if (topByFrequency.length > 0) {
      const freqList = topByFrequency
        .slice(0, 30)
        .map(r => `${r.domain}(${r.cnt})`)
        .join(', ');
      parts.push(`Frequent domains (last 7d): ${freqList}`);
    }

    if (recentVisits.length > 0) {
      const recentList = recentVisits
        .slice(0, 20)
        .map(r => `${r.title || r.domain}: ${r.url}`)
        .join('\n');
      parts.push(`Recent visits:\n${recentList}`);
    }

    if (bookmarks.length > 0) {
      const bkList = bookmarks
        .slice(0, 30)
        .map(r => `${r.title || r.url}${r.folder ? ` [${r.folder}]` : ''}`)
        .join('\n');
      parts.push(`Bookmarks:\n${bkList}`);
    }

    return parts.join('\n\n');
  } catch (e) {
    console.error('[user-profile] Failed to query browsing data:', e);
    return null;
  }
}

/**
 * Generate the user profile by sending browsing data to the LLM.
 * Saves the result to ~/.tappi-browser/user_profile.json.
 */
export async function generateProfile(db: Database.Database, llmConfig: LLMConfig): Promise<UserProfile | null> {
  console.log('[user-profile] Starting profile generation...');

  const browsingData = getBrowsingDataSummary(db);
  if (!browsingData) {
    console.log('[user-profile] No browsing data available, skipping generation');
    return null;
  }

  const basePrompt = `Analyze this browsing data and produce a compact user profile JSON (≤200 tokens). Include: interests, frequent_sites (top 5 domains), work_context, preferred_sources, shopping_patterns, locale_hints. Be extremely concise — short arrays, no verbose descriptions. Output ONLY raw JSON, no markdown.

Required shape:
{"interests":[],"frequent_sites":[],"work_context":"","preferred_sources":[],"shopping_patterns":[],"locale_hints":[],"updated_at":"${new Date().toISOString()}"}

Browsing data:
${browsingData}`;

  const strictPrompt = basePrompt + '\n\nCRITICAL: Output must be under 200 tokens. Use very short values. No explanations.';

  try {
    const model = createModel(llmConfig);

    // First attempt
    let { text } = await generateText({
      model,
      prompt: basePrompt,
      maxOutputTokens: 400, // Allow room but validate after
    });

    text = text.trim();

    // Strip markdown code fences if present
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    // Validate JSON
    let parsed: UserProfile;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.warn('[user-profile] LLM output is not valid JSON, retrying with strict prompt');
      const retry = await generateText({ model, prompt: strictPrompt, maxOutputTokens: 300 });
      let retryText = retry.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      try {
        parsed = JSON.parse(retryText);
      } catch {
        console.error('[user-profile] Retry also failed JSON parse, aborting');
        return null;
      }
    }

    // Check token count
    const profileStr = JSON.stringify(parsed);
    if (estimateTokens(profileStr) > MAX_TOKENS) {
      console.warn('[user-profile] Profile exceeds 200 tokens, retrying with strict constraint');
      const retry = await generateText({ model, prompt: strictPrompt, maxOutputTokens: 300 });
      let retryText = retry.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      try {
        parsed = JSON.parse(retryText);
      } catch {
        console.error('[user-profile] Strict retry failed JSON parse, using truncated original');
        // Fall through with original parsed — better than nothing
      }
    }

    // Ensure updated_at is set
    parsed.updated_at = new Date().toISOString();

    // Ensure all required fields exist
    const profile: UserProfile = {
      interests: parsed.interests || [],
      frequent_sites: parsed.frequent_sites || [],
      work_context: parsed.work_context || '',
      preferred_sources: parsed.preferred_sources || [],
      shopping_patterns: parsed.shopping_patterns || [],
      locale_hints: parsed.locale_hints || [],
      updated_at: parsed.updated_at,
    };

    // Save to disk (profile-relative path)
    const savePath = getUserProfilePath();
    const saveDir = path.dirname(savePath);
    if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
    fs.writeFileSync(savePath, JSON.stringify(profile, null, 2));
    console.log('[user-profile] Profile saved to', savePath, '(~' + estimateTokens(JSON.stringify(profile)) + ' tokens)');

    return profile;
  } catch (e: any) {
    console.error('[user-profile] Generation failed:', e?.message || e);
    return null;
  }
}

/**
 * Schedule a non-blocking profile update on startup.
 * Only runs if agentBrowsingDataAccess is true and the profile is stale.
 * Fire-and-forget — browser must be usable immediately.
 */
export function scheduleProfileUpdate(
  db: Database.Database,
  llmConfig: LLMConfig,
): void {
  // Defer to not block browser startup
  setTimeout(async () => {
    try {
      const existing = loadProfile();
      if (existing && !isStale(existing)) {
        console.log('[user-profile] Profile is fresh, skipping update');
        return;
      }
      await generateProfile(db, llmConfig);
    } catch (e: any) {
      console.error('[user-profile] Scheduled update failed (non-fatal):', e?.message || e);
    }
  }, 5000); // 5-second delay — browser fully ready before we hit the LLM
}
