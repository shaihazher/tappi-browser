/**
 * command-executor.ts — Unified command dispatcher.
 *
 * Parses text commands from the agent (or dev input) and routes them:
 *   - Page commands: "elements", "click 4", "type 1 hello", "text", "scroll down", etc.
 *   - Browser commands: "B0 on", "B2 delete github.com", "B6 mute", etc.
 *
 * Same interface for both LLM output and manual dev testing (Phase 4 testing mode).
 */

import type { WebContents } from 'electron';
import { TabManager } from './tab-manager';
import type { BrowserContext } from './browser-tools';
import * as pageTools from './page-tools';
import * as browserTools from './browser-tools';
import * as httpTools from './http-tools';
import * as fileTools from './file-tools';

export interface ExecutorContext {
  browserCtx: BrowserContext;
}

interface ParsedCommand {
  type: 'page' | 'browser' | 'meta';
  action: string;
  args: string[];
}

// ─── Command Parser ───

function parseCommand(input: string): ParsedCommand {
  const trimmed = input.trim();

  // B-commands: "B0 on", "B2 delete github.com"
  const bMatch = trimmed.match(/^(B\d+)\s*(.*)?$/i);
  if (bMatch) {
    const bCmd = bMatch[1].toUpperCase();
    const rest = (bMatch[2] || '').trim();
    const args = rest ? rest.split(/\s+/) : [];
    return { type: 'browser', action: bCmd, args };
  }

  // Handle pipe-style grep: "elements | grep submit" or "text | grep refund"
  let grepArg: string | null = null;
  let cmdStr = trimmed;
  const pipeMatch = trimmed.match(/^(.+?)\s*\|\s*grep\s+(.+)$/i);
  if (pipeMatch) {
    cmdStr = pipeMatch[1].trim();
    grepArg = pipeMatch[2].trim();
  }

  // Page commands: "click 4", "type 1 hello world", "elements", "text", etc.
  const parts = cmdStr.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case 'elements':
    case 'els':
      return { type: 'page', action: 'elements', args: [...parts.slice(1), ...(grepArg ? ['--grep', grepArg] : [])] };

    case 'click':
      return { type: 'page', action: 'click', args: parts.slice(1) };

    case 'type': {
      // "type 3 hello world" → index=3, text="hello world"
      const idx = parts[1];
      const text = parts.slice(2).join(' ');
      return { type: 'page', action: 'type', args: [idx, text] };
    }

    case 'paste': {
      const idx = parts[1];
      const text = parts.slice(2).join(' ');
      return { type: 'page', action: 'paste', args: [idx, text] };
    }

    case 'focus':
      return { type: 'page', action: 'focus', args: parts.slice(1) };

    case 'check':
      return { type: 'page', action: 'check', args: parts.slice(1) };

    case 'text':
      return { type: 'page', action: 'text', args: [...parts.slice(1), ...(grepArg ? ['--grep', grepArg] : [])] };

    case 'scroll':
      return { type: 'page', action: 'scroll', args: parts.slice(1) };

    case 'keys':
    case 'key':
      return { type: 'page', action: 'keys', args: parts.slice(1) };

    case 'eval':
      return { type: 'page', action: 'eval', args: [parts.slice(1).join(' ')] };

    case 'screenshot':
    case 'ss':
      return { type: 'page', action: 'screenshot', args: parts.slice(1) };

    case 'click-xy':
    case 'clickxy':
      return { type: 'page', action: 'click-xy', args: parts.slice(1) };

    case 'hover-xy':
    case 'hoverxy':
      return { type: 'page', action: 'hover-xy', args: parts.slice(1) };

    case 'wait':
      return { type: 'page', action: 'wait', args: parts.slice(1) };

    // HTTP commands
    case 'fetch':
    case 'http':
    case 'get':
      return { type: 'meta', action: 'http-get', args: parts.slice(1) };

    case 'post':
      return { type: 'meta', action: 'http-post', args: parts.slice(1) };

    case 'put':
      return { type: 'meta', action: 'http-put', args: parts.slice(1) };

    case 'delete':
      // Distinguish "delete <url>" (HTTP) from other uses
      if (parts[1] && (parts[1].startsWith('http') || parts[1].startsWith('/'))) {
        return { type: 'meta', action: 'http-delete', args: parts.slice(1) };
      }
      return { type: 'meta', action: 'unknown', args: [trimmed] };

    case 'api-key':
    case 'apikey':
      return { type: 'meta', action: 'api-key', args: parts.slice(1) };

    case 'file':
    case 'f':
      return { type: 'meta', action: 'file', args: parts.slice(1) };

    // Meta commands
    case 'help':
      return { type: 'meta', action: 'help', args: [] };

    case 'state':
    case 'status':
      return { type: 'meta', action: 'state', args: [] };

    case 'menu':
      return { type: 'meta', action: 'menu', args: [] };

    default:
      return { type: 'meta', action: 'unknown', args: [trimmed] };
  }
}

// ─── Command Executor ───

export async function executeCommand(input: string, ctx: ExecutorContext): Promise<string> {
  const parsed = parseCommand(input);
  const wc = ctx.browserCtx.tabManager.activeWebContents;

  // ─── Browser commands ───
  if (parsed.type === 'browser') {
    return browserTools.executeBCommand(ctx.browserCtx, parsed.action, parsed.args);
  }

  // ─── Meta commands ───
  if (parsed.type === 'meta') {
    switch (parsed.action) {
      case 'help':
        return HELP_TEXT;
      case 'state':
        return getFullState(ctx);
      case 'menu':
        return getMenu(ctx);

      // HTTP commands
      case 'http-get':
      case 'http-post':
      case 'http-put':
      case 'http-delete': {
        const method = parsed.action.replace('http-', '').toUpperCase();
        return executeHttpCommand(method, parsed.args);
      }

      // API key management
      case 'api-key': {
        const sub = parsed.args[0]?.toLowerCase();
        if (sub === 'store' || sub === 'set') {
          return httpTools.storeApiKey(parsed.args[1], parsed.args.slice(2).join(' '));
        }
        if (sub === 'list' || sub === 'ls') {
          return httpTools.listApiKeys();
        }
        if (sub === 'delete' || sub === 'rm') {
          return httpTools.deleteApiKey(parsed.args[1]);
        }
        if (sub === 'get') {
          const key = httpTools.getApiKey(parsed.args[1]);
          return key ? `Key for "${parsed.args[1]}": ${key.slice(0, 8)}...` : `No key found for "${parsed.args[1]}"`;
        }
        return 'Usage: api-key store|list|get|delete <service> [key]';
      }

      // File management
      case 'file': {
        const sub = parsed.args[0]?.toLowerCase();
        const filePath = parsed.args[1] || '';
        const rest = parsed.args.slice(2).join(' ');

        switch (sub) {
          case 'write':
          case 'create':
            return fileTools.fileWrite(filePath, rest);
          case 'read':
          case 'cat':
            return fileTools.fileRead(filePath);
          case 'head':
            return fileTools.fileHead(filePath, parseInt(parsed.args[2]) || 20);
          case 'tail':
            return fileTools.fileTail(filePath, parseInt(parsed.args[2]) || 20);
          case 'append':
          case 'add':
            return fileTools.fileAppend(filePath, rest);
          case 'delete':
          case 'rm':
            return fileTools.fileDelete(filePath);
          case 'list':
          case 'ls':
            return fileTools.fileList(filePath || undefined);
          case 'copy':
          case 'cp':
            return fileTools.fileCopy(filePath, parsed.args[2] || '');
          case 'move':
          case 'mv':
            return fileTools.fileMove(filePath, parsed.args[2] || '');
          default:
            return 'Usage: file write|read|head|tail|append|delete|list|copy|move <path> [content]';
        }
      }

      case 'unknown':
        return `Unknown command: "${parsed.args[0]}". Type "help" for available commands.`;
    }
  }

  // ─── Page commands (need active tab) ───
  if (!wc) return 'No active tab. Open a tab first.';

  switch (parsed.action) {
    case 'elements': {
      const grepIdx = parsed.args.indexOf('--grep');
      const grep = grepIdx >= 0 ? parsed.args[grepIdx + 1] : undefined;
      const filter = grepIdx >= 0 ? (parsed.args[0] !== '--grep' ? parsed.args[0] : undefined) : parsed.args[0];
      return pageTools.pageElements(wc, filter, false, grep);
    }

    case 'click': {
      const idx = parseInt(parsed.args[0]);
      if (isNaN(idx)) return 'Usage: click <index>';
      return pageTools.pageClick(wc, idx);
    }

    case 'type': {
      const idx = parseInt(parsed.args[0]);
      const text = parsed.args[1];
      if (isNaN(idx) || !text) return 'Usage: type <index> <text>';
      return pageTools.pageType(wc, idx, text);
    }

    case 'paste': {
      const idx = parseInt(parsed.args[0]);
      const text = parsed.args[1];
      if (isNaN(idx) || !text) return 'Usage: paste <index> <text>';
      return pageTools.pagePaste(wc, idx, text);
    }

    case 'focus': {
      const idx = parseInt(parsed.args[0]);
      if (isNaN(idx)) return 'Usage: focus <index>';
      return pageTools.pageFocus(wc, idx);
    }

    case 'check': {
      const idx = parseInt(parsed.args[0]);
      if (isNaN(idx)) return 'Usage: check <index>';
      return pageTools.pageCheck(wc, idx);
    }

    case 'text': {
      const grepIdx = parsed.args.indexOf('--grep');
      const grep = grepIdx >= 0 ? parsed.args[grepIdx + 1] : undefined;
      const selector = grepIdx >= 0 ? (parsed.args[0] !== '--grep' ? parsed.args[0] : undefined) : parsed.args[0];
      return pageTools.pageText(wc, selector, grep);
    }

    case 'scroll':
      return pageTools.pageScroll(wc, parsed.args[0] || 'down', parseInt(parsed.args[1]) || undefined);

    case 'keys':
      if (!parsed.args[0]) return 'Usage: keys <combo> or keys <text> <key> <text> <key> ...\nExamples: keys ctrl+c | keys enter | keys "hello" tab "world" enter';
      // If multiple args, treat as a sequence: keys "hello" tab "world" enter
      return pageTools.pageKeys(wc, parsed.args.length > 1 ? parsed.args : parsed.args[0]);

    case 'eval':
      if (!parsed.args[0]) return 'Usage: eval <javascript>';
      return pageTools.pageEval(wc, parsed.args[0]);

    case 'screenshot':
      return pageTools.pageScreenshot(wc, parsed.args[0]);

    case 'click-xy': {
      const x = parseInt(parsed.args[0]);
      const y = parseInt(parsed.args[1]);
      if (isNaN(x) || isNaN(y)) return 'Usage: click-xy <x> <y>';
      return pageTools.pageClickXY(wc, x, y);
    }

    case 'hover-xy': {
      const x = parseInt(parsed.args[0]);
      const y = parseInt(parsed.args[1]);
      if (isNaN(x) || isNaN(y)) return 'Usage: hover-xy <x> <y>';
      return pageTools.pageHoverXY(wc, x, y);
    }

    case 'wait': {
      const ms = parseInt(parsed.args[0]);
      if (isNaN(ms)) return 'Usage: wait <ms>';
      return pageTools.pageWait(ms);
    }

    default:
      return `Unknown page command: ${parsed.action}`;
  }
}

// ─── HTTP command helper ───

async function executeHttpCommand(method: string, args: string[]): Promise<string> {
  // Parse: <url> [--header key:value] [--auth Bearer xxx] [--body {...}] [--json {...}] [--save path]
  const url = args[0];
  if (!url) return `Usage: ${method.toLowerCase()} <url> [--header key:value] [--auth token] [--body data] [--json data] [--save path]`;

  const req: httpTools.HttpRequest = { url, method };
  const headers: Record<string, string> = {};

  let i = 1;
  while (i < args.length) {
    const flag = args[i];
    if ((flag === '--header' || flag === '-H') && args[i + 1]) {
      const [key, ...valParts] = args[i + 1].split(':');
      headers[key.trim()] = valParts.join(':').trim();
      i += 2;
    } else if (flag === '--auth' && args[i + 1]) {
      // Check if it's a stored key reference: --auth @service
      const authVal = args[i + 1];
      if (authVal.startsWith('@')) {
        const service = authVal.slice(1);
        const key = httpTools.getApiKey(service);
        if (!key) return `No API key stored for "${service}". Use: api-key store ${service} <key>`;
        req.auth = `Bearer ${key}`;
      } else {
        req.auth = authVal;
      }
      i += 2;
    } else if (flag === '--body' && args[i + 1]) {
      req.body = args.slice(i + 1).join(' ');
      break; // body consumes rest
    } else if (flag === '--json' && args[i + 1]) {
      try {
        req.json = JSON.parse(args.slice(i + 1).join(' '));
      } catch {
        return 'Error: Invalid JSON in --json argument';
      }
      break;
    } else if (flag === '--save' && args[i + 1]) {
      req.saveToFile = args[i + 1];
      i += 2;
    } else if (flag === '--timeout' && args[i + 1]) {
      req.timeout = parseInt(args[i + 1]);
      i += 2;
    } else {
      i++;
    }
  }

  if (Object.keys(headers).length > 0) req.headers = headers;

  return httpTools.httpRequest(req);
}

// ─── State & Menu generation ───

export function getFullState(ctx: ExecutorContext): string {
  const wc = ctx.browserCtx.tabManager.activeWebContents;
  if (!wc) return 'No active tab.';

  const state = browserTools.getBrowserState(ctx.browserCtx);
  const menu = browserTools.getBrowserMenu();
  return `${state}\n${menu}`;
}

export async function getMenu(ctx: ExecutorContext): Promise<string> {
  const wc = ctx.browserCtx.tabManager.activeWebContents;
  if (!wc) return 'No active tab. Open a tab first.';

  // Get page elements
  const elements = await pageTools.pageElements(wc);

  // Get browser state + menu
  const state = browserTools.getBrowserState(ctx.browserCtx);
  const bMenu = browserTools.getBrowserMenu();

  return `${state}\n\n${elements}\n${bMenu}`;
}


// ─── Help Text ───

const HELP_TEXT = `
📖 Tappi Browser Commands

Page commands:
  elements [selector]    Index interactive elements on the page
  click <index>          Click element by index
  type <index> <text>    Type text into element
  paste <index> <text>   Paste text into element
  focus <index>          Focus element
  check <index>          Check element state (value, checked, etc.)
  text [selector]        Extract visible text from page
  scroll <dir> [px]      Scroll up/down/top/bottom
  keys <combo>           Send keyboard combo (e.g. ctrl+c, enter, tab)
  eval <js>              Execute JavaScript in page
  screenshot [path]      Take screenshot (save to file or clipboard)
  click-xy <x> <y>      Click at coordinates
  hover-xy <x> <y>      Hover at coordinates
  wait <ms>              Wait for milliseconds

Browser commands (B-prefix):
  B0 on|off              Toggle dark mode
  B2 list [domain]       List cookies
  B2 delete <domain|all> Delete cookies
  B6 close|mute|pin|dup|others|right   Tab management
  B7 [add|toggle]        Toggle bookmark
  B8 in|out|reset|<pct>  Zoom control
  B9 <text>              Find on page
  B10 [pdf] [path]       Print or save as PDF
  B14 <url>              Navigate to URL
  B15 <query>            Search via search engine
  B16 back|forward       Navigation history
  B17 clipboard|file     Screenshot

HTTP & API:
  get <url> [opts]       HTTP GET request
  post <url> [opts]      HTTP POST request
  put <url> [opts]       HTTP PUT request
  delete <url> [opts]    HTTP DELETE request
    Options: --header key:value  --auth Bearer|@service  --body data  --json data  --save path  --timeout ms
  api-key store <svc> <key>  Store API key (encrypted)
  api-key list           List stored services
  api-key get <svc>      Show key preview
  api-key delete <svc>   Remove stored key

Files (workspace: ~/tappi-workspace/):
  file write <path> <content>   Create/overwrite file (.md, .csv, .txt, .json, .html, etc.)
  file read <path>              Read file contents
  file head <path> [n]          First n lines (default 20)
  file tail <path> [n]          Last n lines (default 20)
  file append <path> <content>  Append to file
  file delete <path>            Delete file or directory
  file list [path]              List directory contents
  file copy <src> <dest>        Copy file
  file move <src> <dest>        Move/rename file

Meta:
  help                   Show this help
  state                  Show browser state
  menu                   Full menu (page elements + browser actions)
`.trim();
