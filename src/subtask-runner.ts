/**
 * subtask-runner.ts — Sequential subtask executor for Deep Mode.
 *
 * Browsing/action subtasks: mini-agent with tools → text response = output.
 * Compile subtask: single streaming LLM call → text = output.
 * All outputs saved to disk by the runner, not by the agents.
 * Progress events emitted to main window via IPC.
 */

import { streamText, generateText } from 'ai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { BrowserWindow } from 'electron';
import { createModel, buildProviderOptions, getModelConfig, type LLMConfig } from './llm-client';
import { createTools } from './tool-registry';
import * as browserTools from './browser-tools';
import type { BrowserContext } from './browser-tools';
import { addMessage, getWindow, getFullHistory, clearHistory, type ChatMessage } from './conversation';
import { purgeSession } from './output-buffer';
import { cleanupSession } from './shell-tools';
import {
  type Subtask,
  type DecompositionResult,
  SUBTASK_SYSTEM_PROMPT,
  RESEARCH_SUBTASK_SYSTEM_PROMPT,
  COMPILE_SYSTEM_PROMPT,
  makeRunDirname,
} from './decompose';

// ── Types ──

export interface SubtaskRunnerOptions {
  decomposition: DecompositionResult;
  originalTask: string;
  browserCtx: BrowserContext;
  llmConfig: LLMConfig;
  window: BrowserWindow;
  sessionId: string;
  developerMode?: boolean;
  codingMode?: boolean;           // BUG-T13: forward coding mode into subtask tool creation
  agentBrowsingDataAccess?: boolean;
  abortSignal?: AbortSignal;
}

export interface DeepRunResult {
  subtasks: Subtask[];
  finalOutput: string;
  outputDir: string;
  durationSeconds: number;
  aborted: boolean;
  mode: 'action' | 'research';
}

// ── Runner ──

export async function runDeepMode(opts: SubtaskRunnerOptions): Promise<DeepRunResult> {
  const {
    decomposition,
    originalTask,
    browserCtx,
    llmConfig,
    window: mainWindow,
    sessionId,
    developerMode = false,
    codingMode = false,           // BUG-T13
    agentBrowsingDataAccess = false,
    abortSignal,
  } = opts;

  const { mode, subtasks } = decomposition;
  const start = Date.now();

  // Create run directory
  const workspace = path.join(os.homedir(), 'tappi-workspace');
  const runDir = path.join(workspace, 'deep-runs', makeRunDirname(originalTask));
  fs.mkdirSync(runDir, { recursive: true });

  // Send plan to UI
  mainWindow.webContents.send('agent:deep-plan', {
    mode,
    subtasks: subtasks.map(s => ({ task: s.task, tool: s.tool, output: s.output, index: s.index, total: s.total })),
  });

  let finalOutput = '';

  for (const subtask of subtasks) {
    if (abortSignal?.aborted) {
      subtask.status = 'failed';
      subtask.error = 'Aborted';
      mainWindow.webContents.send('agent:deep-subtask-done', {
        index: subtask.index, status: 'failed', duration: 0, error: 'Aborted',
      });
      continue;
    }

    const subtaskStart = Date.now();
    subtask.status = 'running';
    mainWindow.webContents.send('agent:deep-subtask-start', {
      index: subtask.index, task: subtask.task, tool: subtask.tool,
    });

    try {
      let result: string;

      if (subtask.tool === 'compile') {
        // Compile step uses primary model — final synthesis needs full reasoning (Phase 8.85)
        result = await runCompileStep(subtask, subtasks, runDir, originalTask, mode, llmConfig, mainWindow);
      } else {
        // Execution subtasks use secondary model — simpler work (Phase 8.85)
        const secondaryConfig = getModelConfig('secondary', llmConfig);
        result = await runBrowsingSubtask(subtask, subtasks, runDir, browserCtx, secondaryConfig, mainWindow, sessionId, developerMode, mode, agentBrowsingDataAccess, codingMode);
      }

      // Save output to disk
      const outputPath = path.join(runDir, subtask.output);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, result || `# Step ${subtask.index + 1}\n\n*No output produced.*\n`);

      subtask.status = 'done';
      subtask.result = result;
      subtask.duration = (Date.now() - subtaskStart) / 1000;
      finalOutput = result; // Last completed step is the final output

      mainWindow.webContents.send('agent:deep-subtask-done', {
        index: subtask.index, status: 'done', duration: subtask.duration,
      });

    } catch (err: any) {
      subtask.status = 'failed';
      subtask.error = err?.message || 'Unknown error';
      subtask.duration = (Date.now() - subtaskStart) / 1000;

      // Save error to disk
      const outputPath = path.join(runDir, subtask.output);
      fs.writeFileSync(outputPath, `# Step ${subtask.index + 1} — FAILED\n\n${subtask.error}\n`);

      mainWindow.webContents.send('agent:deep-subtask-done', {
        index: subtask.index, status: 'failed', duration: subtask.duration, error: subtask.error,
      });
    }
  }

  const totalDuration = (Date.now() - start) / 1000;
  const relDir = path.relative(workspace, runDir);

  return {
    subtasks,
    finalOutput,
    outputDir: relDir,
    durationSeconds: totalDuration,
    aborted: abortSignal?.aborted || false,
    mode,
  };
}

// ── Browsing/Action Subtask ──

async function runBrowsingSubtask(
  subtask: Subtask,
  allSubtasks: Subtask[],
  runDir: string,
  browserCtx: BrowserContext,
  llmConfig: LLMConfig,
  mainWindow: BrowserWindow,
  parentSessionId: string,
  developerMode: boolean,
  mode: 'action' | 'research',
  agentBrowsingDataAccess = false,
  codingMode = false,             // BUG-T13: receive and forward coding mode
): Promise<string> {
  const subSessionId = `deep:${parentSessionId}:step-${subtask.index}`;

  try {
    const model = createModel(llmConfig);
    // BUG-T13: pass codingMode so team tools are available in subtasks when coding mode is on
    const tools = createTools(browserCtx, subSessionId, { developerMode, llmConfig, codingMode, agentBrowsingDataAccess });

    // Build system prompt
    const todayStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const workspace = path.join(os.homedir(), 'tappi-workspace');
    let systemPrompt: string;

    if (mode === 'research' && subtask.tool === 'browser') {
      systemPrompt = RESEARCH_SUBTASK_SYSTEM_PROMPT
        .replace('{today}', todayStr)
        .replace('{workspace}', workspace);
    } else {
      systemPrompt = SUBTASK_SYSTEM_PROMPT
        .replace('{today}', todayStr)
        .replace('{tool}', subtask.tool)
        .replace('{workspace}', workspace);
    }

    // Build task prompt with references to prior step outputs
    let taskPrompt = subtask.task;

    if (subtask.index > 0) {
      const priorFiles: string[] = [];
      for (const st of allSubtasks.slice(0, subtask.index)) {
        const p = path.join(runDir, st.output);
        if (fs.existsSync(p)) priorFiles.push(p);
      }
      if (priorFiles.length > 0) {
        taskPrompt += `\n\nPrior step outputs are at:\n${priorFiles.map(p => `- ${p}`).join('\n')}\nRead these files if your task references prior steps.`;
      }
    }

    // Get browser context
    let browserState = '(unavailable)';
    try { browserState = browserTools.getBrowserState(browserCtx); } catch {}

    // Add user message
    addMessage(subSessionId, { role: 'user', content: taskPrompt });

    const messages: ChatMessage[] = [
      { role: 'user', content: `[Browser: ${browserState}]\n\n${taskPrompt}` },
    ];

    const providerOptions = buildProviderOptions(llmConfig);

    const toolsUsed: string[] = [];

    // Phase 8.40: Timeout-based execution — no step limit
    const subtaskTimeoutMs = llmConfig.subtaskTimeoutMs ?? 300_000; // default 5 min
    const subtaskStart = Date.now();
    let subtaskTimedOut = false;
    const subtaskAbortController = new AbortController();
    const subtaskTimeoutHandle = setTimeout(() => {
      subtaskTimedOut = true;
      subtaskAbortController.abort();
    }, subtaskTimeoutMs);

    const result = streamText({
      model,
      system: systemPrompt,
      messages: messages as any,
      tools,
      ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
      // No stopWhen — runs until model stops or timeout (Phase 8.40)
      abortSignal: subtaskAbortController.signal,
      onStepFinish: async (event: any) => {
        try {
          const toolResults = event.toolResults || [];
          for (const tr of toolResults) {
            const toolName = tr.toolName || 'unknown';
            toolsUsed.push(toolName);
            const rawOutput = tr.output ?? tr.result ?? '';
            const resultStr = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput) ?? '';
            const display = `🔧 ${toolName}${resultStr.length > 150 ? '\n' + resultStr.slice(0, 150) + '...' : resultStr.length > 40 ? '\n' + resultStr : ' → ' + resultStr}`;
            mainWindow.webContents.send('agent:deep-tool-result', {
              index: subtask.index, toolName, display,
            });
          }
        } catch {}
      },
    });

    // Stream text chunks to UI
    let fullResponse = '';
    try {
      for await (const chunk of result.textStream) {
        fullResponse += chunk;
        mainWindow.webContents.send('agent:deep-stream-chunk', {
          index: subtask.index, chunk,
        });
      }
    } catch (streamErr: any) {
      if (streamErr?.name === 'AbortError' && subtaskTimedOut) {
        // Graceful timeout: preserve partial output + append notice
        const elapsed = Date.now() - subtaskStart;
        const min = Math.floor(elapsed / 60000);
        const sec = Math.floor((elapsed % 60000) / 1000);
        const durStr = min > 0 ? `${min}m ${sec}s` : `${sec}s`;
        const notice = `\n\n---\n⏰ *Subtask timed out after ${durStr}. ${toolsUsed.length} tool calls completed. Partial output preserved.*`;
        if (fullResponse.trim()) {
          fullResponse += notice;
        } else {
          // No text output — build a context dump of what happened
          fullResponse = buildContextDump(subSessionId, subtask, toolsUsed) + notice;
        }
        mainWindow.webContents.send('agent:deep-stream-chunk', {
          index: subtask.index, chunk: notice,
        });
      } else if (streamErr?.name !== 'AbortError') {
        throw streamErr; // re-throw non-abort errors
      }
    } finally {
      clearTimeout(subtaskTimeoutHandle);
    }

    return fullResponse;

  } finally {
    // Cleanup sub-session resources
    cleanupSession(subSessionId);
    purgeSession(subSessionId);
    clearHistory(subSessionId);
  }
}

// ── Compile Step ──

async function runCompileStep(
  subtask: Subtask,
  allSubtasks: Subtask[],
  runDir: string,
  originalTask: string,
  mode: 'action' | 'research',
  llmConfig: LLMConfig,
  mainWindow: BrowserWindow,
): Promise<string> {
  const todayStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Read all prior subtask outputs
  const reports: string[] = [];
  for (const st of allSubtasks) {
    if (st.index >= subtask.index) break;
    const p = path.join(runDir, st.output);
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, 'utf-8');
        reports.push(`### Step ${st.index + 1}: ${st.task.slice(0, 80)}\n\n${content}`);
      } catch {
        reports.push(`### Step ${st.index + 1}\n\n*File not found*`);
      }
    }
  }

  const findings = reports.length > 0 ? reports.join('\n\n---\n\n') : '*No subtask outputs found.*';

  const prompt = COMPILE_SYSTEM_PROMPT
    .replace('{today}', todayStr)
    .replace('{original_task}', originalTask)
    .replace('{subtask_reports}', findings);

  const model = createModel(llmConfig);

  // Stream compilation
  const result = streamText({
    model,
    prompt,
    maxOutputTokens: 16384,
  });

  let fullText = '';
  for await (const chunk of result.textStream) {
    fullText += chunk;
    mainWindow.webContents.send('agent:deep-stream-chunk', {
      index: subtask.index, chunk,
    });
  }

  return fullText;
}

// ── Context Dump ──

/**
 * Build a context dump when a subtask hits the step limit.
 * Extracts the conversation history (tool calls + results) so subsequent
 * steps and the compile step know exactly what happened and where it stopped.
 */
function buildContextDump(sessionId: string, subtask: Subtask, toolsUsed: string[]): string {
  const history = getFullHistory(sessionId);
  const parts: string[] = [
    `# Step ${subtask.index + 1} — Context Dump (step limit reached)`,
    '',
    `**Task:** ${subtask.task}`,
    `**Tool calls:** ${toolsUsed.length} (${[...new Set(toolsUsed)].join(', ')})`,
    `**Status:** Hit 50-step limit before producing final output.`,
    '',
    '## What happened (conversation trace):',
    '',
  ];

  // Extract meaningful content from the conversation
  for (const msg of history) {
    if (msg.role === 'user' && typeof msg.content === 'string') {
      // Skip the injected browser context prefix
      const clean = msg.content.replace(/^\[Browser:.*?\]\n\n/s, '');
      parts.push(`**User:** ${clean.slice(0, 300)}`);
    } else if (msg.role === 'assistant') {
      // Could be structured (tool calls) or plain text
      if (typeof msg.content === 'string') {
        if (msg.content.trim()) parts.push(`**Agent:** ${msg.content.slice(0, 500)}`);
      } else if (Array.isArray((msg as any).content)) {
        // Structured content parts (tool calls, text)
        for (const part of (msg as any).content) {
          if (part.type === 'text' && part.text?.trim()) {
            parts.push(`**Agent:** ${part.text.slice(0, 300)}`);
          } else if (part.type === 'tool-call') {
            const args = typeof part.args === 'string' ? part.args : JSON.stringify(part.args || {});
            parts.push(`**Tool call:** ${part.toolName}(${args.slice(0, 200)})`);
          }
        }
      }
    } else if ((msg as any).role === 'tool') {
      // Tool result
      if (Array.isArray((msg as any).content)) {
        for (const part of (msg as any).content) {
          if (part.type === 'tool-result') {
            const res = typeof part.result === 'string' ? part.result : JSON.stringify(part.result || '');
            parts.push(`**Tool result (${part.toolName}):** ${res.slice(0, 300)}`);
          }
        }
      }
    }
  }

  // Cap total dump size to ~4KB to avoid blowing up the compile step context
  let dump = parts.join('\n');
  if (dump.length > 4000) {
    dump = dump.slice(0, 3800) + '\n\n---\n*[context dump truncated at 4KB]*';
  }

  return dump;
}
