/**
 * extension-manager.ts — Chrome extension installation, persistence, and lifecycle.
 *
 * Supports:
 *   - Unpacked directories (loaded directly)
 *   - Packed .crx files (extracted to managed dir, then loaded as unpacked)
 *
 * Extensions are persisted per-profile in extensions.json and auto-loaded on boot.
 * Electron does NOT persist extensions across restarts — we handle that.
 */

import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { profileManager } from './profile-manager';
import { sessionManager } from './session-manager';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExtensionEntry {
  path: string;
  allowFileAccess?: boolean;
  addedAt: string;
  source: 'unpacked' | 'crx';
  enabled: boolean;
}

interface ExtensionsFile {
  extensions: ExtensionEntry[];
}

export interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  path: string;
  allowFileAccess?: boolean;
  addedAt?: string;
  source?: 'unpacked' | 'crx';
  enabled: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getExtensionsJsonPath(profileName?: string): string {
  return path.join(profileManager.getProfileDir(profileName), 'extensions.json');
}

function getManagedExtDir(profileName?: string): string {
  return path.join(profileManager.getProfileDir(profileName), 'extensions');
}

function readPersistence(profileName?: string): ExtensionsFile {
  const filePath = getExtensionsJsonPath(profileName);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (e) {
    console.warn('[extensions] Failed to read extensions.json:', e);
  }
  return { extensions: [] };
}

function writePersistence(data: ExtensionsFile, profileName?: string): void {
  const filePath = getExtensionsJsonPath(profileName);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── CRX Extraction ─────────────────────────────────────────────────────────

/**
 * Extract a packed .crx file to a destination directory.
 *
 * CRX3: [Cr24(4)] [version(4)] [header_size(4)] [header(header_size)] [ZIP]
 * CRX2: [Cr24(4)] [version(4)] [pubkey_len(4)] [sig_len(4)] [pubkey] [sig] [ZIP]
 *
 * We find the ZIP offset, write the ZIP to a temp file, and extract with `unzip`.
 */
function unpackCrx(crxPath: string, destDir: string): string {
  const buf = fs.readFileSync(crxPath);

  // Validate magic: 'Cr24'
  if (buf.length < 16 || buf.toString('ascii', 0, 4) !== 'Cr24') {
    throw new Error('Not a valid CRX file (missing Cr24 magic)');
  }

  const version = buf.readUInt32LE(4);
  let zipOffset: number;

  if (version === 3) {
    // CRX3: header_size at bytes 8-12
    const headerSize = buf.readUInt32LE(8);
    zipOffset = 12 + headerSize;
  } else if (version === 2) {
    // CRX2: pubkey_len at 8-12, sig_len at 12-16
    const pubkeyLen = buf.readUInt32LE(8);
    const sigLen = buf.readUInt32LE(12);
    zipOffset = 16 + pubkeyLen + sigLen;
  } else {
    throw new Error(`Unsupported CRX version: ${version}`);
  }

  if (zipOffset >= buf.length) {
    throw new Error('CRX file appears truncated — ZIP data offset beyond file size');
  }

  // Write ZIP portion to temp file
  const tmpZip = path.join(path.dirname(destDir), `_crx_tmp_${Date.now()}.zip`);
  try {
    fs.writeFileSync(tmpZip, buf.subarray(zipOffset));

    // Extract using system unzip (available on macOS + Linux)
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    execFileSync('unzip', ['-o', tmpZip, '-d', destDir], { stdio: 'pipe' });
  } finally {
    try { fs.unlinkSync(tmpZip); } catch {}
  }

  // Validate that manifest.json exists
  if (!fs.existsSync(path.join(destDir, 'manifest.json'))) {
    throw new Error('Extracted CRX does not contain manifest.json');
  }

  return destDir;
}

// ─── Permission Helpers ──────────────────────────────────────────────────────

/**
 * Check if an extension has a given permission declared in its manifest.
 * Looks up the extension path via the active session, then reads manifest.json.
 */
export function extensionHasPermission(extensionId: string, permission: string): boolean {
  try {
    const ses = sessionManager.getProfileSession();
    const ext = ses.getExtension(extensionId);
    if (!ext) return false;

    const manifestPath = path.join(ext.path, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return false;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const permissions: string[] = manifest.permissions || [];
    return permissions.includes(permission);
  } catch {
    return false;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Install a Chrome extension from an unpacked directory or .crx file.
 */
export async function installExtension(
  extensionPath: string,
  options?: { allowFileAccess?: boolean }
): Promise<ExtensionInfo | { error: string }> {
  try {
    const absPath = path.resolve(extensionPath);
    let finalPath = absPath;
    let source: 'unpacked' | 'crx' = 'unpacked';

    // Detect .crx and extract
    if (absPath.endsWith('.crx')) {
      if (!fs.existsSync(absPath)) {
        return { error: `CRX file not found: ${absPath}` };
      }
      // Read manifest from CRX to get an ID-like name for the dir
      const extId = `crx-${path.basename(absPath, '.crx')}-${Date.now()}`;
      const destDir = path.join(getManagedExtDir(), extId);
      try {
        unpackCrx(absPath, destDir);
      } catch (e: any) {
        return { error: `CRX extraction failed: ${e.message}` };
      }
      finalPath = destDir;
      source = 'crx';
    }

    // Validate unpacked directory
    if (!fs.existsSync(finalPath) || !fs.statSync(finalPath).isDirectory()) {
      return { error: `Not a directory: ${finalPath}` };
    }
    if (!fs.existsSync(path.join(finalPath, 'manifest.json'))) {
      return { error: `No manifest.json found in: ${finalPath}` };
    }

    // Get active profile session
    const ses = sessionManager.getProfileSession();

    // Check if already loaded
    const existing = ses.getAllExtensions();
    for (const ext of existing) {
      if (ext.path === finalPath) {
        return { error: `Extension already loaded from: ${finalPath}` };
      }
    }

    // Load into Electron
    const ext = await ses.loadExtension(finalPath, {
      allowFileAccess: options?.allowFileAccess ?? false,
    });

    // Persist
    const data = readPersistence();
    // Remove any existing entry for same path
    data.extensions = data.extensions.filter(e => e.path !== finalPath);
    data.extensions.push({
      path: finalPath,
      allowFileAccess: options?.allowFileAccess,
      addedAt: new Date().toISOString(),
      source,
      enabled: true,
    });
    writePersistence(data);

    return {
      id: ext.id,
      name: ext.name,
      version: ext.version,
      path: ext.path,
      allowFileAccess: options?.allowFileAccess,
      addedAt: data.extensions[data.extensions.length - 1].addedAt,
      source,
      enabled: true,
    };
  } catch (e: any) {
    return { error: e.message || String(e) };
  }
}

/**
 * Install extension from a downloaded .crx file.
 * Extracts to managed dir, loads, optionally deletes the original .crx.
 */
export async function installFromCrx(
  crxFilePath: string,
  options?: { deleteOriginal?: boolean }
): Promise<ExtensionInfo | { error: string }> {
  const result = await installExtension(crxFilePath);
  if ('error' in result) return result;

  // Optionally delete original .crx file
  if (options?.deleteOriginal) {
    try { fs.unlinkSync(crxFilePath); } catch {}
  }

  return result;
}

/**
 * List all extensions (loaded + disabled), enriched with persistence metadata.
 */
export function listExtensions(): ExtensionInfo[] {
  try {
    const ses = sessionManager.getProfileSession();
    const loaded = ses.getAllExtensions();
    const persisted = readPersistence();

    const results: ExtensionInfo[] = [];
    const seenPaths = new Set<string>();

    // Add loaded (enabled) extensions
    for (const ext of loaded) {
      seenPaths.add(ext.path);
      const entry = persisted.extensions.find(e => e.path === ext.path);
      results.push({
        id: ext.id,
        name: ext.name,
        version: ext.version,
        path: ext.path,
        allowFileAccess: entry?.allowFileAccess,
        addedAt: entry?.addedAt,
        source: entry?.source,
        enabled: true,
      });
    }

    // Add disabled extensions from persistence
    for (const entry of persisted.extensions) {
      if (seenPaths.has(entry.path)) continue;
      if (entry.enabled === false) {
        // Read manifest.json to get name/version
        try {
          const manifestPath = path.join(entry.path, 'manifest.json');
          if (!fs.existsSync(manifestPath)) continue;
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          results.push({
            id: `disabled-${Buffer.from(entry.path).toString('base64url').slice(0, 16)}`,
            name: manifest.name || path.basename(entry.path),
            version: manifest.version || '0.0.0',
            path: entry.path,
            allowFileAccess: entry.allowFileAccess,
            addedAt: entry.addedAt,
            source: entry.source,
            enabled: false,
          });
        } catch {
          // Skip entries with unreadable manifests
        }
      }
    }

    return results;
  } catch (e: any) {
    console.error('[extensions] listExtensions error:', e);
    return [];
  }
}

/**
 * Get a single extension by ID or name.
 */
export function getExtension(idOrName: string): ExtensionInfo | { error: string } {
  try {
    const ses = sessionManager.getProfileSession();

    // Try by ID first (loaded extensions)
    const ext = ses.getExtension(idOrName);
    if (ext) {
      const persisted = readPersistence();
      const entry = persisted.extensions.find(e => e.path === ext.path);
      return {
        id: ext.id,
        name: ext.name,
        version: ext.version,
        path: ext.path,
        allowFileAccess: entry?.allowFileAccess,
        addedAt: entry?.addedAt,
        source: entry?.source,
        enabled: true,
      };
    }

    // Fallback: case-insensitive name search in loaded extensions
    const all = ses.getAllExtensions();
    const match = all.find(e => e.name.toLowerCase() === idOrName.toLowerCase());
    if (match) {
      const persisted = readPersistence();
      const entry = persisted.extensions.find(e => e.path === match.path);
      return {
        id: match.id,
        name: match.name,
        version: match.version,
        path: match.path,
        allowFileAccess: entry?.allowFileAccess,
        addedAt: entry?.addedAt,
        source: entry?.source,
        enabled: true,
      };
    }

    // Also check disabled extensions in persistence
    const persisted = readPersistence();
    for (const entry of persisted.extensions) {
      if (entry.enabled === false) {
        try {
          const manifestPath = path.join(entry.path, 'manifest.json');
          if (!fs.existsSync(manifestPath)) continue;
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          if (manifest.name?.toLowerCase() === idOrName.toLowerCase()) {
            return {
              id: `disabled-${Buffer.from(entry.path).toString('base64url').slice(0, 16)}`,
              name: manifest.name,
              version: manifest.version || '0.0.0',
              path: entry.path,
              allowFileAccess: entry.allowFileAccess,
              addedAt: entry.addedAt,
              source: entry.source,
              enabled: false,
            };
          }
        } catch {}
      }
    }

    return { error: `Extension not found: ${idOrName}` };
  } catch (e: any) {
    return { error: e.message || String(e) };
  }
}

/**
 * Remove an extension by ID or name (including disabled extensions).
 */
export async function removeExtension(idOrName: string): Promise<{ success: boolean; error?: string }> {
  try {
    const ses = sessionManager.getProfileSession();

    // Resolve to extension object (loaded ones)
    let ext = ses.getExtension(idOrName);
    if (!ext) {
      const all = ses.getAllExtensions();
      ext = all.find(e => e.name.toLowerCase() === idOrName.toLowerCase()) || null;
    }

    let extPath: string | undefined;

    if (ext) {
      extPath = ext.path;
      // Remove from Electron session
      ses.removeExtension(ext.id);
    } else {
      // Check disabled extensions in persistence
      const data = readPersistence();
      for (const entry of data.extensions) {
        if (entry.enabled === false) {
          try {
            const manifestPath = path.join(entry.path, 'manifest.json');
            if (!fs.existsSync(manifestPath)) continue;
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            if (manifest.name?.toLowerCase() === idOrName.toLowerCase()) {
              extPath = entry.path;
              break;
            }
          } catch {}
        }
      }
    }

    if (!extPath) {
      return { success: false, error: `Extension not found: ${idOrName}` };
    }

    // Update persistence
    const data = readPersistence();
    const entry = data.extensions.find(e => e.path === extPath);
    data.extensions = data.extensions.filter(e => e.path !== extPath);
    writePersistence(data);

    // If source was 'crx', delete the extracted directory
    if (entry?.source === 'crx') {
      const managedDir = getManagedExtDir();
      if (extPath.startsWith(managedDir)) {
        try {
          fs.rmSync(extPath, { recursive: true, force: true });
          console.log(`[extensions] Deleted extracted CRX dir: ${extPath}`);
        } catch (e) {
          console.warn('[extensions] Failed to delete extracted CRX dir:', e);
        }
      }
    }

    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

/**
 * Disable an extension — unloads from session but keeps in persistence.
 */
export async function disableExtension(idOrName: string): Promise<{ success: boolean; error?: string }> {
  try {
    const ses = sessionManager.getProfileSession();

    // Resolve to loaded extension
    let ext = ses.getExtension(idOrName);
    if (!ext) {
      const all = ses.getAllExtensions();
      ext = all.find(e => e.name.toLowerCase() === idOrName.toLowerCase()) || null;
    }
    if (!ext) {
      return { success: false, error: `Extension not found or already disabled: ${idOrName}` };
    }

    const extPath = ext.path;

    // Unload from session
    ses.removeExtension(ext.id);

    // Update persistence: set enabled = false
    const data = readPersistence();
    const entry = data.extensions.find(e => e.path === extPath);
    if (entry) {
      entry.enabled = false;
      writePersistence(data);
    }

    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

/**
 * Enable a previously disabled extension — reloads into session.
 */
export async function enableExtension(idOrName: string): Promise<ExtensionInfo | { error: string }> {
  try {
    const ses = sessionManager.getProfileSession();
    const data = readPersistence();

    // Find the disabled entry by name (read manifest) or by checking if idOrName matches a persisted path pattern
    let targetEntry: ExtensionEntry | undefined;

    for (const entry of data.extensions) {
      if (entry.enabled !== false) continue;
      try {
        const manifestPath = path.join(entry.path, 'manifest.json');
        if (!fs.existsSync(manifestPath)) continue;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        if (manifest.name?.toLowerCase() === idOrName.toLowerCase()) {
          targetEntry = entry;
          break;
        }
      } catch {}
    }

    // Also try matching by the synthetic disabled ID
    if (!targetEntry) {
      for (const entry of data.extensions) {
        if (entry.enabled !== false) continue;
        const syntheticId = `disabled-${Buffer.from(entry.path).toString('base64url').slice(0, 16)}`;
        if (syntheticId === idOrName) {
          targetEntry = entry;
          break;
        }
      }
    }

    if (!targetEntry) {
      return { error: `Disabled extension not found: ${idOrName}` };
    }

    if (!fs.existsSync(targetEntry.path) || !fs.existsSync(path.join(targetEntry.path, 'manifest.json'))) {
      return { error: `Extension directory missing: ${targetEntry.path}` };
    }

    // Load into session
    const ext = await ses.loadExtension(targetEntry.path, {
      allowFileAccess: targetEntry.allowFileAccess ?? false,
    });

    // Update persistence: set enabled = true
    targetEntry.enabled = true;
    writePersistence(data);

    return {
      id: ext.id,
      name: ext.name,
      version: ext.version,
      path: ext.path,
      allowFileAccess: targetEntry.allowFileAccess,
      addedAt: targetEntry.addedAt,
      source: targetEntry.source,
      enabled: true,
    };
  } catch (e: any) {
    return { error: e.message || String(e) };
  }
}

/**
 * Load all persisted extensions for a profile. Called at boot and on profile switch.
 * Skips missing directories and auto-cleans stale entries.
 */
export async function loadPersistedExtensionsForProfile(profileName?: string): Promise<void> {
  const data = readPersistence(profileName);
  if (data.extensions.length === 0) return;

  const ses = sessionManager.getProfileSession(profileName);
  const staleIndexes: number[] = [];

  for (let i = 0; i < data.extensions.length; i++) {
    const entry = data.extensions[i];

    // Backward compat: treat missing enabled field as true
    if (entry.enabled === undefined) entry.enabled = true;

    // Skip disabled extensions
    if (entry.enabled === false) {
      console.log(`[extensions] Skipping disabled: ${entry.path}`);
      continue;
    }

    if (!fs.existsSync(entry.path) || !fs.existsSync(path.join(entry.path, 'manifest.json'))) {
      console.warn(`[extensions] Skipping missing extension dir: ${entry.path}`);
      staleIndexes.push(i);
      continue;
    }
    try {
      // Check not already loaded
      const existing = ses.getAllExtensions();
      if (existing.some(e => e.path === entry.path)) continue;

      await ses.loadExtension(entry.path, {
        allowFileAccess: entry.allowFileAccess ?? false,
      });
      console.log(`[extensions] Loaded: ${entry.path}`);
    } catch (e) {
      console.error(`[extensions] Failed to load ${entry.path}:`, e);
      staleIndexes.push(i);
    }
  }

  // Auto-clean stale entries
  if (staleIndexes.length > 0) {
    data.extensions = data.extensions.filter((_, i) => !staleIndexes.includes(i));
    writePersistence(data, profileName);
    console.log(`[extensions] Cleaned ${staleIndexes.length} stale entries`);
  }
}
