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
  getWindow, addMessage, addMessages,
  clearHistory as clearConversation,
  getUnsummarizedEvictedMessages, setEvictionSummary,
  buildSummaryPrompt,
  type ChatMessage,
} from './conversation';

import {
  addConversationMessage,
  generateAutoTitleFallback,
  getConversationMessageCount,
  updateConversationTitle,
} from './conversation-store';
import { buildProjectContext } from './project-manager';
import { getDb } from './database';

import { bootstrapContext } from './coding-memory';
import * as teamManager from './team-manager';
import { getLoginHint } from './login-state';
import { profileManager } from './profile-manager';
import { sessionManager } from './session-manager';
import { listIdentities } from './password-vault';

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

const PROBLEM_SOLVING_GUIDE = `
## Problem-Solving Framework
For non-trivial requests, follow this mental process:

1. **Understand**: What does the user actually want? Re-read their request.
2. **Analyze**: What's causing their problem? Consider 2-3 possible causes/solutions.
3. **Decide**: Pick the best approach based on what they need.
4. **Act**: Implement the solution efficiently.
5. **Verify**: Did it work? Does it actually solve their problem?
6. **Present**: Explain what you did and why.

Skip this framework for simple lookups, fact-based questions, or straightforward tasks.

## Sub-Agent Debugging
When a sub-agent's result is incomplete or unclear:
- \`sub_agent_status({ id })\` → see result summary + status
- \`sub_agent_transcript({ id })\` → see FULL conversation (tool calls, results, thoughts)
- Use transcript to understand what sub-agent tried and why it may have stopped early.
`;

const SYSTEM_PROMPT = `You are Aria 🪷, an AI agent built into a web browser. You control the browser through tools.

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
}

// Task-type addendums removed (Phase 9.12) — the agent decides when/if to spawn sub-agents.
// No forced orchestration. spawn_agent is a tool the agent can use when it makes sense.

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

// Phase 9.12: Removed isReportDeliverableRequest and hasReportArtifacts — no forced retry loops.

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
    const browserContext = assembleContext(browserCtx, llmConfig);

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

    const tools = createTools(browserCtx, sessionId, {
      developerMode, llmConfig, worktreeIsolation, agentBrowsingDataAccess, conversationId, projectWorkingDir,
      onSubAgentProgress: (data) => broadcast('agent:subagent-progress', data),
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

    const activeSystemPrompt = dateContext + SYSTEM_PROMPT + codingMemoryContext;
    console.log('[agent] Run starting:', Object.keys(tools).length, 'tools,', browserContext.length, 'chars context, devMode:', developerMode, 'taskType:', taskType);

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
        // Inject working context (active working dir and last file)
        const workingDir = getWorkingDir(sessionId);
        const lastFile = getLastFile(sessionId);
        if (workingDir) ctxParts.push(`Working Dir: ${workingDir}`);
        if (lastFile) ctxParts.push(`Last File: ${lastFile}`);
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

    const isCodex = llmConfig.provider === 'openai-codex';
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

    // Progress interval: emit agent:progress every second while running
    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - runStart;
      broadcast('agent:progress', { elapsed, toolCalls: toolCallCount, timeoutMs });
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
    try {
      // Stream-start fires on first chunk from LLM (no early artificial indicators).
      console.log('[agent] Calling LLM:', llmConfig.provider, llmConfig.model, 'key:', llmConfig.apiKey.slice(0, 4) + '***');
      const providerOptions = buildProviderOptions(llmConfig);

      // Codex (openai-codex) now routes through LiteLLM with OpenAI-compatible chat.
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

          if (toolResults.length === 0) {
            idleCount++;
          } else {
            idleCount = 0;
          }

          for (const tc of toolCalls) {
            try {
              agentEvents.emit('tool', {
                type: 'tool-call',
                toolName: tc.toolName,
                args: tc.args ?? {},
              });
            } catch {}
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
            // present_download returns HTML that the UI parses — must not be truncated
            const isInfoTool = /^(team_status|team_task_list|list_|file_list|exec_list|sub_agent_status|browsing_history|downloads|present_download)/.test(toolName);
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
            // 80% timeout warning injection (parity with AI SDK prepareStep path)
            if (warningPending && !warningInjected) {
              warningInjected = true;
              const elapsed = Date.now() - runStart;
              const elapsedMin = Math.floor(elapsed / 60000);
              const totalMin = Math.floor(timeoutMs / 60000);
              const warningMsg = `[⏰ Approaching timeout (${elapsedMin}m of ${totalMin}m). Wrap up your current task.]`;
              console.log('[agent] Injecting timeout warning');
              return {
                messages: [...currentMessages, { role: 'user', content: warningMsg } as any],
              };
            }
            // Duplicate detection hint injection
            if (dupHintPending) {
              dupHintPending = false;
              return {
                messages: [...currentMessages, {
                  role: 'user',
                  content: "[You're repeating the same action. Try a different approach.]",
                } as any],
              };
            }
            // Idle detection: 5 consecutive text-only turns → abort
            if (idleCount >= 5) {
              console.log(`[agent] Idle detection: ${idleCount} text-only turns — stopping`);
              stopReason = 'idle';
              _lastStopReason = 'idle';
              abortController.abort();
            }
            return undefined;
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
          logPrefix: 'agent.codex.litellm',
        });

        if (codexReasoningBuffer.length > 0) {
          broadcast('agent:reasoning-chunk', { text: codexReasoningBuffer, done: true });
          conversationEvents.push({ role: 'thinking', content: codexReasoningBuffer });
        }

        console.log(`[agent] Codex LiteLLM stream done — textChunks=${codexTextChunkCount}, reasoningChunks=${codexReasoningChunkCount}`);

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
        const llmCallBase: Record<string, any> = {
          model,
          system: activeSystemPrompt,
          messages: messages as any,
          tools,
          maxOutputTokens: 30000,
          ...(Object.keys(callProviderOptions).length > 0 ? { providerOptions: callProviderOptions } : {}),
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
            if (idleCount >= 5) {
              console.log(`[agent] Idle detection: ${idleCount} text-only turns — stopping`);
              stopReason = 'idle';
              _lastStopReason = 'idle';
              abortController.abort();
            }
            return undefined;
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
        // LiteLLM codex path streams chunks + tool events directly via callbacks.
      }

      console.log('[agent] Stream complete, response:', fullResponse.length, 'chars, tools:', toolsUsed.length, '| mode:', resultMode);
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
      if (llmConfig.provider === 'openai-codex') {
        logProviderRequestError('agent.main.stream', streamErr);
      } else {
        console.error('[agent] Stream error:', streamErr?.message || streamErr);
      }
      if (!errorSent) {
        const details = extractRequestErrorDetails(streamErr, 1200);
        const errMsg = details.responseBody || details.message || 'Stream error';
        sendError(mainWindow, errMsg, ariaWebContents);
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

    try {
      const response = await result?.response;
      const responseMessages = response?.messages || [];

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
