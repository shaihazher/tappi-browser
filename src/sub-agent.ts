/**
 * sub-agent.ts — Sub-agent spawning and management.
 *
 * The main chat agent can spawn isolated sub-agents for parallel/complex tasks.
 * Sub-agents inherit: LLM provider, model, API key, thinking config, all tools.
 * Sub-agents get: own conversation history, own output buffer, own session scope.
 * Sub-agents do NOT get the parent's conversation history.
 *
 * When a sub-agent finishes, it reports a summary back to the parent.
 * Output buffers are purged when the sub-agent session ends.
 */

import { streamText, stepCountIs } from 'ai';
import { createModel, buildProviderOptions, getModelConfig, type LLMConfig } from './llm-client';
import { createTools, TOOL_USAGE_GUIDE } from './tool-registry';
import * as browserTools from './browser-tools';
import * as httpTools from './http-tools';
import type { BrowserContext } from './browser-tools';
import { addMessage, getWindow, clearHistory, type ChatMessage } from './conversation';
import { purgeSession } from './output-buffer';
import { cleanupSession } from './shell-tools';

// ─── Types ───

export interface SubAgentTask {
  id: string;
  task: string;
  status: 'running' | 'completed' | 'failed';
  sessionId: string;
  result?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  toolsUsed: string[];
}

// Active sub-agents (limit enforced)
const MAX_CONCURRENT = 3;
const activeAgents = new Map<string, SubAgentTask>();
let agentCounter = 0;

// ─── Spawn ───

export async function spawnSubAgent(
  task: string,
  browserCtx: BrowserContext,
  llmConfig: LLMConfig,
  parentSessionId: string,
  modelPurpose: 'primary' | 'secondary' = 'secondary', // Phase 8.85: secondary by default
): Promise<string> {
  // Check concurrency limit
  const running = Array.from(activeAgents.values()).filter(a => a.status === 'running');
  if (running.length >= MAX_CONCURRENT) {
    return `❌ Max ${MAX_CONCURRENT} concurrent sub-agents. Running: ${running.map(a => a.id).join(', ')}. Wait for one to finish or check status.`;
  }

  const id = `sub-${++agentCounter}`;
  const sessionId = `${parentSessionId}:${id}`;

  const agentTask: SubAgentTask = {
    id,
    task,
    status: 'running',
    sessionId,
    startedAt: Date.now(),
    toolsUsed: [],
  };
  activeAgents.set(id, agentTask);

  // Resolve the appropriate model config (secondary by default, Phase 8.85)
  const resolvedConfig = getModelConfig(modelPurpose, llmConfig);

  // Run in background — don't await
  runSubAgent(agentTask, browserCtx, resolvedConfig).catch(err => {
    agentTask.status = 'failed';
    agentTask.error = err?.message || 'Unknown error';
    agentTask.finishedAt = Date.now();
  });

  return `✓ Spawned sub-agent ${id}\n  Task: ${task}\n  Check: sub_agent_status("${id}")\n  It will report back when done.`;
}

// ─── Status ───

export function getSubAgentStatus(id?: string): string {
  if (id) {
    const agent = activeAgents.get(id);
    if (!agent) return `Sub-agent "${id}" not found.`;

    const duration = ((agent.finishedAt || Date.now()) - agent.startedAt) / 1000;
    const lines = [
      `${agent.id}: ${agent.status === 'running' ? '⏳ running' : agent.status === 'completed' ? '✓ completed' : '✗ failed'} (${duration.toFixed(1)}s)`,
      `Task: ${agent.task}`,
    ];
    if (agent.toolsUsed.length > 0) lines.push(`Tools used: ${[...new Set(agent.toolsUsed)].join(', ')}`);
    if (agent.result) lines.push(`Result: ${agent.result.length > 500 ? agent.result.slice(0, 500) + '...' : agent.result}`);
    if (agent.error) lines.push(`Error: ${agent.error}`);
    return lines.join('\n');
  }

  // List all
  if (activeAgents.size === 0) return 'No sub-agents.';

  return Array.from(activeAgents.values()).map(a => {
    const status = a.status === 'running' ? '⏳' : a.status === 'completed' ? '✓' : '✗';
    const duration = ((a.finishedAt || Date.now()) - a.startedAt) / 1000;
    return `${status} ${a.id}: ${a.task.slice(0, 60)}${a.task.length > 60 ? '...' : ''} (${duration.toFixed(1)}s)`;
  }).join('\n');
}

// ─── Internal: Run a sub-agent to completion ───

async function runSubAgent(
  agentTask: SubAgentTask,
  browserCtx: BrowserContext,
  llmConfig: LLMConfig,
): Promise<void> {
  const { sessionId, task } = agentTask;

  try {
    const model = createModel(llmConfig);
    const tools = createTools(browserCtx, sessionId);

    // Add the task as the first user message
    addMessage(sessionId, { role: 'user', content: task });

    const browserContext = assembleBrowserContext(browserCtx);

    const messages = [
      { role: 'user' as const, content: `[Browser: ${browserContext}]\n\n${task}` },
    ];

    // Use provider options derived from the resolved config (secondary has thinking: false)
    const providerOptions = buildProviderOptions(llmConfig);

    const result = await streamText({
      model,
      system: SUB_AGENT_SYSTEM_PROMPT,
      messages,
      tools,
      maxOutputTokens: 2048,
      ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
      stopWhen: stepCountIs(50), // sub-agents get fewer steps
      onStepFinish: async (event: any) => {
        try {
          const toolResults = event.toolResults || [];
          for (const tr of toolResults) {
            agentTask.toolsUsed.push(tr.toolName || 'unknown');
          }
        } catch {}
      },
    });

    // Collect full response
    let fullResponse = '';
    for await (const chunk of result.textStream) {
      fullResponse += chunk;
    }

    agentTask.result = fullResponse || `Used ${agentTask.toolsUsed.length} tools: ${[...new Set(agentTask.toolsUsed)].join(', ')}`;
    agentTask.status = 'completed';

  } catch (err: any) {
    agentTask.status = 'failed';
    agentTask.error = err?.message || 'Unknown error';
  } finally {
    agentTask.finishedAt = Date.now();
    // Cleanup session resources
    cleanupSession(sessionId);
    purgeSession(sessionId);
    clearHistory(sessionId);
  }
}

function assembleBrowserContext(browserCtx: BrowserContext): string {
  try {
    return browserTools.getBrowserState(browserCtx);
  } catch {
    return '(unavailable)';
  }
}

const SUB_AGENT_SYSTEM_PROMPT = `You are a Tappi sub-agent — a focused worker spawned by the main agent to complete a specific task.

You have access to all the same tools as the main agent: browser, files, HTTP, shell (if dev mode is on).

Rules:
1. Focus on the task you were given. Don't go off track.
2. Be efficient — use grep/search before reading/scrolling.
3. When done, summarize what you accomplished clearly and concisely.
4. If you hit a blocker you can't resolve, explain clearly what's blocking you.

The page is a black box — use elements/text tools to see it.
`;

// ─── Cleanup ───

export function cleanupAllSubAgents(): void {
  for (const [id, agent] of activeAgents) {
    if (agent.status === 'running') {
      agent.status = 'failed';
      agent.error = 'App shutting down';
      agent.finishedAt = Date.now();
    }
    cleanupSession(agent.sessionId);
    purgeSession(agent.sessionId);
    clearHistory(agent.sessionId);
  }
  activeAgents.clear();
}
