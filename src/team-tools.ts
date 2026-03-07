/**
 * team-tools.ts — Claude Code-style agent team tools for Vercel AI SDK.
 *
 * Provides SendMessage, TaskCreate, TaskGet, TaskList, TaskUpdate, TeamCreate,
 * TeamDelete, and SpawnTeammate tools matching Claude Code's agent teams pattern.
 *
 * Tools are created via factory functions that receive team/agent context.
 */

import { tool } from 'ai';
import { z } from 'zod';
import * as mailbox from './mailbox';
import * as taskList from './shared-task-list';
import * as teamManager from './team-manager';
import type { BrowserContext } from './browser-tools';
import type { LLMConfig } from './llm-client';

export interface TeamToolsContext {
  teamId?: string;
  agentName?: string;  // e.g. "@backend", "@lead"
  browserCtx: BrowserContext;
  llmConfig?: LLMConfig;
  sessionId: string;
  conversationId?: string;
}

/**
 * Resolve team ID — checks provided value, then context, then active team.
 */
function resolveTeamId(ctx: TeamToolsContext): string | null {
  return ctx.teamId || teamManager.getActiveTeamId();
}

/**
 * Broadcast team status update to chrome and Aria UI.
 */
function broadcastTeamUpdate(ctx: TeamToolsContext): void {
  try {
    const status = teamManager.getTeamStatusUI();
    try { ctx.browserCtx.window.webContents.send('team:updated', status); } catch {}
    try {
      const aw = (ctx.browserCtx.tabManager as any).ariaWebContents;
      if (aw && !aw.isDestroyed()) aw.send('team:updated', status);
    } catch {}
  } catch {}
}

// ─── Tools Available to All Agents (Lead + Teammates) ───

/**
 * SendMessage — Send messages to teammates with support for DM, broadcast,
 * shutdown requests/responses. Replaces old team_message.
 */
export function createSendMessageTool(ctx: TeamToolsContext) {
  return tool({
    description: `Send a message to a teammate or broadcast to all. Message types:
- "message": Direct message to one teammate (default)
- "broadcast": Send to ALL teammates (use sparingly — expensive)
- "shutdown_request": Ask a teammate to gracefully shut down
- "shutdown_response": Respond to a shutdown request (approve or reject)
Messages are delivered between turns — recipient wakes up when idle.`,
    inputSchema: z.object({
      type: z.enum(['message', 'broadcast', 'shutdown_request', 'shutdown_response'])
        .default('message')
        .describe('Message type'),
      recipient: z.string().optional()
        .describe('Teammate name for DM/shutdown (e.g. "@backend"). Required for message/shutdown_request.'),
      content: z.string()
        .describe('Message text'),
      summary: z.string().optional()
        .describe('5-10 word summary shown as preview in the UI'),
      approve: z.boolean().optional()
        .describe('For shutdown_response: true to accept shutdown, false to reject'),
    }),
    execute: async ({ type, recipient, content, summary, approve }: {
      type: 'message' | 'broadcast' | 'shutdown_request' | 'shutdown_response';
      recipient?: string;
      content: string;
      summary?: string;
      approve?: boolean;
    }) => {
      const tid = resolveTeamId(ctx);
      if (!tid) return 'No active team.';
      const from = ctx.agentName || '@lead';

      switch (type) {
        case 'message': {
          if (!recipient) return 'Recipient required for direct messages.';
          return mailbox.sendMessage(tid, from, recipient, content, { type: 'message', summary });
        }
        case 'broadcast': {
          return mailbox.sendMessage(tid, from, '@all', content, { type: 'broadcast', summary });
        }
        case 'shutdown_request': {
          if (!recipient) return 'Recipient required for shutdown_request.';
          const team = teamManager.getTeam(tid);
          if (!team) return `Team "${tid}" not found.`;
          const teammate = team.teammates.get(recipient);
          if (!teammate) return `Teammate "${recipient}" not found.`;
          teammate._shutdownRequested = true;
          return mailbox.sendMessage(tid, from, recipient,
            `[SHUTDOWN REQUEST]: ${content}`,
            { type: 'shutdown_request', summary: summary || 'Shutdown requested' });
        }
        case 'shutdown_response': {
          const team = teamManager.getTeam(tid);
          if (!team) return `Team "${tid}" not found.`;
          const me = team.teammates.get(from);
          if (me) {
            me._shutdownAcknowledged = approve !== false;
          }
          const msg = approve !== false
            ? `[SHUTDOWN ACKNOWLEDGED]: ${content}`
            : `[SHUTDOWN REJECTED]: ${content}`;
          return mailbox.sendMessage(tid, from, '@lead', msg,
            { type: 'shutdown_response', summary: summary || (approve !== false ? 'Shutdown accepted' : 'Shutdown rejected') });
        }
        default:
          return `Unknown message type: ${type}`;
      }
    },
  });
}

/**
 * TaskCreate — Create a new task in the team's shared task list.
 */
export function createTaskCreateTool(ctx: TeamToolsContext) {
  return tool({
    description: `Create a new task in the team's shared task list. Tasks can have owners, dependencies (blockedBy), and metadata. Use to break down work and assign to teammates.`,
    inputSchema: z.object({
      subject: z.string().describe('Brief, actionable task title'),
      description: z.string().describe('Detailed description of what needs to be done'),
      owner: z.string().optional().describe('Teammate to assign (e.g. "@backend")'),
      blockedBy: z.array(z.string()).optional().describe('Task IDs that must complete first'),
      metadata: z.record(z.string(), z.any()).optional().describe('Arbitrary metadata to attach'),
    }),
    execute: async ({ subject, description, owner, blockedBy, metadata }: {
      subject: string; description: string; owner?: string; blockedBy?: string[];
      metadata?: Record<string, any>;
    }) => {
      const tid = resolveTeamId(ctx);
      if (!tid) return 'No active team.';
      const from = ctx.agentName || '@lead';
      const task = taskList.createTask(tid, {
        title: subject,
        description,
        owner,
        blockedBy,
        metadata,
        created_by: from,
      });
      broadcastTeamUpdate(ctx);
      return `Task "${task.id}" created: ${task.title} (status: ${task.status}${task.owner ? `, owner: ${task.owner}` : ''})`;
    },
  });
}

/**
 * TaskGet — Get full details of a specific task.
 */
export function createTaskGetTool(ctx: TeamToolsContext) {
  return tool({
    description: `Get full details of a task by ID. Returns title, description, status, owner, dependencies, and result.`,
    inputSchema: z.object({
      taskId: z.string().describe('Task ID (e.g. "task-1")'),
    }),
    execute: async ({ taskId }: { taskId: string }) => {
      const tid = resolveTeamId(ctx);
      if (!tid) return 'No active team.';
      const task = taskList.getTask(tid, taskId);
      if (!task) return `Task "${taskId}" not found.`;

      const blocked = taskList.isTaskBlocked(tid, taskId);
      const unblockers = blocked ? taskList.getUnmetBlockers(tid, taskId) : [];

      const lines = [
        `**${task.title}** [${task.id}]`,
        `Status: ${task.status}${blocked ? ' (BLOCKED)' : ''}`,
        task.owner ? `Owner: ${task.owner}` : 'Owner: unassigned',
        `Description: ${task.description}`,
      ];

      if (task.blockedBy.length > 0) {
        lines.push(`Blocked by: ${task.blockedBy.join(', ')}${unblockers.length > 0 ? ` (unmet: ${unblockers.join(', ')})` : ' (all resolved)'}`);
      }
      if (task.blocks.length > 0) {
        lines.push(`Blocks: ${task.blocks.join(', ')}`);
      }
      if (task.result) {
        lines.push(`Result: ${task.result}`);
      }
      if (task.files_touched.length > 0) {
        lines.push(`Files: ${task.files_touched.join(', ')}`);
      }

      return lines.join('\n');
    },
  });
}

/**
 * TaskList — List all tasks in the team's shared task list.
 */
export function createTaskListTool(ctx: TeamToolsContext) {
  return tool({
    description: `List all tasks in the team's task list. Shows ID, title, status, owner, and blocked status. Use to find available work or check progress.`,
    inputSchema: z.object({}),
    execute: async () => {
      const tid = resolveTeamId(ctx);
      if (!tid) return 'No active team.';
      return taskList.formatTaskListForContext(tid);
    },
  });
}

/**
 * TaskUpdate — Update a task's status, owner, result, files, or dependencies.
 */
export function createTaskUpdateTool(ctx: TeamToolsContext) {
  return tool({
    description: `Update a task in the team's task list. Use to mark tasks in_progress/completed, set owner, add results, track files modified, or set up dependencies.`,
    inputSchema: z.object({
      taskId: z.string().describe('Task ID (e.g. "task-1")'),
      status: z.enum(['pending', 'in_progress', 'completed', 'deleted']).optional()
        .describe('New status'),
      owner: z.string().optional().describe('New owner (teammate name)'),
      subject: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      result: z.string().optional().describe('Completion summary'),
      files_touched: z.array(z.string()).optional().describe('Files modified by this task'),
      addBlocks: z.array(z.string()).optional().describe('Task IDs that cannot start until this completes'),
      addBlockedBy: z.array(z.string()).optional().describe('Task IDs that must complete before this can start'),
      metadata: z.record(z.string(), z.any()).optional().describe('Metadata to merge (set key to null to delete)'),
    }),
    execute: async ({ taskId, status, owner, subject, description, result, files_touched, addBlocks, addBlockedBy, metadata }: {
      taskId: string; status?: any; owner?: string; subject?: string;
      description?: string; result?: string; files_touched?: string[];
      addBlocks?: string[]; addBlockedBy?: string[];
      metadata?: Record<string, any>;
    }) => {
      const tid = resolveTeamId(ctx);
      if (!tid) return 'No active team.';
      const { message, conflicts } = taskList.updateTask(tid, taskId, {
        status,
        owner,
        title: subject,
        description,
        result,
        files_touched,
        addBlocks,
        addBlockedBy,
        metadata,
      });
      broadcastTeamUpdate(ctx);
      if (conflicts.length > 0) {
        const conflictLines = conflicts.map(c =>
          `File conflict: ${c.file} touched by ${c.taskTitles.join(' and ')}`
        ).join('\n');
        return `${message}\n\n${conflictLines}`;
      }
      return message;
    },
  });
}

/**
 * TeamStatus — Get team overview with teammates, task list, messages.
 */
export function createTeamStatusTool(ctx: TeamToolsContext) {
  return tool({
    description: `Get team overview: teammate statuses (idle/working/done), task list progress, and file conflicts.`,
    inputSchema: z.object({}),
    execute: async () => {
      const tid = resolveTeamId(ctx);
      if (!tid) return 'No active team.';
      return teamManager.getTeamStatus(tid);
    },
  });
}

// ─── Lead-Only Tools ───

/**
 * TeamCreate — Create a new team for parallel agent work.
 */
export function createTeamCreateTool(ctx: TeamToolsContext) {
  return tool({
    description: `Create a team for parallel multi-agent work. Defines teammates with roles. Each teammate gets a dedicated browser tab and optional git worktree isolation. After creating, add tasks with TaskCreate, then spawn teammates with SpawnTeammate.`,
    inputSchema: z.object({
      team_name: z.string().describe('Name for the team (e.g. "api-build")'),
      task: z.string().describe('High-level task description'),
      working_dir: z.string().describe('Project root directory'),
      teammates: z.array(z.object({
        name: z.string().describe('Agent name starting with @ (e.g. "@backend")'),
        role: z.string().describe('Role description'),
        model: z.string().optional().describe('Optional: different model for this teammate'),
      })).optional().describe('Teammate configs. If omitted, auto-determined from task.'),
      worktree_isolation: z.boolean().optional()
        .describe('Give each teammate an isolated git worktree (default: true for git repos)'),
    }),
    execute: async ({ team_name, task, working_dir, teammates, worktree_isolation }: {
      team_name: string; task: string; working_dir: string;
      teammates?: Array<{ name: string; role: string; model?: string }>;
      worktree_isolation?: boolean;
    }) => {
      if (!ctx.llmConfig) return 'No LLM config available.';
      const useWorktrees = worktree_isolation ?? true;
      const aw = (ctx.browserCtx.tabManager as any).ariaWebContents ?? null;
      const { teamId, summary } = await teamManager.createTeam(
        task, working_dir, ctx.browserCtx, ctx.llmConfig, teammates, useWorktrees, aw,
        ctx.conversationId,
      );
      broadcastTeamUpdate(ctx);
      return summary;
    },
  });
}

/**
 * TeamDelete — Remove a team and clean up resources.
 */
export function createTeamDeleteTool(ctx: TeamToolsContext) {
  return tool({
    description: `Remove team and clean up resources (task list, mailboxes, worktrees). If teammates are still active, automatically sends shutdown requests, waits up to 15 seconds for graceful shutdown, then force-terminates remaining teammates.`,
    inputSchema: z.object({
      force: z.boolean().optional().describe('Force immediate termination of all active teammates (default: true — auto-shutdown with grace period)'),
    }),
    execute: async ({ force }: { force?: boolean }) => {
      const tid = resolveTeamId(ctx);
      if (!tid) return 'No active team.';
      const team = teamManager.getTeam(tid);
      if (!team) {
        teamManager.dissolveTeam(tid);
        return `Team "${tid}" deleted.`;
      }

      const active = Array.from(team.teammates.values()).filter(t =>
        t.status === 'working' || t.status === 'idle'
      );

      if (active.length > 0) {
        // Send shutdown requests to all active teammates
        for (const tm of active) {
          if (!tm._shutdownRequested) {
            tm._shutdownRequested = true;
            mailbox.sendMessage(tid, '@lead', tm.name,
              '[SHUTDOWN REQUEST]: Team is being dissolved. Wrap up immediately.',
              { type: 'shutdown_request', summary: 'Team dissolving' });
          }
        }

        if (force === false) {
          // Non-force: just send shutdown requests and return
          return `Shutdown requests sent to ${active.length} teammate(s): ${active.map(t => t.name).join(', ')}. Call team_delete again after they finish, or use force mode.`;
        }

        // Grace period: wait up to 15 seconds for teammates to finish
        const graceStart = Date.now();
        const GRACE_MS = 15_000;
        while (Date.now() - graceStart < GRACE_MS) {
          const stillActive = Array.from(team.teammates.values()).filter(t =>
            t.status === 'working' || t.status === 'idle'
          );
          if (stillActive.length === 0) break;
          await new Promise(r => setTimeout(r, 2000));
        }

        // Force-terminate any remaining active teammates
        const remaining = Array.from(team.teammates.values()).filter(t =>
          t.status === 'working' || t.status === 'idle'
        );
        for (const tm of remaining) {
          console.log(`[team_delete] Force-terminating ${tm.name}`);
          tm.abortController?.abort();
          mailbox.cancelWaiter(tid, tm.name);
          tm.status = 'done';
          tm.result = (tm.result || '') + '\n(Force-terminated during team deletion)';
          tm.finishedAt = Date.now();
        }
      }

      const result = await teamManager.dissolveTeam(tid);
      broadcastTeamUpdate(ctx);
      return result;
    },
  });
}

/**
 * SpawnTeammate — Start a teammate's turn-based session with a task.
 */
export function createSpawnTeammateTool(ctx: TeamToolsContext) {
  return tool({
    description: `Spawn a teammate and start their turn-based session. Each teammate gets a dedicated browser tab and runs in an idle/wake loop — they work, go idle, and wake up when messages arrive. Monitor with TeamStatus. Send guidance with SendMessage.`,
    inputSchema: z.object({
      teammate_name: z.string().describe('Teammate name (e.g. "@backend")'),
      task: z.string().describe('Initial task for this teammate'),
    }),
    execute: async ({ teammate_name, task }: { teammate_name: string; task: string }) => {
      const tid = resolveTeamId(ctx);
      if (!tid) return 'No active team.';
      if (!ctx.llmConfig) return 'No LLM config available.';
      const team = teamManager.getTeam(tid);
      if (!team) return `Team "${tid}" not found.`;
      const teammate = team.teammates.get(teammate_name);
      if (!teammate) {
        const available = Array.from(team.teammates.keys()).join(', ');
        return `Teammate "${teammate_name}" not found. Available: ${available || '(none)'}.`;
      }
      const aw = (ctx.browserCtx.tabManager as any).ariaWebContents ?? null;
      const result = await teamManager.runTeammate({
        teammate, teamId: tid, task, browserCtx: ctx.browserCtx,
        llmConfig: ctx.llmConfig, ariaWebContents: aw,
      });
      broadcastTeamUpdate(ctx);
      return result;
    },
  });
}

/**
 * WriteContracts — Write shared interface contracts for teammates.
 */
export function createWriteContractsTool(ctx: TeamToolsContext) {
  return tool({
    description: `Write shared contracts/interfaces that all teammates must follow. Call BEFORE spawning teammates. Contracts define the shared API surface: type definitions, interfaces, function signatures.`,
    inputSchema: z.object({
      path: z.string().describe('Relative path from working dir (e.g. "contracts/types.ts")'),
      content: z.string().describe('Contract content — type defs, interfaces, function stubs'),
      description: z.string().describe('What this contract defines'),
    }),
    execute: async ({ path: filePath, content, description }: {
      path: string; content: string; description: string;
    }) => {
      const tid = resolveTeamId(ctx);
      if (!tid) return 'No active team.';
      const result = teamManager.writeContract(tid, filePath, content, description);
      broadcastTeamUpdate(ctx);
      return result;
    },
  });
}

/**
 * ValidateIntegration — Run build/test validation after teammates finish.
 */
export function createValidateIntegrationTool(ctx: TeamToolsContext) {
  return tool({
    description: `Run integration validation after teammates finish. Checks contracts, file conflicts, and runs build/test command.`,
    inputSchema: z.object({
      command: z.string().optional().describe('Build/test command (e.g. "npm run build")'),
    }),
    execute: async ({ command }: { command?: string }) => {
      const tid = resolveTeamId(ctx);
      if (!tid) return 'No active team.';
      const team = teamManager.getTeam(tid);
      if (team) {
        const doneTeammates = Array.from(team.teammates.values()).filter(t => t.status === 'done');
        if (doneTeammates.length === 0) {
          const states = Array.from(team.teammates.values()).map(t => `${t.name}: ${t.status}`).join(', ');
          return `No completed work to validate yet. Current states: ${states || '(no teammates)'}.`;
        }
      }
      return teamManager.validateIntegration(tid, command);
    },
  });
}

/**
 * WaitForTeam — Block until all teammates have finished or timeout.
 * This keeps the main agent's streamText call alive while teammates work.
 */
export function createWaitForTeamTool(ctx: TeamToolsContext) {
  return tool({
    description: `Block and wait until all teammates have finished (status: done/failed) or timeout. Use this AFTER spawning teammates to wait for their completion. The tool polls every 5 seconds and returns the final team status when all teammates are done. IMPORTANT: Always call this after spawning teammates — do not return without waiting for them.`,
    inputSchema: z.object({
      timeout_seconds: z.number().optional().describe('Max seconds to wait (default: 600 = 10 min). Set higher for complex tasks.'),
    }),
    execute: async ({ timeout_seconds }: { timeout_seconds?: number }) => {
      const tid = resolveTeamId(ctx);
      if (!tid) return 'No active team.';
      const team = teamManager.getTeam(tid);
      if (!team) return `Team "${tid}" not found.`;

      const timeoutMs = (timeout_seconds || 600) * 1000;
      const startTime = Date.now();
      const pollInterval = 5000;

      while (Date.now() - startTime < timeoutMs) {
        const active = Array.from(team.teammates.values()).filter(t =>
          t.status === 'working' || t.status === 'idle'
        );
        if (active.length === 0) {
          return `All teammates finished.\n\n${teamManager.getTeamStatus(tid)}`;
        }
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const activeNames = active.map(t => `${t.name} (${t.status})`).join(', ');
        console.log(`[wait_for_team] ${elapsed}s — waiting for: ${activeNames}`);
        await new Promise(r => setTimeout(r, pollInterval));
      }

      return `⏰ Wait timed out after ${timeout_seconds || 600}s. Some teammates may still be running.\n\n${teamManager.getTeamStatus(tid)}`;
    },
  });
}

// ─── Factory: Create All Team Tools ───

/**
 * Create team tools for an agent. Returns different tool sets based on role.
 */
export function createTeamTools(ctx: TeamToolsContext): Record<string, any> {
  const isTeammate = !!ctx.agentName && ctx.agentName !== '@lead';

  // Tools available to all agents
  const tools: Record<string, any> = {
    send_message: createSendMessageTool(ctx),
    task_create: createTaskCreateTool(ctx),
    task_get: createTaskGetTool(ctx),
    task_list: createTaskListTool(ctx),
    task_update: createTaskUpdateTool(ctx),
    team_status: createTeamStatusTool(ctx),
  };

  // Lead-only tools
  if (!isTeammate) {
    tools.team_create = createTeamCreateTool(ctx);
    tools.team_delete = createTeamDeleteTool(ctx);
    tools.spawn_teammate = createSpawnTeammateTool(ctx);
    tools.wait_for_team = createWaitForTeamTool(ctx);
    tools.write_contracts = createWriteContractsTool(ctx);
    tools.validate_integration = createValidateIntegrationTool(ctx);
  }

  return tools;
}
