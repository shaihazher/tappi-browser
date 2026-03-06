import { randomUUID } from 'crypto';
import { getDb } from './database';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScriptField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'file_path' | 'url' | 'select';
  required: boolean;
  description?: string;
  placeholder?: string;
  options?: string[];
  default?: any;
}

export interface ScriptInputSchema {
  fields: ScriptField[];
  bulkHeaders?: string[];
}

export interface AuthRequirement {
  domain: string;
  description: string;
  authType: 'credentials' | 'session' | 'either';
}

export interface Script {
  id: string;
  name: string;
  description: string;
  scriptType: 'automated' | 'semi-automated' | 'playbook';
  inputSchema: ScriptInputSchema;
  scriptBody: string;
  sourceConversationId?: string;
  createdAt: string;
  updatedAt: string;
  lastRun?: string;
  runCount: number;
  authRequirements?: AuthRequirement[];
  domains?: string[];
}

// ─── Row mapping ─────────────────────────────────────────────────────────────

interface ScriptRow {
  id: string;
  name: string;
  description: string | null;
  script_type: string;
  input_schema: string | null;
  script_body: string;
  source_conversation_id: string | null;
  created_at: string;
  updated_at: string;
  last_run: string | null;
  run_count: number;
  archived: number;
  auth_requirements: string | null;
  domains: string | null;
}

function rowToScript(row: ScriptRow): Script {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    scriptType: row.script_type as Script['scriptType'],
    inputSchema: row.input_schema ? JSON.parse(row.input_schema) : { fields: [] },
    scriptBody: row.script_body,
    sourceConversationId: row.source_conversation_id || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRun: row.last_run || undefined,
    runCount: row.run_count,
    authRequirements: row.auth_requirements ? JSON.parse(row.auth_requirements) : undefined,
    domains: row.domains ? JSON.parse(row.domains) : undefined,
  };
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export function createScript(
  data: Omit<Script, 'id' | 'createdAt' | 'updatedAt' | 'runCount'>
): Script {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO scripts (id, name, description, script_type, input_schema, script_body, source_conversation_id, created_at, updated_at, run_count, archived, auth_requirements, domains)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
  ).run(
    id,
    data.name,
    data.description || '',
    data.scriptType,
    JSON.stringify(data.inputSchema),
    data.scriptBody,
    data.sourceConversationId || null,
    now,
    now,
    data.authRequirements ? JSON.stringify(data.authRequirements) : null,
    data.domains ? JSON.stringify(data.domains) : null
  );

  return {
    id,
    name: data.name,
    description: data.description || '',
    scriptType: data.scriptType,
    inputSchema: data.inputSchema,
    scriptBody: data.scriptBody,
    sourceConversationId: data.sourceConversationId,
    createdAt: now,
    updatedAt: now,
    runCount: 0,
    authRequirements: data.authRequirements,
    domains: data.domains,
  };
}

export function getScript(id: string): Script | null {
  const row = getDb().prepare('SELECT * FROM scripts WHERE id = ?').get(id) as ScriptRow | undefined;
  return row ? rowToScript(row) : null;
}

export function listScripts(): Script[] {
  const rows = getDb().prepare(
    'SELECT * FROM scripts WHERE archived = 0 ORDER BY updated_at DESC'
  ).all() as ScriptRow[];
  return rows.map(rowToScript);
}

export function updateScript(
  id: string,
  updates: Partial<Pick<Script, 'name' | 'description' | 'scriptType' | 'inputSchema' | 'scriptBody' | 'authRequirements' | 'domains'>>
): Script | null {
  const existing = getScript(id);
  if (!existing) return null;

  const db = getDb();
  const now = new Date().toISOString();
  const sets: string[] = ['updated_at = ?'];
  const bindings: any[] = [now];

  if (updates.name !== undefined) {
    sets.push('name = ?');
    bindings.push(updates.name);
  }
  if (updates.description !== undefined) {
    sets.push('description = ?');
    bindings.push(updates.description);
  }
  if (updates.scriptType !== undefined) {
    sets.push('script_type = ?');
    bindings.push(updates.scriptType);
  }
  if (updates.inputSchema !== undefined) {
    sets.push('input_schema = ?');
    bindings.push(JSON.stringify(updates.inputSchema));
  }
  if (updates.scriptBody !== undefined) {
    sets.push('script_body = ?');
    bindings.push(updates.scriptBody);
  }
  if (updates.authRequirements !== undefined) {
    sets.push('auth_requirements = ?');
    bindings.push(JSON.stringify(updates.authRequirements));
  }
  if (updates.domains !== undefined) {
    sets.push('domains = ?');
    bindings.push(updates.domains ? JSON.stringify(updates.domains) : null);
  }

  bindings.push(id);
  db.prepare(`UPDATE scripts SET ${sets.join(', ')} WHERE id = ?`).run(...bindings);

  return getScript(id);
}

export function deleteScript(id: string): boolean {
  const info = getDb().prepare('DELETE FROM scripts WHERE id = ?').run(id);
  return info.changes > 0;
}

export function getScriptsByDomain(domain: string): Script[] {
  const rows = getDb().prepare(
    `SELECT * FROM scripts WHERE archived = 0 AND domains LIKE ? ORDER BY updated_at DESC`
  ).all(`%"${domain}"%`) as ScriptRow[];
  return rows.map(rowToScript);
}

export function incrementRunCount(id: string): void {
  const now = new Date().toISOString();
  getDb().prepare(
    'UPDATE scripts SET run_count = run_count + 1, last_run = ?, updated_at = ? WHERE id = ?'
  ).run(now, now, id);
}
