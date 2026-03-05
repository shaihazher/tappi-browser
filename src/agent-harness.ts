/**
 * agent-harness.ts — Shared resilience utilities for the Vercel AI SDK agent path.
 *
 * Provides: error classification, retry logic, tool result truncation,
 * progress assessment (replaces crude idle detection), and continuation state.
 *
 * Used by: agent.ts, sub-agent.ts, team-manager.ts.
 * NOT used by: claude-code-provider.ts (has its own subprocess model).
 */

// ─── Error Classification ────────────────────────────────────────────────────

export type ErrorCategory =
  | 'rate_limit'
  | 'overloaded'
  | 'network'
  | 'context_length'
  | 'malformed'
  | 'auth'
  | 'abort'
  | 'server_error'
  | 'unknown';

export interface ClassifiedError {
  category: ErrorCategory;
  retryable: boolean;
  maxRetries: number;
  suggestedDelayMs: number;
  message: string;
}

/**
 * Classify an error to determine retry strategy.
 * Extracts status codes from common error shapes across providers.
 */
export function classifyError(err: any): ClassifiedError {
  const msg = String(err?.message || '').toLowerCase();
  const statusCode =
    err?.statusCode ?? err?.status ?? err?.cause?.statusCode ?? err?.cause?.status ?? 0;
  const causeCode = String(err?.cause?.code || '').toLowerCase();
  const errName = String(err?.name || '');

  // Abort — intentional, never retry
  if (errName === 'AbortError' || msg.includes('aborted') || msg.includes('aborterror')) {
    return { category: 'abort', retryable: false, maxRetries: 0, suggestedDelayMs: 0, message: 'Aborted' };
  }

  // Auth — never retry
  if (statusCode === 401 || statusCode === 403) {
    return { category: 'auth', retryable: false, maxRetries: 0, suggestedDelayMs: 0, message: err?.message || 'Authentication error' };
  }

  // Rate limit (429)
  if (statusCode === 429 || msg.includes('rate limit') || msg.includes('too many requests')) {
    return { category: 'rate_limit', retryable: true, maxRetries: 3, suggestedDelayMs: 15_000, message: 'Rate limited' };
  }

  // Overloaded (529 Anthropic)
  if (statusCode === 529 || msg.includes('overloaded')) {
    return { category: 'overloaded', retryable: true, maxRetries: 3, suggestedDelayMs: 30_000, message: 'API overloaded' };
  }

  // Context length exceeded
  if (
    msg.includes('context length') ||
    msg.includes('context_length') ||
    msg.includes('max_tokens') ||
    msg.includes('too long') ||
    msg.includes('maximum context') ||
    msg.includes('token limit')
  ) {
    return { category: 'context_length', retryable: true, maxRetries: 1, suggestedDelayMs: 0, message: 'Context length exceeded' };
  }

  // Network errors (reuse pattern from llm-client.ts isRetryableCodexNetworkError)
  if (
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('socket hang up') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('eai_again') ||
    causeCode === 'econnreset' ||
    causeCode === 'econnrefused' ||
    causeCode === 'etimedout' ||
    causeCode === 'eai_again'
  ) {
    return { category: 'network', retryable: true, maxRetries: 3, suggestedDelayMs: 2_000, message: 'Network error' };
  }

  // Malformed response / JSON parse errors
  if (
    msg.includes('json') ||
    msg.includes('parse') ||
    msg.includes('unexpected token') ||
    msg.includes('malformed')
  ) {
    return { category: 'malformed', retryable: true, maxRetries: 1, suggestedDelayMs: 1_000, message: 'Malformed response' };
  }

  // Server errors (5xx)
  if (statusCode >= 500 && statusCode < 600) {
    return { category: 'server_error', retryable: true, maxRetries: 3, suggestedDelayMs: 5_000, message: `Server error (${statusCode})` };
  }

  // Unknown — retry once conservatively
  return { category: 'unknown', retryable: true, maxRetries: 1, suggestedDelayMs: 3_000, message: err?.message || 'Unknown error' };
}

// ─── Tool Result Truncation ──────────────────────────────────────────────────

interface TruncationOptions {
  /** Max bytes for the most recent N tool results */
  recentMaxBytes?: number;
  /** Max bytes for older tool results */
  olderMaxBytes?: number;
  /** Number of "recent" tool results to keep at higher limit */
  recentCount?: number;
}

/**
 * Tiered truncation of tool results in a message array.
 * Recent results keep more context, older ones are trimmed aggressively.
 * Mutates and returns the messages array.
 */
export function truncateToolResults(
  messages: any[],
  opts: TruncationOptions = {},
): any[] {
  const {
    recentMaxBytes = 8192,
    olderMaxBytes = 2048,
    recentCount = 3,
  } = opts;

  // Find all tool-role message indices
  const toolIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'tool') {
      toolIndices.push(i);
    }
  }

  if (toolIndices.length === 0) return messages;

  // The last `recentCount` tool messages get the higher limit
  const recentStart = Math.max(0, toolIndices.length - recentCount);

  for (let t = 0; t < toolIndices.length; t++) {
    const idx = toolIndices[t];
    const maxBytes = t >= recentStart ? recentMaxBytes : olderMaxBytes;
    const msg = messages[idx];

    if (typeof msg.content === 'string' && msg.content.length > maxBytes) {
      messages[idx] = { ...msg, content: msg.content.slice(0, maxBytes) + '\n...(truncated)' };
    } else if (Array.isArray(msg.content)) {
      messages[idx] = {
        ...msg,
        content: msg.content.map((part: any) => {
          if (
            part?.type === 'tool-result' &&
            typeof part.result === 'string' &&
            part.result.length > maxBytes
          ) {
            return { ...part, result: part.result.slice(0, maxBytes) + '\n...(truncated)' };
          }
          return part;
        }),
      };
    }
  }

  return messages;
}

// ─── Progress Assessment ─────────────────────────────────────────────────────

export interface ProgressState {
  /** Consecutive steps with 0 tool calls (no active sub-agents) */
  textOnlySteps: number;
  /** Consecutive steps calling the exact same tool+args */
  repeatedToolSteps: number;
  /** Last tool+args signature for repeat detection */
  lastToolSignature: string;
  /** Total steps since user message */
  totalSteps: number;
  /** Set of unique tool names used */
  uniqueToolsUsed: Set<string>;
  /** Step number of last detected "real progress" */
  lastProgressCheckpoint: number;
  /** Tool errors in the last N steps */
  recentErrors: number;
  /** Step number of last reflection injection */
  lastReflectionStep: number;
  /** Timestamp of last time-based reflection */
  lastTimeReflectionMs: number;
  /** Run start timestamp */
  runStartMs: number;
}

export function createProgressState(): ProgressState {
  return {
    textOnlySteps: 0,
    repeatedToolSteps: 0,
    lastToolSignature: '',
    totalSteps: 0,
    uniqueToolsUsed: new Set(),
    lastProgressCheckpoint: 0,
    recentErrors: 0,
    lastReflectionStep: 0,
    lastTimeReflectionMs: Date.now(),
    runStartMs: Date.now(),
  };
}

export type ProgressAction =
  | 'continue'
  | 'inject_reflection'
  | 'inject_course_correction'
  | 'abort';

export interface ProgressAssessment {
  action: ProgressAction;
  reason?: string;
}

/**
 * Multi-signal progress scoring. Returns what action to take.
 * Replaces the crude `idleCount >= 5 → abort`.
 */
export function assessProgress(state: ProgressState): ProgressAssessment {
  // Hard abort: 10+ text-only steps (was 5, now more forgiving)
  if (state.textOnlySteps >= 10) {
    return { action: 'abort', reason: `${state.textOnlySteps} consecutive text-only steps` };
  }

  // Reflection: 5 text-only steps
  if (state.textOnlySteps >= 5) {
    return {
      action: 'inject_reflection',
      reason: `${state.textOnlySteps} text-only steps — checking if stuck`,
    };
  }

  // Course correction: 4+ repeated tool calls with same args
  if (state.repeatedToolSteps >= 4) {
    return {
      action: 'inject_course_correction',
      reason: `Same tool+args called ${state.repeatedToolSteps} times in a row`,
    };
  }

  // Reflection: 15+ steps since last progress with low tool diversity
  if (
    state.totalSteps - state.lastProgressCheckpoint >= 15 &&
    state.uniqueToolsUsed.size <= 2
  ) {
    return {
      action: 'inject_reflection',
      reason: `${state.totalSteps - state.lastProgressCheckpoint} steps since last progress checkpoint with only ${state.uniqueToolsUsed.size} unique tools`,
    };
  }

  // Course correction: 3+ tool errors in recent window
  if (state.recentErrors >= 3) {
    return {
      action: 'inject_course_correction',
      reason: `${state.recentErrors} tool errors in recent steps`,
    };
  }

  return { action: 'continue' };
}

/**
 * Update progress state after a step finishes.
 * Returns true if meaningful progress was detected (for checkpoint updates).
 */
export function updateProgressState(
  state: ProgressState,
  event: {
    toolCalls: Array<{ toolName: string; args?: any }>;
    toolResults: Array<{ toolName: string; result?: any; output?: any }>;
    hasActiveSubAgents: boolean;
    hasError?: boolean;
  },
): boolean {
  state.totalSteps++;

  const { toolCalls, toolResults, hasActiveSubAgents, hasError } = event;

  // Track errors
  if (hasError) {
    state.recentErrors++;
  } else if (state.recentErrors > 0 && toolResults.length > 0) {
    // Decay errors on successful tool use
    state.recentErrors = Math.max(0, state.recentErrors - 1);
  }

  // Text-only step tracking — suppress when sub-agents are active
  if (toolResults.length === 0 && !hasActiveSubAgents) {
    state.textOnlySteps++;
  } else if (toolResults.length > 0) {
    state.textOnlySteps = 0;
  }
  // When sub-agents are active and no tool results, don't increment (waiting is expected)

  // Repeated tool detection
  if (toolCalls.length === 1) {
    const sig = `${toolCalls[0].toolName}:${JSON.stringify(toolCalls[0].args || {})}`;
    if (sig === state.lastToolSignature) {
      state.repeatedToolSteps++;
    } else {
      state.repeatedToolSteps = 0;
      state.lastToolSignature = sig;
    }
  } else if (toolCalls.length > 1) {
    state.repeatedToolSteps = 0;
    state.lastToolSignature = '';
  }

  // Track unique tools
  let newToolUsed = false;
  for (const tr of toolResults) {
    if (!state.uniqueToolsUsed.has(tr.toolName)) {
      state.uniqueToolsUsed.add(tr.toolName);
      newToolUsed = true;
    }
  }

  // Detect meaningful progress: new tool used, or substantial content returned
  const hasSubstantialResult = toolResults.some(tr => {
    const content = tr.result ?? tr.output ?? '';
    const len = typeof content === 'string' ? content.length : JSON.stringify(content).length;
    return len > 100;
  });

  if (newToolUsed || hasSubstantialResult) {
    state.lastProgressCheckpoint = state.totalSteps;
    return true;
  }

  return false;
}

// ─── Reflection Prompts ──────────────────────────────────────────────────────

export function buildReflectionPrompt(state: ProgressState): string {
  const elapsedMin = Math.floor((Date.now() - state.runStartMs) / 60_000);
  return `[Progress check: You've been working for ${state.totalSteps} steps (${elapsedMin}m). Are you making progress toward the user's request? If stuck, try a different approach. If done, provide your final answer.]`;
}

export function buildCourseCorrection(reason: string): string {
  return `[Course correction: You appear to be stuck (${reason}). Step back, reassess, and try a fundamentally different approach. If the current approach isn't working, explain what's blocking you.]`;
}

export function buildBudgetWarning(stepsUsed: number, maxSteps: number): string {
  return `[Budget warning: You've used ${stepsUsed}/${maxSteps} steps. Synthesize your findings and provide your answer now.]`;
}

export function buildSelfCheckPrompt(toolCalls: number, elapsedMin: number): string {
  return `[Self-check after ${toolCalls} tool calls and ${elapsedMin} minutes]: Briefly assess: (1) Are you on track? (2) What have you accomplished? (3) What remains? If done, provide your final answer.`;
}

export function buildTimeReflection(elapsedMin: number): string {
  return `[${elapsedMin} minutes elapsed]: Summarize what you've accomplished and what remains. If mostly done, wrap up.`;
}

// ─── Continuation State ──────────────────────────────────────────────────────

export interface ContinuationState {
  reason: 'timeout' | 'error' | 'context_length';
  toolCallCount: number;
  lastAction: string;
  elapsedMs: number;
  partialResponse: string;
  timestamp: number;
}

const continuationStore = new Map<string, ContinuationState>();

export function buildContinuationState(
  reason: ContinuationState['reason'],
  toolCallCount: number,
  lastAction: string,
  elapsedMs: number,
  partialResponse: string,
): ContinuationState {
  return {
    reason,
    toolCallCount,
    lastAction,
    elapsedMs,
    partialResponse: partialResponse.slice(0, 500), // keep it compact
    timestamp: Date.now(),
  };
}

export function setContinuationState(sessionId: string, state: ContinuationState): void {
  continuationStore.set(sessionId, state);
}

export function getContinuationState(sessionId: string): ContinuationState | undefined {
  return continuationStore.get(sessionId);
}

export function clearContinuationState(sessionId: string): void {
  continuationStore.delete(sessionId);
}

export function buildContinuationPrimer(state: ContinuationState): string {
  const reasonLabels: Record<string, string> = {
    timeout: 'timeout',
    error: 'unrecoverable error',
    context_length: 'context length exceeded',
  };
  return `[Continuation from previous run that ended due to ${reasonLabels[state.reason] || state.reason}. ${state.toolCallCount} tool calls completed. Last action: ${state.lastAction}. Resume from where you left off.]`;
}

// ─── Token Estimation ────────────────────────────────────────────────────────

/**
 * Rough token estimate for a message array. chars / 4.
 */
export function estimateMessageTokens(messages: any[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === 'string') chars += part.length;
        else if (part?.text) chars += part.text.length;
        else if (part?.result) chars += (typeof part.result === 'string' ? part.result.length : JSON.stringify(part.result).length);
        else chars += JSON.stringify(part || '').length;
      }
    }
  }
  return Math.ceil(chars / 4);
}
