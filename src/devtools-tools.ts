/**
 * devtools-tools.ts — DevTools tool definitions for the Vercel AI SDK.
 *
 * Provides agent tools for inspecting browser internals via Chrome DevTools
 * Protocol: console logs, network requests, JS errors, and page inspection
 * (DOM, performance, storage, resources).
 *
 * Each tool lazily attaches a CDP session on first call — subsequent calls
 * reuse the existing session and read from the rolling buffer.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { WebContents } from 'electron';
import { cdpManager } from './cdp-manager';

// ─── Helpers ────────────────────────────────────────────────────────────────────

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ─── Factory ────────────────────────────────────────────────────────────────────

export function createDevtoolsTools(
  getWC: (tabIndex?: number) => WebContents,
  tabManager: any // TabManager type
) {

  /** Resolve webContents + tabId for a given optional tab index. */
  function resolveTab(tab?: number): { wc: WebContents; tabId: string } {
    const wc = getWC(tab);
    const tabId = tabManager.getTabIdByWebContentsId(wc.id);
    if (!tabId) throw new Error('Could not resolve tab ID for the target webContents.');
    return { wc, tabId };
  }

  return {

    // ═══════════════════════════════════════════════════════════════════════════
    //  console_logs
    // ═══════════════════════════════════════════════════════════════════════════

    console_logs: tool({
      description:
        'Read console output (log/warn/error) from a tab. First call starts monitoring. Check after: failed clicks, broken pages, CORS/CSP errors. Example: console_logs({ level: \'error\' })',
      inputSchema: z.object({
        tab: z.number().optional().describe('Tab index (0-based) to target — omit for current tab'),
        level: z.enum(['all', 'log', 'warn', 'error', 'info', 'debug']).optional().describe('Filter by log level'),
        grep: z.string().optional().describe('Filter entries containing this text'),
        limit: z.number().optional().default(50).describe('Max entries to return'),
        clear: z.boolean().optional().default(false).describe('Clear the buffer after reading'),
      }),
      execute: async ({
        tab,
        level,
        grep,
        limit = 50,
        clear = false,
      }: {
        tab?: number;
        level?: 'all' | 'log' | 'warn' | 'error' | 'info' | 'debug';
        grep?: string;
        limit?: number;
        clear?: boolean;
      }) => {
        const { wc, tabId } = resolveTab(tab);

        // Ensure CDP session with required domains
        await cdpManager.ensureSession(tabId, wc, ['Runtime', 'Page']);

        // Read buffered entries
        const entries = cdpManager.getConsoleEntries(tabId, { level, grep, limit });

        // Optionally clear
        if (clear) {
          cdpManager.clearBuffer(tabId, 'console');
        }

        if (!entries || entries.length === 0) {
          return 'No console messages captured yet. Monitoring started — interact with the page and call again.';
        }

        // Format: [HH:MM:SS] LEVEL: message
        return entries
          .map((e: any) => `[${formatTime(e.timestamp)}] ${(e.level || 'LOG').toUpperCase()}: ${e.text}`)
          .join('\n');
      },
    }),

    // ═══════════════════════════════════════════════════════════════════════════
    //  network_requests
    // ═══════════════════════════════════════════════════════════════════════════

    network_requests: tool({
      description:
        'Read HTTP requests/responses with URL, status, timing, size. First call starts monitoring. Check after: form submissions, to find hidden APIs for direct data extraction, auth redirect chains. Example: network_requests({ grep: \'/api/\', status: \'4xx\' })',
      inputSchema: z.object({
        tab: z.number().optional().describe('Tab index (0-based) to target — omit for current tab'),
        status: z.string().optional().describe('Filter by status code pattern (e.g. "200", "4xx", "5xx")'),
        method: z.string().optional().describe('Filter by HTTP method (GET, POST, etc.)'),
        grep: z.string().optional().describe('Filter entries where URL contains this text'),
        limit: z.number().optional().default(50).describe('Max entries to return'),
        details: z.boolean().optional().default(false).describe('Include response headers'),
        clear: z.boolean().optional().default(false).describe('Clear the buffer after reading'),
      }),
      execute: async ({
        tab,
        status,
        method,
        grep,
        limit = 50,
        details = false,
        clear = false,
      }: {
        tab?: number;
        status?: string;
        method?: string;
        grep?: string;
        limit?: number;
        details?: boolean;
        clear?: boolean;
      }) => {
        const { wc, tabId } = resolveTab(tab);

        await cdpManager.ensureSession(tabId, wc, ['Network', 'Page']);

        const entries = cdpManager.getNetworkEntries(tabId, { status, method, grep, limit, details });

        if (clear) {
          cdpManager.clearBuffer(tabId, 'network');
        }

        if (!entries || entries.length === 0) {
          return 'No network requests captured yet. Monitoring started — interact with the page and call again.';
        }

        // Format: METHOD STATUS URL (TIMINGms, SIZE)
        return entries
          .map((e: any) => {
            const timing = e.timing != null ? `${Math.round(e.timing)}ms` : '?ms';
            const size = e.size != null ? formatBytes(e.size) : '?';
            let line = `${e.method || 'GET'} ${e.status || '???'} ${e.url} (${timing}, ${size})`;
            if (details && e.responseHeaders) {
              const headers = Object.entries(e.responseHeaders)
                .map(([k, v]) => `  ${k}: ${v}`)
                .join('\n');
              line += '\n' + headers;
            }
            return line;
          })
          .join('\n');
      },
    }),

    // ═══════════════════════════════════════════════════════════════════════════
    //  js_errors
    // ═══════════════════════════════════════════════════════════════════════════

    js_errors: tool({
      description:
        'Read uncaught JS exceptions with stack traces. First call starts monitoring. Check when: pages render blank, buttons don\'t work, navigation breaks. Example: js_errors({ limit: 5 })',
      inputSchema: z.object({
        tab: z.number().optional().describe('Tab index (0-based) to target — omit for current tab'),
        grep: z.string().optional().describe('Filter errors containing this text'),
        limit: z.number().optional().default(20).describe('Max entries to return'),
        clear: z.boolean().optional().default(false).describe('Clear the buffer after reading'),
      }),
      execute: async ({
        tab,
        grep,
        limit = 20,
        clear = false,
      }: {
        tab?: number;
        grep?: string;
        limit?: number;
        clear?: boolean;
      }) => {
        const { wc, tabId } = resolveTab(tab);

        await cdpManager.ensureSession(tabId, wc, ['Runtime', 'Page']);

        const entries = cdpManager.getErrorEntries(tabId, { grep, limit });

        if (clear) {
          cdpManager.clearBuffer(tabId, 'error');
        }

        if (!entries || entries.length === 0) {
          return 'No JS errors captured. Monitoring started — interact with the page and call again.';
        }

        // Format: error message + location + stack trace
        return entries
          .map((e: any) => {
            let line = `❌ ${e.message || 'Unknown error'}`;
            if (e.url) line += `\n   at ${e.url}${e.lineNumber != null ? `:${e.lineNumber}` : ''}${e.columnNumber != null ? `:${e.columnNumber}` : ''}`;
            if (e.stackTrace) line += `\n${e.stackTrace}`;
            return line;
          })
          .join('\n\n');
      },
    }),

    // ═══════════════════════════════════════════════════════════════════════════
    //  devtools_inspect
    // ═══════════════════════════════════════════════════════════════════════════

    devtools_inspect: tool({
      description:
        'Inspect page internals (one-shot). Targets: dom (DOM tree/query), performance (metrics), storage (localStorage/sessionStorage/cookies), resources (loaded scripts/styles/images). Example: devtools_inspect({ target: \'storage\', storageType: \'local\' })',
      inputSchema: z.object({
        tab: z.number().optional().describe('Tab index (0-based) to target — omit for current tab'),
        target: z.enum(['dom', 'performance', 'storage', 'resources']).describe('What to inspect'),
        selector: z.string().optional().describe('CSS selector for DOM queries (target=dom only)'),
        storageType: z.enum(['local', 'session', 'cookies']).optional().describe('Storage type (target=storage only, defaults to local)'),
      }),
      execute: async ({
        tab,
        target,
        selector,
        storageType,
      }: {
        tab?: number;
        target: 'dom' | 'performance' | 'storage' | 'resources';
        selector?: string;
        storageType?: 'local' | 'session' | 'cookies';
      }) => {
        const { wc, tabId } = resolveTab(tab);

        // ── DOM ──────────────────────────────────────────────────────────────
        if (target === 'dom') {
          await cdpManager.ensureSession(tabId, wc, ['DOM']);

          if (selector) {
            // Query a specific element
            const docResult = await cdpManager.sendCommand(tabId, 'DOM.getDocument', { depth: 0 });
            const rootNodeId = docResult.root.nodeId;

            const queryResult = await cdpManager.sendCommand(tabId, 'DOM.querySelector', {
              nodeId: rootNodeId,
              selector,
            });

            if (!queryResult.nodeId || queryResult.nodeId === 0) {
              return `No element found matching selector: ${selector}`;
            }

            const htmlResult = await cdpManager.sendCommand(tabId, 'DOM.getOuterHTML', {
              nodeId: queryResult.nodeId,
            });

            return `Element matching "${selector}":\n\n${htmlResult.outerHTML}`;
          }

          // No selector — return document structure summary
          const docResult = await cdpManager.sendCommand(tabId, 'DOM.getDocument', { depth: 3 });

          function summarizeNode(node: any, indent: string = ''): string {
            if (!node) return '';
            const lines: string[] = [];

            const tag = node.nodeName || '';
            if (tag === '#text' || tag === '#comment') return '';

            let desc = `${indent}<${tag.toLowerCase()}`;
            if (node.attributes) {
              const attrs: Record<string, string> = {};
              for (let i = 0; i < node.attributes.length; i += 2) {
                attrs[node.attributes[i]] = node.attributes[i + 1];
              }
              if (attrs.id) desc += ` id="${attrs.id}"`;
              if (attrs.class) desc += ` class="${attrs.class}"`;
            }
            const childCount = node.childNodeCount ?? node.children?.length ?? 0;
            desc += childCount > 0 ? `> (${childCount} children)` : '>';
            lines.push(desc);

            if (node.children) {
              for (const child of node.children) {
                const childSummary = summarizeNode(child, indent + '  ');
                if (childSummary) lines.push(childSummary);
              }
            }

            return lines.join('\n');
          }

          const summary = summarizeNode(docResult.root);
          return `Document structure (depth=3):\n\n${summary}`;
        }

        // ── PERFORMANCE ──────────────────────────────────────────────────────
        if (target === 'performance') {
          await cdpManager.ensureSession(tabId, wc, ['Performance']);

          await cdpManager.sendCommand(tabId, 'Performance.enable');
          const metricsResult = await cdpManager.sendCommand(tabId, 'Performance.getMetrics');

          if (!metricsResult.metrics || metricsResult.metrics.length === 0) {
            return 'No performance metrics available.';
          }

          return metricsResult.metrics
            .map((m: any) => `${m.name}: ${typeof m.value === 'number' ? m.value.toFixed(2) : m.value}`)
            .join('\n');
        }

        // ── STORAGE ──────────────────────────────────────────────────────────
        if (target === 'storage') {
          const type = storageType || 'local';

          if (type === 'local') {
            const data = await wc.executeJavaScript(
              `JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])))`
            );
            const parsed = JSON.parse(data);
            const keys = Object.keys(parsed);
            if (keys.length === 0) return 'localStorage is empty.';
            return `localStorage (${keys.length} keys):\n\n` +
              keys.map(k => `${k}: ${parsed[k]}`).join('\n');
          }

          if (type === 'session') {
            const data = await wc.executeJavaScript(
              `JSON.stringify(Object.fromEntries(Object.keys(sessionStorage).map(k => [k, sessionStorage.getItem(k)])))`
            );
            const parsed = JSON.parse(data);
            const keys = Object.keys(parsed);
            if (keys.length === 0) return 'sessionStorage is empty.';
            return `sessionStorage (${keys.length} keys):\n\n` +
              keys.map(k => `${k}: ${parsed[k]}`).join('\n');
          }

          if (type === 'cookies') {
            const url = wc.getURL();
            const cookies = await wc.session.cookies.get({ url });
            if (cookies.length === 0) return `No cookies for ${url}.`;
            return `Cookies for ${url} (${cookies.length}):\n\n` +
              cookies.map((c: any) =>
                `${c.name}=${c.value}${c.httpOnly ? ' [httpOnly]' : ''}${c.secure ? ' [secure]' : ''}${c.sameSite ? ` [sameSite=${c.sameSite}]` : ''}`
              ).join('\n');
          }

          return `Unknown storage type: ${type}`;
        }

        // ── RESOURCES ────────────────────────────────────────────────────────
        if (target === 'resources') {
          await cdpManager.ensureSession(tabId, wc, ['Page']);

          const treeResult = await cdpManager.sendCommand(tabId, 'Page.getResourceTree');

          const resources: Array<{ url: string; type: string }> = [];

          function collectResources(frame: any): void {
            if (frame.resources) {
              for (const r of frame.resources) {
                resources.push({ url: r.url, type: r.type });
              }
            }
            if (frame.childFrames) {
              for (const child of frame.childFrames) {
                collectResources(child.frame || child);
              }
            }
          }

          collectResources(treeResult.frameTree);

          if (resources.length === 0) return 'No resources found.';

          // Group by type
          const byType = new Map<string, string[]>();
          for (const r of resources) {
            const list = byType.get(r.type) || [];
            list.push(r.url);
            byType.set(r.type, list);
          }

          const lines: string[] = [`Page resources (${resources.length} total):\n`];
          for (const [type, urls] of byType) {
            lines.push(`── ${type} (${urls.length}) ──`);
            for (const url of urls) {
              lines.push(`  ${url}`);
            }
          }

          return lines.join('\n');
        }

        return `Unknown target: ${target}`;
      },
    }),
  };
}
