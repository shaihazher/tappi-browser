/**
 * browser-tools.ts — Browser-level B-command implementations.
 *
 * These operate on the browser itself (tabs, cookies, zoom, dark mode, etc.)
 * rather than page content. Each maps directly to Electron APIs.
 *
 * Also generates the compact B-command menu appended to the agent's context.
 */

import { session, clipboard } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';
import { TabManager } from './tab-manager';
import * as fs from 'fs';
import * as path from 'path';

export interface BrowserContext {
  window: BrowserWindow;
  tabManager: TabManager;
  config: any;
}

// ─── Dark Mode CSS ───

const DARK_MODE_CSS = `
  html {
    filter: invert(1) hue-rotate(180deg) !important;
    background: #111 !important;
  }
  img, video, canvas, picture, svg, [style*="background-image"] {
    filter: invert(1) hue-rotate(180deg) !important;
  }
`;

const darkModeCSSKeys = new Map<string, string>(); // webContents id → CSS key

// ─── B-Command Implementations ───

export async function bDarkMode(ctx: BrowserContext, args: string[]): Promise<string> {
  const wc = ctx.tabManager.activeWebContents;
  if (!wc) return 'No active tab.';

  const mode = args[0]?.toLowerCase();
  if (mode === 'on') {
    const key = await wc.insertCSS(DARK_MODE_CSS);
    darkModeCSSKeys.set(wc.id.toString(), key);
    return 'Dark mode: ON';
  } else if (mode === 'off') {
    const key = darkModeCSSKeys.get(wc.id.toString());
    if (key) {
      await wc.removeInsertedCSS(key);
      darkModeCSSKeys.delete(wc.id.toString());
    }
    return 'Dark mode: OFF';
  }
  return 'Usage: B0 on|off';
}

export async function bCookies(ctx: BrowserContext, args: string[]): Promise<string> {
  const action = args[0]?.toLowerCase();
  const domain = args[1];

  if (action === 'list') {
    const filter = domain ? { domain } : {};
    const cookies = await session.defaultSession.cookies.get(filter);
    if (cookies.length === 0) return domain ? `No cookies for ${domain}` : 'No cookies stored.';
    // Group by domain
    const grouped = new Map<string, number>();
    cookies.forEach(c => {
      const d = c.domain || 'unknown';
      grouped.set(d, (grouped.get(d) || 0) + 1);
    });
    if (domain) {
      return cookies.map(c => `  ${c.name}=${(c.value || '').slice(0, 30)}${c.value && c.value.length > 30 ? '...' : ''}`).join('\n');
    }
    return [...grouped.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([d, n]) => `  ${d}: ${n} cookies`)
      .join('\n');
  }

  if (action === 'delete') {
    if (!domain) return 'Usage: B2 delete <domain|all>';
    if (domain === 'all') {
      await session.defaultSession.clearStorageData({ storages: ['cookies'] });
      return 'All cookies deleted.';
    }
    const cookies = await session.defaultSession.cookies.get({ domain });
    for (const c of cookies) {
      const url = `http${c.secure ? 's' : ''}://${c.domain?.replace(/^\./, '') || domain}${c.path || '/'}`;
      await session.defaultSession.cookies.remove(url, c.name);
    }
    return `Deleted ${cookies.length} cookies for ${domain}`;
  }

  return 'Usage: B2 list [domain] | B2 delete <domain|all>';
}

export async function bAdBlocker(ctx: BrowserContext, args: string[]): Promise<string> {
  const { isAdBlockerEnabled, toggleAdBlocker, getBlockedCount, addSiteException, removeSiteException, getSiteExceptions } = require('./ad-blocker');

  const action = args[0]?.toLowerCase();

  if (action === 'on' || action === 'off') {
    toggleAdBlocker(action === 'on');
    return `Ad blocker: ${action === 'on' ? 'ON' : 'OFF'}`;
  }

  if (action === 'status') {
    const enabled = isAdBlockerEnabled();
    const count = getBlockedCount();
    const exceptions = getSiteExceptions();
    return `Ad blocker: ${enabled ? 'ON' : 'OFF'} | Blocked: ${count}${exceptions.length > 0 ? ` | Exceptions: ${exceptions.join(', ')}` : ''}`;
  }

  if (action === 'exception' || action === 'except') {
    const domain = args[1];
    if (!domain) return 'Usage: B1 exception <domain>';
    const remove = args[2]?.toLowerCase() === 'remove';
    if (remove) { removeSiteException(domain); return `Removed exception for ${domain}`; }
    addSiteException(domain);
    return `Added exception for ${domain} — ads will show on this site.`;
  }

  return `Usage: B1 on|off|status|exception <domain>`;
}

export async function bHistory(ctx: BrowserContext, args: string[]): Promise<string> {
  const { searchHistory, getRecentHistory, clearHistory } = require('./database');

  const action = args[0]?.toLowerCase();

  if (action === 'clear') {
    const range = args[1] || 'all';
    const count = clearHistory(range);
    return `Cleared ${count} history entries (${range}).`;
  }

  if (action === 'search') {
    const query = args.slice(1).join(' ');
    if (!query) return 'Usage: B3 search <query>';
    const results = searchHistory(query, 10);
    if (results.length === 0) return `No history matching "${query}"`;
    return results.map((r: any) => `  ${r.title || r.url} — ${r.domain}`).join('\n');
  }

  // Default: recent history
  const results = getRecentHistory(10);
  if (results.length === 0) return 'No browsing history yet.';
  return results.map((r: any) => `  ${r.title || r.url} — ${r.domain}`).join('\n');
}

export async function bDownloads(ctx: BrowserContext, args: string[]): Promise<string> {
  const { getDownloadsSummary, cancelDownload, clearCompleted } = require('./download-manager');

  const action = args[0]?.toLowerCase();

  if (action === 'cancel') {
    const id = args[1];
    if (!id) return 'Usage: B5 cancel <id>';
    const ok = cancelDownload(id);
    return ok ? `Cancelled download ${id}` : `Download ${id} not found or already complete.`;
  }

  if (action === 'clear') {
    clearCompleted();
    return 'Cleared completed downloads.';
  }

  return getDownloadsSummary();
}

export async function bTab(ctx: BrowserContext, args: string[]): Promise<string> {
  const action = args[0]?.toLowerCase();
  const activeId = ctx.tabManager.activeTabId;
  if (!activeId) return 'No active tab.';

  switch (action) {
    case 'close':
      ctx.tabManager.closeTab(activeId);
      return ctx.tabManager.tabCount > 0 ? 'Tab closed.' : 'Last tab closed.';
    case 'mute':
      ctx.tabManager.muteTab(activeId);
      return 'Tab audio toggled.';
    case 'pin':
      ctx.tabManager.pinTab(activeId);
      return 'Tab pin toggled.';
    case 'duplicate': {
      const newId = ctx.tabManager.duplicateTab(activeId);
      return newId ? 'Tab duplicated.' : 'Failed to duplicate.';
    }
    case 'others':
      ctx.tabManager.closeOtherTabs(activeId);
      return 'Other tabs closed.';
    case 'right':
      ctx.tabManager.closeTabsToRight(activeId);
      return 'Tabs to right closed.';
    default:
      return 'Usage: B6 close|mute|pin|duplicate|others|right';
  }
}

export async function bBookmark(ctx: BrowserContext, args: string[]): Promise<string> {
  const action = args[0]?.toLowerCase();
  const wc = ctx.tabManager.activeWebContents;
  if (!wc) return 'No active tab.';

  if (action === 'add' || action === 'toggle' || !action) {
    const url = wc.getURL();
    const added = ctx.tabManager.toggleBookmark(url);
    return added ? `Bookmarked: ${url}` : `Removed bookmark: ${url}`;
  }
  if (action === 'list') {
    return 'Bookmark listing coming in Phase 6.';
  }
  return 'Usage: B7 [add|toggle|list]';
}

export async function bZoom(ctx: BrowserContext, args: string[]): Promise<string> {
  const wc = ctx.tabManager.activeWebContents;
  if (!wc) return 'No active tab.';

  const action = args[0]?.toLowerCase();
  const current = wc.getZoomLevel();

  switch (action) {
    case 'in':
      wc.setZoomLevel(current + 0.5);
      return `Zoom: ${Math.round((current + 0.5) * 100 / 1 + 100)}%`;
    case 'out':
      wc.setZoomLevel(current - 0.5);
      return `Zoom: ${Math.round((current - 0.5) * 100 / 1 + 100)}%`;
    case 'reset':
      wc.setZoomLevel(0);
      return 'Zoom: 100%';
    default:
      // Try numeric level
      const level = parseFloat(action);
      if (!isNaN(level)) {
        // Convert percentage to zoom level: 100% = 0, 150% = ~2.5
        const zoomLevel = Math.log(level / 100) / Math.log(1.2);
        wc.setZoomLevel(zoomLevel);
        return `Zoom: ${level}%`;
      }
      return 'Usage: B8 in|out|reset|<percent>';
  }
}

export async function bFind(ctx: BrowserContext, args: string[]): Promise<string> {
  const wc = ctx.tabManager.activeWebContents;
  if (!wc) return 'No active tab.';

  const query = args.join(' ');
  if (!query) {
    wc.stopFindInPage('clearSelection');
    return 'Find cleared.';
  }

  return new Promise((resolve) => {
    wc.once('found-in-page', (_e, result) => {
      resolve(`Found "${query}": ${result.matches} matches (showing ${result.activeMatchOrdinal} of ${result.matches})`);
    });
    wc.findInPage(query);
    // Timeout fallback
    setTimeout(() => resolve(`Searching for "${query}"...`), 2000);
  });
}

export async function bPrint(ctx: BrowserContext, args: string[]): Promise<string> {
  const wc = ctx.tabManager.activeWebContents;
  if (!wc) return 'No active tab.';

  if (args[0]?.toLowerCase() === 'pdf') {
    const pdfPath = args[1] || path.join(
      process.env.HOME || '.',
      'Downloads',
      `tappi-${Date.now()}.pdf`
    );
    // BUG-A05: use printToPDF (silent, no dialog) with printBackground for best output
    const data = await wc.printToPDF({ printBackground: true });
    fs.writeFileSync(pdfPath, data);
    return `PDF saved: ${pdfPath}`;
  }

  wc.print();
  return 'Print dialog opened.';
}

export async function bNavigate(ctx: BrowserContext, args: string[]): Promise<string> {
  const url = args.join(' ');
  if (!url) return 'Usage: B14 <url>';

  let finalUrl = url;
  if (!/^https?:\/\//i.test(url) && !/^file:\/\//i.test(url)) {
    if (/^[^\s]+\.[^\s]+$/.test(url)) {
      finalUrl = 'https://' + url;
    } else {
      return `Not a URL: "${url}". Use B15 to search.`;
    }
  }

  // Phase 8.35: Aria tab must never navigate away — open a new tab instead.
  const activeId = ctx.tabManager.activeTabId;
  if (activeId && activeId === ctx.tabManager.ariaTabId) {
    ctx.tabManager.createTab(finalUrl);
    return `Navigating to: ${finalUrl} (opened in new tab)`;
  }

  const wc = ctx.tabManager.activeWebContents;
  if (!wc) return 'No active tab.';
  wc.loadURL(finalUrl);
  return `Navigating to: ${finalUrl}`;
}

export async function bSearch(ctx: BrowserContext, args: string[]): Promise<string> {
  const query = args.join(' ');
  if (!query) return 'Usage: B15 <query>';

  const engine = ctx.config?.searchEngine || 'google';
  const engines: Record<string, string> = {
    google: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
    duckduckgo: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
    ddg: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
    brave: `https://search.brave.com/search?q=${encodeURIComponent(query)}`,
    bing: `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
  };

  const searchUrl = engines[engine] || engines.google;

  // Phase 8.35: Aria tab must never navigate away — open a new tab instead.
  const activeId = ctx.tabManager.activeTabId;
  if (activeId && activeId === ctx.tabManager.ariaTabId) {
    ctx.tabManager.createTab(searchUrl);
    return `Searching: "${query}" (${engine}) — opened in new tab`;
  }

  const wc = ctx.tabManager.activeWebContents;
  if (!wc) return 'No active tab.';
  wc.loadURL(searchUrl);
  return `Searching: "${query}" (${engine})`;
}

export async function bBackForward(ctx: BrowserContext, args: string[]): Promise<string> {
  const wc = ctx.tabManager.activeWebContents;
  if (!wc) return 'No active tab.';

  const action = args[0]?.toLowerCase();
  if (action === 'back') {
    if (wc.canGoBack()) { wc.goBack(); return 'Going back.'; }
    return 'Cannot go back — no history.';
  }
  if (action === 'forward') {
    if (wc.canGoForward()) { wc.goForward(); return 'Going forward.'; }
    return 'Cannot go forward.';
  }
  return 'Usage: B16 back|forward';
}

export async function bScreenshot(ctx: BrowserContext, args: string[]): Promise<string> {
  const wc = ctx.tabManager.activeWebContents;
  if (!wc) return 'No active tab.';

  const target = args[0]?.toLowerCase() || 'clipboard';
  const image = await wc.capturePage();

  if (target === 'clipboard') {
    clipboard.writeImage(image);
    return 'Screenshot copied to clipboard.';
  }

  const filePath = args[1] || path.join(
    process.env.HOME || '.',
    'Downloads',
    `tappi-screenshot-${Date.now()}.png`
  );
  fs.writeFileSync(filePath, image.toPNG());
  return `Screenshot saved: ${filePath}`;
}


// ─── Browser State Generator ───

export function getBrowserState(ctx: BrowserContext): string {
  const tabCount = ctx.tabManager.tabCount;
  const active = ctx.tabManager.activeTabId;
  const wc = ctx.tabManager.activeWebContents;

  let title = 'New Tab';
  let url = '';
  let zoom = 100;

  if (wc) {
    title = wc.getTitle() || 'Untitled';
    url = wc.getURL() || '';
    // Convert zoom level to percentage
    const level = wc.getZoomLevel();
    zoom = Math.round(Math.pow(1.2, level) * 100);
  }

  const dm = darkModeCSSKeys.has(wc?.id?.toString() || '') ? 'ON' : 'OFF';

  let adBlockStatus = 'OFF';
  let adBlockCount = 0;
  try {
    const { isAdBlockerEnabled, getBlockedCount } = require('./ad-blocker');
    if (isAdBlockerEnabled()) {
      adBlockStatus = 'ON';
      adBlockCount = getBlockedCount();
    }
  } catch {}

  const lines: string[] = [];
  lines.push(`Page: ${title}`);
  lines.push(`URL: ${url}`);
  if (adBlockStatus === 'ON') lines.push(`🛡 ${adBlockCount} ads blocked`);

  return lines.join('\n');
}

export async function bMedia(ctx: BrowserContext, args: string[]): Promise<string> {
  const action = (args[0] || '').toLowerCase();
  const activeId = ctx.tabManager.activeTabId;
  if (!activeId) return 'No active tab.';

  try {
    const { toggleOverlay, mediaStatus, mediaSeek, mediaVolume, setQuality, isMediaEngineAvailable } = require('./media-engine');

    if (!isMediaEngineAvailable()) {
      return '⚠️ mpv not installed. Run: brew install mpv';
    }

    if (!action || action === 'toggle') {
      const result = await toggleOverlay(activeId);
      if (result.success) {
        return result.active
          ? '🎬 mpv overlay activated'
          : '⏹ mpv overlay deactivated';
      }
      return `❌ ${result.error}`;
    }

    if (action === 'status') {
      const status = await mediaStatus(activeId);
      return JSON.stringify(status, null, 2);
    }

    if (action === 'seek') {
      const pos = parseFloat(args[1] || '0');
      return mediaSeek(activeId, pos);
    }

    if (action === 'volume') {
      const vol = parseInt(args[1] || '100', 10);
      return mediaVolume(activeId, vol);
    }

    if (action === 'quality') {
      const q = (args[1] || 'best') as 'best' | '1080p' | '720p' | '480p';
      setQuality(activeId, q);
      return `Quality set to ${q}`;
    }

    return 'Usage: B19 toggle|status|seek <sec>|volume <0-100>|quality <best|1080p|720p|480p>';
  } catch (e: any) {
    return `Media error: ${e.message}`;
  }
}

export function getBrowserMenu(): string {
  // Compact B-command menu — always injected, ~100 tokens
  return [
    '',
    'Browser Actions:',
    '[B0] dark_mode(on|off)  [B1] ad_blocker(on|off|status|exception)  [B2] cookies(list|delete)',
    '[B3] history(search|clear)  [B5] downloads(cancel|clear)  [B6] tab(close|mute|pin|dup|others|right)',
    '[B7] bookmark  [B8] zoom(in|out|reset)  [B9] find(text)  [B10] print [pdf]',
    '[B14] navigate(url)  [B15] search(query)  [B16] back|forward  [B17] screenshot(clipboard|file)',
    '[B19] media(toggle|status|seek|volume|quality)  — mpv overlay control',
  ].join('\n');
}


// ─── B-Command Dispatch Table ───

const B_COMMANDS: Record<string, (ctx: BrowserContext, args: string[]) => Promise<string>> = {
  B0: bDarkMode,
  B1: bAdBlocker,
  B2: bCookies,
  B3: bHistory,
  B5: bDownloads,
  B6: bTab,
  B7: bBookmark,
  B8: bZoom,
  B9: bFind,
  B10: bPrint,
  B14: bNavigate,
  B15: bSearch,
  B16: bBackForward,
  B17: bScreenshot,
  B19: bMedia,
};

export function executeBCommand(ctx: BrowserContext, command: string, args: string[]): Promise<string> {
  const handler = B_COMMANDS[command];
  if (!handler) return Promise.resolve(`Unknown browser command: ${command}. Available: ${Object.keys(B_COMMANDS).join(', ')}`);
  return handler(ctx, args);
}
