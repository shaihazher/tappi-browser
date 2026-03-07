/**
 * mailbox.ts — Inter-agent messaging system with turn-based wake support.
 *
 * Each teammate has an inbox. Messages are delivered between turns as user-role
 * conversation messages. When a teammate is idle (has an active MessageWaiter),
 * sending a message wakes them immediately.
 */

import { MessageWaiter } from './message-waiter';

export interface MailboxMessage {
  id: string;
  from: string;       // "@lead", "@backend", etc.
  to: string;         // "@frontend", "@all", etc.
  content: string;
  timestamp: string;
  read: boolean;
  type?: 'message' | 'broadcast' | 'shutdown_request' | 'shutdown_response' | 'system';
  summary?: string;   // short preview for UI
}

export interface Mailbox {
  agentName: string;
  messages: MailboxMessage[];
}

// Global mailbox registry per team
const teamMailboxes = new Map<string, Map<string, Mailbox>>();

// Per-agent message waiters for turn-based idle/wake
const agentWaiters = new Map<string, MessageWaiter>();

let messageCounter = 0;

function waiterKey(teamId: string, agentName: string): string {
  return `${teamId}:${agentName}`;
}

// ─── Init ───

export function initMailbox(teamId: string, agentName: string): void {
  if (!teamMailboxes.has(teamId)) {
    teamMailboxes.set(teamId, new Map());
  }
  const boxes = teamMailboxes.get(teamId)!;
  if (!boxes.has(agentName)) {
    boxes.set(agentName, { agentName, messages: [] });
  }
}

// ─── Send ───

export function sendMessage(
  teamId: string,
  from: string,
  to: string,
  content: string,
  options?: { type?: MailboxMessage['type']; summary?: string },
): string {
  const boxes = teamMailboxes.get(teamId);
  if (!boxes) return `Team "${teamId}" not found.`;

  const msg: MailboxMessage = {
    id: `msg-${++messageCounter}`,
    from,
    to,
    content,
    timestamp: new Date().toISOString(),
    read: false,
    type: options?.type || 'message',
    summary: options?.summary,
  };

  if (to === '@all') {
    // Broadcast to everyone except sender
    for (const [name, box] of boxes) {
      if (name !== from) {
        box.messages.push({ ...msg });
        // Wake idle agent
        wakeAgent(teamId, name);
      }
    }
    return `Broadcast to all teammates.`;
  } else {
    const box = boxes.get(to);
    if (!box) return `Teammate "${to}" not found.`;
    box.messages.push(msg);
    // Wake idle agent
    wakeAgent(teamId, to);
    return `Message sent to ${to}.`;
  }
}

/**
 * Wake an idle agent by delivering their unread messages via their MessageWaiter.
 */
function wakeAgent(teamId: string, agentName: string): void {
  const key = waiterKey(teamId, agentName);
  const waiter = agentWaiters.get(key);
  if (waiter && waiter.isWaiting) {
    const unread = getUnreadMessages(teamId, agentName);
    if (unread.length > 0) {
      waiter.deliver(unread);
      agentWaiters.delete(key);
    }
  }
}

// ─── Wait (Turn-Based Idle/Wake) ───

/**
 * Block until messages arrive for this agent or timeout expires.
 * Used by the teammate turn loop to idle between turns.
 *
 * If there are already unread messages, returns them immediately.
 * Otherwise, registers a waiter and blocks.
 */
export async function waitForMessages(
  teamId: string,
  agentName: string,
  timeoutMs: number,
): Promise<MailboxMessage[] | null> {
  // Check for already-queued unread messages first
  const existing = getUnreadMessages(teamId, agentName);
  if (existing.length > 0) {
    return existing;
  }

  // Register a waiter and block
  const key = waiterKey(teamId, agentName);
  const waiter = new MessageWaiter();
  agentWaiters.set(key, waiter);

  try {
    return await waiter.wait(timeoutMs);
  } finally {
    // Clean up waiter regardless of outcome
    agentWaiters.delete(key);
  }
}

/**
 * Cancel any active waiter for an agent (e.g. on abort/interrupt).
 */
export function cancelWaiter(teamId: string, agentName: string): void {
  const key = waiterKey(teamId, agentName);
  const waiter = agentWaiters.get(key);
  if (waiter) {
    waiter.cancel();
    agentWaiters.delete(key);
  }
}

/**
 * Check if an agent is currently idle (waiting for messages).
 */
export function isAgentIdle(teamId: string, agentName: string): boolean {
  const key = waiterKey(teamId, agentName);
  const waiter = agentWaiters.get(key);
  return waiter?.isWaiting ?? false;
}

// ─── Read ───

/**
 * Get unread messages for an agent. Marks them as read.
 */
export function getUnreadMessages(teamId: string, agentName: string): MailboxMessage[] {
  const boxes = teamMailboxes.get(teamId);
  if (!boxes) return [];
  const box = boxes.get(agentName);
  if (!box) return [];

  const unread = box.messages.filter(m => !m.read);
  unread.forEach(m => { m.read = true; });
  return unread;
}

/**
 * Get all messages for an agent (read + unread).
 */
export function getAllMessages(teamId: string, agentName: string): MailboxMessage[] {
  const boxes = teamMailboxes.get(teamId);
  if (!boxes) return [];
  const box = boxes.get(agentName);
  if (!box) return [];
  return [...box.messages];
}

/**
 * Lead: get all messages across all mailboxes in a team.
 */
export function getAllTeamMessages(teamId: string): Record<string, MailboxMessage[]> {
  const boxes = teamMailboxes.get(teamId);
  if (!boxes) return {};
  const result: Record<string, MailboxMessage[]> = {};
  for (const [name, box] of boxes) {
    result[name] = [...box.messages];
  }
  return result;
}

/**
 * Format unread messages as a context injection string.
 * Used for initial turn setup / system prompt context.
 */
export function formatInboxForContext(messages: MailboxMessage[]): string {
  if (messages.length === 0) return '';
  const lines = messages.map(m =>
    `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.from}: ${m.content}`
  );
  return `\n\nInbox (${messages.length} new message${messages.length > 1 ? 's' : ''}):\n${lines.join('\n')}`;
}

/**
 * Format messages for delivery as user-role conversation content.
 * Each message becomes a line in a single user message.
 */
export function formatMessagesForDelivery(messages: MailboxMessage[]): string {
  if (messages.length === 0) return '';
  return messages.map(m => `[Message from ${m.from}]: ${m.content}`).join('\n\n');
}

// ─── Cleanup ───

export function cleanupTeamMailbox(teamId: string): void {
  // Cancel all active waiters for this team
  const boxes = teamMailboxes.get(teamId);
  if (boxes) {
    for (const [name] of boxes) {
      cancelWaiter(teamId, name);
    }
  }
  teamMailboxes.delete(teamId);
}
