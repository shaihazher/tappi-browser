/**
 * shell-tools.ts — Developer Mode shell access.
 *
 * Provides exec/exec_bg/exec_status/exec_kill with the output discipline layer.
 * All output is captured → truncated for the LLM → full output greppable.
 *
 * SECURITY: Only available when Developer Mode is ON.
 * The tool-registry conditionally includes these tools based on config.
 */

import { execSync, spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { captureOutput, appendOutput, finishEntry, grepOutput, listOutputs, getOutputView } from './output-buffer';

const DEFAULT_TIMEOUT = 30_000; // 30s for sync exec
const DEFAULT_CWD = path.join(process.env.HOME || process.env.USERPROFILE || '.', 'tappi-workspace');
const SHELL = process.env.SHELL || '/bin/bash';

// ─── Install Detection ───

/**
 * Detect if a command looks like a tool installation.
 * If it does AND exited successfully, append a nudge to the output
 * reminding the LLM to register the tool.
 *
 * This is a nudge, not auto-registration — the LLM still needs to
 * call register_tool with the right name/description. But it won't forget.
 */
const INSTALL_PATTERNS: Array<{ regex: RegExp; extractName: (m: RegExpMatchArray) => string; via: (cmd: string) => string }> = [
  // brew install <pkg>
  { regex: /\bbrew\s+install\s+(\S+)/, extractName: m => m[1], via: cmd => cmd.trim() },
  // npm install -g <pkg>
  { regex: /\bnpm\s+(?:install|i)\s+(?:-g|--global)\s+(\S+)/, extractName: m => m[1].replace(/@.*$/, ''), via: cmd => cmd.trim() },
  // pip install <pkg> / pip3 install <pkg> / uv pip install <pkg>
  { regex: /\b(?:uv\s+)?pip3?\s+install\s+(?!-r)(\S+)/, extractName: m => m[1].replace(/[=><].*$/, ''), via: cmd => cmd.trim() },
  // cargo install <pkg>
  { regex: /\bcargo\s+install\s+(\S+)/, extractName: m => m[1], via: cmd => cmd.trim() },
  // go install <pkg>
  { regex: /\bgo\s+install\s+(\S+)/, extractName: m => m[1].split('/').pop()!.replace(/@.*$/, ''), via: cmd => cmd.trim() },
  // gem install <pkg>
  { regex: /\bgem\s+install\s+(\S+)/, extractName: m => m[1], via: cmd => cmd.trim() },
  // apt install / apt-get install
  { regex: /\bapt(?:-get)?\s+install\s+(?:-y\s+)?(\S+)/, extractName: m => m[1], via: cmd => cmd.trim() },
  // dnf install / yum install
  { regex: /\b(?:dnf|yum)\s+install\s+(?:-y\s+)?(\S+)/, extractName: m => m[1], via: cmd => cmd.trim() },
];

function detectInstallCommand(command: string, exitCode: number): string | null {
  if (exitCode !== 0) return null; // Only nudge on successful installs

  for (const pattern of INSTALL_PATTERNS) {
    const match = command.match(pattern.regex);
    if (match) {
      const name = pattern.extractName(match);
      const via = pattern.via(command);
      return `💡 Detected tool installation: "${name}" via \`${via}\`. Call register_tool to track it.`;
    }
  }

  return null;
}

// ─── Background Process Registry ───

interface BgProcess {
  pid: number;
  command: string;
  process: ChildProcess;
  outputId: number;       // Links to output-buffer entry
  sessionId: string;
  startedAt: number;
}

const bgProcesses = new Map<number, BgProcess>();
const MAX_BG_PROCESSES = 20; // F16: max background processes

// Ensure workspace exists
function ensureCwd(cwd: string): string {
  if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });
  return cwd;
}

// ─── exec — Run a command synchronously ───

export function shellExec(
  sessionId: string,
  command: string,
  options?: { cwd?: string; timeout?: number; env?: Record<string, string> },
): string {
  const cwd = ensureCwd(options?.cwd || DEFAULT_CWD);
  const timeout = options?.timeout || DEFAULT_TIMEOUT;

  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    const result = execSync(command, {
      cwd,
      timeout,
      shell: SHELL,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024, // 50MB max buffer
      env: { ...process.env, ...options?.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    stdout = result || '';
  } catch (err: any) {
    // execSync throws on non-zero exit
    stdout = err.stdout || '';
    stderr = err.stderr || '';
    exitCode = err.status ?? 1;

    if (err.killed) {
      stderr += `\n[TIMEOUT] Command killed after ${timeout / 1000}s`;
      exitCode = 124; // standard timeout exit code
    }
  }

  const entry = captureOutput(sessionId, command, stdout, stderr, exitCode);

  // Auto-detect tool installations and nudge the LLM
  const installHint = detectInstallCommand(command, exitCode);
  if (installHint) {
    return entry.truncatedView + '\n\n' + installHint;
  }

  return entry.truncatedView;
}

// ─── exec_bg — Run a command in the background ───

export function shellExecBg(
  sessionId: string,
  command: string,
  options?: { cwd?: string; env?: Record<string, string> },
): string {
  // F16: enforce background process limit
  if (bgProcesses.size >= MAX_BG_PROCESSES) {
    return `❌ Max ${MAX_BG_PROCESSES} background processes reached. Kill existing processes first.`;
  }

  const cwd = ensureCwd(options?.cwd || DEFAULT_CWD);

  const child = spawn(SHELL, ['-c', command], {
    cwd,
    env: { ...process.env, ...options?.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  if (!child.pid) {
    return `❌ Failed to start: ${command}`;
  }

  // Create initial output entry
  const entry = captureOutput(sessionId, command, '', '', null, child.pid);

  const bgProc: BgProcess = {
    pid: child.pid,
    command,
    process: child,
    outputId: entry.id,
    sessionId,
    startedAt: Date.now(),
  };
  bgProcesses.set(child.pid, bgProc);

  // Stream output into the buffer
  child.stdout?.on('data', (chunk: Buffer) => {
    appendOutput(sessionId, entry.id, chunk.toString());
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    appendOutput(sessionId, entry.id, chunk.toString());
  });

  child.on('exit', (code) => {
    finishEntry(sessionId, entry.id, code ?? 1);
    bgProcesses.delete(child.pid!);
  });

  child.on('error', (err) => {
    appendOutput(sessionId, entry.id, `\n[ERROR] ${err.message}\n`);
    finishEntry(sessionId, entry.id, 1);
    bgProcesses.delete(child.pid!);
  });

  return `⏳ Background process started: PID ${child.pid}\n  Command: ${command}\n  Output: out-${entry.id}\n  Check: exec_status(${child.pid}) | Kill: exec_kill(${child.pid})`;
}

// ─── exec_status — Check background process status ───

export function shellExecStatus(sessionId: string, pid: number): string {
  const bgProc = bgProcesses.get(pid);

  if (!bgProc) {
    return `PID ${pid} not found in active background processes.`;
  }

  const running = !bgProc.process.killed && bgProc.process.exitCode === null;
  const uptime = Math.round((Date.now() - bgProc.startedAt) / 1000);

  // Get the truncated view of recent output
  const outputView = getOutputView(bgProc.sessionId, bgProc.outputId);

  return [
    `PID ${pid}: ${running ? '⏳ running' : '✓ exited'} (${uptime}s)`,
    `Command: ${bgProc.command}`,
    '',
    outputView,
  ].join('\n');
}

// ─── exec_kill — Kill a background process ───

export function shellExecKill(pid: number): string {
  const bgProc = bgProcesses.get(pid);

  if (!bgProc) {
    return `Cannot kill PID ${pid}: not a tracked agent process`;
  }

  try {
    bgProc.process.kill('SIGTERM');
    // Give it 3s, then SIGKILL
    setTimeout(() => {
      if (!bgProc.process.killed) {
        bgProc.process.kill('SIGKILL');
      }
    }, 3000);
    return `✓ Sent SIGTERM to PID ${pid} (${bgProc.command})`;
  } catch (err: any) {
    return `Failed to kill PID ${pid}: ${err.message}`;
  }
}

// ─── exec_grep — Search output buffers ───

export function shellExecGrep(
  sessionId: string,
  pattern: string,
  options?: { id?: number; all?: boolean; context?: number },
): string {
  return grepOutput(sessionId, pattern, options);
}

// ─── exec_list — List all outputs in session ───

export function shellExecList(sessionId: string): string {
  return listOutputs(sessionId);
}

// ─── Cleanup — Kill all bg processes for a session ───

export function cleanupSession(sessionId: string): void {
  for (const [pid, proc] of bgProcesses) {
    if (proc.sessionId === sessionId) {
      try { proc.process.kill('SIGKILL'); } catch {}
      bgProcesses.delete(pid);
    }
  }
}

// Kill all bg processes on app exit
export function cleanupAll(): void {
  for (const [pid, proc] of bgProcesses) {
    try { proc.process.kill('SIGKILL'); } catch {}
    bgProcesses.delete(pid);
  }
}
