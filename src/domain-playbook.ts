/**
 * domain-playbook.ts — Domain-level playbooks for structural learning across sessions.
 *
 * Captures domain-specific learnings (URL patterns, UI quirks, workarounds) in SQLite
 * and injects them into future sessions when the agent navigates to that domain.
 */

import { generateText } from 'ai';
import { createModel, buildProviderOptions, type LLMConfig } from './llm-client';
import { getDb } from './database';
import { scriptifyViaCli, type CliAuthConfig } from './claude-code-provider';
import { agentEvents } from './agent-bus';

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface DomainPlaybook {
  domain: string;       // e.g. "csi.amazon.com"
  playbook: string;     // structured learnings, max ~2000 chars
  updatedAt: string;
  version: number;      // increments on each update
}

// ─── Excluded Domains ───────────────────────────────────────────────────────────

const EXCLUDED_DOMAINS = new Set([
  'localhost',
  '127.0.0.1',
  'search.brave.com',
]);

const EXCLUDED_DOMAIN_PATTERNS = [
  /^(www\.)?google\.[a-z.]+$/,   // google.com, google.co.uk, etc.
  /^(www\.)?bing\.com$/,
  /^(www\.)?duckduckgo\.com$/,
];

export function isDomainExcluded(domain: string): boolean {
  if (EXCLUDED_DOMAINS.has(domain)) return true;
  return EXCLUDED_DOMAIN_PATTERNS.some(p => p.test(domain));
}

// ─── Inflight Update Gate ────────────────────────────────────────────────────────

let _inflightUpdate: Promise<any> | null = null;

export async function waitForPlaybookUpdate(): Promise<void> {
  if (_inflightUpdate) {
    try { await _inflightUpdate; } catch {}
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// ─── CRUD ───────────────────────────────────────────────────────────────────────

export function getPlaybook(domain: string): DomainPlaybook | null {
  const db = getDb();
  const row = db.prepare('SELECT domain, playbook, updated_at, version FROM domain_playbooks WHERE domain = ?').get(domain) as any;
  if (!row) return null;
  return {
    domain: row.domain,
    playbook: row.playbook,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

export function upsertPlaybook(domain: string, playbook: string): void {
  const db = getDb();
  // Enforce max size
  const trimmed = playbook.slice(0, 2000);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO domain_playbooks (domain, playbook, updated_at, version)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(domain) DO UPDATE SET
      playbook = excluded.playbook,
      updated_at = excluded.updated_at,
      version = version + 1
  `).run(domain, trimmed, now);

  agentEvents.emit('playbook:updated', { domain, playbook: trimmed });
}

export function deletePlaybook(domain: string): void {
  const db = getDb();
  db.prepare('DELETE FROM domain_playbooks WHERE domain = ?').run(domain);
}

export function listPlaybooks(): DomainPlaybook[] {
  const db = getDb();
  const rows = db.prepare('SELECT domain, playbook, updated_at, version FROM domain_playbooks ORDER BY updated_at DESC').all() as any[];
  return rows.map(r => ({
    domain: r.domain,
    playbook: r.playbook,
    updatedAt: r.updated_at,
    version: r.version,
  }));
}

// ─── LLM Prompt ─────────────────────────────────────────────────────────────────

const PLAYBOOK_UPDATE_PROMPT = `You are a domain knowledge curator. You receive:
1. The user's original intent (what they asked the agent to do)
2. Domains visited during a browsing session, with existing playbooks (if any)
3. Tool calls the agent made (actions + arguments)
4. Tool results (what happened after each action)
5. The agent's final summary

Your job: extract STRUCTURAL DOMAIN KNOWLEDGE from the session — information that
would help a browser automation agent work effectively on this domain in future sessions.

TRACE ERROR→CORRECTION PATTERNS:
- When the agent tried a URL/path that failed, then discovered the correct one — record the CORRECT path
- When the agent clicked an element that didn't work, then found the right approach — record the RIGHT approach
- When the agent hit a blocker (dialog, rate limit, auth wall), then found a workaround — record the WORKAROUND
- Skip all failed attempts. Only capture what ACTUALLY WORKED.

USE USER INTENT + TOOL ARGUMENTS for richer pattern extraction:
- User intent reveals WHAT the user was trying to accomplish — use this to frame domain knowledge
- Tool call arguments show exact URLs, selectors, text typed — use these for URL patterns and navigation sequences
- Tool results confirm what worked vs. failed — combine with arguments for error→correction traces

WHAT TO CAPTURE (these are the ONLY valid playbook entries):
- URL patterns: correct paths, query params, API endpoints (use {placeholder} for variable parts)
  Example: "DataViewer: /view?asin={ASIN}&mpid={MPID}"
- UI navigation: where features are, menu structures, required click sequences
  Example: "Settings → Account → API Keys (not in the top nav, buried in sidebar)"
- Prerequisite steps: cookie banners, dialogs to dismiss, login flows
  Example: "Press Escape to dismiss onboarding dialog before using dropdowns"
- Element patterns: how to find specific elements, selector strategies
  Example: "Search box is inside iframe#search-frame, not in main document"
- Rate limits / timing: discovered limits, required waits
  Example: "API returns 429 after ~10 requests/minute — add 6s delay between calls"
- Anti-patterns: paths that DON'T work (to avoid repeating mistakes)
  Example: "Do NOT use /api/v1/ — returns 404. Use /api/v2/ instead"

WHAT TO NEVER CAPTURE:
- User data (passwords, tokens, personal info, specific account details)
- Transient content (search results, page text, data values from this session)
- Opinions or commentary ("site is slow", "UI is confusing")
- Run-specific values (specific IDs, dates, results — use {placeholders} instead)

RULES:
- Merge new learnings INTO existing playbook (don't lose previous knowledge)
- Remove entries proven WRONG in this session
- Use terse bullet points — aim for 500-1500 characters per domain
- Include URL paths with {placeholder} syntax for variable parts
- If NOTHING genuinely useful was learned about a domain, OMIT it entirely

Respond with ONLY a JSON object (no markdown fences):
{
  "updates": [
    {
      "domain": "example.com",
      "playbook": "- URL pattern: /api/v2/{resource}\\n- Dismiss cookie banner before interacting",
      "reason": "Discovered correct API version after 404 errors"
    }
  ]
}

If NO domains have genuinely useful structural learnings, respond: { "updates": [] }`;

// ─── Post-Execution Update ──────────────────────────────────────────────────────

export async function updatePlaybooksFromSession(
  domainsVisited: Set<string>,
  domainToolCounts: Map<string, number>,
  conversationEvents: Array<{ role: string; content: string }>,
  agentResponse: string,
  llmConfig: LLMConfig,
  cliAuth?: CliAuthConfig,
): Promise<{ updated: Array<{ domain: string; reason: string }>; errors: string[] }> {
  const work = _updatePlaybooksFromSessionImpl(domainsVisited, domainToolCounts, conversationEvents, agentResponse, llmConfig, cliAuth);
  _inflightUpdate = work;
  try { return await work; } finally { _inflightUpdate = null; }
}

async function _updatePlaybooksFromSessionImpl(
  domainsVisited: Set<string>,
  domainToolCounts: Map<string, number>,
  conversationEvents: Array<{ role: string; content: string }>,
  agentResponse: string,
  llmConfig: LLMConfig,
  cliAuth?: CliAuthConfig,
): Promise<{ updated: Array<{ domain: string; reason: string }>; errors: string[] }> {
  // Filter to non-excluded domains with at least 1 non-navigate tool call
  const candidates = [...domainsVisited].filter(domain => {
    if (isDomainExcluded(domain)) return false;
    return (domainToolCounts.get(domain) || 0) > 0;
  });

  if (candidates.length === 0) {
    return { updated: [], errors: [] };
  }

  // Load existing playbooks for candidates
  const existingPlaybooks: Record<string, string> = {};
  for (const domain of candidates) {
    const pb = getPlaybook(domain);
    if (pb) existingPlaybooks[domain] = pb.playbook;
  }

  // Build user content
  const domainSection = candidates.map(d => {
    const existing = existingPlaybooks[d];
    return existing
      ? `Domain: ${d}\nExisting playbook:\n${existing}`
      : `Domain: ${d}\n(no existing playbook)`;
  }).join('\n\n');

  // Extract user intent (first user message only — the task description)
  const userIntent = conversationEvents
    .filter(e => e.role === 'user')
    .map(e => e.content)
    .slice(0, 1).join('').slice(0, 2_000);

  // Extract tool call arguments (terse summaries of what the agent did)
  const toolCalls = conversationEvents
    .filter(e => e.role === 'tool-call')
    .map(e => e.content)
    .join('\n').slice(0, 10_000);

  // Extract tool results (existing behavior)
  const toolResults = conversationEvents
    .filter(e => e.role === 'tool')
    .map(e => e.content)
    .join('\n\n').slice(0, 20_000);

  const userContent = [
    'USER INTENT:',
    userIntent || '(no user message captured)',
    '',
    'DOMAINS VISITED:',
    domainSection,
    '',
    'TOOL CALLS (what the agent did):',
    toolCalls || '(no tool calls captured)',
    '',
    'TOOL RESULTS (what happened):',
    toolResults || '(no tool results)',
    '',
    'AGENT SUMMARY:',
    agentResponse.slice(0, 5_000) || '(no summary)',
  ].join('\n');

  // LLM call (dual-path: Vercel AI SDK or Claude Code CLI)
  let parsed: any;
  try {
    if (llmConfig.provider === 'claude-code') {
      const cliResult = await scriptifyViaCli(userContent, PLAYBOOK_UPDATE_PROMPT, cliAuth);
      if ('error' in cliResult) {
        return { updated: [], errors: [cliResult.error] };
      }
      parsed = cliResult.data;
    } else {
      const model = createModel(llmConfig);
      const providerOptions = buildProviderOptions(llmConfig);
      const result = await generateText({
        model,
        providerOptions,
        messages: [
          { role: 'system', content: PLAYBOOK_UPDATE_PROMPT },
          { role: 'user', content: userContent },
        ],
        maxOutputTokens: 4_096,
      });
      let text = result.text.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      try {
        parsed = JSON.parse(text);
      } catch {
        return { updated: [], errors: ['Failed to parse playbook update response'] };
      }
    }
  } catch (llmErr: any) {
    return { updated: [], errors: [`LLM call failed: ${llmErr?.message}`] };
  }

  if (!parsed?.updates || !Array.isArray(parsed.updates)) {
    return { updated: [], errors: [] };
  }

  // Validate and upsert
  const updated: Array<{ domain: string; reason: string }> = [];
  const errors: string[] = [];
  const candidateSet = new Set(candidates);

  for (const update of parsed.updates) {
    // Validate domain is in candidates (prevent prompt injection)
    if (!update.domain || !candidateSet.has(update.domain)) {
      errors.push(`Rejected update for non-candidate domain: ${update.domain}`);
      continue;
    }

    // Reject empty/vague playbooks
    if (!update.playbook || typeof update.playbook !== 'string') {
      errors.push(`Empty playbook for ${update.domain}`);
      continue;
    }

    // Must have at least one bullet point with actionable info
    const hasBullet = /^[-•*]/.test(update.playbook.trim()) || /\n[-•*]/.test(update.playbook);
    if (!hasBullet) {
      errors.push(`Playbook for ${update.domain} lacks actionable bullet points`);
      continue;
    }

    // Reject vague reasons
    const reason = update.reason || '';
    if (!reason || reason.length < 10) {
      errors.push(`Vague reason for ${update.domain}: "${reason}"`);
      continue;
    }

    try {
      upsertPlaybook(update.domain, update.playbook);
      updated.push({ domain: update.domain, reason });
    } catch (e: any) {
      errors.push(`DB error for ${update.domain}: ${e?.message}`);
    }
  }

  return { updated, errors };
}
