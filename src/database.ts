/**
 * database.ts — SQLite storage layer for Tappi Browser.
 *
 * Tables: history, bookmarks, credentials, permissions, settings.
 * Uses better-sqlite3 for synchronous, in-process SQLite.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

const DB_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.tappi-browser');
const DB_PATH = path.join(DB_DIR, 'tappi.db');

let db: Database.Database;

export function initDatabase(dbPath?: string): Database.Database {
  if (db) return db;
  const resolvedPath = dbPath || DB_PATH;
  const resolvedDir = path.dirname(resolvedPath);
  if (!fs.existsSync(resolvedDir)) fs.mkdirSync(resolvedDir, { recursive: true });

  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // ─── History ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      title TEXT DEFAULT '',
      domain TEXT DEFAULT '',
      visit_time INTEGER NOT NULL,
      transition TEXT DEFAULT 'link',
      visit_count INTEGER DEFAULT 1
    )
  `);
  // Migration: add visit_count if missing (existing DBs)
  try { db.exec(`ALTER TABLE history ADD COLUMN visit_count INTEGER DEFAULT 1`); } catch {}
  db.exec(`CREATE INDEX IF NOT EXISTS idx_history_time ON history(visit_time DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_history_domain ON history(domain)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_history_url ON history(url)`);

  // ─── Bookmarks (migration from JSON) ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      title TEXT DEFAULT '',
      folder TEXT DEFAULT '',
      favicon TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      last_visited TEXT DEFAULT NULL,
      visit_count INTEGER DEFAULT 0
    )
  `);
  // Migration: add new columns if missing (existing DBs)
  try { db.exec(`ALTER TABLE bookmarks ADD COLUMN last_visited TEXT DEFAULT NULL`); } catch {}
  try { db.exec(`ALTER TABLE bookmarks ADD COLUMN visit_count INTEGER DEFAULT 0`); } catch {}
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bookmarks_url ON bookmarks(url)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bookmarks_folder ON bookmarks(folder)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bookmarks_created ON bookmarks(created_at DESC)`);

  // ─── Downloads ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      url TEXT NOT NULL,
      path TEXT NOT NULL,
      size INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed'
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_downloads_created ON downloads(created_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status)`);

  // ─── Credentials (password vault) ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      username TEXT NOT NULL,
      password_enc TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used INTEGER DEFAULT 0,
      UNIQUE(domain, username)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_credentials_domain ON credentials(domain)`);

  // ─── Site permissions ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      permission TEXT NOT NULL,
      allowed INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      UNIQUE(domain, permission)
    )
  `);

  // ─── Conversations (Phase 8.35) ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      message_count INTEGER DEFAULT 0,
      preview TEXT DEFAULT '',
      archived INTEGER DEFAULT 0
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      token_estimate INTEGER DEFAULT 0
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_messages ON conversation_messages(conversation_id, created_at)`);

  // ─── Projects (Phase 9.07) ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      working_dir TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived INTEGER DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS project_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      conversation_id TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_project_artifacts ON project_artifacts(project_id)`);

  // ─── Scripts (Phase 10: Scriptify) ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS scripts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      script_type TEXT NOT NULL DEFAULT 'agent',
      input_schema TEXT,
      script_body TEXT NOT NULL,
      source_conversation_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_run TEXT,
      run_count INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_scripts_updated ON scripts(updated_at DESC)`);
  // Migration: add auth_requirements column if missing
  try { db.exec(`ALTER TABLE scripts ADD COLUMN auth_requirements TEXT`); } catch {}
  // Migration: add domains column for playbook tracking
  try { db.exec(`ALTER TABLE scripts ADD COLUMN domains TEXT`); } catch {}

  // Domain playbooks: structural domain knowledge persisted across sessions
  db.exec(`
    CREATE TABLE IF NOT EXISTS domain_playbooks (
      domain TEXT PRIMARY KEY,
      playbook TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER DEFAULT 1
    )
  `);

  // Safe migrations: add project_id + mode columns to conversations if not present
  try { db.exec(`ALTER TABLE conversations ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL`); } catch {}
  try { db.exec(`ALTER TABLE conversations ADD COLUMN mode TEXT DEFAULT 'chat'`); } catch {}
  try { db.exec(`ALTER TABLE conversations ADD COLUMN cc_session_id TEXT DEFAULT NULL`); } catch {}

  // FTS5 for full-text search across conversation messages
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS conversation_messages_fts USING fts5(
      content,
      conversation_id UNINDEXED,
      message_id UNINDEXED,
      content='conversation_messages',
      content_rowid='id'
    )
  `);

  // Triggers to keep FTS index in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS conv_msg_ai AFTER INSERT ON conversation_messages BEGIN
      INSERT INTO conversation_messages_fts(rowid, content, conversation_id, message_id) VALUES (new.id, new.content, new.conversation_id, new.id);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS conv_msg_ad AFTER DELETE ON conversation_messages BEGIN
      INSERT INTO conversation_messages_fts(conversation_messages_fts, rowid, content, conversation_id, message_id) VALUES ('delete', old.id, old.content, old.conversation_id, old.id);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS conv_msg_au AFTER UPDATE ON conversation_messages BEGIN
      INSERT INTO conversation_messages_fts(conversation_messages_fts, rowid, content, conversation_id, message_id) VALUES ('delete', old.id, old.content, old.conversation_id, old.id);
      INSERT INTO conversation_messages_fts(rowid, content, conversation_id, message_id) VALUES (new.id, new.content, new.conversation_id, new.id);
    END
  `);

  return db;
}

export function getDb(): Database.Database {
  if (!db) initDatabase();
  return db;
}

// ─── History operations ───

export function addHistory(url: string, title: string): void {
  if (!url || url.startsWith('file://') || url === 'about:blank') return;
  const domain = extractDomain(url);
  const d = getDb();
  // Check if this URL was visited recently (same day) — increment visit_count
  const existing = d.prepare(
    `SELECT id, visit_count FROM history WHERE url = ? ORDER BY visit_time DESC LIMIT 1`
  ).get(url) as { id: number; visit_count: number } | undefined;
  if (existing) {
    d.prepare(
      `UPDATE history SET visit_count = visit_count + 1, visit_time = ?, title = ? WHERE id = ?`
    ).run(Date.now(), title || '', existing.id);
  } else {
    d.prepare(
      'INSERT INTO history (url, title, domain, visit_time, visit_count) VALUES (?, ?, ?, ?, 1)'
    ).run(url, title || '', domain, Date.now());
  }
}

export function searchHistory(query: string, limit = 20): Array<{ url: string; title: string; domain: string; visit_time: number }> {
  const q = `%${query}%`;
  return getDb().prepare(
    `SELECT DISTINCT url, title, domain, MAX(visit_time) as visit_time
     FROM history
     WHERE url LIKE ? OR title LIKE ?
     GROUP BY url
     ORDER BY visit_time DESC
     LIMIT ?`
  ).all(q, q, limit) as any[];
}

export function getRecentHistory(limit = 20): Array<{ url: string; title: string; domain: string; visit_time: number }> {
  return getDb().prepare(
    `SELECT url, title, domain, visit_time
     FROM history
     ORDER BY visit_time DESC
     LIMIT ?`
  ).all(limit) as any[];
}

export function clearHistory(timeRange?: 'today' | 'week' | 'all'): number {
  const d = getDb();
  if (!timeRange || timeRange === 'all') {
    const info = d.prepare('DELETE FROM history').run();
    return info.changes;
  }
  const now = Date.now();
  const cutoff = timeRange === 'today'
    ? now - 24 * 60 * 60 * 1000
    : now - 7 * 24 * 60 * 60 * 1000;
  const info = d.prepare('DELETE FROM history WHERE visit_time > ?').run(cutoff);
  return info.changes;
}

// ─── Bookmark operations ───

export function addBookmark(url: string, title = '', folder = '', favicon = ''): boolean {
  try {
    getDb().prepare(
      'INSERT OR REPLACE INTO bookmarks (url, title, folder, favicon, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(url, title, folder, favicon, Date.now());
    return true;
  } catch { return false; }
}

export function removeBookmark(url: string): boolean {
  const info = getDb().prepare('DELETE FROM bookmarks WHERE url = ?').run(url);
  return info.changes > 0;
}

export function isBookmarked(url: string): boolean {
  const row = getDb().prepare('SELECT 1 FROM bookmarks WHERE url = ?').get(url);
  return !!row;
}

export function getAllBookmarks(): Array<{ url: string; title: string; folder: string; favicon: string; created_at: number }> {
  return getDb().prepare('SELECT * FROM bookmarks ORDER BY created_at DESC').all() as any[];
}

export function searchBookmarks(query: string, limit = 10): Array<{ url: string; title: string; folder: string }> {
  const q = `%${query}%`;
  return getDb().prepare(
    `SELECT url, title, folder FROM bookmarks
     WHERE url LIKE ? OR title LIKE ?
     ORDER BY created_at DESC LIMIT ?`
  ).all(q, q, limit) as any[];
}

/**
 * Migrate bookmarks from the old JSON file to SQLite.
 * Runs once, then renames the JSON file.
 */
export function migrateBookmarksFromJson(): void {
  const jsonPath = path.join(DB_DIR, 'bookmarks.json');
  if (!fs.existsSync(jsonPath)) return;

  try {
    const urls: string[] = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const d = getDb();
    const insert = d.prepare(
      'INSERT OR IGNORE INTO bookmarks (url, title, folder, favicon, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    const now = Date.now();
    const tx = d.transaction(() => {
      for (const url of urls) {
        insert.run(url, '', '', '', now);
      }
    });
    tx();
    // Rename old file
    fs.renameSync(jsonPath, jsonPath + '.migrated');
    console.log(`[db] Migrated ${urls.length} bookmarks from JSON to SQLite`);
  } catch (e) {
    console.error('[db] Bookmark migration failed:', e);
  }
}

// ─── Permission operations ───

export function getPermission(domain: string, permission: string): boolean | null {
  const row = getDb().prepare(
    'SELECT allowed FROM permissions WHERE domain = ? AND permission = ?'
  ).get(domain, permission) as { allowed: number } | undefined;
  return row ? !!row.allowed : null;
}

export function setPermission(domain: string, permission: string, allowed: boolean): void {
  getDb().prepare(
    `INSERT OR REPLACE INTO permissions (domain, permission, allowed, updated_at) VALUES (?, ?, ?, ?)`
  ).run(domain, permission, allowed ? 1 : 0, Date.now());
}

export function getPermissionsForDomain(domain: string): Array<{ permission: string; allowed: boolean }> {
  const rows = getDb().prepare(
    'SELECT permission, allowed FROM permissions WHERE domain = ?'
  ).all(domain) as Array<{ permission: string; allowed: number }>;
  return rows.map(r => ({ permission: r.permission, allowed: !!r.allowed }));
}

export function clearPermissions(domain?: string): void {
  if (domain) {
    getDb().prepare('DELETE FROM permissions WHERE domain = ?').run(domain);
  } else {
    getDb().prepare('DELETE FROM permissions').run();
  }
}

// ─── Credential operations ───

export function saveCredential(domain: string, username: string, passwordEnc: string): void {
  const now = Date.now();
  getDb().prepare(
    `INSERT INTO credentials (domain, username, password_enc, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(domain, username) DO UPDATE SET password_enc = ?, updated_at = ?`
  ).run(domain, username, passwordEnc, now, now, passwordEnc, now);
}

export function getCredentials(domain: string): Array<{ id: number; username: string; password_enc: string; last_used: number; created_at: number }> {
  return getDb().prepare(
    'SELECT id, username, password_enc, last_used, created_at FROM credentials WHERE domain = ? ORDER BY last_used DESC'
  ).all(domain) as any[];
}

export function updateCredentialLastUsed(id: number): void {
  getDb().prepare('UPDATE credentials SET last_used = ? WHERE id = ?').run(Date.now(), id);
}

export function deleteCredential(id: number): void {
  getDb().prepare('DELETE FROM credentials WHERE id = ?').run(id);
}

export function listCredentialDomains(): string[] {
  const rows = getDb().prepare(
    'SELECT DISTINCT domain FROM credentials ORDER BY domain'
  ).all() as Array<{ domain: string }>;
  return rows.map(r => r.domain);
}

// ─── Agent browsing data query functions ───

export interface HistoryQueryParams {
  grep?: string;
  since?: string;   // ISO date string
  until?: string;   // ISO date string
  domain?: string;
  limit?: number;
  sort?: 'recent' | 'frequent';
}

export function queryHistory(params: HistoryQueryParams = {}): Array<{
  url: string; title: string; domain: string; visited_at: string; visit_count: number;
}> {
  const { grep, since, until, domain, limit = 50, sort = 'recent' } = params;
  const conditions: string[] = [];
  const bindings: any[] = [];

  if (grep) {
    conditions.push(`(LOWER(url) LIKE LOWER(?) OR LOWER(title) LIKE LOWER(?))`);
    const pat = `%${grep}%`;
    bindings.push(pat, pat);
  }
  if (since) {
    conditions.push(`visit_time >= ?`);
    bindings.push(new Date(since).getTime());
  }
  if (until) {
    conditions.push(`visit_time <= ?`);
    bindings.push(new Date(until).getTime());
  }
  if (domain) {
    conditions.push(`LOWER(domain) = LOWER(?)`);
    bindings.push(domain);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderBy = sort === 'frequent' ? `visit_count DESC, visit_time DESC` : `visit_time DESC`;

  const rows = getDb().prepare(
    `SELECT url, title, domain, visit_time, visit_count
     FROM history
     ${where}
     ORDER BY ${orderBy}
     LIMIT ?`
  ).all(...bindings, limit) as Array<{ url: string; title: string; domain: string; visit_time: number; visit_count: number }>;

  return rows.map(r => ({
    url: r.url,
    title: r.title,
    domain: r.domain,
    visited_at: new Date(r.visit_time).toISOString(),
    visit_count: r.visit_count,
  }));
}

export interface BookmarkQueryParams {
  grep?: string;
  folder?: string;
  sort?: 'recent' | 'alpha' | 'frequent';
  limit?: number;
}

export function queryBookmarks(params: BookmarkQueryParams = {}): Array<{
  url: string; title: string; folder: string; created_at: string; visit_count: number;
}> {
  const { grep, folder, sort = 'recent', limit = 50 } = params;
  const conditions: string[] = [];
  const bindings: any[] = [];

  if (grep) {
    conditions.push(`(LOWER(url) LIKE LOWER(?) OR LOWER(title) LIKE LOWER(?))`);
    const pat = `%${grep}%`;
    bindings.push(pat, pat);
  }
  if (folder !== undefined) {
    conditions.push(`LOWER(folder) = LOWER(?)`);
    bindings.push(folder);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  let orderBy: string;
  if (sort === 'alpha') orderBy = `title COLLATE NOCASE ASC`;
  else if (sort === 'frequent') orderBy = `visit_count DESC, created_at DESC`;
  else orderBy = `created_at DESC`;

  const rows = getDb().prepare(
    `SELECT url, title, folder, created_at, visit_count
     FROM bookmarks
     ${where}
     ORDER BY ${orderBy}
     LIMIT ?`
  ).all(...bindings, limit) as Array<{ url: string; title: string; folder: string; created_at: number; visit_count: number }>;

  return rows.map(r => ({
    url: r.url,
    title: r.title,
    folder: r.folder || '',
    created_at: new Date(r.created_at).toISOString(),
    visit_count: r.visit_count,
  }));
}

export interface DownloadQueryParams {
  grep?: string;
  since?: string;   // ISO date string
  type?: string;    // file extension filter (e.g. "pdf", ".mp4")
  limit?: number;
}

export function queryDownloads(params: DownloadQueryParams = {}): Array<{
  filename: string; url: string; size: number; created_at: string; status: string; path: string;
}> {
  const { grep, since, type, limit = 50 } = params;
  const conditions: string[] = [];
  const bindings: any[] = [];

  if (grep) {
    conditions.push(`(LOWER(filename) LIKE LOWER(?) OR LOWER(url) LIKE LOWER(?))`);
    const pat = `%${grep}%`;
    bindings.push(pat, pat);
  }
  if (since) {
    conditions.push(`created_at >= ?`);
    bindings.push(new Date(since).toISOString());
  }
  if (type) {
    const ext = type.startsWith('.') ? type : `.${type}`;
    conditions.push(`LOWER(filename) LIKE LOWER(?)`);
    bindings.push(`%${ext}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = getDb().prepare(
    `SELECT filename, url, path, size, created_at, status
     FROM downloads
     ${where}
     ORDER BY created_at DESC
     LIMIT ?`
  ).all(...bindings, limit) as Array<{ filename: string; url: string; path: string; size: number; created_at: string; status: string }>;

  return rows.map(r => ({
    filename: r.filename,
    url: r.url,
    size: r.size,
    created_at: r.created_at,
    status: r.status,
    path: r.path,
  }));
}

export function recordDownload(
  filename: string, url: string, filePath: string, size: number, status: string
): void {
  try {
    getDb().prepare(
      `INSERT INTO downloads (filename, url, path, size, created_at, status) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(filename, url, filePath, size, new Date().toISOString(), status);
  } catch (e) {
    console.error('[db] recordDownload failed:', e);
  }
}

// ─── Helpers ───

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    (db as any) = null;
  }
}

/**
 * Close existing database and reinitialize with a new path.
 * Used when switching profiles.
 */
export function reinitDatabase(newDbPath: string): Database.Database {
  closeDatabase();
  return initDatabase(newDbPath);
}
