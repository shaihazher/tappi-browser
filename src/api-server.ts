/**
 * api-server.ts — Local HTTP API server for Tappi Browser (Phase 8.45)
 *
 * Binds to 127.0.0.1:18901 only. Auth via Bearer token stored at
 * ~/.tappi-browser/api-token. Rate limited: 100 req/min per IP.
 *
 * Exposes FULL tool repertoire + agent access to external CLI clients.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { BrowserWindow } from 'electron';
import type { TabManager } from './tab-manager';
import { agentEvents, runAgent, agentProgressData } from './agent';
import { createTools } from './tool-registry';
import * as pageTools from './page-tools';
import * as browserTools from './browser-tools';
import * as captureTools from './capture-tools';
import { getDb } from './database';

// ─── Constants ───────────────────────────────────────────────────────────────

export const API_PORT = 18901;
const TOKEN_DIR  = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.tappi-browser');
const TOKEN_FILE = path.join(TOKEN_DIR, 'api-token');
const RATE_LIMIT  = 100;   // requests per window
const RATE_WINDOW = 60_000; // ms

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ApiServerDeps {
  mainWindow: BrowserWindow;
  tabManager: TabManager;
  getConfig: () => any;         // returns TappiConfig
  decryptApiKey: (stored: string) => string;
  updateConfig: (updates: any) => void;  // deep-merge + save config (same as config:save IPC)
}

// ─── Token management ────────────────────────────────────────────────────────

export function ensureApiToken(): string {
  try {
    if (!fs.existsSync(TOKEN_DIR)) fs.mkdirSync(TOKEN_DIR, { recursive: true });
    if (fs.existsSync(TOKEN_FILE)) {
      const tok = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
      if (tok.length === 64) return tok;
    }
    const tok = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(TOKEN_FILE, tok, { mode: 0o600 });
    console.log(`[api] Token generated → ${TOKEN_FILE}`);
    return tok;
  } catch (e) {
    console.error('[api] Token init error:', e);
    return crypto.randomBytes(32).toString('hex'); // ephemeral fallback
  }
}

function readToken(): string {
  try { return fs.readFileSync(TOKEN_FILE, 'utf-8').trim(); } catch { return ''; }
}

/** F11: Flatten object keys to dot-notation for config field validation */
function flattenKeys(obj: any, prefix = ''): string[] {
  const keys: string[] = [];
  for (const k of Object.keys(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
      keys.push(...flattenKeys(obj[k], full));
    } else {
      keys.push(full);
    }
  }
  return keys;
}

/** F9: Constant-time token comparison to prevent timing attacks */
function timingSafeTokenCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against dummy to avoid timing leak on length mismatch
    const dummy = Buffer.alloc(bufA.length);
    crypto.timingSafeEqual(bufA, dummy);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────

interface RateEntry { count: number; resetAt: number; }
const rateLimiter = new Map<string, RateEntry>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  let entry = rateLimiter.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW };
    rateLimiter.set(ip, entry);
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

// Cleanup stale entries every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of rateLimiter) {
    if (now > e.resetAt) rateLimiter.delete(ip);
  }
}, 300_000).unref();

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function json(res: http.ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function err(res: http.ServerResponse, status: number, message: string) {
  json(res, status, { error: message });
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1_000_000) reject(new Error('Body too large')); });
    req.on('end', () => {
      if (!data) { resolve({}); return; }
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// Pattern match: /api/tabs/:id/action or /api/tabs/:id
function matchRoute(pattern: string, url: string): Record<string, string> | null {
  const patParts = pattern.split('/');
  const urlParts = url.split('?')[0].split('/');
  if (patParts.length !== urlParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].startsWith(':')) {
      params[patParts[i].slice(1)] = decodeURIComponent(urlParts[i]);
    } else if (patParts[i] !== urlParts[i]) {
      return null;
    }
  }
  return params;
}

function getQuery(url: string): Record<string, string> {
  const q: Record<string, string> = {};
  const idx = url.indexOf('?');
  if (idx === -1) return q;
  new URLSearchParams(url.slice(idx + 1)).forEach((v, k) => { q[k] = v; });
  return q;
}

// ─── Server ───────────────────────────────────────────────────────────────────

let server: http.Server | null = null;

export function startApiServer(port: number, deps: ApiServerDeps): void {
  if (server) return; // already running

  const validToken = readToken();

  server = http.createServer(async (req, res) => {
    const ip = req.socket.remoteAddress || '127.0.0.1';

    // Rate limit
    if (!checkRateLimit(ip)) {
      return err(res, 429, 'Rate limit exceeded: 100 req/min');
    }

    // F10: Block cross-origin requests (browsers set Origin; CLI tools don't)
    if (req.headers['origin']) {
      return err(res, 403, 'Cross-origin requests blocked');
    }

    // Auth (F9: timing-safe comparison)
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const validToken = readToken();
    if (!token || !timingSafeTokenCompare(token, validToken)) {
      return err(res, 401, 'Unauthorized: invalid or missing Bearer token');
    }

    const method = req.method?.toUpperCase() || 'GET';
    const rawUrl  = req.url || '/';
    const urlPath = rawUrl.split('?')[0];
    const query   = getQuery(rawUrl);

    try {
      await handleRequest(deps, method, urlPath, query, req, res);
    } catch (e: any) {
      console.error('[api] Request error:', e);
      err(res, 500, e?.message || 'Internal server error');
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[api] HTTP API server listening on http://127.0.0.1:${port}`);
  });

  server.on('error', (e: any) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`[api] Port ${port} already in use — API server not started`);
    } else {
      console.error('[api] Server error:', e);
    }
  });
}

export function stopApiServer(): void {
  if (server) {
    server.close();
    server = null;
    console.log('[api] Server stopped');
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

async function handleRequest(
  deps: ApiServerDeps,
  method: string,
  urlPath: string,
  query: Record<string, string>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  const { mainWindow, tabManager, getConfig, decryptApiKey } = deps;

  // ── GET /api/status ──────────────────────────────────────────────────────────
  if (method === 'GET' && urlPath === '/api/status') {
    const cfg = getConfig();
    const tabs = tabManager.getTabList();
    // Phase 8.40: include agent progress data
    const progress = agentProgressData;
    return json(res, 200, {
      running: true,
      tabCount: tabs.length,
      activeTabId: tabManager.activeTabId,
      hasApiKey: !!cfg.llm?.apiKey,
      model: `${cfg.llm?.provider}/${cfg.llm?.model}`,
      developerMode: cfg.developerMode,
      profile: 'default',
      // Agent progress (Phase 8.40)
      agentRunning: progress.running,
      elapsed: progress.elapsed,
      toolCalls: progress.toolCalls,
      timeoutMs: progress.timeoutMs,
    });
  }

  // ── GET /api/tabs ─────────────────────────────────────────────────────────────
  if (method === 'GET' && urlPath === '/api/tabs') {
    return json(res, 200, tabManager.getTabList());
  }

  // ── POST /api/tabs (create tab) ───────────────────────────────────────────────
  if (method === 'POST' && urlPath === '/api/tabs') {
    const body = await readBody(req);
    const tabId = tabManager.createTab(body.url || undefined);
    await new Promise(r => setTimeout(r, 300)); // brief wait for tab init
    const tabs = tabManager.getTabList();
    const tab = tabs.find(t => t.id === tabId);
    return json(res, 200, tab || { id: tabId });
  }

  // ── DELETE /api/tabs/:id ───────────────────────────────────────────────────────
  {
    const m = matchRoute('/api/tabs/:id', urlPath);
    if (method === 'DELETE' && m) {
      const tab = tabManager.getTabList().find(t => t.id === m.id);
      if (!tab) return err(res, 404, 'Tab not found');
      if (tab.isAria) return err(res, 400, 'Cannot close Aria tab');
      tabManager.closeTab(m.id);
      return json(res, 200, { success: true });
    }
  }

  // ── POST /api/tabs/:id/activate ─────────────────────────────────────────────
  {
    const m = matchRoute('/api/tabs/:id/activate', urlPath);
    if (method === 'POST' && m) {
      const tab = tabManager.getTabList().find(t => t.id === m.id);
      if (!tab) return err(res, 404, 'Tab not found');
      tabManager.switchTab(m.id);
      return json(res, 200, { success: true, tab: { id: m.id, title: tab.title, index: tab.index } });
    }
  }

  // ── POST /api/tabs/:id/navigate ───────────────────────────────────────────────
  {
    const m = matchRoute('/api/tabs/:id/navigate', urlPath);
    if (method === 'POST' && m) {
      const body = await readBody(req);
      if (!body.url) return err(res, 400, 'url required');
      tabManager.navigate(m.id, body.url);
      return json(res, 200, { success: true });
    }
  }

  // ── GET /api/tabs/:id/elements ────────────────────────────────────────────────
  {
    const m = matchRoute('/api/tabs/:id/elements', urlPath);
    if (method === 'GET' && m) {
      const wc = tabManager.getWebContentsForTab(m.id);
      if (!wc) return err(res, 404, 'Tab not found');
      const result = await pageTools.pageElements(wc, undefined, false, query.grep || undefined);
      return json(res, 200, { result });
    }
  }

  // ── GET /api/tabs/:id/links ──────────────────────────────────────────────────
  {
    const m = matchRoute('/api/tabs/:id/links', urlPath);
    if (method === 'GET' && m) {
      const wc = tabManager.getWebContentsForTab(m.id);
      if (!wc) return err(res, 404, 'Tab not found');
      const result = await pageTools.pageLinks(wc, query.grep || undefined);
      return json(res, 200, { result });
    }
  }

  // ── POST /api/tabs/:id/click ──────────────────────────────────────────────────
  {
    const m = matchRoute('/api/tabs/:id/click', urlPath);
    if (method === 'POST' && m) {
      const body = await readBody(req);
      if (body.index === undefined) return err(res, 400, 'index required');
      const wc = tabManager.getWebContentsForTab(m.id);
      if (!wc) return err(res, 404, 'Tab not found');
      const result = await pageTools.pageClick(wc, body.index);
      return json(res, 200, { result });
    }
  }

  // ── POST /api/tabs/:id/type ───────────────────────────────────────────────────
  {
    const m = matchRoute('/api/tabs/:id/type', urlPath);
    if (method === 'POST' && m) {
      const body = await readBody(req);
      if (body.index === undefined || body.text === undefined) return err(res, 400, 'index and text required');
      const wc = tabManager.getWebContentsForTab(m.id);
      if (!wc) return err(res, 404, 'Tab not found');
      const result = await pageTools.pageType(wc, body.index, body.text);
      return json(res, 200, { result });
    }
  }

  // ── POST /api/tabs/:id/paste ──────────────────────────────────────────────────
  {
    const m = matchRoute('/api/tabs/:id/paste', urlPath);
    if (method === 'POST' && m) {
      const body = await readBody(req);
      if (body.index === undefined || body.text === undefined) return err(res, 400, 'index and text required');
      const wc = tabManager.getWebContentsForTab(m.id);
      if (!wc) return err(res, 404, 'Tab not found');
      const result = await pageTools.pagePaste(wc, body.index, body.text);
      return json(res, 200, { result });
    }
  }

  // ── GET /api/tabs/:id/text ────────────────────────────────────────────────────
  {
    const m = matchRoute('/api/tabs/:id/text', urlPath);
    if (method === 'GET' && m) {
      const wc = tabManager.getWebContentsForTab(m.id);
      if (!wc) return err(res, 404, 'Tab not found');
      const result = await pageTools.pageText(wc, undefined, query.grep || undefined);
      return json(res, 200, { result });
    }
  }

  // ── GET /api/tabs/:id/screenshot ──────────────────────────────────────────────
  {
    const m = matchRoute('/api/tabs/:id/screenshot', urlPath);
    if (method === 'GET' && m) {
      const wc = tabManager.getWebContentsForTab(m.id);
      if (!wc) return err(res, 404, 'Tab not found');
      const result = await pageTools.pageScreenshot(wc, undefined);
      return json(res, 200, { result });
    }
  }

  // ── POST /api/tabs/:id/click-xy ──────────────────────────────────────────────
  {
    const m = matchRoute('/api/tabs/:id/click-xy', urlPath);
    if (method === 'POST' && m) {
      const body = await readBody(req);
      if (body.x === undefined || body.y === undefined) return err(res, 400, 'x and y required');
      const wc = tabManager.getWebContentsForTab(m.id);
      if (!wc) return err(res, 404, 'Tab not found');
      const result = await pageTools.pageClickXY(wc, body.x, body.y);
      return json(res, 200, { result });
    }
  }

  // ── POST /api/tabs/:id/hover-xy ───────────────────────────────────────────────
  {
    const m = matchRoute('/api/tabs/:id/hover-xy', urlPath);
    if (method === 'POST' && m) {
      const body = await readBody(req);
      if (body.x === undefined || body.y === undefined) return err(res, 400, 'x and y required');
      const wc = tabManager.getWebContentsForTab(m.id);
      if (!wc) return err(res, 404, 'Tab not found');
      const result = await pageTools.pageHoverXY(wc, body.x, body.y);
      return json(res, 200, { result });
    }
  }

  // ── POST /api/tabs/:id/scroll ─────────────────────────────────────────────────
  {
    const m = matchRoute('/api/tabs/:id/scroll', urlPath);
    if (method === 'POST' && m) {
      const body = await readBody(req);
      if (!body.direction) return err(res, 400, 'direction required (up|down|top|bottom)');
      const wc = tabManager.getWebContentsForTab(m.id);
      if (!wc) return err(res, 404, 'Tab not found');
      const result = await pageTools.pageScroll(wc, body.direction, body.amount);
      return json(res, 200, { result });
    }
  }

  // ── POST /api/tabs/:id/keys ───────────────────────────────────────────────────
  {
    const m = matchRoute('/api/tabs/:id/keys', urlPath);
    if (method === 'POST' && m) {
      const body = await readBody(req);
      if (!body.keys) return err(res, 400, 'keys required');
      const wc = tabManager.getWebContentsForTab(m.id);
      if (!wc) return err(res, 404, 'Tab not found');
      const result = await pageTools.pageKeys(wc, body.keys);
      return json(res, 200, { result });
    }
  }

  // ── POST /api/tabs/:id/eval ───────────────────────────────────────────────────
  {
    const m = matchRoute('/api/tabs/:id/eval', urlPath);
    if (method === 'POST' && m) {
      const body = await readBody(req);
      if (!body.js) return err(res, 400, 'js required');
      const wc = tabManager.getWebContentsForTab(m.id);
      if (!wc) return err(res, 404, 'Tab not found');
      const result = await pageTools.pageEval(wc, body.js);
      return json(res, 200, { result });
    }
  }

  // ── POST /api/agent/ask/stream (SSE) ─────────────────────────────────────────
  if (method === 'POST' && urlPath === '/api/agent/ask/stream') {
    const body = await readBody(req);
    if (!body.message) return err(res, 400, 'message required');

    const cfg = getConfig();
    const apiKey = decryptApiKey(cfg.llm?.apiKey || '');
    if (!apiKey) return err(res, 400, 'No API key configured in Tappi Browser settings');

    // Bug 1 fix: resolve or create conversationId, init row in DB
    const convId: string = body.conversationId || crypto.randomUUID();
    try {
      const now = new Date().toISOString();
      getDb().prepare(
        "INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, '', ?, ?)"
      ).run(convId, now, now);
    } catch (dbErr) {
      console.error('[api] Failed to init conversation row:', dbErr);
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const browserCtx: browserTools.BrowserContext = { window: mainWindow, tabManager, config: cfg };

    let chunkHandler: ((data: { text: string; done: boolean }) => void) | null = null;
    let downloadCardHandler: ((data: any) => void) | null = null;
    let toolHandler: ((data: any) => void) | null = null;

    const cleanup = () => {
      if (chunkHandler) agentEvents.removeListener('chunk', chunkHandler);
      if (downloadCardHandler) agentEvents.removeListener('download_card', downloadCardHandler);
      if (toolHandler) agentEvents.removeListener('tool', toolHandler);
    };

    chunkHandler = ({ text, done }: { text: string; done: boolean }) => {
      try {
        res.write(`data: ${JSON.stringify({ text, done })}\n\n`);
        if (done) {
          cleanup();
          res.end();
        }
      } catch {
        cleanup();
      }
    };

    downloadCardHandler = (data: any) => {
      try {
        res.write(`data: ${JSON.stringify({ type: 'download_card', payload: data })}\n\n`);
      } catch {
        cleanup();
      }
    };

    toolHandler = (data: any) => {
      try {
        res.write(`data: ${JSON.stringify({ type: 'tool', payload: data })}\n\n`);
      } catch {
        cleanup();
      }
    };

    agentEvents.on('chunk', chunkHandler);
    agentEvents.on('download_card', downloadCardHandler);
    agentEvents.on('tool', toolHandler);

    // Cleanup on client disconnect
    req.on('close', () => {
      cleanup();
    });

    runAgent({
      userMessage: body.message,
      sessionId: convId,
      conversationId: convId,
      browserCtx,
      llmConfig: {
        provider: cfg.llm.provider,
        model: cfg.llm.model,
        apiKey,
        thinking: cfg.llm.thinking,
        region: cfg.llm.region,
        projectId: cfg.llm.projectId,
        location: cfg.llm.location,
        endpoint: cfg.llm.endpoint,
        baseUrl: cfg.llm.baseUrl,
      },
      window: mainWindow,
      developerMode: cfg.developerMode,
      agentBrowsingDataAccess: cfg.privacy?.agentBrowsingDataAccess === true,
    }).catch(e => {
      try { res.write(`data: ${JSON.stringify({ text: `❌ ${e.message}`, done: true })}\n\n`); res.end(); } catch {}
      cleanup();
    });

    return; // response handled by SSE
  }

  // ── POST /api/agent/ask ───────────────────────────────────────────────────────
  if (method === 'POST' && urlPath === '/api/agent/ask') {
    const body = await readBody(req);
    if (!body.message) return err(res, 400, 'message required');

    const cfg = getConfig();
    const apiKey = decryptApiKey(cfg.llm?.apiKey || '');
    if (!apiKey) return err(res, 400, 'No API key configured in Tappi Browser settings');

    // Bug 1 fix: resolve or create conversationId, init row in DB
    const convId: string = body.conversationId || crypto.randomUUID();
    try {
      const now = new Date().toISOString();
      getDb().prepare(
        "INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, '', ?, ?)"
      ).run(convId, now, now);
    } catch (dbErr) {
      console.error('[api] Failed to init conversation row:', dbErr);
    }

    const browserCtx: browserTools.BrowserContext = { window: mainWindow, tabManager, config: cfg };

    let fullResponse = '';
    let resolved = false;

    return new Promise<void>((resolve) => {
      // Phase 8.40: Use agentTimeoutMs + 10s buffer as the API timeout
      const agentTimeoutMs = cfg.llm?.agentTimeoutMs ?? 600_000;
      const TIMEOUT = agentTimeoutMs + 10_000;
      let timeoutHandle: NodeJS.Timeout;

      const chunkHandler = ({ text, done }: { text: string; done: boolean }) => {
        // BUG-003: Strip UI-only indicator lines (e.g. "🧠 Analyzing task complexity...")
        // BUG-T9: Also skip whitespace-only chunks (e.g. "\n" emitted to clear the UI "analyzing" message)
        if (!text.startsWith('🧠') && text.trim() !== '') {
          fullResponse += text;
        }
        if (done && !resolved) {
          resolved = true;
          clearTimeout(timeoutHandle);
          agentEvents.removeListener('chunk', chunkHandler);
          // BUG-T9: trimStart() strips any leading newline that slipped through
          json(res, 200, { response: fullResponse.trimStart() });
          resolve();
        }
      };

      agentEvents.on('chunk', chunkHandler);

      timeoutHandle = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          agentEvents.removeListener('chunk', chunkHandler);
          json(res, 200, { response: fullResponse || '(timeout — no response received)' });
          resolve();
        }
      }, TIMEOUT);

      runAgent({
        userMessage: body.message,
        sessionId: convId,
        conversationId: convId,
        browserCtx,
        llmConfig: {
          provider: cfg.llm.provider,
          model: cfg.llm.model,
          apiKey,
          thinking: cfg.llm.thinking,
          region: cfg.llm.region,
          projectId: cfg.llm.projectId,
          location: cfg.llm.location,
          endpoint: cfg.llm.endpoint,
          baseUrl: cfg.llm.baseUrl,
          // Timeouts (Phase 8.40)
          agentTimeoutMs: cfg.llm.agentTimeoutMs,
          teammateTimeoutMs: cfg.llm.teammateTimeoutMs,
          subtaskTimeoutMs: cfg.llm.subtaskTimeoutMs,
        },
        window: mainWindow,
        developerMode: cfg.developerMode,
        agentBrowsingDataAccess: cfg.privacy?.agentBrowsingDataAccess === true,
      }).catch(e => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutHandle);
          agentEvents.removeListener('chunk', chunkHandler);
          json(res, 500, { error: e.message });
          resolve();
        }
      });
    });
  }

  // ── POST /api/browser/dark-mode ───────────────────────────────────────────────
  if (method === 'POST' && urlPath === '/api/browser/dark-mode') {
    const body = await readBody(req);
    const cfg = getConfig();
    const browserCtx: browserTools.BrowserContext = { window: mainWindow, tabManager, config: cfg };
    const mode = body.enabled ? 'on' : 'off';
    const result = await browserTools.bDarkMode(browserCtx, [mode]);
    return json(res, 200, { result });
  }

  // ── GET /api/browser/cookies ──────────────────────────────────────────────────
  if (method === 'GET' && urlPath === '/api/browser/cookies') {
    const cfg = getConfig();
    const browserCtx: browserTools.BrowserContext = { window: mainWindow, tabManager, config: cfg };
    const args = query.domain ? ['list', query.domain] : ['list'];
    const result = await browserTools.bCookies(browserCtx, args);
    return json(res, 200, { result });
  }

  // ── DELETE /api/browser/cookies ───────────────────────────────────────────────
  if (method === 'DELETE' && urlPath === '/api/browser/cookies') {
    const body = await readBody(req);
    const cfg = getConfig();
    const browserCtx: browserTools.BrowserContext = { window: mainWindow, tabManager, config: cfg };
    const domain = body.domain || 'all';
    const result = await browserTools.bCookies(browserCtx, ['delete', domain]);
    return json(res, 200, { result });
  }

  // ── POST /api/browser/zoom ────────────────────────────────────────────────────
  if (method === 'POST' && urlPath === '/api/browser/zoom') {
    const body = await readBody(req);
    if (!body.action) return err(res, 400, 'action required (in|out|reset|level)');
    const cfg = getConfig();
    const browserCtx: browserTools.BrowserContext = { window: mainWindow, tabManager, config: cfg };
    const result = await browserTools.bZoom(browserCtx, [String(body.action)]);
    return json(res, 200, { result });
  }

  // ── POST /api/browser/find ────────────────────────────────────────────────────
  if (method === 'POST' && urlPath === '/api/browser/find') {
    const body = await readBody(req);
    const cfg = getConfig();
    const browserCtx: browserTools.BrowserContext = { window: mainWindow, tabManager, config: cfg };
    const args = body.text ? [body.text] : [];
    const result = await browserTools.bFind(browserCtx, args);
    return json(res, 200, { result });
  }

  // ── POST /api/browser/screenshot ──────────────────────────────────────────────
  if (method === 'POST' && urlPath === '/api/browser/screenshot') {
    const body = await readBody(req);
    const wc = tabManager.activeWebContents;
    if (!wc) return err(res, 400, 'No active tab');
    const result = await captureTools.captureScreenshot(
      mainWindow,
      wc,
      { target: body.target || 'tab', format: body.format, quality: body.quality, saveTo: body.saveTo },
    );
    return json(res, 200, { path: result.path, width: result.width, height: result.height, size: result.size });
  }

  // ── POST /api/browser/record ──────────────────────────────────────────────────
  if (method === 'POST' && urlPath === '/api/browser/record') {
    const body = await readBody(req);
    if (!body.action) return err(res, 400, 'action required (start|stop|status)');
    const result = await captureTools.handleRecord(
      mainWindow,
      () => tabManager.activeWebContents,
      body,
      (status) => {
        try { mainWindow.webContents.send('capture:recording-update', status); } catch {}
      },
    );
    return json(res, 200, { result });
  }

  // ── GET /api/config ───────────────────────────────────────────────────────────
  if (method === 'GET' && urlPath === '/api/config') {
    const cfg = getConfig();
    return json(res, 200, {
      ...cfg,
      llm: {
        ...cfg.llm,
        apiKey: cfg.llm?.apiKey ? '••••••••' : '',
        secondaryApiKey: cfg.llm?.secondaryApiKey ? '••••••••' : '',
      },
    });
  }

  // ── PATCH /api/config ─────────────────────────────────────────────────────────
  if (method === 'PATCH' && urlPath === '/api/config') {
    const body = await readBody(req);

    // F11: Block dangerous config fields
    const blockedFields = ['llm.baseUrl', 'developerMode', 'apiKey'];
    const flatKeys = flattenKeys(body);
    const blocked = flatKeys.filter(k => blockedFields.some(b => k === b || k.startsWith(b + '.')));
    if (blocked.length > 0) {
      return err(res, 400, `Blocked config fields: ${blocked.join(', ')}. These cannot be changed via API.`);
    }

    // F11: Only allow whitelisted fields
    const allowedPatterns = ['llm.model', 'llm.provider', 'features.', 'searchEngine'];
    const disallowed = flatKeys.filter(k => !allowedPatterns.some(p => k === p || k.startsWith(p)));
    if (disallowed.length > 0) {
      return err(res, 400, `Disallowed config fields: ${disallowed.join(', ')}. Allowed: llm.model, llm.provider, features.*, searchEngine`);
    }

    try {
      deps.updateConfig(body);
      return json(res, 200, { success: true });
    } catch (e: any) {
      return err(res, 500, e.message || 'Config update failed');
    }
  }

  // ── GET /api/tools ────────────────────────────────────────────────────────────
  if (method === 'GET' && urlPath === '/api/tools') {
    const cfg = getConfig();
    const browserCtx: browserTools.BrowserContext = { window: mainWindow, tabManager, config: cfg };
    const tools = createTools(browserCtx, 'api', {
      developerMode: cfg.developerMode,
      agentBrowsingDataAccess: cfg.privacy?.agentBrowsingDataAccess === true,
    });
    const toolList = Object.entries(tools).map(([name, t]: [string, any]) => ({
      name,
      description: t.description || '',
    }));
    return json(res, 200, toolList);
  }

  // ── POST /api/tools/:toolName ─────────────────────────────────────────────────
  {
    const m = matchRoute('/api/tools/:toolName', urlPath);
    if (method === 'POST' && m) {
      const cfg = getConfig();
      const apiKey = decryptApiKey(cfg.llm?.apiKey || '');
      const browserCtx: browserTools.BrowserContext = { window: mainWindow, tabManager, config: cfg };
      const tools = createTools(browserCtx, 'api', {
        developerMode: cfg.developerMode,
        agentBrowsingDataAccess: cfg.privacy?.agentBrowsingDataAccess === true,
        llmConfig: apiKey ? {
          provider: cfg.llm.provider,
          model: cfg.llm.model,
          apiKey,
          thinking: cfg.llm.thinking,
          region: cfg.llm.region,
          projectId: cfg.llm.projectId,
          location: cfg.llm.location,
          endpoint: cfg.llm.endpoint,
          baseUrl: cfg.llm.baseUrl,
        } : undefined,
      });
      const tool = (tools as any)[m.toolName];
      if (!tool) {
        return err(res, 404, `Tool "${m.toolName}" not found. GET /api/tools for list.`);
      }
      const body = await readBody(req);
      try {
        const result = await tool.execute(body, { toolCallId: 'api', messages: [] });
        return json(res, 200, { result });
      } catch (e: any) {
        return err(res, 500, e?.message || 'Tool execution failed');
      }
    }
  }

  // ── 404 ───────────────────────────────────────────────────────────────────────
  return err(res, 404, `Route not found: ${method} ${urlPath}`);
}
