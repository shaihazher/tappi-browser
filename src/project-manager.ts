/**
 * project-manager.ts — Project entity for Coding Mode (Phase 9.07).
 *
 * Groups related coding mode conversations under a project, tracks artifacts
 * (files/folders touched), and builds a compact system-prompt context block.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { getDb } from './database';

function expandPath(p: string): string {
  if (!p) return p;
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p === '~') return os.homedir();
  return p;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  description?: string;
  working_dir?: string;
  created_at: string;
  updated_at: string;
  archived: number; // 0 | 1
}

export interface ProjectArtifact {
  id: number;
  project_id: string;
  path: string;
  type: 'file' | 'folder';
  description?: string;
  created_at: string;
  conversation_id?: string;
}

// ─── CRUD: Projects ───────────────────────────────────────────────────────────

export function createProject(name: string, workingDir: string, description?: string): Project {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const resolvedDir = expandPath(workingDir);

  db.prepare(`
    INSERT INTO projects (id, name, description, working_dir, created_at, updated_at, archived)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(id, name, description ?? null, resolvedDir || null, now, now);

  return getProject(id) as Project;
}

export function getProject(id: string): Project | null {
  const row = getDb().prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Project | undefined;
  return row ?? null;
}

export function getProjectByWorkingDir(workingDir: string): Project | null {
  const resolved = expandPath(workingDir);
  const row = getDb().prepare(
    `SELECT * FROM projects WHERE working_dir = ? AND archived = 0 ORDER BY updated_at DESC LIMIT 1`
  ).get(resolved) as Project | undefined;
  return row ?? null;
}

export function getProjectByName(name: string): Project | null {
  const row = getDb().prepare(
    `SELECT * FROM projects WHERE name = ? AND archived = 0 ORDER BY updated_at DESC LIMIT 1`
  ).get(name) as Project | undefined;
  return row ?? null;
}

/**
 * Find an existing project by name or working_dir, or return null.
 * Used to prevent duplicate project creation.
 */
export function findExistingProject(name: string, workingDir?: string): Project | null {
  // Try working_dir first (more specific match)
  if (workingDir) {
    const byDir = getProjectByWorkingDir(workingDir);
    if (byDir) return byDir;
  }
  // Then try name
  return getProjectByName(name);
}

export function listProjects(includeArchived = false): Project[] {
  const db = getDb();
  if (includeArchived) {
    return db.prepare(`SELECT * FROM projects ORDER BY updated_at DESC`).all() as Project[];
  }
  return db.prepare(`SELECT * FROM projects WHERE archived = 0 ORDER BY updated_at DESC`).all() as Project[];
}

export function updateProject(id: string, updates: Partial<Omit<Project, 'id' | 'created_at'>>): void {
  const db = getDb();
  const now = new Date().toISOString();
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.name !== undefined)        { fields.push('name = ?');        values.push(updates.name); }
  if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
  if (updates.working_dir !== undefined) { fields.push('working_dir = ?'); values.push(updates.working_dir); }
  if (updates.archived !== undefined)    { fields.push('archived = ?');    values.push(updates.archived); }

  fields.push('updated_at = ?');
  values.push(now);
  values.push(id);

  if (fields.length === 1) return; // only updated_at — nothing real to update
  db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function archiveProject(id: string): void {
  updateProject(id, { archived: 1 });
}

// ─── Artifact Tracking ────────────────────────────────────────────────────────

export function addArtifact(
  projectId: string,
  filePath: string,
  type: 'file' | 'folder',
  description?: string,
  conversationId?: string,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO project_artifacts (project_id, path, type, description, created_at, conversation_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(projectId, filePath, type, description ?? null, now, conversationId ?? null);

  // Bump project updated_at
  db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).run(now, projectId);
}

export function getArtifacts(projectId: string): ProjectArtifact[] {
  return getDb().prepare(
    `SELECT * FROM project_artifacts WHERE project_id = ? ORDER BY created_at DESC`
  ).all(projectId) as ProjectArtifact[];
}

export function removeArtifact(id: number): void {
  getDb().prepare(`DELETE FROM project_artifacts WHERE id = ?`).run(id);
}

// ─── Conversation Linking ─────────────────────────────────────────────────────

export function linkConversation(conversationId: string, projectId: string): void {
  const db = getDb();
  db.prepare(`UPDATE conversations SET project_id = ?, mode = 'coding', updated_at = ? WHERE id = ?`)
    .run(projectId, new Date().toISOString(), conversationId);

  // Bump project updated_at
  db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), projectId);
}

export function getProjectConversations(projectId: string): any[] {
  return getDb().prepare(
    `SELECT id, title, created_at, updated_at, message_count, preview, archived, mode
     FROM conversations
     WHERE project_id = ? AND archived = 0
     ORDER BY updated_at DESC`
  ).all(projectId) as any[];
}

// ─── Auto-detection ───────────────────────────────────────────────────────────

/**
 * Try to determine a human-friendly project name from the working directory.
 * Checks package.json → Cargo.toml → go.mod → pyproject.toml → fallback to dirname.
 */
export function detectProjectName(workingDir: string): string {
  try {
    // package.json (Node / JS)
    const pkgJson = path.join(workingDir, 'package.json');
    if (fs.existsSync(pkgJson)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf-8'));
      if (pkg.name) return pkg.name;
    }
  } catch {}

  try {
    // Cargo.toml (Rust)
    const cargoToml = path.join(workingDir, 'Cargo.toml');
    if (fs.existsSync(cargoToml)) {
      const raw = fs.readFileSync(cargoToml, 'utf-8');
      const m = raw.match(/^\s*name\s*=\s*"([^"]+)"/m);
      if (m) return m[1];
    }
  } catch {}

  try {
    // go.mod (Go)
    const goMod = path.join(workingDir, 'go.mod');
    if (fs.existsSync(goMod)) {
      const raw = fs.readFileSync(goMod, 'utf-8');
      const m = raw.match(/^module\s+(.+)/m);
      if (m) return m[1].trim().split('/').pop() || m[1].trim();
    }
  } catch {}

  try {
    // pyproject.toml (Python)
    const pyproject = path.join(workingDir, 'pyproject.toml');
    if (fs.existsSync(pyproject)) {
      const raw = fs.readFileSync(pyproject, 'utf-8');
      const m = raw.match(/^\s*name\s*=\s*"([^"]+)"/m);
      if (m) return m[1];
    }
  } catch {}

  // Fallback: use directory basename
  return path.basename(workingDir) || 'Untitled Project';
}

// ─── Context Injection ────────────────────────────────────────────────────────

/**
 * Build a compact (~200-300 token) project context block for system prompt injection.
 */
export function buildProjectContext(projectId: string): string {
  const project = getProject(projectId);
  if (!project) return '';

  const lines: string[] = [
    `[Active Project: ${project.name}]`,
  ];

  if (project.working_dir) {
    lines.push(`Dir: ${project.working_dir}`);
    lines.push(`⚠️ SCOPE: All file operations and shell commands for this conversation are scoped to ${project.working_dir}. Do not access or modify files in other project directories.`);
  }
  if (project.description) lines.push(`Description: ${project.description}`);

  // Recent artifacts (last 10)
  const artifacts = getArtifacts(projectId).slice(0, 10);
  if (artifacts.length > 0) {
    lines.push('Artifacts:');
    artifacts.forEach(a => {
      const desc = a.description ? ` — ${a.description}` : '';
      lines.push(`  ${a.type === 'folder' ? '📁' : '📄'} ${a.path}${desc}`);
    });
  }

  // Conversation count
  const convCount = (getProjectConversations(projectId) || []).length;
  if (convCount > 0) lines.push(`Conversations: ${convCount}`);

  return lines.join('\n');
}
