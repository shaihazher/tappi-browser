/**
 * output-buffer.ts — Shell Output Discipline Layer
 *
 * PHILOSOPHY: The LLM never sees full command output. Ever.
 * 
 * Every command's stdout+stderr is captured in full into a session-scoped buffer.
 * The LLM receives only: first HEAD_LINES + gap notice + last TAIL_LINES.
 * Full output is searchable via grep at any time.
 * Buffers are purged when the session ends.
 *
 * This is the same grep philosophy from the page indexer applied to shell output:
 * compact default view + unlimited searchable depth.
 */

// ─── Config ───
const HEAD_LINES = 20;   // First N lines the LLM sees
const TAIL_LINES = 20;   // Last N lines the LLM sees
const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB max per output entry (ring buffer for bg processes)

// ─── Types ───

export interface OutputEntry {
  id: number;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;  // null = still running (bg process)
  lines: number;
  bytes: number;
  timestamp: number;
  pid?: number;
  truncatedView: string;   // Pre-computed truncated view for the LLM
}

// Session → OutputEntry[]
const sessions = new Map<string, OutputEntry[]>();
let globalId = 0;

// ─── Core Functions ───

/**
 * Store command output and return the truncated view for the LLM.
 */
export function captureOutput(
  sessionId: string,
  command: string,
  stdout: string,
  stderr: string,
  exitCode: number | null,
  pid?: number,
): OutputEntry {
  if (!sessions.has(sessionId)) sessions.set(sessionId, []);
  const entries = sessions.get(sessionId)!;

  const combined = stdout + (stderr ? '\n' + stderr : '');
  const id = ++globalId;

  const entry: OutputEntry = {
    id,
    command,
    stdout: combined.slice(0, MAX_BUFFER_SIZE), // cap storage
    stderr,
    exitCode,
    lines: combined.split('\n').length,
    bytes: combined.length,
    timestamp: Date.now(),
    pid,
    truncatedView: '', // computed below
  };

  entry.truncatedView = buildTruncatedView(entry);
  entries.push(entry);

  return entry;
}

/**
 * Append output to an existing entry (for background processes).
 * Returns updated truncated view.
 */
export function appendOutput(sessionId: string, id: number, newOutput: string): string {
  const entry = getEntry(sessionId, id);
  if (!entry) return `[out-${id}] not found`;

  // Ring buffer: if over max, keep last MAX_BUFFER_SIZE bytes
  entry.stdout += newOutput;
  if (entry.stdout.length > MAX_BUFFER_SIZE) {
    entry.stdout = entry.stdout.slice(-MAX_BUFFER_SIZE);
  }
  entry.lines = entry.stdout.split('\n').length;
  entry.bytes = entry.stdout.length;
  entry.truncatedView = buildTruncatedView(entry);

  return entry.truncatedView;
}

/**
 * Mark a background process entry as finished.
 */
export function finishEntry(sessionId: string, id: number, exitCode: number): void {
  const entry = getEntry(sessionId, id);
  if (entry) {
    entry.exitCode = exitCode;
    entry.truncatedView = buildTruncatedView(entry);
  }
}

/**
 * Build the truncated view the LLM sees.
 * If output fits within HEAD_LINES + TAIL_LINES, show it all.
 * Otherwise: head + gap notice + tail.
 */
function buildTruncatedView(entry: OutputEntry): string {
  const lines = entry.stdout.split('\n');
  const total = lines.length;
  const parts: string[] = [];

  // Status header
  const status = entry.exitCode === null ? '⏳ running' : entry.exitCode === 0 ? '✓' : `✗ exit ${entry.exitCode}`;
  parts.push(`[out-${entry.id}] $ ${entry.command}  ${status}  (${total} lines, ${formatBytes(entry.bytes)})`);

  if (total <= HEAD_LINES + TAIL_LINES) {
    // Fits — show everything
    parts.push(entry.stdout);
  } else {
    // Truncate: head + gap + tail
    const head = lines.slice(0, HEAD_LINES).join('\n');
    const tail = lines.slice(-TAIL_LINES).join('\n');
    const hidden = total - HEAD_LINES - TAIL_LINES;

    parts.push(head);
    parts.push(`\n--- ${hidden} lines hidden — use exec_grep to search ---\n`);
    parts.push(tail);
  }

  return parts.join('\n');
}

/**
 * Grep across output buffers.
 */
export function grepOutput(
  sessionId: string,
  pattern: string,
  options?: { id?: number; all?: boolean; context?: number },
): string {
  const ctx = options?.context ?? 2;
  const entries = sessions.get(sessionId) || [];

  if (entries.length === 0) return 'No command output in this session.';

  // Determine which entries to search
  let targets: OutputEntry[];
  if (options?.id !== undefined) {
    const entry = entries.find(e => e.id === options.id);
    if (!entry) return `[out-${options.id}] not found.`;
    targets = [entry];
  } else if (options?.all) {
    targets = entries;
  } else {
    // Default: last command
    targets = [entries[entries.length - 1]];
  }

  const patternLower = pattern.toLowerCase();
  const results: string[] = [];

  for (const entry of targets) {
    const lines = entry.stdout.split('\n');
    const matchIndices: Set<number> = new Set();

    // Find matching line indices
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(patternLower)) {
        // Add match + context lines
        for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) {
          matchIndices.add(j);
        }
      }
    }

    if (matchIndices.size === 0) continue;

    const sorted = Array.from(matchIndices).sort((a, b) => a - b);
    results.push(`[out-${entry.id}] $ ${entry.command} — ${sorted.filter(i => lines[i].toLowerCase().includes(patternLower)).length} matches:`);

    let lastIdx = -2;
    for (const idx of sorted) {
      if (idx > lastIdx + 1) results.push('  ---');
      const isMatch = lines[idx].toLowerCase().includes(patternLower);
      const prefix = isMatch ? '>>> ' : '    ';
      results.push(`${prefix}${idx + 1}: ${lines[idx]}`);
      lastIdx = idx;
    }
  }

  if (results.length === 0) {
    const searchScope = options?.all ? 'all outputs' : options?.id ? `out-${options.id}` : 'last output';
    return `No matches for "${pattern}" in ${searchScope}.`;
  }

  return results.join('\n');
}

/**
 * Get the truncated view of a specific output entry.
 */
export function getOutputView(sessionId: string, id: number): string {
  const entry = getEntry(sessionId, id);
  if (!entry) return `[out-${id}] not found.`;
  return entry.truncatedView;
}

/**
 * List all output entries in a session (compact summary).
 */
export function listOutputs(sessionId: string): string {
  const entries = sessions.get(sessionId) || [];
  if (entries.length === 0) return 'No command output in this session.';

  return entries.map(e => {
    const status = e.exitCode === null ? '⏳' : e.exitCode === 0 ? '✓' : '✗';
    return `[out-${e.id}] ${status} ${e.command} (${e.lines} lines, ${formatBytes(e.bytes)})`;
  }).join('\n');
}

/**
 * Purge all output for a session.
 */
export function purgeSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/**
 * Get raw entry (internal use).
 */
function getEntry(sessionId: string, id: number): OutputEntry | undefined {
  return sessions.get(sessionId)?.find(e => e.id === id);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
