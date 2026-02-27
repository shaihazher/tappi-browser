/**
 * sub-agent.ts — Sub-agent spawning and management.
 *
 * The main chat agent can spawn isolated sub-agents for parallel/complex tasks.
 * Sub-agents inherit: LLM provider, model, API key, thinking config, all tools.
 * Sub-agents get: own conversation history, own output buffer, own session scope.
 * Sub-agents do NOT get the parent's conversation history.
 *
 * Tab isolation: each sub-agent is allocated exactly one dedicated browser tab.
 * The sub-agent's tools are locked to that tab via tabManager.setAgentTarget().
 * No other tab can be accessed by the sub-agent.
 *
 * When a sub-agent finishes, it reports a summary back to the parent.
 * Output buffers are purged when the sub-agent session ends.
 */

import { generateText, streamText, stepCountIs } from 'ai';
import * as os from 'os';
import * as path from 'path';
import { getWorkspacePath, DEFAULT_WORKSPACE } from './workspace-resolver';
import { getWorkingDir, setWorkingDir, resetContext } from './working-context';
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
import type { BrowserContext } from './browser-tools';
import { addMessage, addMessages, getWindow, getFullHistory, clearHistory, type ChatMessage } from './conversation';
import { purgeSession } from './output-buffer';
import { cleanupSession } from './shell-tools';

// ─── Types ───

export interface SubAgentTask {
  id: string;
  task: string;
  taskType: TaskType;       // classified task type
  contract: string;         // system prompt scaffolding for this task type
  depth: SubAgentDepth;     // Phase 9.12: budget control
  workingDir?: string;      // Working directory for file operations
  status: 'running' | 'completed' | 'failed' | 'killed';
  sessionId: string;
  assignedTabId?: string;   // dedicated browser tab for this sub-agent
  abortController?: AbortController; // Phase 9.12: for kill support
  result?: string;
  transcript?: ChatMessage[]; // Phase 9.097: full conversation history (for debugging/audit)
  error?: string;
  startedAt: number;
  finishedAt?: number;
  toolsUsed: string[];
  metrics?: {
    provider: string;
    mode: 'streamText' | 'generateText';
    steps: number;
    toolCalls: number;
    uniqueTools: number;
    suspicious: boolean;
    suspiciousReason?: string;
    attempts?: number;
    emptyToolIntentSteps?: number;
    toolCallFailures?: number;
    recoveredByNonStreamRetry?: boolean;
  };
}

export type TaskType = 'research' | 'coding' | 'story-writing' | 'normal';

// Active sub-agents (limit enforced)
const MAX_CONCURRENT = 5;
const activeAgents = new Map<string, SubAgentTask>();
let agentCounter = 0;

// Phase 9.12: Depth presets — control how much work a sub-agent does
export type SubAgentDepth = 'quick' | 'standard' | 'deep';
const DEPTH_PRESETS: Record<SubAgentDepth, { maxSteps: number; maxSources: number; maxOutputChars: number; thinkingEnabled: boolean }> = {
  quick:    { maxSteps: 5,  maxSources: 1, maxOutputChars: 800,  thinkingEnabled: false },
  standard: { maxSteps: 15, maxSources: 3, maxOutputChars: 2000, thinkingEnabled: false },
  deep:     { maxSteps: 30, maxSources: 5, maxOutputChars: 4000, thinkingEnabled: true },
};

// ─── Task Classifier ───

/**
 * Classify a task as research, coding, story-writing, or normal.
 * Called for each incoming user message to decide whether to spawn sub-agents.
 */
function hasKeyword(msg: string, keyword: string): boolean {
  const escaped = keyword
    .toLowerCase()
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`).test(msg);
}

function hasAnyKeyword(msg: string, keywords: string[]): boolean {
  for (const kw of keywords) {
    if (hasKeyword(msg, kw)) return true;
  }
  return false;
}

export function classifyTask(userMessage: string): TaskType {
  const msg = userMessage.toLowerCase();

  // Research signals
  const researchKeywords = [
    'research', 'find', 'look up', 'look into', 'search', 'investigate',
    'explore', 'what is', 'who is', 'how does', 'explain', 'summarize',
    'compare', 'analyze', 'review', 'gather', 'collect information',
    'deep dive', 'deep-dive', 'comprehensive', 'overview', 'report on',
    'learn about', 'tell me about', 'what are', 'background on',
  ];

  // Coding signals
  const codingKeywords = [
    'code', 'implement', 'build', 'create', 'develop', 'write a',
    'write the', 'program', 'function', 'class', 'module', 'script',
    'fix', 'debug', 'refactor', 'test', 'feature', 'component',
    'api', 'backend', 'frontend', 'database', 'schema', 'migration',
    'deploy', 'typescript', 'javascript', 'python', 'html', 'css',
    'react', 'svelte', 'vue', 'node', 'sql', 'git', 'repository',
  ];

  // Story-writing signals
  const storyKeywords = [
    'story', 'write a story', 'write a chapter', 'novel', 'fiction',
    'character', 'plot', 'narrative', 'scene', 'dialogue', 'prose',
    'fantasy', 'thriller', 'romance', 'mystery', 'horror',
    'protagonist', 'antagonist', 'world-build', 'worldbuild',
    'write about', 'creative writing', 'short story', 'poem',
  ];

  // Score each category
  let researchScore = 0;
  let codingScore = 0;
  let storyScore = 0;

  for (const kw of researchKeywords) {
    if (hasKeyword(msg, kw)) researchScore++;
  }
  for (const kw of codingKeywords) {
    if (hasKeyword(msg, kw)) codingScore++;
  }
  for (const kw of storyKeywords) {
    if (hasKeyword(msg, kw)) storyScore++;
  }

  // Multi-file / complexity signals boost coding (kept conservative)
  if (/\b(files?|modules?|services?|components?)\b/.test(msg)) codingScore++;
  if (/\bpages\b/.test(msg)) codingScore += 0.5;

  // Report-style tasks usually indicate research intent.
  if (/\b(report|research report|trend report|market report)\b/.test(msg)) researchScore += 0.5;

  if (/\b(multiple|several|various|all the)\b/.test(msg)) {
    researchScore += 0.5;
    codingScore += 0.5;
  }

  const maxScore = Math.max(researchScore, codingScore, storyScore);

  // Must meet a minimum threshold to warrant sub-agents
  if (maxScore < 1) return 'normal';

  // Tie-break: if no explicit coding intent, prefer research over coding.
  const explicitCodingSignal = hasAnyKeyword(msg, [
    'code', 'implement', 'build', 'debug', 'refactor',
    'function', 'class', 'script', 'api', 'backend', 'frontend',
    'database', 'typescript', 'javascript', 'python', 'sql',
  ]);
  if (researchScore === codingScore && researchScore > 0 && !explicitCodingSignal) {
    return 'research';
  }

  if (storyScore === maxScore && storyScore > 0) return 'story-writing';
  if (codingScore === maxScore && codingScore > 0) return 'coding';
  if (researchScore === maxScore && researchScore > 0) return 'research';

  return 'normal';
}

// ─── Contract/Scaffolding Templates ───

const RESEARCH_CONTRACT = `## Sub-Agent Contract: Research

You are a research sub-agent. Your ONE job is the specific research task assigned to you.
You have a LIMITED step budget — be efficient. Do NOT visit every link. Pick the best 1-3 sources.

### How to Research
1. **search("your query")** → scan the search result snippets first
2. **click(N)** → only click the most promising result
3. **text({ grep: "key term" })** → extract what you need. Do NOT read entire pages.
4. If you have enough info, stop and synthesize. Don't keep searching.

### Incremental Output Rule
**IMPORTANT:** Provide synthesis incrementally. After each major finding, summarize what you learned.
If you are interrupted/killed, your last synthesis will be preserved for the parent agent.
Do NOT wait until the end to write your findings — summarize as you go.

### Rules
1. **Scope**: Only research what you were assigned. Do not expand scope.
2. **Efficiency**: Prefer grep over full-page reads. 1-3 good sources > 5 shallow ones.
3. **Tab**: You have ONE dedicated browser tab. Use ONLY that tab.
4. **Budget**: You have limited steps. Use them wisely. Stop when you have a good answer.
5. **Done**: When finished, your final text output must contain your findings.

### Output Format
- 2-3 sentence executive summary
- Key findings as bullet points with source URLs
- Keep it concise — quality over volume
`;

const CODING_CONTRACT = `## Sub-Agent Contract: Coding

You are a coding sub-agent. Your ONE job is the specific coding task assigned to you.

### Incremental Output Rule
**IMPORTANT:** Write files incrementally. Save working code frequently, not just at the end.
If you are interrupted/killed, your saved files will be preserved for the parent agent.
Do NOT wait until you're "done" to write files — save progress as you go.

### Rules
1. **Scope**: Implement only what you were assigned. Do not modify unrelated files.
2. **Contracts First**: Read any shared contracts/interfaces before writing code.
3. **Quality**: Write clean, typed, testable code. Match existing code style.
4. **Files**: Work in your assigned working directory. List files before reading.
5. **Save Often**: Write partial implementations — they're valuable even if incomplete.
6. **Tests**: If the task involves testable code, include basic tests.
7. **Tab**: You have ONE dedicated browser tab (for docs lookup only). Stay on task.
8. **Done**: When finished, state "CODING COMPLETE:" and list every file you touched.

### Output Format
- List files created/modified
- Brief description of what each file does
- Any assumptions or dependencies the lead should know about
`;

const STORY_CONTRACT = `## Sub-Agent Contract: Story Writing

You are a creative writing sub-agent. Your ONE job is the specific writing task assigned to you.

### Rules
1. **Scope**: Write only the section/chapter/element you were assigned.
2. **Style**: Match the tone, voice, and style established by the lead agent.
3. **Consistency**: Stay true to established characters, world rules, and plot.
4. **Quality**: Write vivid, purposeful prose. Show don't tell. No filler.
5. **Files**: Save your output to the working directory with your agent ID in the name.
6. **Tab**: You have ONE dedicated browser tab (for research only). Focus on writing.
7. **Done**: When finished, state "WRITING COMPLETE:" and summarize what you wrote.

### Output Format
- Write the full content as requested
- End with a brief note on tone/style choices
- Flag any continuity questions for the lead
`;

export function getContractForTaskType(taskType: TaskType): string {
  switch (taskType) {
    case 'research': return RESEARCH_CONTRACT;
    case 'coding': return CODING_CONTRACT;
    case 'story-writing': return STORY_CONTRACT;
    default: return '';
  }
}

// ─── Model capability check ───

/**
 * Detect if a model is "lightweight" (e.g. Haiku, Flash, Mini) — too weak for
 * multi-step agentic browsing tasks like research.
 * These models can navigate and call tools but produce thin, unreliable results.
 */
function isLightweightModel(config: LLMConfig): boolean {
  const model = (config.model || '').toLowerCase();
  const lightweightPatterns = [
    'haiku', 'flash', 'mini', 'nano', 'tiny', 'small',
    'gpt-4o-mini', 'gpt-3.5', 'llama-3.1-8b', 'llama-3.2',
    'gemma', 'phi-', 'mistral-7b',
  ];
  return lightweightPatterns.some(p => model.includes(p));
}

// ─── Spawn ───

/** Progress callback for UI chips — called on each sub-agent step finish. */
export type SubAgentProgressCallback = (data: {
  agentId: string;
  taskType: TaskType;
  step: number;
  tools: string[];
  url?: string;
  status: 'running' | 'completed' | 'failed';
  elapsed: number;
  done: boolean;
}) => void;

function allocateSubAgentTab(id: string, browserCtx: BrowserContext): string | undefined {
  try {
    if (!browserCtx.tabManager) return undefined;
    const tabId = browserCtx.tabManager.createTab('about:blank', undefined, { background: true });
    console.log(`[sub-agent] ${id} allocated tab: ${tabId}`);
    return tabId;
  } catch (e) {
    console.warn(`[sub-agent] ${id} failed to allocate tab:`, e);
    return undefined;
  }
}

/**
 * Phase 9.12: Non-blocking spawn. Returns immediately with agent ID.
 * The main agent checks status with sub_agent_status and kills with kill_agent.
 * No retries, no auto-promotion — the agent controls the workflow.
 */
export interface SubAgentSpawnOptions {
  workingDir?: string;  // Working directory for file operations (defaults to configured workspace)
}

export async function spawnSubAgent(
  task: string,
  browserCtx: BrowserContext,
  llmConfig: LLMConfig,
  parentSessionId: string,
  modelPurpose: 'primary' | 'secondary' = 'secondary',
  taskType?: TaskType,
  onProgress?: SubAgentProgressCallback,
  depth: SubAgentDepth = 'standard',
  spawnOptions?: SubAgentSpawnOptions,
): Promise<string> {
  // Check concurrency limit
  const running = Array.from(activeAgents.values()).filter(a => a.status === 'running');
  if (running.length >= MAX_CONCURRENT) {
    return `❌ Max ${MAX_CONCURRENT} concurrent sub-agents. Running: ${running.map(a => a.id).join(', ')}. Wait for one to finish or check status with sub_agent_status.`;
  }

  const id = `sub-${++agentCounter}`;
  const sessionId = `${parentSessionId}:${id}`;
  const resolvedType = taskType || 'normal';
  const contract = getContractForTaskType(resolvedType);
  const preset = DEPTH_PRESETS[depth];

  // Resolve working directory for file operations
  // Priority: explicit workingDir > inherit from parent session > default workspace
  let workingDir = spawnOptions?.workingDir;
  if (!workingDir) {
    const parentWorkingDir = getWorkingDir(parentSessionId);
    if (parentWorkingDir) {
      workingDir = parentWorkingDir;
    }
  }

  // Initialize sub-agent's working context with inherited working dir
  if (workingDir) {
    setWorkingDir(sessionId, workingDir);
  }

  // Allocate a dedicated browser tab for this sub-agent
  const assignedTabId = allocateSubAgentTab(id, browserCtx);

  const abortController = new AbortController();

  const agentTask: SubAgentTask = {
    id,
    task,
    taskType: resolvedType,
    contract,
    depth,
    workingDir,
    status: 'running',
    sessionId,
    assignedTabId,
    abortController,
    startedAt: Date.now(),
    toolsUsed: [],
  };
  activeAgents.set(id, agentTask);

  // Resolve model config
  const activeConfig = getModelConfig(modelPurpose, llmConfig);

  // Phase 9.12: Override thinking for sub-agents based on depth
  const subAgentConfig: LLMConfig = {
    ...activeConfig,
    thinking: preset.thinkingEnabled,
  };

  // Emit initial progress event — sub-agent spawned
  if (onProgress) {
    onProgress({ agentId: id, taskType: resolvedType, step: 0, tools: [], status: 'running', elapsed: 0, done: false });
  }

  // Fire and forget — run in background, don't block the main agent
  runSubAgent(agentTask, browserCtx, subAgentConfig, onProgress).catch(err => {
    agentTask.status = 'failed';
    agentTask.error = err?.message || 'Unknown error';
    agentTask.finishedAt = Date.now();
    releaseSubAgentTab(agentTask, browserCtx);
  }).finally(() => {
    // Emit final progress event
    if (onProgress) {
      const duration = ((agentTask.finishedAt || Date.now()) - agentTask.startedAt) / 1000;
      onProgress({
        agentId: id, taskType: resolvedType, step: agentTask.toolsUsed.length,
        tools: [...new Set(agentTask.toolsUsed)], status: agentTask.status as any,
        elapsed: duration * 1000, done: true,
      });
    }
  });

  console.log(`[sub-agent] ${id} spawned (depth=${depth}, maxSteps=${preset.maxSteps}, model=${subAgentConfig.model}, thinking=${preset.thinkingEnabled}, workingDir=${workingDir || 'default'})`);
  const workDirHint = workingDir ? ` Files saved to: ${workingDir}` : '';
  // Phase 9.14: Suggest when to check back based on depth
  const checkBackHint = depth === 'quick' ? 'Check in ~15s' : depth === 'deep' ? 'Check in ~60s' : 'Check in ~30s';
  return `🚀 Spawned ${id} [${resolvedType}, depth=${depth}] — running in background.${workDirHint}
⏱ ${checkBackHint} with: sub_agent_status({ id: "${id}" })
💡 Sub-agent has ${preset.maxSteps} steps — it will finish. Wait for completion unless stuck.`;
}

/**
 * Phase 9.12: Kill a running sub-agent.
 */
export function killSubAgent(id: string, browserCtx: BrowserContext): string {
  const agent = activeAgents.get(id);
  if (!agent) return `❌ Sub-agent "${id}" not found.`;
  if (agent.status !== 'running') return `ℹ️ ${id} is already ${agent.status}.`;

  // Phase 9.13: Preserve partial result before aborting
  // The result field is updated incrementally during runSubAgent, so we capture it here
  const partialResult = agent.result;
  const partialToolsUsed = [...agent.toolsUsed];

  agent.abortController?.abort();
  agent.status = 'killed';
  agent.error = 'Killed by parent agent';
  agent.finishedAt = Date.now();

  // Preserve partial result if available (shows what sub-agent found before being killed)
  if (partialResult && partialResult.length > 0) {
    agent.result = `[KILLED — Partial Result]\n${partialResult}`;
  } else if (partialToolsUsed.length > 0) {
    agent.result = `[KILLED — No synthesis yet] Used ${partialToolsUsed.length} tools: ${[...new Set(partialToolsUsed)].join(', ')}`;
  }

  // Phase 9.097: Preserve transcript before clearing
  agent.transcript = getFullHistory(agent.sessionId);

  releaseSubAgentTab(agent, browserCtx);
  cleanupSession(agent.sessionId);
  purgeSession(agent.sessionId);
  clearHistory(agent.sessionId);

  const duration = ((agent.finishedAt - agent.startedAt) / 1000).toFixed(1);
  const partialHint = agent.result ? ' Partial result preserved — check status for details.' : '';
  return `🛑 Killed ${id} after ${duration}s. ${partialToolsUsed.length} tool calls completed.${partialHint}`;
}

// ─── Status ───

function summarizeTranscriptTail(transcript: ChatMessage[], limit = 4): string {
  const tail = transcript.slice(-Math.max(1, limit));
  const lines: string[] = [];

  for (const msg of tail) {
    const role = (msg as any).role || 'unknown';
    if (role === 'assistant') {
      const content = (msg as any).content;
      if (typeof content === 'string') {
        const text = content.replace(/\s+/g, ' ').trim();
        if (text) lines.push(`[assistant] ${text.slice(0, 180)}${text.length > 180 ? '…' : ''}`);
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (!part || typeof part !== 'object') continue;
          if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
            const text = part.text.replace(/\s+/g, ' ').trim();
            lines.push(`[assistant] ${text.slice(0, 180)}${text.length > 180 ? '…' : ''}`);
          } else if (part.type === 'tool-call') {
            lines.push(`[tool-call] ${part.toolName || 'unknown'}(${JSON.stringify(part.args || {}).slice(0, 120)})`);
          }
        }
      }
    } else if (role === 'tool') {
      const content = (msg as any).content;
      const text = (typeof content === 'string' ? content : JSON.stringify(content || '')).replace(/\s+/g, ' ').trim();
      if (text) lines.push(`[tool-result] ${text.slice(0, 180)}${text.length > 180 ? '…' : ''}`);
    } else if (role === 'user' || role === 'system') {
      const content = (msg as any).content;
      const text = (typeof content === 'string' ? content : JSON.stringify(content || '')).replace(/\s+/g, ' ').trim();
      if (text) lines.push(`[${role}] ${text.slice(0, 140)}${text.length > 140 ? '…' : ''}`);
    }
  }

  return lines.join('\n');
}

export function getSubAgentStatus(id?: string): string {
  if (id) {
    const agent = activeAgents.get(id);
    if (!agent) return `Sub-agent "${id}" not found.`;

    const duration = ((agent.finishedAt || Date.now()) - agent.startedAt) / 1000;
    const statusEmoji = agent.status === 'running' ? '⏳' : agent.status === 'completed' ? '✅' : agent.status === 'killed' ? '🛑' : '❌';
    const lines = [
      `${statusEmoji} ${agent.id} [${agent.taskType}, depth=${agent.depth}] — ${agent.status} (${duration.toFixed(1)}s)`,
      `Task: ${agent.task.slice(0, 120)}`,
    ];

    // Phase 9.13: Show budget usage for running agents
    if (agent.status === 'running') {
      const preset = DEPTH_PRESETS[agent.depth];
      const stepsUsed = agent.metrics?.steps ?? agent.toolsUsed.length;
      const stepsLeft = preset.maxSteps - stepsUsed;
      lines.push(`Budget: ${stepsUsed}/${preset.maxSteps} steps used, ${Math.max(0, stepsLeft)} remaining`);

      // Show recent tools as activity indicator
      const recentTools = [...new Set(agent.toolsUsed)].slice(-5);
      if (recentTools.length > 0) {
        lines.push(`Recent tools: ${recentTools.join(', ')}`);
      }

      // Phase 9.14: Show snippet of ongoing work (first 400 chars of result so far)
      // This gives main agent visibility into what sub-agent is finding without killing it
      if (agent.result && agent.result.length > 0) {
        const snippet = agent.result.length > 400 
          ? agent.result.slice(0, 400) + '...' 
          : agent.result;
        lines.push(`Work in progress:\n${snippet}`);
      }

      // Timing hint: suggest when to check again based on remaining steps
      const estimatedSeconds = Math.max(5, stepsLeft * 3); // ~3s per step remaining
      lines.push(`⏱ Check again in ~${Math.min(30, estimatedSeconds)}s or when steps exhausted.`);

      // Add live transcript tail while running for better parent-agent visibility
      const liveTranscript = getFullHistory(agent.sessionId);
      if (liveTranscript.length > 0) {
        const tail = summarizeTranscriptTail(liveTranscript, 4);
        if (tail) lines.push(`Latest transcript tail:\n${tail}`);
      }
    }

    if (agent.workingDir) lines.push(`Working Dir: ${agent.workingDir}`);
    if (agent.toolsUsed.length > 0) lines.push(`Tools: ${agent.toolsUsed.length} calls (${[...new Set(agent.toolsUsed)].join(', ')})`);
    if (agent.result) {
      // Phase 9.12: Cap result output based on depth preset
      const preset = DEPTH_PRESETS[agent.depth];
      const maxLen = preset.maxOutputChars;
      lines.push(`Result:\n${agent.result.length > maxLen ? agent.result.slice(0, maxLen) + `\n... (${agent.result.length} chars total — full result saved to file if applicable)` : agent.result}`);
    }
    if (agent.error) lines.push(`Error: ${agent.error}`);

    // Contextual hints based on status
    if (agent.status === 'running') {
      const preset = DEPTH_PRESETS[agent.depth];
      lines.push(`💡 Wait for completion. Budget: ${preset.maxSteps} steps max.`);
    } else if (agent.status === 'killed') {
      lines.push(`💡 Sub-agent was killed. Partial result above — reuse findings instead of starting fresh.`);
    } else if (agent.status === 'completed' && agent.workingDir) {
      lines.push(`📁 Access outputs: file_list({ path: "${agent.workingDir}" }) or file_read({ path: "${agent.workingDir}/<filename>" })`);
    }

    // Phase 9.097: Mention transcript availability for debugging
    if (agent.transcript && agent.transcript.length > 0) {
      lines.push(`📝 Full transcript available (${agent.transcript.length} messages) — use sub_agent_transcript({ id: "${id}" }) to inspect.`);
    }
    return lines.join('\n');
  }

  // List all
  if (activeAgents.size === 0) return 'No sub-agents.';

  return Array.from(activeAgents.values()).map(a => {
    const statusEmoji = a.status === 'running' ? '⏳' : a.status === 'completed' ? '✅' : a.status === 'killed' ? '🛑' : '❌';
    const duration = ((a.finishedAt || Date.now()) - a.startedAt) / 1000;
    return `${statusEmoji} ${a.id} [${a.taskType}, ${a.depth}] ${a.task.slice(0, 60)}${a.task.length > 60 ? '...' : ''} (${duration.toFixed(1)}s, ${a.toolsUsed.length} tools)`;
  }).join('\n');
}

// ─── Transcript Access (Phase 9.097) ───

/**
 * Get the full transcript for a sub-agent (tool calls, results, thoughts).
 * Useful when sub-agent stopped mid-run or result is incomplete.
 */
export function getSubAgentTranscript(id: string): { transcript: ChatMessage[] | null; error?: string } {
  const agent = activeAgents.get(id);
  if (!agent) return { transcript: null, error: `Sub-agent "${id}" not found.` };

  // Live access while running
  if (agent.status === 'running') {
    const live = getFullHistory(agent.sessionId);
    if (!live || live.length === 0) {
      return { transcript: null, error: `No transcript available yet for ${id}.` };
    }
    return { transcript: live };
  }

  // Archived transcript after completion/kill/failure
  if (!agent.transcript || agent.transcript.length === 0) {
    return { transcript: null, error: `No transcript available for ${id}.` };
  }
  return { transcript: agent.transcript };
}

// ─── Tab Release ───

function releaseSubAgentTab(agentTask: SubAgentTask, browserCtx: BrowserContext): void {
  if (!agentTask.assignedTabId) return;
  try {
    if (browserCtx.tabManager) {
      browserCtx.tabManager.closeTab(agentTask.assignedTabId);
      console.log(`[sub-agent] ${agentTask.id} released tab: ${agentTask.assignedTabId}`);
    }
  } catch (e) {
    console.warn(`[sub-agent] ${agentTask.id} failed to release tab:`, e);
  }
  agentTask.assignedTabId = undefined;
  // Clean up sub-agent's working context
  resetContext(agentTask.sessionId);
}

// ─── Internal: Run a sub-agent to completion ───

async function runSubAgent(
  agentTask: SubAgentTask,
  browserCtx: BrowserContext,
  llmConfig: LLMConfig,
  onProgress?: SubAgentProgressCallback,
): Promise<void> {
  const { sessionId, task, contract, assignedTabId } = agentTask;

  // Lock the agent to its dedicated tab before creating tools.
  // Phase 9.11: Use lockedTabId option for hard enforcement at the tool level,
  // in addition to the soft agentTargetId (which can be overwritten by bSearch/bNavigate).
  const savedAgentTarget = browserCtx.tabManager?.agentTargetId ?? null;
  if (assignedTabId && browserCtx.tabManager) {
    browserCtx.tabManager.setAgentTarget(assignedTabId);
  }

  let executionMode: 'streamText' | 'generateText' = 'generateText';
  let codexToolIntentSteps = 0;
  let codexParsedToolCalls = 0;
  let codexExecutedToolResults = 0;
  let codexEmptyToolIntentSteps = 0;
  let codexToolFailures = 0;
  let codexRecoveredByNonStreamRetry = false;

  // Phase 9.12: Depth-based step limit
  const depthPreset = DEPTH_PRESETS[agentTask.depth];
  const MAX_STEPS = depthPreset.maxSteps;
  const abortSignal = agentTask.abortController?.signal;

  try {
    console.log(`[sub-agent] ${agentTask.id} running with model: ${llmConfig.provider}/${llmConfig.model}, thinking: ${llmConfig.thinking}`);
    const model = createModel(llmConfig);
    const tools = createTools(browserCtx, sessionId, {
      lockedTabId: assignedTabId,
    });
    console.log(`[sub-agent] ${agentTask.id} tools: ${Object.keys(tools).length}`);

    addMessage(sessionId, { role: 'user', content: task });

    const browserContext = assembleBrowserContext(browserCtx);
    const tabNote = assignedTabId
      ? `\n[Tab: You are locked to tab ID "${assignedTabId}". You MUST NOT open, switch to, or interact with any other tab.]`
      : '';

    // Build budget and working directory context
    const effectiveWorkingDir = agentTask.workingDir || getWorkspacePath();
    const budgetNote = `## Your Budget
You have **${depthPreset.maxSteps} steps** maximum. Each tool call counts as one step.
You may use up to **${depthPreset.maxSources} sources**. Use them wisely.
Stop early if you have a good answer — quality over volume.

## Working Directory
Files resolve relative to: **${effectiveWorkingDir}**
Save outputs here with file_write({ path: "filename.md", content: "..." }).`;

    // ─── Date Grounding (Phase 9.097) ───────────────────────────────────────
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const dateContext = `## Current Time
Date: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
Time: ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
Timezone: ${tz}
`;

    const systemPrompt = contract
      ? `${dateContext}${SUB_AGENT_BASE_PROMPT}\n\n${budgetNote}\n\n${contract}`
      : `${dateContext}${SUB_AGENT_BASE_PROMPT}\n\n${budgetNote}`;

    const providerOptions = buildProviderOptions(llmConfig);
    const callProviderOptions: Record<string, any> = withCodexProviderOptions(
      llmConfig.provider,
      { ...providerOptions },
      systemPrompt,
      systemPrompt,
    );

    // Build sub-agent messages from full session history so follow-up redirects
    // can retain complete context turn-over-turn.
    const history = getWindow(sessionId);
    const llmMessages = history.map((msg, idx) => {
      const isLast = idx === history.length - 1;
      if (isLast && msg.role === 'user' && typeof msg.content === 'string') {
        return {
          role: 'user' as const,
          content: `[Browser: ${browserContext}]${tabNote}\n\n${msg.content}`,
        };
      }
      return msg as any;
    });

    // Phase 9.12: MAX_STEPS comes from depth preset (set above)

    // Capture synthesis + file outputs from step callbacks so we can share a
    // robust result regardless of streaming/non-streaming execution mode.
    const stepTexts: string[] = [];
    const writtenFiles: string[] = [];
    let observedSteps = 0;

    const resetRunTracking = () => {
      stepTexts.length = 0;
      writtenFiles.length = 0;
      observedSteps = 0;
      agentTask.toolsUsed = [];
      codexToolIntentSteps = 0;
      codexParsedToolCalls = 0;
      codexExecutedToolResults = 0;
      codexEmptyToolIntentSteps = 0;
      codexToolFailures = 0;
    };

    const handleStepFinish = async (event: any) => {
      try {
        const toolCalls = event.toolCalls || [];
        const toolResults = event.toolResults || [];
        const stepNum = event.stepNumber ?? '?';
        const finishReason = String(event.finishReason ?? 'n/a');
        const textLen = event.text?.length ?? 0;
        const toolIntent = /tool/i.test(finishReason) || toolCalls.length > 0;
        if (toolIntent) codexToolIntentSteps++;
        codexParsedToolCalls += toolCalls.length;
        codexExecutedToolResults += toolResults.length;
        if (toolIntent && toolCalls.length === 0 && toolResults.length === 0) {
          codexEmptyToolIntentSteps++;
          codexToolFailures++;
        }

        console.log(`[sub-agent] ${agentTask.id} step ${stepNum}: finish=${finishReason}, calls=${toolCalls.length}, results=${toolResults.length}, tool_intent=${toolIntent ? 'yes' : 'no'}, text=${textLen} chars`);

        const numericStep = typeof stepNum === 'number' ? stepNum : parseInt(stepNum, 10);
        if (Number.isFinite(numericStep)) {
          observedSteps = Math.max(observedSteps, (numericStep as number) + 1);
        } else {
          observedSteps += 1;
        }

        const stepToolNames: string[] = [];
        let stepUrl: string | undefined;

        for (const tr of toolResults) {
          const toolName = tr.toolName || 'unknown';
          agentTask.toolsUsed.push(toolName);
          stepToolNames.push(toolName);

          // Track files the sub-agent wrote (findings reports, etc.)
          const output = tr.result ?? tr.output ?? '';
          if (toolName === 'file_write' && typeof output === 'string') {
            const fileMatch = output.match(/Written:\s*(\S+)/);
            if (fileMatch) writtenFiles.push(fileMatch[1]);
          }
        }

        const stepText = (event.text || '').trim();
        if (stepText.length > 0) {
          stepTexts.push(stepText);
        }

        // Phase 9.13: Preserve partial result incrementally so it survives if killed mid-run
        // Build partial result from accumulated step texts + tools used
        const partialResult = stepTexts.join('\n\n').trim();
        if (partialResult.length > 0) {
          agentTask.result = partialResult;
        } else if (agentTask.toolsUsed.length > 0) {
          agentTask.result = `[Partial] Used ${agentTask.toolsUsed.length} tools: ${[...new Set(agentTask.toolsUsed)].slice(-5).join(', ')}`;
        }

        // Extract URL from tool calls (navigate, search, open, etc.)
        for (const tc of toolCalls) {
          const args = tc.args || {};
          if (args.url) { stepUrl = args.url; break; }
          if (args.query) { stepUrl = `🔍 ${args.query}`; break; }
        }

        // Broadcast progress to UI
        if (onProgress) {
          const elapsed = Date.now() - agentTask.startedAt;
          onProgress({
            agentId: agentTask.id,
            taskType: agentTask.taskType,
            step: Number.isFinite(numericStep) ? (numericStep as number) : 0,
            tools: stepToolNames,
            url: stepUrl,
            status: 'running',
            elapsed,
            done: false,
          });
        }
      } catch (e) {
        console.error(`[sub-agent] ${agentTask.id} onStepFinish error:`, e);
      }
    };

    // Codex path: direct Codex backend runtime with robust streamed tool-call assembly.
    let finalText = '';
    let fallbackSteps: any[] = [];
    let structuredResponseMessages: ChatMessage[] = [];

    if (false && llmConfig.provider === 'openai-codex') {
      executionMode = 'streamText';
      const codexRun = await runLiteLLMCodexToolLoop({
        config: llmConfig,
        system: systemPrompt,
        messages: llmMessages,
        tools,
        maxSteps: MAX_STEPS,
        providerOptions: callProviderOptions,
        abortSignal,
        onTextDelta: (delta) => {
          finalText += delta;
        },
        onStepFinish: handleStepFinish,
        logPrefix: `sub-agent.${agentTask.id}.codex`,
      });

      if (!finalText.trim()) {
        finalText = codexRun.text || '';
      }

      codexToolFailures = codexRun.metrics.toolCallFailures + codexRun.metrics.unresolvedEmptyToolIntentSteps;
      codexRecoveredByNonStreamRetry = codexRun.metrics.emptyToolIntentRetries > 0;
      structuredResponseMessages = (codexRun.responseMessages || []) as ChatMessage[];

      console.log(`[sub-agent] ${agentTask.id} codex backend metrics:`, JSON.stringify(codexRun.metrics));
    } else {
      executionMode = 'generateText';
      const result = await generateText({
        model,
        system: systemPrompt,
        messages: llmMessages as any,
        tools,
        ...(llmConfig.provider !== 'openai-codex' ? { maxOutputTokens: 30000 } : {}),
        ...(Object.keys(callProviderOptions).length > 0 ? { providerOptions: callProviderOptions } : {}),
        stopWhen: stepCountIs(MAX_STEPS),
        abortSignal,
        onStepFinish: handleStepFinish,
      });

      finalText = (result.text || '').trim();
      fallbackSteps = result.steps || [];
      try {
        const response = await (result as any).response;
        const responseMessages = response?.messages || [];
        if (Array.isArray(responseMessages) && responseMessages.length > 0) {
          structuredResponseMessages = responseMessages as ChatMessage[];
        }
      } catch {
        // Best-effort only
      }
    }

    // Fallback: if step callbacks didn't provide text/results, use generateText steps.
    if (stepTexts.length === 0 && fallbackSteps.length > 0) {
      for (const step of fallbackSteps) {
        const stepText = (step.text || '').trim();
        if (stepText.length > 0) stepTexts.push(stepText);

        for (const tr of (step.toolResults || []) as any[]) {
          if (!tr) continue;
          const output = tr.result ?? tr.output ?? '';
          if (tr.toolName === 'file_write' && typeof output === 'string') {
            const fileMatch = output.match(/Written:\s*(\S+)/);
            if (fileMatch) writtenFiles.push(fileMatch[1]);
          }
        }
      }
    }

    // Assemble the full response: prefer all step texts joined (captures
    // the model's progressive synthesis), fall back to final streamed/text output.
    finalText = (finalText || '').trim();
    const allStepText = stepTexts.join('\n\n').trim();
    const fullResponse = allStepText.length > finalText.length ? allStepText : finalText;

    const uniqueFiles = [...new Set(writtenFiles)];
    const stepCount = Math.max(observedSteps, fallbackSteps.length);
    const toolCallCount = agentTask.toolsUsed.length;
    const uniqueToolCount = new Set(agentTask.toolsUsed).size;

    // Shallow-run detector: catch silent degradation where agents stop after
    // one call/step and still appear "successful".
    let suspicious = false;
    let suspiciousReason = '';
    if (agentTask.taskType !== 'normal' && stepCount <= 1 && toolCallCount <= 1) {
      suspicious = true;
      suspiciousReason = 'non-normal task finished with ≤1 step and ≤1 tool call';
    } else if (agentTask.taskType === 'research' && stepCount <= 2 && toolCallCount <= 2 && fullResponse.length < 300) {
      suspicious = true;
      suspiciousReason = 'research run appears shallow (low steps/tools and short synthesis)';
    }

    agentTask.metrics = {
      provider: llmConfig.provider,
      mode: executionMode,
      steps: stepCount,
      toolCalls: toolCallCount,
      uniqueTools: uniqueToolCount,
      suspicious,
      ...(suspiciousReason ? { suspiciousReason } : {}),
      emptyToolIntentSteps: codexEmptyToolIntentSteps,
      toolCallFailures: codexToolFailures,
      recoveredByNonStreamRetry: codexRecoveredByNonStreamRetry,
    };

    console.log(`[sub-agent] ${agentTask.id} complete: finalText=${finalText.length}, allStepText=${allStepText.length}, fullResponse=${fullResponse.length} chars, ${toolCallCount} tool calls, ${stepCount} steps, files=${uniqueFiles.length}, mode=${executionMode}, suspicious=${suspicious}, tool_failures=${codexToolFailures}, empty_tool_intent_steps=${codexEmptyToolIntentSteps}, recovered=${codexRecoveredByNonStreamRetry}`);

    if (fullResponse.length > 0) {
      agentTask.result = fullResponse;
      if (uniqueFiles.length > 0) {
        agentTask.result += `\n\n📁 Files written: ${uniqueFiles.join(', ')}`;
      }
      if (suspicious) {
        agentTask.result += `\n\n[Diagnostics] shallow_run=true; reason=${suspiciousReason}; steps=${stepCount}; tool_calls=${toolCallCount}; unique_tools=${uniqueToolCount}`;
      }
    } else {
      // No text at all — the model only called tools without any synthesis.
      // Build a minimal summary from what we know.
      agentTask.result = `Sub-agent completed ${stepCount} steps using ${[...new Set(agentTask.toolsUsed)].join(', ')}.`;
      if (uniqueFiles.length > 0) {
        agentTask.result += ` Files written: ${uniqueFiles.join(', ')}`;
      }
      console.warn(`[sub-agent] ${agentTask.id} produced no text output across ${stepCount} steps`);
    }

    // Persist structured turns so future sub-agent redirects/reruns can carry
    // full tool-call and tool-result context in-session.
    if (structuredResponseMessages.length > 0) {
      addMessages(sessionId, structuredResponseMessages);
    } else if (fullResponse.length > 0) {
      addMessage(sessionId, { role: 'assistant', content: fullResponse });
    }

    // Surface suspicious runs loudly, but don't hard-fail healthy-looking outputs.
    // This prevents false failures while still exposing shallow/degraded behavior.
    if (suspicious) {
      console.warn(`[sub-agent] ${agentTask.id} suspicious run flagged: ${suspiciousReason}`);
    }
    agentTask.status = 'completed';

  } catch (err: any) {
    // Phase 9.12: Handle kill (AbortError)
    if (err?.name === 'AbortError') {
      if (agentTask.status === 'killed') {
        // Already marked as killed by killSubAgent — just preserve partial result
        console.log(`[sub-agent] ${agentTask.id} killed by parent`);
        return;
      }
      // Unknown abort — treat as failure
      agentTask.status = 'failed';
      agentTask.error = 'Aborted';
      return;
    }

    if (llmConfig.provider === 'openai-codex') {
      logProviderRequestError(`sub-agent.${agentTask.id}`, err);
    }

    const details = extractRequestErrorDetails(err, 1600);

    console.error(`[sub-agent] ${agentTask.id} FAILED:`, details);

    agentTask.metrics = {
      provider: llmConfig.provider,
      mode: executionMode,
      steps: agentTask.metrics?.steps ?? 0,
      toolCalls: agentTask.toolsUsed.length,
      uniqueTools: new Set(agentTask.toolsUsed).size,
      suspicious: true,
      suspiciousReason: details.statusCode ? `request failed with status ${details.statusCode}` : 'request failed',
      emptyToolIntentSteps: codexEmptyToolIntentSteps,
      toolCallFailures: codexToolFailures,
      recoveredByNonStreamRetry: codexRecoveredByNonStreamRetry,
    };

    agentTask.status = 'failed';
    agentTask.error = details.responseBody
      ? `${details.message || 'Bad Request'} — ${details.responseBody}`
      : (details.message || 'Unknown error');
  } finally {
    agentTask.finishedAt = Date.now();

    // Restore the agent target to what it was before this sub-agent ran
    if (browserCtx.tabManager) {
      browserCtx.tabManager.setAgentTarget(savedAgentTarget);
    }

    // Release the dedicated tab
    releaseSubAgentTab(agentTask, browserCtx);

    // Phase 9.097: Preserve full transcript before clearing (for main agent audit)
    agentTask.transcript = getFullHistory(sessionId);

    // Cleanup session resources
    cleanupSession(sessionId);
    purgeSession(sessionId);
    clearHistory(sessionId);
  }
}

// ─── Tool Filtering ───

/**
 * Filter tools to only what's needed for a given task type.
 * Research sub-agents need: page tools + navigation + search + HTTP + file_write.
 * They do NOT need: shell, cron, team, coding memory, worktrees, password vault,
 * sub-agents (no inception), conversation search, ad-blocker, media, etc.
 *
 * Fewer tools = less context bloat = model focuses on actually doing the research.
 */
function filterToolsForTaskType(
  tools: Record<string, any>,
  taskType: TaskType,
): Record<string, any> {
  // Only filter for research — other types may need broader tool access
  if (taskType !== 'research') return tools;

  // Allowlist of tools a research sub-agent actually needs
  const RESEARCH_TOOLS = new Set([
    // Page interaction (core research loop: navigate → elements → text → extract)
    'elements', 'click', 'type', 'text', 'screenshot', 'scroll', 'wait', 'paste',
    'focus', 'check', 'eval_js', 'keys',
    // Navigation
    'navigate', 'search', 'back_forward', 'tab',
    // HTTP (for fetching pages / APIs directly)
    'http_request',
    // File (to save findings)
    'file_write', 'file_read', 'file_list',
  ]);

  const filtered: Record<string, any> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (RESEARCH_TOOLS.has(name)) {
      filtered[name] = tool;
    }
  }

  return filtered;
}

function assembleBrowserContext(browserCtx: BrowserContext): string {
  try {
    return browserTools.getBrowserState(browserCtx);
  } catch {
    return '(unavailable)';
  }
}

const SUB_AGENT_BASE_PROMPT = `You are a Tappi sub-agent — a focused worker with a LIMITED step budget.

## Core Rules
1. **Scope**: Only do what you were assigned. Do not expand scope.
2. **Efficiency**: grep > scroll > read-all. Every tool call costs a step.
3. **Tab**: You have ONE dedicated browser tab. Use ONLY that tab.
4. **Done**: When you have a good answer, stop. Quality over volume.

## Page Interaction
The page is a black box until you query it:
- \`elements()\` → see clickable items (returns numbered indexes)
- \`click({ index: N })\` or \`type({ index: N, text: "..." })\` → interact
- \`text({ grep: "keyword" })\` → read content without screenshots
- **After navigation or page changes, indexes shift — call elements() again**

## Error Recovery
- "Element not found" or wrong index → call elements() again (indexes shift after page changes)
- "Tab not found" → you only have ONE tab, stay in it
- Tool failed? Try a different approach — don't repeat the same action 3 times
- Stuck? Summarize what you found and stop — partial results are valuable

## Output
When finished, provide:
- 2-3 sentence summary of what you found/did
- Key details with sources (for research) or files touched (for coding)
- Then STOP — do not keep searching after you have a good answer

## Problem-Solving Framework
1. **Understand**: Re-read your assignment. What's the exact deliverable?
2. **Plan**: Map 2-3 approaches. Pick the one that fits your step budget.
3. **Execute**: Work efficiently. Save progress incrementally (files, synthesis).
4. **Verify**: Did you complete the assignment? If not, summarize what's missing.
5. **Report**: Your lead needs a clear answer. Format: summary + key findings + sources/files.

Skip this for trivial lookups. Use it for research, coding, or multi-step tasks.

${TOOL_USAGE_GUIDE}
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
