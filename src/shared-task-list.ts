/**
 * shared-task-list.ts — Shared task registry for agent teams (Phase 8.38).
 *
 * All agents in a team share a single task list. Tasks have states, dependencies,
 * and file conflict detection. Persisted to ~/tappi-workspace/teams/<team-id>/tasks.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type TaskStatus = 'pending' | 'in-progress' | 'done' | 'blocked';

export interface SharedTask {
  id: string;
  title: string;
  description: string;
  assignee?: string;              // teammate name, e.g. "@backend"
  status: TaskStatus;
  dependencies: string[];         // task IDs that must complete first
  blockedBy?: string;             // human-readable block reason
  result?: string;                // completion summary
  files_touched: string[];        // files this task modified
  created_by: string;             // "@lead" or "@backend" etc.
  created_at: string;
  updated_at: string;
}

export interface FileConflict {
  file: string;
  taskIds: string[];
  taskTitles: string[];
}

const WORKSPACE_DIR = path.join(os.homedir(), 'tappi-workspace', 'teams');

// In-memory task lists per team
const teamTaskLists = new Map<string, SharedTask[]>();

let taskCounter = 0;

// ─── Init ───

export function initTaskList(teamId: string): void {
  if (!teamTaskLists.has(teamId)) {
    // Try to load from disk
    const saved = loadFromDisk(teamId);
    teamTaskLists.set(teamId, saved || []);
  }
}

// ─── Create ───

export function createTask(
  teamId: string,
  params: {
    title: string;
    description: string;
    assignee?: string;
    dependencies?: string[];
    created_by: string;
  }
): SharedTask {
  const tasks = getTaskList(teamId);
  const task: SharedTask = {
    id: `task-${++taskCounter}`,
    title: params.title,
    description: params.description,
    assignee: params.assignee,
    status: 'pending',
    dependencies: params.dependencies || [],
    files_touched: [],
    created_by: params.created_by,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Check if blocked by deps
  if (task.dependencies.length > 0) {
    const unmet = task.dependencies.filter(depId => {
      const dep = tasks.find(t => t.id === depId);
      return dep && dep.status !== 'done';
    });
    if (unmet.length > 0) {
      task.status = 'blocked';
      task.blockedBy = `Waiting for: ${unmet.join(', ')}`;
    }
  }

  tasks.push(task);
  persist(teamId, tasks);
  return task;
}

// ─── Read ───

export function getTaskList(teamId: string): SharedTask[] {
  if (!teamTaskLists.has(teamId)) {
    initTaskList(teamId);
  }
  return teamTaskLists.get(teamId) || [];
}

export function getTask(teamId: string, taskId: string): SharedTask | undefined {
  return getTaskList(teamId).find(t => t.id === taskId);
}

// ─── Update ───

export function claimTask(teamId: string, taskId: string, agentName: string): string {
  const tasks = getTaskList(teamId);
  const task = tasks.find(t => t.id === taskId);
  if (!task) return `❌ Task "${taskId}" not found.`;
  if (task.status === 'done') return `❌ Task "${taskId}" is already done.`;
  if (task.status === 'blocked') return `❌ Task "${taskId}" is blocked: ${task.blockedBy}`;
  if (task.status === 'in-progress' && task.assignee && task.assignee !== agentName) {
    return `❌ Task "${taskId}" is already claimed by ${task.assignee}.`;
  }

  task.assignee = agentName;
  task.status = 'in-progress';
  task.updated_at = new Date().toISOString();
  persist(teamId, tasks);
  return `✓ Claimed task "${task.title}".`;
}

export function updateTask(
  teamId: string,
  taskId: string,
  updates: {
    status?: TaskStatus;
    result?: string;
    files_touched?: string[];
    blockedBy?: string;
    assignee?: string;
  }
): { message: string; conflicts: FileConflict[] } {
  const tasks = getTaskList(teamId);
  const task = tasks.find(t => t.id === taskId);
  if (!task) return { message: `❌ Task "${taskId}" not found.`, conflicts: [] };

  if (updates.status !== undefined) task.status = updates.status;
  if (updates.result !== undefined) task.result = updates.result;
  if (updates.assignee !== undefined) task.assignee = updates.assignee;
  if (updates.blockedBy !== undefined) task.blockedBy = updates.blockedBy;
  if (updates.files_touched !== undefined) {
    task.files_touched = updates.files_touched;
  }
  task.updated_at = new Date().toISOString();

  // Auto-unblock tasks that were waiting on this one (if it's now done)
  let unblocked: string[] = [];
  if (task.status === 'done') {
    for (const other of tasks) {
      if (other.status === 'blocked' && other.dependencies.includes(taskId)) {
        // Check if all deps are now done
        const unmetDeps = other.dependencies.filter(depId => {
          const dep = tasks.find(t => t.id === depId);
          return dep && dep.status !== 'done';
        });
        if (unmetDeps.length === 0) {
          other.status = 'pending';
          other.blockedBy = undefined;
          other.updated_at = new Date().toISOString();
          unblocked.push(other.title);
        }
      }
    }
  }

  persist(teamId, tasks);

  // Detect file conflicts
  const conflicts = detectFileConflicts(tasks);

  let message = `✓ Task "${task.title}" updated to ${task.status}.`;
  if (unblocked.length > 0) {
    message += ` Unblocked: ${unblocked.join(', ')}.`;
  }

  return { message, conflicts };
}

// ─── File Conflict Detection ───

export function detectFileConflicts(tasks: SharedTask[]): FileConflict[] {
  const fileMap = new Map<string, { taskId: string; taskTitle: string }[]>();

  for (const task of tasks) {
    if (task.status === 'done') continue; // Only check active tasks
    for (const file of task.files_touched) {
      if (!fileMap.has(file)) fileMap.set(file, []);
      fileMap.get(file)!.push({ taskId: task.id, taskTitle: task.title });
    }
  }

  const conflicts: FileConflict[] = [];
  for (const [file, taskRefs] of fileMap) {
    if (taskRefs.length > 1) {
      conflicts.push({
        file,
        taskIds: taskRefs.map(r => r.taskId),
        taskTitles: taskRefs.map(r => r.taskTitle),
      });
    }
  }

  return conflicts;
}

// ─── Format for Context ───

export function formatTaskListForContext(teamId: string): string {
  const tasks = getTaskList(teamId);
  if (tasks.length === 0) return '(No tasks yet)';

  const statusEmoji: Record<TaskStatus, string> = {
    'pending': '⏳',
    'in-progress': '🔄',
    'done': '✅',
    'blocked': '🚫',
  };

  const lines = tasks.map(t => {
    const emoji = statusEmoji[t.status];
    const assignee = t.assignee ? ` [${t.assignee}]` : '';
    const blocked = t.status === 'blocked' && t.blockedBy ? ` — ${t.blockedBy}` : '';
    return `${emoji} [${t.id}] ${t.title}${assignee}${blocked}`;
  });

  return lines.join('\n');
}

export function formatTaskListCompact(tasks: SharedTask[]): string {
  if (tasks.length === 0) return '(No tasks)';
  const statusEmoji: Record<TaskStatus, string> = {
    'pending': '⏳', 'in-progress': '🔄', 'done': '✅', 'blocked': '🚫',
  };
  return tasks.map(t => `${statusEmoji[t.status]} ${t.title}`).join('\n');
}

// ─── Persistence ───

function getTeamDir(teamId: string): string {
  return path.join(WORKSPACE_DIR, teamId);
}

function getTasksPath(teamId: string): string {
  return path.join(getTeamDir(teamId), 'tasks.json');
}

function persist(teamId: string, tasks: SharedTask[]): void {
  try {
    const dir = getTeamDir(teamId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getTasksPath(teamId), JSON.stringify(tasks, null, 2));
  } catch (e: any) {
    console.error('[shared-task-list] persist failed:', e?.message);
  }
}

function loadFromDisk(teamId: string): SharedTask[] | null {
  try {
    const p = getTasksPath(teamId);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  } catch {}
  return null;
}

// ─── Cleanup ───

export function cleanupTeamTaskList(teamId: string): void {
  teamTaskLists.delete(teamId);
}

// ─── Summary for Dissolve ───

export function getTeamSummary(teamId: string): string {
  const tasks = getTaskList(teamId);
  const done = tasks.filter(t => t.status === 'done');
  const blocked = tasks.filter(t => t.status === 'blocked');
  const pending = tasks.filter(t => t.status === 'pending' || t.status === 'in-progress');

  const lines = [
    `Tasks: ${tasks.length} total, ${done.length} done, ${blocked.length} blocked, ${pending.length} pending/in-progress`,
    '',
    '**Completed tasks:**',
    ...done.map(t => `✅ ${t.title}${t.result ? ': ' + t.result.slice(0, 100) : ''}`),
  ];

  if (blocked.length > 0) {
    lines.push('', '**Blocked tasks:**');
    lines.push(...blocked.map(t => `🚫 ${t.title}: ${t.blockedBy || 'unknown reason'}`));
  }

  return lines.join('\n');
}
