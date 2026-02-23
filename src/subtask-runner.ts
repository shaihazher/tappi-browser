/**
 * subtask-runner.ts — Deep Mode executor (Phase 9.06: Parallel Research).
 *
 * Research subtasks run IN PARALLEL (up to 3 concurrent), each with a
 * dedicated browser tab. Action subtasks run sequentially as before.
 * Compile step always runs last (sequential, depends on all prior outputs).
 *
 * Each parallel agent gets a scoped BrowserContext that pins its tools to
 * its own tab — agents cannot switch tabs or interfere with each other.
 *
 * Progress events emitted to main window + Aria tab via IPC.
 */

import { streamText, generateText, stepCountIs } from 'ai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { BrowserWindow, WebContents } from 'electron';
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

// ── Constants ──

/** Maximum number of research subtasks running in parallel. */
const MAX_PARALLEL = 3;

// ── Types ──

export interface SubtaskRunnerOptions {
  decomposition: DecompositionResult;
  originalTask: string;
  browserCtx: BrowserContext;
  llmConfig: LLMConfig;
  window: BrowserWindow;
  sessionId: string;
  developerMode?: boolean;
  codingMode?: boolean;
  agentBrowsingDataAccess?: boolean;
  abortSignal?: AbortSignal;
  ariaWebContents?: WebContents | null;
  onTokenUsage?: (usage: any) => void;
}

export interface DeepRunResult {
  subtasks: Subtask[];
  finalOutput: string;
  outputDir: string;
  outputDirAbsolute: string;
  durationSeconds: number;
  aborted: boolean;
  mode: 'action' | 'research';
}

// ── Tab-Scoped BrowserContext ──

/**
 * Create a BrowserContext proxy where `tabManager.activeWebTabWebContents`
 * always returns the specified tab's webContents.
 *
 * This ensures parallel agents ONLY interact with their dedicated tab —
 * they can't see, switch to, or affect any other tab.
 */
function createScopedBrowserCtx(
  baseBrowserCtx: BrowserContext,
  tabId: string,
): BrowserContext {
  const realTabManager = baseBrowserCtx.tabManager;

  // Create a proxy around tabManager that overrides webContents resolution
  const scopedTabManager = new Proxy(realTabManager, {
    get(target, prop, receiver) {
      // Override activeWebTabWebContents to always return the scoped tab
      if (prop === 'activeWebTabWebContents') {
        const wc = target.getWebContentsForTab(tabId);
        return wc && !wc.isDestroyed() ? wc : null;
      }
      // Override activeWebContents similarly
      if (prop === 'activeWebContents') {
        const wc = target.getWebContentsForTab(tabId);
        return wc && !wc.isDestroyed() ? wc : null;
      }
      // Override activeTabId to return the scoped tab id
      if (prop === 'activeTabId') {
        return tabId;
      }
      // Override agentTargetId to return the scoped tab id
      if (prop === 'agentTargetId') {
        return tabId;
      }
      // setAgentTarget is a no-op — scoped agents can't change target
      if (prop === 'setAgentTarget') {
        return () => {};
      }
      // Everything else passes through to the real tabManager
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') {
        return value.bind(target);
      }
      return value;
    },
  });

  return {
    window: baseBrowserCtx.window,
    tabManager: scopedTabManager as any,
    config: baseBrowserCtx.config,
  };
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
    codingMode = false,
    agentBrowsingDataAccess = false,
    abortSignal,
    ariaWebContents,
    onTokenUsage,
  } = opts;

  function deepBroadcast(channel: string, data: any) {
    try { mainWindow.webContents.send(channel, data); } catch {}
    try { if (ariaWebContents && !ariaWebContents.isDestroyed()) ariaWebContents.send(channel, data); } catch {}
  }

  const { mode, subtasks } = decomposition;
  const start = Date.now();

  // Create run directory
  const workspace = path.join(os.homedir(), 'tappi-workspace');
  const runDir = path.join(workspace, 'deep-runs', makeRunDirname(originalTask));
  fs.mkdirSync(runDir, { recursive: true });

  // Detect DAG parallelism for action mode
  const isDagParallel = mode === 'action' && hasDAGParallelism(subtasks);

  // Send plan to UI — include parallel flag so UI knows not to collapse streams
  deepBroadcast('agent:deep-plan', {
    mode,
    parallel: mode === 'research' || isDagParallel,
    subtasks: subtasks.map(s => ({
      task: s.task, tool: s.tool, output: s.output, index: s.index, total: s.total,
      depends_on: s.depends_on,
    })),
  });

  let finalOutput = '';

  // ── Research mode: parallel research + sequential compile ──
  if (mode === 'research') {
    const researchSubtasks = subtasks.filter(s => s.tool !== 'compile');
    const compileSubtask = subtasks.find(s => s.tool === 'compile');

    // Run research subtasks in parallel (max 3 concurrent)
    await runParallelResearch(
      researchSubtasks, subtasks, runDir, browserCtx, llmConfig,
      mainWindow, sessionId, developerMode, agentBrowsingDataAccess,
      codingMode, abortSignal, ariaWebContents, onTokenUsage,
    );

    // Run compile step sequentially
    if (compileSubtask && !abortSignal?.aborted) {
      const compileStart = Date.now();
      compileSubtask.status = 'running';
      deepBroadcast('agent:deep-subtask-start', {
        index: compileSubtask.index, task: compileSubtask.task, tool: compileSubtask.tool,
      });

      try {
        finalOutput = await runCompileStep(
          compileSubtask, subtasks, runDir, originalTask, mode,
          llmConfig, mainWindow, ariaWebContents, onTokenUsage,
        );

        const outputPath = path.join(runDir, compileSubtask.output);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, finalOutput || '# Final Report\n\n*No output produced.*\n');

        compileSubtask.status = 'done';
        compileSubtask.result = finalOutput;
        compileSubtask.duration = (Date.now() - compileStart) / 1000;

        deepBroadcast('agent:deep-subtask-done', {
          index: compileSubtask.index, status: 'done', duration: compileSubtask.duration,
        });
      } catch (err: any) {
        compileSubtask.status = 'failed';
        compileSubtask.error = err?.message || 'Unknown error';
        compileSubtask.duration = (Date.now() - compileStart) / 1000;
        deepBroadcast('agent:deep-subtask-done', {
          index: compileSubtask.index, status: 'failed', duration: compileSubtask.duration, error: compileSubtask.error,
        });
      }
    } else if (compileSubtask && abortSignal?.aborted) {
      compileSubtask.status = 'failed';
      compileSubtask.error = 'Aborted';
      deepBroadcast('agent:deep-subtask-done', {
        index: compileSubtask.index, status: 'failed', duration: 0, error: 'Aborted',
      });
    }
  }
  // ── Action mode: DAG parallel or sequential ──
  else {
    if (isDagParallel) {
      // DAG-aware parallel execution — independent steps run concurrently
      finalOutput = await runDAGActionMode(
        subtasks, originalTask, runDir, browserCtx, llmConfig,
        mainWindow, sessionId, developerMode, agentBrowsingDataAccess,
        codingMode, abortSignal, ariaWebContents, onTokenUsage,
      );
    } else {
      // Classic sequential — no depends_on or all steps depend on previous
      for (const subtask of subtasks) {
        if (abortSignal?.aborted) {
          subtask.status = 'failed';
          subtask.error = 'Aborted';
          deepBroadcast('agent:deep-subtask-done', {
            index: subtask.index, status: 'failed', duration: 0, error: 'Aborted',
          });
          continue;
        }

        const subtaskStart = Date.now();
        subtask.status = 'running';
        deepBroadcast('agent:deep-subtask-start', {
          index: subtask.index, task: subtask.task, tool: subtask.tool,
        });

        try {
          let result: string;
          if (subtask.tool === 'compile') {
            result = await runCompileStep(subtask, subtasks, runDir, originalTask, mode, llmConfig, mainWindow, ariaWebContents, onTokenUsage);
          } else {
            const secondaryConfig = getModelConfig('secondary', llmConfig);
            result = await runBrowsingSubtask(subtask, subtasks, runDir, browserCtx, secondaryConfig, mainWindow, sessionId, developerMode, mode, agentBrowsingDataAccess, codingMode, ariaWebContents, onTokenUsage);
          }

          const outputPath = path.join(runDir, subtask.output);
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, result || `# Step ${subtask.index + 1}\n\n*No output produced.*\n`);

          subtask.status = 'done';
          subtask.result = result;
          subtask.duration = (Date.now() - subtaskStart) / 1000;
          finalOutput = result;

          deepBroadcast('agent:deep-subtask-done', {
            index: subtask.index, status: 'done', duration: subtask.duration,
          });
        } catch (err: any) {
          subtask.status = 'failed';
          subtask.error = err?.message || 'Unknown error';
          subtask.duration = (Date.now() - subtaskStart) / 1000;
          const outputPath = path.join(runDir, subtask.output);
          fs.writeFileSync(outputPath, `# Step ${subtask.index + 1} — FAILED\n\n${subtask.error}\n`);
          deepBroadcast('agent:deep-subtask-done', {
            index: subtask.index, status: 'failed', duration: subtask.duration, error: subtask.error,
          });
        }
      }
    }
  }

  const totalDuration = (Date.now() - start) / 1000;
  const relDir = path.relative(workspace, runDir);

  return {
    subtasks,
    finalOutput,
    outputDir: relDir,
    outputDirAbsolute: runDir,
    durationSeconds: totalDuration,
    aborted: abortSignal?.aborted || false,
    mode,
  };
}

// ── DAG Parallelism Helpers ──

/**
 * Returns true if any subtask in this action plan has an explicit `depends_on`
 * field AND at least one step is independent (depends_on: []).
 * That means some steps can run in parallel — use DAG mode.
 */
function hasDAGParallelism(subtasks: Subtask[]): boolean {
  const anyHasDepsField = subtasks.some(s => Array.isArray(s.depends_on));
  if (!anyHasDepsField) return false;
  // At least one independent step (can fire immediately without waiting)
  return subtasks.some(s => Array.isArray(s.depends_on) && s.depends_on.length === 0);
}

/**
 * Build a full dependency map for every subtask.
 * Subtasks without `depends_on` fall back to depending on the previous step
 * (sequential fallback — maintains backwards compat).
 */
function buildDepMap(subtasks: Subtask[]): Map<number, number[]> {
  const deps = new Map<number, number[]>();
  for (const st of subtasks) {
    if (Array.isArray(st.depends_on)) {
      // Use declared deps (validated at parse time to only contain backward refs)
      deps.set(st.index, st.depends_on);
    } else {
      // No depends_on: fallback to sequential (depends on immediate predecessor)
      deps.set(st.index, st.index > 0 ? [st.index - 1] : []);
    }
  }
  return deps;
}

// ── DAG Action Mode Execution ──

/**
 * Execute action subtasks using a dependency-aware scheduler.
 *
 * - Independent steps (depends_on: []) start immediately and run in parallel
 *   up to MAX_PARALLEL concurrent tasks.
 * - Dependent steps are gated until ALL their declared dependencies complete.
 * - If a dependency fails, all transitive dependents are marked failed/skipped.
 * - Each parallel step gets its own background browser tab (like research mode).
 * - Sequential steps (no depends_on field) retain the shared browser context.
 */
async function runDAGActionMode(
  subtasks: Subtask[],
  originalTask: string,
  runDir: string,
  browserCtx: BrowserContext,
  llmConfig: LLMConfig,
  mainWindow: BrowserWindow,
  sessionId: string,
  developerMode: boolean,
  agentBrowsingDataAccess: boolean,
  codingMode: boolean,
  abortSignal?: AbortSignal,
  ariaWebContents?: WebContents | null,
  onTokenUsage?: (usage: any) => void,
): Promise<string> {
  function deepBroadcast(channel: string, data: any) {
    try { mainWindow.webContents.send(channel, data); } catch {}
    try { if (ariaWebContents && !ariaWebContents.isDestroyed()) ariaWebContents.send(channel, data); } catch {}
  }

  const secondaryConfig = getModelConfig('secondary', llmConfig);
  const depMap = buildDepMap(subtasks);
  const subtaskMap = new Map(subtasks.map(s => [s.index, s]));

  // Tracking sets
  const done = new Set<number>();
  const failed = new Set<number>();
  const pending = new Set<number>(subtasks.map(s => s.index));
  const running = new Set<Promise<void>>();

  let finalOutput = '';

  const runOne = async (subtask: Subtask): Promise<void> => {
    if (abortSignal?.aborted) {
      subtask.status = 'failed';
      subtask.error = 'Aborted';
      deepBroadcast('agent:deep-subtask-done', {
        index: subtask.index, status: 'failed', duration: 0, error: 'Aborted',
      });
      failed.add(subtask.index);
      return;
    }

    // Check if any declared dependency failed — skip this step if so
    const myDeps = depMap.get(subtask.index) || [];
    const depsFailed = myDeps.some(d => failed.has(d));
    if (depsFailed) {
      subtask.status = 'failed';
      subtask.error = 'Skipped (a required dependency failed)';
      deepBroadcast('agent:deep-subtask-done', {
        index: subtask.index, status: 'failed', duration: 0, error: subtask.error,
      });
      failed.add(subtask.index);
      return;
    }

    // Determine if this step runs in parallel (has explicit depends_on field)
    // vs. sequential fallback (no depends_on field — shares main browser ctx)
    const isExplicitlyParallel = Array.isArray(subtask.depends_on);

    // For explicitly parallel steps → give each a dedicated background tab
    let tabId: string | null = null;
    let effectiveCtx = browserCtx;
    if (isExplicitlyParallel) {
      try {
        tabId = browserCtx.tabManager.createTab('about:blank', undefined, { background: true });
        effectiveCtx = createScopedBrowserCtx(browserCtx, tabId);
      } catch (err: any) {
        console.warn(`[deep-dag] Failed to create tab for step ${subtask.index}:`, err?.message);
        // Fall back to shared context — step still runs, just not isolated
      }
    }

    const subtaskStart = Date.now();
    subtask.status = 'running';
    deepBroadcast('agent:deep-subtask-start', {
      index: subtask.index, task: subtask.task, tool: subtask.tool,
      ...(tabId ? { tabId } : {}),
    });

    try {
      let result: string;
      if (subtask.tool === 'compile') {
        result = await runCompileStep(
          subtask, subtasks, runDir, originalTask, 'action',
          llmConfig, mainWindow, ariaWebContents, onTokenUsage,
        );
      } else {
        result = await runBrowsingSubtask(
          subtask, subtasks, runDir, effectiveCtx, secondaryConfig,
          mainWindow, sessionId, developerMode, 'action',
          agentBrowsingDataAccess, codingMode, ariaWebContents, onTokenUsage,
        );
      }

      const outputPath = path.join(runDir, subtask.output);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, result || `# Step ${subtask.index + 1}\n\n*No output produced.*\n`);

      subtask.status = 'done';
      subtask.result = result;
      subtask.duration = (Date.now() - subtaskStart) / 1000;
      finalOutput = result;
      done.add(subtask.index);

      deepBroadcast('agent:deep-subtask-done', {
        index: subtask.index, status: 'done', duration: subtask.duration,
      });
    } catch (err: any) {
      subtask.status = 'failed';
      subtask.error = err?.message || 'Unknown error';
      subtask.duration = (Date.now() - subtaskStart) / 1000;
      const outputPath = path.join(runDir, subtask.output);
      try { fs.writeFileSync(outputPath, `# Step ${subtask.index + 1} — FAILED\n\n${subtask.error}\n`); } catch {}
      failed.add(subtask.index);
      deepBroadcast('agent:deep-subtask-done', {
        index: subtask.index, status: 'failed', duration: subtask.duration, error: subtask.error,
      });
    } finally {
      if (tabId) {
        try { browserCtx.tabManager.closeTab(tabId); } catch {}
      }
    }
  };

  // ── DAG scheduling loop ──
  while (pending.size > 0 || running.size > 0) {
    if (abortSignal?.aborted) {
      // Mark all remaining pending as aborted
      for (const idx of pending) {
        const st = subtaskMap.get(idx)!;
        st.status = 'failed';
        st.error = 'Aborted';
        deepBroadcast('agent:deep-subtask-done', {
          index: idx, status: 'failed', duration: 0, error: 'Aborted',
        });
      }
      pending.clear();
      break;
    }

    // Find all subtasks that are ready to start:
    // all their dependencies are resolved (done OR failed)
    const ready: Subtask[] = [];
    for (const idx of pending) {
      const st = subtaskMap.get(idx)!;
      const myDeps = depMap.get(idx) || [];
      const allResolved = myDeps.every(d => done.has(d) || failed.has(d));
      if (allResolved) ready.push(st);
    }

    // Dispatch ready tasks up to concurrency cap
    for (const st of ready) {
      if (running.size >= MAX_PARALLEL) break;
      pending.delete(st.index);
      // Two-statement form avoids TS7022 circular-initializer error
      let dagPromise: Promise<void>;
      dagPromise = runOne(st).then(() => { running.delete(dagPromise); });
      running.add(dagPromise);
    }

    // Deadlock guard: pending subtasks exist but none are ready and nothing is running
    if (running.size === 0 && pending.size > 0) {
      console.warn('[deep-dag] Deadlock — no ready steps. Remaining:', [...pending]);
      for (const idx of pending) {
        const st = subtaskMap.get(idx)!;
        st.status = 'failed';
        st.error = 'DAG deadlock — dependency cycle or unresolvable dependency';
        deepBroadcast('agent:deep-subtask-done', {
          index: idx, status: 'failed', duration: 0, error: st.error,
        });
        failed.add(idx);
      }
      pending.clear();
      break;
    }

    // Wait for at least one running task to complete before re-evaluating
    if (running.size > 0) {
      await Promise.race(running);
    }
  }

  return finalOutput;
}

// ── Parallel Research Execution ──

/**
 * Run research subtasks in parallel with a concurrency cap of MAX_PARALLEL.
 * Each agent gets a dedicated background tab that is closed on completion.
 */
async function runParallelResearch(
  researchSubtasks: Subtask[],
  allSubtasks: Subtask[],
  runDir: string,
  browserCtx: BrowserContext,
  llmConfig: LLMConfig,
  mainWindow: BrowserWindow,
  sessionId: string,
  developerMode: boolean,
  agentBrowsingDataAccess: boolean,
  codingMode: boolean,
  abortSignal?: AbortSignal,
  ariaWebContents?: WebContents | null,
  onTokenUsage?: (usage: any) => void,
): Promise<void> {
  function deepBroadcast(channel: string, data: any) {
    try { mainWindow.webContents.send(channel, data); } catch {}
    try { if (ariaWebContents && !ariaWebContents.isDestroyed()) ariaWebContents.send(channel, data); } catch {}
  }

  const secondaryConfig = getModelConfig('secondary', llmConfig);

  // Queue system: process up to MAX_PARALLEL at a time
  const queue = [...researchSubtasks];
  const running = new Set<Promise<void>>();
  const tabIds: Map<number, string> = new Map(); // subtask index → tab ID

  async function runOne(subtask: Subtask): Promise<void> {
    if (abortSignal?.aborted) {
      subtask.status = 'failed';
      subtask.error = 'Aborted';
      deepBroadcast('agent:deep-subtask-done', {
        index: subtask.index, status: 'failed', duration: 0, error: 'Aborted',
      });
      return;
    }

    // Create a dedicated background tab for this agent
    let tabId: string | null = null;
    try {
      tabId = browserCtx.tabManager.createTab('about:blank', undefined, { background: true });
      tabIds.set(subtask.index, tabId);
    } catch (err: any) {
      console.error(`[deep-parallel] Failed to create tab for step ${subtask.index}:`, err?.message);
      subtask.status = 'failed';
      subtask.error = `Failed to create tab: ${err?.message}`;
      deepBroadcast('agent:deep-subtask-done', {
        index: subtask.index, status: 'failed', duration: 0, error: subtask.error,
      });
      return;
    }

    // Create a scoped browser context that pins tools to this tab
    const scopedCtx = createScopedBrowserCtx(browserCtx, tabId);

    const subtaskStart = Date.now();
    subtask.status = 'running';
    deepBroadcast('agent:deep-subtask-start', {
      index: subtask.index, task: subtask.task, tool: subtask.tool,
      tabId, // Send tabId to UI for tab indicator
    });

    try {
      const result = await runBrowsingSubtask(
        subtask, allSubtasks, runDir, scopedCtx, secondaryConfig,
        mainWindow, sessionId, developerMode, 'research',
        agentBrowsingDataAccess, codingMode, ariaWebContents, onTokenUsage,
      );

      const outputPath = path.join(runDir, subtask.output);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, result || `# Step ${subtask.index + 1}\n\n*No output produced.*\n`);

      subtask.status = 'done';
      subtask.result = result;
      subtask.duration = (Date.now() - subtaskStart) / 1000;

      deepBroadcast('agent:deep-subtask-done', {
        index: subtask.index, status: 'done', duration: subtask.duration,
      });
    } catch (err: any) {
      subtask.status = 'failed';
      subtask.error = err?.message || 'Unknown error';
      subtask.duration = (Date.now() - subtaskStart) / 1000;
      const outputPath = path.join(runDir, subtask.output);
      fs.writeFileSync(outputPath, `# Step ${subtask.index + 1} — FAILED\n\n${subtask.error}\n`);
      deepBroadcast('agent:deep-subtask-done', {
        index: subtask.index, status: 'failed', duration: subtask.duration, error: subtask.error,
      });
    } finally {
      // Close the dedicated tab
      if (tabId) {
        try {
          browserCtx.tabManager.closeTab(tabId);
        } catch {}
        tabIds.delete(subtask.index);
      }
    }
  }

  // Process queue with concurrency cap
  while (queue.length > 0 || running.size > 0) {
    // Fill up to MAX_PARALLEL concurrent tasks
    while (queue.length > 0 && running.size < MAX_PARALLEL) {
      if (abortSignal?.aborted) break;
      const subtask = queue.shift()!;
      const promise = runOne(subtask).then(() => {
        running.delete(promise);
      });
      running.add(promise);
    }

    if (abortSignal?.aborted) {
      // Mark remaining queued subtasks as aborted
      for (const subtask of queue) {
        subtask.status = 'failed';
        subtask.error = 'Aborted';
        deepBroadcast('agent:deep-subtask-done', {
          index: subtask.index, status: 'failed', duration: 0, error: 'Aborted',
        });
      }
      queue.length = 0;
    }

    // Wait for at least one to finish before filling more
    if (running.size > 0) {
      await Promise.race(running);
    }
  }
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
  codingMode = false,
  ariaWebContents?: WebContents | null,
  onTokenUsage?: (usage: any) => void,
): Promise<string> {
  const subSessionId = `deep:${parentSessionId}:step-${subtask.index}`;
  function deepBroadcast(channel: string, data: any) {
    try { mainWindow.webContents.send(channel, data); } catch {}
    try { if (ariaWebContents && !ariaWebContents.isDestroyed()) ariaWebContents.send(channel, data); } catch {}
  }

  try {
    const model = createModel(llmConfig);
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

    // For sequential (action) mode, inject prior outputs
    // For parallel (research) mode, no prior outputs — agents are independent
    if (mode !== 'research' && subtask.index > 0) {
      const priorFiles: string[] = [];
      for (const st of allSubtasks.slice(0, subtask.index)) {
        const p = path.join(runDir, st.output);
        if (fs.existsSync(p)) priorFiles.push(p);
      }
      if (priorFiles.length > 0) {
        const priorContext: string[] = [];
        for (const p of priorFiles) {
          try {
            const content = fs.readFileSync(p, 'utf8');
            if (content.trim()) {
              priorContext.push(`--- ${path.basename(p)} ---\n${content.slice(0, 4000)}`);
            }
          } catch {}
        }
        if (priorContext.length > 0) {
          taskPrompt += `\n\n## Prior Step Results (already gathered — do NOT re-research these)\n\n${priorContext.join('\n\n')}\n\nBuild on these results. Do NOT repeat searches for information already gathered above.`;
        }
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

    // Timeout-based execution
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
      stopWhen: stepCountIs(100),
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
            deepBroadcast('agent:deep-tool-result', {
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
        deepBroadcast('agent:deep-stream-chunk', {
          index: subtask.index, chunk,
        });
      }
    } catch (streamErr: any) {
      if (streamErr?.name === 'AbortError' && subtaskTimedOut) {
        const elapsed = Date.now() - subtaskStart;
        const min = Math.floor(elapsed / 60000);
        const sec = Math.floor((elapsed % 60000) / 1000);
        const durStr = min > 0 ? `${min}m ${sec}s` : `${sec}s`;
        const notice = `\n\n---\n⏰ *Subtask timed out after ${durStr}. ${toolsUsed.length} tool calls completed. Partial output preserved.*`;
        if (fullResponse.trim()) {
          fullResponse += notice;
        } else {
          fullResponse = buildContextDump(subSessionId, subtask, toolsUsed) + notice;
        }
        deepBroadcast('agent:deep-stream-chunk', {
          index: subtask.index, chunk: notice,
        });
      } else if (streamErr?.name !== 'AbortError') {
        throw streamErr;
      }
    } finally {
      clearTimeout(subtaskTimeoutHandle);
    }

    // Report token usage for this subtask (Phase 9.07)
    try {
      const usage = await result.usage;
      if (usage && onTokenUsage) {
        onTokenUsage(usage);
      }
    } catch (e) {
      // Usage not available from this provider — ignore
    }

    return fullResponse;

  } finally {
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
  ariaWebContents?: WebContents | null,
  onTokenUsage?: (usage: any) => void,
): Promise<string> {
  function deepBroadcast(channel: string, data: any) {
    try { mainWindow.webContents.send(channel, data); } catch {}
    try { if (ariaWebContents && !ariaWebContents.isDestroyed()) ariaWebContents.send(channel, data); } catch {}
  }
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

  const result = streamText({
    model,
    prompt,
    maxOutputTokens: 16384,
  });

  let fullText = '';
  for await (const chunk of result.textStream) {
    fullText += chunk;
    deepBroadcast('agent:deep-stream-chunk', {
      index: subtask.index, chunk,
    });
  }

  // Report token usage for compile step (Phase 9.07)
  try {
    const usage = await result.usage;
    if (usage && onTokenUsage) {
      onTokenUsage(usage);
    }
  } catch (e) {
    // Usage not available from this provider — ignore
  }

  return fullText;
}

// ── Context Dump ──

function buildContextDump(sessionId: string, subtask: Subtask, toolsUsed: string[]): string {
  const history = getFullHistory(sessionId);
  const parts: string[] = [
    `# Step ${subtask.index + 1} — Context Dump (timed out)`,
    '',
    `**Task:** ${subtask.task}`,
    `**Tool calls:** ${toolsUsed.length} (${[...new Set(toolsUsed)].join(', ')})`,
    '',
    '## What happened (conversation trace):',
    '',
  ];

  for (const msg of history) {
    if (msg.role === 'user' && typeof msg.content === 'string') {
      const clean = msg.content.replace(/^\[Browser:.*?\]\n\n/s, '');
      parts.push(`**User:** ${clean.slice(0, 300)}`);
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        if (msg.content.trim()) parts.push(`**Agent:** ${msg.content.slice(0, 500)}`);
      } else if (Array.isArray((msg as any).content)) {
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

  let dump = parts.join('\n');
  if (dump.length > 4000) {
    dump = dump.slice(0, 3800) + '\n\n---\n*[context dump truncated at 4KB]*';
  }

  return dump;
}
