/**
 * tool-manager.ts — Unified Tool Registry (CLI + API)
 *
 * Tracks what tools the agent has installed/discovered via shell and API.
 * Persisted to ~/.tappi-browser/tools.json.
 * Injected into agent context as a compact summary (~100 tokens).
 * Visible in Settings → Tools tab.
 *
 * The agent calls register_tool after installing something.
 * On startup, CLI tools are verified via `which`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.tappi-browser');
const TOOLS_PATH = path.join(CONFIG_DIR, 'tools.json');

// ─── Types ───

export interface CliTool {
  name: string;
  command: string;          // The actual binary/command name
  installedVia?: string;    // e.g. "brew install ffmpeg"
  version?: string;
  description: string;
  authStatus?: string;      // "ok" | "needed" | custom
  account?: string;         // e.g. "shaihazher"
  notes?: string;           // Free-form notes the agent can add
  detectedAt: string;       // ISO timestamp
  verified: boolean;        // Last verification result
  verifiedAt?: string;      // ISO timestamp of last check
}

export interface ToolsRegistry {
  cli: CliTool[];
}

// ─── Load / Save ───

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

export function loadTools(): ToolsRegistry {
  try {
    if (fs.existsSync(TOOLS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(TOOLS_PATH, 'utf-8'));
      return { cli: raw.cli || [] };
    }
  } catch (e) {
    console.error('[tool-manager] load failed:', e);
  }
  return { cli: [] };
}

function saveTools(registry: ToolsRegistry): void {
  ensureDir();
  fs.writeFileSync(TOOLS_PATH, JSON.stringify(registry, null, 2));
}

// ─── CLI Tool Operations ───

/**
 * Register or update a CLI tool.
 */
export function registerCliTool(tool: Omit<CliTool, 'detectedAt' | 'verified'>): string {
  const registry = loadTools();
  const existing = registry.cli.findIndex(t => t.name === tool.name);

  const entry: CliTool = {
    ...tool,
    detectedAt: existing >= 0 ? registry.cli[existing].detectedAt : new Date().toISOString(),
    verified: verifyCommand(tool.command),
    verifiedAt: new Date().toISOString(),
  };

  if (existing >= 0) {
    registry.cli[existing] = entry;
  } else {
    registry.cli.push(entry);
  }

  saveTools(registry);
  // BUG-T6A: include version using the correct property name (tool.version, not tool.ver)
  const verStr = tool.version ? ` v${tool.version}` : '';
  return `✓ Registered tool: ${tool.name}${verStr} (${tool.command})${entry.verified ? '' : ' ⚠️ not found on PATH'}`;
}

/**
 * Unregister a CLI tool.
 */
export function unregisterCliTool(name: string): string {
  const registry = loadTools();
  const idx = registry.cli.findIndex(t => t.name === name);
  if (idx < 0) return `Tool "${name}" not found.`;
  registry.cli.splice(idx, 1);
  saveTools(registry);
  return `✓ Removed tool: ${name}`;
}

/**
 * Update a specific field on a CLI tool.
 */
export function updateCliTool(name: string, updates: Partial<Pick<CliTool, 'version' | 'authStatus' | 'account' | 'notes' | 'description'>>): string {
  const registry = loadTools();
  const tool = registry.cli.find(t => t.name === name);
  if (!tool) return `Tool "${name}" not found.`;
  Object.assign(tool, updates);
  saveTools(registry);
  return `✓ Updated tool: ${name}`;
}

/**
 * List all CLI tools (formatted for the agent).
 */
export function listCliTools(): string {
  const registry = loadTools();
  if (registry.cli.length === 0) return 'No CLI tools registered.';

  return registry.cli.map(t => {
    const status = t.verified ? '✅' : '⚠️';
    const auth = t.authStatus ? ` [auth:${t.authStatus}${t.account ? ` ${t.account}` : ''}]` : '';
    const ver = t.version ? ` v${t.version}` : '';
    return `${status} ${t.name}${ver} — ${t.description}${auth}`;
  }).join('\n');
}

/**
 * Verify all CLI tools are still available on PATH.
 * Returns summary of changes.
 */
export function verifyAllTools(): string {
  const registry = loadTools();
  const changes: string[] = [];

  for (const tool of registry.cli) {
    const wasVerified = tool.verified;
    tool.verified = verifyCommand(tool.command);
    tool.verifiedAt = new Date().toISOString();

    if (wasVerified && !tool.verified) {
      changes.push(`⚠️ ${tool.name} (${tool.command}) — no longer found on PATH`);
    } else if (!wasVerified && tool.verified) {
      changes.push(`✅ ${tool.name} (${tool.command}) — now available`);
    }
  }

  saveTools(registry);
  return changes.length > 0 ? changes.join('\n') : `All ${registry.cli.length} tools verified ✓`;
}

// ─── Context Injection ───

/**
 * Compact context string injected into the agent's system prompt.
 * ~5-10 tokens per tool. One line per tool.
 */
export function getToolsContext(): string {
  const registry = loadTools();

  const parts: string[] = [];

  if (registry.cli.length > 0) {
    const cliSummary = registry.cli.map(t => {
      const status = t.verified ? '' : '⚠️';
      const auth = t.authStatus === 'ok' ? ', auth:ok' : t.authStatus === 'needed' ? ', auth:needed' : '';
      return `${status}${t.name}${t.version ? ' v' + t.version : ''} (${t.description}${auth})`;
    }).join(', ');
    parts.push(`CLI: ${cliSummary}`);
  }

  return parts.length > 0 ? `Available tools:\n${parts.join('\n')}` : '';
}

// ─── Helpers ───

function verifyCommand(command: string): boolean {
  try {
    execSync(`which ${command}`, { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
