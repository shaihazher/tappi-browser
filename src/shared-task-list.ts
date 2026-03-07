/**
 * shared-task-list.ts — Shared task registry for agent teams.
 *
 * All agents in a team share a single task list. Tasks have states, bidirectional
 * dependency graph (blocks/blockedBy), owner assignment, and file conflict detection.
 * Persisted to <workspace>/teams/<team-id>/tasks.json.
 *
 * Status naming aligned with Claude Code: pending | in_progress | completed | deleted.
 * "Blocked" is computed — a task is blocked if its blockedBy[] contains non-completed tasks.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getWorkspacePath } from './workspace-resolver';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

export interface SharedTask {
  id: string;
  title: string;
  description: string;
  owner?: string;                   // teammate name, e.g. "@backend"
  status: TaskStatus;
  blockedBy: string[];              // task IDs that must complete first
  blocks: string[];                 // task IDs this task blocks (inverse)
  result?: string;                  // completion summary
  files_touched: string[];          // files this task modified
  metadata?: Record<string, any>;   // arbitrary metadata
  created_by: string;               // "@lead" or "@backend" etc.
  created_at: string;
  updated_at: string;
}

export interface FileConflict {
  file: string;
  taskIds: string[];
  taskTitles: string[];
}

// Get teams directory from configured workspace
function getTeamsDir(): string {
  return path.join(getWorkspacePath(), 'teams');
}

// In-memory task lists per team
const teamTaskLists = new Map<string, SharedTask[]>();

let taskCounter = 0;

// ─── Init ───

export function initTaskList(teamId: string): void {
  if (!teamTaskLists.has(teamId)) {
    const saved = loadFromDisk(teamId);
    teamTaskLists.set(teamId, saved || []);
    // Restore counter from loaded tasks
    if (saved) {
      for (const t of saved) {
        const num = parseInt(t.id.replace('task-', ''), 10);
        if (num > taskCounter) taskCounter = num;
      }
    }
  }
}

// ─── Create ───

export function createTask(
  teamId: string,
  params: {
    title: string;
    description: string;
    owner?: string;
    blockedBy?: string[];
    metadata?: Record<string, any>;
    created_by: string;
  }
): SharedTask {
  const tasks = getTaskList(teamId);
  const task: SharedTask = {
    id: `task-${++taskCounter}`,
    title: params.title,
    description: params.description,
    owner: params.owner,
    status: 'pending',
    blockedBy: params.blockedBy || [],
    blocks: [],
    files_touched: [],
    metadata: params.metadata,
    created_by: params.created_by,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Wire up inverse dependency: if this task is blockedBy X, then X blocks this task
  for (const depId of task.blockedBy) {
    const dep = tasks.find(t => t.id === depId);
    if (dep && !dep.blocks.includes(task.id)) {
      dep.blocks.push(task.id);
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

/**
 * Check if a task is blocked (has non-completed blockedBy dependencies).
 */
export function isTaskBlocked(teamId: string, taskId: string): boolean {
  const tasks = getTaskList(teamId);
  const task = tasks.find(t => t.id === taskId);
  if (!task || task.blockedBy.length === 0) return false;
  return task.blockedBy.some(depId => {
    const dep = tasks.find(t => t.id === depId);
    return dep && dep.status !== 'completed';
  });
}

/**
 * Get the unmet blockers for a task.
 */
export function getUnmetBlockers(teamId: string, taskId: string): string[] {
  const tasks = getTaskList(teamId);
  const task = tasks.find(t => t.id === taskId);
  if (!task) return [];
  return task.blockedBy.filter(depId => {
    const dep = tasks.find(t => t.id === depId);
    return dep && dep.status !== 'completed';
  });
}

// ─── Update ───

export function updateTask(
  teamId: string,
  taskId: string,
  updates: {
    status?: TaskStatus;
    owner?: string;
    result?: string;
    files_touched?: string[];
    title?: string;
    description?: string;
    metadata?: Record<string, any>;
    addBlocks?: string[];
    addBlockedBy?: string[];
  }
): { message: string; conflicts: FileConflict[] } {
  const tasks = getTaskList(teamId);
  const task = tasks.find(t => t.id === taskId);
  if (!task) return { message: `Task "${taskId}" not found.`, conflicts: [] };

  if (updates.status !== undefined) task.status = updates.status;
  if (updates.owner !== undefined) task.owner = updates.owner;
  if (updates.result !== undefined) task.result = updates.result;
  if (updates.title !== undefined) task.title = updates.title;
  if (updates.description !== undefined) task.description = updates.description;
  if (updates.files_touched !== undefined) task.files_touched = updates.files_touched;
  if (updates.metadata !== undefined) {
    task.metadata = { ...(task.metadata || {}), ...updates.metadata };
    // Allow null values to delete keys
    for (const [k, v] of Object.entries(task.metadata!)) {
      if (v === null) delete task.metadata![k];
    }
  }

  // Add new blocks
  if (updates.addBlocks) {
    for (const targetId of updates.addBlocks) {
      if (!task.blocks.includes(targetId)) {
        task.blocks.push(targetId);
      }
      // Wire inverse: target is now blockedBy this task
      const target = tasks.find(t => t.id === targetId);
      if (target && !target.blockedBy.includes(taskId)) {
        target.blockedBy.push(taskId);
      }
    }
  }

  // Add new blockedBy
  if (updates.addBlockedBy) {
    for (const depId of updates.addBlockedBy) {
      if (!task.blockedBy.includes(depId)) {
        task.blockedBy.push(depId);
      }
      // Wire inverse: dep now blocks this task
      const dep = tasks.find(t => t.id === depId);
      if (dep && !dep.blocks.includes(taskId)) {
        dep.blocks.push(taskId);
      }
    }
  }

  task.updated_at = new Date().toISOString();

  // Auto-unblock: when a task is completed, check tasks it blocks
  const unblocked: string[] = [];
  if (task.status === 'completed') {
    for (const blockedId of task.blocks) {
      const blocked = tasks.find(t => t.id === blockedId);
      if (!blocked) continue;
      // Check if all of blocked's blockedBy are now completed
      const stillBlocked = blocked.blockedBy.some(bId => {
        const b = tasks.find(t => t.id === bId);
        return b && b.status !== 'completed';
      });
      if (!stillBlocked) {
        unblocked.push(blocked.title);
      }
    }
  }

  // Handle deleted status — remove from dependency graph
  if (task.status === 'deleted') {
    // Remove this task from other tasks' blockedBy
    for (const blockedId of task.blocks) {
      const blocked = tasks.find(t => t.id === blockedId);
      if (blocked) {
        blocked.blockedBy = blocked.blockedBy.filter(id => id !== taskId);
      }
    }
    // Remove this task from other tasks' blocks
    for (const depId of task.blockedBy) {
      const dep = tasks.find(t => t.id === depId);
      if (dep) {
        dep.blocks = dep.blocks.filter(id => id !== taskId);
      }
    }
  }

  persist(teamId, tasks);

  const conflicts = detectFileConflicts(tasks);

  let message = `Task "${task.title}" updated to ${task.status}.`;
  if (unblocked.length > 0) {
    message += ` Unblocked: ${unblocked.join(', ')}.`;
  }

  return { message, conflicts };
}

// ─── File Conflict Detection ───

export function detectFileConflicts(tasks: SharedTask[]): FileConflict[] {
  const fileMap = new Map<string, { taskId: string; taskTitle: string }[]>();

  for (const task of tasks) {
    if (task.status === 'completed' || task.status === 'deleted') continue;
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
  const tasks = getTaskList(teamId).filter(t => t.status !== 'deleted');
  if (tasks.length === 0) return '(No tasks yet)';

  const statusEmoji: Record<TaskStatus, string> = {
    'pending': '⏳',
    'in_progress': '🔄',
    'completed': '✅',
    'deleted': '🗑️',
  };

  const lines = tasks.map(t => {
    const emoji = statusEmoji[t.status];
    const owner = t.owner ? ` [${t.owner}]` : '';
    const blocked = isTaskBlocked(teamId, t.id);
    const blockedStr = blocked ? ` — blocked by: ${getUnmetBlockers(teamId, t.id).join(', ')}` : '';
    return `${emoji} [${t.id}] ${t.title}${owner}${blockedStr}`;
  });

  return lines.join('\n');
}

export function formatTaskListCompact(tasks: SharedTask[]): string {
  if (tasks.length === 0) return '(No tasks)';
  const statusEmoji: Record<TaskStatus, string> = {
    'pending': '⏳', 'in_progress': '🔄', 'completed': '✅', 'deleted': '🗑️',
  };
  return tasks.filter(t => t.status !== 'deleted')
    .map(t => `${statusEmoji[t.status]} ${t.title}`)
    .join('\n');
}

// ─── Persistence ───

function getTeamDir(teamId: string): string {
  return path.join(getTeamsDir(), teamId);
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

// ─── Summary ───

export function getTeamSummary(teamId: string): string {
  const tasks = getTaskList(teamId).filter(t => t.status !== 'deleted');
  const completed = tasks.filter(t => t.status === 'completed');
  const blocked = tasks.filter(t => isTaskBlocked(teamId, t.id));
  const active = tasks.filter(t => t.status === 'pending' || t.status === 'in_progress');

  const lines = [
    `Tasks: ${tasks.length} total, ${completed.length} completed, ${blocked.length} blocked, ${active.length} pending/in-progress`,
    '',
    '**Completed tasks:**',
    ...completed.map(t => `✅ ${t.title}${t.result ? ': ' + t.result.slice(0, 100) : ''}`),
  ];

  if (blocked.length > 0) {
    lines.push('', '**Blocked tasks:**');
    lines.push(...blocked.map(t => `🚫 ${t.title}: blocked by ${getUnmetBlockers(teamId, t.id).join(', ')}`));
  }

  return lines.join('\n');
}
