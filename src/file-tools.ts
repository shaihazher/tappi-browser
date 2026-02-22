/**
 * file-tools.ts — File management tools for the agent.
 *
 * Read, write, list, and manage files in the workspace directory.
 * The agent can create markdown, CSV, JSON, text, HTML files —
 * anything it needs to save research, export data, or produce deliverables.
 *
 * Workspace: ~/tappi-workspace/ (created on first use)
 * The agent can also access absolute paths when explicitly requested.
 */

import * as fs from 'fs';
import * as path from 'path';

const WORKSPACE = path.join(process.env.HOME || process.env.USERPROFILE || '.', 'tappi-workspace');

function ensureWorkspace() {
  if (!fs.existsSync(WORKSPACE)) fs.mkdirSync(WORKSPACE, { recursive: true });
}

function resolvePath(filePath: string): string {
  // Absolute paths pass through; relative paths resolve to workspace
  if (path.isAbsolute(filePath)) return filePath;
  ensureWorkspace();
  return path.join(WORKSPACE, filePath);
}

// ─── File Operations ───

export function fileWrite(filePath: string, content: string): string {
  if (!filePath) return 'Usage: file write <path> <content>';
  if (!content && content !== '') return 'Usage: file write <path> <content>';

  const resolved = resolvePath(filePath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(resolved, content, 'utf-8');
  const size = fs.statSync(resolved).size;
  return `Written: ${resolved} (${formatBytes(size)})`;
}

// Token estimation: ~4 chars per token (conservative for code/prose mix)
const CHARS_PER_TOKEN = 4;
const TOKEN_THRESHOLD = 20_000; // 20K tokens
const BYTE_THRESHOLD = TOKEN_THRESHOLD * CHARS_PER_TOKEN; // ~80KB

export interface FileReadOptions {
  grep?: string;
  offset?: number;   // byte offset for chunked reading
  limit?: number;    // byte limit for chunked reading
}

export function fileRead(filePath: string, options?: FileReadOptions): string {
  if (!filePath) return 'Usage: file read <path>';

  const resolved = resolvePath(filePath);
  if (!fs.existsSync(resolved)) return `File not found: ${resolved}`;

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) return `"${resolved}" is a directory. Use: file list ${filePath}`;

  // ── Grep mode: stream line-by-line, return matches with context ──
  if (options?.grep) {
    return fileGrepInternal(resolved, options.grep, 2, GREP_CHAR_CAP);
  }

  // ── Chunked read mode: byte offset + limit for sub-agent parallelism ──
  if (options?.offset !== undefined || options?.limit !== undefined) {
    const byteOffset = options.offset || 0;
    const byteLimit = Math.min(options.limit || BYTE_THRESHOLD, BYTE_THRESHOLD);
    const fd = fs.openSync(resolved, 'r');
    const buf = Buffer.alloc(byteLimit);
    const bytesRead = fs.readSync(fd, buf, 0, byteLimit, byteOffset);
    fs.closeSync(fd);
    const content = buf.slice(0, bytesRead).toString('utf-8');
    const header = `${resolved} — bytes ${byteOffset}-${byteOffset + bytesRead} of ${stat.size} (${formatBytes(bytesRead)})`;
    const hasMore = byteOffset + bytesRead < stat.size;
    return hasMore
      ? `${header}\n${content}\n\n... more data available. Next chunk: offset=${byteOffset + bytesRead}`
      : `${header}\n${content}`;
  }

  // ── Standard read with token-aware gate ──
  if (stat.size > BYTE_THRESHOLD) {
    const lineCount = countLines(resolved);
    const estimatedTokens = Math.ceil(stat.size / CHARS_PER_TOKEN);
    const preview = readFirstNLines(resolved, 5);
    const ext = path.extname(resolved).toLowerCase();

    return [
      `⚠️ LARGE FILE — not loaded to save context.`,
      ``,
      `📄 ${resolved}`,
      `   Size: ${formatBytes(stat.size)} | Lines: ${lineCount} | ~${estimatedTokens.toLocaleString()} tokens`,
      `   Type: ${ext || 'unknown'}`,
      ``,
      `Preview (first 5 lines):`,
      `───`,
      preview,
      `───`,
      ``,
      `Options (re-call file_read with these params):`,
      `  • grep: "search term" — find specific content (recommended)`,
      `  • offset: 0, limit: 80000 — read first ~20K tokens`,
      `  • Or use file_head / file_tail / file_grep / spawn_agent`,
    ].join('\n');
  }

  return fs.readFileSync(resolved, 'utf-8');
}

// ─── Internal helpers for smart reading ───

const GREP_TOKEN_CAP = 5_000; // max tokens for grep results
const GREP_CHAR_CAP = GREP_TOKEN_CAP * CHARS_PER_TOKEN; // ~20KB

function countLines(filePath: string): number {
  const buf = fs.readFileSync(filePath);
  let count = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0A) count++;
  }
  return count + 1; // last line may not end with newline
}

function readFirstNLines(filePath: string, n: number): string {
  const content = fs.readFileSync(filePath, 'utf-8');
  return content.split('\n').slice(0, n).join('\n');
}

/**
 * Grep a file with context lines, capped at a token budget.
 * Used by both file_read(grep=...) and fileGrep().
 */
function fileGrepInternal(resolvedPath: string, grep: string, contextLines: number, charCap: number): string {
  const content = fs.readFileSync(resolvedPath, 'utf-8');
  const lines = content.split('\n');
  const grepLower = grep.toLowerCase();
  const matchIndices = new Set<number>();
  let matchCount = 0;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(grepLower)) {
      matchCount++;
      for (let j = Math.max(0, i - contextLines); j <= Math.min(lines.length - 1, i + contextLines); j++) {
        matchIndices.add(j);
      }
    }
  }

  if (matchIndices.size === 0) return `No matches for "${grep}" in ${resolvedPath} (${lines.length} lines scanned).`;

  const sorted = [...matchIndices].sort((a, b) => a - b);
  const output: string[] = [];
  let lastIdx = -2;
  let totalChars = 0;

  for (const idx of sorted) {
    if (idx > lastIdx + 1) output.push('---');
    const marker = lines[idx].toLowerCase().includes(grepLower) ? '>>>' : '   ';
    const line = `${marker} ${idx + 1}: ${lines[idx]}`;
    totalChars += line.length + 1;
    if (totalChars > charCap) {
      output.push(`... (capped at ~${GREP_TOKEN_CAP.toLocaleString()} tokens — ${matchCount} total matches)`);
      break;
    }
    output.push(line);
    lastIdx = idx;
  }

  return `${resolvedPath} — ${matchCount} match${matchCount !== 1 ? 'es' : ''} for "${grep}":\n${output.join('\n')}`;
}

export function fileReadRange(filePath: string, from: number, to: number): string {
  if (!filePath) return 'Usage: file_read_range(path, from, to)';

  const resolved = resolvePath(filePath);
  if (!fs.existsSync(resolved)) return `File not found: ${resolved}`;

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) return `"${resolved}" is a directory.`;

  const content = fs.readFileSync(resolved, 'utf-8');
  const allLines = content.split('\n');

  // Clamp range (1-indexed input)
  const start = Math.max(0, (from || 1) - 1);
  const end = Math.min(allLines.length, to || allLines.length);

  if (start >= allLines.length) return `Line ${from} is beyond file end (${allLines.length} lines).`;

  const slice = allLines.slice(start, end);
  const result = slice.map((line, i) => `${start + i + 1}: ${line}`).join('\n');

  // Safety cap: don't return more than ~20K tokens worth
  if (result.length > BYTE_THRESHOLD) {
    const truncAt = BYTE_THRESHOLD;
    const truncLines = result.slice(0, truncAt).split('\n');
    const lastFullLine = truncLines.length - 1;
    return [
      truncLines.slice(0, lastFullLine).join('\n'),
      ``,
      `... truncated at ~${TOKEN_THRESHOLD.toLocaleString()} tokens. Showing lines ${from}-${start + lastFullLine}. Use a smaller range.`,
    ].join('\n');
  }

  const header = `${resolved} — lines ${start + 1}-${end} of ${allLines.length}`;
  return `${header}\n${result}`;
}

export function fileHead(filePath: string, lines: number = 20): string {
  const resolved = resolvePath(filePath);
  if (!fs.existsSync(resolved)) return `File not found: ${resolved}`;

  const content = fs.readFileSync(resolved, 'utf-8');
  const allLines = content.split('\n');
  const result = allLines.slice(0, lines).join('\n');
  if (allLines.length > lines) {
    return result + `\n... (${allLines.length - lines} more lines)`;
  }
  return result;
}

export function fileTail(filePath: string, lines: number = 20): string {
  const resolved = resolvePath(filePath);
  if (!fs.existsSync(resolved)) return `File not found: ${resolved}`;

  const content = fs.readFileSync(resolved, 'utf-8');
  const allLines = content.split('\n');
  if (allLines.length <= lines) return content;
  return `... (${allLines.length - lines} lines above)\n` + allLines.slice(-lines).join('\n');
}

export function fileAppend(filePath: string, content: string): string {
  if (!filePath || !content) return 'Usage: file append <path> <content>';

  const resolved = resolvePath(filePath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.appendFileSync(resolved, content + '\n', 'utf-8');
  return `Appended to: ${resolved}`;
}

export function fileDelete(filePath: string): string {
  if (!filePath) return 'Usage: file delete <path>';

  const resolved = resolvePath(filePath);
  if (!fs.existsSync(resolved)) return `File not found: ${resolved}`;

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    fs.rmSync(resolved, { recursive: true });
    return `Deleted directory: ${resolved}`;
  }

  fs.unlinkSync(resolved);
  return `Deleted: ${resolved}`;
}

export function fileList(dirPath?: string): string {
  const resolved = dirPath ? resolvePath(dirPath) : WORKSPACE;
  ensureWorkspace();

  if (!fs.existsSync(resolved)) return `Directory not found: ${resolved}`;
  if (!fs.statSync(resolved).isDirectory()) return `Not a directory: ${resolved}`;

  const entries = fs.readdirSync(resolved, { withFileTypes: true });
  if (entries.length === 0) return `(empty directory: ${resolved})`;

  const lines = entries.map(e => {
    const fullPath = path.join(resolved, e.name);
    if (e.isDirectory()) return `📁 ${e.name}/`;
    const stat = fs.statSync(fullPath);
    return `📄 ${e.name} (${formatBytes(stat.size)})`;
  });

  return `${resolved}/\n` + lines.join('\n');
}

export function fileCopy(src: string, dest: string): string {
  if (!src || !dest) return 'Usage: file copy <source> <destination>';

  const resolvedSrc = resolvePath(src);
  const resolvedDest = resolvePath(dest);

  if (!fs.existsSync(resolvedSrc)) return `Source not found: ${resolvedSrc}`;

  const destDir = path.dirname(resolvedDest);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  fs.copyFileSync(resolvedSrc, resolvedDest);
  return `Copied: ${resolvedSrc} → ${resolvedDest}`;
}

export function fileMove(src: string, dest: string): string {
  if (!src || !dest) return 'Usage: file move <source> <destination>';

  const resolvedSrc = resolvePath(src);
  const resolvedDest = resolvePath(dest);

  if (!fs.existsSync(resolvedSrc)) return `Source not found: ${resolvedSrc}`;

  const destDir = path.dirname(resolvedDest);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  fs.renameSync(resolvedSrc, resolvedDest);
  return `Moved: ${resolvedSrc} → ${resolvedDest}`;
}

// ─── Structured File Creators ───

export function createCSV(filePath: string, headers: string[], rows: string[][]): string {
  if (!filePath) return 'Usage: provide a file path';

  const escape = (val: string) => {
    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
      return '"' + val.replace(/"/g, '""') + '"';
    }
    return val;
  };

  const lines = [
    headers.map(escape).join(','),
    ...rows.map(row => row.map(escape).join(',')),
  ];

  return fileWrite(filePath, lines.join('\n'));
}

export function createJSON(filePath: string, data: any): string {
  if (!filePath) return 'Usage: provide a file path';
  return fileWrite(filePath, JSON.stringify(data, null, 2));
}

// ─── Grep ───

export function fileGrep(filePath: string, grep: string, contextLines = 1): string {
  if (!filePath || !grep) return 'Usage: file_grep(path, grep)';
  const resolved = resolvePath(filePath);
  if (!fs.existsSync(resolved)) return `File not found: ${filePath}`;

  try {
    return fileGrepInternal(resolved, grep, contextLines, GREP_CHAR_CAP);
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

// ─── Helpers ───

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
