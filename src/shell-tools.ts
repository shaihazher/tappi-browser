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
import { getWorkspacePath } from './workspace-resolver';

const DEFAULT_TIMEOUT = 30_000; // 30s for sync exec
const SHELL = process.env.SHELL || '/bin/bash';
const HOME = process.env.HOME || process.env.USERPROFILE || '/';

// ─── Phase 9.096b: Shell Command Guardrails ───
// Light guardrails — block commands that target critical directories.
// Not a sandbox. Just a hard floor to prevent catastrophic deletions.

const STATIC_PROTECTED_PATHS = [
  HOME,                                          // ~/
  '/',                                           // root
  path.join(HOME, '.tappi-browser'),             // app data
  path.join(HOME, '.tappi'),                     // tappi config
  path.dirname(process.execPath),                // electron binary dir
  // The app's own source dir (if running in dev mode)
  path.resolve(__dirname, '..'),                 // tappi-browser project root (dist/../)
  path.resolve(__dirname, '..', 'src'),          // source dir
];

// Dynamic protected paths — e.g., the active team's working directory
const dynamicProtectedPaths = new Set<string>();

/** Add a path to the dynamic protection list (e.g., active team working dir). */
export function addProtectedPath(p: string): void {
  const resolved = path.resolve(p.replace(/^~/, HOME));
  dynamicProtectedPaths.add(resolved);
}

/** Remove a path from the dynamic protection list. */
export function removeProtectedPath(p: string): void {
  const resolved = path.resolve(p.replace(/^~/, HOME));
  dynamicProtectedPaths.delete(resolved);
}

// ─── Contract File Soft-Guard ─────────────────────────────────────────────────
// Contract files should be edited via team_write_contracts, not raw shell commands.
// We warn (but don't block) when a shell command appears to write to them.

const contractFilePaths = new Set<string>();

/** Register a contract file path so shell writes to it trigger a warning. */
export function addContractFilePath(p: string): void {
  contractFilePaths.add(path.resolve(p.replace(/^~/, HOME)));
}

/** Deregister a contract file path (call when team dissolves). */
export function removeContractFilePath(p: string): void {
  contractFilePaths.delete(path.resolve(p.replace(/^~/, HOME)));
}

/** Clear all registered contract file paths (call on team dissolve). */
export function clearContractFilePaths(): void {
  contractFilePaths.clear();
}

const WRITE_OP_PATTERNS = [
  /\s>[> ]/, /\btee\b/, /\bcp\b.*\s+\S+\s*$/, /\bmv\b.*\s+\S+\s*$/,
  /\bsed\s+-i\b/, /\becho\b.*>/, /\bcat\b.*>/, /\bprintf\b.*>/, /\btouch\b/,
];

/**
 * Check if command writes to a registered contract file.
 * Returns a ⚠️ warning string if so, null otherwise.
 */
function checkContractFileWrite(command: string): string | null {
  if (contractFilePaths.size === 0) return null;
  const normalizedCmd = command.replace(/~/g, HOME);
  const isWriteOp = WRITE_OP_PATTERNS.some(p => p.test(normalizedCmd));
  if (!isWriteOp) return null;
  for (const contractPath of contractFilePaths) {
    const basename = path.basename(contractPath);
    if (normalizedCmd.includes(contractPath) || normalizedCmd.includes(basename)) {
      return `\n\n⚠️ You're modifying a contract file directly (${basename}). Use team_write_contracts instead — it auto-copies to all worktrees and keeps contracts in sync.`;
    }
  }
  return null;
}

function getProtectedPaths(): string[] {
  return [...STATIC_PROTECTED_PATHS, ...dynamicProtectedPaths];
}

// Patterns that indicate destructive recursive operations
const DESTRUCTIVE_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f?|--recursive|-[a-zA-Z]*f[a-zA-Z]*r)\b/,  // rm -rf, rm -r, rm -fr
  /\brm\s+-[a-zA-Z]*f[a-zA-Z]*\s/,                                          // rm -f (less destructive but flag it on protected paths)
  /\brmdir\b/,
  /\btrash\b/,
  /\bmv\s+.*\s+.*[\/]?\.?Trash/i,                                           // mv ... .Trash
  /\bsudo\s+rm\b/,
];

/**
 * Check if a command targets a protected path with a destructive operation.
 * Returns an error message if blocked, null if allowed.
 */
function checkCommandSafety(command: string): string | null {
  const isDestructive = DESTRUCTIVE_PATTERNS.some(p => p.test(command));
  if (!isDestructive) return null;

  // Normalize and expand paths in the command for matching
  const normalizedCmd = command.replace(/~/g, HOME);

  for (const protectedPath of getProtectedPaths()) {
    // Check if command contains a path that IS the protected path or is its parent
    // We check both the exact path and with trailing slash
    const patterns = [
      protectedPath,
      protectedPath + '/',
      protectedPath + ' ',
      `"${protectedPath}"`,
      `'${protectedPath}'`,
    ];

    for (const pattern of patterns) {
      if (normalizedCmd.includes(pattern)) {
        return `🛡️ BLOCKED: Destructive operation targeting protected path "${protectedPath}".\n` +
               `Protected paths: ~/, /, ~/.tappi-browser/, ~/.tappi/, and the app source directory.\n` +
               `If you need to delete files, target specific subdirectories or files instead.`;
      }
    }

    // Also check if ~ shorthand is used and it matches
    const tildeVersion = protectedPath.replace(HOME, '~');
    if (command.includes(tildeVersion + '/') || command.includes(tildeVersion + ' ') ||
        command.includes(`"${tildeVersion}"`) || command.includes(`'${tildeVersion}'`) ||
        command.endsWith(tildeVersion)) {
      // Only block if the tilde path IS the protected path, not a subdir of it
      // e.g., block "rm -rf ~/" but allow "rm -rf ~/Documents/Tappi/temp"
      const cmdParts = command.split(/\s+/);
      for (const part of cmdParts) {
        const cleanPart = part.replace(/^["']|["']$/g, '').replace(/\/+$/, '');
        const expandedPart = cleanPart.replace(/^~/, HOME);
        const resolvedProtected = protectedPath.replace(/\/+$/, '');
        if (expandedPart === resolvedProtected) {
          return `🛡️ BLOCKED: Destructive operation targeting protected path "${protectedPath}".\n` +
                 `Protected paths: ~/, /, ~/.tappi-browser/, ~/.tappi/, and the app source directory.\n` +
                 `If you need to delete files, target specific subdirectories or files instead.`;
        }
      }
    }
  }

  return null;
}

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
  // Phase 9.096b: Check command safety before execution
  const safetyError = checkCommandSafety(command);
  if (safetyError) return safetyError;

  const cwd = ensureCwd(options?.cwd || getWorkspacePath());
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

  // Contract file soft-guard
  const contractWarn = checkContractFileWrite(command);

  let result = entry.truncatedView;
  if (installHint) result += '\n\n' + installHint;
  if (contractWarn) result += contractWarn;
  return result;
}

// ─── exec_bg — Run a command in the background ───

export function shellExecBg(
  sessionId: string,
  command: string,
  options?: { cwd?: string; env?: Record<string, string> },
): string {
  // Phase 9.096b: Check command safety before execution
  const safetyError = checkCommandSafety(command);
  if (safetyError) return safetyError;

  // F16: enforce background process limit
  if (bgProcesses.size >= MAX_BG_PROCESSES) {
    return `❌ Max ${MAX_BG_PROCESSES} background processes reached. Kill existing processes first.`;
  }

  const cwd = ensureCwd(options?.cwd || getWorkspacePath());

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

  const contractWarnBg = checkContractFileWrite(command);
  const bgMsg = `⏳ Background process started: PID ${child.pid}\n  Command: ${command}\n  Output: out-${entry.id}\n  Check: exec_status(${child.pid}) | Kill: exec_kill(${child.pid})`;
  return contractWarnBg ? bgMsg + contractWarnBg : bgMsg;
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
