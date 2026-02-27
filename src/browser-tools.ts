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
import { profileManager } from './profile-manager';
import * as fs from 'fs';
import * as path from 'path';

export interface BrowserContext {
  window: BrowserWindow;
  tabManager: TabManager;
  config: any;
}

// ─── Dark Mode CSS ───

const DARK_MODE_CSS = `
  :root {
    color-scheme: dark !important;
  }
  html {
    background-color: #1a1a2e !important;
    color: #e0e0e0 !important;
  }
  body {
    background-color: #1a1a2e !important;
    color: #e0e0e0 !important;
  }
  /* Main containers — darken backgrounds */
  main, article, section, aside, nav, header, footer,
  div, form, fieldset, details, dialog, summary,
  table, thead, tbody, tfoot, tr, th, td {
    background-color: inherit !important;
    color: inherit !important;
    border-color: #333 !important;
  }
  /* Override bright backgrounds */
  [style*="background-color: rgb(255"],
  [style*="background-color: white"],
  [style*="background-color:#fff"],
  [style*="background: rgb(255"],
  [style*="background: white"],
  [style*="background:#fff"] {
    background-color: #1a1a2e !important;
  }
  /* Links */
  a, a:visited { color: #7aa2f7 !important; }
  a:hover { color: #89b4fa !important; }
  /* Inputs */
  input, textarea, select, button {
    background-color: #232340 !important;
    color: #e0e0e0 !important;
    border-color: #444 !important;
  }
  /* Code blocks */
  pre, code, .highlight {
    background-color: #16162a !important;
    color: #c0caf5 !important;
  }
  /* Images, videos, canvases stay untouched */
  img, video, canvas, picture, svg, iframe {
    /* do NOT invert — leave media as-is */
  }
  /* Scrollbar */
  ::-webkit-scrollbar { background: #1a1a2e; width: 10px; }
  ::-webkit-scrollbar-thumb { background: #444; border-radius: 5px; }
  ::-webkit-scrollbar-thumb:hover { background: #555; }
`;

const darkModeCSSKeys = new Map<string, string>(); // webContents id → CSS key

// ─── Return Enrichment Helpers ───

/**
 * Wait for a WebContents to finish loading (did-finish-load or did-fail-load),
 * with a configurable timeout. Resolves once either event fires or timeout elapses.
 */
export function waitForLoad(wc: WebContents, timeoutMs = 4000): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const timer = setTimeout(finish, timeoutMs);
    wc.once('did-finish-load', () => { clearTimeout(timer); finish(); });
    wc.once('did-fail-load', () => { clearTimeout(timer); finish(); });
  });
}

/**
 * Wait for a page to have meaningful rendered content.
 * First waits for the document to load (did-finish-load / did-stop-loading),
 * then polls for non-trivial body text — handles JS-heavy SPAs that render
 * content after the initial HTML load (React, Next.js, etc.).
 */
export async function waitForContent(wc: WebContents, timeoutMs = 6000): Promise<void> {
  // Phase 1: Wait for document load
  await waitForLoad(wc, Math.min(timeoutMs, 4000));

  // Phase 2: Poll for rendered content (handles SPA hydration)
  const deadline = Date.now() + Math.max(timeoutMs - 4000, 2000);
  while (Date.now() < deadline) {
    try {
      const len = await wc.executeJavaScript(
        `(document.body && document.body.innerText) ? document.body.innerText.trim().length : 0`
      );
      if (len > 200) return; // Page has meaningful content
    } catch { return; } // Page destroyed or navigated, bail
    await new Promise(r => setTimeout(r, 300));
  }
}

/**
 * Lightweight page-type detection — runs AFTER the page has loaded.
 * Returns a short string tag describing the page type.
 */
async function detectPageType(wc: WebContents): Promise<string> {
  try {
    const info = await wc.executeJavaScript(`(() => {
      const url = location.href;

      // Canvas apps (URL pattern match — cheapest)
      if (/docs\\.google\\.com\\/(spreadsheets|presentation)/.test(url)) return 'canvas:sheets';
      if (/figma\\.com\\/file/.test(url)) return 'canvas:figma';
      if (/excalidraw\\.com/.test(url)) return 'canvas:draw';
      if (/canva\\.com\\/design/.test(url)) return 'canvas:canva';

      // Canvas apps (DOM check — slightly more expensive)
      const canvases = document.querySelectorAll('canvas');
      const viewportArea = window.innerWidth * window.innerHeight;
      let canvasArea = 0;
      canvases.forEach(c => { canvasArea += c.offsetWidth * c.offsetHeight; });
      if (canvasArea > viewportArea * 0.5) return 'canvas:generic';

      // Login form
      if (document.querySelector('input[type="password"]')) return 'login';

      // Media page
      const video = document.querySelector('video');
      if (video && video.offsetWidth > 300) return 'media';

      // Search results (common patterns)
      if (/\\/search|[?&]q=/.test(url)) return 'search';

      // PDF viewer
      if (url.endsWith('.pdf') || document.querySelector('embed[type="application/pdf"]')) return 'pdf';

      // Minimal DOM — might be loading SPA
      const interactiveCount = document.querySelectorAll('a, button, input, select, textarea, [role="button"]').length;
      if (interactiveCount < 3 && document.body.innerText.trim().length < 100) return 'loading';

      return 'standard';
    })()`);
    return info;
  } catch { return 'standard'; }
}

/**
 * Maps page type tags to contextual hints for the agent.
 */
function pageTypeHint(pageType: string): string {
  switch (pageType) {
    case 'canvas:sheets':
      return '📊 Google Sheets — elements() indexes toolbar, menus, tabs, and formula bar. For the cell grid: use keys() (arrow keys, F2 to edit, Enter to confirm) and screenshot() + click_xy/double_click_xy for visual interaction.';
    case 'canvas:figma':
      return '🎨 Figma — elements() indexes toolbar, panels, and layer tree. For the design canvas: use screenshot() + click_xy/double_click_xy, and keys() for tool shortcuts (V/R/T/P).';
    case 'canvas:draw':
      return '✏️ Excalidraw — elements() indexes the toolbar. For canvas: use keys() (1-8 for tools) and screenshot() + click_xy for shapes.';
    case 'canvas:canva':
      return '🖼️ Canva — elements() indexes side panels and toolbar. For design canvas: screenshot() + click_xy/double_click_xy.';
    case 'canvas:generic':
      return '⚠️ Canvas-rendered page — elements() indexes any DOM overlays. For canvas content: keys() for shortcuts, screenshot() + click_xy/double_click_xy for visual interaction.';
    case 'login':
      return '🔐 Login form detected. Use elements() to see form fields.';
    case 'media':
      return '🎬 Media page detected. media_toggle for mpv overlay, keys("space") for play/pause.';
    case 'search':
      return '🔍 Search results loaded. elements() to see result links, text(grep: "keyword") to scan snippets.';
    case 'pdf':
      return '📄 PDF page — text() for content extraction, screenshot for visual layout.';
    case 'loading':
      return '⏳ Page appears to still be loading (minimal DOM). Try wait(1500) then elements().';
    default:
      return '💡 Page loaded. Call elements() to see interactive elements.';
  }
}

// ─── B-Command Implementations ───

export async function bDarkMode(ctx: BrowserContext, args: string[]): Promise<string> {
  const wc = ctx.tabManager.activeWebTabWebContents;
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
  // Use the active profile's session for cookie isolation
  const profileSession = session.fromPartition(profileManager.getSessionPartition());

  if (action === 'list') {
    const filter = domain ? { domain } : {};
    const cookies = await profileSession.cookies.get(filter);
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
      await profileSession.clearStorageData({ storages: ['cookies'] });
      return 'All cookies deleted.';
    }
    const cookies = await profileSession.cookies.get({ domain });
    for (const c of cookies) {
      const url = `http${c.secure ? 's' : ''}://${c.domain?.replace(/^\./, '') || domain}${c.path || '/'}`;
      await profileSession.cookies.remove(url, c.name);
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

  // Switch: when Aria is active, use soft targeting (agent targets tab without
  // switching visual focus). When user is on a content tab, do a real switch.
  if (action === 'switch') {
    const target = args[1];
    if (!target) return 'Usage: B6 switch <index|id>';
    const isAriaActive = activeId === ctx.tabManager.ariaTabId;

    // Resolve target to tab ID
    const idx = parseInt(target, 10);
    let targetId: string | null = null;
    let targetTitle = 'unknown';

    if (!isNaN(idx)) {
      const tabs = ctx.tabManager.getTabList();
      if (idx < 0 || idx >= tabs.length) return `Tab index ${idx} out of range (0-${tabs.length - 1}).`;
      targetId = tabs[idx]?.id ?? null;
      targetTitle = tabs[idx]?.title ?? 'unknown';
    } else {
      targetId = target;
      const info = ctx.tabManager.getTabInfo(target);
      if (info) targetTitle = info.title;
    }

    if (!targetId) return 'Tab not found.';

    if (isAriaActive) {
      // Phase 9: Soft switch — agent targets this tab, Aria stays in focus
      ctx.tabManager.setAgentTarget(targetId);
      return `Targeting tab [${!isNaN(idx) ? idx : targetId}]: ${targetTitle} (Aria stays in focus)`;
    } else {
      // Real switch — user is browsing, honor the switch
      if (!isNaN(idx)) {
        ctx.tabManager.switchToIndex(idx);
      } else {
        ctx.tabManager.switchTab(targetId);
      }
      const active = ctx.tabManager.getTabList().find((t: any) => t.active);
      return `Switched to tab [${!isNaN(idx) ? idx : targetId}]: ${active?.title || 'unknown'}`;
    }
  }

  // List tabs
  if (action === 'list') {
    const tabs = ctx.tabManager.getTabList();
    const targetId = ctx.tabManager.agentTargetId;
    return tabs.map((t: any, i: number) => {
      const marker = t.active ? '→' : ' ';
      const icon = t.isAria ? '🪷' : '📄';
      const targeted = t.id === targetId ? ' (targeted)' : '';
      return `${marker} [${i}] ${icon} ${t.title}${targeted}`;
    }).join('\n');
  }

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
      return 'Usage: B6 switch <index>|list|close|mute|pin|duplicate|others|right';
  }
}

export async function bBookmark(ctx: BrowserContext, args: string[]): Promise<string> {
  const action = args[0]?.toLowerCase();
  const wc = ctx.tabManager.activeWebTabWebContents;
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
  const wc = ctx.tabManager.activeWebTabWebContents;
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
  const wc = ctx.tabManager.activeWebTabWebContents;
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
  const wc = ctx.tabManager.activeWebTabWebContents;
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
  // Phase 9: Open in background so Aria stays in focus for the user.
  const activeId = ctx.tabManager.activeTabId;
  if (activeId && activeId === ctx.tabManager.ariaTabId) {
    const tabId = ctx.tabManager.createTab(finalUrl, undefined, { background: true });
    ctx.tabManager.setAgentTarget(tabId); // Auto-target the new tab
    // Wait for the background tab to actually load
    const bgWc = ctx.tabManager.getWebContentsForTab(tabId);
    if (bgWc) await waitForContent(bgWc, 6000);
    const tabs = ctx.tabManager.getTabList();
    const tabIndex = tabs.findIndex((t: any) => t.id === tabId);
    return `Navigating to: ${finalUrl} (opened in tab [${tabIndex}], now targeting it)\n💡 Page loaded. Call elements() to see interactive elements.`;
  }

  const wc = ctx.tabManager.activeWebTabWebContents;
  if (!wc) return 'No active tab.';
  wc.loadURL(finalUrl);

  // Enrichment 1+2: Wait for page to render content, then detect page type and append hint
  await waitForContent(wc, 6000);
  const pageType = await detectPageType(wc);
  const hint = pageTypeHint(pageType);
  return `Navigated to: ${finalUrl}\n${hint}`;
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
  // Phase 9: Open in background so Aria stays in focus for the user.
  const activeId = ctx.tabManager.activeTabId;
  if (activeId && activeId === ctx.tabManager.ariaTabId) {
    const tabId = ctx.tabManager.createTab(searchUrl, undefined, { background: true });
    ctx.tabManager.setAgentTarget(tabId); // Auto-target the new tab
    // Wait for search results to load
    const newWc = ctx.tabManager.getWebContentsForTab(tabId);
    if (newWc) await waitForContent(newWc, 6000);
    const tabs = ctx.tabManager.getTabList();
    const tabIndex = tabs.findIndex((t: any) => t.id === tabId);
    return `Searching: "${query}" (${engine}) — opened in tab [${tabIndex}], now targeting it\n\n💡 On SERPs, use elements({ grep: 'keyword' }) → click(index) for links. text() shows visual URLs (missing paths/params). elements() has full hrefs.`;
  }

  const wc = ctx.tabManager.activeWebTabWebContents;
  if (!wc) return 'No active tab.';
  wc.loadURL(searchUrl);
  await waitForLoad(wc, 4000);
  return `Searching: "${query}" (${engine})\n\n💡 On SERPs, use elements({ grep: 'keyword' }) → click(index) for links. text() shows visual URLs (missing paths/params). elements() has full hrefs.`;
}

export async function bBackForward(ctx: BrowserContext, args: string[]): Promise<string> {
  const wc = ctx.tabManager.activeWebTabWebContents;
  if (!wc) return 'No active tab.';

  const action = args[0]?.toLowerCase();
  if (action === 'back') {
    if (!wc.canGoBack()) return 'Cannot go back — no history.';
    wc.goBack();
    await waitForLoad(wc, 4000);
    return `Went back.\n💡 Page loaded. Call elements() to see interactive elements.`;
  }
  if (action === 'forward') {
    if (!wc.canGoForward()) return 'Cannot go forward.';
    wc.goForward();
    await waitForLoad(wc, 4000);
    return `Went forward.\n💡 Page loaded. Call elements() to see interactive elements.`;
  }
  return 'Usage: B16 back|forward';
}

export async function bScreenshot(ctx: BrowserContext, args: string[]): Promise<string> {
  const wc = ctx.tabManager.activeWebTabWebContents;
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
  const wc = ctx.tabManager.activeWebTabWebContents;

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
    '[B3] history(search|clear)  [B5] downloads(cancel|clear)  [B6] tab(switch|list|close|mute|pin|dup|others|right)',
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
