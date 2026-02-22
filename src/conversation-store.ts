/**
 * conversation-store.ts — Persistent conversation history (Phase 8.35.3).
 *
 * Stores conversations and messages in SQLite.
 * Provides CRUD, search, auto-title generation, and agent-readable tools.
 */

import { randomUUID } from 'crypto';
import { getDb } from './database';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Conversation {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
  preview: string;
  archived: number;
}

export interface ConversationMessage {
  id: number;
  conversation_id: string;
  role: string;
  content: string;
  created_at: string;
  token_estimate: number;
}

// ─── Conversations CRUD ───────────────────────────────────────────────────────

export function createConversation(id?: string): Conversation {
  const db = getDb();
  const convId = id || randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO conversations (id, title, created_at, updated_at, message_count, preview, archived)
     VALUES (?, NULL, ?, ?, 0, '', 0)`
  ).run(convId, now, now);
  return { id: convId, title: null, created_at: now, updated_at: now, message_count: 0, preview: '', archived: 0 };
}

export function getConversation(id: string): Conversation | null {
  return getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation | null;
}

export function listConversations(limit = 50, includeArchived = false): Conversation[] {
  const db = getDb();
  if (includeArchived) {
    return db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?').all(limit) as Conversation[];
  }
  return db.prepare('SELECT * FROM conversations WHERE archived = 0 ORDER BY updated_at DESC LIMIT ?').all(limit) as Conversation[];
}

export function updateConversationTitle(id: string, title: string): void {
  getDb().prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
    .run(title, new Date().toISOString(), id);
}

export function archiveConversation(id: string): void {
  getDb().prepare('UPDATE conversations SET archived = 1 WHERE id = ?').run(id);
}

export function deleteConversation(id: string): void {
  // CASCADE deletes messages too (via FK)
  getDb().prepare('DELETE FROM conversations WHERE id = ?').run(id);
}

function touchConversation(id: string, preview?: string): void {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) as c FROM conversation_messages WHERE conversation_id = ?').get(id) as any).c;
  if (preview !== undefined) {
    db.prepare('UPDATE conversations SET updated_at = ?, message_count = ?, preview = ? WHERE id = ?')
      .run(new Date().toISOString(), count, preview, id);
  } else {
    db.prepare('UPDATE conversations SET updated_at = ?, message_count = ? WHERE id = ?')
      .run(new Date().toISOString(), count, id);
  }
}

// ─── Messages CRUD ────────────────────────────────────────────────────────────

export function addConversationMessage(
  conversationId: string,
  role: string,
  content: string
): ConversationMessage {
  const db = getDb();
  const now = new Date().toISOString();

  // Serialize content: if it's already a string, store as-is; otherwise JSON-stringify
  const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
  const tokenEstimate = Math.ceil(contentStr.length / 4);

  const info = db.prepare(
    `INSERT INTO conversation_messages (conversation_id, role, content, created_at, token_estimate)
     VALUES (?, ?, ?, ?, ?)`
  ).run(conversationId, role, contentStr, now, tokenEstimate);

  // Update conversation preview (first user message)
  const conv = getConversation(conversationId);
  if (role === 'user' && conv && !conv.preview) {
    const preview = contentStr.slice(0, 100);
    touchConversation(conversationId, preview);
  } else {
    touchConversation(conversationId);
  }

  return {
    id: info.lastInsertRowid as number,
    conversation_id: conversationId,
    role,
    content: contentStr,
    created_at: now,
    token_estimate: tokenEstimate,
  };
}

export function getConversationMessages(
  conversationId: string,
  offset = 0,
  limit = 100
): ConversationMessage[] {
  return getDb().prepare(
    `SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?`
  ).all(conversationId, limit, offset) as ConversationMessage[];
}

export function getConversationMessageCount(conversationId: string): number {
  return ((getDb().prepare('SELECT COUNT(*) as c FROM conversation_messages WHERE conversation_id = ?').get(conversationId) as any)?.c || 0);
}

// ─── Auto-title generation ────────────────────────────────────────────────────

/**
 * Generate a short title from the first assistant response.
 * Called from agent.ts after the first assistant response in a new conversation.
 */
export function generateAutoTitle(conversationId: string, assistantText: string): string {
  // Take first ~100 chars of the assistant response, extract first sentence/phrase
  const text = assistantText.replace(/[#*`_\[\]()]/g, '').trim();
  const firstSentence = text.split(/[.!?\n]/)[0].trim();
  const words = firstSentence.split(/\s+/).slice(0, 6).join(' ');
  const title = words.length > 3 ? words : text.slice(0, 40).trim();
  if (title) {
    updateConversationTitle(conversationId, title);
  }
  return title;
}

// ─── Full-text search ─────────────────────────────────────────────────────────

export interface SearchResult {
  conversation_id: string;
  message_id: number;
  role: string;
  snippet: string;
  created_at: string;
  conversation_title: string | null;
}

export function searchConversations(
  query: string,
  conversationId?: string,
  limit = 20
): SearchResult[] {
  const db = getDb();
  try {
    // Sanitize FTS5 special chars: quotes, parens, asterisk, caret, plus, minus
    const ftsQuery = query.replace(/["'()*^+\-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!ftsQuery) return [];

    let sql: string;
    let params: any[];

    if (conversationId) {
      sql = `
        SELECT cm.conversation_id, cm.id as message_id, cm.role,
               snippet(conversation_messages_fts, 0, '[', ']', '...', 20) as snippet,
               cm.created_at, c.title as conversation_title
        FROM conversation_messages_fts fts
        JOIN conversation_messages cm ON cm.id = fts.rowid
        JOIN conversations c ON c.id = cm.conversation_id
        WHERE conversation_messages_fts MATCH ? AND cm.conversation_id = ?
        ORDER BY rank
        LIMIT ?
      `;
      params = [ftsQuery, conversationId, limit];
    } else {
      sql = `
        SELECT cm.conversation_id, cm.id as message_id, cm.role,
               snippet(conversation_messages_fts, 0, '[', ']', '...', 20) as snippet,
               cm.created_at, c.title as conversation_title
        FROM conversation_messages_fts fts
        JOIN conversation_messages cm ON cm.id = fts.rowid
        JOIN conversations c ON c.id = cm.conversation_id
        WHERE conversation_messages_fts MATCH ? AND c.archived = 0
        ORDER BY rank
        LIMIT ?
      `;
      params = [ftsQuery, limit];
    }

    return db.prepare(sql).all(...params) as SearchResult[];
  } catch (e) {
    console.error('[conv-store] FTS search error:', e);
    // Fallback to LIKE search
    const q = `%${query}%`;
    return db.prepare(
      `SELECT cm.conversation_id, cm.id as message_id, cm.role,
              SUBSTR(cm.content, 1, 200) as snippet,
              cm.created_at, c.title as conversation_title
       FROM conversation_messages cm
       JOIN conversations c ON c.id = cm.conversation_id
       WHERE cm.content LIKE ? ${conversationId ? 'AND cm.conversation_id = ?' : ''}
       ORDER BY cm.created_at DESC LIMIT ?`
    ).all(...(conversationId ? [q, conversationId, limit] : [q, limit])) as SearchResult[];
  }
}

// ─── Agent-readable access (Phase 8.35.4) ────────────────────────────────────

const MAX_MSG_CHARS = 500;

export function agentListConversations(limit = 20, grep?: string): string {
  const convs = listConversations(Math.min(limit, 50));
  if (convs.length === 0) return 'No conversations yet.';

  const filtered = grep
    ? convs.filter(c =>
        (c.title || '').toLowerCase().includes(grep.toLowerCase()) ||
        c.preview.toLowerCase().includes(grep.toLowerCase())
      )
    : convs;

  if (filtered.length === 0) return `No conversations matching "${grep}".`;

  const lines = filtered.map(c => {
    const date = c.updated_at.slice(0, 10);
    const title = c.title || '(untitled)';
    const preview = c.preview ? ` — "${c.preview.slice(0, 60)}"` : '';
    return `• [${c.id.slice(0, 8)}] ${date} | ${title} (${c.message_count} msgs)${preview}`;
  });

  return `Conversations (${filtered.length}):\n${lines.join('\n')}\n\nUse conversations_read({ conversation_id: "..." }) to read messages.`;
}

export function agentSearchConversations(query: string, conversationId?: string, limit = 20): string {
  const results = searchConversations(query, conversationId, Math.min(limit, 50));
  if (results.length === 0) return `No messages matching "${query}".`;

  const db = getDb();
  const groups = new Map<string, SearchResult[]>();
  for (const r of results) {
    if (!groups.has(r.conversation_id)) groups.set(r.conversation_id, []);
    groups.get(r.conversation_id)!.push(r);
  }

  const lines: string[] = [`Search results for "${query}" (${results.length} matches):\n`];
  for (const [convId, msgs] of groups) {
    const conv = getConversation(convId);
    lines.push(`Conversation: ${conv?.title || '(untitled)'} [${convId.slice(0, 8)}]`);

    for (const m of msgs) {
      // Get context (±2 messages)
      const msgId = m.message_id;
      const ctx = db.prepare(
        `SELECT id, role, content FROM conversation_messages
         WHERE conversation_id = ? AND id BETWEEN ? AND ?
         ORDER BY id ASC LIMIT 5`
      ).all(convId, Math.max(1, msgId - 2), msgId + 2) as any[];

      for (const ctxMsg of ctx) {
        const isMatch = ctxMsg.id === msgId;
        const prefix = isMatch ? '>>> ' : '    ';
        const content = typeof ctxMsg.content === 'string' ? ctxMsg.content : JSON.stringify(ctxMsg.content);
        const snippet = content.slice(0, MAX_MSG_CHARS);
        lines.push(`${prefix}[msg#${ctxMsg.id}] ${ctxMsg.role}: ${snippet}${content.length > MAX_MSG_CHARS ? '...' : ''}`);
      }
      lines.push('    ---');
    }
    lines.push('');
  }

  lines.push(`Use conversations_read({ conversation_id: "...", offset: 0 }) for full messages.`);
  return lines.join('\n');
}

export function agentReadConversation(
  conversationId: string,
  offset = 0,
  limit = 20,
  grep?: string
): string {
  // Exact match first; if not found and ID looks like a short prefix, do LIKE prefix search
  let conv = getConversation(conversationId);
  if (!conv && conversationId.length < 36) {
    const matches = getDb().prepare(
      `SELECT * FROM conversations WHERE id LIKE ? ORDER BY updated_at DESC LIMIT 2`
    ).all(`${conversationId}%`) as Conversation[];
    if (matches.length === 1) {
      conv = matches[0];
      conversationId = matches[0].id; // use the resolved full UUID
    } else if (matches.length > 1) {
      return `Ambiguous short ID "${conversationId}" matches ${matches.length} conversations. Use a longer prefix or the full UUID from conversations_list.`;
    }
  }
  if (!conv) return `Conversation "${conversationId}" not found.`;

  const clampedLimit = Math.min(limit, 20);
  const messages = getConversationMessages(conversationId, offset, clampedLimit + 1); // +1 to detect more
  const hasMore = messages.length > clampedLimit;
  const toShow = messages.slice(0, clampedLimit);

  let filtered = toShow;
  if (grep) {
    filtered = toShow.filter(m => m.content.toLowerCase().includes(grep.toLowerCase()));
  }

  if (filtered.length === 0) {
    if (grep) return `No messages matching "${grep}" in offset range ${offset}-${offset + clampedLimit}.`;
    return `No messages at offset ${offset} (conversation has ${conv.message_count} messages).`;
  }

  const lines: string[] = [
    `Conversation: ${conv.title || '(untitled)'} [${conversationId}]`,
    `Messages ${offset}–${offset + filtered.length - 1} of ${conv.message_count} total:`,
    '',
  ];

  for (let i = 0; i < filtered.length; i++) {
    const m = filtered[i];
    const content = m.content.slice(0, MAX_MSG_CHARS);
    const truncated = m.content.length > MAX_MSG_CHARS;
    lines.push(`[${offset + i}] ${m.role}: ${content}${truncated ? '...(truncated)' : ''}`);
  }

  if (hasMore && !grep) {
    lines.push('');
    lines.push(`[${offset + clampedLimit} more messages] Use offset=${offset + clampedLimit} to continue.`);
  }

  return lines.join('\n');
}
