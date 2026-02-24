/**
 * agent.ts — The agent loop (Phase 8.1: Deep Mode).
 *
 * Wires the agent panel to tools through an LLM via Vercel AI SDK v6.
 * Deep Mode: decomposes complex tasks into focused subtasks.
 * Two deep modes: Action (multi-step DO) and Research (gather + compile).
 */

import { streamText, generateText, stepCountIs } from 'ai';
import type { BrowserWindow, WebContents } from 'electron';
import { EventEmitter } from 'events';
import { createModel, buildProviderOptions, getModelConfig, type LLMConfig } from './llm-client';
import { createTools, TOOL_USAGE_GUIDE } from './tool-registry';
import * as browserTools from './browser-tools';
import * as httpTools from './http-tools';
import * as toolManagerMod from './tool-manager';
import { loadProfile, loadUserProfileTxt } from './user-profile';
import type { BrowserContext } from './browser-tools';

// Global event emitter for API server to subscribe to agent output
export const agentEvents = new EventEmitter();
agentEvents.setMaxListeners(50);

// Phase 8.40: Progress tracking data (read by API server for /api/status)
export interface AgentProgressData {
  running: boolean;
  elapsed: number;
  toolCalls: number;
  timeoutMs: number;
}
export let agentProgressData: AgentProgressData = { running: false, elapsed: 0, toolCalls: 0, timeoutMs: 0 };

import {
  getWindow, addMessage, addMessages,
  clearHistory as clearConversation,
  getUnsummarizedEvictedMessages, setEvictionSummary,
  buildSummaryPrompt,
  type ChatMessage,
} from './conversation';

import {
  addConversationMessage,
  generateAutoTitle,
  getConversationMessageCount,
} from './conversation-store';
import { buildProjectContext } from './project-manager';
import { getDb } from './database';

import { decomposeTask } from './decompose';
import { bootstrapContext } from './coding-memory';
import * as teamManager from './team-manager';
import { runDeepMode } from './subtask-runner';
import { getLoginHint } from './login-state';
import { profileManager } from './profile-manager';
import { sessionManager } from './session-manager';
import { listIdentities } from './password-vault';

export { clearConversation as clearHistory };

/**
 * Assemble minimal context for the LLM.
 *
 * 🚨 ZERO PAGE CONTENT. The page is a black box.
 * The LLM calls `elements`, `text`, `grep` tools when it wants to see the page.
 * Only browser state (title, URL, tab count) and API services are injected.
 */
function assembleContext(browserCtx: BrowserContext, llmConfig?: LLMConfig): string {
  const parts: string[] = [];

  // Current time + timezone (~20 tokens)
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  parts.push(`Time: ${now.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })} (${tz})`);

  // Model context injection (Phase 8.85)
  if (llmConfig) {
    const primaryLabel = `${llmConfig.provider}/${llmConfig.model}`;
    const secondaryLabel = llmConfig.secondaryModel
      ? `${llmConfig.secondaryProvider || llmConfig.provider}/${llmConfig.secondaryModel}`
      : primaryLabel;
    parts.push(`Models: primary=${primaryLabel}, secondary=${secondaryLabel}`);
  }

  // Browser state — title, URL, tab count (~50 tokens)
  try {
    parts.push(browserTools.getBrowserState(browserCtx));
  } catch (e) {
    parts.push('Page: (unavailable)');
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

  // Login detection hint (Phase 8.4.3)
  // If the active tab has a detected login form, inject a credential hint (~30 tokens).
  // This lets the agent proactively offer autofill without being asked.
  try {
    const wc = browserCtx.tabManager.activeWebContents;
    if (wc) {
      const loginHint = getLoginHint(wc.id);
      if (loginHint) parts.push('', loginHint);
    }
  } catch {
    // Non-fatal — agent works fine without the hint
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
  // If current page has multiple identities stored, tell the agent about them.
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

  return parts.join('\n');
}

const SYSTEM_PROMPT = `You are Aria 🪷, an AI agent built into a web browser. You control the browser through tools.

## Core Rule: The Page Is a Black Box

You NEVER see page content in your context. The page is opaque until you query it with tools.
**First move on any page task:** \`elements\` to see what's there, or \`text\` to read content.

## The Grep Philosophy

grep > scroll > read-all. Always.
- \`elements({ grep: "checkout" })\` — searches ALL elements including offscreen
- \`text({ grep: "refund policy" })\` — searches entire page text
- \`history({ grep: "what I said" })\` — searches full conversation history
- Never screenshot to understand a page. \`text\` and \`elements\` are faster and cheaper.
- For canvas apps (Sheets, Docs, Figma), use \`keys\` instead of click/type.

## How APIs work
- \`register_api\` + \`api_key_store\` to configure. Then \`http_request\` with \`auth: "@service"\`.
- Use \`document_endpoint\` to save schemas after browsing API docs — learn once, use forever.
- Responses are saved to files. Use \`file_read\` with grep to extract what you need.

## Style
- Concise. Say what you did and what happened.
- If something fails, try an alternative before giving up.
- Always respond with text after tool calls.
`;

interface AgentRunOptions {
  userMessage: string;
  browserCtx: BrowserContext;
  llmConfig: LLMConfig;
  window: BrowserWindow;
  sessionId?: string;
  developerMode?: boolean;
  deepMode?: boolean;  // true = decompose complex tasks, false = always direct
  codingMode?: boolean; // true = team tools + coding system prompt (Phase 8.38)
  worktreeIsolation?: boolean; // Phase 8.39: git worktree isolation enabled
  agentBrowsingDataAccess?: boolean; // Phase 8.4.1: grant agent access to history/bookmarks/downloads
  conversationId?: string;  // Phase 8.35: SQLite conversation ID for persistence
  ariaWebContents?: WebContents | null; // Phase 8.35: Aria tab webcontents for broadcast
}

const CODING_MODE_SYSTEM_PROMPT_ADDENDUM = `

## Coding Mode — Team Orchestration

**Spawn a team for multi-file tasks.** Single-file fixes are fine to do directly.

**Protocol — Contract-First:**
1. \`team_create\` → 2. \`team_write_contracts\` (BEFORE spawning) → 3. \`team_task_add\` + \`team_run_teammate\` → 4. Monitor with \`team_status\`, merge with \`worktree_merge\`, validate with \`team_validate\` → 5. \`team_advance_phase\` for next batch.

**Rules:**
- Contracts first, teammates second. No code without contracts.
- Teams auto-dissolve when all teammates finish. Don't dissolve manually.
- Trust your teammates. Worktree file counts in \`team_status\` are ground truth.
- Never abandon a team mid-flow for \`spawn_agent\`. Teams have isolation + contracts; sub-agents don't.
- After \`team_interrupt\`, wait 30-60s then check \`team_status\`.

**Contracts:** Types first, one concern per file, no implementations (stubs only), ≤20 lines each, max 5 per phase. Use relative imports that work from worktrees.
`;

let activeRun: AbortController | null = null;
let _lastStopReason: string | null = null; // Phase 8.40: track why agent stopped

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

export async function runAgent(opts: AgentRunOptions): Promise<void> {
  const { userMessage, browserCtx, llmConfig, window: mainWindow, sessionId = 'default', developerMode = false, deepMode = true, codingMode = false, worktreeIsolation = true, agentBrowsingDataAccess = false, conversationId, ariaWebContents } = opts;

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

  // ─── Deep Mode Gate ───────────────────────────────────────────────────────
  // If deep mode is ON, try to decompose the task. The LLM decides if it's
  // simple (direct loop) or complex (action/research deep mode).
  // Phase 9: Skip deep mode when codingMode is on — team orchestration IS
  // the decomposition. The direct agent loop has team tools and will use them.
  if (deepMode !== false && !codingMode) {
    try {
      console.log('[agent] Deep mode ON — attempting decomposition...');
      broadcast('agent:stream-start', {});
      sendChunk(mainWindow, '🧠 Analyzing task complexity...', false, ariaWebContents);

      const decomposition = await decomposeTask(userMessage, llmConfig);

      if (decomposition) {
        console.log('[agent] Decomposed into', decomposition.subtasks.length, 'subtasks, mode:', decomposition.mode);
        // BUG-T13: Do NOT send done=true here — that would make the API resolve with an empty string
        // before deep mode has even run. The API stays open until we emit the final output below.

        // Add user message to history
        addMessage(sessionId, { role: 'user', content: userMessage });

        // BUG-T13: Pass codingMode so subtask runner can load team tools
        const result = await runDeepMode({
          decomposition,
          originalTask: userMessage,
          browserCtx,
          llmConfig,
          window: mainWindow,
          sessionId,
          developerMode,
          codingMode,
          agentBrowsingDataAccess,
          abortSignal: abortController.signal,
          ariaWebContents,
          // Phase 9.07: Forward subtask token usage to the UI token bar
          onTokenUsage: (usage) => {
            try {
              broadcast('agent:token-usage', {
                inputTokens: usage.inputTokens || 0,
                outputTokens: usage.outputTokens || 0,
                totalTokens: (usage.inputTokens || 0) + (usage.outputTokens || 0),
              });
            } catch (e) {
              // Non-fatal — token bar update is best-effort
            }
          },
        });

        // Add summary to conversation history
        const summary = result.aborted
          ? `[Deep mode aborted — ${result.subtasks.filter(s => s.status === 'done').length}/${result.subtasks.length} steps completed]`
          : `[Deep mode ${result.mode}: ${result.subtasks.length} steps completed in ${result.durationSeconds.toFixed(1)}s]\n\n${result.finalOutput.slice(0, 2000)}`;
        addMessage(sessionId, { role: 'assistant' as const, content: summary });

        // ─── Persist deep mode to SQLite conversation store ─────────────
        if (conversationId) {
          try {
            addConversationMessage(conversationId, 'user', userMessage);

            // Persist each subtask step as a tool message for rich history
            for (const subtask of result.subtasks) {
              const status = subtask.status === 'done' ? '✅' : subtask.status === 'failed' ? '❌' : '⏭️';
              const stepSummary = `${status} Step ${(subtask.index ?? 0) + 1}: ${subtask.task || 'Untitled'}`;
              addConversationMessage(conversationId, 'tool', stepSummary);
            }

            const assistantContent = result.aborted
              ? `[Deep mode aborted — ${result.subtasks.filter(s => s.status === 'done').length}/${result.subtasks.length} steps completed]`
              : result.finalOutput || '[Deep mode complete — no final output]';
            addConversationMessage(conversationId, 'assistant', assistantContent);
            const msgCount = getConversationMessageCount(conversationId);
            if (msgCount <= 4) {
              generateAutoTitle(conversationId, assistantContent);
            }
            try { if (ariaWebContents && !ariaWebContents.isDestroyed()) ariaWebContents.send('aria:conversation-updated', { conversationId }); } catch {}
          } catch (persistErr: any) {
            console.error('[agent] Deep mode SQLite persist error (non-fatal):', persistErr?.message);
          }
        }

        // Send completion to UI
        broadcast('agent:deep-complete', {
          mode: result.mode,
          durationSeconds: result.durationSeconds,
          outputDir: result.outputDir,
          outputDirAbsolute: result.outputDirAbsolute,
          aborted: result.aborted,
          completedSteps: result.subtasks.filter(s => s.status === 'done').length,
          totalSteps: result.subtasks.length,
          finalOutput: result.mode === 'research' ? result.finalOutput : undefined,
        });

        // Emit done signal for API listeners. The compile step already streamed
        // its output via deep-stream-chunk events — don't duplicate the full report
        // as a regular chat chunk (that causes a raw unrendered duplicate).
        const deepFinalText = result.aborted
          ? `[Task aborted — ${result.subtasks.filter(s => s.status === 'done').length}/${result.subtasks.length} steps completed]`
          : result.finalOutput || '[Deep mode complete]';
        // For API SSE listeners, emit the final text so they get the response
        try { agentEvents.emit('chunk', { text: deepFinalText, done: true }); } catch {}
        // For UI, just signal done (no text) — content is already in the plan card
        sendChunk(mainWindow, '', true, ariaWebContents);

        activeRun = null;
        return;
      }

      // Task is simple — fall through to direct loop
      console.log('[agent] Task is simple — using direct agent loop');
      // Clear the "analyzing" message WITHOUT closing the stream (done=false)
      // The direct loop below will send its own done=true when complete.
      // Sending done=true here would close SSE connections before the actual response.
      sendChunk(mainWindow, '\n', false, ariaWebContents);

    } catch (decomposeErr: any) {
      console.error('[agent] Decomposition failed, falling back to direct:', decomposeErr?.message);
      // Clear analyzing message WITHOUT closing the stream
      sendChunk(mainWindow, '\n', false, ariaWebContents);
    }
  }

  // ─── Direct Agent Loop (existing) ─────────────────────────────────────────

  let errorSent = false;
  let streamStarted = false;  // hoisted — needed by codingMode early broadcast + lazy guards below
  const toolsUsed: string[] = [];

  try {
    const model = createModel(llmConfig);
    const tools = createTools(browserCtx, sessionId, { developerMode, llmConfig, codingMode, worktreeIsolation, agentBrowsingDataAccess, conversationId });
    const browserContext = assembleContext(browserCtx, llmConfig);

    // ─── Project context injection (Phase 9.07) ────────────────────────────
    // If the current conversation has a project_id, inject a compact project
    // context block (~200-300 tokens) so the agent knows about project state.
    let projectContextBlock = '';
    if (conversationId) {
      try {
        const row = getDb().prepare(
          `SELECT project_id FROM conversations WHERE id = ? LIMIT 1`
        ).get(conversationId) as { project_id: string | null } | undefined;
        if (row?.project_id) {
          projectContextBlock = buildProjectContext(row.project_id);
        }
      } catch (e: any) {
        // Non-fatal — project context is optional
        console.error('[agent] Failed to inject project context:', e?.message);
      }
    }

    // ─── Coding Memory Bootstrap (Phase coding-memory) ────────────────────
    // When in coding mode, check if the active team's project dir (or cwd) has
    // a .tappi-coding-memory/ directory. If so, inject the last 3 sessions + main.md.
    let codingMemoryContext = '';
    if (codingMode) {
      try {
        const activeTeam = teamManager.getActiveTeam();
        const projectDir = activeTeam?.workingDir || process.cwd();
        const memCtx = bootstrapContext(projectDir);
        if (memCtx) {
          codingMemoryContext = '\n\n' + memCtx;
        }
      } catch (memErr: any) {
        // Non-fatal — bootstrap is best-effort
        console.error('[agent] coding-memory bootstrap error:', memErr?.message);
      }
    }

    const activeSystemPrompt = codingMode
      ? SYSTEM_PROMPT + CODING_MODE_SYSTEM_PROMPT_ADDENDUM + codingMemoryContext
      : SYSTEM_PROMPT;
    console.log('[agent] Run starting:', Object.keys(tools).length, 'tools,', browserContext.length, 'chars context (ZERO page elements), devMode:', developerMode, 'deepMode:', deepMode, 'codingMode:', codingMode);

    // Add user message to history
    addMessage(sessionId, { role: 'user', content: userMessage });

    // Build messages for LLM from the rolling window
    const history = getWindow(sessionId);

    // Inject browser state into the last user message as a lightweight system note
    const messages: ChatMessage[] = [];
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      if (i === history.length - 1 && msg.role === 'user' && typeof msg.content === 'string') {
        // Inject browser context (and optional project context) into the last user message
        const ctxParts = [`[Browser: ${browserContext}]`];
        if (projectContextBlock) ctxParts.push(projectContextBlock);
        messages.push({ role: 'user', content: `${ctxParts.join('\n')}\n\n${msg.content}` });
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
    let idleCount = 0;
    let toolCallCount = 0;

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

    // Progress interval: emit agent:progress every second while running
    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - runStart;
      broadcast('agent:progress', { elapsed, toolCalls: toolCallCount, timeoutMs });
      agentProgressData = { running: true, elapsed, toolCalls: toolCallCount, timeoutMs };
    }, 1000);
    agentProgressData = { running: true, elapsed: 0, toolCalls: 0, timeoutMs };

    let result;
    // Collect ordered conversation events for persistence (Phase 9.1: rich conversation history)
    const conversationEvents: Array<{ role: string; content: string }> = [];
    try {
      // In coding mode, deep mode is skipped so no stream-start was sent yet — fire it now
      // so the UI shows a visible indicator while the LLM thinks (can take 30s+ with thinking ON)
      // Set streamStarted here so the lazy !streamStarted guards below don't fire a second start.
      if (codingMode && !streamStarted) {
        broadcast('agent:stream-start', {});
        streamStarted = true;
        sendChunk(mainWindow, '🏗️ Planning with team orchestration...', false, ariaWebContents);
      }
      console.log('[agent] Calling LLM:', llmConfig.provider, llmConfig.model, 'key:', llmConfig.apiKey.slice(0, 4) + '***');
      const providerOptions = buildProviderOptions(llmConfig);
      console.log('[agent] Thinking:', llmConfig.thinking !== false ? 'ON' : 'OFF', '| providerOptions:', JSON.stringify(providerOptions));

      result = streamText({
        model,
        system: activeSystemPrompt,
        messages: messages as any, // AI SDK accepts ModelMessage[]
        tools,
        maxOutputTokens: 2048,
        ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
        // Phase 8.40 + Phase 9 fix: AI SDK v6 defaults to stepCountIs(1) which
        // limits the agent to a single LLM call. Override with 200 steps so the
        // agent loops (navigate → elements → click → …) until it finishes or times out.
        stopWhen: stepCountIs(200),
        abortSignal: abortController.signal,
        prepareStep: async ({ messages: currentMessages }: { messages: any[] }) => {
          // 80% timeout warning injection
          if (warningPending && !warningInjected) {
            warningInjected = true;
            const elapsed = Date.now() - runStart;
            const elapsedMin = Math.floor(elapsed / 60000);
            const totalMin = Math.floor(timeoutMs / 60000);
            const warningMsg = `[⏰ Approaching timeout (${elapsedMin}m of ${totalMin}m). Wrap up your current task.]`;
            console.log('[agent] Injecting timeout warning');
            return { messages: [...currentMessages, { role: 'user', content: warningMsg }] };
          }
          // Duplicate detection hint injection
          if (dupHintPending) {
            dupHintPending = false;
            return {
              messages: [...currentMessages, {
                role: 'user',
                content: "[You're repeating the same action. Try a different approach.]",
              }],
            };
          }
          // Idle detection: 5 consecutive text-only turns → abort
          // Phase 9.096f: In coding mode, lead often waits for teammates (text-only turns
          // are normal). Use a higher threshold to avoid premature stoppage.
          const idleThreshold = codingMode ? 15 : 5;
          if (idleCount >= idleThreshold) {
            console.log(`[agent] Idle detection: ${idleCount} text-only turns — stopping`);
            stopReason = 'idle';
            _lastStopReason = 'idle';
            abortController.abort();
          }
          return undefined;
        },
        onStepFinish: async (event: any) => {
          try {
            const toolResults = event.toolResults || [];

            if (toolResults.length === 0) {
              idleCount++;
            } else {
              idleCount = 0;
            }

            for (const tr of toolResults) {
              const toolName = tr.toolName || 'unknown';
              const rawOutput = tr.output ?? tr.result ?? '';
              const resultStr = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput) ?? '(empty)';

              toolsUsed.push(toolName);
              toolCallCount++;

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
              const isInfoTool = /^(team_status|team_task_list|list_|file_list|exec_list|sub_agent_status|browsing_history|downloads)/.test(toolName);
              const maxDisplay = isInfoTool ? 1500 : 200;
              const display = `🔧 ${toolName}${resultStr.length > maxDisplay ? '\n' + resultStr.slice(0, maxDisplay) + '...' : resultStr.length > 50 ? '\n' + resultStr : ' → ' + resultStr}`;
              broadcast('agent:tool-result', { toolName, result: resultStr, display });
              // Persist tool result for conversation history
              conversationEvents.push({ role: 'tool', content: display });
            }
          } catch (stepErr: any) {
            console.error('[agent] onStepFinish error:', stepErr?.message || stepErr);
          }
        },
      });
    } catch (initErr: any) {
      clearTimeout(timeoutHandle);
      clearTimeout(warningHandle);
      clearInterval(progressInterval);
      agentProgressData = { running: false, elapsed: 0, toolCalls: 0, timeoutMs: 0 };
      console.error('[agent] Init error:', initErr?.message || initErr);
      sendError(mainWindow, initErr?.message || 'Failed to start LLM call', ariaWebContents);
      errorSent = true;
      return;
    }

    let fullResponse = '';

    try {
      console.log('[agent] Starting stream...');
      let reasoningBuffer = '';
      let reasoningChunkCount = 0;
      let textChunkCount = 0;
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
          if (ct !== 'tool-call' && ct !== 'tool-result' && ct !== 'tool-input-start' && ct !== 'tool-input-delta' && ct !== 'raw' && ct !== 'response-metadata' && ct !== 'source') {
            console.log('[agent] unhandled chunk type:', ct);
          }
        }
        // tool-call / tool-result events handled by onStepFinish — skip here
      }
      console.log('[agent] Stream complete, response:', fullResponse.length, 'chars, tools:', toolsUsed.length);
    } catch (streamErr: any) {
      // AbortError = intentional stop (timeout, idle detection, or manual stop)
      if (streamErr?.name === 'AbortError') {
        if (stopReason === 'timeout') {
          // Graceful timeout: preserve partial output + append notice
          const elapsed = Date.now() - runStart;
          const min = Math.floor(elapsed / 60000);
          const sec = Math.floor((elapsed % 60000) / 1000);
          const durStr = min > 0 ? `${min}m ${sec}s` : `${sec}s`;
          const notice = `\n\n---\n⏰ Agent timed out after ${durStr}. ${toolCallCount} tool calls completed.`;
          if (!streamStarted) broadcast('agent:stream-start', {});
          if (fullResponse) {
            sendChunk(mainWindow, notice, true, ariaWebContents);
            // Persist partial + notice for context
            addMessage(sessionId, { role: 'assistant' as const, content: fullResponse + notice });
          } else if (toolsUsed.length > 0) {
            sendChunk(mainWindow, `⏰ Timed out after ${durStr}. ${toolCallCount} tool calls completed: ${[...new Set(toolsUsed)].join(', ')}`, true, ariaWebContents);
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
      console.error('[agent] Stream error:', JSON.stringify({
        message: streamErr?.message,
        data: streamErr?.data,
        status: streamErr?.statusCode || streamErr?.status,
        body: typeof streamErr?.responseBody === 'string' ? streamErr.responseBody.slice(0, 500) : undefined,
      }));
      if (!errorSent) {
        const errMsg = streamErr?.data?.error?.message || streamErr?.responseBody || streamErr?.message || 'Stream error';
        sendError(mainWindow, typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg), ariaWebContents);
        errorSent = true;
      }
      return;
    } finally {
      clearTimeout(timeoutHandle);
      clearTimeout(warningHandle);
      clearInterval(progressInterval);
      agentProgressData = { running: false, elapsed: Date.now() - runStart, toolCalls: toolCallCount, timeoutMs };
    }

    // ─── Persist structured response messages (Phase 7.9) ───────────────────
    // Instead of saving just the flat text, save the full AI SDK ResponseMessage[]
    // which includes tool call content parts + tool result messages.
    // This gives the LLM proper memory of what tools it called and what they returned.

    if (errorSent) {
      // Don't persist or finalize on error
      return;
    }

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

    try {
      const response = await result.response;
      const responseMessages = response.messages;

      if (responseMessages && responseMessages.length > 0) {
        // Persist all structured response messages (assistant + tool messages)
        addMessages(sessionId, responseMessages as ChatMessage[]);
        console.log('[agent] Persisted', responseMessages.length, 'response messages (structured, with tool calls/results)');
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

    // ─── Finalize the stream to the UI ──────────────────────────────────────

    // ─── Persist to SQLite conversation store (Phase 9.1: rich history) ─────
    if (conversationId && !errorSent) {
      try {
        // Persist user message
        addConversationMessage(conversationId, 'user', userMessage);

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
            generateAutoTitle(conversationId, fullResponse);
          }
        }

        // Notify Aria tab that the conversation has been updated
        try { if (ariaWebContents && !ariaWebContents.isDestroyed()) ariaWebContents.send('aria:conversation-updated', { conversationId }); } catch {}
      } catch (persistErr: any) {
        console.error('[agent] SQLite persist error (non-fatal):', persistErr?.message);
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
    if (!errorSent) {
      sendError(mainWindow, err?.data?.error?.message || err?.message || 'Unknown error', ariaWebContents);
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
    const { text } = await generateText({
      model,
      prompt,
      maxOutputTokens: 300, // Keep summaries compact
    });

    if (text && text.trim()) {
      const summary = `[Conversation summary — earlier turns evicted from context window. Use history({ grep: "..." }) to search the full uncompacted history if you need details.]\n${text.trim()}\n[End summary — current conversation continues below]`;
      setEvictionSummary(sessionId, summary, evicted.boundary);
      console.log('[agent] Eviction summary set:', text.trim().length, 'chars');
    }
  } catch (err: any) {
    console.error('[agent] Failed to generate eviction summary:', err?.message);
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
