/**
 * conversation.ts — Conversation history manager (Phase 7.9).
 *
 * Stores full conversation history with structured AI SDK messages (tool calls + results).
 * Uses token-aware rolling window with eviction summaries for LLM context.
 * Full history always searchable via grep, even after messages leave the window.
 */

import type { AssistantModelMessage, ToolModelMessage, ModelMessage } from 'ai';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A message in our conversation store. Can be a simple text message or a structured AI SDK message. */
export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'system'; content: string }
  | AssistantModelMessage
  | ToolModelMessage;

interface ConversationState {
  messages: ChatMessage[];
  /** Cached eviction summary (regenerated when window shifts). */
  evictionSummary: string | null;
  /** Index of last message included in the eviction summary. */
  evictionBoundary: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Target token budget for the rolling window sent to the LLM. */
const WINDOW_TOKEN_BUDGET = 100_000;

/** Rough token estimation: chars / 4. */
function estimateTokens(msg: ChatMessage): number {
  return Math.ceil(extractAllText(msg).length / 4);
}

// ─── State ───────────────────────────────────────────────────────────────────

const conversations = new Map<string, ConversationState>();

function getState(sessionId: string): ConversationState {
  if (!conversations.has(sessionId)) {
    conversations.set(sessionId, { messages: [], evictionSummary: null, evictionBoundary: -1 });
  }
  return conversations.get(sessionId)!;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function getFullHistory(sessionId: string): ChatMessage[] {
  return getState(sessionId).messages;
}

/**
 * Get the rolling window sent to the LLM.
 * - Pins the first user message so the agent never forgets the original task.
 * - Uses token budget (~96K) instead of flat message count.
 * - Prepends eviction summary when messages have been evicted.
 */
export function getWindow(sessionId: string): ChatMessage[] {
  const state = getState(sessionId);
  const full = state.messages;
  if (full.length === 0) return [];

  // Find first user message
  const firstUserIdx = full.findIndex(m => m.role === 'user');

  // Build window from the end, respecting token budget
  let budget = WINDOW_TOKEN_BUDGET;
  let windowStart = full.length; // exclusive start (we'll decrement)

  // Reserve budget for the pinned first user message
  const pinnedCost = firstUserIdx >= 0 ? estimateTokens(full[firstUserIdx]) : 0;
  // Reserve budget for eviction summary (~500 tokens max)
  const summaryReserve = 500;
  budget -= pinnedCost + summaryReserve;

  // Walk backwards from the end
  for (let i = full.length - 1; i >= 0; i--) {
    const cost = estimateTokens(full[i]);
    if (budget - cost < 0 && windowStart < full.length) break; // at least include 1 message
    budget -= cost;
    windowStart = i;
  }

  const windowMessages = full.slice(windowStart);

  // If no messages were evicted, return as-is
  if (windowStart === 0) return full;

  // Build result with pinned first user message + eviction summary + recent window
  const result: ChatMessage[] = [];

  // Pin first user message if it's outside the window
  if (firstUserIdx >= 0 && firstUserIdx < windowStart) {
    result.push(full[firstUserIdx]);
  }

  // Add eviction summary if we have one
  if (state.evictionSummary) {
    result.push({
      role: 'system',
      content: state.evictionSummary,
    });
  }

  // Add the recent window (skip first user msg if it's already pinned and happens to be in window)
  for (const msg of windowMessages) {
    result.push(msg);
  }

  return result;
}

/** Add a message to the conversation. */
export function addMessage(sessionId: string, message: ChatMessage) {
  getState(sessionId).messages.push(message);
}

/** Add multiple messages (e.g., AI SDK ResponseMessage[] from a completed streamText). */
export function addMessages(sessionId: string, messages: ChatMessage[]) {
  const state = getState(sessionId);
  for (const msg of messages) {
    state.messages.push(msg);
  }
}

/** Clear all history for a session. */
export function clearHistory(sessionId: string) {
  conversations.delete(sessionId);
}

/**
 * Update the eviction summary. Called by the agent after each turn to summarize
 * messages that have fallen out of the window.
 *
 * @param sessionId - Session to update
 * @param summary - The summary text
 * @param boundary - Index of the last message covered by this summary
 */
export function setEvictionSummary(sessionId: string, summary: string, boundary: number) {
  const state = getState(sessionId);
  state.evictionSummary = summary;
  state.evictionBoundary = boundary;
}

/**
 * Get messages that have been evicted from the window but not yet summarized.
 * Returns null if no new eviction has occurred.
 */
export function getUnsummarizedEvictedMessages(sessionId: string): { messages: ChatMessage[]; boundary: number } | null {
  const state = getState(sessionId);
  const full = state.messages;
  if (full.length === 0) return null;

  // Calculate current window start (same logic as getWindow)
  let budget = WINDOW_TOKEN_BUDGET - 500; // summary reserve
  const firstUserIdx = full.findIndex(m => m.role === 'user');
  if (firstUserIdx >= 0) budget -= estimateTokens(full[firstUserIdx]);

  let windowStart = full.length;
  for (let i = full.length - 1; i >= 0; i--) {
    const cost = estimateTokens(full[i]);
    if (budget - cost < 0 && windowStart < full.length) break;
    budget -= cost;
    windowStart = i;
  }

  // No eviction happening
  if (windowStart === 0) return null;

  // Check if we already have a summary covering these messages
  if (state.evictionBoundary >= windowStart - 1) return null;

  // Return messages from after the last summary boundary to just before the window
  const start = state.evictionBoundary + 1;
  const end = windowStart;
  if (start >= end) return null;

  return {
    messages: full.slice(start, end),
    boundary: end - 1,
  };
}

// ─── Text Extraction (for grep + token estimation) ──────────────────────────

/**
 * Extract all searchable text from a message, handling both simple string content
 * and structured AI SDK content parts (tool calls, tool results, reasoning, etc.).
 */
function extractAllText(msg: ChatMessage): string {
  if (typeof msg.content === 'string') return msg.content;

  // Structured content — array of parts
  if (!Array.isArray(msg.content)) return '';

  const parts: string[] = [];
  for (const part of msg.content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as any;

    switch (p.type) {
      case 'text':
        if (p.text) parts.push(p.text);
        break;
      case 'tool-call':
        parts.push(`[tool-call: ${p.toolName || ''}(${JSON.stringify(p.args || {})})]`);
        break;
      case 'tool-result':
        parts.push(`[tool-result: ${p.toolName || ''} → ${typeof p.result === 'string' ? p.result : JSON.stringify(p.result || '')}]`);
        break;
      case 'reasoning':
        if (p.text) parts.push(`[reasoning: ${p.text}]`);
        break;
      case 'file':
        parts.push('[file attachment]');
        break;
      default:
        // Unknown part type — try to extract any text
        if (p.text) parts.push(p.text);
        break;
    }
  }

  return parts.join('\n');
}

// ─── Search ──────────────────────────────────────────────────────────────────

/**
 * Search the full conversation history (including messages outside the rolling window).
 * Handles both simple text messages and structured AI SDK messages.
 * Returns matching messages with their index, role, and surrounding context.
 */
export function searchHistory(sessionId: string, grep: string): string {
  const full = getFullHistory(sessionId);
  if (full.length === 0) return 'No conversation history.';

  const grepLower = grep.toLowerCase();
  const matches: string[] = [];
  const seen = new Set<string>(); // deduplicate lines

  for (let i = 0; i < full.length; i++) {
    const msg = full[i];
    const text = extractAllText(msg);

    if (text.toLowerCase().includes(grepLower)) {
      // Show match with context: 1 message before and after
      const start = Math.max(0, i - 1);
      const end = Math.min(full.length - 1, i + 1);
      for (let j = start; j <= end; j++) {
        const m = full[j];
        const prefix = j === i ? '>>> ' : '    ';
        const mText = extractAllText(m);
        const snippet = mText.length > 300 ? mText.slice(0, 297) + '...' : mText;
        const line = `${prefix}[${j}] ${m.role}: ${snippet}`;
        if (!seen.has(line)) {
          seen.add(line);
          matches.push(line);
        }
      }
      if (end < full.length - 1) matches.push('    ---');
    }
  }

  if (matches.length === 0) return `No messages matching "${grep}" in ${full.length} messages.`;

  // Calculate current window boundary for context
  let budget = WINDOW_TOKEN_BUDGET - 500;
  const firstUserIdx = full.findIndex(m => m.role === 'user');
  if (firstUserIdx >= 0) budget -= estimateTokens(full[firstUserIdx]);
  let windowStart = full.length;
  for (let i = full.length - 1; i >= 0; i--) {
    const cost = estimateTokens(full[i]);
    if (budget - cost < 0 && windowStart < full.length) break;
    budget -= cost;
    windowStart = i;
  }

  return [
    `Found matches in history (${full.length} total messages, window starts at [${windowStart}]):`,
    ...matches,
  ].join('\n');
}

// ─── Summary Generation Prompt ───────────────────────────────────────────────

/**
 * Build a prompt for the LLM to summarize evicted messages.
 * Called from agent.ts when messages need summarization.
 */
export function buildSummaryPrompt(evictedMessages: ChatMessage[]): string {
  const transcript: string[] = [];
  for (const msg of evictedMessages) {
    const text = extractAllText(msg);
    if (!text.trim()) continue;
    const snippet = text.length > 500 ? text.slice(0, 497) + '...' : text;
    transcript.push(`${msg.role}: ${snippet}`);
  }

  return `Summarize this conversation excerpt into 2-4 bullet points. Focus on: what the user asked, what was found/done, key facts/URLs/numbers. Be concrete — names, prices, URLs matter. Skip routine tool mechanics.

Conversation:
${transcript.join('\n')}

Summary (2-4 bullets, past tense, ~100 words max):`;
}
