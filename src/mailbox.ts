/**
 * mailbox.ts — Inter-agent messaging system (Phase 8.38).
 *
 * Each teammate has an inbox. Unread messages are injected into context
 * on each agent turn. The lead can read all mailboxes; teammates only their own.
 * Messages are lightweight text only.
 */

export interface MailboxMessage {
  id: string;
  from: string;       // "@lead", "@backend", etc.
  to: string;         // "@frontend", "@all", etc.
  content: string;
  timestamp: string;
  read: boolean;
}

export interface Mailbox {
  agentName: string;
  messages: MailboxMessage[];
}

// Global mailbox registry per team
const teamMailboxes = new Map<string, Map<string, Mailbox>>();

let messageCounter = 0;

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
): string {
  const boxes = teamMailboxes.get(teamId);
  if (!boxes) return `❌ Team "${teamId}" not found.`;

  const msg: MailboxMessage = {
    id: `msg-${++messageCounter}`,
    from,
    to,
    content,
    timestamp: new Date().toISOString(),
    read: false,
  };

  if (to === '@all') {
    // Broadcast to everyone except sender
    for (const [name, box] of boxes) {
      if (name !== from) {
        box.messages.push({ ...msg });
      }
    }
    return `✓ Broadcast to all teammates.`;
  } else {
    const box = boxes.get(to);
    if (!box) return `❌ Teammate "${to}" not found.`;
    box.messages.push(msg);
    return `✓ Message sent to ${to}.`;
  }
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
 */
export function formatInboxForContext(messages: MailboxMessage[]): string {
  if (messages.length === 0) return '';
  const lines = messages.map(m =>
    `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.from}: ${m.content}`
  );
  return `\n\n📬 **Inbox (${messages.length} new message${messages.length > 1 ? 's' : ''}):**\n${lines.join('\n')}`;
}

// ─── Cleanup ───

export function cleanupTeamMailbox(teamId: string): void {
  teamMailboxes.delete(teamId);
}
