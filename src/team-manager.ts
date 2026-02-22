/**
 * team-manager.ts — Central orchestration engine for agent teams (Phase 8.38).
 *
 * Lead = main Aria session. Decomposes tasks, spawns teammates, monitors progress,
 * synthesizes results. Teammates = independent agent sessions with their own context.
 */

import { streamText } from 'ai';
import { createModel, getModelConfig, type LLMConfig } from './llm-client';
import { createTools } from './tool-registry';
import type { BrowserContext } from './browser-tools';
import { addMessage, clearHistory } from './conversation';
import { purgeSession } from './output-buffer';
import { cleanupSession } from './shell-tools';
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

// ─── Types ───

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
}

export interface Teammate {
  id: string;
  name: string;                   // e.g. "@backend"
  role: string;
  sessionId: string;
  status: 'idle' | 'working' | 'blocked' | 'done' | 'failed';
  currentTaskId?: string;
  model?: string;                 // can use different model than lead
  toolsUsed: string[];
  result?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  // Phase 8.39: Git worktree isolation
  worktreePath?: string;          // absolute path to isolated worktree
  worktreeBranch?: string;        // e.g. "wt-backend"
}

export interface TeammateRunOptions {
  teammate: Teammate;
  teamId: string;
  task: string;
  browserCtx: BrowserContext;
  llmConfig: LLMConfig;
}

// ─── Active Teams ───

const activeTeams = new Map<string, TeamSession>();
let teamCounter = 0;

// ─── IPC Callback ───

type TeamUpdateCallback = (teamId: string, team: TeamSession) => void;
let onTeamUpdate: TeamUpdateCallback | null = null;

export function setTeamUpdateCallback(cb: TeamUpdateCallback): void {
  onTeamUpdate = cb;
}

function notifyUpdate(teamId: string): void {
  const team = activeTeams.get(teamId);
  if (team && onTeamUpdate) onTeamUpdate(teamId, team);
}

// ─── Create Team ───

export async function createTeam(
  taskDescription: string,
  workingDir: string,
  browserCtx: BrowserContext,
  llmConfig: LLMConfig,
  teammateConfigs?: Array<{ name: string; role: string; model?: string }>,
  worktreeIsolation?: boolean,
): Promise<{ teamId: string; summary: string }> {
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
  };

  activeTeams.set(teamId, team);
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

  summary += `\n\nUse team_task_add to create tasks, then team_run_teammate to assign work.`;

  return { teamId, summary };
}

// ─── Run a Teammate ───

export async function runTeammate(opts: TeammateRunOptions): Promise<string> {
  const { teammate, teamId, task, browserCtx, llmConfig } = opts;
  const team = activeTeams.get(teamId);
  if (!team) return `❌ Team "${teamId}" not found.`;

  teammate.status = 'working';
  teammate.startedAt = Date.now();
  notifyUpdate(teamId);

  // Run in background
  runTeammateSession(teammate, teamId, task, browserCtx, llmConfig).catch(err => {
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
): Promise<void> {
  const { sessionId, name, role } = teammate;

  try {
    // Use teammate's explicit model if specified; otherwise use secondary model (Phase 8.85).
    // Teammates are parallel workers — secondary is cheaper/faster and sufficient.
    const baseConfig = getModelConfig('secondary', llmConfig);
    const tmConfig: LLMConfig = teammate.model
      ? { ...baseConfig, model: teammate.model }
      : baseConfig;

    const model = createModel(tmConfig);
    const tools = createTools(browserCtx, sessionId, { developerMode: true, llmConfig: tmConfig });

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

    // Phase 8.40: Timeout-based execution — no step limit
    const teammateTimeoutMs = llmConfig.teammateTimeoutMs ?? 600_000; // default 10 min
    const tmRunStart = Date.now();
    let tmTimedOut = false;
    const tmAbortController = new AbortController();
    const tmTimeoutHandle = setTimeout(() => {
      tmTimedOut = true;
      tmAbortController.abort();
    }, teammateTimeoutMs);

    const result = await streamText({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
      tools,
      // No stopWhen — runs until model stops or timeout (Phase 8.40)
      abortSignal: tmAbortController.signal,
      onStepFinish: async (event: any) => {
        try {
          const toolResults = event.toolResults || [];
          for (const tr of toolResults) {
            teammate.toolsUsed.push(tr.toolName || 'unknown');
          }
        } catch {}
      },
    });

    let fullResponse = '';
    try {
      for await (const chunk of result.textStream) {
        fullResponse += chunk;
      }
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

        // Notify lead
        sendMessage(teamId, name, '@lead',
          `⏰ Timeout: ${name} timed out after ${durStr}. ${teammate.toolsUsed.length} tool calls completed.\n` +
          (fullResponse ? `Partial output:\n${fullResponse.slice(0, 500)}` : 'No output produced.')
        );

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
    }

    teammate.result = fullResponse || `Used ${teammate.toolsUsed.length} tools: ${[...new Set(teammate.toolsUsed)].join(', ')}`;
    teammate.status = 'done';
    teammate.finishedAt = Date.now();

    // Notify lead via mailbox
    sendMessage(teamId, name, '@lead', `Task complete: ${task.slice(0, 100)}\n\nResult: ${(teammate.result || '').slice(0, 300)}`);

    notifyUpdate(teamId);

  } catch (err: any) {
    teammate.status = 'failed';
    teammate.error = err?.message || 'Unknown error';
    teammate.finishedAt = Date.now();
    notifyUpdate(teamId);
  } finally {
    cleanupSession(sessionId);
    purgeSession(sessionId);
    clearHistory(sessionId);
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
    `**Team ${teamId}** (${team.status})`,
    `Task: ${team.taskDescription}`,
    `Working dir: ${team.workingDir}`,
    '',
    '**Teammates:**',
  ];

  for (const [, tm] of team.teammates) {
    const emoji = statusEmoji[tm.status] || '❓';
    const dur = tm.finishedAt
      ? `${((tm.finishedAt - tm.startedAt) / 1000).toFixed(0)}s`
      : `${((Date.now() - tm.startedAt) / 1000).toFixed(0)}s`;
    const wtLabel = tm.worktreeBranch ? ` [${tm.worktreeBranch}]` : '';
    lines.push(`${emoji} ${tm.name}${wtLabel} (${tm.status}, ${dur}): ${tm.role}`);
    if (tm.currentTaskId) {
      const t = getTask(teamId, tm.currentTaskId);
      if (t) lines.push(`   → Working on: ${t.title}`);
    }
    if (tm.worktreePath) lines.push(`   📁 Worktree: ${tm.worktreePath}`);
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

  return lines.join('\n');
}

// ─── Dissolve Team ───

export async function dissolveTeam(teamId: string): Promise<string> {
  const team = activeTeams.get(teamId);
  if (!team) return `❌ Team "${teamId}" not found.`;

  // Collect summary
  const taskSummary = getTeamSummary(teamId);

  const lines = [
    `**Team ${teamId} dissolved.**`,
    '',
    `Task: ${team.taskDescription}`,
    `Duration: ${((Date.now() - new Date(team.created_at).getTime()) / 1000 / 60).toFixed(1)} minutes`,
    '',
    '**Teammate Results:**',
  ];

  for (const [, tm] of team.teammates) {
    lines.push(`- ${tm.name}: ${tm.status}`);
    if (tm.result) lines.push(`  ${tm.result.slice(0, 200)}`);
    if (tm.error) lines.push(`  Error: ${tm.error}`);
  }

  lines.push('', taskSummary);

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
  }>;
  taskCount: number;
  doneCount: number;
  activeCount: number;
  worktreeIsolation?: boolean;  // Phase 8.39: whether worktrees are enabled
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
      return {
        name: tm.name,
        role: tm.role,
        status: tm.status,
        currentTask: currentTask?.title,
        worktreeBranch: tm.worktreeBranch,
        worktreePath: tm.worktreePath,
      };
    }),
    taskCount: tasks.length,
    doneCount: done,
    activeCount: active,
    worktreeIsolation: team.worktreeIsolation,
  };
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

  return `You are ${name}, a member of a coding team (team ID: ${teamId}).

Your role: ${role}
${cwdSection}
## Team Collaboration Rules
1. Check your inbox before starting work — teammates may have sent relevant info.
2. Update the task list when you start/finish tasks using team_task_update.
3. When you touch files, log them with files_touched so conflicts are detected.
4. If you need info from another teammate, send them a message with team_message.
5. If you're blocked, update the task status to "blocked" with a clear reason.
6. Be specific in your result summaries — the lead synthesizes everything.

## Current Task List
${taskList}

## Coding Standards
- Preserve existing code style and conventions.
- Write clean, documented code.
- Report what files you modified and what tests you ran.
- If you discover new tasks needed, add them with team_task_add.

## Tools Available
You have full access to: page tools, browser tools (you can browse docs!), HTTP tools, file tools, and shell tools.
Use them freely — especially: browse docs, read files, run tests, check build output.

The page is a black box — use elements/text tools to see it.
Be efficient: grep before reading entire files.
`;
}
