/**
 * team-manager.ts — Central orchestration engine for agent teams (Phase 8.38).
 *
 * Lead = main Aria session. Decomposes tasks, spawns teammates, monitors progress,
 * synthesizes results. Teammates = independent agent sessions with their own context.
 */

import { streamText, stepCountIs } from 'ai';
import type { WebContents } from 'electron';
import { createModel, getModelConfig, type LLMConfig } from './llm-client';
import { createTools } from './tool-registry';
import type { BrowserContext } from './browser-tools';
import { addMessage, clearHistory } from './conversation';
import { purgeSession } from './output-buffer';
import { cleanupSession, addProtectedPath, removeProtectedPath, clearContractFilePaths } from './shell-tools';
import {
  initMailbox,
  sendMessage,
  getUnreadMessages,
  formatInboxForContext,
  cleanupTeamMailbox,
} from './mailbox';
import {
  initTaskList,
  createTask,
  getTaskList,
  getTask,
  updateTask,
  claimTask,
  formatTaskListForContext,
  getTeamSummary,
  cleanupTeamTaskList,
  detectFileConflicts,
  type SharedTask,
} from './shared-task-list';
import { WorktreeManager, createWorktreeManager, type WorktreeInfo } from './worktree-manager';
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
  path: string;          // relative path from workingDir (e.g. "contracts/types.ts")
  absolutePath: string;  // resolved absolute path
  description: string;   // what this contract defines
  phase: number;         // which spawn round this contract belongs to (1-based)
  createdAt: string;
}

export interface TeamSession {
  id: string;
  lead: string;                   // session ID of lead (always "default")
  teammates: Map<string, Teammate>;
  workingDir: string;
  status: 'planning' | 'active' | 'completing' | 'done';
  created_at: string;
  taskDescription: string;
  worktreeIsolation?: boolean;    // Phase 8.39: git worktree per teammate
  worktreeManager?: WorktreeManager; // Phase 8.39: manages worktree lifecycle
  ariaWebContents?: WebContents | null; // Live UI broadcasting
  // Phase 9.096: Contract-first parallel work
  contracts: ContractFile[];      // shared contract/interface files written by lead
  currentPhase: number;           // current spawn round (1-based)
  validationResults?: string;     // post-merge validation output
  _autoDissolveScheduled?: boolean; // Phase 9.096e: prevents double auto-dissolve
}

export interface Teammate {
  id: string;
  name: string;                   // e.g. "@backend"
  role: string;
  sessionId: string;
  status: 'idle' | 'working' | 'blocked' | 'done' | 'failed' | 'interrupted';
  currentTaskId?: string;
  currentTaskText?: string;       // human-readable task description from team_run_teammate
  model?: string;                 // can use different model than lead
  toolsUsed: string[];
  filesWritten?: string[];        // passive tracking: files created/modified by this teammate
  result?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  // Phase 8.39: Git worktree isolation
  worktreePath?: string;          // absolute path to isolated worktree
  worktreeBranch?: string;        // e.g. "wt-backend"
  // Phase 9.096d: Interrupt support
  abortController?: AbortController;   // for on-demand abort
  conversationHistory?: any[];         // accumulated messages for surgical resume
  partialResponse?: string;            // text accumulated before interrupt
  _systemPrompt?: string;              // frozen at first invocation for resume
  _tools?: Record<string, any>;        // frozen at first invocation for resume
  _model?: any;                        // frozen at first invocation for resume
  // Phase 9.096d: Pulse
  lastPulse?: string;                  // latest ~20-token activity snippet
  _activityLog?: string[];             // plain text log of tool calls + results for interrupt resume
}

export interface TeammateRunOptions {
  teammate: Teammate;
  teamId: string;
  task: string;
  browserCtx: BrowserContext;
  llmConfig: LLMConfig;
  ariaWebContents?: WebContents | null;
}

// ─── Pulse Helpers ───

/** Build a human-readable activity description from a tool call */
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
    case 'team_task_update': return `updating task ${args.task_id || ''}`;
    case 'team_message': return `messaging ${args.to || ''}`;
    default:             return toolName;
  }
}

/** Extract a meaningful phrase from LLM text output for pulse display */
function extractMeaningfulPhrase(text: string): string {
  // Look for sentences starting with action verbs in the last ~200 chars
  const fragment = text.slice(-300);
  // Try to find "I'll/I will/Now I/Let me/Going to/Creating/Building/Writing/Implementing..."
  const patterns = [
    /(?:I'll|I will|Now I'll|Let me|Going to)\s+(.{10,70}?)(?:\.|$)/i,
    /(?:Creating|Building|Writing|Implementing|Adding|Setting up|Configuring|Reading|Checking)\s+(.{5,60}?)(?:\.|,|$)/i,
    /(?:Now|Next)[,:]\s+(.{10,60}?)(?:\.|$)/i,
  ];
  for (const pat of patterns) {
    const m = fragment.match(pat);
    if (m) {
      const phrase = (m[0] || '').replace(/\n/g, ' ').trim().slice(0, 80);
      if (phrase.length > 15) return phrase;
    }
  }
  // Fallback: last complete sentence fragment
  const sentences = fragment.split(/[.!]\s+/);
  const last = (sentences[sentences.length - 1] || '').replace(/\n/g, ' ').trim();
  if (last.length > 15 && last.length < 80) return last;
  return '';
}

// ─── Active Teams ───

const activeTeams = new Map<string, TeamSession>();
let teamCounter = 0;
let teamDevMode = false;

/** Update teammate developer mode — called when config changes. */
export function setTeamDevMode(enabled: boolean): void {
  teamDevMode = enabled;
}

// ─── IPC Callback ───

type TeamUpdateCallback = (teamId: string, team: TeamSession) => void;
let onTeamUpdate: TeamUpdateCallback | null = null;

export function setTeamUpdateCallback(cb: TeamUpdateCallback): void {
  onTeamUpdate = cb;
}

function notifyUpdate(teamId: string): void {
  const team = activeTeams.get(teamId);
  if (team && onTeamUpdate) onTeamUpdate(teamId, team);

  // Phase 9.096e: Auto-dissolve when all teammates reach terminal state.
  // Dissolve is housekeeping, not a lead decision. Fire it automatically.
  if (team && team.status === 'active') {
    const allTerminal = team.teammates.size > 0 &&
      Array.from(team.teammates.values()).every(t => t.status === 'done' || t.status === 'failed');
    if (allTerminal && !team._autoDissolveScheduled) {
      team._autoDissolveScheduled = true;
      // Small delay to let final UI updates land before cleanup
      setTimeout(async () => {
        try {
          console.log(`[team] Auto-dissolving ${teamId} — all teammates finished.`);
          await dissolveTeam(teamId);
        } catch (e: any) {
          console.error(`[team] Auto-dissolve failed for ${teamId}:`, e?.message);
        }
      }, 2000);
    }
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
  // F16: Max 10 teammates across all teams
  const totalTeammates = Array.from(activeTeams.values()).reduce((sum, t) => sum + t.teammates.size, 0);
  const requestedCount = teammateConfigs?.length || 3; // defaultTeammates returns ~3
  if (totalTeammates + requestedCount > 10) {
    return { teamId: '', summary: `❌ Cannot create team: would exceed max 10 teammates (currently ${totalTeammates} active). Dissolve existing teams first.` };
  }

  const teamId = `team-${++teamCounter}`;

  // Initialize mailbox and task list
  initMailbox(teamId, '@lead');
  initTaskList(teamId);

  // Phase 8.39: Set up worktree manager if isolation enabled and in a git repo
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
    // Phase 9.096: Contract-first parallel work
    contracts: [],
    currentPhase: 1,
  };

  activeTeams.set(teamId, team);

  // Phase 9.096b: Protect the working directory from destructive shell commands while team is active
  addProtectedPath(resolvedDir);

  notifyUpdate(teamId);

  // Auto-configure teammates if not provided
  const teammates = teammateConfigs || defaultTeammates(taskDescription);

  // Register each teammate in mailbox + team; create worktrees if enabled
  const worktreeWarnings: string[] = [];
  for (const tc of teammates) {
    const sessionId = `${teamId}:${tc.name}`;
    initMailbox(teamId, tc.name);

    let worktreePath: string | undefined;
    let worktreeBranch: string | undefined;

    // Phase 8.39: Create worktree for each teammate
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
        worktreeWarnings.push(`⚠️ Worktree creation failed for ${tc.name}: ${e?.message || e}`);
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
    };

    team.teammates.set(tc.name, teammate);
  }

  team.status = 'active';
  notifyUpdate(teamId);

  const teammateList = teammates.map(t => {
    const tm = team.teammates.get(t.name);
    const wtInfo = tm?.worktreeBranch ? ` [${tm.worktreeBranch}]` : '';
    return `- ${t.name}${wtInfo}: ${t.role}`;
  }).join('\n');

  let summary = `✓ Team "${teamId}" created with ${teammates.length} teammate(s):\n${teammateList}\n\nTask: ${taskDescription}\nWorking dir: ${workingDir}`;

  if (worktreesEnabled) {
    summary += `\n🔀 Worktree isolation: ENABLED — each teammate has an isolated copy of the codebase.`;
  } else if (worktreeIsolation !== false) {
    summary += `\nℹ️ Worktree isolation: UNAVAILABLE — working directory is not a git repository. Teammates share the working directory.`;
  }

  if (worktreeWarnings.length > 0) {
    summary += '\n' + worktreeWarnings.join('\n');
  }

  summary += `\n\n**Contract-First Protocol (Phase 9.096):**
1. Write shared contracts FIRST with \`team_write_contracts\` — type definitions, interfaces, function signatures that teammates must import/reference.
2. Then \`team_task_add\` to define tasks referencing those contracts.
3. Then \`team_run_teammate\` to spawn teammates — they receive contracts in their system prompt.
4. After teammates finish, call \`team_validate\` to verify integration before dissolving.

Max ~5 contract files per phase. Later phases build on real merged code, not more stubs.`;

  return { teamId, summary };
}

// ─── Run a Teammate ───

export async function runTeammate(opts: TeammateRunOptions): Promise<string> {
  const { teammate, teamId, task, browserCtx, llmConfig, ariaWebContents } = opts;
  const team = activeTeams.get(teamId);
  if (!team) return `❌ Team "${teamId}" not found.`;

  // Phase 9.096: Hard gate — contracts MUST be written before spawning any teammate.
  // LLMs skip "MANDATORY" prompt instructions. Code gates are deterministic.
  if (team.contracts.length === 0) {
    return `❌ No contracts written. Call team_write_contracts first — define shared interfaces/types that teammates must reference. This prevents incompatible code.\n\nExample: team_write_contracts({ path: "contracts/types.ts", content: "export interface ...", description: "Shared data types" })`;
  }

  // Store ariaWebContents on the team session for future reference
  if (ariaWebContents && !team.ariaWebContents) {
    team.ariaWebContents = ariaWebContents;
  }

  teammate.status = 'working';
  teammate.currentTaskText = task;
  teammate.startedAt = Date.now();
  notifyUpdate(teamId);

  // Run in background
  console.log(`[team] Spawning ${teammate.name}...`);
  runTeammateSession(teammate, teamId, task, browserCtx, llmConfig, ariaWebContents ?? team.ariaWebContents).catch(err => {
    console.error(`[team] ${teammate.name} unhandled rejection:`, err?.message, err?.stack?.slice(0, 200));
    teammate.status = 'failed';
    teammate.error = err?.message || 'Unknown error';
    teammate.finishedAt = Date.now();
    notifyUpdate(teamId);
  });

  return `✓ Teammate ${teammate.name} started on: ${task}`;
}

async function runTeammateSession(
  teammate: Teammate,
  teamId: string,
  task: string,
  browserCtx: BrowserContext,
  llmConfig: LLMConfig,
  ariaWebContents?: WebContents | null,
): Promise<void> {
  const { sessionId, name, role } = teammate;
  console.log(`[team] ${name} session starting — teamId: ${teamId}, task: ${task.slice(0, 60)}`);

  // ─── Mailbox throttle (max 1 file message per 5s per teammate) ───
  let lastFileMailTs = 0;
  let pendingFileCount = 0;

  // ─── Broadcast helper ───
  function teamBroadcast(channel: string, data: any): void {
    try {
      if (ariaWebContents && !ariaWebContents.isDestroyed()) {
        ariaWebContents.send(channel, data);
      } else {
        console.warn(`[team] ${name} broadcast SKIPPED (ariaWebContents ${ariaWebContents ? 'destroyed' : 'null'}): ${channel}`);
      }
    } catch (e: any) {
      console.warn(`[team] ${name} broadcast FAILED: ${channel} — ${e?.message}`);
    }
  }

  // Announce teammate start
  teamBroadcast('team:teammate-start', {
    id: teammate.id,
    name,
    role,
    task,
  });

  try {
    // Use teammate's explicit model if specified; otherwise use secondary model (Phase 8.85).
    // Teammates are parallel workers — secondary is cheaper/faster and sufficient.
    const baseConfig = getModelConfig('secondary', llmConfig);
    const tmConfig: LLMConfig = teammate.model
      ? { ...baseConfig, model: teammate.model }
      : baseConfig;

    const model = createModel(tmConfig);
    const tools = createTools(browserCtx, sessionId, { developerMode: teamDevMode, llmConfig: tmConfig, agentName: name });

    // Get unread messages for this teammate
    const unread = getUnreadMessages(teamId, name);
    const inboxContext = formatInboxForContext(unread);

    // Get task list context
    const taskListContext = formatTaskListForContext(teamId);

    // Phase 8.39: Use worktree path as the default cwd if available
    const worktreeCwd = teammate.worktreePath;
    const systemPrompt = buildTeammateSystemPrompt(name, role, teamId, taskListContext, worktreeCwd);

    const userContent = `${task}${inboxContext}`;

    addMessage(sessionId, { role: 'user', content: userContent });

    // Phase 9.096d: Freeze invocation config for surgical resume
    teammate._systemPrompt = systemPrompt;
    teammate._tools = tools;
    teammate._model = model;

    // Phase 9.096d: Initialize conversation history for interrupt/resume
    teammate.conversationHistory = [{ role: 'user', content: userContent }];
    teammate.partialResponse = '';

    // Phase 8.40: Timeout-based execution — no step limit
    const teammateTimeoutMs = llmConfig.teammateTimeoutMs ?? 900_000; // default 15 min
    const tmRunStart = Date.now();
    let tmTimedOut = false;
    const tmAbortController = new AbortController();
    // Phase 9.096d: Store AbortController on teammate for interrupt support
    teammate.abortController = tmAbortController;
    const tmTimeoutHandle = setTimeout(() => {
      tmTimedOut = true;
      tmAbortController.abort();
    }, teammateTimeoutMs);

    console.log(`[team] ${name} calling LLM (model: ${tmConfig.model}, provider: ${tmConfig.provider})...`);
    let result;
    try {
    result = await streamText({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
      tools,
      // Phase 9 fix: AI SDK v6 defaults to stepCountIs(1). Teammates need multi-step.
      stopWhen: stepCountIs(100),
      abortSignal: tmAbortController.signal,
      onStepFinish: async (event: any) => {
        try {
          const toolResults = event.toolResults || [];
          const isFirstTool = teammate.toolsUsed.length === 0 && toolResults.length > 0;
          for (const tr of toolResults) {
            const toolName = tr.toolName || 'unknown';
            teammate.toolsUsed.push(toolName);

            const resultStr = typeof tr.result === 'string'
              ? tr.result
              : JSON.stringify(tr.result ?? '');

            // Broadcast tool activity to in-chat panel
            teamBroadcast('team:teammate-tool', {
              name,
              toolName,
              display: `🔧 ${toolName} → ${resultStr.slice(0, 120)}`,
            });

            // Passive file tracking + auto mailbox on file writes (throttled)
            if (toolName === 'file_write' || toolName === 'file_append') {
              const filePath = (tr as any).args?.path || (tr as any).args?.file_path || '';
              if (filePath) {
                if (!teammate.filesWritten) teammate.filesWritten = [];
                teammate.filesWritten.push(filePath);
                pendingFileCount++;
                const now = Date.now();
                if (now - lastFileMailTs >= 5000) {
                  lastFileMailTs = now;
                  const shortPath = filePath.split('/').slice(-2).join('/');
                  const sizeMatch = resultStr.match(/\(([^)]+)\)/);
                  const sizeStr = sizeMatch ? ` (${sizeMatch[1]})` : '';
                  const batchNote = pendingFileCount > 1 ? ` (+${pendingFileCount - 1} more)` : '';
                  const mailText = `📄 Created ${shortPath}${sizeStr}${batchNote}`;
                  sendMessage(teamId, name, '@lead', mailText);
                  teamBroadcast('team:mailbox-message', { from: name, to: '@lead', text: mailText });
                  pendingFileCount = 0;
                }
              }
            }

            // Phase 9.096e: Broaden passive file detection for eval_js and exec
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

            // Auto-generate mailbox for exec results (build/test outcomes)
            if (toolName === 'exec' && resultStr.length > 0) {
              const exitMatch = resultStr.match(/exit(?:Code)?[:\s]+(\d+)/i);
              const exitCode = exitMatch ? parseInt(exitMatch[1]) : null;
              if (exitCode !== null && exitCode !== 0) {
                const mailText = `⚠️ Command failed (exit ${exitCode}): ${resultStr.slice(0, 80)}`;
                sendMessage(teamId, name, '@lead', mailText);
                teamBroadcast('team:mailbox-message', { from: name, to: '@lead', text: mailText });
              }
            }
          }

          // Auto mailbox: announce start on first tool call
          if (isFirstTool) {
            const startMail = `🚀 Started working — ${task.slice(0, 60)}`;
            sendMessage(teamId, name, '@lead', startMail);
            teamBroadcast('team:mailbox-message', { from: name, to: '@lead', text: startMail });
          }

          // Phase 9.096d: Capture step as plain text log for interrupt/resume.
          // Plain text can never fail SDK validation — no structured tool messages.
          try {
            if (!teammate._activityLog) teammate._activityLog = [];
            for (const tr of toolResults) {
              const toolName = (tr as any).toolName || 'unknown';
              const args = (tr as any).args || {};
              const desc = describeToolActivity(toolName, args);
              const resultStr = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result ?? '');
              const resultPreview = resultStr.slice(0, 200);
              teammate._activityLog.push(`${desc} → ${resultPreview}`);
            }
            if (event.text) {
              teammate._activityLog.push(`Response: ${event.text.slice(0, 200)}`);
            }
          } catch {}

          // Passive top card update — every tool step, not just when teammate explicitly reports
          notifyUpdate(teamId);
        } catch {}
      },
    });
    } catch (initErr: any) {
      // Catch InvalidPromptError / TypeValidationError on initial teammate invocation
      const errName = initErr?.name || initErr?.constructor?.name || '';
      console.error(`[team] ${name} INITIAL streamText failed (${errName}):`, initErr?.message?.slice?.(0, 200));
      console.error(`[team] ${name} cause:`, initErr?.cause?.message?.slice?.(0, 500) || 'no cause');
      // Rethrow — we can't simplify the initial invocation (no prior context to summarize)
      throw initErr;
    }

    let fullResponse = '';
    let tmChunkCount = 0;
    // Phase 9.096d: Pulse system — emit activity snippet every 30s
    let currentActivity = '';
    let textSincePulse = '';
    const pulseIntervalMs = 30_000;
    const pulseInterval = setInterval(() => {
      const pulseText = (currentActivity || textSincePulse).slice(0, 80);
      if (pulseText && teammate.status === 'working') {
        teammate.lastPulse = pulseText;
        sendMessage(teamId, name, '@lead', '🫀 ' + pulseText);
        teamBroadcast('team:teammate-pulse', { name, text: pulseText });
        teamBroadcast('team:mailbox-message', { from: name, to: '@lead', text: '🫀 ' + pulseText });
      }
      textSincePulse = '';
    }, pulseIntervalMs);

    console.log(`[team] ${name} starting stream...`);
    try {
      // Use fullStream to capture text-delta chunks for live UI broadcasting
      for await (const chunk of result.fullStream) {
        tmChunkCount++;
        if (tmChunkCount === 1) console.log(`[team] ${name} first chunk: type=${(chunk as any).type}`);
        if (chunk.type === 'text-delta') {
          // AI SDK v6: field is 'text' on text-delta chunks (not 'textDelta' or 'delta')
          const textDelta = (chunk as any).text ?? (chunk as any).delta ?? (chunk as any).textDelta ?? '';
          fullResponse += textDelta;
          // Phase 9.096d: Track partial response for interrupt support
          teammate.partialResponse = fullResponse;
          if (textDelta) {
            textSincePulse += textDelta;
            // Extract meaningful activity from accumulated text (not raw fragments)
            if (fullResponse.length > 20) {
              const meaningful = extractMeaningfulPhrase(fullResponse.slice(-200));
              if (meaningful) currentActivity = meaningful;
            }
            teamBroadcast('team:teammate-chunk', {
              name,
              text: textDelta,
              done: false,
            });
          }
        } else if (chunk.type === 'tool-call') {
          // Phase 9.096d: Track tool call activity for pulse — human-readable descriptions
          const toolName = (chunk as any).toolName || 'tool';
          const args = (chunk as any).args || {};
          currentActivity = describeToolActivity(toolName, args);
          textSincePulse += currentActivity;
        } else if ((chunk as any).type === 'reasoning' || (chunk as any).type === 'reasoning-start' || (chunk as any).type === 'reasoning-end') {
          // Phase 9.096d: Capture reasoning for pulse + broadcast
          const reasoningText = (chunk as any).text ?? (chunk as any).textDelta ?? '';
          if (reasoningText) {
            textSincePulse += reasoningText;
            // Extract meaningful phrase from reasoning for pulse
            const meaningful = extractMeaningfulPhrase(reasoningText);
            if (meaningful) currentActivity = meaningful;
            teamBroadcast('team:teammate-reasoning', { name, text: reasoningText });
          }
        }
      }
      console.log(`[team] ${name} stream done — ${fullResponse.length} chars, ${tmChunkCount} chunks, ${teammate.toolsUsed.length} tools`);
    } catch (streamErr: any) {
      if (streamErr?.name === 'AbortError' && tmTimedOut) {
        // Timeout: mark task as blocked, notify lead
        const elapsed = Date.now() - tmRunStart;
        const min = Math.floor(elapsed / 60000);
        const sec = Math.floor((elapsed % 60000) / 1000);
        const durStr = min > 0 ? `${min}m ${sec}s` : `${sec}s`;
        const timeoutMsg = `Timed out after ${durStr}. ${teammate.toolsUsed.length} tool calls completed.`;

        // Update any in-progress task to blocked
        if (teammate.currentTaskId) {
          const team = activeTeams.get(teamId);
          if (team) {
            updateTask(teamId, teammate.currentTaskId, { status: 'blocked', blockedBy: `Teammate timed out: ${timeoutMsg}` });
          }
        }

        // Notify lead and broadcast mailbox event
        const timeoutContent = `⏰ Timeout: ${name} timed out after ${durStr}. ${teammate.toolsUsed.length} tool calls completed.\n` +
          (fullResponse ? `Partial output:\n${fullResponse.slice(0, 500)}` : 'No output produced.');
        sendMessage(teamId, name, '@lead', timeoutContent);
        teamBroadcast('team:mailbox-message', {
          from: name,
          to: '@lead',
          text: timeoutContent.slice(0, 200),
        });

        // Signal stream done
        teamBroadcast('team:teammate-chunk', { name, text: '', done: true });
        teamBroadcast('team:teammate-done', { name, status: 'blocked', summary: timeoutMsg });

        teammate.result = fullResponse
          ? `${fullResponse}\n\n---\n⏰ Timed out after ${durStr}.`
          : `⏰ Timed out after ${durStr}. ${teammate.toolsUsed.length} tool calls: ${[...new Set(teammate.toolsUsed)].join(', ')}`;
        teammate.status = 'blocked';
        teammate.error = timeoutMsg;
        teammate.finishedAt = Date.now();
        notifyUpdate(teamId);
        return;
      } else if (streamErr?.name !== 'AbortError') {
        throw streamErr;
      }
    } finally {
      clearTimeout(tmTimeoutHandle);
      clearInterval(pulseInterval);
    }

    teammate.result = fullResponse || `Used ${teammate.toolsUsed.length} tools: ${[...new Set(teammate.toolsUsed)].join(', ')}`;
    teammate.status = 'done';
    teammate.finishedAt = Date.now();

    // Notify lead via mailbox and broadcast mailbox event
    const completeContent = `Task complete: ${task.slice(0, 100)}\n\nResult: ${(teammate.result || '').slice(0, 300)}`;
    sendMessage(teamId, name, '@lead', completeContent);
    teamBroadcast('team:mailbox-message', {
      from: name,
      to: '@lead',
      text: completeContent.slice(0, 200),
    });

    // Signal stream done
    teamBroadcast('team:teammate-chunk', { name, text: '', done: true });
    teamBroadcast('team:teammate-done', {
      name,
      status: 'done',
      summary: (teammate.result || '').slice(0, 300),
    });

    notifyUpdate(teamId);

  } catch (err: any) {
    const errMsg = err?.message || 'Unknown error';
    console.error(`[team] ${name} session error:`, errMsg, err?.stack?.slice(0, 300));
    teamBroadcast('team:teammate-chunk', { name, text: '', done: true });
    teamBroadcast('team:teammate-done', { name, status: 'failed', summary: errMsg });
    teammate.status = 'failed';
    teammate.error = errMsg;
    teammate.finishedAt = Date.now();
    notifyUpdate(teamId);
  } finally {
    cleanupSession(sessionId);
    purgeSession(sessionId);
    clearHistory(sessionId);
  }
}

// ─── Phase 9.096d: Interrupt & Resume ───

/**
 * Interrupt a running teammate and redirect them with new instructions.
 * Preserves conversation history — they resume with full context + redirect message.
 */
export async function interruptTeammate(teamId: string, name: string, message: string): Promise<string> {
  const team = activeTeams.get(teamId);
  if (!team) return `❌ Team "${teamId}" not found.`;

  const teammate = team.teammates.get(name);
  if (!teammate) return `❌ Teammate "${name}" not found in team "${teamId}".`;
  if (teammate.status !== 'working') return `❌ ${name} is not currently working (status: ${teammate.status}). Can only interrupt working teammates.`;

  // Step 1: Abort current stream
  teammate.abortController?.abort();

  // Step 2: Wait for abort to propagate
  await new Promise<void>(resolve => setTimeout(resolve, 500));

  // Step 3: Mark as interrupted
  teammate.status = 'interrupted';
  notifyUpdate(teamId);

  // Step 4: Build resume as plain text — can never fail SDK validation
  const activityLog = teammate._activityLog || [];
  const logText = activityLog.length > 0
    ? `\n\nWhat you did before being interrupted (${activityLog.length} steps):\n${activityLog.map((l, i) => `${i + 1}. ${l}`).join('\n')}`
    : '';
  const filesText = teammate.filesWritten && teammate.filesWritten.length > 0
    ? `\n\nFiles you wrote: ${teammate.filesWritten.join(', ')}`
    : '';
  const partialText = teammate.partialResponse;
  const partialNote = (partialText && partialText.trim())
    ? `\n\nYour last thought before interrupt: "${partialText.slice(-200)}"`
    : '';

  const resumeHistory: any[] = [{
    role: 'user',
    content: `[INTERRUPT from @lead]: ${message}${logText}${filesText}${partialNote}\n\nContinue with the redirect instructions above. Check what files exist in your worktree and proceed from where you left off.`,
  }];

  // Step 5: Notify lead + broadcast
  const interruptMsg = `⚡ ${name} interrupted and redirected: "${message.slice(0, 80)}"`;
  sendMessage(teamId, '@lead', '@lead', interruptMsg);

  const ariaWC = team.ariaWebContents;
  function teamBroadcastInterrupt(channel: string, data: any): void {
    try {
      if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send(channel, data);
    } catch {}
  }
  teamBroadcastInterrupt('team:teammate-interrupt', { name, message });
  teamBroadcastInterrupt('team:mailbox-message', { from: '@lead', to: name, text: interruptMsg });

  // Step 6: Resume with frozen config + new AbortController
  const newAbortController = new AbortController();
  teammate.abortController = newAbortController;
  teammate.status = 'working';
  teammate.partialResponse = '';
  notifyUpdate(teamId);

  // Retrieve frozen invocation config
  const frozenSystemPrompt = teammate._systemPrompt || '';
  const frozenTools = teammate._tools || {};
  const frozenModel = teammate._model;
  const worktreePath = teammate.worktreePath;

  // Run with history in background
  runTeammateWithHistory({
    teammate,
    teamId,
    resumeHistory,
    systemPrompt: frozenSystemPrompt,
    tools: frozenTools,
    model: frozenModel,
    abortController: newAbortController,
    ariaWebContents: ariaWC,
  }).catch(err => {
    console.error(`[team] ${name} resume after interrupt error:`, err?.message);
    teammate.status = 'failed';
    teammate.error = err?.message || 'Resume failed';
    teammate.finishedAt = Date.now();
    notifyUpdate(teamId);
  });

  return `⚡ ${name} interrupted. Resuming with: "${message.slice(0, 80)}"\n⏳ Wait 30-60s, then call team_status to check progress.`;
}

interface TeammateResumeOptions {
  teammate: Teammate;
  teamId: string;
  resumeHistory: any[];
  systemPrompt: string;
  tools: Record<string, any>;
  model: any;
  abortController: AbortController;
  ariaWebContents?: WebContents | null;
}

/**
 * Run a teammate from an existing conversation history (surgical resume after interrupt).
 * Shares core logic with runTeammateSession but skips initial message construction.
 */
async function runTeammateWithHistory(opts: TeammateResumeOptions): Promise<void> {
  const { teammate, teamId, resumeHistory, systemPrompt, tools, model, abortController, ariaWebContents } = opts;
  const { sessionId, name } = teammate;

  function teamBroadcast(channel: string, data: any): void {
    try {
      if (ariaWebContents && !ariaWebContents.isDestroyed()) {
        ariaWebContents.send(channel, data);
      }
    } catch {}
  }

  teamBroadcast('team:teammate-start', { id: teammate.id, name, role: teammate.role, task: '(resuming after interrupt)' });

  try {
    // Update conversation history to resumed state
    teammate.conversationHistory = resumeHistory;
    teammate.partialResponse = '';

    // Pulse system
    let currentActivity = '';
    let textSincePulse = '';
    const pulseInterval = setInterval(() => {
      const pulseText = (currentActivity || textSincePulse).slice(0, 80);
      if (pulseText && teammate.status === 'working') {
        teammate.lastPulse = pulseText;
        sendMessage(teamId, name, '@lead', '🫀 ' + pulseText);
        teamBroadcast('team:teammate-pulse', { name, text: pulseText });
        teamBroadcast('team:mailbox-message', { from: name, to: '@lead', text: '🫀 ' + pulseText });
      }
      textSincePulse = '';
    }, 30_000);

    // Resume messages are always plain text (user role) — can never fail SDK validation
    const result = await streamText({
      model,
      system: systemPrompt,
      messages: resumeHistory,
      tools,
      stopWhen: stepCountIs(100),
      abortSignal: abortController.signal,
      onStepFinish: async (event: any) => {
        try {
          const toolResults = event.toolResults || [];
          for (const tr of toolResults) {
            const toolName = tr.toolName || 'unknown';
            teammate.toolsUsed.push(toolName);
            const resultStr = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result ?? '');
            teamBroadcast('team:teammate-tool', { name, toolName, display: `🔧 ${toolName} → ${resultStr.slice(0, 120)}` });

            // Passive file tracking
            if (toolName === 'file_write' || toolName === 'file_append') {
              const filePath = (tr as any).args?.path || (tr as any).args?.file_path || '';
              if (filePath) {
                if (!teammate.filesWritten) teammate.filesWritten = [];
                teammate.filesWritten.push(filePath);
              }
            }

            // Phase 9.096e: Broaden passive file detection for eval_js and exec
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

          // Capture step as plain text activity log (same as runTeammateSession)
          try {
            if (!teammate._activityLog) teammate._activityLog = [];
            for (const tr of toolResults) {
              const toolName = (tr as any).toolName || 'unknown';
              const args = (tr as any).args || {};
              const desc = describeToolActivity(toolName, args);
              const resultStr = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result ?? '');
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
    let fullResponse = '';
    let chunksReceived = 0;
    try {
      for await (const chunk of result.fullStream) {
        chunksReceived++;
        if (chunk.type === 'text-delta') {
          const textDelta = (chunk as any).text ?? (chunk as any).delta ?? (chunk as any).textDelta ?? '';
          fullResponse += textDelta;
          teammate.partialResponse = fullResponse;
          if (textDelta) {
            textSincePulse += textDelta;
            if (fullResponse.length > 20) {
              const meaningful = extractMeaningfulPhrase(fullResponse.slice(-200));
              if (meaningful) currentActivity = meaningful;
            }
            teamBroadcast('team:teammate-chunk', { name, text: textDelta, done: false });
          }
        } else if (chunk.type === 'tool-call') {
          const toolName = (chunk as any).toolName || 'tool';
          const args = (chunk as any).args || {};
          currentActivity = describeToolActivity(toolName, args);
          textSincePulse += currentActivity;
        } else if ((chunk as any).type === 'reasoning' || (chunk as any).type === 'reasoning-start' || (chunk as any).type === 'reasoning-end') {
          const reasoningText = (chunk as any).text ?? (chunk as any).textDelta ?? '';
          if (reasoningText) {
            textSincePulse += reasoningText;
            const meaningful = extractMeaningfulPhrase(reasoningText);
            if (meaningful) currentActivity = meaningful;
            teamBroadcast('team:teammate-reasoning', { name, text: reasoningText });
          }
        }
      }
    } catch (streamErr: any) {
      if (streamErr?.name !== 'AbortError') throw streamErr;
    } finally {
      clearInterval(pulseInterval);
    }

    teammate.result = fullResponse || `Resumed — ${teammate.toolsUsed.length} tools used`;
    teammate.status = 'done';
    teammate.finishedAt = Date.now();

    const completeContent = `Task complete (after redirect): ${(teammate.result || '').slice(0, 300)}`;
    sendMessage(teamId, name, '@lead', completeContent);
    teamBroadcast('team:mailbox-message', { from: name, to: '@lead', text: completeContent.slice(0, 200) });
    teamBroadcast('team:teammate-chunk', { name, text: '', done: true });
    teamBroadcast('team:teammate-done', { name, status: 'done', summary: (teammate.result || '').slice(0, 300) });

    notifyUpdate(teamId);
  } catch (err: any) {
    const errMsg = err?.message || 'Unknown error';
    console.error(`[team] ${name} resume error:`, errMsg);
    teamBroadcast('team:teammate-chunk', { name, text: '', done: true });
    teamBroadcast('team:teammate-done', { name, status: 'failed', summary: errMsg });
    teammate.status = 'failed';
    teammate.error = errMsg;
    teammate.finishedAt = Date.now();
    notifyUpdate(teamId);
  }
}

// ─── Phase 9.096: Contract Management ───

/**
 * Write a contract/interface stub file to the project's contracts directory.
 * These files define the shared API surface that teammates must reference.
 * Lead writes contracts BEFORE spawning teammates.
 */
export function writeContract(
  teamId: string,
  relativePath: string,
  content: string,
  description: string,
): string {
  const team = activeTeams.get(teamId);
  if (!team) return `❌ Team "${teamId}" not found.`;

  // Enforce max 5 contracts per phase
  const phaseContracts = team.contracts.filter(c => c.phase === team.currentPhase);
  if (phaseContracts.length >= 5) {
    return `❌ Max 5 contract files per phase (current phase ${team.currentPhase} has ${phaseContracts.length}). Merge current phase results first, then start a new phase for more contracts.`;
  }

  // Resolve paths
  const resolvedDir = team.workingDir.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '.');
  const absolutePath = path.resolve(resolvedDir, relativePath);

  // Ensure parent directory exists
  const parentDir = path.dirname(absolutePath);
  fs.mkdirSync(parentDir, { recursive: true });

  // Write the contract file
  fs.writeFileSync(absolutePath, content, 'utf-8');

  // Track the contract
  const contract: ContractFile = {
    path: relativePath,
    absolutePath,
    description,
    phase: team.currentPhase,
    createdAt: new Date().toISOString(),
  };

  // Upsert — replace if same relative path exists
  const existingIdx = team.contracts.findIndex(c => c.path === relativePath);
  if (existingIdx >= 0) {
    team.contracts[existingIdx] = contract;
  } else {
    team.contracts.push(contract);
  }

  notifyUpdate(teamId);

  // If worktrees exist, copy contracts into each worktree
  if (team.worktreeIsolation && team.worktreeManager) {
    const copyResults: string[] = [];
    for (const [, tm] of team.teammates) {
      if (tm.worktreePath) {
        try {
          const wtContractPath = path.resolve(tm.worktreePath, relativePath);
          const wtParentDir = path.dirname(wtContractPath);
          fs.mkdirSync(wtParentDir, { recursive: true });
          fs.writeFileSync(wtContractPath, content, 'utf-8');
          copyResults.push(`✓ ${tm.name}`);
        } catch (e: any) {
          copyResults.push(`⚠️ ${tm.name}: ${e?.message}`);
        }
      }
    }
    if (copyResults.length > 0) {
      return `✓ Contract written: ${relativePath}\n  ${description}\n  Phase ${team.currentPhase} (${phaseContracts.length + 1}/5)\n  Copied to worktrees: ${copyResults.join(', ')}`;
    }
  }

  return `✓ Contract written: ${relativePath}\n  ${description}\n  Phase ${team.currentPhase} (${phaseContracts.length + 1}/5)`;
}

/**
 * Get all contract files for a team, formatted for teammate context injection.
 */
export function getContractsContext(teamId: string): string {
  const team = activeTeams.get(teamId);
  if (!team || team.contracts.length === 0) return '';

  const lines = ['## Shared Contracts (DO NOT modify these — import/reference only)\n'];
  for (const c of team.contracts) {
    lines.push(`### ${c.path} — ${c.description} (phase ${c.phase})`);
    try {
      const content = fs.readFileSync(c.absolutePath, 'utf-8');
      // Cap each contract display at 100 lines to keep context manageable
      const contentLines = content.split('\n');
      if (contentLines.length > 100) {
        lines.push('```');
        lines.push(contentLines.slice(0, 100).join('\n'));
        lines.push(`... (${contentLines.length - 100} more lines — read the file for full content)`);
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

/**
 * Advance to the next phase. Called after merging phase results.
 */
export function advancePhase(teamId: string): string {
  const team = activeTeams.get(teamId);
  if (!team) return `❌ Team "${teamId}" not found.`;

  const prevPhase = team.currentPhase;
  team.currentPhase += 1;
  notifyUpdate(teamId);

  return `✓ Advanced from phase ${prevPhase} to phase ${team.currentPhase}. You can now write new contracts for this phase.`;
}

/**
 * Post-merge validation — run the project (build/lint/test) and report issues.
 * Returns a structured validation report.
 */
export async function validateIntegration(
  teamId: string,
  command?: string,
): Promise<string> {
  const team = activeTeams.get(teamId);
  if (!team) return `❌ Team "${teamId}" not found.`;

  const resolvedDir = team.workingDir.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '.');

  // Collect all files touched by teammates
  const allFiles: string[] = [];
  for (const [, tm] of team.teammates) {
    if (tm.filesWritten) allFiles.push(...tm.filesWritten);
  }
  const uniqueFiles = [...new Set(allFiles)];

  // Check for import/reference consistency in contract consumers
  const contractIssues: string[] = [];
  for (const contract of team.contracts) {
    const contractBasename = path.basename(contract.path, path.extname(contract.path));
    // Simple heuristic: check if any teammate file imports/references the contract
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
      contractIssues.push(`⚠️ Contract "${contract.path}" not referenced by any teammate file`);
    }
  }

  // Run validation command if provided
  let commandOutput = '';
  if (command) {
    try {
      const { execSync } = require('child_process');
      const result = execSync(command, {
        cwd: resolvedDir,
        timeout: 60_000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      commandOutput = `✅ Validation command passed:\n\`\`\`\n${(result || '').slice(0, 2000)}\n\`\`\``;
    } catch (e: any) {
      const stderr = e?.stderr || '';
      const stdout = e?.stdout || '';
      commandOutput = `❌ Validation command failed (exit ${e?.status || '?'}):\n\`\`\`\n${(stderr || stdout).slice(0, 2000)}\n\`\`\``;
    }
  }

  // Build report
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
    lines.push('', '✅ All contracts referenced by teammate code.');
  }

  // Check for file conflicts (same file touched by multiple teammates)
  const fileOwners = new Map<string, string[]>();
  for (const [, tm] of team.teammates) {
    for (const f of tm.filesWritten || []) {
      if (!fileOwners.has(f)) fileOwners.set(f, []);
      fileOwners.get(f)!.push(tm.name);
    }
  }
  const conflicts = [...fileOwners.entries()].filter(([, owners]) => owners.length > 1);
  if (conflicts.length > 0) {
    lines.push('', '**⚠️ File Conflicts (multiple teammates wrote same file):**');
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

// ─── Worktree File Scanner (Phase 9.096e) ───

/**
 * Scan a worktree for new/modified files using `git status --porcelain`.
 * Returns an array of file paths relative to the worktree root.
 */
function scanWorktreeFiles(worktreePath: string): { count: number; files: string[] } {
  try {
    const { execSync } = require('child_process');
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
  if (!team) return `❌ Team "${teamId}" not found.`;

  const tasks = getTaskList(teamId);
  const statusEmoji: Record<string, string> = {
    idle: '⏳', working: '🔄', blocked: '🚫', done: '✅', failed: '❌'
  };

  const lines = [
    `**Team ${teamId}** (${team.status}) — Phase ${team.currentPhase}`,
    `Task: ${team.taskDescription}`,
    `Working dir: ${team.workingDir}`,
  ];

  // Phase 9.096: Show contracts
  if (team.contracts.length > 0) {
    lines.push('', `**Contracts (${team.contracts.length}):**`);
    for (const c of team.contracts) {
      lines.push(`  📜 ${c.path} — ${c.description} (phase ${c.phase})`);
    }
  }

  lines.push('', '**Teammates:**');

  let hasWorkingTeammates = false;
  for (const [, tm] of team.teammates) {
    if (tm.status === 'working') hasWorkingTeammates = true;

    const emoji = statusEmoji[tm.status] || '❓';
    const dur = tm.finishedAt
      ? `${((tm.finishedAt - tm.startedAt) / 1000).toFixed(0)}s`
      : `${((Date.now() - tm.startedAt) / 1000).toFixed(0)}s`;
    const wtLabel = tm.worktreeBranch ? ` [${tm.worktreeBranch}]` : '';
    const toolCount = tm.toolsUsed.length;
    const passiveFilesCount = tm.filesWritten?.length || 0;
    const lastTool = toolCount > 0 ? tm.toolsUsed[toolCount - 1] : '';

    // Phase 9.096e: Real worktree file scan
    let worktreeScan: { count: number; files: string[] } = { count: 0, files: [] };
    if (tm.worktreePath) {
      worktreeScan = scanWorktreeFiles(tm.worktreePath);
    }
    const filesDisplay = tm.worktreePath
      ? `${worktreeScan.count} worktree files, ${passiveFilesCount} passive`
      : `${passiveFilesCount} files`;

    const activityStr = toolCount > 0
      ? ` | ${toolCount} tools, ${filesDisplay}${lastTool ? `, last: ${lastTool}` : ''}`
      : '';
    lines.push(`${emoji} ${tm.name}${wtLabel} (${tm.status}, ${dur}${activityStr}): ${tm.role}`);
    if (tm.currentTaskText) {
      lines.push(`   → Task: ${tm.currentTaskText.slice(0, 80)}`);
    } else if (tm.currentTaskId) {
      const t = getTask(teamId, tm.currentTaskId);
      if (t) lines.push(`   → Working on: ${t.title}`);
    }
    if (tm.worktreePath) {
      lines.push(`   📁 Worktree: ${tm.worktreePath}`);
      if (worktreeScan.count > 0) {
        const shown = worktreeScan.files.slice(0, 5).map(f => f.split('/').pop() || f).join(', ');
        const extra = worktreeScan.count > 5 ? ` (+${worktreeScan.count - 5} more)` : '';
        lines.push(`   📄 Changed files: ${shown}${extra}`);
      }
    }
    // Phase 9.096d: Show pulse activity and interrupt hint for working teammates
    if (tm.status === 'working') {
      if (tm.lastPulse) {
        lines.push(`   🫀 ${tm.lastPulse}`);
      }
      lines.push(`   💡 Use team_interrupt to redirect if needed`);
    }
    // Phase 9.096e: Show recent activity log entries (last 3)
    if (tm._activityLog && tm._activityLog.length > 0) {
      const recent = tm._activityLog.slice(-3);
      lines.push(`   📋 Recent: ${recent.map(e => e.slice(0, 60)).join(' | ')}`);
    }
    if (tm.error) lines.push(`   Error: ${tm.error}`);
  }

  if (tasks.length > 0) {
    lines.push('', '**Task List:**', formatTaskListForContext(teamId));
  }

  // Detect conflicts
  const conflicts = detectFileConflicts(tasks);
  if (conflicts.length > 0) {
    lines.push('', '⚠️ **File Conflicts:**');
    for (const c of conflicts) {
      lines.push(`  ${c.file}: ${c.taskTitles.join(' vs ')}`);
    }
  }

  // Phase 9.096d: Role reminder when teammates are working
  if (hasWorkingTeammates) {
    lines.push(
      '',
      '📋 **Your role while teammates work:**',
      '• `team_interrupt @name "instructions"` — redirect a teammate mid-task',
      '• `team_message @name "text"` — send a message (non-blocking)',
      '• `team_status` — re-check progress',
      '⚠️ Do NOT write code in the project directory while teammates are running.',
    );
  }

  return lines.join('\n');
}

// ─── Dissolve Team ───

export async function dissolveTeam(teamId: string): Promise<string> {
  const team = activeTeams.get(teamId);
  if (!team) return `❌ Team "${teamId}" not found.`;

  // Phase 9.096e: Clear contract file path registrations
  clearContractFilePaths();

  // Collect summary
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

  // ─── Persist session memory (coding-memory) ───
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
      teamId: teamId,
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

    // Build a compact update for main.md
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
      lines.push('', `📝 Session logged to: ${sessionPath.replace(resolvedWorkingDir + '/', '')}`);
    }
  } catch (memErr: any) {
    console.error('[team] coding-memory persist error (non-fatal):', memErr?.message);
  }

  // Cleanup
  for (const [, tm] of team.teammates) {
    cleanupSession(tm.sessionId);
    purgeSession(tm.sessionId);
    clearHistory(tm.sessionId);
  }

  // Phase 8.39: Remove worktrees on team dissolve (skip if they have uncommitted changes)
  if (team.worktreeManager) {
    for (const [, tm] of team.teammates) {
      if (tm.worktreePath || tm.worktreeBranch) {
        try {
          const result = await team.worktreeManager.removeWorktree(tm.name, { force: false });
          if (!result.removed && result.hadChanges) {
            lines.push(`⚠️ Worktree for ${tm.name} has uncommitted changes — kept at: ${tm.worktreePath}`);
          }
        } catch (e: any) {
          lines.push(`⚠️ Failed to remove worktree for ${tm.name}: ${e?.message || e}`);
        }
      }
    }
    // Prune dead git worktree entries
    try { team.worktreeManager.pruneWorktrees(); } catch {}
  }

  cleanupTeamMailbox(teamId);
  cleanupTeamTaskList(teamId);

  // Phase 9.096b: Remove working directory protection now that team is dissolved
  removeProtectedPath(team.workingDir);

  team.status = 'done';
  activeTeams.delete(teamId);
  notifyUpdate(teamId);

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
    worktreeBranch?: string;    // Phase 8.39: branch name for display
    worktreePath?: string;      // Phase 8.39: absolute path
    toolCount?: number;         // passive: total tools used
    lastTool?: string;          // passive: last tool called
    elapsed?: number;           // seconds since start
    filesWritten?: number;      // passive: files created/modified
    // Phase 9.096e: real worktree scan + recent activity
    worktreeFiles?: number;     // real count from git status --porcelain
    recentActivity?: string[];  // last 3 activity log entries
  }>;
  taskCount: number;
  doneCount: number;
  activeCount: number;
  worktreeIsolation?: boolean;  // Phase 8.39: whether worktrees are enabled
  // Phase 9.096: Contract-first
  contractCount: number;
  currentPhase: number;
}

export function getTeamStatusUI(): TeamStatusUI | null {
  const team = getActiveTeam();
  if (!team) return null;

  const tasks = getTaskList(team.id);
  const done = tasks.filter(t => t.status === 'done').length;
  const active = Array.from(team.teammates.values()).filter(t => t.status === 'working').length;

  return {
    teamId: team.id,
    status: team.status,
    taskDescription: team.taskDescription,
    teammates: Array.from(team.teammates.values()).map(tm => {
      const currentTask = tm.currentTaskId ? getTask(team.id, tm.currentTaskId) : undefined;
      const elapsed = tm.finishedAt
        ? Math.floor((tm.finishedAt - tm.startedAt) / 1000)
        : Math.floor((Date.now() - tm.startedAt) / 1000);
      const lastTool = tm.toolsUsed.length > 0 ? tm.toolsUsed[tm.toolsUsed.length - 1] : undefined;
      // Phase 9.096e: Scan worktree for real file counts
      const wtScan = tm.worktreePath ? scanWorktreeFiles(tm.worktreePath) : { count: 0, files: [] };
      return {
        name: tm.name,
        role: tm.role,
        status: tm.status,
        currentTask: currentTask?.title || tm.currentTaskText,
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
    // Phase 9.096
    contractCount: team.contracts.length,
    currentPhase: team.currentPhase,
  };
}

// ─── Phase 9.096e: Cascading Human Interrupt ───

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

/**
 * Freeze all active teammates — abort their streams, mark as 'interrupted',
 * and preserve all state (history, files, logs) for potential resume.
 * Called by stopAgent() and interruptMainSession() to cascade human interrupt.
 */
export function freezeAllTeammates(): FrozenTeamState | null {
  const team = getActiveTeam();
  if (!team) return null;

  const frozenTeammates: FrozenTeamState['teammates'] = [];

  for (const [, tm] of team.teammates) {
    if (tm.status === 'working') {
      // Abort the stream but preserve all state
      tm.abortController?.abort();
      tm.status = 'interrupted';
      // Don't clear _activityLog, filesWritten, partialResponse, conversationHistory
    }

    // Scan worktree for real file count
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

  // Cancel auto-dissolve if scheduled
  team._autoDissolveScheduled = false;

  notifyUpdate(team.id);

  return { teamId: team.id, teammates: frozenTeammates };
}

// ─── Cleanup ───

export function cleanupAllTeams(): void {
  for (const [teamId, team] of activeTeams) {
    for (const [, tm] of team.teammates) {
      try { cleanupSession(tm.sessionId); } catch {}
      try { purgeSession(tm.sessionId); } catch {}
      try { clearHistory(tm.sessionId); } catch {}

      // Phase 8.39: Cleanup worktrees that have no uncommitted changes
      if (team.worktreeManager && (tm.worktreePath || tm.worktreeBranch)) {
        try {
          // Use sync-style removal (force=false so we don't blow away uncommitted work)
          const worktreeDir = tm.worktreePath || '';
          if (worktreeDir) {
            team.worktreeManager.removeWorktree(tm.name, { force: false }).catch(() => {});
          }
        } catch {}
      }
    }
    // Prune stale git worktree refs
    if (team.worktreeManager) {
      try { team.worktreeManager.pruneWorktrees(); } catch {}
    }
    cleanupTeamMailbox(teamId);
    cleanupTeamTaskList(teamId);
    // Phase 9.096b: Remove working dir protection on cleanup
    removeProtectedPath(team.workingDir);
  }
  activeTeams.clear();
}

// ─── Helpers ───

function defaultTeammates(taskDescription: string): Array<{ name: string; role: string; model?: string }> {
  // Simple heuristic: always provide at least a backend and frontend teammate
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

  // Default: one backend + one frontend
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

  // Phase 9.096: Inject contract files into teammate context
  const contractsContext = getContractsContext(teamId);
  const contractsSection = contractsContext
    ? `\n${contractsContext}
**CRITICAL:** These contract files define the shared API surface. You MUST:
- Import types/interfaces from the contract files — do NOT redefine them.
- Use the exact function signatures specified in contracts.
- If a contract specifies a data shape, use it as-is.
- If you need something not in the contracts, message @lead to update them.
`
    : '';

  return `You are ${name}, a member of a coding team (team ID: ${teamId}).

Your role: ${role}
${cwdSection}${contractsSection}
## Team Collaboration Rules — MANDATORY
1. Check your inbox before starting work — teammates may have sent relevant info.
2. **ALWAYS call team_task_update** when you start a task (status: "in-progress") and when you finish (status: "done" with result summary and files_touched). This drives the progress bar — if you don't update, the team looks stuck.
3. If you need info from another teammate, send them a message with team_message.
4. If you're blocked, update the task status to "blocked" with a clear reason.
5. When done with ALL your work: update every task you worked on to "done", then send a completion summary to @lead via team_message.

## Current Task List
${taskList}

## Coding Standards
- Preserve existing code style and conventions.
- Write clean, documented code.
- Report what files you modified and what tests you ran.
- If you discover new tasks needed, add them with team_task_add.
- **Commit your work** with git when you finish (if in a git worktree).

## Tools Available
You have full access to: page tools, browser tools (you can browse docs!), HTTP tools, file tools, and shell tools.
Use them freely — especially: browse docs, read files, run tests, check build output.

The page is a black box — use elements/text tools to see it.
Be efficient: grep before reading entire files.
`;
}
