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

import { generateText, stepCountIs } from 'ai';
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
  taskType: TaskType;       // classified task type
  contract: string;         // system prompt scaffolding for this task type
  status: 'running' | 'completed' | 'failed';
  sessionId: string;
  assignedTabId?: string;   // dedicated browser tab for this sub-agent
  result?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  toolsUsed: string[];
}

export type TaskType = 'research' | 'coding' | 'story-writing' | 'normal';

// Active sub-agents (limit enforced)
const MAX_CONCURRENT = 5;
const activeAgents = new Map<string, SubAgentTask>();
let agentCounter = 0;

// ─── Task Classifier ───

/**
 * Classify a task as research, coding, story-writing, or normal.
 * Called for each incoming user message to decide whether to spawn sub-agents.
 */
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
    if (msg.includes(kw)) researchScore++;
  }
  for (const kw of codingKeywords) {
    if (msg.includes(kw)) codingScore++;
  }
  for (const kw of storyKeywords) {
    if (msg.includes(kw)) storyScore++;
  }

  // Multi-file / complexity signals boost coding
  if (/\b(files?|modules?|services?|pages?|components?)\b/.test(msg)) codingScore++;
  if (/\b(multiple|several|various|all the)\b/.test(msg)) {
    researchScore += 0.5;
    codingScore += 0.5;
  }

  const maxScore = Math.max(researchScore, codingScore, storyScore);

  // Must meet a minimum threshold to warrant sub-agents
  if (maxScore < 1) return 'normal';

  if (storyScore === maxScore && storyScore > 0) return 'story-writing';
  if (codingScore === maxScore && codingScore > 0) return 'coding';
  if (researchScore === maxScore && researchScore > 0) return 'research';

  return 'normal';
}

// ─── Contract/Scaffolding Templates ───

const RESEARCH_CONTRACT = `## Sub-Agent Contract: Research

You are a research sub-agent. Your ONE job is the specific research task assigned to you.

### How to Research (follow this loop)
1. **search("your query")** → Google search results appear
2. **elements()** → see clickable search result links
3. **click(N)** → click a promising result to open the page
4. **text()** → read the full page content and extract key information
5. **Repeat** steps 1-4 for 3-5 different sources
6. **file_write** → save your compiled findings to ~/tappi-workspace/

⚠️ **CRITICAL**: You MUST call text() after navigating to each page to actually READ it.
Just navigating to a URL gives you nothing. The page is a black box until you call text().

### Rules
1. **Scope**: Only research what you were assigned. Do not expand scope.
2. **Depth**: Find 3-5 high-quality sources. Extract specific facts, quotes, data points, and trends.
3. **Do NOT stop early**. If you've only visited 1-2 pages, keep going. Aim for 3-5 sources minimum.
4. **Tab**: You have ONE dedicated browser tab. Use ONLY that tab.
5. **Done**: When finished, your final text output must contain all your findings in full.

### Output Format
- 2-3 sentence executive summary
- Detailed bullet-point findings organized by subtopic
- Source URLs for every claim
- Gaps or conflicting information flagged
- MUST be at least 500 words. Thin outputs are useless.
`;

const CODING_CONTRACT = `## Sub-Agent Contract: Coding

You are a coding sub-agent. Your ONE job is the specific coding task assigned to you.

### Rules
1. **Scope**: Implement only what you were assigned. Do not modify unrelated files.
2. **Contracts First**: Read any shared contracts/interfaces before writing code.
3. **Quality**: Write clean, typed, testable code. Match existing code style.
4. **Files**: Work in your assigned working directory. List files before reading.
5. **Tests**: If the task involves testable code, include basic tests.
6. **Tab**: You have ONE dedicated browser tab (for docs lookup only). Stay on task.
7. **Done**: When finished, state "CODING COMPLETE:" and list every file you touched.

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
5. **Files**: Save your output to ~/tappi-workspace/ with your agent ID in the name.
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

export async function spawnSubAgent(
  task: string,
  browserCtx: BrowserContext,
  llmConfig: LLMConfig,
  parentSessionId: string,
  modelPurpose: 'primary' | 'secondary' = 'secondary',
  taskType?: TaskType,
  onProgress?: SubAgentProgressCallback,
): Promise<string> {
  // Check concurrency limit
  const running = Array.from(activeAgents.values()).filter(a => a.status === 'running');
  if (running.length >= MAX_CONCURRENT) {
    return `❌ Max ${MAX_CONCURRENT} concurrent sub-agents. Running: ${running.map(a => a.id).join(', ')}. Wait for one to finish or check status.`;
  }

  const id = `sub-${++agentCounter}`;
  const sessionId = `${parentSessionId}:${id}`;
  const resolvedType = taskType || 'normal';
  const contract = getContractForTaskType(resolvedType);

  // Auto-promote lightweight models for research tasks.
  // Models like Haiku can navigate but can't effectively plan multi-step browsing
  // research — they burn through steps producing thin results.
  let effectivePurpose = modelPurpose;
  if (resolvedType === 'research' && modelPurpose === 'secondary') {
    const secondaryConfig = getModelConfig('secondary', llmConfig);
    if (isLightweightModel(secondaryConfig)) {
      effectivePurpose = 'primary';
      console.log(`[sub-agent] ${id} auto-promoted to primary model — ${secondaryConfig.model} too lightweight for research`);
    }
  }

  // Allocate a dedicated browser tab for this sub-agent
  let assignedTabId: string | undefined;
  try {
    if (browserCtx.tabManager) {
      assignedTabId = browserCtx.tabManager.createTab('about:blank', undefined, { background: true });
      console.log(`[sub-agent] ${id} allocated tab: ${assignedTabId}`);
    }
  } catch (e) {
    console.warn(`[sub-agent] ${id} failed to allocate tab:`, e);
  }

  const agentTask: SubAgentTask = {
    id,
    task,
    taskType: resolvedType,
    contract,
    status: 'running',
    sessionId,
    assignedTabId,
    startedAt: Date.now(),
    toolsUsed: [],
  };
  activeAgents.set(id, agentTask);

  // Resolve the appropriate model config
  const resolvedConfig = getModelConfig(effectivePurpose, llmConfig);

  // Await the sub-agent to completion and return full results.
  // The AI SDK executes parallel tool calls concurrently, so multiple
  // spawn_agent calls in the same step all run in parallel automatically.
  // Emit initial progress event — sub-agent spawned
  if (onProgress) {
    onProgress({ agentId: id, taskType: resolvedType, step: 0, tools: [], status: 'running', elapsed: 0, done: false });
  }

  try {
    await runSubAgent(agentTask, browserCtx, resolvedConfig, onProgress);
  } catch (err: any) {
    agentTask.status = 'failed';
    agentTask.error = err?.message || 'Unknown error';
    agentTask.finishedAt = Date.now();
    releaseSubAgentTab(agentTask, browserCtx);
  }

  const duration = ((agentTask.finishedAt || Date.now()) - agentTask.startedAt) / 1000;

  // Emit final progress event — sub-agent finished
  if (onProgress) {
    onProgress({
      agentId: id, taskType: resolvedType, step: agentTask.toolsUsed.length,
      tools: [...new Set(agentTask.toolsUsed)], status: agentTask.status as any,
      elapsed: duration * 1000, done: true,
    });
  }

  if (agentTask.status === 'completed') {
    return `✅ ${id} [${resolvedType}] completed in ${duration.toFixed(1)}s\n\n${agentTask.result || '(no output)'}`;
  } else {
    return `❌ ${id} [${resolvedType}] failed after ${duration.toFixed(1)}s: ${agentTask.error || 'Unknown error'}`;
  }
}

// ─── Status ───

export function getSubAgentStatus(id?: string): string {
  if (id) {
    const agent = activeAgents.get(id);
    if (!agent) return `Sub-agent "${id}" not found.`;

    const duration = ((agent.finishedAt || Date.now()) - agent.startedAt) / 1000;
    const lines = [
      `${agent.id} [${agent.taskType}]: ${agent.status === 'running' ? '⏳ running' : agent.status === 'completed' ? '✓ completed' : '✗ failed'} (${duration.toFixed(1)}s)`,
      `Task: ${agent.task}`,
      `Tab: ${agent.assignedTabId || 'none'}`,
    ];
    if (agent.toolsUsed.length > 0) lines.push(`Tools used: ${[...new Set(agent.toolsUsed)].join(', ')}`);
    if (agent.result) {
      // For completed agents, return full result (up to 4000 chars) so the
      // main agent can synthesize properly. Running agents get truncated preview.
      const maxLen = agent.status === 'completed' ? 4000 : 500;
      lines.push(`Result: ${agent.result.length > maxLen ? agent.result.slice(0, maxLen) + `... (${agent.result.length} chars total)` : agent.result}`);
    }
    if (agent.error) lines.push(`Error: ${agent.error}`);
    return lines.join('\n');
  }

  // List all
  if (activeAgents.size === 0) return 'No sub-agents.';

  return Array.from(activeAgents.values()).map(a => {
    const status = a.status === 'running' ? '⏳' : a.status === 'completed' ? '✓' : '✗';
    const duration = ((a.finishedAt || Date.now()) - a.startedAt) / 1000;
    return `${status} ${a.id} [${a.taskType}]: ${a.task.slice(0, 60)}${a.task.length > 60 ? '...' : ''} (${duration.toFixed(1)}s)`;
  }).join('\n');
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

    const systemPrompt = contract
      ? `${SUB_AGENT_BASE_PROMPT}\n\n${contract}`
      : SUB_AGENT_BASE_PROMPT;

    const providerOptions = buildProviderOptions(llmConfig);

    // Use generateText (non-streaming) with maxSteps instead of streamText.
    // streamText's multi-step loop via OpenRouter silently drops tool calls
    // after the first round-trip, causing sub-agents to bail after 1 search.
    // generateText parses complete responses and handles multi-step reliably.
    const MAX_STEPS = 60;

    const result = await generateText({
      model,
      system: systemPrompt,
      messages: [
        { role: 'user' as const, content: `[Browser: ${browserContext}]${tabNote}\n\n${task}` },
      ],
      tools,
      maxOutputTokens: 32768,
      ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
      stopWhen: stepCountIs(MAX_STEPS),
      onStepFinish: async (event: any) => {
        try {
          const toolCalls = event.toolCalls || [];
          const toolResults = event.toolResults || [];
          const stepNum = event.stepNumber ?? '?';
          const finishReason = event.finishReason ?? 'n/a';
          const textLen = event.text?.length ?? 0;
          console.log(`[sub-agent] ${agentTask.id} step ${stepNum}: finish=${finishReason}, calls=${toolCalls.length}, results=${toolResults.length}, text=${textLen} chars`);

          const stepToolNames: string[] = [];
          let stepUrl: string | undefined;

          for (const tr of toolResults) {
            const toolName = tr.toolName || 'unknown';
            agentTask.toolsUsed.push(toolName);
            stepToolNames.push(toolName);
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
              step: typeof stepNum === 'number' ? stepNum : parseInt(stepNum, 10) || 0,
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
      },
    });

    const fullResponse = result.text || '';
    console.log(`[sub-agent] ${agentTask.id} complete: ${fullResponse.length} chars, ${agentTask.toolsUsed.length} tool calls, ${result.steps?.length ?? 0} steps`);

    // Validate result quality
    const rawResult = fullResponse || `Used ${agentTask.toolsUsed.length} tools: ${[...new Set(agentTask.toolsUsed)].join(', ')}`;
    const MIN_RESEARCH_CHARS = 200;
    if (agentTask.taskType === 'research' && rawResult.length < MIN_RESEARCH_CHARS) {
      agentTask.result = `⚠️ THIN RESULT (${rawResult.length} chars — expected ${MIN_RESEARCH_CHARS}+). The sub-agent may have failed to extract meaningful content.\n\n${rawResult}`;
      console.warn(`[sub-agent] ${agentTask.id} produced thin research result: ${rawResult.length} chars`);
    } else {
      agentTask.result = rawResult;
    }
    agentTask.status = 'completed';

  } catch (err: any) {
    console.error(`[sub-agent] ${agentTask.id} FAILED:`, err?.message || err);
    agentTask.status = 'failed';
    agentTask.error = err?.message || 'Unknown error';
  } finally {
    agentTask.finishedAt = Date.now();

    // Restore the agent target to what it was before this sub-agent ran
    if (browserCtx.tabManager) {
      browserCtx.tabManager.setAgentTarget(savedAgentTarget);
    }

    // Release the dedicated tab
    releaseSubAgentTab(agentTask, browserCtx);

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

const SUB_AGENT_BASE_PROMPT = `You are a Tappi sub-agent — a focused worker spawned by the main agent to complete a specific task.

You have access to all the same tools as the main agent: browser, files, HTTP, shell (if dev mode is on).

Core rules:
1. Focus on the task you were given. Don't go off track.
2. Be efficient — use grep/search before reading/scrolling.
3. You have ONE dedicated browser tab. Work only in that tab. Do not open or switch to other tabs.
4. When done, summarize what you accomplished clearly and concisely.
5. If you hit a blocker you can't resolve, explain clearly what's blocking you.

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
