/**
 * team-manager.ts — Central orchestration engine for agent teams.
 *
 * Turn-based idle/wake model inspired by Claude Code's agent teams:
 * - Lead creates team, defines tasks, spawns teammates
 * - Teammates run in a turn loop: streamText → idle → wake on message → repeat
 * - Messages delivered as user-role conversation turns between streamText calls
 * - Graceful shutdown via shutdown_request/response protocol
 * - Each teammate gets a dedicated browser tab
 */

import { streamText, stepCountIs } from 'ai';
import type { WebContents } from 'electron';
import {
  createModel,
  getModelConfig,
  buildProviderOptions,
  withCodexProviderOptions,
  logProviderRequestError,
  extractRequestErrorDetails,
  type LLMConfig,
} from './llm-client';
import { classifyError } from './agent-harness';
import { createTools } from './tool-registry';
import type { BrowserContext } from './browser-tools';
import { addMessage, addMessages, getWindow, clearHistory, type ChatMessage } from './conversation';
import { purgeSession } from './output-buffer';
import { cleanupSession, addProtectedPath, removeProtectedPath, clearContractFilePaths } from './shell-tools';
import {
  initMailbox,
  sendMessage,
  getUnreadMessages,
  formatInboxForContext,
  formatMessagesForDelivery,
  waitForMessages,
  cancelWaiter,
  cleanupTeamMailbox,
} from './mailbox';
import {
  initTaskList,
  createTask,
  getTaskList,
  getTask,
  updateTask,
  formatTaskListForContext,
  getTeamSummary,
  cleanupTeamTaskList,
  detectFileConflicts,
  type SharedTask,
} from './shared-task-list';
import { WorktreeManager, createWorktreeManager, type WorktreeInfo } from './worktree-manager';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  initCodingMemory,
  logTeamSession,
  updateMainState,
  type TeamSessionSummary,
  type TeammateMemory,
  type ContractMemory,
} from './coding-memory';

// ─── Types ───

export interface ContractFile {
  path: string;          // relative path from workingDir
  absolutePath: string;
  description: string;
  phase: number;
  createdAt: string;
}

export interface TeamSession {
  id: string;
  lead: string;
  teammates: Map<string, Teammate>;
  workingDir: string;
  status: 'planning' | 'active' | 'completing' | 'done';
  created_at: string;
  taskDescription: string;
  worktreeIsolation?: boolean;
  worktreeManager?: WorktreeManager;
  ariaWebContents?: WebContents | null;
  contracts: ContractFile[];
  currentPhase: number;
  validationResults?: string;
  _autoDissolveScheduled?: boolean;
}

export interface Teammate {
  id: string;
  name: string;
  role: string;
  sessionId: string;
  status: 'idle' | 'working' | 'done' | 'failed' | 'interrupted';
  currentTaskId?: string;
  model?: string;
  toolsUsed: string[];
  filesWritten?: string[];
  result?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  worktreePath?: string;
  worktreeBranch?: string;
  abortController?: AbortController;
  assignedTabId?: number;        // dedicated browser tab
  // Shutdown protocol
  _shutdownRequested: boolean;
  _shutdownAcknowledged: boolean;
  // Internal state for turn loop
  _systemPrompt?: string;
  _tools?: Record<string, any>;
  _model?: any;
  _provider?: string;
  _activityLog?: string[];
}

export interface TeammateRunOptions {
  teammate: Teammate;
  teamId: string;
  task: string;
  browserCtx: BrowserContext;
  llmConfig: LLMConfig;
  ariaWebContents?: WebContents | null;
}

// ─── Helpers ───

function describeToolActivity(toolName: string, args: Record<string, any>): string {
  const p = args.path || args.file_path || '';
  const basename = p ? p.split('/').pop() || p : '';
  switch (toolName) {
    case 'file_write':   return basename ? `writing ${basename}` : 'writing file';
    case 'file_read':    return basename ? `reading ${basename}` : 'reading file';
    case 'file_read_range': return basename ? `reading ${basename}` : 'reading file section';
    case 'file_append':  return basename ? `appending to ${basename}` : 'appending to file';
    case 'file_delete':  return basename ? `deleting ${basename}` : 'deleting file';
    case 'file_list':    return p ? `listing ${p}` : 'listing files';
    case 'file_grep':    return `searching ${basename || 'file'} for "${(args.grep || args.pattern || '').slice(0, 30)}"`;
    case 'file_copy':    return `copying ${basename}`;
    case 'file_move':    return `moving ${basename}`;
    case 'exec': {
      const cmd = (args.command || '').slice(0, 60);
      return cmd ? `running: ${cmd}` : 'running command';
    }
    case 'exec_bg':      return `background: ${(args.command || '').slice(0, 50)}`;
    case 'exec_grep':    return `searching output for "${(args.pattern || '').slice(0, 30)}"`;
    case 'navigate':     return `navigating to ${(args.url || '').slice(0, 50)}`;
    case 'search':       return `searching: ${(args.query || '').slice(0, 40)}`;
    case 'elements':     return args.grep ? `finding elements: "${args.grep}"` : 'indexing page elements';
    case 'click':        return `clicking element [${args.index ?? '?'}]`;
    case 'type':         return `typing into [${args.index ?? '?'}]: "${(args.text || '').slice(0, 30)}"`;
    case 'paste':        return `pasting into [${args.index ?? '?'}]`;
    case 'text':         return args.grep ? `reading page text: "${args.grep}"` : 'reading page text';
    case 'screenshot':   return 'taking screenshot';
    case 'eval_js':      return `eval: ${(args.js || '').slice(0, 50)}`;
    case 'scroll':       return `scrolling ${args.direction || 'down'}`;
    case 'keys':         return `pressing ${args.sequence || 'keys'}`;
    case 'http_request':  return `${args.method || 'GET'} ${(args.url || '').slice(0, 50)}`;
    case 'task_update':  return `updating task ${args.taskId || ''}`;
    case 'send_message': return `messaging ${args.recipient || ''}`;
    default:             return toolName;
  }
}

async function persistTeammateStructuredHistory(
  sessionId: string,
  result: any,
  fullResponse: string,
  logPrefix: string,
): Promise<void> {
  try {
    const response = await result?.response;
    const responseMessages = response?.messages || [];

    if (Array.isArray(responseMessages) && responseMessages.length > 0) {
      addMessages(sessionId, responseMessages as ChatMessage[]);
      console.log(`[team] ${logPrefix}: persisted ${responseMessages.length} structured response messages`);
      return;
    }

    if (fullResponse && fullResponse.trim().length > 0) {
      addMessage(sessionId, { role: 'assistant', content: fullResponse });
      console.log(`[team] ${logPrefix}: persisted flat assistant response fallback`);
    }
  } catch (persistErr: any) {
    console.error(`[team] ${logPrefix}: failed to persist structured response messages, falling back:`, persistErr?.message);
    if (fullResponse && fullResponse.trim().length > 0) {
      addMessage(sessionId, { role: 'assistant', content: fullResponse });
    }
  }
}

// ─── Active Teams ───

const activeTeams = new Map<string, TeamSession>();
let teamCounter = 0;
let teamDevMode = false;

export function setTeamDevMode(enabled: boolean): void {
  teamDevMode = enabled;
}

// ─── IPC Callback ───

type TeamUpdateCallback = (teamId: string, team: TeamSession) => void;
let onTeamUpdate: TeamUpdateCallback | null = null;

export function setTeamUpdateCallback(cb: TeamUpdateCallback): void {
  onTeamUpdate = cb;
}

function normalizeTeammateName(name: string): string {
  return name.replace(/^@/, '').replace(/\s+/g, '-').toLowerCase();
}

function getPendingWorktreeNames(team: TeamSession): string[] {
  if (!team.worktreeIsolation || !team.worktreeManager) return [];
  const teammateNames = new Set(Array.from(team.teammates.values()).map(tm => normalizeTeammateName(tm.name)));
  return team.worktreeManager
    .listWorktrees()
    .map(w => w.name)
    .filter(n => teammateNames.has(normalizeTeammateName(n)));
}

function notifyUpdate(teamId: string): void {
  const team = activeTeams.get(teamId);
  if (team && onTeamUpdate) onTeamUpdate(teamId, team);

  // Auto-finalize when all teammates reach terminal state
  if (team && team.status === 'active') {
    const allTerminal = team.teammates.size > 0 &&
      Array.from(team.teammates.values()).every(t => t.status === 'done' || t.status === 'failed');
    if (allTerminal && !team._autoDissolveScheduled) {
      team._autoDissolveScheduled = true;
      setTimeout(async () => {
        try {
          console.log(`[team] Auto-finalizing ${teamId} — all teammates finished.`);
          await finalizeTeam(teamId);
        } catch (e: any) {
          console.error(`[team] Auto-finalize failed for ${teamId}:`, e?.message);
          const stillTeam = activeTeams.get(teamId);
          if (stillTeam) stillTeam._autoDissolveScheduled = false;
        }
      }, 2000);
    }
  }
}

// ─── Persist Team Config ───

function persistTeamConfig(teamId: string): void {
  const team = activeTeams.get(teamId);
  if (!team) return;

  try {
    const resolvedDir = team.workingDir.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '.');
    const configDir = path.join(resolvedDir, 'teams', teamId);
    fs.mkdirSync(configDir, { recursive: true });

    const config = {
      name: teamId,
      created_at: team.created_at,
      working_dir: team.workingDir,
      status: team.status,
      taskDescription: team.taskDescription,
      currentPhase: team.currentPhase,
      members: Array.from(team.teammates.values()).map(tm => ({
        name: tm.name,
        role: tm.role,
        status: tm.status,
        tabId: tm.assignedTabId,
        worktreeBranch: tm.worktreeBranch,
      })),
      contracts: team.contracts.map(c => ({
        path: c.path,
        description: c.description,
        phase: c.phase,
      })),
    };

    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify(config, null, 2),
    );
  } catch (e: any) {
    console.error('[team] persistTeamConfig failed:', e?.message);
  }
}

// ─── Create Team ───

export async function createTeam(
  taskDescription: string,
  workingDir: string,
  browserCtx: BrowserContext,
  llmConfig: LLMConfig,
  teammateConfigs?: Array<{ name: string; role: string; model?: string }>,
  worktreeIsolation?: boolean,
  ariaWebContents?: WebContents | null,
): Promise<{ teamId: string; summary: string }> {
  // Max 10 teammates across all teams
  const totalTeammates = Array.from(activeTeams.values()).reduce((sum, t) => sum + t.teammates.size, 0);
  const requestedCount = teammateConfigs?.length || 3;
  if (totalTeammates + requestedCount > 10) {
    return { teamId: '', summary: `Cannot create team: would exceed max 10 teammates (currently ${totalTeammates} active).` };
  }

  const teamId = `team-${++teamCounter}`;

  // Initialize mailbox and task list
  initMailbox(teamId, '@lead');
  initTaskList(teamId);

  // Set up worktree manager
  const resolvedDir = workingDir.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '.');
  const wtManager = (worktreeIsolation !== false) ? createWorktreeManager(resolvedDir) : null;
  const worktreesEnabled = !!wtManager;

  const team: TeamSession = {
    id: teamId,
    lead: 'default',
    teammates: new Map(),
    workingDir,
    status: 'planning',
    created_at: new Date().toISOString(),
    taskDescription,
    worktreeIsolation: worktreesEnabled,
    worktreeManager: wtManager || undefined,
    ariaWebContents: ariaWebContents ?? null,
    contracts: [],
    currentPhase: 1,
  };

  activeTeams.set(teamId, team);
  addProtectedPath(resolvedDir);
  notifyUpdate(teamId);

  // Auto-configure teammates if not provided
  const teammates = teammateConfigs || defaultTeammates(taskDescription);

  const worktreeWarnings: string[] = [];
  for (const tc of teammates) {
    const sessionId = `${teamId}:${tc.name}`;
    initMailbox(teamId, tc.name);

    let worktreePath: string | undefined;
    let worktreeBranch: string | undefined;

    if (worktreesEnabled && wtManager) {
      try {
        const wt = await wtManager.createWorktree({
          name: tc.name,
          teammateId: tc.name,
        });
        worktreePath = wt.path;
        worktreeBranch = wt.branch;
        console.log(`[team] Worktree for ${tc.name}: ${wt.path} (branch: ${wt.branch})`);
      } catch (e: any) {
        worktreeWarnings.push(`Worktree creation failed for ${tc.name}: ${e?.message || e}`);
        console.error(`[team] Worktree creation failed for ${tc.name}:`, e);
      }
    }

    const teammate: Teammate = {
      id: tc.name,
      name: tc.name,
      role: tc.role,
      sessionId,
      status: 'idle',
      model: tc.model,
      toolsUsed: [],
      startedAt: Date.now(),
      worktreePath,
      worktreeBranch,
      _shutdownRequested: false,
      _shutdownAcknowledged: false,
    };

    team.teammates.set(tc.name, teammate);
  }

  team.status = 'active';
  persistTeamConfig(teamId);
  notifyUpdate(teamId);

  const teammateList = teammates.map(t => {
    const tm = team.teammates.get(t.name);
    const wtInfo = tm?.worktreeBranch ? ` [${tm.worktreeBranch}]` : '';
    return `- ${t.name}${wtInfo}: ${t.role}`;
  }).join('\n');

  let summary = `Team "${teamId}" created with ${teammates.length} teammate(s):\n${teammateList}\n\nTask: ${taskDescription}\nWorking dir: ${workingDir}`;

  if (worktreesEnabled) {
    summary += `\nWorktree isolation: ENABLED — each teammate has an isolated copy of the codebase.`;
  } else if (worktreeIsolation !== false) {
    summary += `\nWorktree isolation: UNAVAILABLE — not a git repository. Teammates share the working directory.`;
  }

  if (worktreeWarnings.length > 0) {
    summary += '\n' + worktreeWarnings.join('\n');
  }

  summary += `\n\n**Workflow:**
1. Write shared contracts with \`write_contracts\` — type definitions, interfaces, function signatures.
2. Create tasks with \`task_create\` — define work for teammates.
3. Spawn teammates with \`spawn_teammate\` — each runs in a turn-based idle/wake loop.
4. Send guidance with \`send_message\` — messages delivered between turns.
5. Monitor with \`team_status\` — check progress, see idle/working status.
6. Shutdown with \`send_message\` (type: shutdown_request) — graceful teardown.
7. Validate with \`validate_integration\` — run build/tests after teammates finish.`;

  return { teamId, summary };
}

// ─── Run a Teammate (Turn-Based Loop) ───

export async function runTeammate(opts: TeammateRunOptions): Promise<string> {
  const { teammate, teamId, task, browserCtx, llmConfig, ariaWebContents } = opts;
  const team = activeTeams.get(teamId);
  if (!team) return `Team "${teamId}" not found.`;

  // Contracts must be written before spawning
  if (team.contracts.length === 0) {
    return `No contracts written. Call write_contracts first — define shared interfaces/types that teammates must reference.`;
  }

  if (ariaWebContents && !team.ariaWebContents) {
    team.ariaWebContents = ariaWebContents;
  }

  teammate.status = 'working';
  teammate.startedAt = Date.now();
  notifyUpdate(teamId);

  // Run turn loop in background
  console.log(`[team] Spawning ${teammate.name} (turn-based loop)...`);
  runTeammateLoop(teammate, teamId, task, browserCtx, llmConfig, ariaWebContents ?? team.ariaWebContents).catch(err => {
    console.error(`[team] ${teammate.name} unhandled rejection:`, err?.message, err?.stack?.slice(0, 200));
    teammate.status = 'failed';
    teammate.error = err?.message || 'Unknown error';
    teammate.finishedAt = Date.now();
    notifyUpdate(teamId);
  });

  return `Teammate ${teammate.name} started on: ${task}`;
}

// ─── Core: Turn-Based Teammate Loop ───

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes idle → auto-shutdown
const STEPS_PER_TURN = 50;             // Max steps per streamText turn
const MAX_RETRIES = 2;

async function runTeammateLoop(
  teammate: Teammate,
  teamId: string,
  task: string,
  browserCtx: BrowserContext,
  llmConfig: LLMConfig,
  ariaWebContents?: WebContents | null,
): Promise<void> {
  const { sessionId, name, role } = teammate;
  console.log(`[team] ${name} turn loop starting — teamId: ${teamId}, task: ${task.slice(0, 60)}`);

  // Broadcast helper
  function teamBroadcast(channel: string, data: any): void {
    try {
      if (ariaWebContents && !ariaWebContents.isDestroyed()) {
        ariaWebContents.send(channel, data);
      }
    } catch {}
  }

  teamBroadcast('team:teammate-start', { id: teammate.id, name, role, task });

  let teammateProvider = llmConfig.provider;

  try {
    // Setup model and tools (once, reused across turns)
    const baseConfig = getModelConfig('secondary', llmConfig);
    const tmConfig: LLMConfig = teammate.model
      ? { ...baseConfig, model: teammate.model }
      : baseConfig;
    teammateProvider = tmConfig.provider;

    const model = createModel(tmConfig);
    const team = activeTeams.get(teamId);
    const tools = createTools(browserCtx, sessionId, {
      developerMode: teamDevMode,
      llmConfig: tmConfig,
      teamId,
      agentName: name,
      worktreeIsolation: team?.worktreeIsolation,
      projectWorkingDir: teammate.worktreePath || team?.workingDir || process.cwd(),
      lockedTabId: teammate.assignedTabId ? String(teammate.assignedTabId) : undefined,
    });

    // Store frozen config
    teammate._systemPrompt = buildTeammateSystemPrompt(name, role, teamId, formatTaskListForContext(teamId), teammate.worktreePath);
    teammate._tools = tools;
    teammate._model = model;
    teammate._provider = tmConfig.provider;

    // Get any pre-existing unread messages
    const unread = getUnreadMessages(teamId, name);
    const inboxContext = formatInboxForContext(unread);

    // Add initial task as user message
    const userContent = `${task}${inboxContext}`;
    addMessage(sessionId, { role: 'user', content: userContent });

    const abortController = new AbortController();
    teammate.abortController = abortController;

    const providerOptions = buildProviderOptions(tmConfig);
    const callProviderOptions = withCodexProviderOptions(
      tmConfig.provider,
      { ...providerOptions },
      teammate._systemPrompt,
      teammate._systemPrompt,
    );

    let turnNumber = 0;

    // ─── Turn Loop ───
    while (true) {
      turnNumber++;
      teammate.status = 'working';
      notifyUpdate(teamId);
      persistTeamConfig(teamId);

      console.log(`[team] ${name} turn ${turnNumber} starting...`);

      const messages = getWindow(sessionId);
      let fullResponse = '';

      // ─── Execute one turn (streamText) ───
      let result: any;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          result = await streamText({
            model,
            system: teammate._systemPrompt!,
            messages: messages as any,
            tools,
            ...(tmConfig.provider !== 'openai-codex' ? { maxOutputTokens: 30000 } : {}),
            ...(Object.keys(callProviderOptions).length > 0 ? { providerOptions: callProviderOptions } : {}),
            stopWhen: stepCountIs(STEPS_PER_TURN),
            abortSignal: abortController.signal,
            onStepFinish: async (event: any) => {
              try {
                const toolResults = event.toolResults || [];
                for (const tr of toolResults) {
                  const toolName = tr.toolName || 'unknown';
                  teammate.toolsUsed.push(toolName);

                  const rawResult = (tr as any).result ?? (tr as any).output ?? '';
                  const resultStr = typeof rawResult === 'string'
                    ? rawResult : JSON.stringify(rawResult ?? '');

                  teamBroadcast('team:teammate-tool', {
                    name, toolName,
                    display: `${toolName} → ${resultStr.slice(0, 120)}`,
                  });

                  // Passive file tracking
                  trackFileWrites(teammate, toolName, tr, resultStr);
                }

                // Activity log
                try {
                  if (!teammate._activityLog) teammate._activityLog = [];
                  for (const tr of toolResults) {
                    const toolName = (tr as any).toolName || 'unknown';
                    const args = (tr as any).args || (tr as any).input || {};
                    const desc = describeToolActivity(toolName, args);
                    const rawResult = (tr as any).result ?? (tr as any).output ?? '';
                    const resultStr = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult ?? '');
                    teammate._activityLog.push(`${desc} → ${resultStr.slice(0, 200)}`);
                  }
                  if (event.text) {
                    teammate._activityLog.push(`Response: ${event.text.slice(0, 200)}`);
                  }
                } catch {}

                notifyUpdate(teamId);
              } catch {}
            },
          });
          break; // Success
        } catch (err: any) {
          if (err?.name === 'AbortError' || attempt >= MAX_RETRIES) throw err;
          const classified = classifyError(err);
          if (!classified.retryable) throw err;
          const delayMs = classified.suggestedDelayMs * (attempt + 1);
          console.warn(`[team] ${name} turn ${turnNumber} retrying (${classified.category}, attempt ${attempt + 1}) in ${delayMs}ms`);
          await new Promise(r => setTimeout(r, delayMs));
        }
      }

      // ─── Consume stream ───
      try {
        for await (const chunk of result.fullStream) {
          if (chunk.type === 'text-delta') {
            const textDelta = (chunk as any).text ?? (chunk as any).delta ?? (chunk as any).textDelta ?? '';
            fullResponse += textDelta;
            if (textDelta) {
              teamBroadcast('team:teammate-chunk', { name, text: textDelta, done: false });
            }
          } else if (chunk.type === 'tool-call') {
            // Already handled in onStepFinish
          }
        }
      } catch (streamErr: any) {
        if (streamErr?.name !== 'AbortError') throw streamErr;
      }

      console.log(`[team] ${name} turn ${turnNumber} done — ${fullResponse.length} chars, ${teammate.toolsUsed.length} total tools`);

      // Persist conversation history
      await persistTeammateStructuredHistory(sessionId, result, fullResponse, `${name}.turn${turnNumber}`);
      teammate.result = fullResponse || `Used ${teammate.toolsUsed.length} tools: ${[...new Set(teammate.toolsUsed)].join(', ')}`;

      // ─── Check shutdown ───
      if (teammate._shutdownRequested && teammate._shutdownAcknowledged) {
        console.log(`[team] ${name} shutdown acknowledged — exiting loop.`);
        teammate.status = 'done';
        teammate.finishedAt = Date.now();
        teamBroadcast('team:teammate-chunk', { name, text: '', done: true });
        teamBroadcast('team:teammate-done', { name, status: 'done', summary: (teammate.result || '').slice(0, 300) });
        notifyUpdate(teamId);
        break;
      }

      // ─── Go idle ───
      teammate.status = 'idle';
      notifyUpdate(teamId);
      persistTeamConfig(teamId);

      // Notify lead that teammate is idle
      const idleSummary = buildIdleSummary(teammate, turnNumber);
      sendMessage(teamId, 'system', '@lead', `${name} completed turn ${turnNumber} and is now idle.\n${idleSummary}`, {
        type: 'system',
        summary: `${name} idle after turn ${turnNumber}`,
      });
      teamBroadcast('team:teammate-idle', { name, turn: turnNumber, summary: idleSummary });

      console.log(`[team] ${name} going idle — waiting for messages (timeout: ${IDLE_TIMEOUT_MS / 1000}s)...`);

      // ─── Wait for messages ───
      let incomingMessages;
      try {
        incomingMessages = await waitForMessages(teamId, name, IDLE_TIMEOUT_MS);
      } catch (waitErr: any) {
        // Cancelled (abort/interrupt)
        if (waitErr?.message?.includes('cancelled')) {
          console.log(`[team] ${name} wait cancelled — checking for interrupt.`);
          // If aborted, exit loop
          if (abortController.signal.aborted) {
            teammate.status = 'interrupted';
            teammate.finishedAt = Date.now();
            notifyUpdate(teamId);
            break;
          }
          continue; // Retry wait
        }
        throw waitErr;
      }

      // Idle timeout — no messages received
      if (!incomingMessages || incomingMessages.length === 0) {
        console.log(`[team] ${name} idle timeout — auto-shutting down.`);
        teammate.status = 'done';
        teammate.result = (teammate.result || '') + '\n\n(Idle timeout — no further messages received)';
        teammate.finishedAt = Date.now();
        teamBroadcast('team:teammate-chunk', { name, text: '', done: true });
        teamBroadcast('team:teammate-done', { name, status: 'done', summary: 'Idle timeout' });
        sendMessage(teamId, 'system', '@lead', `${name} auto-shutdown after idle timeout.`, {
          type: 'system',
          summary: `${name} idle timeout`,
        });
        notifyUpdate(teamId);
        break;
      }

      // ─── Deliver messages as user-role conversation turns ───
      const deliveredContent = formatMessagesForDelivery(incomingMessages);
      addMessage(sessionId, { role: 'user', content: deliveredContent });
      console.log(`[team] ${name} woke up — ${incomingMessages.length} message(s) delivered.`);

      // Loop back to next turn
    }

  } catch (err: any) {
    const details = extractRequestErrorDetails(err, 1600);
    if (teammateProvider === 'openai-codex') {
      logProviderRequestError(`team.${name}.loop`, err);
    }
    const errMsg = details.responseBody || details.message || 'Unknown error';
    console.error(`[team] ${name} loop error:`, errMsg, err?.stack?.slice?.(0, 300));
    teamBroadcast('team:teammate-chunk', { name, text: '', done: true });
    teamBroadcast('team:teammate-done', { name, status: 'failed', summary: errMsg });
    teammate.status = 'failed';
    teammate.error = errMsg;
    teammate.finishedAt = Date.now();
    notifyUpdate(teamId);
  } finally {
    cleanupSession(sessionId);
    purgeSession(sessionId);
  }
}

// ─── Helpers for Turn Loop ───

function trackFileWrites(teammate: Teammate, toolName: string, tr: any, resultStr: string): void {
  if (toolName === 'file_write' || toolName === 'file_append') {
    const inputArgs = (tr as any).args || (tr as any).input || {};
    let filePath = inputArgs.path || inputArgs.file_path || '';
    if (!filePath) {
      const writtenMatch = resultStr.match(/Written:\s*([^\s(]+)/);
      if (writtenMatch) filePath = writtenMatch[1];
    }
    if (filePath) {
      if (!teammate.filesWritten) teammate.filesWritten = [];
      teammate.filesWritten.push(filePath);
    }
  }
  if (toolName === 'eval_js') {
    const js = (tr as any).args?.js || (tr as any).args?.code || '';
    const writeMatch = js.match(/writeFileSync?\s*\(\s*['"`]([^'"`]+)['"`]/);
    if (writeMatch) {
      if (!teammate.filesWritten) teammate.filesWritten = [];
      teammate.filesWritten.push(writeMatch[1]);
    }
  }
  if (toolName === 'exec') {
    const cmd = (tr as any).args?.command || '';
    const redirectMatch = cmd.match(/(?:>>?|tee\s+)([^\s;|&>]+)/);
    if (redirectMatch && redirectMatch[1] && !redirectMatch[1].startsWith('-')) {
      if (!teammate.filesWritten) teammate.filesWritten = [];
      teammate.filesWritten.push(redirectMatch[1]);
    }
  }
}

function buildIdleSummary(teammate: Teammate, turnNumber: number): string {
  const parts: string[] = [];
  parts.push(`Turn ${turnNumber}: ${teammate.toolsUsed.length} total tool calls`);
  if (teammate.filesWritten && teammate.filesWritten.length > 0) {
    const recent = teammate.filesWritten.slice(-3).map(f => f.split('/').pop() || f);
    parts.push(`Files: ${recent.join(', ')}${teammate.filesWritten.length > 3 ? ` (+${teammate.filesWritten.length - 3} more)` : ''}`);
  }
  if (teammate._activityLog && teammate._activityLog.length > 0) {
    const last = teammate._activityLog[teammate._activityLog.length - 1];
    parts.push(`Last: ${last.slice(0, 80)}`);
  }
  return parts.join(' | ');
}

// ─── Contract Management ───

export function writeContract(
  teamId: string,
  relativePath: string,
  content: string,
  description: string,
): string {
  const team = activeTeams.get(teamId);
  if (!team) return `Team "${teamId}" not found.`;

  const phaseContracts = team.contracts.filter(c => c.phase === team.currentPhase);
  if (phaseContracts.length >= 5) {
    return `Max 5 contract files per phase (current phase ${team.currentPhase} has ${phaseContracts.length}).`;
  }

  const resolvedDir = team.workingDir.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '.');
  const absolutePath = path.resolve(resolvedDir, relativePath);

  const parentDir = path.dirname(absolutePath);
  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf-8');

  // Auto-commit in git repos for worktree merge safety
  if (team.worktreeIsolation && team.worktreeManager) {
    try {
      const relForGit = path.relative(resolvedDir, absolutePath);
      execSync(`git add -- "${relForGit.replace(/"/g, '\\"')}"`, { cwd: resolvedDir, stdio: ['pipe', 'pipe', 'pipe'] });
      const staged = execSync('git diff --cached --name-only', { cwd: resolvedDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }) as string;
      if (staged.trim().length > 0) {
        execSync(`git commit -m "[tappi] Update contract ${relativePath.replace(/"/g, '\\"')}"`, { cwd: resolvedDir, stdio: ['pipe', 'pipe', 'pipe'] });
      }
    } catch {}
  }

  const contract: ContractFile = {
    path: relativePath,
    absolutePath,
    description,
    phase: team.currentPhase,
    createdAt: new Date().toISOString(),
  };

  const existingIdx = team.contracts.findIndex(c => c.path === relativePath);
  if (existingIdx >= 0) {
    team.contracts[existingIdx] = contract;
  } else {
    team.contracts.push(contract);
  }

  notifyUpdate(teamId);

  // Copy contracts into worktrees
  if (team.worktreeIsolation && team.worktreeManager) {
    const copyResults: string[] = [];
    for (const [, tm] of team.teammates) {
      if (tm.worktreePath) {
        try {
          const wtContractPath = path.resolve(tm.worktreePath, relativePath);
          fs.mkdirSync(path.dirname(wtContractPath), { recursive: true });
          fs.writeFileSync(wtContractPath, content, 'utf-8');
          copyResults.push(`${tm.name}`);
        } catch (e: any) {
          copyResults.push(`${tm.name}: ${e?.message}`);
        }
      }
    }
    if (copyResults.length > 0) {
      return `Contract written: ${relativePath}\n  ${description}\n  Phase ${team.currentPhase} (${phaseContracts.length + 1}/5)\n  Copied to worktrees: ${copyResults.join(', ')}`;
    }
  }

  return `Contract written: ${relativePath}\n  ${description}\n  Phase ${team.currentPhase} (${phaseContracts.length + 1}/5)`;
}

export function getContractsContext(teamId: string): string {
  const team = activeTeams.get(teamId);
  if (!team || team.contracts.length === 0) return '';

  const lines = ['## Shared Contracts (DO NOT modify these — import/reference only)\n'];
  for (const c of team.contracts) {
    lines.push(`### ${c.path} — ${c.description} (phase ${c.phase})`);
    try {
      const content = fs.readFileSync(c.absolutePath, 'utf-8');
      const contentLines = content.split('\n');
      if (contentLines.length > 100) {
        lines.push('```');
        lines.push(contentLines.slice(0, 100).join('\n'));
        lines.push(`... (${contentLines.length - 100} more lines)`);
        lines.push('```');
      } else {
        lines.push('```');
        lines.push(content);
        lines.push('```');
      }
    } catch {
      lines.push('(file not readable)');
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function advancePhase(teamId: string): string {
  const team = activeTeams.get(teamId);
  if (!team) return `Team "${teamId}" not found.`;

  const prevPhase = team.currentPhase;
  team.currentPhase += 1;
  notifyUpdate(teamId);

  return `Advanced from phase ${prevPhase} to phase ${team.currentPhase}. You can now write new contracts for this phase.`;
}

export async function validateIntegration(
  teamId: string,
  command?: string,
): Promise<string> {
  const team = activeTeams.get(teamId);
  if (!team) return `Team "${teamId}" not found.`;

  const resolvedDir = team.workingDir.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '.');

  const allFiles: string[] = [];
  for (const [, tm] of team.teammates) {
    if (tm.filesWritten) allFiles.push(...tm.filesWritten);
  }
  const uniqueFiles = [...new Set(allFiles)];

  // Check contract references
  const contractIssues: string[] = [];
  for (const contract of team.contracts) {
    const contractBasename = path.basename(contract.path, path.extname(contract.path));
    let referenced = false;
    for (const file of uniqueFiles) {
      try {
        const resolvedFile = file.startsWith('/') ? file : path.resolve(resolvedDir, file);
        if (fs.existsSync(resolvedFile)) {
          const content = fs.readFileSync(resolvedFile, 'utf-8');
          if (content.includes(contractBasename) || content.includes(contract.path)) {
            referenced = true;
            break;
          }
        }
      } catch {}
    }
    if (!referenced && uniqueFiles.length > 0) {
      contractIssues.push(`Contract "${contract.path}" not referenced by any teammate file`);
    }
  }

  let commandOutput = '';
  if (command) {
    try {
      const result = execSync(command, {
        cwd: resolvedDir,
        timeout: 60_000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      commandOutput = `Validation command passed:\n\`\`\`\n${(result || '').slice(0, 2000)}\n\`\`\``;
    } catch (e: any) {
      const stderr = e?.stderr || '';
      const stdout = e?.stdout || '';
      commandOutput = `Validation command failed (exit ${e?.status || '?'}):\n\`\`\`\n${(stderr || stdout).slice(0, 2000)}\n\`\`\``;
    }
  }

  const lines = [
    `**Integration Validation — Team ${teamId}**`,
    '',
    `Files touched: ${uniqueFiles.length}`,
    `Contracts: ${team.contracts.length}`,
    `Phase: ${team.currentPhase}`,
  ];

  if (contractIssues.length > 0) {
    lines.push('', '**Contract Reference Issues:**');
    lines.push(...contractIssues);
  } else if (team.contracts.length > 0) {
    lines.push('', 'All contracts referenced by teammate code.');
  }

  const fileOwners = new Map<string, string[]>();
  for (const [, tm] of team.teammates) {
    for (const f of tm.filesWritten || []) {
      if (!fileOwners.has(f)) fileOwners.set(f, []);
      fileOwners.get(f)!.push(tm.name);
    }
  }
  const conflicts = [...fileOwners.entries()].filter(([, owners]) => owners.length > 1);
  if (conflicts.length > 0) {
    lines.push('', '**File Conflicts:**');
    for (const [file, owners] of conflicts) {
      lines.push(`  ${file}: ${owners.join(' vs ')}`);
    }
  }

  if (commandOutput) {
    lines.push('', '**Build/Test Output:**', commandOutput);
  }

  team.validationResults = lines.join('\n');
  notifyUpdate(teamId);
  return lines.join('\n');
}

// ─── Worktree File Scanner ───

function scanWorktreeFiles(worktreePath: string): { count: number; files: string[] } {
  try {
    const result = execSync('git status --porcelain', {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    const files = result
      ? result.split('\n').map((l: string) => l.slice(3).trim()).filter(Boolean)
      : [];
    return { count: files.length, files };
  } catch {
    return { count: 0, files: [] };
  }
}

// ─── Team Status ───

export function getTeamStatus(teamId: string): string {
  const team = activeTeams.get(teamId);
  if (!team) return `Team "${teamId}" not found.`;

  const tasks = getTaskList(teamId);
  const statusEmoji: Record<string, string> = {
    idle: '⏸️', working: '🔄', done: '✅', failed: '❌', interrupted: '⚡'
  };

  const lines = [
    `**Team ${teamId}** (${team.status}) — Phase ${team.currentPhase}`,
    `Task: ${team.taskDescription}`,
    `Working dir: ${team.workingDir}`,
  ];

  if (team.contracts.length > 0) {
    lines.push('', `**Contracts (${team.contracts.length}):**`);
    for (const c of team.contracts) {
      lines.push(`  ${c.path} — ${c.description} (phase ${c.phase})`);
    }
  }

  lines.push('', '**Teammates:**');

  for (const [, tm] of team.teammates) {
    const emoji = statusEmoji[tm.status] || '?';
    const dur = tm.finishedAt
      ? `${((tm.finishedAt - tm.startedAt) / 1000).toFixed(0)}s`
      : `${((Date.now() - tm.startedAt) / 1000).toFixed(0)}s`;
    const wtLabel = tm.worktreeBranch ? ` [${tm.worktreeBranch}]` : '';
    const toolCount = tm.toolsUsed.length;

    let worktreeScan = { count: 0, files: [] as string[] };
    if (tm.worktreePath) {
      worktreeScan = scanWorktreeFiles(tm.worktreePath);
    }

    const activityStr = toolCount > 0
      ? ` | ${toolCount} tools, ${tm.filesWritten?.length || 0} files`
      : '';
    lines.push(`${emoji} ${tm.name}${wtLabel} (${tm.status}, ${dur}${activityStr}): ${tm.role}`);

    if (tm.worktreePath) {
      lines.push(`   Worktree: ${tm.worktreePath}`);
      if (worktreeScan.count > 0) {
        const shown = worktreeScan.files.slice(0, 5).map((f: string) => f.split('/').pop() || f).join(', ');
        const extra = worktreeScan.count > 5 ? ` (+${worktreeScan.count - 5} more)` : '';
        lines.push(`   Changed files: ${shown}${extra}`);
      }
    }

    if (tm._activityLog && tm._activityLog.length > 0) {
      const recent = tm._activityLog.slice(-3);
      lines.push(`   Recent: ${recent.map(e => e.slice(0, 60)).join(' | ')}`);
    }

    if (tm._shutdownRequested) {
      lines.push(`   Shutdown: ${tm._shutdownAcknowledged ? 'acknowledged' : 'requested (pending)'}`);
    }

    if (tm.error) lines.push(`   Error: ${tm.error}`);
  }

  if (tasks.length > 0) {
    lines.push('', '**Task List:**', formatTaskListForContext(teamId));
  }

  const conflicts = detectFileConflicts(tasks);
  if (conflicts.length > 0) {
    lines.push('', '**File Conflicts:**');
    for (const c of conflicts) {
      lines.push(`  ${c.file}: ${c.taskTitles.join(' vs ')}`);
    }
  }

  const pendingWorktrees = getPendingWorktreeNames(team);
  const hasWorkingTeammates = Array.from(team.teammates.values()).some(t => t.status === 'working');
  if (!hasWorkingTeammates && pendingWorktrees.length > 0) {
    lines.push('', `Pending merges: ${pendingWorktrees.join(', ')}.`);
  }

  if (hasWorkingTeammates) {
    lines.push(
      '',
      '**Your role while teammates work:**',
      '- send_message({ recipient: "@name", ... }) — send guidance',
      '- send_message({ type: "shutdown_request", ... }) — graceful shutdown',
      '- team_status — re-check progress',
      'Do NOT write code in the project directory while teammates are running.',
    );
  }

  return lines.join('\n');
}

// ─── Finalize & Dissolve ───

export async function finalizeTeam(teamId: string): Promise<string> {
  const team = activeTeams.get(teamId);
  if (!team) return `Team "${teamId}" not found.`;

  if (!team.worktreeIsolation || !team.worktreeManager) {
    return dissolveTeam(teamId);
  }

  const lines: string[] = [`Finalizing team ${teamId}...`];
  const pending = getPendingWorktreeNames(team);

  if (pending.length === 0) {
    lines.push('No pending worktrees.');
    lines.push(await dissolveTeam(teamId));
    return lines.join('\n');
  }

  const terminalNames = new Set(
    Array.from(team.teammates.values())
      .filter(t => t.status === 'done' || t.status === 'failed')
      .map(t => normalizeTeammateName(t.name))
  );

  for (const wtName of pending) {
    if (!terminalNames.has(normalizeTeammateName(wtName))) {
      lines.push(`Skipped ${wtName}: teammate not terminal yet.`);
      continue;
    }
    try {
      const merged = await team.worktreeManager.mergeWorktree(wtName, { strategy: 'squash' });
      lines.push(merged.message);
      if (merged.success) {
        const removed = await team.worktreeManager.removeWorktree(wtName, { force: false });
        lines.push(removed.message);
      }
    } catch (e: any) {
      lines.push(`Finalize failed for ${wtName}: ${e?.message || e}`);
    }
  }

  const remaining = getPendingWorktreeNames(team);
  if (remaining.length === 0) {
    lines.push('All worktrees merged.');
    lines.push(await dissolveTeam(teamId));
  } else {
    lines.push(`Remaining unmerged worktrees: ${remaining.join(', ')}.`);
    team.status = 'completing';
    team._autoDissolveScheduled = false;
    notifyUpdate(teamId);
  }

  return lines.join('\n');
}

export async function dissolveTeam(teamId: string): Promise<string> {
  const team = activeTeams.get(teamId);
  if (!team) return `Team "${teamId}" not found.`;

  clearContractFilePaths();

  const taskSummary = getTeamSummary(teamId);

  const lines = [
    `**Team ${teamId} dissolved.**`,
    '',
    `Task: ${team.taskDescription}`,
    `Duration: ${((Date.now() - new Date(team.created_at).getTime()) / 1000 / 60).toFixed(1)} minutes`,
    `Phases completed: ${team.currentPhase}`,
    `Contracts written: ${team.contracts.length}`,
  ];

  if (team.validationResults) {
    lines.push('', '**Last Validation:**', team.validationResults);
  }

  lines.push('', '**Teammate Results:**');

  for (const [, tm] of team.teammates) {
    lines.push(`- ${tm.name}: ${tm.status}`);
    if (tm.result) lines.push(`  ${tm.result.slice(0, 200)}`);
    if (tm.error) lines.push(`  Error: ${tm.error}`);
  }

  lines.push('', taskSummary);

  // Persist session memory
  try {
    const resolvedWorkingDir = team.workingDir.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '.');
    initCodingMemory(team.workingDir);

    const dissolvedAt = new Date().toISOString();
    const durationMs = Date.now() - new Date(team.created_at).getTime();

    const teammateSummaries: TeammateMemory[] = Array.from(team.teammates.values()).map(tm => ({
      name: tm.name,
      role: tm.role,
      status: tm.status,
      result: tm.result,
      filesWritten: tm.filesWritten,
      toolsUsed: [...new Set(tm.toolsUsed)],
      error: tm.error,
    }));

    const contractSummaries: ContractMemory[] = team.contracts.map(c => ({
      path: c.path,
      description: c.description,
      phase: c.phase,
    }));

    const sessionSummary: TeamSessionSummary = {
      teamId,
      taskDescription: team.taskDescription,
      durationMs,
      createdAt: team.created_at,
      dissolvedAt,
      teammates: teammateSummaries,
      contracts: contractSummaries,
      phasesCompleted: team.currentPhase,
      validationResults: team.validationResults,
      workingDir: team.workingDir,
    };

    const sessionPath = logTeamSession(team.workingDir, sessionSummary);

    const allFiles = teammateSummaries.flatMap(tm => tm.filesWritten || []);
    const uniqueFiles = [...new Set(allFiles)];
    const mainUpdate = [
      `### Session ${teamId} (${dissolvedAt.slice(0, 10)})`,
      `Task: ${team.taskDescription}`,
      `Duration: ${Math.round(durationMs / 60000)}m | Phases: ${team.currentPhase} | Files: ${uniqueFiles.length}`,
      contractSummaries.length > 0
        ? `Contracts: ${contractSummaries.map(c => c.path).join(', ')}`
        : '',
      team.validationResults ? `Validation: see session log` : '',
    ].filter(Boolean).join('\n');

    updateMainState(team.workingDir, mainUpdate);

    if (sessionPath) {
      lines.push('', `Session logged to: ${sessionPath.replace(resolvedWorkingDir + '/', '')}`);
    }
  } catch (memErr: any) {
    console.error('[team] coding-memory persist error (non-fatal):', memErr?.message);
  }

  // Cleanup
  for (const [, tm] of team.teammates) {
    cancelWaiter(teamId, tm.name);
    cleanupSession(tm.sessionId);
    purgeSession(tm.sessionId);
    clearHistory(tm.sessionId);
  }

  if (team.worktreeManager) {
    for (const [, tm] of team.teammates) {
      if (tm.worktreePath || tm.worktreeBranch) {
        try {
          const result = await team.worktreeManager.removeWorktree(tm.name, { force: false });
          if (!result.removed && result.hadChanges) {
            lines.push(`Worktree for ${tm.name} has uncommitted changes — kept at: ${tm.worktreePath}`);
          }
        } catch (e: any) {
          lines.push(`Failed to remove worktree for ${tm.name}: ${e?.message || e}`);
        }
      }
    }
    try { team.worktreeManager.pruneWorktrees(); } catch {}
  }

  cleanupTeamMailbox(teamId);
  cleanupTeamTaskList(teamId);
  removeProtectedPath(team.workingDir);

  team.status = 'done';
  activeTeams.delete(teamId);
  if (onTeamUpdate) onTeamUpdate(teamId, null as any);

  return lines.join('\n');
}

// ─── Active Team Tracking ───

export function getActiveTeam(): TeamSession | null {
  for (const [, team] of activeTeams) {
    if (team.status !== 'done') return team;
  }
  return null;
}

export function getActiveTeamId(): string | null {
  for (const [id, team] of activeTeams) {
    if (team.status !== 'done') return id;
  }
  return null;
}

export function getAllTeams(): TeamSession[] {
  return Array.from(activeTeams.values());
}

export function getTeam(teamId: string): TeamSession | undefined {
  return activeTeams.get(teamId);
}

/**
 * Count active (working/idle) teammates across all teams.
 * Used by agent.ts to suppress idle checks while teammates are active.
 */
export function getActiveTeammateCount(): number {
  let count = 0;
  for (const team of activeTeams.values()) {
    for (const tm of team.teammates.values()) {
      if (tm.status === 'working' || tm.status === 'idle') count++;
    }
  }
  return count;
}

// ─── Team Status for UI ───

export interface TeamStatusUI {
  teamId: string;
  status: string;
  taskDescription: string;
  teammates: Array<{
    name: string;
    role: string;
    status: string;
    currentTask?: string;
    worktreeBranch?: string;
    worktreePath?: string;
    toolCount?: number;
    lastTool?: string;
    elapsed?: number;
    filesWritten?: number;
    worktreeFiles?: number;
    recentActivity?: string[];
  }>;
  taskCount: number;
  doneCount: number;
  activeCount: number;
  worktreeIsolation?: boolean;
  contractCount: number;
  currentPhase: number;
}

export function getTeamStatusUI(): TeamStatusUI | null {
  const team = getActiveTeam();
  if (!team) return null;

  const tasks = getTaskList(team.id);
  const done = tasks.filter(t => t.status === 'completed').length;
  const active = Array.from(team.teammates.values()).filter(t => t.status === 'working').length;

  return {
    teamId: team.id,
    status: team.status,
    taskDescription: team.taskDescription,
    teammates: Array.from(team.teammates.values()).map(tm => {
      const elapsed = tm.finishedAt
        ? Math.floor((tm.finishedAt - tm.startedAt) / 1000)
        : Math.floor((Date.now() - tm.startedAt) / 1000);
      const lastTool = tm.toolsUsed.length > 0 ? tm.toolsUsed[tm.toolsUsed.length - 1] : undefined;
      const wtScan = tm.worktreePath ? scanWorktreeFiles(tm.worktreePath) : { count: 0, files: [] };
      return {
        name: tm.name,
        role: tm.role,
        status: tm.status,
        worktreeBranch: tm.worktreeBranch,
        worktreePath: tm.worktreePath,
        toolCount: tm.toolsUsed.length,
        lastTool,
        elapsed,
        filesWritten: tm.filesWritten?.length || 0,
        worktreeFiles: wtScan.count,
        recentActivity: tm._activityLog ? tm._activityLog.slice(-3) : [],
      };
    }),
    taskCount: tasks.length,
    doneCount: done,
    activeCount: active,
    worktreeIsolation: team.worktreeIsolation,
    contractCount: team.contracts.length,
    currentPhase: team.currentPhase,
  };
}

// ─── Cascading Human Interrupt ───

export interface FrozenTeamState {
  teamId: string;
  teammates: Array<{
    name: string;
    status: string;
    filesWritten: string[];
    worktreeFileCount: number;
    lastActivity: string;
    toolsUsed: number;
  }>;
}

export function freezeAllTeammates(): FrozenTeamState | null {
  const team = getActiveTeam();
  if (!team) return null;

  const frozenTeammates: FrozenTeamState['teammates'] = [];

  for (const [, tm] of team.teammates) {
    if (tm.status === 'working') {
      tm.abortController?.abort();
      tm.status = 'interrupted';
    }
    if (tm.status === 'idle') {
      cancelWaiter(team.id, tm.name);
      tm.status = 'interrupted';
    }

    const wtFiles = tm.worktreePath ? scanWorktreeFiles(tm.worktreePath) : { count: 0, files: [] };
    const lastLog = tm._activityLog?.slice(-1)[0] || '';

    frozenTeammates.push({
      name: tm.name,
      status: tm.status,
      filesWritten: tm.filesWritten || [],
      worktreeFileCount: wtFiles.count,
      lastActivity: lastLog,
      toolsUsed: tm.toolsUsed.length,
    });
  }

  team._autoDissolveScheduled = false;
  notifyUpdate(team.id);

  return { teamId: team.id, teammates: frozenTeammates };
}

// ─── Cleanup ───

export function cleanupAllTeams(): void {
  for (const [teamId, team] of activeTeams) {
    for (const [, tm] of team.teammates) {
      try { cancelWaiter(teamId, tm.name); } catch {}
      try { cleanupSession(tm.sessionId); } catch {}
      try { purgeSession(tm.sessionId); } catch {}
      try { clearHistory(tm.sessionId); } catch {}

      if (team.worktreeManager && (tm.worktreePath || tm.worktreeBranch)) {
        try {
          team.worktreeManager.removeWorktree(tm.name, { force: false }).catch(() => {});
        } catch {}
      }
    }
    if (team.worktreeManager) {
      try { team.worktreeManager.pruneWorktrees(); } catch {}
    }
    cleanupTeamMailbox(teamId);
    cleanupTeamTaskList(teamId);
    removeProtectedPath(team.workingDir);
  }
  activeTeams.clear();
}

// ─── Helpers ───

function defaultTeammates(taskDescription: string): Array<{ name: string; role: string; model?: string }> {
  const lower = taskDescription.toLowerCase();
  const mates: Array<{ name: string; role: string; model?: string }> = [];

  if (lower.includes('backend') || lower.includes('api') || lower.includes('server') || lower.includes('database')) {
    mates.push({ name: '@backend', role: 'Backend engineer — handles server logic, APIs, databases' });
  }
  if (lower.includes('frontend') || lower.includes('ui') || lower.includes('css') || lower.includes('html')) {
    mates.push({ name: '@frontend', role: 'Frontend engineer — handles UI, CSS, browser code' });
  }
  if (lower.includes('test') || lower.includes('spec')) {
    mates.push({ name: '@tester', role: 'QA engineer — writes and runs tests, verifies functionality' });
  }

  if (mates.length === 0) {
    mates.push(
      { name: '@backend', role: 'Backend engineer — handles server logic, APIs, databases' },
      { name: '@frontend', role: 'Frontend engineer — handles UI, CSS, browser code' },
    );
  }

  return mates;
}

function buildTeammateSystemPrompt(name: string, role: string, teamId: string, taskList: string, worktreeCwd?: string): string {
  const cwdSection = worktreeCwd
    ? `\n## Your Isolated Working Directory (Git Worktree)
Your codebase copy is at: ${worktreeCwd}
ALWAYS use this as your cwd in exec commands: { command: "...", cwd: "${worktreeCwd}" }
You have your own branch — make changes freely without affecting teammates.
`
    : '';

  const contractsContext = getContractsContext(teamId);
  const contractsSection = contractsContext
    ? `\n${contractsContext}
**CRITICAL:** These contract files define the shared API surface. You MUST:
- Import types/interfaces from the contract files — do NOT redefine them.
- Use the exact function signatures specified in contracts.
- If you need something not in the contracts, message @lead to update them.
`
    : '';

  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dateContext = `## Current Time
Date: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
Time: ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
Timezone: ${tz}
`;

  return `${dateContext}You are ${name}, a member of a coding team (team ID: ${teamId}).

Your role: ${role}
${cwdSection}${contractsSection}
## Team Collaboration — Turn-Based Model
You operate in a turn-based loop:
1. You work on your task (using tools, writing code, running tests).
2. When your turn ends, you go idle.
3. Messages from teammates/lead arrive between turns as new messages.
4. You wake up and process the new messages.

## Communication Tools
- **send_message** — Send DMs to teammates or lead. Messages delivered between turns.
- **task_create** — Create new tasks for the team.
- **task_update** — Update task status (in_progress/completed), set owner, add results and files.
- **task_list** — See all tasks and their status.
- **task_get** — Get full details of a specific task.

## Rules
1. **ALWAYS call task_update** when you start a task (status: "in_progress") and finish (status: "completed" with result and files_touched).
2. If you need info from another teammate, use send_message.
3. When you receive a shutdown_request, finish critical work, then respond with send_message (type: "shutdown_response", approve: true).
4. If blocked, update task status and message @lead.
5. When done with ALL work, update all your tasks to "completed" and send a summary to @lead.

## Current Task List
${taskList}

## Coding Standards
- Preserve existing code style and conventions.
- Write clean, documented code.
- Report what files you modified.
- **Commit your work** with git when you finish (if in a git worktree).

## Problem-Solving
If stuck: re-read your task → identify what's blocking → try 1-2 alternatives → message @lead if still blocked.

## Tools Available
You have full access to: page tools, browser tools, HTTP tools, file tools, and shell tools.
Use them freely — browse docs, read files, run tests, check build output.
Be efficient: grep before reading entire files.
`;
}
