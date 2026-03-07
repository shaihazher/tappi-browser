/**
 * working-context.ts — Session-scoped working directory tracking.
 *
 * Tracks the last active working directory and written file per session.
 * This helps agents remember where they were working across turns,
 * avoiding the need to re-discover paths via file_list.
 *
 * Key design: Each session has its own isolated context.
 * Teammates inherit parent's working dir at spawn time (handled in team-manager.ts).
 */

interface WorkingContext {
  workingDir: string | null;
  lastFile: string | null;
}

// Session-keyed working contexts
const workingContexts = new Map<string, WorkingContext>();

/**
 * Get the working context for a session, creating if needed.
 */
function getContext(sessionId: string): WorkingContext {
  if (!workingContexts.has(sessionId)) {
    workingContexts.set(sessionId, { workingDir: null, lastFile: null });
  }
  return workingContexts.get(sessionId)!;
}

/**
 * Get the active working directory for a session.
 * Returns null if not set (agent should fall back to default workspace).
 */
export function getWorkingDir(sessionId: string): string | null {
  return getContext(sessionId).workingDir;
}

/**
 * Set the active working directory for a session.
 * Called after successful file writes to track where the agent is working.
 */
export function setWorkingDir(sessionId: string, dir: string): void {
  getContext(sessionId).workingDir = dir;
}

/**
 * Get the last written file for a session.
 * Useful for "read what you just wrote" prompts.
 */
export function getLastFile(sessionId: string): string | null {
  return getContext(sessionId).lastFile;
}

/**
 * Set the last written file for a session.
 */
export function setLastFile(sessionId: string, filePath: string): void {
  getContext(sessionId).lastFile = filePath;
}

/**
 * Clear the working context for a session.
 * Called when a session ends or is explicitly reset.
 */
export function resetContext(sessionId: string): void {
  workingContexts.delete(sessionId);
}

/**
 * Get both working dir and last file as a context block for injection.
 * Returns null if neither is set.
 */
export function getWorkingContextBlock(sessionId: string): string | null {
  const ctx = getContext(sessionId);
  const parts: string[] = [];
  
  if (ctx.workingDir) {
    parts.push(`Working Dir: ${ctx.workingDir}`);
  }
  if (ctx.lastFile) {
    parts.push(`Last File: ${ctx.lastFile}`);
  }
  
  return parts.length > 0 ? parts.join('\n') : null;
}
