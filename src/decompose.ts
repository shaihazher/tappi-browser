/**
 * decompose.ts — Task decomposition for Deep Mode.
 *
 * Two modes, auto-detected by the LLM:
 * 1. **Action Deep** — multi-step browser/system tasks (fill forms, deploy, etc.)
 *    Ends with the action itself. No compile step.
 * 2. **Research Deep** — gather info across multiple sources, compile a report.
 *    Fixed N subtopics (default 5), each visits 3 URLs, ends with compilation.
 *
 * Inspired by tappi Python's decompose.py + research.py.
 */

import { generateText } from 'ai';
import { createModel, type LLMConfig } from './llm-client';

// ── Data Types ──

export interface Subtask {
  task: string;
  tool: string;     // "browser" | "files" | "shell" | "http" | "compile"
  output: string;   // filename like "step_1_results.md"
  index: number;
  total: number;
  status: 'pending' | 'running' | 'done' | 'failed';
  result?: string;
  duration?: number;
  error?: string;
  /** DAG: indices of steps that must complete before this one starts.
   *  Empty array = independent (can run in parallel with others).
   *  Omitted = fall back to sequential ordering. */
  depends_on?: number[];
}

export interface DecompositionResult {
  mode: 'action' | 'research';
  subtasks: Subtask[];
}

// ── Prompts ──

function today(): string {
  return new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

const DECOMPOSE_PROMPT = `You are a task decomposition planner. Today is {today}.

Given a user task, decide:
1. If it's **simple** (answerable directly, single tool call, or conversational), return: {{"simple": true}}
2. If it's **complex**, decide the MODE and decompose.

## Modes

**"action"** — Multi-step tasks where the goal is to DO something (fill forms, deploy code, send emails, make purchases, configure settings, post content). Each step is an action. The last step IS the final action — no compilation needed.

**"research"** — Tasks where the goal is to LEARN something (compare products, analyze markets, investigate topics, find information across multiple sources). Each step gathers info from different sources. The last step compiles all findings into a structured report.

## Response Format

For simple tasks:
\`\`\`json
{{"simple": true}}
\`\`\`

For complex tasks:
\`\`\`json
{{
  "mode": "action" | "research",
  "subtasks": [
    {{"task": "Detailed description with enough context to execute independently", "tool": "browser|files|shell|http", "output": "step_1_description.md", "depends_on": []}},
    ...
  ]
}}
\`\`\`

## Rules
- 3-7 subtasks max (rarely 10). Be concise.
- Each subtask's "task" must be self-contained — include enough context to execute without seeing the original query.
- For **research** mode: end with a compile step ({{"task": "Compile all findings...", "tool": "compile", "output": "final_report.md"}}).
- For **action** mode: do NOT add a compile step. The last subtask is the final action.
- If the task mixes research + action (e.g. "find plumbers and email the list"), the final step should be the ACTION, mode = "action".

## Dependency Graph (action mode)
For **action** mode, use the \`depends_on\` field (array of 0-based step indices) to declare which prior steps must complete before this one:
- \`"depends_on": []\` — step is **independent**, can run in parallel with other independent steps.
- \`"depends_on": [0]\` — step must wait for step 0 to finish.
- \`"depends_on": [0, 2]\` — step must wait for steps 0 AND 2 to finish.

Assign \`depends_on\` thoughtfully:
- Steps that gather independent information in parallel → \`depends_on: []\`
- Steps that act on results of prior steps → list those step indices
- When in doubt, depend on the previous step (conservative/sequential)
- The LAST step typically depends on all prior steps if it needs their outputs.

User task: {task}`;

const RESEARCH_DECOMPOSE_PROMPT = `You are a research planner. Today is {today}.

Given a research query, decompose it into exactly {n} focused subtopics that together comprehensively cover the topic.

Each subtopic should:
- Be specific enough to research in one focused search session
- Cover a different angle/aspect of the main query
- Be independently researchable

Return a JSON array of {n} objects:
- "subtopic": Concise title
- "task": Detailed research instructions (what to search for, what to find)

Research query: {query}`;

// ── Subtask System Prompts ──

export const SUBTASK_SYSTEM_PROMPT = `You are a focused agent. Today is {today}.

You have ONE job: complete the task below.

Your workspace is: {workspace}

## Rules
- Stay focused — do NOT go on tangents.
- Be EFFICIENT. Aim for under 10 tool calls total.
- The page is a black box — use elements/text tools to see it.
- Use grep to find specific things (don't scroll through everything).
- If the task is **research/gathering**: collect info, then write your findings as your final text response. Include source URLs.
- If the task is an **action** (send email, fill form, click button, post content): COMPLETE THE ACTION. Verify it succeeded. Your final text response confirms what you did.
- Your final text response IS your output — do NOT call any file write tool.
- If prior subtask outputs exist as files in your workspace, read them when referenced.
`;

export const RESEARCH_SUBTASK_SYSTEM_PROMPT = `You are a focused web researcher. Today is {today}.

Your workspace is: {workspace}

## Research Workflow
1. Use search tool to Google your topic.
2. From the results, pick exactly 3 URLs that look most relevant.
3. For each URL: navigate to it, read its content with text tool, extract key findings.
4. After visiting all 3 URLs, STOP browsing and write your report as your final text response.

## Key Rules
- You MUST visit exactly 3 URLs (not more, not less).
- Use text() to read page content, grep to find specific info.
- Do NOT call any file write tool — your text response IS your output.
- Include source URLs as citations.
- Write detailed findings with data, stats, and key takeaways.
- Be efficient — don't waste tool calls.
`;

export const COMPILE_SYSTEM_PROMPT = `You are a report compiler. Today is {today}.

## Original Task
{original_task}

## Subtask Reports
{subtask_reports}

## Instructions
Compile the subtask reports above into a comprehensive, well-structured final report.

The report should:
1. Start with an executive summary
2. Organize findings into logical sections
3. Highlight key insights and conclusions
4. Include all source URLs in a References section
5. Note any conflicting information across sources

Use markdown. Be thorough but readable.
`;

// ── LLM Helpers ──

async function callLLM(prompt: string, llmConfig: LLMConfig, maxTokens: number = 4096): Promise<string> {
  const model = createModel(llmConfig);
  const { text } = await generateText({
    model,
    prompt,
    maxOutputTokens: maxTokens,
  });
  return text || '';
}

// ── Decomposition ──

/**
 * Decompose a task into subtasks.
 * Returns null if the task is simple (should use direct agent loop).
 */
export async function decomposeTask(task: string, llmConfig: LLMConfig): Promise<DecompositionResult | null> {
  const prompt = DECOMPOSE_PROMPT
    .replace('{today}', today())
    .replace('{task}', task);

  const response = await callLLM(prompt, llmConfig);
  return parseDecomposition(response);
}

/**
 * Decompose a research query into fixed subtopics + compilation step.
 * Always returns subtasks (never null — research mode is explicit).
 */
export async function decomposeResearch(query: string, llmConfig: LLMConfig, numTopics: number = 5): Promise<DecompositionResult> {
  const prompt = RESEARCH_DECOMPOSE_PROMPT
    .replace('{today}', today())
    .replace('{n}', String(numTopics))
    .replace('{query}', query);

  const response = await callLLM(prompt, llmConfig);
  const subtopics = parseSubtopics(response);

  // Ensure we have enough subtopics
  const topics = subtopics.length >= numTopics
    ? subtopics.slice(0, numTopics)
    : Array.from({ length: numTopics }, (_, i) => ({
        subtopic: `Aspect ${i + 1}`,
        task: `Research aspect ${i + 1} of: ${query}`,
      }));

  const total = numTopics + 1; // subtopics + compile
  const subtasks: Subtask[] = topics.map((st, i) => ({
    task: st.task,
    tool: 'browser',
    output: `findings_${i + 1}.md`,
    index: i,
    total,
    status: 'pending' as const,
  }));

  // Add compilation step
  const fileList = topics.map((_, i) => `findings_${i + 1}.md`).join(', ');
  subtasks.push({
    task: `Compile all ${numTopics} research findings (${fileList}) into a final report`,
    tool: 'compile',
    output: 'final_report.md',
    index: numTopics,
    total,
    status: 'pending',
  });

  return { mode: 'research', subtasks };
}

// ── Parsing ──

function parseDecomposition(text: string): DecompositionResult | null {
  // Try to extract JSON from markdown code block or raw JSON
  let raw: string | null = null;

  // Code block
  const cbMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\}|\[[\s\S]*?\])\s*```/);
  if (cbMatch) raw = cbMatch[1];

  // Bare simple object
  if (!raw) {
    const simpleMatch = text.match(/(\{[^{}]*"simple"[^{}]*\})/);
    if (simpleMatch) raw = simpleMatch[1];
  }

  // Bare JSON with mode
  if (!raw) {
    const modeMatch = text.match(/(\{[\s\S]*"mode"[\s\S]*"subtasks"[\s\S]*\})/);
    if (modeMatch) raw = modeMatch[1];
  }

  // Bare array (legacy format)
  if (!raw) {
    const arrMatch = text.match(/(\[[\s\S]*\])/);
    if (arrMatch) raw = arrMatch[1];
  }

  if (!raw) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  // Simple task
  if (parsed?.simple) return null;

  // New format: { mode, subtasks }
  if (parsed?.mode && Array.isArray(parsed.subtasks) && parsed.subtasks.length >= 2) {
    const mode = parsed.mode === 'research' ? 'research' : 'action';
    const total = parsed.subtasks.length;
    const subtasks: Subtask[] = parsed.subtasks.map((item: any, i: number) => {
      const st: Subtask = {
        task: item.task || '',
        tool: item.tool || 'browser',
        output: item.output || `step_${i + 1}.md`,
        index: i,
        total,
        status: 'pending',
      };
      // Preserve depends_on if present and valid (array of numbers)
      if (Array.isArray(item.depends_on) && item.depends_on.every((d: any) => typeof d === 'number')) {
        st.depends_on = item.depends_on.filter((d: number) => d >= 0 && d < i); // only backward refs
      }
      return st;
    });
    return { mode, subtasks };
  }

  // Legacy format: bare array of subtask objects
  if (Array.isArray(parsed) && parsed.length >= 2) {
    const total = parsed.length;
    const hasCompile = parsed.some((s: any) => s.tool === 'compile');
    const mode = hasCompile ? 'research' : 'action';
    const subtasks: Subtask[] = parsed.map((item: any, i: number) => {
      const st: Subtask = {
        task: item.task || '',
        tool: item.tool || 'browser',
        output: item.output || `step_${i + 1}.md`,
        index: i,
        total,
        status: 'pending',
      };
      if (Array.isArray(item.depends_on) && item.depends_on.every((d: any) => typeof d === 'number')) {
        st.depends_on = item.depends_on.filter((d: number) => d >= 0 && d < i);
      }
      return st;
    });
    return { mode, subtasks };
  }

  return null;
}

function parseSubtopics(text: string): Array<{ subtopic: string; task: string }> {
  // Code block
  const cbMatch = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  if (cbMatch) {
    try { return JSON.parse(cbMatch[1]); } catch {}
  }
  // Bare array
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[0]); } catch {}
  }
  return [];
}

// ── Run Directory Naming ──

export function makeRunDirname(task: string): string {
  const clean = task.toLowerCase().replace(/[^a-zA-Z0-9\s]/g, '');
  const fillers = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'my', 'me', 'is', 'it']);
  let words = clean.split(/\s+/).filter(w => !fillers.has(w));
  if (words.length === 0) words = clean.split(/\s+/).slice(0, 3);
  const slug = words.slice(0, 5).join('-') || 'task';

  const now = new Date();
  const hour = now.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true }).toLowerCase().replace(' ', '');
  const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase().replace(' ', '-');

  return `${slug}-${dateStr}-${hour}`;
}
