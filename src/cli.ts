#!/usr/bin/env node
/**
 * cli.ts — tappi-browser CLI (Phase 8.45)
 *
 * Reads the API token from ~/.tappi-browser/api-token and makes HTTP calls
 * to the local Tappi Browser API server (port 18901).
 *
 * Usage: tappi-browser <command> [args...]
 *   tappi-browser --help
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';

// ─── Constants ───────────────────────────────────────────────────────────────

const API_PORT  = 18901;
const API_BASE  = `http://127.0.0.1:${API_PORT}/api`;
const TOKEN_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.tappi-browser');
const TOKEN_FILE = path.join(TOKEN_DIR, 'api-token');

// ─── ANSI colors ─────────────────────────────────────────────────────────────

const isCI = !process.stdout.isTTY || process.env.NO_COLOR;
const c = {
  bold:  (s: string) => isCI ? s : `\x1b[1m${s}\x1b[0m`,
  dim:   (s: string) => isCI ? s : `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => isCI ? s : `\x1b[32m${s}\x1b[0m`,
  cyan:  (s: string) => isCI ? s : `\x1b[36m${s}\x1b[0m`,
  yellow:(s: string) => isCI ? s : `\x1b[33m${s}\x1b[0m`,
  red:   (s: string) => isCI ? s : `\x1b[31m${s}\x1b[0m`,
  blue:  (s: string) => isCI ? s : `\x1b[34m${s}\x1b[0m`,
  reset: (s: string) => isCI ? s : `\x1b[0m${s}\x1b[0m`,
};

// ─── Args parsing ─────────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);

// Extract flags
const jsonMode = rawArgs.includes('--json');
const streamMode = rawArgs.includes('--stream');

// Remove flags from args list
const args = rawArgs.filter(a => !a.startsWith('--'));

// ─── Token ────────────────────────────────────────────────────────────────────

function getToken(): string {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
  } catch {
    die('No API token found. Make sure Tappi Browser is running.\nToken location: ' + TOKEN_FILE);
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function apiFetch(method: string, endpoint: string, body?: any): Promise<any> {
  const token = getToken();
  const url   = `${API_BASE}${endpoint}`;

  const options: http.RequestOptions = {
    method,
    host: '127.0.0.1',
    port: API_PORT,
    path: `/api${endpoint}`,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 401) {
          reject(new Error('Unauthorized: API token mismatch. Is Tappi Browser running?'));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    req.on('error', (e: any) => {
      if (e.code === 'ECONNREFUSED') {
        reject(new Error('Cannot connect to Tappi Browser API. Is the browser running?'));
      } else {
        reject(e);
      }
    });
    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function sseStream(endpoint: string, body: any): Promise<void> {
  const token = getToken();

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const options: http.RequestOptions = {
      method: 'POST',
      host: '127.0.0.1',
      port: API_PORT,
      path: `/api${endpoint}`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Accept': 'text/event-stream',
      },
    };

    const req = http.request(options, (res) => {
      if (res.statusCode !== 200) {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${data}`)));
        return;
      }

      let buf = '';
      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const payload = JSON.parse(line.slice(6));
              if (payload.type === 'download_card' && payload.payload) {
                // Download card event — show file info in terminal
                const d = payload.payload;
                const formats = (d.formats || []).join(', ');
                process.stdout.write(`\n📎 File ready: ${d.name}${d.description ? ' — ' + d.description : ''} [${formats}]\n   Path: ${d.path}\n`);
              } else {
                process.stdout.write(payload.text || '');
              }
            } catch {}
          }
        }
      });
      res.on('end', () => {
        process.stdout.write('\n');
        resolve();
      });
    });

    req.on('error', (e: any) => {
      if (e.code === 'ECONNREFUSED') {
        reject(new Error('Cannot connect to Tappi Browser API. Is the browser running?'));
      } else {
        reject(e);
      }
    });

    req.write(postData);
    req.end();
  });
}

// ─── Output helpers ───────────────────────────────────────────────────────────

function out(data: any) {
  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
  } else if (typeof data === 'string') {
    console.log(data);
  } else if (data && typeof data === 'object') {
    // Pretty print objects
    if (data.result !== undefined) {
      console.log(data.result);
    } else if (data.error) {
      console.error(c.red('✗ Error: ' + data.error));
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
  } else {
    console.log(data);
  }
}

function die(msg: string): never {
  console.error(c.red('✗ ' + msg));
  process.exit(1);
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatTabs(tabs: any[]): string {
  if (!tabs.length) return c.dim('No tabs open');
  return tabs.map((t: any, i: number) => {
    const active = t.active ? c.green('▶ ') : '  ';
    const aria   = t.isAria ? c.cyan('[Aria]') + ' ' : '';
    const title  = c.bold(t.title || 'Untitled');
    const url    = c.dim(t.url || '');
    return `${active}${i}. ${aria}${title}\n      ${url}`;
  }).join('\n');
}

function formatStatus(s: any): string {
  return [
    `${c.bold('Tappi Browser')} ${c.green('● running')}`,
    `${c.cyan('Model:')}       ${s.model}`,
    `${c.cyan('Tabs:')}        ${s.tabCount}`,
    `${c.cyan('Dev Mode:')}    ${s.developerMode ? c.yellow('on') : c.dim('off')}`,
    `${c.cyan('API Key:')}     ${s.hasApiKey ? c.green('configured') : c.red('not set')}`,
  ].join('\n');
}

// ─── HELP ─────────────────────────────────────────────────────────────────────

const HELP = `
${c.bold('tappi-browser')} — Tappi Browser CLI (Phase 8.45)

${c.bold('USAGE')}
  tappi-browser <command> [args...]
  tappi-browser --json <command>   # Machine-readable JSON output

${c.bold('NAVIGATION')}
  open <url>              Open URL in current tab
  navigate <url>          Navigate current tab to URL
  back                    Go back
  forward                 Go forward

${c.bold('PAGE INTERACTION')}
  elements [--grep <text>]     Index interactive elements
  click <index>                Click element by index
  type <index> <text>          Type into element
  text [--grep <text>]         Extract page text
  screenshot [file]            Take screenshot

${c.bold('TAB MANAGEMENT')}
  tabs                         List all tabs
  tab new [url]                Open new tab
  tab close [index]            Close tab (current or by index)
  tab switch <index>           Switch to tab by index

${c.bold('AGENT')}
  ask <message>                Ask the AI agent
  ask --stream <message>       Streaming response

${c.bold('BROWSER')}
  status                       Show browser status
  dark-mode on|off             Toggle dark mode
  zoom in|out|reset|<pct>      Zoom page
  find <text>                  Find on page
  screenshot [file]            Screenshot active tab

${c.bold('TOOLS')}
  tools                        List all available tools
  tool <name> [json-args]      Call any tool by name

${c.bold('CONFIG')}
  config get                   Show current config
  config set <key> <value>     Update config key

${c.bold('FLAGS')}
  --json                       Output raw JSON
  --stream                     Streaming SSE (use with: ask)
`.trim();

// ─── Commands ─────────────────────────────────────────────────────────────────

const [cmd, ...rest] = args;

async function main() {
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return;
  }

  // ── status ────────────────────────────────────────────────────────────────────
  if (cmd === 'status') {
    const data = await apiFetch('GET', '/status');
    if (jsonMode) { out(data); return; }
    console.log(formatStatus(data));
    return;
  }

  // ── tabs ──────────────────────────────────────────────────────────────────────
  if (cmd === 'tabs') {
    const data = await apiFetch('GET', '/tabs');
    if (jsonMode) { out(data); return; }
    console.log(formatTabs(data));
    return;
  }

  // ── tab <subcommand> ──────────────────────────────────────────────────────────
  if (cmd === 'tab') {
    const [sub, ...tabArgs] = rest;

    if (sub === 'new') {
      const url = tabArgs[0];
      const data = await apiFetch('POST', '/tabs', url ? { url } : {});
      if (jsonMode) { out(data); return; }
      console.log(c.green('✓ New tab opened') + (url ? ': ' + url : ''));
      return;
    }

    if (sub === 'close') {
      if (tabArgs[0] !== undefined) {
        // Close by index: find tab ID
        const tabs: any[] = await apiFetch('GET', '/tabs');
        const idx = parseInt(tabArgs[0], 10);
        const tab = tabs[idx];
        if (!tab) die(`No tab at index ${idx}`);
        await apiFetch('DELETE', `/tabs/${tab.id}`);
        if (jsonMode) { out({ success: true }); return; }
        console.log(c.green('✓ Tab closed: ') + (tab.title || tab.url));
      } else {
        // Close active tab
        const status = await apiFetch('GET', '/status');
        if (!status.activeTabId) die('No active tab');
        await apiFetch('DELETE', `/tabs/${status.activeTabId}`);
        if (jsonMode) { out({ success: true }); return; }
        console.log(c.green('✓ Active tab closed'));
      }
      return;
    }

    if (sub === 'switch') {
      const idx = parseInt(tabArgs[0], 10);
      if (isNaN(idx)) die('Usage: tab switch <index>');
      const tabs: any[] = await apiFetch('GET', '/tabs');
      const tab = tabs[idx];
      if (!tab) die(`No tab at index ${idx}`);
      await apiFetch('POST', `/tabs/${tab.id}/navigate`, { url: tab.url });
      if (jsonMode) { out({ success: true }); return; }
      console.log(c.green('✓ Switched to tab: ') + (tab.title || tab.url));
      return;
    }

    die(`Unknown tab subcommand: ${sub}. Try: new, close, switch`);
  }

  // ── open / navigate ───────────────────────────────────────────────────────────
  if (cmd === 'open' || cmd === 'navigate') {
    const url = rest[0];
    if (!url) die(`Usage: ${cmd} <url>`);
    // Get active tab and navigate it
    const status = await apiFetch('GET', '/status');
    if (!status.activeTabId) die('No active tab');
    const data = await apiFetch('POST', `/tabs/${status.activeTabId}/navigate`, { url });
    if (jsonMode) { out(data); return; }
    console.log(c.green('✓ Navigating to: ') + url);
    return;
  }

  // ── back / forward ────────────────────────────────────────────────────────────
  if (cmd === 'back') {
    const data = await apiFetch('POST', '/tools/back_forward', { direction: 'back' });
    if (jsonMode) { out(data); return; }
    console.log(c.green('✓ Going back'));
    return;
  }

  if (cmd === 'forward') {
    const data = await apiFetch('POST', '/tools/back_forward', { direction: 'forward' });
    if (jsonMode) { out(data); return; }
    console.log(c.green('✓ Going forward'));
    return;
  }

  // ── elements ──────────────────────────────────────────────────────────────────
  if (cmd === 'elements') {
    const grepIdx = rawArgs.indexOf('--grep');
    const grep = grepIdx !== -1 ? rawArgs[grepIdx + 1] : undefined;
    const status = await apiFetch('GET', '/status');
    if (!status.activeTabId) die('No active tab');
    const qs = grep ? `?grep=${encodeURIComponent(grep)}` : '';
    const data = await apiFetch('GET', `/tabs/${status.activeTabId}/elements${qs}`);
    out(data);
    return;
  }

  // ── click ─────────────────────────────────────────────────────────────────────
  if (cmd === 'click') {
    const index = parseInt(rest[0], 10);
    if (isNaN(index)) die('Usage: click <index>');
    const status = await apiFetch('GET', '/status');
    if (!status.activeTabId) die('No active tab');
    const data = await apiFetch('POST', `/tabs/${status.activeTabId}/click`, { index });
    out(data);
    return;
  }

  // ── type ──────────────────────────────────────────────────────────────────────
  if (cmd === 'type') {
    const index = parseInt(rest[0], 10);
    const text  = rest.slice(1).join(' ');
    if (isNaN(index) || !text) die('Usage: type <index> <text>');
    const status = await apiFetch('GET', '/status');
    if (!status.activeTabId) die('No active tab');
    const data = await apiFetch('POST', `/tabs/${status.activeTabId}/type`, { index, text });
    out(data);
    return;
  }

  // ── text ──────────────────────────────────────────────────────────────────────
  if (cmd === 'text') {
    const grepIdx = rawArgs.indexOf('--grep');
    const grep = grepIdx !== -1 ? rawArgs[grepIdx + 1] : undefined;
    const status = await apiFetch('GET', '/status');
    if (!status.activeTabId) die('No active tab');
    const qs = grep ? `?grep=${encodeURIComponent(grep)}` : '';
    const data = await apiFetch('GET', `/tabs/${status.activeTabId}/text${qs}`);
    out(data);
    return;
  }

  // ── screenshot ────────────────────────────────────────────────────────────────
  if (cmd === 'screenshot') {
    const data = await apiFetch('POST', '/browser/screenshot', { target: 'tab', format: 'png' });
    if (jsonMode) { out(data); return; }
    console.log(c.green('✓ Screenshot saved: ') + data.path);
    return;
  }

  // ── ask ───────────────────────────────────────────────────────────────────────
  if (cmd === 'ask') {
    const message = rest.join(' ');
    if (!message) die('Usage: ask <message>');

    if (streamMode) {
      await sseStream('/agent/ask/stream', { message });
    } else {
      if (!jsonMode) process.stdout.write(c.dim('🤔 Thinking...'));
      const data = await apiFetch('POST', '/agent/ask', { message });
      if (!jsonMode) process.stdout.write('\r' + ' '.repeat(20) + '\r');
      if (jsonMode) { out(data); return; }
      console.log(data.response || data.result || data);
    }
    return;
  }

  // ── dark-mode ─────────────────────────────────────────────────────────────────
  if (cmd === 'dark-mode') {
    const state = rest[0];
    if (state !== 'on' && state !== 'off') die('Usage: dark-mode on|off');
    const data = await apiFetch('POST', '/browser/dark-mode', { enabled: state === 'on' });
    out(data);
    return;
  }

  // ── zoom ──────────────────────────────────────────────────────────────────────
  if (cmd === 'zoom') {
    const action = rest[0];
    if (!action) die('Usage: zoom in|out|reset|<level>');
    const data = await apiFetch('POST', '/browser/zoom', { action });
    out(data);
    return;
  }

  // ── find ──────────────────────────────────────────────────────────────────────
  if (cmd === 'find') {
    const text = rest.join(' ');
    const data = await apiFetch('POST', '/browser/find', { text });
    out(data);
    return;
  }

  // ── tools ─────────────────────────────────────────────────────────────────────
  if (cmd === 'tools') {
    const data: any[] = await apiFetch('GET', '/tools');
    if (jsonMode) { out(data); return; }
    console.log(c.bold(`\n${data.length} available tools:\n`));
    for (const t of data) {
      const shortDesc = (t.description || '').split('.')[0].slice(0, 80);
      console.log(`  ${c.cyan(t.name.padEnd(25))} ${c.dim(shortDesc)}`);
    }
    console.log();
    return;
  }

  // ── tool <name> [json-args] ───────────────────────────────────────────────────
  if (cmd === 'tool') {
    const toolName = rest[0];
    if (!toolName) die('Usage: tool <name> [json-args]');
    let toolArgs: any = {};
    if (rest[1]) {
      try { toolArgs = JSON.parse(rest[1]); }
      catch { die('Invalid JSON args: ' + rest[1]); }
    }
    const data = await apiFetch('POST', `/tools/${toolName}`, toolArgs);
    out(data);
    return;
  }

  // ── config ────────────────────────────────────────────────────────────────────
  if (cmd === 'config') {
    const [sub, ...cfgArgs] = rest;

    if (sub === 'get' || !sub) {
      const data = await apiFetch('GET', '/config');
      out(data);
      return;
    }

    if (sub === 'set') {
      const [key, ...valParts] = cfgArgs;
      const value = valParts.join(' ');
      if (!key || value === undefined) die('Usage: config set <key> <value>');
      // Build nested object from dot-notation key
      const keys = key.split('.');
      const body: any = {};
      let cur = body;
      for (let i = 0; i < keys.length - 1; i++) {
        cur[keys[i]] = {};
        cur = cur[keys[i]];
      }
      cur[keys[keys.length - 1]] = value;
      const data = await apiFetch('PATCH', '/config', body);
      if (jsonMode) { out(data); return; }
      console.log(c.green(`✓ Config updated: ${key} = ${value}`));
      return;
    }

    die(`Unknown config subcommand: ${sub}`);
  }

  // ── exec (developer mode — shell via tool passthrough) ────────────────────────
  if (cmd === 'exec') {
    const command = rest.join(' ');
    if (!command) die('Usage: exec <command>');
    const data = await apiFetch('POST', '/tools/exec', { command });
    out(data);
    return;
  }

  // ── Unknown command ────────────────────────────────────────────────────────────
  die(`Unknown command: ${cmd}\nRun 'tappi-browser help' for usage.`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

main().catch(e => {
  if (e.code === 'ECONNREFUSED') {
    console.error(c.red('✗ Cannot connect to Tappi Browser. Is it running?'));
  } else {
    console.error(c.red('✗ ' + (e.message || String(e))));
  }
  process.exit(1);
});
