/**
 * agent.ts — The agent loop.
 *
 * Wires the agent panel to tools through an LLM via Vercel AI SDK v6.
 * Single direct agent loop — uses spawn_agent for parallel tasks when needed.
 */

import { streamText, generateText, stepCountIs } from 'ai';
import type { BrowserWindow, WebContents } from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import {
  createModel,
  buildProviderOptions,
  getModelConfig,
  withCodexProviderOptions,
  logProviderRequestError,
  extractRequestErrorDetails,
  runLiteLLMCodexToolLoop,
  type LLMConfig,
} from './llm-client';
import { createTools, TOOL_USAGE_GUIDE } from './tool-registry';
import * as browserTools from './browser-tools';
import * as httpTools from './http-tools';
import * as toolManagerMod from './tool-manager';
import { loadProfile, loadUserProfileTxt } from './user-profile';
import type { BrowserContext } from './browser-tools';
import { getWorkspacePath } from './workspace-resolver';
import { getWorkingDir, getLastFile, resetContext } from './working-context';

// Re-export agentEvents from shared bus (avoids circular dep with tool-registry)
export { agentEvents } from './agent-bus';
import { agentEvents } from './agent-bus';

// Phase 8.40: Progress tracking data (read by API server for /api/status)
export interface AgentProgressData {
  running: boolean;
  elapsed: number;
  toolCalls: number;
  timeoutMs: number;
}
export let agentProgressData: AgentProgressData = { running: false, elapsed: 0, toolCalls: 0, timeoutMs: 0 };

import {
  getWindow, getFullHistory, addMessage, addMessages,
  clearHistory as clearConversation,
  getUnsummarizedEvictedMessages, setEvictionSummary,
  buildSummaryPrompt, sanitizeResponseMessages,
  type ChatMessage,
} from './conversation';

import {
  addConversationMessage,
  generateAutoTitleFallback,
  getConversationMessageCount,
  getConversationMessages,
  updateConversationTitle,
} from './conversation-store';
import { buildProjectContext } from './project-manager';
import { getDb } from './database';
import { reconcileScriptFix } from './scriptify-engine';
import { updatePlaybooksFromSession } from './domain-playbook';

import { bootstrapContext } from './coding-memory';
import * as teamManager from './team-manager';
import { getLoginHint } from './login-state';
import { profileManager } from './profile-manager';
import { sessionManager } from './session-manager';
import { listIdentities } from './password-vault';
import { getActiveTeammateCount } from './team-manager';
import { forceCompaction } from './conversation';
import {
  classifyError,
  truncateToolResults,
  createProgressState,
  assessProgress,
  updateProgressState,
  buildReflectionPrompt,
  buildCourseCorrection,
  buildSelfCheckPrompt,
  buildTimeReflection,
  buildContinuationState,
  buildContinuationPrimer,
  setContinuationState,
  getContinuationState,
  clearContinuationState,
  estimateMessageTokens,
  type ProgressState,
} from './agent-harness';

// Wrapper: clear conversation history AND working context for a session
export function clearHistory(sessionId: string = 'default'): void {
  clearConversation(sessionId);
  resetContext(sessionId);
}

/**
 * Assemble minimal context for the LLM.
 *
 * 🚨 ZERO PAGE CONTENT. The page is a black box.
 * The LLM calls `elements`, `text`, `grep` tools when it wants to see the page.
 * Only browser state (title, URL, tab count) and API services are injected.
 */
/**
 * Phase 10: Static context — appended to system prompt for prompt caching.
 * These don't change between steps in the same agent run:
 * user profile, API services, CLI tools, workspace, model info.
 * Cached by Anthropic's prompt caching (90% discount on reads).
 */
function assembleStaticContext(browserCtx: BrowserContext, llmConfig?: LLMConfig): string {
  const parts: string[] = [];

  // Model context injection (Phase 8.85)
  if (llmConfig) {
    const primaryLabel = `${llmConfig.provider}/${llmConfig.model}`;
    const secondaryLabel = llmConfig.secondaryModel
      ? `${llmConfig.secondaryProvider || llmConfig.provider}/${llmConfig.secondaryModel}`
      : primaryLabel;
    parts.push(`Models: primary=${primaryLabel}, secondary=${secondaryLabel}`);
  }

  // Workspace hint — show configured workspace path
  try {
    const workspacePath = getWorkspacePath();
    parts.push(`Workspace: ${workspacePath}`);
  } catch {
    // Non-fatal
  }

  // API services context (only if services are configured)
  const apiContext = httpTools.getServiceContext();
  if (apiContext) parts.push('', apiContext);

  // CLI tools context (only if tools are registered)
  const toolsContext = toolManagerMod.getToolsContext();
  if (toolsContext) parts.push('', toolsContext);

  // ─── User Profile (Phase 9.096c: two-layer system) ───
  try {
    // Layer 1: User-written profile text (always injected if present)
    const userProfileTxt = loadUserProfileTxt();
    if (userProfileTxt) {
      parts.push('', `[User Profile]\n${userProfileTxt}`);
    }

    // Layer 2: Auto-enrichment from browsing data (only when toggled on)
    const config = (browserCtx as any).config as { privacy?: { agentBrowsingDataAccess?: boolean } } | undefined;
    const accessEnabled = config?.privacy?.agentBrowsingDataAccess === true;
    if (accessEnabled) {
      const autoProfile = loadProfile();
      if (autoProfile) {
        const { updated_at, ...compactProfile } = autoProfile;
        parts.push(`[Browsing Insights: ${JSON.stringify(compactProfile)}]`);
      }
    }
  } catch (e) {
    // Non-fatal — profile injection is optional
    console.error('[agent] Failed to inject user profile:', e);
  }

  return parts.join('\n');
}

/**
 * Phase 10: Dynamic context — injected into last user message per-step.
 * These change between steps: time, browser state, login hints, identity, recipes.
 * NOT cached since they're different on each LLM call.
 */
function assembleDynamicContext(browserCtx: BrowserContext): string {
  const parts: string[] = [];

  // Current time + timezone (~20 tokens)
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  parts.push(`Time: ${now.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })} (${tz})`);

  // Browser state — title, URL, tab count (~50 tokens)
  try {
    parts.push(browserTools.getBrowserState(browserCtx));
  } catch (e) {
    parts.push('Page: (unavailable)');
  }

  // Login detection hint (Phase 8.4.3)
  try {
    const wc = browserCtx.tabManager.activeWebContents;
    if (wc) {
      const loginHint = getLoginHint(wc.id);
      if (loginHint) parts.push('', loginHint);
    }
  } catch {
    // Non-fatal
  }

  // Active profile hint (Phase 8.4.4)
  try {
    const pName = profileManager.activeProfile;
    if (pName && pName !== 'default') {
      parts.push('', `[🪪 Browser Profile: ${pName}]`);
    }
  } catch {
    // Non-fatal
  }

  // Multi-identity site hint (Phase 8.4.6)
  try {
    const wc = browserCtx.tabManager.activeWebContents;
    if (wc) {
      const url = wc.getURL();
      if (url) {
        const domain = new URL(url).hostname.replace(/^www\./, '');
        const identities = listIdentities(domain);
        const activeIdentities = sessionManager.getSiteIdentities(domain);
        if (identities.length >= 2) {
          const activeUser = activeIdentities[0]?.username;
          const others = identities.filter(u => u !== activeUser);
          let hint = `[👤 ${domain}: `;
          if (activeUser) {
            hint += `signed in as @${activeUser}.`;
            if (others.length > 0) hint += ` Also available: ${others.map(u => '@' + u).join(', ')}`;
          } else {
            hint += `${identities.length} identities stored: ${identities.map(u => '@' + u).join(', ')}`;
          }
          hint += ']';
          parts.push('', hint);
        }
      }
    }
  } catch {
    // Non-fatal
  }

  // Recipe hint — if current page matches a recipe app, suggest available actions
  try {
    const wc = browserCtx.tabManager.activeWebContents;
    if (wc) {
      const url = wc.getURL();
      if (url && url.startsWith('http')) {
        const domain = new URL(url).hostname.replace(/^www\./, '');
        const { ALL_RECIPES } = require('./recipes');
        const matchingRecipe = ALL_RECIPES.find((r: any) =>
          domain.includes(r.domain) || r.domainAliases?.some((d: string) => domain.includes(d))
        );
        if (matchingRecipe) {
          const actions = matchingRecipe.actions.map((a: any) => `${matchingRecipe.app}:${a.name}`).join(', ');
          parts.push('', `[📋 Recipes available for ${matchingRecipe.displayName}: ${actions}]`);
        }
      }
    }
  } catch {
    // Non-fatal
  }

  return parts.join('\n');
}

const PROBLEM_SOLVING_GUIDE = `
## Problem-Solving Directive
For EVERY request, follow this process:
1. **Understand** this request clearly — re-read and identify what the user actually wants.
2. **Figure out** how to fulfill this request/problem — consider approaches and pick the best one.
3. **Solve** the problem or fulfill the request — act decisively and efficiently.
4. **Verify** — confirm it worked and actually solves their problem.
5. **Present** — explain what you did and why, concisely.

For straightforward factual questions or simple lookups, compress steps 2–4.

## Agent Teams
When you spawn teammates for parallel work:
1. Create team → write contracts → create tasks → spawn teammates
2. **CRITICAL**: After spawning all teammates, call \`wait_for_team\` to block until they finish. NEVER return without waiting for teammates to complete.
3. After wait_for_team returns, collect results with \`team_status\`, then call \`team_delete\` to clean up.
4. Present the combined results to the user.
`;

export const SYSTEM_PROMPT = `You are Aria 🪷, an AI agent built into a web browser. You control the browser through tools.

## Core Rule: The Page Is a Black Box

You NEVER see page content in your context. The page is opaque until you query it with tools.
**First move on any page task:** \`elements\` to see what's there, or \`text\` to read content.

## The Grep Philosophy

grep > scroll > read-all. Always.
- \`elements({ grep: "checkout" })\` — searches ALL elements including offscreen
- \`text({ grep: "refund policy" })\` — searches entire page text (supports regex: \`"Wed|Thu"\` or \`"/Wed|Thu/i"\`)
- \`history({ grep: "what I said" })\` — searches full conversation history
- Never screenshot to understand a page. \`text\` and \`elements\` are faster and cheaper.
- For canvas apps (Sheets, Docs, Figma), use \`keys\` instead of click/type.

## How APIs work
- \`register_api\` + \`api_key_store\` to configure. Then \`http_request\` with \`auth: "@service"\`.
- Use \`document_endpoint\` to save schemas after browsing API docs — learn once, use forever.
- Responses are saved to files. Use \`file_read\` with grep to extract what you need.

## Multi-Account Identity
- When you see \`[👤 domain: ...]\` in your context, multiple identities exist for that site. Use \`site_identity\` to list, open, or register identities with isolated sessions.

## Style
- Concise. Say what you did and what happened.
- If something fails, try an alternative before giving up.
- Always respond with text after tool calls.

## File Download Rule
**CRITICAL: When you create any file (report, document, export, etc.), you MUST call present_download IMMEDIATELY after file_write. Do not just mention the file in text.**

Example workflow:
1. file_write(path="report.md", content="...")  // relative paths resolve to workspace
2. present_download(path="report.md") <- THIS IS REQUIRED

The user expects to see an interactive download card with buttons. Don't let them down.
${PROBLEM_SOLVING_GUIDE}
${TOOL_USAGE_GUIDE}
`;

interface ProcessedAttachment {
  name: string;
  mimeType: string;
  size: number;
  base64: string;
  category: 'image' | 'document' | 'text';
  tempPath?: string;
}

interface AgentRunOptions {
  userMessage: string;
  browserCtx: BrowserContext;
  llmConfig: LLMConfig;
  window: BrowserWindow;
  sessionId?: string;
  developerMode?: boolean;
  worktreeIsolation?: boolean; // Phase 8.39: git worktree isolation enabled
  agentBrowsingDataAccess?: boolean; // Phase 8.4.1: grant agent access to history/bookmarks/downloads
  conversationId?: string;  // Phase 8.35: SQLite conversation ID for persistence
  ariaWebContents?: WebContents | null; // Phase 8.35: Aria tab webcontents for broadcast
  executionRetryCount?: number; // Internal guard: auto-retry planning-only non-normal runs once
  codexToolRetryCount?: number; // Internal guard: codex empty-tool-call recovery retries
  codexForceNonStream?: boolean; // Internal guard: retry codex once via non-stream generateText
  attachments?: ProcessedAttachment[]; // File attachments for multimodal messages
  scriptId?: string;  // Script ID when executing a stored script — enables script_persist_fix tool
  scriptInputs?: Record<string, any>;  // Input values used for this script run — for auto-reconciliation
  cliAuth?: any;  // CLI auth config for post-execution reconciliation LLM call
  planMode?: boolean; // Vercel SDK plan mode — text-only plan generation, no tool calls
}

// The main agent decides: single-agent task or multi-agent teams.

let activeRun: AbortController | null = null;
let _lastStopReason: string | null = null; // Phase 8.40: track why agent stopped

// ── Vercel SDK Plan Mode state ──
const PLAN_PATTERNS = [
  /\bplan\s+(this|how|for|out|it)\b/i,
  /\bfigure\s+out\b/i,
  /\bhow\s+should\s+(i|we)\b/i,
  /\bwhat('s| is)\s+the\s+best\s+(approach|way|strategy|method)\b/i,
  /\bdesign\s+(a|an|the)\s+\w/i,
  /\bmap\s+out\b/i,
  /\bbreak\s+(this|it)\s+down\b/i,
  /\boutline\s+(the|a|an)\s+\w/i,
  /\bwhat\s+steps\b/i,
  /\bcome\s+up\s+with\s+(a\s+)?plan\b/i,
  /\bthink\s+through\b/i,
  /\bplan\s+mode\b/i,
];

export function detectPlanIntent(message: string): boolean {
  return PLAN_PATTERNS.some(p => p.test(message));
}

let _pendingPlanApproval = false;
let _pendingPlanOpts: AgentRunOptions | null = null;

export function isPlanPending(): boolean { return _pendingPlanApproval; }
export function resetAgentPlanState(): void {
  _pendingPlanApproval = false;
  _pendingPlanOpts = null;
}
export function getPendingPlanOpts(): AgentRunOptions | null { return _pendingPlanOpts; }

// ── Phase 9.096d: Interrupt/Redirect support ──
let _activeRunOptions: AgentRunOptions | null = null;
let _activePartialResponse: string = '';
let _activeSessionId: string = 'default';

function sendChunk(mainWindow: BrowserWindow, text: string, done: boolean, extraWC?: WebContents | null) {
  try { mainWindow.webContents.send('agent:stream-chunk', { text, done }); } catch {}
  try { if (extraWC && !extraWC.isDestroyed()) extraWC.send('agent:stream-chunk', { text, done }); } catch {}
  // Emit to API server listeners (Phase 8.45)
  try { agentEvents.emit('chunk', { text, done }); } catch {}
}

function sendError(mainWindow: BrowserWindow, msg: string, extraWC?: WebContents | null) {
  console.error('[agent] Error:', msg);
  try { mainWindow.webContents.send('agent:stream-start', {}); } catch {}
  try { if (extraWC && !extraWC.isDestroyed()) extraWC.send('agent:stream-start', {}); } catch {}
  sendChunk(mainWindow, `❌ ${msg}`, true, extraWC);
}

/**
 * Hydrate in-memory conversation window from persisted SQLite conversation history.
 *
 * This is needed after app restart: UI can render DB history, but agent memory starts empty.
 * We restore user/assistant/system turns into the in-memory session exactly once per sessionId.
 */
function hydrateSessionFromConversationIfNeeded(sessionId: string, conversationId?: string): void {
  if (!conversationId) return;
  if (getFullHistory(sessionId).length > 0) return;

  try {
    const BATCH_SIZE = 200;
    let offset = 0;
    let restored = 0;
    const teamEventSummary: string[] = [];

    while (true) {
      const rows = getConversationMessages(conversationId, offset, BATCH_SIZE);
      if (!rows || rows.length === 0) break;

      for (const row of rows) {
        const content = (row.content || '').toString();
        if (!content) continue;

        if (row.role === 'team-event') {
          try {
            const data = JSON.parse(content);
            if (data.type === 'teammate-done') {
              teamEventSummary.push(`${data.name} (${data.status}): ${(data.summary || '').slice(0, 150)}`);
            } else if (data.type === 'team-dissolved') {
              teamEventSummary.push(`Team dissolved after ${data.duration}min. Results: ${(data.teammates || []).map((t: any) => `${t.name}:${t.status}`).join(', ')}`);
            }
          } catch {}
          continue;
        }

        if (row.role === 'user' || row.role === 'assistant' || row.role === 'system') {
          addMessage(sessionId, { role: row.role as 'user' | 'assistant' | 'system', content });
          restored++;
        }
      }

      if (rows.length < BATCH_SIZE) break;
      offset += rows.length;
    }

    // Inject team event summary as context for the agent
    if (teamEventSummary.length > 0) {
      addMessage(sessionId, {
        role: 'user',
        content: `[Previous session context — agent team results]\n${teamEventSummary.join('\n')}`,
      });
      restored++;
    }

    if (restored > 0) {
      console.log(`[agent] Hydrated ${restored} messages from conversation ${conversationId} into session ${sessionId}`);
    }
  } catch (e: any) {
    console.error('[agent] Conversation hydration failed (non-fatal):', e?.message || e);
  }
}

// Phase 9.12: Removed isReportDeliverableRequest and hasReportArtifacts — no forced retry loops.

/**
 * Format tool call arguments into a terse one-line summary for playbook generation.
 * Truncates large values to avoid bloating the playbook LLM context.
 */
function formatToolCallArgs(toolName: string, args: Record<string, any>): string {
  const MAX_VAL = 120, MAX_TOTAL = 300;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    if (str.length > 500) { parts.push(`${key}: <${str.length} chars>`); }
    else { parts.push(`${key}: ${str.length > MAX_VAL ? str.slice(0, MAX_VAL) + '...' : str}`); }
  }
  const full = `🔨 ${toolName} → ${parts.join(', ')}`;
  return full.length > MAX_TOTAL ? full.slice(0, MAX_TOTAL) + '...' : full;
}

export async function runAgent(opts: AgentRunOptions): Promise<void> {
  const {
    userMessage,
    browserCtx,
    llmConfig,
    window: mainWindow,
    sessionId = 'default',
    developerMode = false,
    worktreeIsolation = true,
    agentBrowsingDataAccess = false,
    conversationId,
    ariaWebContents,
    codexForceNonStream = false,
    codexToolRetryCount = 0,
    attachments,
  } = opts;

  // Helper: broadcast to both chrome UI and Aria tab
  function broadcast(channel: string, data?: any) {
    try { mainWindow.webContents.send(channel, data); } catch {}
    try { if (ariaWebContents && !ariaWebContents.isDestroyed()) ariaWebContents.send(channel, data); } catch {}
  }

  if (activeRun) { activeRun.abort(); activeRun = null; }
  const abortController = new AbortController();
  activeRun = abortController;

  // Phase 9.096d: Track live state for interrupt/redirect support
  _activeRunOptions = opts;
  _activePartialResponse = '';
  _activeSessionId = sessionId;

  // ─── Agent Loop ────────────────────────────────────────────────────────────

  let errorSent = false;
  let streamStarted = false;
  const toolsUsed: string[] = [];

  // Phase 9.12: No automatic task classification or forced orchestration.
  // The agent decides if/when to use spawn_agent based on its own judgment.
  const taskType = 'normal';

  try {
    const model = createModel(llmConfig);
    // Phase 10: Split context into static (cached in system prompt) and dynamic (per-step)
    const staticContext = assembleStaticContext(browserCtx, llmConfig);
    const browserContext = assembleDynamicContext(browserCtx);

    // ─── Project context injection (Phase 9.07 / 9.099) ────────────────────
    // If the current conversation has a project_id, inject a compact project
    // context block so the agent knows about project state AND scope CWD.
    let projectContextBlock = '';
    let projectWorkingDir = '';
    if (conversationId) {
      try {
        const row = getDb().prepare(
          `SELECT project_id FROM conversations WHERE id = ? LIMIT 1`
        ).get(conversationId) as { project_id: string | null } | undefined;
        if (row?.project_id) {
          projectContextBlock = buildProjectContext(row.project_id);
          // Resolve the project's working_dir for CWD scoping
          const { getProject: getProj } = require('./project-manager');
          const proj = getProj(row.project_id);
          if (proj?.working_dir) {
            const expandedDir = proj.working_dir.startsWith('~/')
              ? path.join(os.homedir(), proj.working_dir.slice(2))
              : proj.working_dir === '~' ? os.homedir() : proj.working_dir;
            if (fs.existsSync(expandedDir)) {
              projectWorkingDir = expandedDir;
            }
          }
        }
      } catch (e: any) {
        // Non-fatal — project context is optional
        console.error('[agent] Failed to inject project context:', e?.message);
      }
    }

    // ─── Domain Playbook Tracking ─────────────────────────────────────────
    const domainsVisited = new Set<string>();
    const domainToolCounts = new Map<string, number>();

    const tools = createTools(browserCtx, sessionId, {
      developerMode, llmConfig, worktreeIsolation, agentBrowsingDataAccess, conversationId, projectWorkingDir,
      scriptId: opts.scriptId,
      domainsVisited, domainToolCounts,
      onProfileSwitch: (name: string) => new Promise((resolve) => {
        agentEvents.emit('profile:switch-request', name, (result: any) => {
          resolve(result);
        });
      }),
    });

    // ─── Coding Memory Bootstrap ───────────────────────────────────────────
    // If there's an active team or project, inject coding memory context.
    let codingMemoryContext = '';
    try {
      const activeTeam = teamManager.getActiveTeam();
      const projectDir = activeTeam?.workingDir || projectWorkingDir;
      if (projectDir) {
        const memCtx = bootstrapContext(projectDir);
        if (memCtx) {
          codingMemoryContext = '\n\n' + memCtx;
        }
      }
    } catch (memErr: any) {
      console.error('[agent] coding-memory bootstrap error:', memErr?.message);
    }

    // ─── Date Grounding (Phase 9.097) ───────────────────────────────────────
    // Inject current date/time for LLMs that don't have native time awareness.
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const dateContext = `## Current Time
Date: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
Time: ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
Timezone: ${tz}
`;

    // Phase 10: Static context (user profile, API services, CLI tools, project, coding memory)
    // is appended to the system prompt where it benefits from prompt caching.
    // Dynamic context (time, browser state, login hints) stays in the per-step user message.
    const staticCtxBlock = staticContext ? `\n\n## Session Context\n${staticContext}` : '';
    const projectCtxBlock = projectContextBlock ? `\n\n${projectContextBlock}` : '';
    const activeSystemPrompt = dateContext + SYSTEM_PROMPT + codingMemoryContext + staticCtxBlock + projectCtxBlock;
    console.log('[agent] Run starting:', Object.keys(tools).length, 'tools,', browserContext.length, 'chars dynamic ctx,', staticContext.length, 'chars static ctx, devMode:', developerMode, 'taskType:', taskType);

    // Restore in-memory history from persisted conversation after restart/switch.
    hydrateSessionFromConversationIfNeeded(sessionId, conversationId);

    // ─── Continuation State: inject context from previous failed run ────────
    const prevContinuation = getContinuationState(sessionId);
    if (prevContinuation) {
      const primer = buildContinuationPrimer(prevContinuation);
      addMessage(sessionId, { role: 'system', content: primer });
      clearContinuationState(sessionId);
      console.log(`[agent] Injected continuation primer (reason: ${prevContinuation.reason}, ${prevContinuation.toolCallCount} prior tool calls)`);
    }

    // Add user message to history
    addMessage(sessionId, { role: 'user', content: userMessage });

    // Build messages for LLM from the rolling window
    const history = getWindow(sessionId);

    // Phase 10: Inject only dynamic browser state into the last user message.
    // Static context (user profile, project, API services) is in the system prompt (cached).
    const messages: ChatMessage[] = [];
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      if (i === history.length - 1 && msg.role === 'user' && typeof msg.content === 'string') {
        const ctxParts = [`[Browser: ${browserContext}]`];
        // Working context (active working dir and last file) — changes per file operation
        const workingDir = getWorkingDir(sessionId);
        const lastFile = getLastFile(sessionId);
        if (workingDir) ctxParts.push(`Working Dir: ${workingDir}`);
        if (lastFile) ctxParts.push(`Last File: ${lastFile}`);
        const fullText = `${ctxParts.join('\n')}\n\n${msg.content}`;

        // Build multimodal content parts when attachments are present
        if (attachments && attachments.length > 0) {
          const provider = llmConfig.provider;
          const pdfProviders = ['anthropic', 'google', 'bedrock', 'vertex', 'openrouter'];
          const parts: any[] = [{ type: 'text', text: fullText }];
          for (const att of attachments) {
            if (att.category === 'image') {
              parts.push({ type: 'image', image: Buffer.from(att.base64, 'base64'), mimeType: att.mimeType });
            } else if (att.mimeType === 'application/pdf') {
              if (pdfProviders.includes(provider)) {
                parts.push({ type: 'file', data: Buffer.from(att.base64, 'base64'), mimeType: 'application/pdf' });
              } else {
                parts[0].text += `\n\n[Attached PDF: ${att.name} (${att.size} bytes) — PDF content not available for this provider]`;
              }
            } else {
              // Text files: decode and inline
              const textContent = Buffer.from(att.base64, 'base64').toString('utf-8');
              parts.push({ type: 'text', text: `\n\n--- ${att.name} ---\n${textContent}\n--- end ---` });
            }
          }
          messages.push({ role: 'user', content: parts } as any);
        } else {
          messages.push({ role: 'user', content: fullText });
        }
      } else {
        messages.push(msg);
      }
    }

    // ─── Phase 8.40: Timeout-Based Execution ────────────────────────────────
    // Coding mode with teams needs more time — teammates run in parallel, lead waits
    const defaultTimeout = 1_800_000; // Phase 9.096f: 30 min for all modes — agents must run until done or timeout
    const timeoutMs = llmConfig.agentTimeoutMs ?? defaultTimeout;
    const runStart = Date.now();
    let stopReason: string | null = null;
    let warningPending = false;
    let warningInjected = false;
    let dupHintPending = false;
    let recentCalls: Array<{ tool: string; args: string }> = [];
    let emptyToolCallFinishCount = 0; // Counts steps where finishReason=tool-calls but 0 parsed calls
    let toolCallCount = 0;
    const progressState: ProgressState = createProgressState();
    let lastReflectionStep = 0;     // Step-based self-reflection tracking
    let lastTimeReflectionMs = Date.now(); // Time-based reflection tracking
    let compactionInProgress = false; // Prevent double-trigger of mid-run compaction

    // Phase 9.15: direct Codex backend path now uses AI SDK streamText/Responses.
    // Keep legacy manual codex loop disabled for compatibility while preserving code for fallback.
    const isCodex = false && llmConfig.provider === 'openai-codex';
    let codexNeedsNonStreamRetry = false;
    let codexToolFailureCount = 0;
    let codexToolIntentSteps = 0;
    let codexParsedToolCalls = 0;
    let codexExecutedToolResults = 0;
    let codexStreamAssembledCalls = 0;
    let codexStreamArgParseErrors = 0;

    const codexStreamToolInputByIndex = new Map<number, {
      toolName: string;
      argsText: string;
      finalized: boolean;
    }>();

    const parseJsonArgsSafe = (raw: any): any => {
      if (raw === undefined || raw === null) return {};
      if (typeof raw === 'object') return raw;
      if (typeof raw !== 'string') return { value: raw };
      const text = raw.trim();
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        codexStreamArgParseErrors++;
        return { __raw: text };
      }
    };

    // Timeout: abort at configured timeout
    const timeoutHandle = setTimeout(() => {
      stopReason = 'timeout';
      _lastStopReason = 'timeout';
      abortController.abort();
    }, timeoutMs);

    // Warning at 80% of timeout
    const warningHandle = setTimeout(() => {
      warningPending = true;
    }, Math.floor(timeoutMs * 0.8));

    // Enhanced progress interval: emit agent:progress every second with richer data
    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - runStart;
      broadcast('agent:progress', {
        elapsed,
        toolCalls: toolCallCount,
        timeoutMs,
        uniqueTools: progressState.uniqueToolsUsed.size,
        lastToolName: toolsUsed.length > 0 ? toolsUsed[toolsUsed.length - 1] : undefined,
        textLength: fullResponse.length,
        stuckSignals: progressState.textOnlySteps,
      });
      agentProgressData = { running: true, elapsed, toolCalls: toolCallCount, timeoutMs };
    }, 1000);
    agentProgressData = { running: true, elapsed: 0, toolCalls: 0, timeoutMs };

    let result: any;
    let resultMode: 'streamText' | 'generateText' | 'litellm' = isCodex ? 'litellm' : (codexForceNonStream ? 'generateText' : 'streamText');
    let codexLiteUsage: { inputTokens: number; outputTokens: number; totalTokens: number } | null = null;
    let codexLiteMetrics: {
      steps: number;
      toolCalls: number;
      toolCallSuccesses: number;
      toolCallFailures: number;
      emptyToolIntentRetries: number;
      unresolvedEmptyToolIntentSteps: number;
    } | null = null;
    let fullResponse = '';
    // Collect ordered conversation events for persistence (Phase 9.1: rich conversation history)
    const conversationEvents: Array<{ role: string; content: string }> = [];
    // Capture user intent for playbook generation
    conversationEvents.push({ role: 'user', content: userMessage });

    // ─── Retry Loop: wrap LLM call + stream in retry for transient errors ───
    const MAIN_MAX_RETRIES = 3;
    for (let mainAttempt = 0; mainAttempt <= MAIN_MAX_RETRIES; mainAttempt++) {
    try {
      // Stream-start fires on first chunk from LLM (no early artificial indicators).
      console.log('[agent] Calling LLM:', llmConfig.provider, llmConfig.model, 'key:', llmConfig.apiKey.slice(0, 4) + '***');
      const providerOptions = buildProviderOptions(llmConfig);

      // Codex (openai-codex) routes through the dedicated Codex backend with OpenAI-compatible chat.
      // Keep provider-level reasoning defaults while preserving shared call path.
      const callProviderOptions: Record<string, any> = withCodexProviderOptions(
        llmConfig.provider,
        { ...providerOptions },
        activeSystemPrompt,
      );

      console.log('[agent] Thinking:', llmConfig.thinking !== false ? 'ON' : 'OFF', '| providerOptions:', JSON.stringify(callProviderOptions));

      const handleStepFinish = async (event: any) => {
        try {
          const toolCalls = event.toolCalls || [];
          const toolResults = event.toolResults || [];
          const finishReason = String(event.finishReason ?? 'n/a');
          const toolIntent = /tool/i.test(finishReason) || toolCalls.length > 0;

          console.log(`[agent] STEP FINISH — step: ${event.stepNumber ?? '?'}, finishReason: ${finishReason}, tools: ${toolResults.length}, parsed_calls: ${toolCalls.length}, tool_intent: ${toolIntent ? 'yes' : 'no'}, text: ${(event.text?.length ?? 0)} chars, reasoning: ${(event.reasoningText?.length ?? 0)} chars`);

          // Update progress state (replaces simple idleCount)
          const hasActiveTeammates = getActiveTeammateCount() > 0;
          updateProgressState(progressState, {
            toolCalls: toolCalls.map((tc: any) => ({ toolName: tc.toolName, args: tc.args })),
            toolResults: toolResults.map((tr: any) => ({ toolName: tr.toolName || 'unknown', result: tr.output ?? tr.result })),
            hasActiveTeammates,
          });

          // Detect anomalous "finishReason=tool-calls but 0 actual calls" — always a bug
          if (/tool/i.test(finishReason) && toolCalls.length === 0 && toolResults.length === 0) {
            emptyToolCallFinishCount++;
            console.warn(`[agent] Empty tool-call finish detected (count: ${emptyToolCallFinishCount})`);
          }

          for (const tc of toolCalls) {
            try {
              agentEvents.emit('tool', {
                type: 'tool-call',
                toolName: tc.toolName,
                args: tc.args ?? {},
              });
            } catch {}
            // Capture tool call arguments for playbook generation
            conversationEvents.push({ role: 'tool-call', content: formatToolCallArgs(tc.toolName, tc.args ?? {}) });
          }

          for (const tr of toolResults) {
            const toolName = tr.toolName || 'unknown';
            const rawOutput = tr.output ?? tr.result ?? '';
            const resultStr = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput) ?? '(empty)';

            toolsUsed.push(toolName);
            toolCallCount++;

            // Domain playbook: attribute non-navigate tools to most recently visited domain
            if (toolName !== 'navigate' && toolName !== 'search') {
              const lastDomain = [...domainsVisited].pop();
              if (lastDomain) {
                domainToolCounts.set(lastDomain, (domainToolCounts.get(lastDomain) || 0) + 1);
              }
            }

            // Duplicate detection: same tool + same args 3x in a row
            const argsStr = JSON.stringify(tr.args ?? {});
            recentCalls.push({ tool: toolName, args: argsStr });
            if (recentCalls.length > 3) recentCalls.shift();
            if (
              recentCalls.length === 3 &&
              recentCalls.every(c => c.tool === toolName && c.args === argsStr)
            ) {
              dupHintPending = true;
              recentCalls = [];
            }

            // Status/info tools get full display; action tools get truncated
            // present_download returns HTML that the UI parses — must not be truncated
            const isInfoTool = /^(team_status|task_list|task_get|list_|file_list|exec_list|browsing_history|downloads|present_download)/.test(toolName);
            const maxDisplay = isInfoTool ? 1500 : 200;
            const display = `🔧 ${toolName}${resultStr.length > maxDisplay ? '\n' + resultStr.slice(0, maxDisplay) + '...' : resultStr.length > 50 ? '\n' + resultStr : ' → ' + resultStr}`;
            broadcast('agent:tool-result', { toolName, result: resultStr, display });
            try { agentEvents.emit('tool', { type: 'tool-result', toolName, result: resultStr.slice(0, 500) }); } catch {}
            // Persist tool result for conversation history
            conversationEvents.push({ role: 'tool', content: display });
          }
        } catch (stepErr: any) {
          console.error('[agent] onStepFinish error:', stepErr?.message || stepErr);
        }
      };

      if (isCodex) {
        resultMode = 'litellm';

        let codexReasoningBuffer = '';
        let codexReasoningChunkCount = 0;
        let codexTextChunkCount = 0;

        const codexRun = await runLiteLLMCodexToolLoop({
          config: llmConfig,
          system: activeSystemPrompt,
          messages: messages as any,
          tools,
          maxSteps: 200,
          providerOptions: callProviderOptions,
          abortSignal: abortController.signal,
          prepareStep: async ({ messages: currentMessages }) => {
            let injectedMessages = [...currentMessages];
            // 80% timeout warning injection (parity with AI SDK prepareStep path)
            if (warningPending && !warningInjected) {
              warningInjected = true;
              const elapsed = Date.now() - runStart;
              const elapsedMin = Math.floor(elapsed / 60000);
              const totalMin = Math.floor(timeoutMs / 60000);
              const warningMsg = `[⏰ Approaching timeout (${elapsedMin}m of ${totalMin}m). Wrap up your current task.]`;
              console.log('[agent] Injecting timeout warning');
              injectedMessages.push({ role: 'user', content: warningMsg } as any);
            }
            // Duplicate detection hint injection
            if (dupHintPending) {
              dupHintPending = false;
              injectedMessages.push({
                role: 'user',
                content: "[You're repeating the same action. Try a different approach.]",
              } as any);
            }
            // Detect "finishReason=tool-calls but 0 parsed calls" stall — abort after 2
            if (emptyToolCallFinishCount >= 2) {
              console.warn(`[agent] Tool-call finish with 0 parsed calls ${emptyToolCallFinishCount}x — aborting to prevent stall`);
              stopReason = 'idle';
              _lastStopReason = 'idle';
              abortController.abort();
              return undefined;
            }
            // Team-aware idle suppression + progress assessment
            const hasActiveTeammates = getActiveTeammateCount() > 0;
            if (!hasActiveTeammates) {
              const assessment = assessProgress(progressState);
              if (assessment.action === 'abort') {
                console.log(`[agent] Progress assessment: ABORT — ${assessment.reason}`);
                stopReason = 'idle';
                _lastStopReason = 'idle';
                abortController.abort();
                return undefined;
              }
              if (assessment.action === 'inject_reflection') {
                injectedMessages.push({ role: 'user', content: buildReflectionPrompt(progressState) } as any);
              }
              if (assessment.action === 'inject_course_correction') {
                injectedMessages.push({ role: 'user', content: buildCourseCorrection(assessment.reason || 'stuck') } as any);
              }
            }
            // Tool result truncation
            truncateToolResults(injectedMessages, { recentMaxBytes: 8192, olderMaxBytes: 2048 });
            return injectedMessages !== currentMessages ? { messages: injectedMessages } : undefined;
          },
          onReasoningDelta: (delta: string) => {
            codexReasoningChunkCount++;
            codexReasoningBuffer += delta;

            if (!streamStarted) {
              broadcast('agent:stream-start', {});
              streamStarted = true;
            }

            const snippet = codexReasoningBuffer.length > 400
              ? '…' + codexReasoningBuffer.slice(-400)
              : codexReasoningBuffer;
            broadcast('agent:reasoning-chunk', { text: snippet, done: false });
          },
          onTextDelta: (delta: string) => {
            codexTextChunkCount++;
            if (!streamStarted) {
              broadcast('agent:stream-start', {});
              streamStarted = true;
            }
            fullResponse += delta;
            _activePartialResponse = fullResponse;
            sendChunk(mainWindow, delta, false, ariaWebContents);
          },
          onToolCall: (tc) => {
            try {
              agentEvents.emit('tool', {
                type: 'tool-call',
                toolName: tc.name,
                args: tc.args ?? {},
              });
            } catch {}
          },
          onStepFinish: async (event) => {
            if (event.toolIntent) codexToolIntentSteps++;
            codexParsedToolCalls += event.toolCalls.length;
            codexExecutedToolResults += event.toolResults.length;
            if (event.toolIntent && event.toolCalls.length === 0 && event.toolResults.length === 0) {
              codexToolFailureCount++;
            }

            await handleStepFinish({
              stepNumber: event.stepNumber,
              finishReason: event.finishReason,
              toolCalls: event.toolCalls.map(tc => ({ toolName: tc.name, args: tc.args })),
              toolResults: event.toolResults.map(tr => ({ toolName: tr.toolName, output: tr.output, result: tr.output, args: tr.args })),
              text: event.text,
              reasoningText: event.reasoningText,
            });
          },
          logPrefix: 'agent.codex.backend',
        });

        if (codexReasoningBuffer.length > 0) {
          broadcast('agent:reasoning-chunk', { text: codexReasoningBuffer, done: true });
          conversationEvents.push({ role: 'thinking', content: codexReasoningBuffer });
        }

        console.log(`[agent] Codex backend stream done — textChunks=${codexTextChunkCount}, reasoningChunks=${codexReasoningChunkCount}`);

        codexLiteUsage = codexRun.usage;
        codexLiteMetrics = codexRun.metrics;
        fullResponse = codexRun.text || fullResponse;
        _activePartialResponse = fullResponse;

        codexNeedsNonStreamRetry = codexRun.metrics.unresolvedEmptyToolIntentSteps > 0;

        result = {
          text: fullResponse,
          steps: codexRun.steps,
          usage: Promise.resolve(codexRun.usage),
          response: Promise.resolve({ messages: codexRun.responseMessages || [] }),
        };
      } else {
        // ── Plan mode overrides ─────────────────────────────────────────
        const planModeSystemPrefix = opts.planMode ? `\n## PLAN MODE ACTIVE\nYou are in planning mode. The user wants you to think through an approach before executing.\n\nREQUIREMENTS:\n1. Analyze the request thoroughly\n2. Produce a clear, numbered plan with concrete steps\n3. If steps can be parallelized, indicate which ones (these will use agent teams)\n4. Be specific about which tools and actions each step would use\n5. Do NOT execute any actions — only describe what you WOULD do\n6. End with: "Ready to execute when you approve."\n\n` : '';
        const effectiveTools = opts.planMode ? {} : tools;
        const effectiveStopWhen = opts.planMode ? stepCountIs(1) : stepCountIs(200);

        const llmCallBase: Record<string, any> = {
          model,
          system: planModeSystemPrefix + activeSystemPrompt,
          messages: messages as any,
          tools: effectiveTools,
          ...(llmConfig.provider !== 'openai-codex' ? { maxOutputTokens: 30000 } : {}),
          ...(Object.keys(callProviderOptions).length > 0 ? { providerOptions: callProviderOptions } : {}),
          stopWhen: effectiveStopWhen,
          abortSignal: abortController.signal,
          prepareStep: async ({ messages: currentMessages }: { messages: any[] }) => {
            let injectedMessages = [...currentMessages];

            // 80% timeout warning injection
            if (warningPending && !warningInjected) {
              warningInjected = true;
              const elapsed = Date.now() - runStart;
              const elapsedMin = Math.floor(elapsed / 60000);
              const totalMin = Math.floor(timeoutMs / 60000);
              const warningMsg = `[⏰ Approaching timeout (${elapsedMin}m of ${totalMin}m). Wrap up your current task.]`;
              console.log('[agent] Injecting timeout warning');
              injectedMessages.push({ role: 'user', content: warningMsg } as any);
            }
            // Duplicate detection hint injection
            if (dupHintPending) {
              dupHintPending = false;
              injectedMessages.push({
                role: 'user',
                content: "[You're repeating the same action. Try a different approach.]",
              } as any);
            }
            // Detect "finishReason=tool-calls but 0 parsed calls" stall — abort after 2
            if (emptyToolCallFinishCount >= 2) {
              console.warn(`[agent] Tool-call finish with 0 parsed calls ${emptyToolCallFinishCount}x — aborting to prevent stall`);
              stopReason = 'idle';
              _lastStopReason = 'idle';
              abortController.abort();
              return undefined;
            }

            // ─── Team-aware idle suppression ────────────────────────
            // When teammates are running, suppress idle/progress checks entirely.
            // The main agent IS making progress — its teammates are working.
            const hasActiveTeammates = getActiveTeammateCount() > 0;
            if (!hasActiveTeammates) {
              // Progress assessment (replaces crude idleCount >= 5 → abort)
              const assessment = assessProgress(progressState);
              if (assessment.action === 'abort') {
                console.log(`[agent] Progress assessment: ABORT — ${assessment.reason}`);
                stopReason = 'idle';
                _lastStopReason = 'idle';
                abortController.abort();
                return undefined;
              }
              if (assessment.action === 'inject_reflection') {
                console.log(`[agent] Progress assessment: inject reflection — ${assessment.reason}`);
                injectedMessages.push({ role: 'user', content: buildReflectionPrompt(progressState) } as any);
              }
              if (assessment.action === 'inject_course_correction') {
                console.log(`[agent] Progress assessment: inject course correction — ${assessment.reason}`);
                injectedMessages.push({ role: 'user', content: buildCourseCorrection(assessment.reason || 'stuck') } as any);
              }

              // ─── Step-based self-reflection (every 25 tool-calling steps) ──
              if (toolCallCount >= 25 && toolCallCount - lastReflectionStep >= 25) {
                lastReflectionStep = toolCallCount;
                const elapsedMin = Math.floor((Date.now() - runStart) / 60_000);
                console.log(`[agent] Injecting self-check at step ${toolCallCount}`);
                injectedMessages.push({ role: 'user', content: buildSelfCheckPrompt(toolCallCount, elapsedMin) } as any);
              }

              // ─── Time-based reflection (every 10 minutes) ─────────────────
              const now = Date.now();
              if (now - lastTimeReflectionMs >= 600_000) {
                lastTimeReflectionMs = now;
                const elapsedMin = Math.floor((now - runStart) / 60_000);
                console.log(`[agent] Injecting time-based reflection at ${elapsedMin}m`);
                injectedMessages.push({ role: 'user', content: buildTimeReflection(elapsedMin) } as any);
              }
            }

            // ─── Tool result truncation (every step) ────────────────────
            truncateToolResults(injectedMessages, { recentMaxBytes: 8192, olderMaxBytes: 2048 });

            // ─── Proactive mid-run compaction ───────────────────────────
            if (!compactionInProgress) {
              const estimatedTokens = estimateMessageTokens(injectedMessages);
              if (estimatedTokens > 80_000) { // 80% of 100K budget
                compactionInProgress = true;
                console.log(`[agent] Context pressure high (${estimatedTokens} est. tokens) — triggering mid-run compaction`);
                forceCompaction(sessionId, async (prompt: string) => {
                  try {
                    const secondaryConfig = getModelConfig('secondary', llmConfig);
                    const compactModel = createModel(secondaryConfig);
                    const compactProviderOptions = buildProviderOptions(secondaryConfig);
                    const compactResult = await generateText({
                      model: compactModel,
                      prompt,
                      maxOutputTokens: 500,
                      ...(Object.keys(compactProviderOptions).length > 0 ? { providerOptions: compactProviderOptions } : {}),
                    });
                    return compactResult.text || '';
                  } catch (e: any) {
                    console.error('[agent] Mid-run compaction LLM call failed:', e?.message);
                    return '';
                  }
                }).catch(e => {
                  console.error('[agent] Mid-run compaction error:', e?.message);
                }).finally(() => {
                  compactionInProgress = false;
                });
              }
            }

            return injectedMessages !== currentMessages ? { messages: injectedMessages } : undefined;
          },
          onStepFinish: handleStepFinish,
        };

        if (codexForceNonStream) {
          resultMode = 'generateText';
          result = await generateText(llmCallBase as any);
        } else {
          resultMode = 'streamText';
          result = streamText(llmCallBase as any);
        }
      }
    } catch (initErr: any) {
      clearTimeout(timeoutHandle);
      clearTimeout(warningHandle);
      clearInterval(progressInterval);
      agentProgressData = { running: false, elapsed: 0, toolCalls: 0, timeoutMs: 0 };
      if (llmConfig.provider === 'openai-codex') {
        logProviderRequestError('agent.main.init', initErr);
      } else {
        console.error('[agent] Init error:', initErr?.message || initErr);
      }
      const initDetails = extractRequestErrorDetails(initErr, 1200);
      sendError(mainWindow, initDetails.responseBody || initDetails.message || 'Failed to start LLM call', ariaWebContents);
      errorSent = true;
      return;
    }

    try {
      console.log('[agent] Starting', resultMode, '...');
      let reasoningBuffer = '';
      let reasoningChunkCount = 0;
      let textChunkCount = 0;

      if (resultMode === 'streamText') {
        for await (const chunk of result.fullStream) {
          if (abortController.signal.aborted) break;

          if (chunk.type === 'reasoning-start') {
            console.log('[agent] Thinking started');
            // Kick off stream-start so the UI is ready before reasoning text arrives
            if (!streamStarted) {
              broadcast('agent:stream-start', {});
              streamStarted = true;
            }

          } else if (chunk.type === 'reasoning-delta') {
            reasoningChunkCount++;
            const rdelta = (chunk as any).delta ?? (chunk as any).text ?? (chunk as any).textDelta ?? '';
            if (reasoningChunkCount === 1) console.log('[agent] First reasoning token — keys:', Object.keys(chunk as any).join(','), '| delta len:', rdelta.length);
            if (reasoningChunkCount % 50 === 0) console.log(`[agent] Thinking... (${reasoningBuffer.length} chars)`);
            reasoningBuffer += rdelta;
            // Rolling 400-char preview so the chip stays snappy
            const snippet = reasoningBuffer.length > 400 ? '…' + reasoningBuffer.slice(-400) : reasoningBuffer;
            broadcast('agent:reasoning-chunk', { text: snippet, done: false });

          } else if (chunk.type === 'reasoning-end') {
            console.log(`[agent] Thinking done — ${reasoningBuffer.length} chars`);
            // Collapse chip with full text
            broadcast('agent:reasoning-chunk', { text: reasoningBuffer, done: true });
            // Persist thinking for conversation history
            if (reasoningBuffer.length > 0) {
              conversationEvents.push({ role: 'thinking', content: reasoningBuffer });
            }
            reasoningBuffer = '';

          } else if (chunk.type === 'text-delta') {
            textChunkCount++;
            if (!streamStarted) {
              console.log('[agent] First chunk received');
              broadcast('agent:stream-start', {});
              streamStarted = true;
            }
            // Collapse any still-open reasoning chip before text starts
            if (reasoningBuffer) {
              broadcast('agent:reasoning-chunk', { text: reasoningBuffer, done: true });
              if (reasoningBuffer.length > 0) {
                conversationEvents.push({ role: 'thinking', content: reasoningBuffer });
              }
              reasoningBuffer = '';
            }
            const textDelta = (chunk as any).delta ?? (chunk as any).text ?? '';
            if (textChunkCount === 1) console.log('[agent] First text token — keys:', Object.keys(chunk as any).join(','), '| delta len:', textDelta.length);
            fullResponse += textDelta;
            _activePartialResponse = fullResponse; // Phase 9.096d: live tracking for interrupt
            sendChunk(mainWindow, textDelta, false, ariaWebContents);

          } else if (chunk.type === 'finish') {
            const finishMeta = chunk as any;
            console.log(`[agent] FINISH — finishReason: ${finishMeta.finishReason ?? 'n/a'}, reasoningChunks: ${reasoningChunkCount}, textChunks: ${textChunkCount}, response: ${fullResponse.length} chars, usage:`, JSON.stringify(finishMeta.usage ?? {}));
            if (reasoningBuffer) {
              broadcast('agent:reasoning-chunk', { text: reasoningBuffer, done: true });
              if (reasoningBuffer.length > 0) {
                conversationEvents.push({ role: 'thinking', content: reasoningBuffer });
              }
              reasoningBuffer = '';
            }
          }
          // log any unrecognised chunk types once so we can see what the stream is delivering
          else {
            const ct = (chunk as any).type;
            const known = [
              'start', 'start-step', 'finish-step',
              'text-start', 'text-end',
              'tool-call', 'tool-result',
              'tool-input-start', 'tool-input-delta', 'tool-input-end',
              'tool-output-available', 'tool-output-error',
              'raw', 'response-metadata', 'source',
            ];
            if (!known.includes(ct)) {
              console.log('[agent] unhandled chunk type:', ct);
            }
          }

          const anyChunk = chunk as any;
          const chunkType = String(anyChunk.type || '');

          // Robust tool-call assembly for fragmented streamed deltas.
          if (chunkType === 'tool-input-start') {
            const idx = Number.isFinite(Number(anyChunk.toolCallIndex))
              ? Number(anyChunk.toolCallIndex)
              : codexStreamToolInputByIndex.size;
            const existing = codexStreamToolInputByIndex.get(idx);
            codexStreamToolInputByIndex.set(idx, {
              toolName: anyChunk.toolName || existing?.toolName || 'unknown',
              argsText: existing?.argsText || '',
              finalized: false,
            });
          } else if (chunkType === 'tool-input-delta') {
            const idx = Number.isFinite(Number(anyChunk.toolCallIndex))
              ? Number(anyChunk.toolCallIndex)
              : codexStreamToolInputByIndex.size;
            const existing = codexStreamToolInputByIndex.get(idx) || {
              toolName: anyChunk.toolName || 'unknown',
              argsText: '',
              finalized: false,
            };
            const delta = anyChunk.delta ?? anyChunk.text ?? anyChunk.textDelta ?? anyChunk.inputTextDelta ?? '';
            if (typeof delta === 'string' && delta.length > 0) {
              existing.argsText += delta;
            }
            if (!existing.toolName && anyChunk.toolName) existing.toolName = anyChunk.toolName;
            codexStreamToolInputByIndex.set(idx, existing);
          } else if (chunkType === 'tool-input-end') {
            const idx = Number.isFinite(Number(anyChunk.toolCallIndex))
              ? Number(anyChunk.toolCallIndex)
              : codexStreamToolInputByIndex.size;
            const existing = codexStreamToolInputByIndex.get(idx) || {
              toolName: anyChunk.toolName || 'unknown',
              argsText: '',
              finalized: false,
            };
            if (existing.finalized) continue;
            if (typeof anyChunk.input === 'string' && anyChunk.input.length > 0) {
              existing.argsText = anyChunk.input;
            }
            const args = anyChunk.args ?? anyChunk.input ?? parseJsonArgsSafe(existing.argsText);
            existing.finalized = true;
            codexStreamToolInputByIndex.set(idx, existing);
            codexStreamAssembledCalls++;
            try {
              agentEvents.emit('tool', {
                type: 'tool-call',
                toolName: anyChunk.toolName || existing.toolName || 'unknown',
                args,
              });
            } catch {}
          }

          // Emit tool events for SSE consumers (support both classic and provider-executed chunk variants)
          if (chunk.type === 'tool-call') {
            try {
              agentEvents.emit('tool', {
                type: 'tool-call',
                toolName: anyChunk.toolName,
                args: anyChunk.args ?? anyChunk.input ?? {},
              });
            } catch {}
          }
          if (chunk.type === 'tool-result' || anyChunk.type === 'tool-output-available') {
            const raw = anyChunk.result ?? anyChunk.output ?? '';
            const resultStr = typeof raw === 'string' ? raw.slice(0, 500) : JSON.stringify(raw).slice(0, 500);
            try { agentEvents.emit('tool', { type: 'tool-result', toolName: anyChunk.toolName, result: resultStr }); } catch {}
          }
        }
      } else if (resultMode === 'generateText') {
        const generatedText = (result?.text || '').toString();
        fullResponse = generatedText;
        _activePartialResponse = fullResponse;
        if (!streamStarted) {
          broadcast('agent:stream-start', {});
          streamStarted = true;
        }
        if (generatedText) {
          sendChunk(mainWindow, generatedText, false, ariaWebContents);
        }

        // Non-stream fallback path: emit tool events from deterministic step data.
        const steps = Array.isArray(result?.steps) ? result.steps : [];
        for (const step of steps) {
          for (const tc of (step?.toolCalls || [])) {
            try {
              agentEvents.emit('tool', { type: 'tool-call', toolName: tc.toolName, args: tc.args ?? {} });
            } catch {}
          }
          for (const tr of (step?.toolResults || [])) {
            const raw = tr?.result ?? tr?.output ?? '';
            const resultStr = typeof raw === 'string' ? raw.slice(0, 500) : JSON.stringify(raw).slice(0, 500);
            try {
              agentEvents.emit('tool', { type: 'tool-result', toolName: tr?.toolName, result: resultStr });
            } catch {}
          }
        }
      } else {
        // Codex backend path streams chunks + tool events directly via callbacks.
      }

      console.log('[agent] Stream complete, response:', fullResponse.length, 'chars, tools:', toolsUsed.length, '| mode:', resultMode);
      break; // Success — exit retry loop
    } catch (streamErr: any) {
      // AbortError = intentional stop (timeout, idle detection, or manual stop) — never retry
      if (streamErr?.name === 'AbortError') {
        if (stopReason === 'timeout') {
          // Graceful timeout: preserve partial output + append notice + continuation state
          const elapsed = Date.now() - runStart;
          const min = Math.floor(elapsed / 60000);
          const sec = Math.floor((elapsed % 60000) / 1000);
          const durStr = min > 0 ? `${min}m ${sec}s` : `${sec}s`;
          const notice = `\n\n---\n⏰ Agent timed out after ${durStr}. ${toolCallCount} tool calls completed. To continue, send a follow-up message.`;
          if (!streamStarted) broadcast('agent:stream-start', {});
          // Build continuation state for resume on next message
          const lastTool = toolsUsed.length > 0 ? toolsUsed[toolsUsed.length - 1] : 'none';
          setContinuationState(sessionId, buildContinuationState('timeout', toolCallCount, lastTool, elapsed, fullResponse));
          if (fullResponse) {
            sendChunk(mainWindow, notice, true, ariaWebContents);
            addMessage(sessionId, { role: 'assistant' as const, content: fullResponse + notice });
          } else if (toolsUsed.length > 0) {
            sendChunk(mainWindow, `⏰ Timed out after ${durStr}. ${toolCallCount} tool calls completed: ${[...new Set(toolsUsed)].join(', ')}. To continue, send a follow-up message.`, true, ariaWebContents);
          } else {
            sendChunk(mainWindow, `⏰ Agent timed out after ${durStr}.`, true, ariaWebContents);
          }
        } else if (stopReason === 'idle') {
          // Idle detection triggered — agent was done but didn't signal
          if (!streamStarted) broadcast('agent:stream-start', {});
          if (fullResponse) {
            sendChunk(mainWindow, '', true, ariaWebContents);
          } else {
            sendChunk(mainWindow, '✓ Done (idle stop).', true, ariaWebContents);
          }
        } else if (_lastStopReason === 'redirect') {
          // Redirect interrupt — send brief indicator; the re-run will start immediately
          if (!streamStarted) broadcast('agent:stream-start', {});
          sendChunk(mainWindow, '↪ Redirecting…', true, ariaWebContents);
        } else {
          // Manual stop
          if (!streamStarted) broadcast('agent:stream-start', {});
          sendChunk(mainWindow, '⏹ Stopped.', true, ariaWebContents);
        }
        return;
      }

      // ─── Retry on transient errors ─────────────────────────────────
      const classified = classifyError(streamErr);
      if (classified.retryable && mainAttempt < MAIN_MAX_RETRIES) {
        const delayMs = classified.suggestedDelayMs * (mainAttempt + 1);
        console.warn(`[agent] ${classified.category} error (attempt ${mainAttempt + 1}/${MAIN_MAX_RETRIES + 1}), retrying in ${delayMs}ms: ${streamErr?.message?.slice(0, 200)}`);

        // Notify UI about retry
        if (!streamStarted) {
          broadcast('agent:stream-start', {});
          streamStarted = true;
        }
        sendChunk(mainWindow, `\n[Retrying after ${classified.category} error...]`, false, ariaWebContents);

        // On context_length error, force compaction before retry
        if (classified.category === 'context_length') {
          try {
            await forceCompaction(sessionId, async (prompt: string) => {
              const secondaryConfig = getModelConfig('secondary', llmConfig);
              const compactModel = createModel(secondaryConfig);
              const compactResult = await generateText({ model: compactModel, prompt, maxOutputTokens: 500 });
              return compactResult.text || '';
            });
          } catch (compErr: any) {
            console.error('[agent] Compaction before retry failed:', compErr?.message);
          }
        }

        await new Promise(r => setTimeout(r, delayMs));
        continue; // Retry
      }

      // Not retryable or attempts exhausted — save continuation state and fail
      if (llmConfig.provider === 'openai-codex') {
        logProviderRequestError('agent.main.stream', streamErr);
      } else {
        console.error('[agent] Stream error:', streamErr?.message || streamErr);
      }
      if (!errorSent) {
        const lastTool = toolsUsed.length > 0 ? toolsUsed[toolsUsed.length - 1] : 'none';
        setContinuationState(sessionId, buildContinuationState('error', toolCallCount, lastTool, Date.now() - runStart, fullResponse));
        const details = extractRequestErrorDetails(streamErr, 1200);
        const errMsg = details.responseBody || details.message || 'Stream error';
        sendError(mainWindow, `${errMsg}. To continue, send a follow-up message.`, ariaWebContents);
        errorSent = true;
      }
      return;
    } finally {
      clearTimeout(timeoutHandle);
      clearTimeout(warningHandle);
      clearInterval(progressInterval);
      agentProgressData = { running: false, elapsed: Date.now() - runStart, toolCalls: toolCallCount, timeoutMs };
    }
    } // end retry loop

    // ─── Team monitoring continuation ─────────────────────────────────────────
    // If the agent's stream ended but teammates are still active, restart with a
    // monitoring prompt. This ensures the agent doesn't return prematurely.
    if (!errorSent && stopReason !== 'timeout') {
      let teamContRounds = 0;
      const MAX_TEAM_CONT = 10;
      while (getActiveTeammateCount() > 0 && teamContRounds < MAX_TEAM_CONT) {
        teamContRounds++;
        const activeCount = getActiveTeammateCount();
        console.log(`[agent] Team continuation round ${teamContRounds} — ${activeCount} teammate(s) still active`);

        // Persist current output
        if (fullResponse) {
          addMessage(sessionId, { role: 'assistant' as const, content: fullResponse });
          sendChunk(mainWindow, '', true, ariaWebContents);
          fullResponse = '';
        }

        // Inject monitoring prompt
        addMessage(sessionId, { role: 'user' as const, content: `[SYSTEM] ${activeCount} teammate(s) still working. Call wait_for_team to wait for their completion, or use team_status to check progress. Do NOT finalize or call team_delete until all teammates are done. Present combined results only after all teammates complete.` });
        broadcast('agent:stream-start', {});

        // New streamText call for continuation
        const contProviderOptions = buildProviderOptions(llmConfig);
        const contCallProviderOptions = withCodexProviderOptions(
          llmConfig.provider,
          { ...contProviderOptions },
          activeSystemPrompt,
        );
        const contAbort = new AbortController();
        const contTimeout = setTimeout(() => contAbort.abort(), 10 * 60 * 1000); // 10 min per round

        try {
          const contMessages = getWindow(sessionId);
          const contResult = streamText({
            model,
            system: activeSystemPrompt,
            messages: contMessages as any,
            tools,
            ...(llmConfig.provider !== 'openai-codex' ? { maxOutputTokens: 30000 } : {}),
            ...(Object.keys(contCallProviderOptions).length > 0 ? { providerOptions: contCallProviderOptions } : {}),
            stopWhen: stepCountIs(200),
            abortSignal: contAbort.signal,
          });

          for await (const chunk of contResult.fullStream) {
            if (contAbort.signal.aborted) break;
            if (chunk.type === 'text-delta') {
              const text = (chunk as any).text ?? (chunk as any).delta ?? (chunk as any).textDelta ?? '';
              fullResponse += text;
              if (text) sendChunk(mainWindow, text, false, ariaWebContents);
            }
          }

          // Persist continuation response
          try {
            const contResp = await contResult.response;
            const contMsgs = contResp?.messages ?? [];
            if (contMsgs.length > 0) addMessages(sessionId, contMsgs as any);
            else if (fullResponse) addMessage(sessionId, { role: 'assistant' as const, content: fullResponse });
          } catch {
            if (fullResponse) addMessage(sessionId, { role: 'assistant' as const, content: fullResponse });
          }

          console.log(`[agent] Team continuation round ${teamContRounds} done — ${fullResponse.length} chars`);
        } catch (contErr: any) {
          if (contErr?.name !== 'AbortError') {
            console.error('[agent] Team continuation error:', contErr?.message);
          }
          break;
        } finally {
          clearTimeout(contTimeout);
        }
      }
    }

    // ─── Persist structured response messages (Phase 7.9) ───────────────────
    // Instead of saving just the flat text, save the full AI SDK ResponseMessage[]
    // which includes tool call content parts + tool result messages.
    // This gives the LLM proper memory of what tools it called and what they returned.

    if (errorSent) {
      // Don't persist or finalize on error
      return;
    }

    if (isCodex) {
      console.log('[agent] Codex tool metrics:', JSON.stringify({
        mode: resultMode,
        toolIntentSteps: codexToolIntentSteps,
        parsedToolCalls: codexParsedToolCalls,
        executedToolResults: codexExecutedToolResults,
        streamAssembledCalls: codexStreamAssembledCalls,
        streamArgParseErrors: codexStreamArgParseErrors,
        emptyParsedToolIntentSteps: codexToolFailureCount,
        unresolvedToolCallFailures: codexToolFailureCount,
        litellmUsage: codexLiteUsage,
        litellmMetrics: codexLiteMetrics,
      }));
    }
    if (isCodex && codexNeedsNonStreamRetry) {
      console.warn('[agent] Codex tool-call anomaly remains after step-level non-stream retry. Continuing with best-effort output and reporting metrics.');
    }
    // Phase 9.12: No auto-retry guardrails. The agent runs once and is trusted
    // to do the right thing. If it needs more work, the user can ask.

    // ─── Emit token usage (Phase 8.25) ──────────────────────────────────────
    try {
      const usage = await result.usage;
      if (usage) {
        broadcast('agent:token-usage', {
          inputTokens: usage.inputTokens || 0,
          outputTokens: usage.outputTokens || 0,
          totalTokens: (usage.inputTokens || 0) + (usage.outputTokens || 0),
        });
        console.log('[agent] Token usage:', usage.inputTokens, 'in +', usage.outputTokens, 'out =', (usage.inputTokens || 0) + (usage.outputTokens || 0), 'total');
      }
    } catch (usageErr: any) {
      console.error('[agent] Failed to get token usage:', usageErr?.message);
    }

    // If the LLM produced nothing (0 text, 0 tools), skip persisting response messages
    // to prevent orphaned tool-call parts from poisoning conversation history.
    if (!fullResponse && toolsUsed.length === 0) {
      console.warn('[agent] Empty response with no tool calls — skipping message persistence to prevent stall');
    } else {
      try {
        const response = await result?.response;
        const responseMessages = response?.messages || [];

        if (responseMessages && responseMessages.length > 0) {
          // Sanitize: strip orphaned tool-call parts (no matching tool-result by toolCallId)
          const sanitized = sanitizeResponseMessages(responseMessages);
          if (sanitized.length > 0) {
            addMessages(sessionId, sanitized as ChatMessage[]);
            console.log('[agent] Persisted', sanitized.length, 'response messages (sanitized from', responseMessages.length, 'raw)');
          } else {
            console.warn('[agent] All response messages were orphaned tool-calls — nothing to persist');
          }
        } else if (fullResponse) {
          // Fallback: if no response messages available, save flat text
          addMessage(sessionId, { role: 'assistant' as const, content: fullResponse });
          console.log('[agent] Persisted flat text response (no structured messages available)');
        }
      } catch (persistErr: any) {
        // If we can't get structured messages, fall back to flat text
        console.error('[agent] Failed to get response messages, falling back to flat text:', persistErr?.message);
        if (fullResponse) {
          addMessage(sessionId, { role: 'assistant' as const, content: fullResponse });
        }
      }
    }

    // ─── Finalize the stream to the UI ──────────────────────────────────────

    // ─── Persist to SQLite conversation store (Phase 9.1: rich history) ─────
    if (conversationId && !errorSent) {
      try {
        // Persist user message (with attachment metadata if present, no base64)
        if (attachments && attachments.length > 0) {
          const persistContent = JSON.stringify({
            text: userMessage,
            attachments: attachments.map((a: any) => ({ name: a.name, mimeType: a.mimeType, size: a.size })),
          });
          addConversationMessage(conversationId, 'user', persistContent);
        } else {
          addConversationMessage(conversationId, 'user', userMessage);
        }

        // Persist intermediate events (thinking, tool results) in order
        for (const evt of conversationEvents) {
          addConversationMessage(conversationId, evt.role, evt.content);
        }

        // Persist final assistant response
        if (fullResponse) {
          addConversationMessage(conversationId, 'assistant', fullResponse);

          // Auto-title after first assistant response in a new conversation
          const msgCount = getConversationMessageCount(conversationId);
          if (msgCount <= 4) { // First 2 exchanges (user + assistant = 2 each)
            generateLLMTitle(conversationId, userMessage, fullResponse, llmConfig, ariaWebContents).catch(err => {
              console.error('[agent] LLM title generation failed, using fallback:', err?.message);
              generateAutoTitleFallback(conversationId, userMessage);
            });
          }
        }

        // Notify Aria tab that the conversation has been updated
        try { if (ariaWebContents && !ariaWebContents.isDestroyed()) ariaWebContents.send('aria:conversation-updated', { conversationId }); } catch {}
      } catch (persistErr: any) {
        console.error('[agent] SQLite persist error (non-fatal):', persistErr?.message);
      }
    }

    // ─── Auto-reconcile script learnings (structural enforcement) ──────────
    // After any script execution, auto-persist fixes/learnings to the stored script.
    // Skips if the agent already called script_persist_fix during execution.
    if (opts.scriptId && !toolsUsed.includes('script_persist_fix')) {
      try {
        console.log('[agent] Script execution complete — auto-reconciling learnings');
        const fixResult = await reconcileScriptFix(
          opts.scriptId,
          opts.scriptInputs || {},
          conversationEvents,
          fullResponse || '',
          llmConfig,
          opts.cliAuth,
        );
        if (fixResult.success) {
          console.log('[agent] Script auto-updated:', fixResult.summary);
          if (ariaWebContents && !ariaWebContents.isDestroyed()) {
            ariaWebContents.send('scripts:auto-updated', {
              scriptId: opts.scriptId,
              summary: fixResult.summary,
            });
          }
        } else {
          console.warn('[agent] Script auto-reconcile skipped:', fixResult.error);
        }
      } catch (reconcileErr: any) {
        console.error('[agent] Script reconcile error (non-fatal):', reconcileErr?.message);
      }
    }

    // ─── Domain Playbook Update ───────────────────────────────────────────
    // After each turn, extract structural domain learnings and persist to SQLite.
    if (domainsVisited.size > 0) {
      try {
        console.log(`[agent] Updating domain playbooks for: ${[...domainsVisited].join(', ')}`);
        const pbResult = await updatePlaybooksFromSession(
          domainsVisited, domainToolCounts, conversationEvents,
          fullResponse || '', llmConfig, opts.cliAuth,
        );
        if (pbResult.updated.length > 0) {
          console.log(`[agent] Playbooks updated: ${pbResult.updated.map(u => `${u.domain} (${u.reason})`).join(', ')}`);
          if (ariaWebContents && !ariaWebContents.isDestroyed()) {
            ariaWebContents.send('domain:playbook-updated', {
              updates: pbResult.updated,
            });
          }
          try { mainWindow.webContents.send('playbooks:updated'); } catch {}
        }
        if (pbResult.errors.length > 0) {
          console.warn(`[agent] Playbook update warnings: ${pbResult.errors.join('; ')}`);
        }
      } catch (pbErr: any) {
        console.error('[agent] Playbook update error (non-fatal):', pbErr?.message);
      }
    }

    if (streamStarted && fullResponse) {
      // Normal completion — LLM produced text
      sendChunk(mainWindow, '', true, ariaWebContents);
    } else if (toolsUsed.length > 0) {
      // Tool calls happened but LLM didn't produce text — summarize what happened
      const summary = `✓ Used ${toolsUsed.length} tool${toolsUsed.length > 1 ? 's' : ''}: ${[...new Set(toolsUsed)].join(', ')}`;
      if (!streamStarted) broadcast('agent:stream-start', {});
      sendChunk(mainWindow, summary, true, ariaWebContents);
    } else {
      // No text and no tools — shouldn't happen but handle gracefully
      if (!streamStarted) broadcast('agent:stream-start', {});
      sendChunk(mainWindow, '✓ Done.', true, ariaWebContents);
    }

    // ─── Vercel SDK Plan Mode: mark pending if plan completed successfully ──
    if (opts.planMode && fullResponse && !errorSent) {
      _pendingPlanApproval = true;
      _pendingPlanOpts = opts;
    }

    // ─── Eviction summary (async, non-blocking) ────────────────────────────
    // If messages have been evicted from the window, generate a summary
    // so the LLM has continuity on the next turn.
    generateEvictionSummaryIfNeeded(sessionId, llmConfig).catch(err => {
      console.error('[agent] Eviction summary error (non-fatal):', err?.message);
    });

  } catch (err: any) {
    if (err.name === 'AbortError') {
      broadcast('agent:stream-start', {});
      if (_lastStopReason === 'timeout') {
        sendChunk(mainWindow, '⏰ Agent timed out.', true, ariaWebContents);
      } else {
        sendChunk(mainWindow, '⏹ Stopped.', true, ariaWebContents);
      }
      return;
    }
    if (llmConfig.provider === 'openai-codex') {
      logProviderRequestError('agent.outer', err);
    }
    if (!errorSent) {
      const details = extractRequestErrorDetails(err, 1200);
      sendError(mainWindow, details.responseBody || details.message || 'Unknown error', ariaWebContents);
    }
  } finally {
    if (activeRun === abortController) activeRun = null;
    _lastStopReason = null;
    // Phase 9.096d: Clear interrupt state on completion
    if (_activeRunOptions === opts) {
      _activeRunOptions = null;
      _activePartialResponse = '';
    }
    // Reset progress data on completion
    if (agentProgressData.running) {
      agentProgressData = { running: false, elapsed: agentProgressData.elapsed, toolCalls: agentProgressData.toolCalls, timeoutMs: agentProgressData.timeoutMs };
    }
  }
}

/**
 * Generate a concise conversation title using the secondary LLM.
 * Fires async after first exchange — non-blocking.
 */
async function generateLLMTitle(
  conversationId: string,
  userMessage: string,
  assistantResponse: string,
  llmConfig: LLMConfig,
  ariaWebContents?: WebContents | null,
): Promise<void> {
  try {
    const secondaryConfig = getModelConfig('secondary', llmConfig);
    const model = createModel(secondaryConfig);
    const providerOptions = buildProviderOptions(secondaryConfig);
    const callProviderOptions: Record<string, any> = withCodexProviderOptions(
      secondaryConfig.provider,
      { ...providerOptions },
      'Generate only a short conversation title.',
      'Generate only a short conversation title.',
    );

    const titlePrompt = `Generate a short, descriptive title (3-6 words) for this conversation. Return ONLY the title text — no quotes, no punctuation at the end, no explanation.

User: ${userMessage.slice(0, 500)}
Assistant: ${assistantResponse.slice(0, 500)}

Title:`;

    let text = '';
    if (secondaryConfig.provider === 'openai-codex') {
      // Codex backend is more stable with streamed Responses calls than generateText.
      const result = streamText({
        model,
        messages: [{ role: 'user', content: titlePrompt }],
        ...(Object.keys(callProviderOptions).length > 0 ? { providerOptions: callProviderOptions } : {}),
      });
      for await (const chunk of result.textStream) {
        text += chunk;
      }
    } else {
      const generated = await generateText({
        model,
        prompt: titlePrompt,
        maxOutputTokens: 30,
        ...(Object.keys(callProviderOptions).length > 0 ? { providerOptions: callProviderOptions } : {}),
      });
      text = generated.text;
    }

    const title = (text || '').replace(/^["']|["']$/g, '').replace(/[.!?]+$/, '').trim();
    if (title && title.length > 2 && title.length < 80) {
      updateConversationTitle(conversationId, title);
      console.log('[agent] LLM auto-title set:', title);
      // Notify Aria tab to refresh sidebar
      try {
        if (ariaWebContents && !ariaWebContents.isDestroyed()) {
          ariaWebContents.send('aria:conversation-updated', { conversationId });
        }
      } catch {}
    } else {
      // LLM returned garbage — fall back
      generateAutoTitleFallback(conversationId, userMessage);
    }
  } catch (err: any) {
    const secondaryConfig = getModelConfig('secondary', llmConfig);
    if (secondaryConfig.provider === 'openai-codex') {
      logProviderRequestError('agent.title', err);
    } else {
      console.error('[agent] LLM title generation error:', err?.message);
    }
    generateAutoTitleFallback(conversationId, userMessage);
  }
}

/**
 * Generate a quick conversation title from user message alone.
 * Fires immediately when user sends first message — parallel to agent execution.
 * This is faster and more reliable than waiting for assistant response.
 * (Phase 9.13: Parallel title generation)
 */
export async function generateQuickTitle(
  conversationId: string,
  userMessage: string,
  llmConfig: LLMConfig,
  ariaWebContents?: WebContents | null,
): Promise<void> {
  try {
    const secondaryConfig = getModelConfig('secondary', llmConfig);
    const model = createModel(secondaryConfig);
    const providerOptions = buildProviderOptions(secondaryConfig);
    const callProviderOptions: Record<string, any> = withCodexProviderOptions(
      secondaryConfig.provider,
      { ...providerOptions },
      'Generate only a short conversation title.',
      'Generate only a short conversation title.',
    );

    // Simple prompt — just the user's message, no assistant response needed
    const titlePrompt = `Generate a short, descriptive title (3-6 words) for a conversation that starts with this message. Return ONLY the title text — no quotes, no punctuation at the end, no explanation.

Message: ${userMessage.slice(0, 300)}

Title:`;

    let text = '';
    if (secondaryConfig.provider === 'openai-codex') {
      const result = streamText({
        model,
        messages: [{ role: 'user', content: titlePrompt }],
        ...(Object.keys(callProviderOptions).length > 0 ? { providerOptions: callProviderOptions } : {}),
      });
      for await (const chunk of result.textStream) {
        text += chunk;
      }
    } else {
      const generated = await generateText({
        model,
        prompt: titlePrompt,
        maxOutputTokens: 30,
        ...(Object.keys(callProviderOptions).length > 0 ? { providerOptions: callProviderOptions } : {}),
      });
      text = generated.text;
    }

    const title = (text || '').replace(/^["']|["']$/g, '').replace(/[.!?]+$/, '').trim();
    if (title && title.length > 2 && title.length < 80) {
      updateConversationTitle(conversationId, title);
      console.log('[agent] Quick title set:', title);
      // Notify Aria tab to refresh sidebar
      try {
        if (ariaWebContents && !ariaWebContents.isDestroyed()) {
          ariaWebContents.send('aria:conversation-updated', { conversationId });
        }
      } catch {}
    } else {
      // LLM returned garbage — fall back
      generateAutoTitleFallback(conversationId, userMessage);
    }
  } catch (err: any) {
    console.error('[agent] Quick title generation error:', err?.message);
    generateAutoTitleFallback(conversationId, userMessage);
  }
}

/**
 * Generate an eviction summary for messages that have fallen out of the rolling window.
 * Uses secondary model (cheap LLM call) to summarize evicted content (Phase 8.85).
 * Non-blocking — failures are logged but don't break the agent.
 */
async function generateEvictionSummaryIfNeeded(sessionId: string, llmConfig: LLMConfig): Promise<void> {
  const evicted = getUnsummarizedEvictedMessages(sessionId);
  if (!evicted) return; // Nothing to summarize

  console.log('[agent] Generating eviction summary for', evicted.messages.length, 'messages (boundary:', evicted.boundary, ')');

  const prompt = buildSummaryPrompt(evicted.messages);

  try {
    // Use secondary model for eviction summaries — simple summarization task (Phase 8.85)
    const secondaryConfig = getModelConfig('secondary', llmConfig);
    const model = createModel(secondaryConfig);
    const providerOptions = buildProviderOptions(secondaryConfig);
    const callProviderOptions: Record<string, any> = withCodexProviderOptions(
      secondaryConfig.provider,
      { ...providerOptions },
      'Summarize prior conversation turns faithfully and concisely.',
      'Summarize prior conversation turns faithfully and concisely.',
    );

    let text = '';
    if (secondaryConfig.provider === 'openai-codex') {
      const result = streamText({
        model,
        messages: [{ role: 'user', content: prompt }],
        ...(Object.keys(callProviderOptions).length > 0 ? { providerOptions: callProviderOptions } : {}),
      });
      for await (const chunk of result.textStream) {
        text += chunk;
      }
    } else {
      const generated = await generateText({
        model,
        prompt,
        maxOutputTokens: 30000, // universal cap
        ...(Object.keys(callProviderOptions).length > 0 ? { providerOptions: callProviderOptions } : {}),
      });
      text = generated.text;
    }

    if (text && text.trim()) {
      const summary = `[Conversation summary — earlier turns evicted from context window. Use history({ grep: "..." }) to search the full uncompacted history if you need details.]\n${text.trim()}\n[End summary — current conversation continues below]`;
      setEvictionSummary(sessionId, summary, evicted.boundary);
      console.log('[agent] Eviction summary set:', text.trim().length, 'chars');
    }
  } catch (err: any) {
    const secondaryConfig = getModelConfig('secondary', llmConfig);
    if (secondaryConfig.provider === 'openai-codex') {
      logProviderRequestError('agent.eviction-summary', err);
    } else {
      console.error('[agent] Failed to generate eviction summary:', err?.message);
    }
    // Non-fatal — the agent will work without the summary, just with less context
  }
}

export function stopAgent() {
  if (activeRun) {
    _lastStopReason = null; // manual stop — no special reason
    activeRun.abort();
    activeRun = null;
  }
  // Phase 9.096e: Cascade stop to all teammates
  teamManager.freezeAllTeammates();
  agentProgressData = { running: false, elapsed: 0, toolCalls: 0, timeoutMs: 0 };
}

/**
 * Phase 9.096d: Interrupt the main agent session and redirect with a new instruction.
 * - Aborts the current stream
 * - Adds partial response + redirect message to conversation history
 * - Re-invokes runAgent with the redirect message so context is preserved
 */
export async function interruptMainSession(message: string): Promise<string> {
  if (!activeRun || !_activeRunOptions) {
    return 'No active agent session to interrupt';
  }

  // Save live state before aborting
  const savedOpts = _activeRunOptions;
  const savedPartial = _activePartialResponse;
  const sessionId = _activeSessionId;

  // Signal redirect so the AbortError handler emits "↪ Redirecting…" instead of "⏹ Stopped."
  _lastStopReason = 'redirect';

  // Abort the current stream
  activeRun.abort();
  activeRun = null;

  // Wait briefly for the abort to propagate
  await new Promise<void>(resolve => setTimeout(resolve, 300));

  // Preserve the partial response in conversation history if any
  if (savedPartial.trim()) {
    addMessage(sessionId, { role: 'assistant' as const, content: savedPartial + '\n\n*(interrupted)*' });
  }

  // Phase 9.096e: Cascade — freeze all teammates and collect their state
  const teamState = teamManager.freezeAllTeammates();

  // Build team context summary for the main agent's redirect
  let teamContext = '';
  if (teamState && teamState.teammates.length > 0) {
    teamContext = '\n\n[TEAM STATE at time of interrupt]\n';
    for (const tm of teamState.teammates) {
      teamContext += `${tm.name} (${tm.status}): ${tm.filesWritten.length} files written, `;
      teamContext += `${tm.worktreeFileCount} worktree files. `;
      if (tm.lastActivity) teamContext += `Last: ${tm.lastActivity}. `;
      teamContext += '\n';
    }
    teamContext += 'Teammates are frozen. You can re-invoke them with team_run_teammate or interrupt them with team_interrupt.\n';
  }

  // Re-invoke with the redirect message (conversation history is preserved in the rolling window)
  const resumeOpts: AgentRunOptions = {
    ...savedOpts,
    userMessage: message + teamContext,
  };

  // Fire-and-forget — the resumed run manages its own lifecycle
  runAgent(resumeOpts).catch(err => {
    console.error('[agent] Redirect re-run error:', err?.message);
  });

  return '↪ Redirected — agent resuming with new instructions';
}
