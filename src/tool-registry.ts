/**
 * tool-registry.ts — Vercel AI SDK v6 tool definitions.
 *
 * Each tool wraps a function from page-tools, browser-tools, http-tools, or file-tools.
 * Tools are created dynamically via createTools() because they need runtime context.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { WebContents } from 'electron';
import * as pageTools from './page-tools';
import * as browserTools from './browser-tools';
import * as httpTools from './http-tools';
import * as fileTools from './file-tools';
import * as shellTools from './shell-tools';
import * as toolManager from './tool-manager';
import * as subAgent from './sub-agent';
import * as cronManager from './cron-manager';
import { searchHistory } from './conversation';
import { agentListConversations, agentSearchConversations, agentReadConversation } from './conversation-store';
import { queryHistory, queryBookmarks, queryDownloads } from './database';
import type { BrowserContext } from './browser-tools';
import type { LLMConfig } from './llm-client';
import * as teamManager from './team-manager';
import * as mailbox from './mailbox';
import * as taskList from './shared-task-list';
import * as captureTools from './capture-tools';
import { WorktreeManager, createWorktreeManager } from './worktree-manager';
import * as projectManager from './project-manager';
import * as codingMemory from './coding-memory';
import { loadUserProfileTxt, saveUserProfileTxt, getUserProfileTxtPath } from './user-profile';

// ─── Phase 9.09: Project update callback ─────────────────────────────────────
// Main process sets this so agent tools can notify the UI when projects change.
let _projectUpdateCallback: (() => void) | null = null;
export function setProjectUpdateCallback(cb: () => void): void {
  _projectUpdateCallback = cb;
}
function emitProjectsUpdated(): void {
  try { _projectUpdateCallback?.(); } catch {}
}

export interface ToolRegistryOptions {
  developerMode?: boolean;
  llmConfig?: LLMConfig;
  codingMode?: boolean;
  teamId?: string;        // Set when called from a teammate session
  agentName?: string;     // Set when called from a teammate session (e.g. "@backend")
  agentBrowsingDataAccess?: boolean; // Phase 8.4.1: grant agent access to history/bookmarks/downloads
  worktreeIsolation?: boolean; // Phase 8.39: git worktree isolation enabled
  repoPath?: string;           // Phase 8.39: current repo path for worktree tools
  conversationId?: string;     // Bug 4 fix: current conversation ID for project auto-linking
}

export function createTools(browserCtx: BrowserContext, sessionId = 'default', options?: ToolRegistryOptions) {
  function getWC(tabIndex?: number): WebContents {
    // Phase 9: If a tab index is specified, resolve to that tab's webContents directly
    if (tabIndex !== undefined && tabIndex !== null) {
      const tabs = browserCtx.tabManager.getTabList();
      if (tabIndex < 0 || tabIndex >= tabs.length) throw new Error(`Tab index ${tabIndex} out of range (0-${tabs.length - 1}).`);
      const tabId = tabs[tabIndex]?.id;
      if (!tabId) throw new Error(`Tab ${tabIndex} not found.`);
      const info = browserCtx.tabManager.getTabInfo(tabId);
      if (!info) throw new Error(`Tab ${tabIndex} not found.`);
      // Get webContents for this specific tab
      const tab = (browserCtx.tabManager as any).tabs?.get(tabId);
      if (tab?.view?.webContents && !tab.view.webContents.isDestroyed()) {
        return tab.view.webContents;
      }
      throw new Error(`Tab ${tabIndex} webContents unavailable.`);
    }
    // Phase 8.35: Always use a real web tab, never the Aria tab.
    // activeWebTabWebContents skips the Aria tab and falls back to the last web tab.
    const wc = browserCtx.tabManager.activeWebTabWebContents;
    if (!wc) throw new Error('No active web tab. Open a tab first.');
    return wc;
  }

  return {
    // ═══ PAGE TOOLS ═══

    elements: tool({
      description: 'Index interactive elements on the page. Default: viewport only (~20-40 elements). Use grep to search ALL elements (including offscreen) by text match — like "elements | grep submit" in a terminal. Use tab param to target a specific tab by index without switching.',
      inputSchema: z.object({
        filter: z.string().optional().describe('CSS selector to scope indexing'),
        grep: z.string().optional().describe('Search all elements (including offscreen) for this text'),
        tab: z.number().optional().describe('Tab index (0-based) to target — omit for current/agent-targeted tab'),
      }),
      execute: async ({ filter, grep, tab }: { filter?: string; grep?: string; tab?: number }) => pageTools.pageElements(getWC(tab), filter, false, grep),
    }),

    click: tool({
      description: 'Click an element by its index number from the elements list.',
      inputSchema: z.object({
        index: z.number().describe('Element index from elements output'),
        tab: z.number().optional().describe('Tab index (0-based) to target'),
      }),
      execute: async ({ index, tab }: { index: number; tab?: number }) => pageTools.pageClick(getWC(tab), index),
    }),

    type: tool({
      description: 'Type text into an input/textarea by index. Clears existing content first. For long content, prefer paste.',
      inputSchema: z.object({
        index: z.number().describe('Element index'),
        text: z.string().describe('Text to type'),
      }),
      execute: async ({ index, text }: { index: number; text: string }) => pageTools.pageType(getWC(), index, text),
    }),

    paste: tool({
      description: 'Paste text into an element by index. Uses OS clipboard — more reliable than type for long content.',
      inputSchema: z.object({
        index: z.number().describe('Element index'),
        content: z.string().describe('Text to paste'),
      }),
      execute: async ({ index, content }: { index: number; content: string }) => pageTools.pagePaste(getWC(), index, content),
    }),

    focus: tool({
      description: 'Focus an element by index without clicking.',
      inputSchema: z.object({
        index: z.number().describe('Element index'),
      }),
      execute: async ({ index }: { index: number }) => pageTools.pageFocus(getWC(), index),
    }),

    check: tool({
      description: 'Read current state of an element: value, checked, disabled, focused.',
      inputSchema: z.object({
        index: z.number().describe('Element index'),
      }),
      execute: async ({ index }: { index: number }) => pageTools.pageCheck(getWC(), index),
    }),

    text: tool({
      description: 'Extract text from the page. Default: ~1.5KB of page text. Use selector for targeted sections (up to 4KB). Use grep to search for specific passages across the entire page — returns matching lines with context. Use tab param to target a specific tab by index.',
      inputSchema: z.object({
        selector: z.string().optional().describe('CSS selector to scope extraction'),
        grep: z.string().optional().describe('Search page text for this string, return matching passages'),
        tab: z.number().optional().describe('Tab index (0-based) to target — omit for current/agent-targeted tab'),
      }),
      execute: async ({ selector, grep, tab }: { selector?: string; grep?: string; tab?: number }) => pageTools.pageText(getWC(tab), selector, grep),
    }),

    scroll: tool({
      description: 'Scroll the page. Directions: up, down, top, bottom. Use tab param to target a specific tab.',
      inputSchema: z.object({
        direction: z.enum(['up', 'down', 'top', 'bottom']),
        amount: z.number().optional().describe('Pixels to scroll (default 500)'),
        tab: z.number().optional().describe('Tab index (0-based) to target'),
      }),
      execute: async ({ direction, amount, tab }: { direction: string; amount?: number; tab?: number }) => pageTools.pageScroll(getWC(tab), direction, amount),
    }),

    keys: tool({
      description: 'Send keyboard input. Essential for canvas apps (Sheets, Docs, Figma). Pass a single combo string or array of actions. Special: enter, tab, escape, backspace, up, down. Combos: ctrl+c, cmd+b.',
      inputSchema: z.object({
        sequence: z.union([z.string(), z.array(z.string())]).describe('Key combo or array of actions'),
      }),
      execute: async ({ sequence }: { sequence: string | string[] }) => pageTools.pageKeys(getWC(), sequence),
    }),

    eval_js: tool({
      description: 'Execute JavaScript in the page context. Has access to document, window.',
      inputSchema: z.object({
        js: z.string().describe('JavaScript code to execute'),
      }),
      execute: async ({ js }: { js: string }) => pageTools.pageEval(getWC(), js),
    }),

    screenshot: tool({
      description: 'Save a screenshot of the current page to a file. Prefer elements/text for quick page understanding.',
      inputSchema: z.object({
        filePath: z.string().optional().describe('File path to save PNG (default: temp dir)'),
      }),
      execute: async ({ filePath }: { filePath?: string }) => pageTools.pageScreenshot(getWC(), filePath),
    }),

    click_xy: tool({
      description: 'Click at specific pixel coordinates. Fallback for elements not reachable by index.',
      inputSchema: z.object({
        x: z.number().describe('X coordinate'),
        y: z.number().describe('Y coordinate'),
      }),
      execute: async ({ x, y }: { x: number; y: number }) => pageTools.pageClickXY(getWC(), x, y),
    }),

    hover_xy: tool({
      description: 'Hover at coordinates. Triggers tooltips, dropdowns.',
      inputSchema: z.object({
        x: z.number().describe('X coordinate'),
        y: z.number().describe('Y coordinate'),
      }),
      execute: async ({ x, y }: { x: number; y: number }) => pageTools.pageHoverXY(getWC(), x, y),
    }),

    wait: tool({
      description: 'Wait for milliseconds. Use sparingly.',
      inputSchema: z.object({
        ms: z.number().describe('Milliseconds to wait'),
      }),
      execute: async ({ ms }: { ms: number }) => pageTools.pageWait(ms),
    }),

    // ═══ BROWSER TOOLS ═══

    navigate: tool({
      description: 'Navigate current tab to a URL.',
      inputSchema: z.object({
        url: z.string().describe('URL to navigate to'),
      }),
      execute: async ({ url }: { url: string }) => browserTools.bNavigate(browserCtx, [url]),
    }),

    search: tool({
      description: 'Search the web using the configured search engine.',
      inputSchema: z.object({
        query: z.string().describe('Search query'),
      }),
      execute: async ({ query }: { query: string }) => browserTools.bSearch(browserCtx, [query]),
    }),

    back_forward: tool({
      description: 'Go back or forward in browser history.',
      inputSchema: z.object({
        direction: z.enum(['back', 'forward']),
      }),
      execute: async ({ direction }: { direction: string }) => browserTools.bBackForward(browserCtx, [direction]),
    }),

    dark_mode: tool({
      description: 'Toggle dark mode on the current page.',
      inputSchema: z.object({
        mode: z.enum(['on', 'off']),
      }),
      execute: async ({ mode }: { mode: string }) => browserTools.bDarkMode(browserCtx, [mode]),
    }),

    cookies: tool({
      description: 'List or delete browser cookies.',
      inputSchema: z.object({
        action: z.enum(['list', 'delete']),
        domain: z.string().optional().describe('Domain to filter/delete (or "all" for delete)'),
      }),
      execute: async ({ action, domain }: { action: string; domain?: string }) =>
        browserTools.bCookies(browserCtx, domain ? [action, domain] : [action]),
    }),

    tab: tool({
      description: 'Tab management — list all tabs, close, mute, pin, duplicate, close others, close right. You do NOT need to switch tabs — use the tab param on elements/text/click/scroll to interact with any tab by index directly. Switch is only for when the user explicitly asks to change the visible tab.',
      inputSchema: z.object({
        action: z.enum(['switch', 'list', 'close', 'mute', 'pin', 'duplicate', 'others', 'right']),
        index: z.union([z.number(), z.string()]).optional().describe('Tab index (0-based) or tab ID — required for switch'),
      }),
      execute: async ({ action, index }: { action: string; index?: number | string }) => {
        const args = [action];
        if (index !== undefined) args.push(String(index));
        return browserTools.bTab(browserCtx, args);
      },
    }),

    bookmark: tool({
      description: 'Toggle bookmark on the current page.',
      inputSchema: z.object({}),
      execute: async () => browserTools.bBookmark(browserCtx, []),
    }),

    zoom: tool({
      description: 'Zoom the page. in/out/reset or a percentage (e.g. "150" or 150).',
      inputSchema: z.object({
        level: z.union([z.string(), z.number()]).optional().describe('in | out | reset | percentage (e.g. 150)'),
        action: z.union([z.string(), z.number()]).optional().describe('Alias for level — accepts either'),
      }),
      execute: async ({ level, action }: { level?: string | number; action?: string | number }) => {
        // BUG-A03: accept both `level` and `action`, prefer `level`
        const zoomValue = String(level ?? action ?? 'reset');
        return browserTools.bZoom(browserCtx, [zoomValue]);
      },
    }),

    find: tool({
      description: 'Find text on page. Empty string clears search.',
      inputSchema: z.object({
        query: z.string().optional().describe('Text to find'),
        text: z.string().optional().describe('Alias for query — accepts either'),
      }),
      execute: async ({ query, text }: { query?: string; text?: string }) => {
        // BUG-A04: accept both `query` and `text`, prefer `query`
        const searchTerm = query ?? text ?? '';
        return browserTools.bFind(browserCtx, searchTerm ? [searchTerm] : []);
      },
    }),

    print_pdf: tool({
      description: 'Print or save as PDF. Provide path/saveTo/filePath for silent PDF save; omit to open print dialog.',
      inputSchema: z.object({
        format:   z.enum(['print', 'pdf']).default('pdf').describe('Output type: pdf (default) or print dialog'),
        filePath: z.string().optional().describe('File path to save PDF (alias: path, saveTo)'),
        path:     z.string().optional().describe('File path to save PDF'),
        saveTo:   z.string().optional().describe('File path to save PDF'),
      }),
      execute: async ({ format, filePath, path: pathArg, saveTo }: { format: string; filePath?: string; path?: string; saveTo?: string }) => {
        // BUG-A05: resolve save path from any of the accepted aliases
        const savePath = filePath || pathArg || saveTo;
        return browserTools.bPrint(browserCtx, savePath ? ['pdf', savePath] : [format]);
      },
    }),

    browser_screenshot: tool({
      description: 'Capture a screenshot of the browser tab, window, or full scrollable page. Returns file path + metadata. target: "tab" (default) | "window" (full Electron window) | "fullpage" (stitched scrollable page). format: "png" (default) | "jpeg". quality: JPEG quality 1-100 (default 90). saveTo: custom file path (default ~/tappi-workspace/screenshots/).',
      inputSchema: z.object({
        target:  z.enum(['tab', 'window', 'fullpage']).optional().describe('What to capture (default: tab)'),
        saveTo:  z.string().optional().describe('File path to save to (default: ~/tappi-workspace/screenshots/capture-{ts}.png)'),
        format:  z.enum(['png', 'jpeg']).optional().describe('Image format (default: png)'),
        quality: z.number().optional().describe('JPEG quality 1-100 (default: 90)'),
      }),
      execute: async ({ target, saveTo, format, quality }: {
        target?: 'tab' | 'window' | 'fullpage'; saveTo?: string; format?: 'png' | 'jpeg'; quality?: number;
      }) => {
        try {
          // Phase 8.35: Capture the real web tab, not the Aria tab.
          const result = await captureTools.captureScreenshot(
            browserCtx.window,
            browserCtx.tabManager.activeWebTabWebContents,
            { target, saveTo, format, quality },
          );
          return `✅ Screenshot saved: ${result.path} (${result.width}×${result.height}, ${(result.size / 1024).toFixed(1)} KB)`;
        } catch (e: any) {
          return `❌ Screenshot failed: ${e.message}`;
        }
      },
    }),

    browser_record: tool({
      description: 'Record the browser as video. Actions: start, stop, status. Uses capturePage polling → ffmpeg to produce MP4. Only one recording at a time. Status bar shows 🔴 REC with elapsed time.',
      inputSchema: z.object({
        action:      z.enum(['start', 'stop', 'status']).describe('start | stop | status'),
        target:      z.enum(['tab', 'window']).optional().describe('What to record: tab (default) or window'),
        saveTo:      z.string().optional().describe('Output file path (default: ~/tappi-workspace/recordings/recording-{ts}.mp4)'),
        maxDuration: z.number().optional().describe('Max seconds before auto-stop (default: 300, max: 600)'),
        fps:         z.number().optional().describe('Frame rate 1-30 (default: 15)'),
      }),
      execute: async ({ action, target, saveTo, maxDuration, fps }: {
        action: 'start' | 'stop' | 'status'; target?: 'tab' | 'window'; saveTo?: string; maxDuration?: number; fps?: number;
      }) => {
        return captureTools.handleRecord(
          browserCtx.window,
          // Phase 8.35: Record the real web tab, not the Aria tab.
          () => browserCtx.tabManager.activeWebTabWebContents,
          { action, target, saveTo, maxDuration, fps },
          (status) => {
            // Notify the UI status bar of recording state changes
            try { browserCtx.window.webContents.send('capture:recording-update', status); } catch {}
          },
        );
      },
    }),

    // ═══ HTTP TOOLS ═══

    http_request: tool({
      description: 'Make an HTTP request. Supports methods, headers, JSON bodies, auth, binary save. Pass jsonBody as a JSON string — it will be parsed and sent as JSON. For auth, use "@service" to auto-resolve a stored API key (e.g. auth: "@openai" → "Bearer sk-...").',
      inputSchema: z.object({
        url: z.string().describe('Request URL'),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
        body: z.string().optional().describe('Raw request body string'),
        jsonBody: z.string().optional().describe('JSON body as string (will be parsed)'),
        auth: z.string().optional().describe('"@service" to use stored key (e.g. "@openai"), or raw "Bearer <token>"'),
        saveToFile: z.string().optional().describe('Save binary response to file path'),
        timeout: z.number().optional().describe('Timeout in ms'),
      }),
      execute: async ({ url, method, body, jsonBody, auth, saveToFile, timeout }: {
        url: string; method?: string; body?: string; jsonBody?: string;
        auth?: string; saveToFile?: string; timeout?: number;
      }) => {
        const req: any = { url, method, body, auth, saveToFile, timeout };
        if (jsonBody) {
          try { req.json = JSON.parse(jsonBody); } catch { req.body = jsonBody; }
        }
        return httpTools.httpRequest(req as httpTools.HttpRequest);
      },
    }),

    api_key_store: tool({
      description: 'Store an API key securely (encrypted).',
      inputSchema: z.object({
        service: z.string().describe('Service name'),
        key: z.string().describe('API key'),
      }),
      execute: async ({ service, key }: { service: string; key: string }) => httpTools.storeApiKey(service, key),
    }),

    api_key_list: tool({
      description: 'List stored API key service names.',
      inputSchema: z.object({}),
      execute: async () => httpTools.listApiKeys(),
    }),

    api_key_get: tool({
      description: 'Retrieve a stored API key.',
      inputSchema: z.object({
        service: z.string().describe('Service name'),
      }),
      execute: async ({ service }: { service: string }) => httpTools.getApiKey(service) || `No key found for "${service}"`,
    }),

    api_key_delete: tool({
      description: 'Delete a stored API key.',
      inputSchema: z.object({
        service: z.string().describe('Service name'),
      }),
      execute: async ({ service }: { service: string }) => httpTools.deleteApiKey(service),
    }),

    register_api: tool({
      description: 'Register an API service with its base URL, auth style, description, and endpoints. Once registered, the service appears in your context every turn so you remember it exists. Pair with api_key_store to make it fully usable.',
      inputSchema: z.object({
        name: z.string().describe('Short service name (e.g. "openai", "stripe", "github")'),
        baseUrl: z.string().describe('API base URL (e.g. "https://api.openai.com/v1")'),
        authHeader: z.string().default('Bearer').describe('Auth prefix — "Bearer", "Basic", "token", or custom'),
        description: z.string().describe('What the API does (e.g. "OpenAI — GPT, DALL-E, Whisper")'),
        endpoints: z.array(z.string()).optional().describe('Key endpoints (e.g. ["/chat/completions", "/images/generations"])'),
      }),
      execute: async ({ name, baseUrl, authHeader, description, endpoints }: {
        name: string; baseUrl: string; authHeader: string; description: string; endpoints?: string[];
      }) => httpTools.registerService(name, baseUrl, authHeader, description, endpoints),
    }),

    list_apis: tool({
      description: 'List all configured API services and stored keys. Shows which services have keys and which need them.',
      inputSchema: z.object({}),
      execute: async () => httpTools.listServices(),
    }),

    remove_api: tool({
      description: 'Remove an API service registration (keeps the key if stored separately).',
      inputSchema: z.object({
        name: z.string().describe('Service name to remove'),
      }),
      execute: async ({ name }: { name: string }) => httpTools.removeService(name),
    }),

    document_endpoint: tool({
      description: 'Document an API endpoint with request + response schemas. Stored persistently — learn an API once, use forever. Use after browsing API docs. Upserts by method+path.',
      inputSchema: z.object({
        service: z.string().describe('Service name (must be registered via register_api first)'),
        endpointPath: z.string().describe('Endpoint path (e.g. "/v1/chat/completions")'),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
        summary: z.string().describe('One-line description (~10 words)'),
        requestSchema: z.string().describe('Compact JSON example of request body'),
        responseSchema: z.string().describe('Compact JSON example of response body'),
      }),
      execute: async (params: {
        service: string; endpointPath: string; method: string; summary: string;
        requestSchema: string; responseSchema: string;
      }) => httpTools.documentEndpoint(params.service, {
        path: params.endpointPath,
        method: params.method,
        summary: params.summary,
        requestSchema: params.requestSchema,
        responseSchema: params.responseSchema,
      }),
    }),

    get_endpoint_docs: tool({
      description: 'Retrieve stored API endpoint documentation for a service. Use before making API calls to recall how endpoints work. Grep to filter by path/description.',
      inputSchema: z.object({
        service: z.string().describe('Service name'),
        grep: z.string().optional().describe('Filter endpoints by path, description, or notes'),
      }),
      execute: async ({ service, grep }: { service: string; grep?: string }) =>
        httpTools.getEndpointDocs(service, grep),
    }),

    // ═══ FILE TOOLS ═══

    file_write: tool({
      description: 'Create or overwrite a file. Relative paths → ~/tappi-workspace/.',
      inputSchema: z.object({
        path: z.string().describe('File path'),
        content: z.string().describe('File content'),
      }),
      execute: async ({ path, content }: { path: string; content: string }) => fileTools.fileWrite(path, content),
    }),

    file_read: tool({
      description: 'Read a file. Large files (>20K tokens) return a summary with options instead of content. Use grep/offset/limit params to handle large files efficiently — grep searches without loading the full file into context, offset+limit enable chunked reading for sub-agents.',
      inputSchema: z.object({
        path: z.string().describe('File path'),
        grep: z.string().optional().describe('Search the file for this text — returns matching lines with ±2 context lines (recommended for large files)'),
        offset: z.number().optional().describe('Byte offset to start reading from (for chunked reading by sub-agents)'),
        limit: z.number().optional().describe('Max bytes to read (default/max ~80KB ≈ 20K tokens)'),
      }),
      execute: async ({ path, grep, offset, limit }: { path: string; grep?: string; offset?: number; limit?: number }) => {
        const opts: fileTools.FileReadOptions = {};
        if (grep) opts.grep = grep;
        if (offset !== undefined) opts.offset = offset;
        if (limit !== undefined) opts.limit = limit;
        return fileTools.fileRead(path, Object.keys(opts).length > 0 ? opts : undefined);
      },
    }),

    file_read_range: tool({
      description: 'Read a specific line range from a file (1-indexed). Use after file_read reports a large file. Capped at ~20K tokens per call — use smaller ranges if truncated.',
      inputSchema: z.object({
        path: z.string().describe('File path'),
        from: z.number().describe('Start line (1-indexed, inclusive)'),
        to: z.number().describe('End line (inclusive)'),
      }),
      execute: async ({ path, from, to }: { path: string; from: number; to: number }) =>
        fileTools.fileReadRange(path, from, to),
    }),

    file_head: tool({
      description: 'Read first N lines of a file.',
      inputSchema: z.object({
        path: z.string().describe('File path'),
        lines: z.number().optional().describe('Number of lines (default 20)'),
      }),
      execute: async ({ path, lines }: { path: string; lines?: number }) => fileTools.fileHead(path, lines || 20),
    }),

    file_tail: tool({
      description: 'Read last N lines of a file.',
      inputSchema: z.object({
        path: z.string().describe('File path'),
        lines: z.number().optional().describe('Number of lines (default 20)'),
      }),
      execute: async ({ path, lines }: { path: string; lines?: number }) => fileTools.fileTail(path, lines || 20),
    }),

    file_append: tool({
      description: 'Append content to a file.',
      inputSchema: z.object({
        path: z.string().describe('File path'),
        content: z.string().describe('Content to append'),
      }),
      execute: async ({ path, content }: { path: string; content: string }) => fileTools.fileAppend(path, content),
    }),

    file_delete: tool({
      description: 'Delete a file or directory.',
      inputSchema: z.object({
        path: z.string().describe('File or directory path'),
      }),
      execute: async ({ path }: { path: string }) => fileTools.fileDelete(path),
    }),

    file_list: tool({
      description: 'List files and directories. Defaults to ~/tappi-workspace/.',
      inputSchema: z.object({
        path: z.string().optional().describe('Directory path'),
      }),
      execute: async ({ path }: { path?: string }) => fileTools.fileList(path || undefined),
    }),

    file_copy: tool({
      description: 'Copy a file.',
      inputSchema: z.object({
        source: z.string().describe('Source path'),
        destination: z.string().describe('Destination path'),
      }),
      execute: async ({ source, destination }: { source: string; destination: string }) =>
        fileTools.fileCopy(source, destination),
    }),

    file_move: tool({
      description: 'Move or rename a file.',
      inputSchema: z.object({
        source: z.string().describe('Source path'),
        destination: z.string().describe('Destination path'),
      }),
      execute: async ({ source, destination }: { source: string; destination: string }) =>
        fileTools.fileMove(source, destination),
    }),

    file_grep: tool({
      description: 'Search a file for lines matching a pattern. Returns matching lines with line numbers and surrounding context. Use instead of file_read when you know what you\'re looking for.',
      inputSchema: z.object({
        path: z.string().describe('File path'),
        grep: z.string().optional().describe('Text to search for (case-insensitive)'),
        pattern: z.string().optional().describe('Alias for grep — text to search for (case-insensitive)'),
        context: z.number().optional().describe('Lines of context around each match (default 1)'),
      }),
      execute: async ({ path, grep, pattern, context: ctx }: { path: string; grep?: string; pattern?: string; context?: number }) => {
        const searchTerm = grep || pattern;
        if (!searchTerm) return 'Usage: provide "grep" or "pattern" param with the text to search for';
        return fileTools.fileGrep(path, searchTerm, ctx);
      },
    }),

    // ═══ HISTORY TOOLS ═══

    history: tool({
      description: 'Search the full conversation history — including messages that scrolled out of the active window. Use to recall earlier findings, tool results, user instructions, or anything from previous turns.',
      inputSchema: z.object({
        grep: z.string().describe('Text to search for in conversation history'),
      }),
      execute: async ({ grep }: { grep: string }) => searchHistory(sessionId, grep),
    }),

    // ═══ AD BLOCKER ═══

    ad_blocker: tool({
      description: 'Toggle the ad blocker on/off, check status, or add site exceptions.',
      inputSchema: z.object({
        action: z.enum(['on', 'off', 'enable', 'disable', 'status', 'exception']).describe('Action to perform (enable/disable are aliases for on/off)'),
        domain: z.string().optional().describe('Domain for site exception'),
      }),
      execute: async ({ action, domain }: { action: string; domain?: string }) => {
        // BUG-010: map enable/disable aliases to on/off
        const resolvedAction = action === 'enable' ? 'on' : action === 'disable' ? 'off' : action;
        return browserTools.executeBCommand(browserCtx, 'B1', domain ? [resolvedAction, domain] : [resolvedAction]);
      },
    }),

    // ═══ BROWSING HISTORY ═══

    browsing_history: tool({
      description: 'Search, filter, or clear the browser navigation history. Supports grep (case-insensitive title/URL match), domain filter, date range, sort order, and result limit.',
      inputSchema: z.object({
        action: z.enum(['recent', 'search', 'clear']).describe('Action: recent (last entries), search (filter by params), clear (today/week/all)'),
        query: z.string().optional().describe('Search query for URL/title (used when action=search or clear range)'),
        grep: z.string().optional().describe('Case-insensitive filter on title or URL'),
        domain: z.string().optional().describe('Filter by domain (e.g. "github.com")'),
        since: z.string().optional().describe('ISO date — only entries after this date'),
        sort: z.enum(['recent', 'frequent']).optional().describe('Sort by recent (default) or frequent (most visited first)'),
        limit: z.number().optional().describe('Max results to return (default 50)'),
      }),
      execute: async ({ action, query, grep, domain, since, sort, limit }: {
        action: string; query?: string; grep?: string; domain?: string; since?: string; sort?: 'recent' | 'frequent'; limit?: number;
      }) => {
        if (action === 'clear') return browserTools.executeBCommand(browserCtx, 'B3', ['clear', query || 'all']);
        // For 'recent' and 'search' — use queryHistory for rich filtering
        const rows = queryHistory({ grep: grep || query, domain, since, sort, limit: limit || 50 });
        if (rows.length === 0) return 'No history entries found.';
        return rows.map(r =>
          `[${r.visited_at}] (×${r.visit_count}) ${r.title || '(no title)'}\n  ${r.url}`
        ).join('\n\n');
      },
    }),

    // ═══ BOOKMARKS ═══

    browse_bookmarks: tool({
      description: 'Search and filter bookmarks. Grep is case-insensitive and matches title or URL.',
      inputSchema: z.object({
        grep: z.string().optional().describe('Case-insensitive search in title or URL'),
        folder: z.string().optional().describe('Filter by folder name'),
        sort: z.enum(['recent', 'alpha', 'frequent']).optional().describe('Sort: recent (default), alpha, or frequent'),
        limit: z.number().optional().describe('Max results to return (default 50)'),
      }),
      execute: async ({ grep, folder, sort, limit }: {
        grep?: string; folder?: string; sort?: 'recent' | 'alpha' | 'frequent'; limit?: number;
      }) => {
        const rows = queryBookmarks({ grep, folder, sort, limit });
        if (rows.length === 0) return 'No bookmarks found.';
        return rows.map(r =>
          `${r.title || '(no title)'}${r.folder ? ` [${r.folder}]` : ''} (×${r.visit_count})\n  ${r.url}\n  Saved: ${r.created_at}`
        ).join('\n\n');
      },
    }),

    // ═══ DOWNLOADS ═══

    downloads: tool({
      description: 'Check download status, cancel active downloads, or clear completed.',
      inputSchema: z.object({
        action: z.enum(['list', 'cancel', 'clear']).optional().describe('Action (default: list)'),
        id: z.string().optional().describe('Download ID to cancel'),
      }),
      execute: async ({ action, id }: { action?: string; id?: string }) => {
        if (action === 'cancel' && id) return browserTools.executeBCommand(browserCtx, 'B5', ['cancel', id]);
        if (action === 'clear') return browserTools.executeBCommand(browserCtx, 'B5', ['clear']);
        return browserTools.executeBCommand(browserCtx, 'B5', []);
      },
    }),

    // ═══ PASSWORD VAULT ═══

    password_vault: tool({
      description: 'Manage saved passwords. Agent can list domains, list credentials per domain, and trigger autofill but NEVER sees raw passwords.',
      inputSchema: z.object({
        action: z.enum(['list', 'list_credentials', 'autofill', 'generate', 'delete']).describe('list: saved domains. list_credentials: usernames for a domain (no passwords). autofill: fill login on current page. generate: create secure password. delete: remove saved password.'),
        domain: z.string().optional().describe('Domain for autofill or list_credentials'),
        username: z.string().optional().describe('Specific username to autofill (optional — omit to use first/only credential)'),
        id: z.number().optional().describe('Credential ID to delete'),
        length: z.number().optional().describe('Password length for generate'),
      }),
      execute: async ({ action, domain, username, id, length }: { action: string; domain?: string; username?: string; id?: number; length?: number }) => {
        const vault = require('./password-vault');
        switch (action) {
          case 'list': {
            const domains = vault.listSavedDomains();
            return domains.length > 0 ? `Saved passwords for: ${domains.join(', ')}` : 'No saved passwords.';
          }
          case 'list_credentials': {
            // Return usernames for a domain — never passwords
            const targetDomain = domain || (() => {
              try {
                const wc = browserCtx.tabManager.activeWebContents;
                return wc ? new URL(wc.getURL()).hostname : '';
              } catch { return ''; }
            })();
            if (!targetDomain) return 'Need a domain. Pass domain param or navigate to the site first.';
            const creds: Array<{ id: number; username: string; created_at: string }> = vault.listCredentials(targetDomain);
            if (creds.length === 0) return `No credentials saved for ${targetDomain}.`;
            const lines = creds.map((c: { id: number; username: string; created_at: string }, i: number) => `${i + 1}. ${c.username} (ID: ${c.id}, saved ${c.created_at.slice(0, 10)})`);
            return `Credentials for ${targetDomain}:\n${lines.join('\n')}`;
          }
          case 'autofill': {
            if (!domain) return 'Need a domain to autofill.';
            const wc = browserCtx.tabManager.activeWebContents;
            if (!wc) return 'No active tab.';
            const cred = vault.getPasswordForAutofill(domain, username || '');
            if (!cred) return `No credentials found for ${domain}`;
            const script = vault.buildAutofillScript(cred.username, cred.password);
            return await wc.executeJavaScript(script);
          }
          case 'generate':
            return `Generated password: ${vault.generatePassword(length || 20)}`;
          case 'delete':
            if (!id) return 'Need a credential ID to delete.';
            vault.removePassword(id);
            return 'Credential deleted.';
          default:
            return 'Unknown action.';
        }
      },
    }),

    // ═══ TOOL MANAGER (always available) ═══

    register_tool: tool({
      description: 'Register a CLI tool after installing it. The tool will appear in your context every turn and in Settings → Tools. Call this after successful `exec("brew install ...")` or `exec("npm install -g ...")`.',
      inputSchema: z.object({
        name: z.string().describe('Tool name (e.g. "ffmpeg", "vercel")'),
        command: z.string().describe('Actual binary name to run (e.g. "ffmpeg", "vercel")'),
        description: z.string().describe('What the tool does (e.g. "Video/audio processing")'),
        installedVia: z.string().optional().describe('Install command used (e.g. "brew install ffmpeg")'),
        version: z.string().optional().describe('Version string'),
        authStatus: z.string().optional().describe('"ok" if authenticated, "needed" if auth required'),
        account: z.string().optional().describe('Account name if authenticated'),
        notes: z.string().optional().describe('Any extra notes'),
      }),
      execute: async (args: { name: string; command: string; description: string; installedVia?: string; version?: string; authStatus?: string; account?: string; notes?: string }) => {
        const result = toolManager.registerCliTool(args);
        // Notify UI
        try { browserCtx.window.webContents.send('tools:updated', null); } catch {}
        return result;
      },
    }),

    unregister_tool: tool({
      description: 'Remove a CLI tool from the registry.',
      inputSchema: z.object({
        name: z.string().describe('Tool name to remove'),
      }),
      execute: async ({ name }: { name: string }) => {
        const result = toolManager.unregisterCliTool(name);
        try { browserCtx.window.webContents.send('tools:updated', null); } catch {}
        return result;
      },
    }),

    update_tool: tool({
      description: 'Update a registered CLI tool\'s metadata (version, auth status, notes).',
      inputSchema: z.object({
        name: z.string().describe('Tool name'),
        version: z.string().optional(),
        authStatus: z.string().optional(),
        account: z.string().optional(),
        notes: z.string().optional(),
        description: z.string().optional(),
      }),
      execute: async ({ name, ...updates }: { name: string; version?: string; authStatus?: string; account?: string; notes?: string; description?: string }) => {
        return toolManager.updateCliTool(name, updates);
      },
    }),

    list_tools: tool({
      description: 'List all registered CLI tools with their status, version, and auth info.',
      inputSchema: z.object({}),
      execute: async () => toolManager.listCliTools(),
    }),

    verify_tools: tool({
      description: 'Verify all registered CLI tools are still available on PATH. Reports any changes.',
      inputSchema: z.object({}),
      execute: async () => toolManager.verifyAllTools(),
    }),

    // ═══ CRON TOOLS (always available) ═══

    cron_add: tool({
      description: 'Create a scheduled job. The task is a prompt that runs as an isolated agent turn (with full browser/tool access). Schedule kinds: "interval" (every N ms), "daily" (at HH:MM local time), "cron" (5-field cron expression).',
      inputSchema: z.object({
        name: z.string().describe('Human-readable job name'),
        task: z.string().describe('The prompt/task for the agent to execute on each run'),
        schedule: z.object({
          kind: z.enum(['interval', 'cron', 'daily']),
          intervalMs: z.number().optional().describe('For interval: milliseconds between runs'),
          cronExpr: z.string().optional().describe('For cron: 5-field cron expression (min hour dom month dow)'),
          timeOfDay: z.string().optional().describe('For daily: "HH:MM" in local time'),
        }),
      }),
      execute: async ({ name, task, schedule }: { name: string; task: string; schedule: any }) => {
        return cronManager.addJob(name, task, schedule);
      },
    }),

    cron_list: tool({
      description: 'List all scheduled jobs with status, next run, and last result.',
      inputSchema: z.object({}),
      execute: async () => cronManager.listJobs(),
    }),

    cron_update: tool({
      description: 'Update a scheduled job by ID. Can change name, task, schedule, or enabled status.',
      inputSchema: z.object({
        id: z.string().describe('Job ID'),
        name: z.string().optional().describe('New name'),
        task: z.string().optional().describe('New task prompt'),
        enabled: z.boolean().optional().describe('Enable or disable the job'),
        schedule: z.object({
          kind: z.enum(['interval', 'cron', 'daily']),
          intervalMs: z.number().optional(),
          cronExpr: z.string().optional(),
          timeOfDay: z.string().optional(),
        }).optional().describe('New schedule'),
      }),
      execute: async ({ id, ...updates }: { id: string; name?: string; task?: string; enabled?: boolean; schedule?: any }) => {
        return cronManager.updateJob(id, updates);
      },
    }),

    cron_delete: tool({
      description: 'Delete a scheduled job by ID.',
      inputSchema: z.object({
        id: z.string().describe('Job ID to delete'),
      }),
      execute: async ({ id }: { id: string }) => {
        return cronManager.deleteJob(id);
      },
    }),

    // ═══ CONVERSATION TOOLS (Phase 8.35.4) ═══

    conversations_list: tool({
      description: 'List recent Aria conversations. Returns titles, dates, and previews. Use grep to filter by title or preview text.',
      inputSchema: z.object({
        limit: z.number().optional().describe('Max conversations to return (default 20)'),
        grep: z.string().optional().describe('Filter by title or preview text'),
      }),
      execute: async ({ limit, grep }: { limit?: number; grep?: string }) =>
        agentListConversations(limit || 20, grep),
    }),

    conversations_search: tool({
      description: 'Full-text search across all Aria conversation messages. Returns matching snippets with ±2 messages context. Use conversations_read to get more context.',
      inputSchema: z.object({
        grep: z.string().describe('Text to search for across all conversations'),
        conversation_id: z.string().optional().describe('Scope search to a specific conversation ID'),
        limit: z.number().optional().describe('Max results (default 20)'),
      }),
      execute: async ({ grep, conversation_id, limit }: { grep: string; conversation_id?: string; limit?: number }) =>
        agentSearchConversations(grep, conversation_id, limit || 20),
    }),

    conversations_read: tool({
      description: 'Read messages from a specific conversation. Returns up to 20 messages per call (each truncated to ~500 chars). Use offset to paginate. Use grep to filter within the conversation.',
      inputSchema: z.object({
        conversation_id: z.string().describe('Conversation ID (from conversations_list or conversations_search)'),
        offset: z.number().optional().describe('Message index to start from (default 0)'),
        limit: z.number().optional().describe('Max messages (default 20, max 20)'),
        grep: z.string().optional().describe('Filter messages within this conversation'),
      }),
      execute: async ({ conversation_id, offset, limit, grep }: { conversation_id: string; offset?: number; limit?: number; grep?: string }) =>
        agentReadConversation(conversation_id, offset || 0, limit || 20, grep),
    }),

    // ═══ MEDIA TOOLS (Phase 8.5 — always available) ═══
    ...createMediaTools(browserCtx),

    // ═══ SHELL TOOLS (Developer Mode only — conditionally included) ═══
    ...(options?.developerMode ? createShellTools(sessionId, browserCtx, options.llmConfig) : {}),

    // ═══ TEAM TOOLS (Coding Mode + Developer Mode — conditionally included) ═══
    ...(options?.developerMode && options?.codingMode
      ? createTeamTools(sessionId, browserCtx, options.llmConfig, options.teamId, options.agentName, options.worktreeIsolation)
      : {}),

    // ═══ WORKTREE TOOLS (Phase 8.39 — Coding Mode + Developer Mode + git repo) ═══
    ...(options?.developerMode && options?.codingMode
      ? createWorktreeTools(options.repoPath)
      : {}),

    // ═══ BROWSING DATA TOOLS (Privacy gate — only when agentBrowsingDataAccess is ON) ═══
    ...(options?.agentBrowsingDataAccess ? createBrowsingDataTools() : {}),

    // ═══ PROJECT TOOLS (Coding Mode only — Phase 9.07) ═══
    ...(options?.codingMode ? createProjectTools(options?.conversationId) : {}),

    // ═══ CODING MEMORY TOOLS (Coding Mode only — Phase coding-memory) ═══
    ...(options?.codingMode ? createCodingMemoryTools() : {}),

    // ═══ USER PROFILE (Phase 9.096c — always available) ═══

    update_user_profile: tool({
      description: 'Read or update the user\'s personal profile. Use when the user says "remember that...", "I prefer...", "add to my profile...". The profile persists across sessions and is included in every conversation. Read first before updating to avoid duplicates.',
      inputSchema: z.object({
        action: z.enum(['read', 'update', 'append']).describe('read: return current profile text. update: replace the full profile (for restructuring). append: add new lines to the end.'),
        text: z.string().optional().describe('For update/append: the text to write/append. Ignored for read.'),
      }),
      execute: async ({ action, text }: { action: 'read' | 'update' | 'append'; text?: string }) => {
        if (action === 'read') {
          const profile = loadUserProfileTxt();
          if (!profile) return { profile: '', empty: true, hint: 'No profile yet. The user can write one in Settings → My Profile, or you can create one with append/update.' };
          const wordCount = profile.split(/\s+/).filter(Boolean).length;
          return { profile, wordCount };
        }

        if (!text) return { error: 'Missing text for ' + action + ' action.' };

        if (action === 'append') {
          const current = loadUserProfileTxt();
          const updated = current ? current.trimEnd() + '\n' + text : text;
          const result = saveUserProfileTxt(updated);
          if (!result.success) return { error: result.error };
          // Notify settings UI
          try { browserCtx.window?.webContents.send('user-profile:updated', updated); } catch {}
          return { success: true, wordCount: result.wordCount };
        }

        if (action === 'update') {
          const result = saveUserProfileTxt(text);
          if (!result.success) return { error: result.error };
          try { browserCtx.window?.webContents.send('user-profile:updated', text); } catch {}
          return { success: true, wordCount: result.wordCount };
        }

        return { error: 'Invalid action.' };
      },
    }),

    // ═══ DOWNLOAD TOOLS (Phase 9.07 Track 5 — always available) ═══

    present_download: tool({
      description: 'Offer a file as a download card in the chat UI. Use this after creating a document, report, or export so the user can download it in multiple formats without leaving the chat.',
      inputSchema: z.object({
        path: z.string().describe('File path (absolute or relative to ~/tappi-workspace/)'),
        description: z.string().optional().describe('What the file is, e.g. "Competitive analysis report"'),
        formats: z.array(z.string()).optional().describe('Override auto-detected formats, e.g. ["md", "html", "pdf"]'),
      }),
      execute: async ({ path: filePath, description, formats }: {
        path: string; description?: string; formats?: string[];
      }) => {
        const fs = await import('fs');
        const pathMod = await import('path');
        const os = await import('os');

        // Resolve relative paths against ~/tappi-workspace/
        let resolved = filePath;
        if (!filePath.startsWith('/') && !filePath.startsWith('~')) {
          resolved = pathMod.join(os.homedir(), 'tappi-workspace', filePath);
        } else if (filePath.startsWith('~/')) {
          resolved = pathMod.join(os.homedir(), filePath.slice(2));
        }

        if (!fs.existsSync(resolved)) {
          return `❌ File not found: ${resolved}`;
        }

        const stat = fs.statSync(resolved);
        const name = pathMod.basename(resolved);
        const ext = pathMod.extname(name).toLowerCase().slice(1);
        const size = stat.size;

        // Determine available formats from extension
        let availableFormats = formats;
        if (!availableFormats) {
          switch (ext) {
            case 'md':   availableFormats = ['md', 'html', 'pdf', 'txt']; break;
            case 'html': availableFormats = ['html', 'pdf', 'txt']; break;
            case 'csv':  availableFormats = ['csv']; break;
            case 'json': availableFormats = ['json', 'txt']; break;
            case 'png': case 'jpg': case 'jpeg': case 'gif': case 'svg':
              availableFormats = [ext]; break;
            case 'pdf':  availableFormats = ['pdf']; break;
            default:     availableFormats = [ext || 'bin']; break;
          }
        }

        const payload = { path: resolved, name, size, formats: availableFormats, description };

        // Emit to main window (sidebar panel / app.js)
        try { browserCtx.window.webContents.send('agent:present-download', payload); } catch {}
        // Emit to Aria tab (full chat UI / aria.js)
        try {
          const ariaWC = (browserCtx.tabManager as any).ariaWebContents;
          if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('agent:present-download', payload);
        } catch {}

        return `📎 File offered for download: ${name}`;
      },
    }),
  };
}

/**
 * Shell tools — only created when Developer Mode is ON.
 * When OFF, these tool schemas are not sent to the LLM at all.
 */
function createShellTools(sessionId: string, browserCtx: BrowserContext, llmConfig?: LLMConfig) {
  return {
    exec: tool({
      description: 'Run a shell command. Output is captured — you see first 20 + last 20 lines. Use exec_grep to search full output. Default timeout: 30s. Default cwd: ~/tappi-workspace/.',
      inputSchema: z.object({
        command: z.string().describe('Shell command to run'),
        cwd: z.string().optional().describe('Working directory (default: ~/tappi-workspace/)'),
        timeout: z.number().optional().describe('Timeout in milliseconds (default: 30000)'),
      }),
      execute: async ({ command, cwd, timeout }: { command: string; cwd?: string; timeout?: number }) => {
        return shellTools.shellExec(sessionId, command, { cwd, timeout });
      },
    }),

    exec_bg: tool({
      description: 'Run a command in the background (servers, watchers, builds). Returns a PID. Check with exec_status, stop with exec_kill.',
      inputSchema: z.object({
        command: z.string().describe('Shell command to run in background'),
        cwd: z.string().optional().describe('Working directory'),
      }),
      execute: async ({ command, cwd }: { command: string; cwd?: string }) => {
        return shellTools.shellExecBg(sessionId, command, { cwd });
      },
    }),

    exec_status: tool({
      description: 'Check a background process. Shows if running, uptime, and recent output (truncated).',
      inputSchema: z.object({
        pid: z.number().optional().describe('Process ID from exec_bg'),
        id: z.number().optional().describe('Alias for pid — accepts either'),
      }),
      execute: async ({ pid, id }: { pid?: number; id?: number }) => {
        const resolvedPid = pid ?? id;
        if (resolvedPid === undefined) return '❌ Provide pid or id.';
        return shellTools.shellExecStatus(sessionId, resolvedPid);
      },
    }),

    exec_kill: tool({
      description: 'Kill a background process by PID.',
      inputSchema: z.object({
        pid: z.number().optional().describe('Process ID to kill'),
        id: z.number().optional().describe('Alias for pid — accepts either'),
      }),
      execute: async ({ pid, id }: { pid?: number; id?: number }) => {
        const resolvedPid = pid ?? id;
        if (resolvedPid === undefined) return '❌ Provide pid or id.';
        return shellTools.shellExecKill(resolvedPid);
      },
    }),

    exec_grep: tool({
      description: 'Search command output. Default: searches last command. Use id for a specific output (number like 7, or string like "out-7"), all:true for all outputs in session. Returns matching lines with context.',
      inputSchema: z.object({
        pattern: z.string().describe('Text to search for (case-insensitive)'),
        id: z.union([z.number(), z.string()]).optional().describe('Specific output ID — numeric (7) or string ("out-7")'),
        all: z.boolean().optional().describe('Search all outputs in this session'),
        context: z.number().optional().describe('Lines of context around matches (default 2)'),
      }),
      execute: async ({ pattern, id, all, context }: { pattern: string; id?: number | string; all?: boolean; context?: number }) => {
        // BUG-T5B: resolve "out-N" string format to numeric id
        let numericId: number | undefined;
        if (typeof id === 'string') {
          const m = id.match(/^out-(\d+)$/);
          numericId = m ? parseInt(m[1], 10) : undefined;
        } else {
          numericId = id;
        }
        return shellTools.shellExecGrep(sessionId, pattern, { id: numericId, all, context });
      },
    }),

    exec_list: tool({
      description: 'List all command outputs in this session with their IDs, status, and size.',
      inputSchema: z.object({}),
      execute: async () => shellTools.shellExecList(sessionId),
    }),

    // ═══ SUB-AGENT (requires shell/dev mode) ═══

    spawn_agent: tool({
      description: 'Spawn a sub-agent for a complex or parallel task. Inherits your model, tools, and dev mode access. Gets its own conversation. Max 3 concurrent. Check status with sub_agent_status. Use model="primary" for critical sub-agents that need full reasoning.',
      inputSchema: z.object({
        task: z.string().describe('Clear, self-contained task description for the sub-agent'),
        model: z.enum(['primary', 'secondary']).optional().describe('Model tier: "secondary" (default, faster/cheaper) or "primary" (full reasoning for critical tasks)'),
      }),
      execute: async ({ task, model }: { task: string; model?: 'primary' | 'secondary' }) => {
        if (!llmConfig) return '❌ No LLM config available for sub-agent.';
        // Block sub-agents when a team is active — use team_run_teammate instead
        const activeTeam = teamManager.getActiveTeamId();
        if (activeTeam) return '❌ You have an active team ("' + activeTeam + '"). Use team_run_teammate to assign work to teammates — they have worktree isolation and contract enforcement. spawn_agent is for non-coding tasks only.';
        return subAgent.spawnSubAgent(task, browserCtx, llmConfig, sessionId, model || 'secondary');
      },
    }),

    sub_agent_status: tool({
      description: 'Check sub-agent status. No id = list all. With id = detailed status + result.',
      inputSchema: z.object({
        id: z.string().optional().describe('Sub-agent ID (e.g. "sub-1")'),
      }),
      execute: async ({ id }: { id?: string }) => subAgent.getSubAgentStatus(id),
    }),
  };
}

/**
 * Team tools — only created when Coding Mode + Developer Mode are both ON.
 * Lead gets all 6 tools. Teammates get 4 (no create/dissolve).
 */
function createTeamTools(
  sessionId: string,
  browserCtx: BrowserContext,
  llmConfig?: LLMConfig,
  teamId?: string,
  agentName?: string,
  worktreeIsolation?: boolean,
) {
  const isTeammate = !!agentName && agentName !== '@lead';

  // ─── Helper: resolve team ID ───
  // MUST call getActiveTeamId() dynamically — NOT cache at tool-creation time.
  // The lead creates the team AFTER tools are registered, so a cached value would be stale (null).
  function resolveTeamId(provided?: string): string | null {
    return provided || teamId || teamManager.getActiveTeamId();
  }

  // ─── Helper: broadcast team status to both chrome and Aria webContents ───
  function broadcastTeamUpdate(): void {
    try {
      const status = teamManager.getTeamStatusUI();
      try { browserCtx.window.webContents.send('team:updated', status); } catch {}
      try {
        const aw = (browserCtx.tabManager as any).ariaWebContents;
        if (aw && !aw.isDestroyed()) aw.send('team:updated', status);
      } catch {}
    } catch {}
  }

  const tools: Record<string, any> = {

    // ─── Available to all (lead + teammates) ───

    team_status: tool({
      description: 'Get team overview: teammates status, task list, recent messages, file conflicts.',
      inputSchema: z.object({
        team_id: z.string().optional().describe('Team ID (default: active team)'),
      }),
      execute: async ({ team_id }: { team_id?: string }) => {
        const tid = resolveTeamId(team_id);
        if (!tid) return '❌ No active team. Use team_create to start one.';
        return teamManager.getTeamStatus(tid);
      },
    }),

    team_message: tool({
      description: 'Send a message to a teammate (@name) or everyone (@all).',
      inputSchema: z.object({
        to: z.string().describe('Recipient: "@backend", "@frontend", "@lead", "@all"'),
        content: z.string().describe('Message content'),
        team_id: z.string().optional().describe('Team ID (default: active team)'),
      }),
      execute: async ({ to, content, team_id }: { to: string; content: string; team_id?: string }) => {
        const tid = resolveTeamId(team_id);
        if (!tid) return '❌ No active team.';
        const from = agentName || '@lead';
        return mailbox.sendMessage(tid, from, to, content);
      },
    }),

    team_task_update: tool({
      description: 'Update a task status, result, or files touched. Use when starting (in-progress), finishing (done), or getting blocked.',
      inputSchema: z.object({
        task_id: z.string().describe('Task ID (e.g. "task-1")'),
        status: z.enum(['pending', 'in-progress', 'done', 'blocked']).optional(),
        result: z.string().optional().describe('Completion summary (for done status)'),
        files_touched: z.array(z.string()).optional().describe('Files you modified'),
        blocked_by: z.string().optional().describe('Why you\'re blocked'),
        team_id: z.string().optional().describe('Team ID (default: active team)'),
      }),
      execute: async ({ task_id, status, result, files_touched, blocked_by, team_id }: {
        task_id: string; status?: any; result?: string; files_touched?: string[]; blocked_by?: string; team_id?: string;
      }) => {
        const tid = resolveTeamId(team_id);
        if (!tid) return '❌ No active team.';
        const { message, conflicts } = taskList.updateTask(tid, task_id, {
          status,
          result,
          files_touched,
          blockedBy: blocked_by,
        });
        broadcastTeamUpdate();
        if (conflicts.length > 0) {
          const conflictLines = conflicts.map(c =>
            `⚠️ File conflict: ${c.file} touched by ${c.taskTitles.join(' and ')}`
          ).join('\n');
          return `${message}\n\n${conflictLines}`;
        }
        return message;
      },
    }),

    team_task_add: tool({
      description: 'Add a new task to the team\'s shared task list.',
      inputSchema: z.object({
        title: z.string().describe('Short task title'),
        description: z.string().describe('Detailed task description'),
        assignee: z.string().optional().describe('Who should do this (@backend, @frontend, etc.)'),
        dependencies: z.array(z.string()).optional().describe('Task IDs that must complete first'),
        team_id: z.string().optional().describe('Team ID (default: active team)'),
      }),
      execute: async ({ title, description, assignee, dependencies, team_id }: {
        title: string; description: string; assignee?: string; dependencies?: string[]; team_id?: string;
      }) => {
        const tid = resolveTeamId(team_id);
        if (!tid) return '❌ No active team.';
        const from = agentName || '@lead';
        const task = taskList.createTask(tid, { title, description, assignee, dependencies, created_by: from });
        broadcastTeamUpdate();
        return `✓ Task "${task.id}" created: ${task.title} (status: ${task.status})`;
      },
    }),
  };

  // ─── Lead-only tools ───
  if (!isTeammate) {
    tools.team_create = tool({
      description: 'Create a coding team. Decomposes the task, spawns teammates who work in parallel. Only the lead (you) can create teams. When working_dir is a git repo and worktree_isolation is enabled, each teammate gets its own isolated git worktree (separate branch + directory) preventing file conflicts.',
      inputSchema: z.object({
        task: z.string().describe('High-level task description'),
        working_dir: z.string().describe('Project root directory (e.g. ~/projects/myapp)'),
        teammates: z.array(z.object({
          name: z.string().describe('Agent name starting with @ (e.g. "@backend")'),
          role: z.string().describe('Role description'),
          model: z.string().optional().describe('Optional: use a different/cheaper model for this teammate'),
        })).optional().describe('Teammate configs. If omitted, auto-determined from task.'),
        model: z.string().optional().describe('Model for all teammates (default: same as lead)'),
        worktree_isolation: z.boolean().optional().describe('Phase 8.39: Give each teammate an isolated git worktree (default: true when working_dir is a git repo). Set false to share the working directory.'),
      }),
      execute: async ({ task, working_dir, teammates, model, worktree_isolation }: {
        task: string; working_dir: string;
        teammates?: Array<{ name: string; role: string; model?: string }>;
        model?: string;
        worktree_isolation?: boolean;
      }) => {
        if (!llmConfig) return '❌ No LLM config available.';
        const tmConfigs = teammates?.map(t => ({
          ...t,
          model: t.model || model,
        }));
        // Use tool param if provided, otherwise fall back to registry option (from config)
        const useWorktrees = worktree_isolation ?? worktreeIsolation ?? true;
        const aw = (browserCtx.tabManager as any).ariaWebContents ?? null;
        const { teamId, summary } = await teamManager.createTeam(
          task, working_dir, browserCtx, llmConfig, tmConfigs, useWorktrees, aw
        );
        try { browserCtx.window.webContents.send('team:updated', teamManager.getTeamStatusUI()); } catch {}
        try { const aw = browserCtx.tabManager.ariaWebContents; if (aw && !aw.isDestroyed()) aw.send('team:updated', teamManager.getTeamStatusUI()); } catch {}
        return summary;
      },
    });

    tools.team_run_teammate = tool({
      description: 'Assign a task to a teammate and start their session.',
      inputSchema: z.object({
        teammate_name: z.string().describe('Teammate name (e.g. "@backend")'),
        task: z.string().describe('Task description for this teammate'),
        team_id: z.string().optional().describe('Team ID (default: active team)'),
      }),
      execute: async ({ teammate_name, task, team_id }: {
        teammate_name: string; task: string; team_id?: string;
      }) => {
        const tid = resolveTeamId(team_id);
        if (!tid) return '❌ No active team.';
        if (!llmConfig) return '❌ No LLM config available.';
        const team = teamManager.getTeam(tid);
        if (!team) return `❌ Team "${tid}" not found.`;
        const teammate = team.teammates.get(teammate_name);
        if (!teammate) return `❌ Teammate "${teammate_name}" not found in team "${tid}".`;
        const aw = (browserCtx.tabManager as any).ariaWebContents ?? null;
        const result = await teamManager.runTeammate({ teammate, teamId: tid, task, browserCtx, llmConfig, ariaWebContents: aw });
        broadcastTeamUpdate();
        return result;
      },
    });

    tools.team_dissolve = tool({
      description: 'End the team session. Compiles final report, shuts down all teammates. Only the lead can dissolve a team. Run team_validate first to check integration.',
      inputSchema: z.object({
        team_id: z.string().optional().describe('Team ID (default: active team)'),
      }),
      execute: async ({ team_id }: { team_id?: string }) => {
        const tid = resolveTeamId(team_id);
        if (!tid) return '❌ No active team.';
        const result = await teamManager.dissolveTeam(tid);
        try { browserCtx.window.webContents.send('team:updated', null); } catch {}
        try { const aw = browserCtx.tabManager.ariaWebContents; if (aw && !aw.isDestroyed()) aw.send('team:updated', null); } catch {}
        return result;
      },
    });

    // ─── Phase 9.096: Contract-First Tools (Lead only) ───

    tools.team_write_contracts = tool({
      description: 'Write a shared contract/interface stub file that all teammates must reference. Call this BEFORE team_run_teammate. Contracts define the shared API surface: type definitions, interfaces, function signatures, data shapes. Max 5 per phase. Teammates receive these in their system prompt and must import/use them — not redefine their own versions.',
      inputSchema: z.object({
        path: z.string().describe('Relative path from working dir (e.g. "contracts/types.ts", "shared/api.py", "interfaces/cart.go")'),
        content: z.string().describe('Contract file content — type defs, interfaces, function stubs. Keep it lean (~20 lines per file). NO implementations, just signatures and shapes.'),
        description: z.string().describe('What this contract defines (e.g. "Cart data types and API function signatures")'),
        team_id: z.string().optional().describe('Team ID (default: active team)'),
      }),
      execute: async ({ path: filePath, content, description, team_id }: {
        path: string; content: string; description: string; team_id?: string;
      }) => {
        const tid = resolveTeamId(team_id);
        if (!tid) return '❌ No active team. Use team_create first.';
        const result = teamManager.writeContract(tid, filePath, content, description);
        broadcastTeamUpdate();
        return result;
      },
    });

    tools.team_validate = tool({
      description: 'Run post-merge integration validation. Checks: (1) all contracts are referenced by teammate code, (2) no file conflicts between teammates, (3) optionally runs a build/test command. Call this AFTER teammates finish and worktrees are merged, BEFORE team_dissolve.',
      inputSchema: z.object({
        command: z.string().optional().describe('Build/test command to run (e.g. "npm run build", "python -m pytest", "go build ./..."). Runs in the working directory with 60s timeout.'),
        team_id: z.string().optional().describe('Team ID (default: active team)'),
      }),
      execute: async ({ command, team_id }: { command?: string; team_id?: string }) => {
        const tid = resolveTeamId(team_id);
        if (!tid) return '❌ No active team.';
        return teamManager.validateIntegration(tid, command);
      },
    });

    tools.team_advance_phase = tool({
      description: 'Advance to the next phase after merging current phase results. Later phases build on real merged code — write new contracts that reference the actual implementations from the previous phase. Use this for large projects that need multiple rounds of parallel work.',
      inputSchema: z.object({
        team_id: z.string().optional().describe('Team ID (default: active team)'),
      }),
      execute: async ({ team_id }: { team_id?: string }) => {
        const tid = resolveTeamId(team_id);
        if (!tid) return '❌ No active team.';
        return teamManager.advancePhase(tid);
      },
    });
  }

  return tools;
}

/**
 * Worktree tools — Phase 8.39. Created when Coding Mode + Developer Mode are ON.
 * Requires a git repository as the working directory.
 * Gated lazily: if repoPath is not a git repo, tools return an informative error.
 */
function createWorktreeTools(repoPath?: string) {
  // Lazy-resolve manager per invocation so the active team's working dir is always used
  function getManager(providedPath?: string): WorktreeManager | null {
    const p = providedPath || repoPath || teamManager.getActiveTeam()?.workingDir;
    if (!p) return null;
    return createWorktreeManager(p);
  }

  function activeRepoPath(): string | undefined {
    return repoPath || teamManager.getActiveTeam()?.workingDir;
  }

  return {
    worktree_create: tool({
      description: 'Create an isolated git worktree for a teammate or standalone session. Each worktree gets its own branch (wt-<name>), allowing parallel file editing without conflicts.',
      inputSchema: z.object({
        name: z.string().describe('Worktree name (e.g. "backend" or "@frontend"). Auto-strips @ prefix.'),
        base_branch: z.string().optional().describe('Base branch to fork from (default: default remote branch like main/master).'),
        repo_path: z.string().optional().describe('Repo root path (default: active team working dir or current dir).'),
      }),
      execute: async ({ name, base_branch, repo_path }: { name: string; base_branch?: string; repo_path?: string }) => {
        const mgr = getManager(repo_path);
        if (!mgr) return '❌ Not a git repository. Worktree isolation unavailable. Use a git repo as the working directory.';
        try {
          const wt = await mgr.createWorktree({ name, baseBranch: base_branch });
          return `✓ Worktree created: "${wt.name}"\n  Path: ${wt.path}\n  Branch: ${wt.branch}\n  Base: ${wt.baseBranch}`;
        } catch (e: any) {
          return `❌ Failed to create worktree: ${e?.message || e}`;
        }
      },
    }),

    worktree_list: tool({
      description: 'List all active Tappi-managed git worktrees in the repository.',
      inputSchema: z.object({
        repo_path: z.string().optional().describe('Repo root path (default: active team working dir).'),
      }),
      execute: async ({ repo_path }: { repo_path?: string }) => {
        const mgr = getManager(repo_path);
        if (!mgr) return '❌ Not a git repository. Worktree isolation unavailable.';
        const list = mgr.listWorktrees();
        if (list.length === 0) return 'No Tappi-managed worktrees found.';
        return list.map(wt =>
          `**${wt.name}** [${wt.status}]\n  Branch: ${wt.branch}\n  Base: ${wt.baseBranch}\n  Path: ${wt.path}\n  Created: ${wt.createdAt}`
        ).join('\n\n');
      },
    }),

    worktree_merge: tool({
      description: 'Merge a worktree branch back into the base branch (default: squash merge for clean history).',
      inputSchema: z.object({
        name: z.string().describe('Worktree name to merge (e.g. "backend").'),
        strategy: z.enum(['merge', 'squash', 'cherry-pick']).optional().describe('Merge strategy: squash (default, clean history), merge (fast-forward/3-way), cherry-pick (individual commits).'),
        message: z.string().optional().describe('Commit message for the merge (default: auto-generated).'),
        repo_path: z.string().optional().describe('Repo root path (default: active team working dir).'),
      }),
      execute: async ({ name, strategy, message, repo_path }: { name: string; strategy?: 'merge' | 'squash' | 'cherry-pick'; message?: string; repo_path?: string }) => {
        const mgr = getManager(repo_path);
        if (!mgr) return '❌ Not a git repository.';
        const result = await mgr.mergeWorktree(name, { strategy: strategy || 'squash', message });
        return result.message;
      },
    }),

    worktree_remove: tool({
      description: 'Remove a git worktree and its branch. By default, fails if there are uncommitted changes.',
      inputSchema: z.object({
        name: z.string().describe('Worktree name to remove (e.g. "backend").'),
        force: z.boolean().optional().describe('Force removal even with uncommitted changes (default: false).'),
        repo_path: z.string().optional().describe('Repo root path (default: active team working dir).'),
      }),
      execute: async ({ name, force, repo_path }: { name: string; force?: boolean; repo_path?: string }) => {
        const mgr = getManager(repo_path);
        if (!mgr) return '❌ Not a git repository.';
        const result = await mgr.removeWorktree(name, { force: force || false });
        return result.message;
      },
    }),

    worktree_status: tool({
      description: 'Show git status and recent commits in a specific worktree.',
      inputSchema: z.object({
        name: z.string().describe('Worktree name (e.g. "backend").'),
        repo_path: z.string().optional().describe('Repo root path (default: active team working dir).'),
      }),
      execute: async ({ name, repo_path }: { name: string; repo_path?: string }) => {
        const mgr = getManager(repo_path);
        if (!mgr) return '❌ Not a git repository.';
        return mgr.worktreeStatus(name);
      },
    }),

    worktree_diff: tool({
      description: 'Show the diff between a worktree branch and its base branch. Useful to review changes before merging.',
      inputSchema: z.object({
        name: z.string().describe('Worktree name (e.g. "backend").'),
        repo_path: z.string().optional().describe('Repo root path (default: active team working dir).'),
      }),
      execute: async ({ name, repo_path }: { name: string; repo_path?: string }) => {
        const mgr = getManager(repo_path);
        if (!mgr) return '❌ Not a git repository.';
        return mgr.worktreeDiff(name);
      },
    }),
  };
}

/**
 * Media tools (Phase 8.5) — mpv overlay control.
 * Always available; gracefully degrades when mpv is not installed.
 */
function createMediaTools(browserCtx: BrowserContext) {
  function getActiveTabId(): string | null {
    return browserCtx.tabManager.activeTabId;
  }

  return {
    media_status: tool({
      description: 'Get current media playback status: playing/paused, position, duration, quality, whether mpv overlay is active.',
      inputSchema: z.object({}),
      execute: async () => {
        const tabId = getActiveTabId();
        if (!tabId) return JSON.stringify({ error: 'No active tab' });
        const result = await browserCtx.window.webContents.executeJavaScript(
          `(async () => { try { return await require("electron").ipcRenderer.invoke("media:status", "${tabId}"); } catch(e) { return null; } })()`
        ).catch(() => null);
        // Call via IPC handle
        const { mediaStatus } = require('./media-engine');
        const status = await mediaStatus(tabId);
        return JSON.stringify(status, null, 2);
      },
    }),

    media_toggle: tool({
      description: 'Toggle mpv overlay on/off for the current tab. When ON: extracts stream via yt-dlp and renders via mpv with reference-quality settings. When OFF: restores browser native playback.',
      inputSchema: z.object({}),
      execute: async () => {
        const tabId = getActiveTabId();
        if (!tabId) return '❌ No active tab';
        const { toggleOverlay } = require('./media-engine');
        const result = await toggleOverlay(tabId);
        if (result.success) {
          return result.active
            ? '🎬 mpv overlay activated — rendering with reference-quality settings'
            : '⏹ mpv overlay deactivated — browser native playback restored';
        }
        return `❌ Failed: ${result.error}`;
      },
    }),

    media_quality: tool({
      description: 'Set video quality preference for mpv overlay. Takes effect on next video load.',
      inputSchema: z.object({
        quality: z.enum(['best', '1080p', '720p', '480p']).describe('Quality preference'),
      }),
      execute: async ({ quality }: { quality: 'best' | '1080p' | '720p' | '480p' }) => {
        const tabId = getActiveTabId();
        if (!tabId) return '❌ No active tab';
        const { setQuality } = require('./media-engine');
        setQuality(tabId, quality);
        return `✓ Quality set to ${quality} (takes effect on next video load)`;
      },
    }),

    media_seek: tool({
      description: 'Seek to a position in the current mpv video. Use seconds (e.g. 90) or percentage 0.0-1.0 (e.g. 0.5 = 50%).',
      inputSchema: z.object({
        position: z.number().describe('Position in seconds (integer) or 0.0–1.0 for percentage'),
      }),
      execute: async ({ position }: { position: number }) => {
        const tabId = getActiveTabId();
        if (!tabId) return '❌ No active tab';
        const { mediaSeek } = require('./media-engine');
        return mediaSeek(tabId, position);
      },
    }),

    media_volume: tool({
      description: 'Set mpv playback volume. Range: 0–100 (or 0–200 for amplification).',
      inputSchema: z.object({
        volume: z.number().describe('Volume level 0-100'),
      }),
      execute: async ({ volume }: { volume: number }) => {
        const tabId = getActiveTabId();
        if (!tabId) return '❌ No active tab';
        const { mediaVolume } = require('./media-engine');
        return mediaVolume(tabId, volume);
      },
    }),
  };
}

/**
 * Browsing data tools — only created when agentBrowsingDataAccess is ON in privacy settings.
 * Gives the agent greppable, filterable access to history, bookmarks, and downloads.
 */
function createBrowsingDataTools() {
  return {
    browse_history: tool({
      description: 'Search and filter the browser navigation history. Grep is case-insensitive and matches title or URL. Sort by "recent" (default) or "frequent" (most visited first).',
      inputSchema: z.object({
        grep: z.string().optional().describe('Case-insensitive search in title or URL'),
        since: z.string().optional().describe('ISO date string — only entries after this date'),
        until: z.string().optional().describe('ISO date string — only entries before this date'),
        domain: z.string().optional().describe('Filter by domain (e.g. "github.com")'),
        limit: z.number().optional().describe('Max results to return (default 50)'),
        sort: z.enum(['recent', 'frequent']).optional().describe('Sort order: recent (default) or frequent'),
      }),
      execute: async ({ grep, since, until, domain, limit, sort }: {
        grep?: string; since?: string; until?: string; domain?: string; limit?: number; sort?: 'recent' | 'frequent';
      }) => {
        const rows = queryHistory({ grep, since, until, domain, limit, sort });
        if (rows.length === 0) return 'No history entries found.';
        return rows.map(r =>
          `[${r.visited_at}] (×${r.visit_count}) ${r.title || '(no title)'}\n  ${r.url}`
        ).join('\n\n');
      },
    }),

    browse_bookmarks: tool({
      description: 'Search and filter bookmarks. Grep is case-insensitive and matches title or URL.',
      inputSchema: z.object({
        grep: z.string().optional().describe('Case-insensitive search in title or URL'),
        folder: z.string().optional().describe('Filter by folder name'),
        sort: z.enum(['recent', 'alpha', 'frequent']).optional().describe('Sort: recent (default), alpha, or frequent'),
        limit: z.number().optional().describe('Max results to return (default 50)'),
      }),
      execute: async ({ grep, folder, sort, limit }: {
        grep?: string; folder?: string; sort?: 'recent' | 'alpha' | 'frequent'; limit?: number;
      }) => {
        const rows = queryBookmarks({ grep, folder, sort, limit });
        if (rows.length === 0) return 'No bookmarks found.';
        return rows.map(r =>
          `${r.title || '(no title)'}${r.folder ? ` [${r.folder}]` : ''} (×${r.visit_count})\n  ${r.url}\n  Saved: ${r.created_at}`
        ).join('\n\n');
      },
    }),

    browse_downloads: tool({
      description: 'Search and filter download history. Grep is case-insensitive and matches filename or URL. Type filters by file extension (e.g. "pdf", "mp4", ".zip").',
      inputSchema: z.object({
        grep: z.string().optional().describe('Case-insensitive search in filename or URL'),
        since: z.string().optional().describe('ISO date string — only downloads after this date'),
        type: z.string().optional().describe('File extension filter, e.g. "pdf", ".mp4", "zip"'),
        limit: z.number().optional().describe('Max results to return (default 50)'),
      }),
      execute: async ({ grep, since, type, limit }: {
        grep?: string; since?: string; type?: string; limit?: number;
      }) => {
        const rows = queryDownloads({ grep, since, type, limit });
        if (rows.length === 0) return 'No downloads found.';
        return rows.map(r => {
          const size = r.size > 0
            ? r.size < 1024 * 1024 ? `${(r.size / 1024).toFixed(1)} KB`
              : `${(r.size / (1024 * 1024)).toFixed(1)} MB`
            : 'size unknown';
          return `${r.filename} (${size}, ${r.status})\n  ${r.created_at}\n  From: ${r.url}\n  Saved: ${r.path}`;
        }).join('\n\n');
      },
    }),
  };
}

/**
 * Project tools — Phase 9.07. Only available when Coding Mode is ON.
 * Provides CRUD for projects, artifact tracking, and conversation search within a project.
 * Bug 4 fix: accepts conversationId for auto-linking and project_link_conversation tool.
 */
function createProjectTools(conversationId?: string) {
  return {
    project_create: tool({
      description: 'Create a new project to group related coding conversations. Detects project name from package.json, Cargo.toml, go.mod, or pyproject.toml if not provided.',
      inputSchema: z.object({
        working_dir: z.string().describe('Absolute path to the project root directory'),
        name: z.string().optional().describe('Project name (auto-detected from manifests if omitted)'),
        description: z.string().optional().describe('Short description of the project'),
      }),
      execute: async ({ working_dir, name, description }: { working_dir: string; name?: string; description?: string }) => {
        try {
          const resolvedName = name || projectManager.detectProjectName(working_dir);
          const project = projectManager.createProject(resolvedName, working_dir, description);
          // Bug 4a fix: auto-link current conversation to the newly created project
          let linkNote = '';
          if (conversationId) {
            try {
              projectManager.linkConversation(conversationId, project.id);
              linkNote = '\n  ✓ Current conversation linked to project';
            } catch (linkErr: any) {
              linkNote = `\n  ⚠ Auto-link failed: ${linkErr?.message || linkErr}`;
            }
          }
          // Phase 9.09: notify sidebar
          emitProjectsUpdated();
          return `✓ Project created: "${project.name}" (ID: ${project.id})\n  Dir: ${project.working_dir || '(none)'}${linkNote}`;
        } catch (e: any) {
          return `❌ Failed to create project: ${e?.message || e}`;
        }
      },
    }),

    // Bug 4b fix: explicit tool for linking the current conversation to any project
    project_link_conversation: tool({
      description: 'Link the current conversation to a project. Call this after project_create or when continuing work on an existing project.',
      inputSchema: z.object({
        project_id: z.string().describe('Project ID to link this conversation to'),
      }),
      execute: async ({ project_id }: { project_id: string }) => {
        try {
          if (!conversationId) return '❌ No conversation ID available to link';
          projectManager.linkConversation(conversationId, project_id);
          // Phase 9.09: notify sidebar
          emitProjectsUpdated();
          return `✓ Conversation linked to project ${project_id}`;
        } catch (e: any) {
          return `❌ Failed to link: ${e?.message || e}`;
        }
      },
    }),

    project_list: tool({
      description: 'List all projects (non-archived by default). Shows name, working dir, and conversation count.',
      inputSchema: z.object({
        include_archived: z.boolean().optional().describe('Include archived projects (default: false)'),
      }),
      execute: async ({ include_archived }: { include_archived?: boolean }) => {
        try {
          const projects = projectManager.listProjects(include_archived ?? false);
          if (projects.length === 0) return 'No projects found. Use project_create to start one.';
          return projects.map(p => {
            const convs = projectManager.getProjectConversations(p.id);
            return `🏗 **${p.name}** (ID: ${p.id})\n  Dir: ${p.working_dir || '(none)'}\n  Conversations: ${convs.length}\n  Updated: ${p.updated_at.slice(0, 10)}${p.archived ? '  [archived]' : ''}`;
          }).join('\n\n');
        } catch (e: any) {
          return `❌ Failed to list projects: ${e?.message || e}`;
        }
      },
    }),

    project_get: tool({
      description: 'Get full details of a project including artifacts and recent conversations.',
      inputSchema: z.object({
        project_id: z.string().describe('Project ID from project_list'),
      }),
      execute: async ({ project_id }: { project_id: string }) => {
        try {
          const project = projectManager.getProject(project_id);
          if (!project) return `❌ Project "${project_id}" not found.`;

          const artifacts = projectManager.getArtifacts(project_id);
          const convs = projectManager.getProjectConversations(project_id);

          const lines = [
            `🏗 **${project.name}**`,
            `ID: ${project.id}`,
            `Dir: ${project.working_dir || '(none)'}`,
            project.description ? `Description: ${project.description}` : '',
            `Created: ${project.created_at.slice(0, 10)}`,
            `Updated: ${project.updated_at.slice(0, 10)}`,
          ].filter(Boolean);

          if (artifacts.length > 0) {
            lines.push('', `Artifacts (${artifacts.length}):`);
            artifacts.slice(0, 15).forEach(a => {
              const desc = a.description ? ` — ${a.description}` : '';
              lines.push(`  ${a.type === 'folder' ? '📁' : '📄'} ${a.path}${desc}`);
            });
            if (artifacts.length > 15) lines.push(`  ... and ${artifacts.length - 15} more`);
          }

          if (convs.length > 0) {
            lines.push('', `Conversations (${convs.length}):`);
            convs.slice(0, 10).forEach(c => {
              lines.push(`  ${c.title || '(untitled)'} — ${c.updated_at?.slice(0, 10)}`);
            });
          }

          return lines.join('\n');
        } catch (e: any) {
          return `❌ Failed to get project: ${e?.message || e}`;
        }
      },
    }),

    project_add_artifact: tool({
      description: 'Add a file or folder artifact to a project (track files you created or modified).',
      inputSchema: z.object({
        project_id: z.string().describe('Project ID'),
        path: z.string().describe('Absolute or relative path to the file or folder'),
        type: z.enum(['file', 'folder']).describe('Whether this is a file or folder'),
        description: z.string().optional().describe('What this artifact is or does'),
        conversation_id: z.string().optional().describe('Conversation that created this artifact'),
      }),
      execute: async ({ project_id, path, type, description, conversation_id }: {
        project_id: string; path: string; type: 'file' | 'folder'; description?: string; conversation_id?: string;
      }) => {
        try {
          projectManager.addArtifact(project_id, path, type, description, conversation_id);
          return `✓ Artifact added to project: ${type === 'folder' ? '📁' : '📄'} ${path}`;
        } catch (e: any) {
          return `❌ Failed to add artifact: ${e?.message || e}`;
        }
      },
    }),

    project_search: tool({
      description: 'Search all conversations that belong to a project. Returns matching message snippets.',
      inputSchema: z.object({
        project_id: z.string().describe('Project ID to search within'),
        query: z.string().describe('Text to search for in conversation messages'),
      }),
      execute: async ({ project_id, query }: { project_id: string; query: string }) => {
        try {
          const project = projectManager.getProject(project_id);
          if (!project) return `❌ Project "${project_id}" not found.`;

          const convs = projectManager.getProjectConversations(project_id);
          if (convs.length === 0) return `No conversations in project "${project.name}".`;

          // Use existing search for each conversation
          const { agentSearchConversations } = require('./conversation-store');
          const results: string[] = [];
          for (const conv of convs) {
            const hits = await agentSearchConversations(query, conv.id, 5);
            if (hits && hits !== 'No results found.' && !hits.startsWith('No results')) {
              results.push(`--- ${conv.title || '(untitled)'} ---\n${hits}`);
            }
          }

          if (results.length === 0) return `No results found for "${query}" in project "${project.name}".`;
          return results.slice(0, 5).join('\n\n');
        } catch (e: any) {
          return `❌ Search failed: ${e?.message || e}`;
        }
      },
    }),
  };
}

// ─── Coding Memory Tools (Phase coding-memory) ────────────────────────────────

/**
 * Two tools for agents to interact with the cross-session coding memory:
 * - coding_memory_search: grep past sessions and decisions
 * - coding_memory_log: manually record a decision or note
 */
function createCodingMemoryTools() {
  // Resolve project dir from active team or cwd
  function getProjectDir(): string {
    const activeTeam = teamManager.getActiveTeam();
    return activeTeam?.workingDir || process.cwd();
  }

  return {
    coding_memory_search: tool({
      description: 'Search past coding session logs and decisions for a query. Useful for recalling what approaches were tried, what decisions were made, or what files were modified in previous sessions.',
      inputSchema: z.object({
        query: z.string().describe('Text to search for across all session logs and decisions'),
      }),
      execute: async ({ query }: { query: string }) => {
        const projectDir = getProjectDir();
        return codingMemory.searchMemory(projectDir, query);
      },
    }),

    coding_memory_log: tool({
      description: 'Manually log a decision or insight to the coding memory. Decisions and notes persist across sessions. Use this to record architectural choices, tradeoffs, or important findings.',
      inputSchema: z.object({
        content: z.string().describe('The decision or note to record'),
        type: z.enum(['decision', 'note']).describe('Type: "decision" for architectural/design choices, "note" for general observations'),
      }),
      execute: async ({ content, type }: { content: string; type: 'decision' | 'note' }) => {
        const projectDir = getProjectDir();
        return codingMemory.logDecision(projectDir, content, type);
      },
    }),
  };
}

export const TOOL_USAGE_GUIDE = `
## How to use browser tools

1. **Always start with \`elements\`** to see what's on the page.
2. **Click/type/paste by index number** from the elements list.
3. **After navigation or major changes**, re-run \`elements\`.
4. **For canvas apps** (Sheets, Docs, Figma) — use \`keys\` instead of type/click.
5. **For API workflows** — use http_request to call APIs.
6. **Save research** to files — markdown for notes, CSV for tabular data.
7. **Grep first, scroll second.** When looking for something specific, use grep on elements/text/history/files.
8. **Be concise** in responses.
`.trim();
