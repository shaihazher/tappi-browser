/**
 * cron-manager.ts — In-browser scheduled tasks (Phase 7.99).
 *
 * Runs inside the Electron main process. Jobs fire as isolated agent turns.
 * If the browser is closed, jobs don't run — no persistence daemon.
 * Persistence: ~/.tappi-browser/cron-jobs.json (loaded on startup, saved on every change).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { streamText, stepCountIs } from 'ai';
import { createModel, buildProviderOptions, type LLMConfig } from './llm-client';
import { createTools } from './tool-registry';
import * as browserTools from './browser-tools';
import type { BrowserContext } from './browser-tools';
import { addMessage, getWindow, clearHistory, type ChatMessage } from './conversation';
import { purgeSession } from './output-buffer';
import { cleanupSession } from './shell-tools';
import type { BrowserWindow } from 'electron';

// ─── Types ───

export interface CronJobSchedule {
  kind: 'interval' | 'cron' | 'daily';
  intervalMs?: number;       // for 'interval'
  cronExpr?: string;         // for 'cron': standard 5-field cron
  timeOfDay?: string;        // for 'daily': "HH:MM" in local time
}

export interface CronJobRun {
  at: string;
  status: 'success' | 'error';
  result: string;
  durationMs: number;
}

export interface CronJob {
  id: string;
  name: string;
  task: string;
  schedule: CronJobSchedule;
  enabled: boolean;
  createdAt: string;
  lastRun?: string;
  lastResult?: string;
  lastStatus?: 'success' | 'error';
  nextRun?: string;
  runs: CronJobRun[];
}

// ─── Constants ───

const CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.tappi-browser');

function getJobsPath(): string {
  try {
    const { profileManager } = require('./profile-manager');
    return profileManager.getCronJobsPath();
  } catch {
    return path.join(CONFIG_DIR, 'cron-jobs.json');
  }
}

const JOBS_PATH = path.join(CONFIG_DIR, 'cron-jobs.json'); // fallback
const MAX_RUNS = 10; // ring buffer per job

// ─── State ───

const jobs = new Map<string, CronJob>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let mainWindow: BrowserWindow | null = null;
let browserCtx: BrowserContext | null = null;
let llmConfig: LLMConfig | null = null;
let devMode = false;

// ─── Persistence ───

function loadJobs(): void {
  try {
    const jobsPath = getJobsPath();
    if (fs.existsSync(jobsPath)) {
      const raw = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
      if (Array.isArray(raw)) {
        for (const job of raw) {
          jobs.set(job.id, job);
        }
      }
    }
  } catch (e) {
    console.error('[cron] Failed to load jobs:', e);
  }
}

function saveJobs(): void {
  try {
    const jobsPath = getJobsPath();
    const dir = path.dirname(jobsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const arr = Array.from(jobs.values());
    fs.writeFileSync(jobsPath, JSON.stringify(arr, null, 2));
  } catch (e) {
    console.error('[cron] Failed to save jobs:', e);
  }
}

// ─── Cron Expression Parser (5-field: min hour dom month dow) ───

function parseCronField(field: string, min: number, max: number): number[] {
  const values: Set<number> = new Set();

  for (const part of field.split(',')) {
    // Handle step: */N or range/N
    const [rangePart, stepStr] = part.split('/');
    const step = stepStr ? parseInt(stepStr, 10) : 1;

    if (rangePart === '*') {
      for (let i = min; i <= max; i += step) values.add(i);
    } else if (rangePart.includes('-')) {
      const [lo, hi] = rangePart.split('-').map(Number);
      for (let i = lo; i <= hi; i += step) values.add(i);
    } else {
      values.add(parseInt(rangePart, 10));
    }
  }

  return Array.from(values).sort((a, b) => a - b);
}

function nextCronOccurrence(expr: string, after: Date = new Date()): Date | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const minutes = parseCronField(fields[0], 0, 59);
  const hours = parseCronField(fields[1], 0, 23);
  const doms = parseCronField(fields[2], 1, 31);
  const months = parseCronField(fields[3], 1, 12);
  const dows = parseCronField(fields[4], 0, 6); // 0=Sunday

  // Start from 1 minute after 'after'
  const candidate = new Date(after);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Search up to 1 year ahead
  const limit = new Date(after);
  limit.setFullYear(limit.getFullYear() + 1);

  while (candidate < limit) {
    if (
      months.includes(candidate.getMonth() + 1) &&
      (doms.includes(candidate.getDate()) || dows.includes(candidate.getDay())) &&
      hours.includes(candidate.getHours()) &&
      minutes.includes(candidate.getMinutes())
    ) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null;
}

// ─── Scheduling ───

function computeNextRun(job: CronJob): Date | null {
  const now = new Date();
  const schedule = job.schedule;

  switch (schedule.kind) {
    case 'interval': {
      const ms = schedule.intervalMs || 60000;
      if (job.lastRun) {
        const last = new Date(job.lastRun);
        const next = new Date(last.getTime() + ms);
        return next > now ? next : new Date(now.getTime() + ms);
      }
      return new Date(now.getTime() + ms);
    }

    case 'daily': {
      const [hh, mm] = (schedule.timeOfDay || '09:00').split(':').map(Number);
      const today = new Date();
      today.setHours(hh, mm, 0, 0);
      if (today > now) return today;
      // Tomorrow
      today.setDate(today.getDate() + 1);
      return today;
    }

    case 'cron': {
      if (!schedule.cronExpr) return null;
      return nextCronOccurrence(schedule.cronExpr, now);
    }

    default:
      return null;
  }
}

function scheduleJob(job: CronJob): void {
  // Clear any existing timer
  const existing = timers.get(job.id);
  if (existing) clearTimeout(existing);

  if (!job.enabled) {
    job.nextRun = undefined;
    return;
  }

  const nextRun = computeNextRun(job);
  if (!nextRun) {
    console.error('[cron] Could not compute next run for:', job.name);
    return;
  }

  job.nextRun = nextRun.toISOString();
  const delayMs = Math.max(nextRun.getTime() - Date.now(), 1000);

  console.log(`[cron] Scheduled "${job.name}" → ${nextRun.toLocaleString()} (in ${Math.round(delayMs / 1000)}s)`);

  const timer = setTimeout(() => {
    executeJob(job);
  }, delayMs);

  timers.set(job.id, timer);
}

// ─── Execution ───

async function executeJob(job: CronJob): Promise<void> {
  if (!llmConfig || !browserCtx || !mainWindow) {
    console.error('[cron] Cannot execute job — missing context');
    scheduleJob(job); // reschedule for next occurrence
    return;
  }

  const startTime = Date.now();
  const sessionId = `cron:${job.id}:${Date.now()}`;

  console.log(`[cron] ⏰ Executing "${job.name}"...`);

  // Notify UI
  mainWindow.webContents.send('cron:job-running', { id: job.id, name: job.name });

  try {
    const model = createModel(llmConfig);
    const tools = createTools(browserCtx, sessionId, { developerMode: devMode, llmConfig });

    // Inject current time + timezone into the task prompt
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timeStr = now.toLocaleString('en-US', {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    });

    const browserState = (() => {
      try { return browserTools.getBrowserState(browserCtx!); } catch { return '(unavailable)'; }
    })();

    const fullTask = `[Current time: ${timeStr} (${tz})]\n[Browser: ${browserState}]\n\n${job.task}`;

    addMessage(sessionId, { role: 'user', content: fullTask });

    const providerOptions = buildProviderOptions(llmConfig);

    const result = await streamText({
      model,
      system: CRON_AGENT_PROMPT,
      messages: [{ role: 'user' as const, content: fullTask }],
      tools,
      ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
      stopWhen: stepCountIs(50),
    });

    let fullResponse = '';
    for await (const chunk of result.textStream) {
      fullResponse += chunk;
    }

    const durationMs = Date.now() - startTime;
    const truncatedResult = fullResponse.length > 200 ? fullResponse.slice(0, 200) + '...' : fullResponse;

    job.lastRun = new Date(startTime).toISOString();
    job.lastStatus = 'success';
    job.lastResult = truncatedResult;
    job.runs.push({ at: job.lastRun, status: 'success', result: truncatedResult, durationMs });
    if (job.runs.length > MAX_RUNS) job.runs.shift();

    console.log(`[cron] ✓ "${job.name}" completed in ${(durationMs / 1000).toFixed(1)}s`);

    // Notify UI
    mainWindow.webContents.send('cron:job-completed', {
      id: job.id, name: job.name, status: 'success', result: truncatedResult, durationMs,
    });

  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    const errMsg = err?.message || 'Unknown error';

    job.lastRun = new Date(startTime).toISOString();
    job.lastStatus = 'error';
    job.lastResult = errMsg;
    job.runs.push({ at: job.lastRun, status: 'error', result: errMsg, durationMs });
    if (job.runs.length > MAX_RUNS) job.runs.shift();

    console.error(`[cron] ✗ "${job.name}" failed:`, errMsg);

    mainWindow.webContents.send('cron:job-completed', {
      id: job.id, name: job.name, status: 'error', result: errMsg, durationMs,
    });

  } finally {
    // Cleanup isolated session
    cleanupSession(sessionId);
    purgeSession(sessionId);
    clearHistory(sessionId);

    // Save and reschedule
    saveJobs();
    scheduleJob(job);

    // Update UI with latest job state
    mainWindow?.webContents.send('cron:jobs-updated', getJobsList());
  }
}

const CRON_AGENT_PROMPT = `You are Tappi 🪷, running a scheduled task inside a web browser.

You have access to all browser tools (elements, click, type, navigate, etc.), files, and HTTP requests.
The page is a black box — use elements/text tools to see it.

Rules:
1. Complete the task efficiently.
2. Use grep/search before reading/scrolling.
3. Summarize what you accomplished briefly.
4. If something fails, note the error clearly.

Be concise — your output is stored as a job result summary.
`;

// ─── Public API (for agent tools + IPC) ───

export function initCronManager(
  win: BrowserWindow,
  ctx: BrowserContext,
  config: LLMConfig,
  developerMode: boolean,
): void {
  mainWindow = win;
  browserCtx = ctx;
  llmConfig = config;
  devMode = developerMode;

  loadJobs();

  // Schedule all enabled jobs
  for (const job of jobs.values()) {
    if (job.enabled) scheduleJob(job);
  }

  console.log(`[cron] Initialized with ${jobs.size} jobs (${Array.from(jobs.values()).filter(j => j.enabled).length} enabled)`);
}

export function updateCronContext(ctx: BrowserContext, config: LLMConfig, developerMode: boolean): void {
  browserCtx = ctx;
  llmConfig = config;
  devMode = developerMode;
}

export function addJob(name: string, task: string, schedule: CronJobSchedule): string {
  const id = crypto.randomUUID();
  const job: CronJob = {
    id,
    name,
    task,
    schedule,
    enabled: true,
    createdAt: new Date().toISOString(),
    runs: [],
  };

  jobs.set(id, job);
  scheduleJob(job);
  saveJobs();

  mainWindow?.webContents.send('cron:jobs-updated', getJobsList());

  return `✓ Created job "${name}" (${id})\n  Schedule: ${formatSchedule(schedule)}\n  Next run: ${job.nextRun ? new Date(job.nextRun).toLocaleString() : 'unknown'}`;
}

export function listJobs(): string {
  if (jobs.size === 0) return 'No cron jobs configured.';

  return Array.from(jobs.values()).map(j => {
    const status = j.enabled ? '✅' : '⏸';
    const lastRunStr = j.lastRun
      ? `${j.lastStatus === 'success' ? '✓' : '✗'} ${timeAgo(j.lastRun)}`
      : 'never';
    const nextRunStr = j.nextRun && j.enabled ? new Date(j.nextRun).toLocaleString() : '-';

    return `${status} ${j.name} (${j.id})\n   Schedule: ${formatSchedule(j.schedule)}\n   Next: ${nextRunStr} | Last: ${lastRunStr}`;
  }).join('\n\n');
}

export function updateJob(id: string, updates: Partial<Pick<CronJob, 'name' | 'task' | 'enabled'> & { schedule?: CronJobSchedule }>): string {
  const job = jobs.get(id);
  if (!job) return `❌ Job not found: ${id}`;

  if (updates.name !== undefined) job.name = updates.name;
  if (updates.task !== undefined) job.task = updates.task;
  if (updates.schedule !== undefined) job.schedule = updates.schedule;
  if (updates.enabled !== undefined) job.enabled = updates.enabled;

  scheduleJob(job);
  saveJobs();

  mainWindow?.webContents.send('cron:jobs-updated', getJobsList());

  return `✓ Updated "${job.name}" (${job.id})\n  Enabled: ${job.enabled}\n  Schedule: ${formatSchedule(job.schedule)}\n  Next: ${job.nextRun ? new Date(job.nextRun).toLocaleString() : '-'}`;
}

export function deleteJob(id: string): string {
  const job = jobs.get(id);
  if (!job) return `❌ Job not found: ${id}`;

  const name = job.name;
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  jobs.delete(id);
  saveJobs();

  mainWindow?.webContents.send('cron:jobs-updated', getJobsList());

  return `✓ Deleted job "${name}" (${id})`;
}

export function runJobNow(id: string): string {
  const job = jobs.get(id);
  if (!job) return `❌ Job not found: ${id}`;

  // Execute immediately in background
  executeJob(job);
  return `⏰ Running "${job.name}" now...`;
}

export function getJobsList(): CronJob[] {
  return Array.from(jobs.values());
}

export function getActiveJobCount(): number {
  return Array.from(jobs.values()).filter(j => j.enabled).length;
}

export function cleanupCron(): void {
  for (const timer of timers.values()) {
    clearTimeout(timer);
  }
  timers.clear();
  console.log('[cron] Cleaned up all timers');
}

// ─── Helpers ───

function formatSchedule(s: CronJobSchedule): string {
  switch (s.kind) {
    case 'interval': {
      const ms = s.intervalMs || 60000;
      if (ms >= 3600000) return `every ${(ms / 3600000).toFixed(ms % 3600000 ? 1 : 0)}h`;
      if (ms >= 60000) return `every ${Math.round(ms / 60000)}min`;
      return `every ${Math.round(ms / 1000)}s`;
    }
    case 'daily':
      return `daily at ${s.timeOfDay || '09:00'}`;
    case 'cron':
      return s.cronExpr || '(invalid)';
    default:
      return '(unknown)';
  }
}

function timeAgo(isoStr: string): string {
  const diffMs = Date.now() - new Date(isoStr).getTime();
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
