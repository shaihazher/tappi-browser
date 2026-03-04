/**
 * native-messaging.ts — Native Host Manager
 *
 * Discovers Chrome native messaging host manifests, spawns host processes,
 * and communicates via the Chrome native messaging stdio protocol
 * (4-byte little-endian length-prefixed JSON on stdin/stdout).
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn, type ChildProcess } from 'child_process';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NativeHostManifest {
  name: string;
  description: string;
  path: string;
  type: 'stdio';
  allowed_origins: string[];
}

interface ActiveConnection {
  process: ChildProcess;
  hostName: string;
  extensionId: string;
  buffer: Buffer;
  onMessage: (msg: any) => void;
  onDisconnect: (error?: string) => void;
}

// ─── Host manifest directories ───────────────────────────────────────────────

function getHostManifestDirs(): string[] {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
      '/Library/Google/Chrome/NativeMessagingHosts',
      path.join(home, 'Library/Application Support/Chromium/NativeMessagingHosts'),
      '/Library/Application Support/Chromium/NativeMessagingHosts',
    ];
  }
  if (process.platform === 'linux') {
    return [
      path.join(home, '.config/google-chrome/NativeMessagingHosts'),
      '/etc/opt/chrome/native-messaging-hosts',
      path.join(home, '.config/chromium/NativeMessagingHosts'),
      '/etc/chromium/native-messaging-hosts',
    ];
  }
  // Windows (fallback — not primary target)
  return [];
}

// ─── Manifest cache ──────────────────────────────────────────────────────────

const manifestCache = new Map<string, NativeHostManifest>();
let cacheBuilt = false;

/**
 * Scan standard directories for native messaging host manifests.
 */
export function discoverNativeHosts(): Map<string, NativeHostManifest> {
  if (cacheBuilt) return manifestCache;

  const dirs = getHostManifestDirs();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      try {
        const full = path.join(dir, file);
        const manifest: NativeHostManifest = JSON.parse(fs.readFileSync(full, 'utf-8'));
        if (manifest.name && manifest.path && manifest.type === 'stdio') {
          manifestCache.set(manifest.name, manifest);
        }
      } catch {
        // skip malformed manifests
      }
    }
  }

  cacheBuilt = true;
  console.log(`[tappi] Discovered ${manifestCache.size} native messaging host(s)`);
  return manifestCache;
}

/**
 * Invalidate host cache (e.g. after installing a new host).
 */
export function refreshHostCache(): void {
  manifestCache.clear();
  cacheBuilt = false;
  discoverNativeHosts();
}

/**
 * Check if a host manifest allows the given extension.
 */
export function validateAccess(hostName: string, extensionId: string): { ok: boolean; error?: string } {
  const hosts = discoverNativeHosts();
  const manifest = hosts.get(hostName);
  if (!manifest) {
    return { ok: false, error: `Native messaging host not found: ${hostName}` };
  }
  const origin = `chrome-extension://${extensionId}/`;
  if (!manifest.allowed_origins.includes(origin)) {
    return { ok: false, error: `Extension ${extensionId} is not in allowed_origins for ${hostName}` };
  }
  if (!fs.existsSync(manifest.path)) {
    return { ok: false, error: `Host executable not found: ${manifest.path}` };
  }
  return { ok: true };
}

// ─── Active connections ──────────────────────────────────────────────────────

const activeConnections = new Map<string, ActiveConnection>();

/**
 * Write a message to a native host process stdin using the 4-byte LE protocol.
 */
function writeMessage(proc: ChildProcess, msg: any): void {
  const json = JSON.stringify(msg);
  const buf = Buffer.from(json, 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  proc.stdin!.write(header);
  proc.stdin!.write(buf);
}

/**
 * Process buffered data from stdout, extracting complete messages.
 */
function processBuffer(conn: ActiveConnection): void {
  while (true) {
    if (conn.buffer.length < 4) return;

    const msgLen = conn.buffer.readUInt32LE(0);
    if (msgLen > 1024 * 1024) {
      // Message too large (>1MB) — kill process
      conn.process.kill();
      conn.onDisconnect('Native host sent message exceeding 1MB limit');
      return;
    }

    if (conn.buffer.length < 4 + msgLen) return;

    const jsonBuf = conn.buffer.subarray(4, 4 + msgLen);
    conn.buffer = conn.buffer.subarray(4 + msgLen);

    try {
      const parsed = JSON.parse(jsonBuf.toString('utf-8'));
      conn.onMessage(parsed);
    } catch (e) {
      console.error('[tappi] Failed to parse native host message:', e);
    }
  }
}

/**
 * Spawn a native host process and set up stdio communication.
 */
function spawnNativeHost(
  manifest: NativeHostManifest,
  extensionId: string,
  connectionId: string,
  onMessage: (msg: any) => void,
  onDisconnect: (error?: string) => void,
): void {
  const origin = `chrome-extension://${extensionId}/`;
  const proc = spawn(manifest.path, [origin], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env },
  });

  const conn: ActiveConnection = {
    process: proc,
    hostName: manifest.name,
    extensionId,
    buffer: Buffer.alloc(0),
    onMessage,
    onDisconnect,
  };

  activeConnections.set(connectionId, conn);

  proc.stdout!.on('data', (chunk: Buffer) => {
    conn.buffer = Buffer.concat([conn.buffer, chunk]);
    processBuffer(conn);
  });

  proc.on('error', (err) => {
    activeConnections.delete(connectionId);
    onDisconnect(`Failed to spawn native host: ${err.message}`);
  });

  proc.on('exit', (code, signal) => {
    activeConnections.delete(connectionId);
    if (signal) {
      onDisconnect(`Native host killed by signal: ${signal}`);
    } else if (code !== 0) {
      onDisconnect(`Native host exited with code: ${code}`);
    } else {
      onDisconnect();
    }
  });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * One-shot message: spawn host, send one message, read one response, kill.
 * Returns the response or throws.
 */
export function sendOneShot(
  hostName: string,
  extensionId: string,
  message: any,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const access = validateAccess(hostName, extensionId);
    if (!access.ok) return reject(new Error(access.error));

    const manifest = discoverNativeHosts().get(hostName)!;
    const connId = `oneshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        const conn = activeConnections.get(connId);
        if (conn) {
          conn.process.kill();
          activeConnections.delete(connId);
        }
        reject(new Error(`Native messaging timeout (30s) for host: ${hostName}`));
      }
    }, 30_000);

    spawnNativeHost(
      manifest,
      extensionId,
      connId,
      (response) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          // Kill after receiving response
          const conn = activeConnections.get(connId);
          if (conn) {
            conn.process.kill();
            activeConnections.delete(connId);
          }
          resolve(response);
        }
      },
      (error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          if (error) reject(new Error(error));
          else reject(new Error('Native host disconnected without response'));
        }
      },
    );

    // Send the message
    const conn = activeConnections.get(connId);
    if (conn) {
      writeMessage(conn.process, message);
    }
  });
}

/**
 * Long-lived port: spawn and keep alive for bidirectional communication.
 */
export function connectPort(
  hostName: string,
  extensionId: string,
  connectionId: string,
  onMessage: (msg: any) => void,
  onDisconnect: (error?: string) => void,
): { ok: boolean; error?: string } {
  const access = validateAccess(hostName, extensionId);
  if (!access.ok) return access;

  const manifest = discoverNativeHosts().get(hostName)!;
  spawnNativeHost(manifest, extensionId, connectionId, onMessage, onDisconnect);
  return { ok: true };
}

/**
 * Send a message on an existing port connection.
 */
export function postMessage(connectionId: string, msg: any): boolean {
  const conn = activeConnections.get(connectionId);
  if (!conn) return false;
  writeMessage(conn.process, msg);
  return true;
}

/**
 * Disconnect (kill) an existing port connection.
 */
export function disconnect(connectionId: string): void {
  const conn = activeConnections.get(connectionId);
  if (!conn) return;
  conn.process.kill();
  activeConnections.delete(connectionId);
}

/**
 * Kill all active native host processes. Called on app quit.
 */
export function cleanupNativeHosts(): void {
  for (const [id, conn] of activeConnections) {
    try {
      conn.process.kill();
    } catch {}
  }
  activeConnections.clear();
  console.log('[tappi] Native host processes cleaned up');
}
