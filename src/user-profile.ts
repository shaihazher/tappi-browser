/**
 * user-profile.ts — Two-layer user profile system.
 *
 * Layer 1 (Phase 9.096c): User-written plain text (~750 words max).
 *   Storage: ~/.tappi-browser/user-profile.txt (profile-aware)
 *   Editable in Settings "My Profile" tab or via agent update_user_profile tool.
 *   Always injected into agent system prompt.
 *
 * Layer 2 (Phase 8.4.2): Auto-generated JSON from browsing data (~200 tokens).
 *   Storage: ~/.tappi-browser/user_profile.json (profile-aware)
 *   Only injected when agentBrowsingDataAccess is enabled.
 */

import { generateText, streamText } from 'ai';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import {
  createModel,
  buildProviderOptions,
  withCodexProviderOptions,
  logProviderRequestError,
  type LLMConfig,
} from './llm-client';

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

// ─── Layer 1: User-written profile text (Phase 9.096c) ───

const MAX_PROFILE_WORDS = 750;

/**
 * Get the path for user-written profile text (profile-aware).
 */
export function getUserProfileTxtPath(): string {
  try {
    const { profileManager } = require('./profile-manager');
    const jsonPath = profileManager.getUserProfilePath();
    return path.join(path.dirname(jsonPath), 'user-profile.txt');
  } catch {
    return path.join(CONFIG_DIR, 'user-profile.txt');
  }
}

/**
 * Load user-written profile text. Returns empty string if not found.
 */
export function loadUserProfileTxt(): string {
  try {
    const p = getUserProfileTxtPath();
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf-8').trim();
  } catch {
    return '';
  }
}

/**
 * Save user-written profile text. Returns word count.
 */
export function saveUserProfileTxt(text: string): { success: boolean; wordCount: number; error?: string } {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount > MAX_PROFILE_WORDS) {
    return { success: false, wordCount, error: `Profile exceeds ${MAX_PROFILE_WORDS} word limit (${wordCount} words).` };
  }
  try {
    const p = getUserProfileTxtPath();
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, text);
    console.log(`[user-profile] Saved user-profile.txt (${wordCount} words)`);
    return { success: true, wordCount };
  } catch (e: any) {
    return { success: false, wordCount, error: e?.message || 'Failed to save' };
  }
}

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
 * Phase 9.096c: Supports granular toggles for history and bookmarks.
 */
function getBrowsingDataSummary(db: Database.Database, options?: { history?: boolean; bookmarks?: boolean }): string | null {
  try {
    const includeHistory = options?.history !== false;
    const includeBookmarks = options?.bookmarks !== false;
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    let topByFrequency: Array<{ domain: string; cnt: number; title: string }> = [];
    let recentVisits: Array<{ url: string; title: string; domain: string; visit_time: number }> = [];
    let bookmarks: Array<{ url: string; title: string; folder: string }> = [];

    if (includeHistory) {
      // Top 100 by frequency (domain visit count)
      topByFrequency = db.prepare(`
        SELECT domain, COUNT(*) as cnt, MAX(title) as title
        FROM history
        WHERE visit_time > ? AND domain != ''
        GROUP BY domain
        ORDER BY cnt DESC
        LIMIT 100
      `).all(sevenDaysAgo) as typeof topByFrequency;

      // Top 50 most recent
      recentVisits = db.prepare(`
        SELECT url, title, domain, visit_time
        FROM history
        WHERE visit_time > ? AND domain != ''
        ORDER BY visit_time DESC
        LIMIT 50
      `).all(sevenDaysAgo) as typeof recentVisits;
    }

    if (includeBookmarks) {
      bookmarks = db.prepare(`
        SELECT url, title, folder FROM bookmarks ORDER BY created_at DESC LIMIT 100
      `).all() as typeof bookmarks;
    }

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
export async function generateProfile(db: Database.Database, llmConfig: LLMConfig, enrichOptions?: { history?: boolean; bookmarks?: boolean }): Promise<UserProfile | null> {
  console.log('[user-profile] Starting profile generation...');

  const browsingData = getBrowsingDataSummary(db, enrichOptions);
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
    // Route to CLI for claude-code provider (all auth methods)
    if (llmConfig.provider === 'claude-code') {
      const { generateProfileViaCli } = await import('./claude-code-provider');
      const runViaCli = async (p: string) => generateProfileViaCli(p, llmConfig.apiKey, llmConfig.model);
      let text = await runViaCli(basePrompt);
      if (!text) return null;
      text = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      let parsed: any;
      try { parsed = JSON.parse(text); } catch {
        // Retry with strict prompt
        text = await runViaCli(strictPrompt);
        if (!text) return null;
        text = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        parsed = JSON.parse(text);
      }
      const profile: UserProfile = {
        interests: parsed.interests || [],
        frequent_sites: parsed.frequent_sites || [],
        work_context: parsed.work_context || '',
        preferred_sources: parsed.preferred_sources || [],
        shopping_patterns: parsed.shopping_patterns || [],
        locale_hints: parsed.locale_hints || [],
        updated_at: new Date().toISOString(),
      };
      const savePath = getUserProfilePath();
      const saveDir = path.dirname(savePath);
      if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
      fs.writeFileSync(savePath, JSON.stringify(profile, null, 2));
      console.log('[user-profile] Profile saved via CLI to', savePath);
      return profile;
    }

    const model = createModel(llmConfig);
    const providerOptions = buildProviderOptions(llmConfig);
    const callProviderOptions: Record<string, any> = withCodexProviderOptions(
      llmConfig.provider,
      { ...providerOptions },
      'Return concise JSON only. No markdown.',
      'Return concise JSON only. No markdown.',
    );

    const runProfilePrompt = async (prompt: string): Promise<string> => {
      if (llmConfig.provider === 'openai-codex') {
        const result = streamText({
          model,
          messages: [{ role: 'user', content: prompt }],
          ...(Object.keys(callProviderOptions).length > 0 ? { providerOptions: callProviderOptions } : {}),
        });
        let out = '';
        for await (const chunk of result.textStream) out += chunk;
        return out;
      }

      const generated = await generateText({
        model,
        prompt,
        maxOutputTokens: 30000, // universal cap
        ...(Object.keys(callProviderOptions).length > 0 ? { providerOptions: callProviderOptions } : {}),
      });
      return generated.text;
    };

    // First attempt
    let text = await runProfilePrompt(basePrompt);

    text = text.trim();

    // Strip markdown code fences if present
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    // Validate JSON
    let parsed: UserProfile;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.warn('[user-profile] LLM output is not valid JSON, retrying with strict prompt');
      const retryTextRaw = await runProfilePrompt(strictPrompt);
      let retryText = retryTextRaw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
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
      const retryTextRaw = await runProfilePrompt(strictPrompt);
      let retryText = retryTextRaw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
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
    if (llmConfig.provider === 'openai-codex') {
      logProviderRequestError('user-profile.generate', e);
    } else {
      console.error('[user-profile] Generation failed:', e?.message || e);
    }
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
  enrichOptions?: { history?: boolean; bookmarks?: boolean },
): void {
  // Defer to not block browser startup
  setTimeout(async () => {
    try {
      const existing = loadProfile();
      if (existing && !isStale(existing)) {
        console.log('[user-profile] Profile is fresh, skipping update');
        return;
      }
      await generateProfile(db, llmConfig, enrichOptions);
    } catch (e: any) {
      console.error('[user-profile] Scheduled update failed (non-fatal):', e?.message || e);
    }
  }, 5000); // 5-second delay — browser fully ready before we hit the LLM
}
