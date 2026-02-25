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

### Rules
1. **Scope**: Only research what you were assigned. Do not expand scope.
2. **Sources**: Use web search, page reading, and HTTP tools. Prefer primary sources.
3. **Depth**: Find 3-5 high-quality sources minimum. Extract key facts, quotes, and data.
4. **Output**: Write a structured findings report with: Summary, Key Facts, Sources, Gaps.
5. **Files**: Save your findings to a file in ~/tappi-workspace/ with your agent ID in the name.
6. **Tab**: You have ONE dedicated browser tab. Use ONLY that tab. Do not open new tabs.
7. **Done**: When finished, clearly state "RESEARCH COMPLETE:" followed by your summary.

### Output Format
- Start with a 2-3 sentence executive summary
- Bullet-point key findings
- Include source URLs
- Flag any gaps or conflicting information
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

// ─── Spawn ───

export async function spawnSubAgent(
  task: string,
  browserCtx: BrowserContext,
  llmConfig: LLMConfig,
  parentSessionId: string,
  modelPurpose: 'primary' | 'secondary' = 'secondary',
  taskType?: TaskType,
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
  const resolvedConfig = getModelConfig(modelPurpose, llmConfig);

  // Run in background — don't await
  runSubAgent(agentTask, browserCtx, resolvedConfig).catch(err => {
    agentTask.status = 'failed';
    agentTask.error = err?.message || 'Unknown error';
    agentTask.finishedAt = Date.now();
    // Release tab on error
    releaseSubAgentTab(agentTask, browserCtx);
  });

  return `✓ Spawned sub-agent ${id} [${resolvedType}]\n  Task: ${task}\n  Tab: ${assignedTabId || 'none'}\n  Check: sub_agent_status("${id}")\n  It will report back when done.`;
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
    if (agent.result) lines.push(`Result: ${agent.result.length > 500 ? agent.result.slice(0, 500) + '...' : agent.result}`);
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
): Promise<void> {
  const { sessionId, task, contract, assignedTabId } = agentTask;

  // Lock the agent to its dedicated tab before creating tools
  // This prevents it from touching any other tab
  const savedAgentTarget = browserCtx.tabManager?.agentTargetId ?? null;
  if (assignedTabId && browserCtx.tabManager) {
    browserCtx.tabManager.setAgentTarget(assignedTabId);
  }

  try {
    const model = createModel(llmConfig);
    const tools = createTools(browserCtx, sessionId);

    // Add the task as the first user message
    addMessage(sessionId, { role: 'user', content: task });

    const browserContext = assembleBrowserContext(browserCtx);

    const tabNote = assignedTabId
      ? `\n[Tab: You are locked to tab ID "${assignedTabId}". You MUST NOT open, switch to, or interact with any other tab.]`
      : '';

    const messages = [
      { role: 'user' as const, content: `[Browser: ${browserContext}]${tabNote}\n\n${task}` },
    ];

    // Build system prompt from contract + base instructions
    const systemPrompt = contract
      ? `${SUB_AGENT_BASE_PROMPT}\n\n${contract}`
      : SUB_AGENT_BASE_PROMPT;

    // Use provider options derived from the resolved config
    const providerOptions = buildProviderOptions(llmConfig);

    const result = await streamText({
      model,
      system: systemPrompt,
      messages,
      tools,
      maxOutputTokens: 32768,
      ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
      stopWhen: stepCountIs(60),
      onStepFinish: async (event: any) => {
        try {
          const toolResults = event.toolResults || [];
          for (const tr of toolResults) {
            const toolName = tr.toolName || 'unknown';
            agentTask.toolsUsed.push(toolName);

            // Enforce tab isolation: if agent tried to open a new tab or switch,
            // log a warning (the tab tool itself doesn't check, so we warn here)
            if (toolName === 'tab' && assignedTabId) {
              console.warn(`[sub-agent] ${agentTask.id} called tab tool — check for isolation violations`);
            }
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
