import { BrowserWindow, WebContentsView, session, ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { addHistory, addBookmark, removeBookmark as removeBookmarkFromDb } from './database';
import { profileManager } from './profile-manager';

export interface Tab {
  id: string;
  view: WebContentsView;
  title: string;
  url: string;
  favicon: string;
  isLoading: boolean;
  isPinned: boolean;
  isAria?: boolean;  // Phase 8.35: Aria tab (non-closeable, always at index 0)
}

interface ClosedTab {
  url: string;
  title: string;
}

export class TabManager {
  private tabs: Map<string, Tab> = new Map();
  private order: string[] = [];
  private activeId: string | null = null;
  private window: BrowserWindow;
  private chromeHeight: number;
  isFullscreen: boolean = false;
  private closedStack: ClosedTab[] = [];
  private bookmarks: Set<string> = new Set();
  private bookmarksPath: string;
  // Phase 9: Agent can target a specific tab without switching visual focus.
  // When set, activeWebTabWebContents returns this tab's webContents instead.
  private _agentTargetId: string | null = null;
  private newtabPath: string;
  private contentPreloadPath: string;
  private ariaPreloadPath: string;
  private lastLayoutWidth: number = 0;
  private lastLayoutHeight: number = 0;
  private lastStatusBarHeight: number = 0;
  // Saved pre-fullscreen layout so we can restore correctly on exit
  private preFullscreenLayoutWidth: number = 0;
  private preFullscreenLayoutHeight: number = 0;
  private preFullscreenStatusBarHeight: number = 0;
  private onWebContentsReady?: (wc: Electron.WebContents) => void;
  public ariaTabId: string | null = null;  // Phase 8.35
  // F8: Rate-limit window.open — max 3 new tabs per second per source
  private windowOpenTimestamps: Map<number, number[]> = new Map();

  constructor(window: BrowserWindow, chromeHeight: number, onWebContentsReady?: (wc: Electron.WebContents) => void) {
    this.onWebContentsReady = onWebContentsReady;
    this.window = window;
    this.chromeHeight = chromeHeight;
    this.bookmarksPath = path.join(
      process.env.HOME || process.env.USERPROFILE || '.',
      '.tappi-browser',
      'bookmarks.json'
    );
    this.newtabPath = path.join(__dirname, 'ui', 'newtab.html');
    this.contentPreloadPath = path.join(__dirname, 'content-preload.js');
    this.ariaPreloadPath = path.join(__dirname, 'aria-preload.js');
    this.reloadBookmarks();
  }

  get tabCount() { return this.tabs.size; }

  get activeWebContents() {
    if (!this.activeId) return null;
    return this.tabs.get(this.activeId)?.view.webContents ?? null;
  }

  /**
   * Returns the webContents of the active tab if it's a real web tab (not Aria),
   * otherwise falls back to the last non-Aria tab in the order.
   * Use this for all agent-driven page interactions and captures so that the
   * Aria tab never accidentally becomes the target.
   */
  get activeWebTabWebContents(): Electron.WebContents | null {
    // Phase 9: If agent has a specific target tab, use that
    if (this._agentTargetId) {
      const target = this.tabs.get(this._agentTargetId);
      if (target && !target.view.webContents.isDestroyed()) {
        return target.view.webContents;
      }
      this._agentTargetId = null; // Target was destroyed, clear it
    }
    // Prefer the active tab if it's not the Aria tab
    if (this.activeId && this.activeId !== this.ariaTabId) {
      return this.tabs.get(this.activeId)?.view.webContents ?? null;
    }
    // Fall back to the last non-Aria tab in the order
    for (let i = this.order.length - 1; i >= 0; i--) {
      const tab = this.tabs.get(this.order[i]);
      if (tab && !tab.isAria) {
        return tab.view.webContents;
      }
    }
    return null;
  }

  /** Phase 9: Set which tab the agent tools target (without switching visual focus). */
  setAgentTarget(id: string | null) {
    this._agentTargetId = id;
  }

  get agentTargetId() { return this._agentTargetId; }

  get activeTabId() { return this.activeId; }

  get ariaWebContents() {
    if (!this.ariaTabId) return null;
    return this.tabs.get(this.ariaTabId)?.view.webContents ?? null;
  }

  // Phase 8.45: API server helpers

  /** Return a flat list of all tabs (in order) for the API. */
  getTabList(): Array<{ id: string; index: number; title: string; url: string; active: boolean; isAria: boolean; isLoading: boolean; isPinned: boolean }> {
    return this.order.map((id, idx) => {
      const tab = this.tabs.get(id);
      if (!tab) return null;
      return {
        id,
        index: idx,
        title: tab.title,
        url: tab.url,
        active: id === this.activeId,
        isAria: !!tab.isAria,
        isLoading: tab.isLoading,
        isPinned: tab.isPinned,
      };
    }).filter(Boolean) as any[];
  }

  /** Get WebContents for any tab by ID (not just the active one). */
  getWebContentsForTab(tabId: string): Electron.WebContents | null {
    return this.tabs.get(tabId)?.view.webContents ?? null;
  }

  /** Get tab ID by 0-based index. */
  getTabIdByIndex(index: number): string | null {
    return this.order[index] ?? null;
  }

  /** Get all tab IDs (copy of order array). */
  getAllTabIds(): string[] {
    return [...this.order];
  }

  /** Phase 8.35: Create the non-closeable Aria tab at index 0. */
  createAriaTab(): string {
    const id = randomUUID();
    const ariaHtmlPath = path.join(__dirname, 'ui', 'aria.html');
    const finalUrl = `file://${ariaHtmlPath}`;

    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        preload: this.ariaPreloadPath,
        nodeIntegration: false,
        webSecurity: true,
      },
    });

    const tab: Tab = {
      id,
      view,
      title: '🪷 Aria',
      url: finalUrl,
      favicon: '',
      isLoading: true,
      isPinned: false,
      isAria: true,
    };
    this.tabs.set(id, tab);
    // Always insert at the front of the order
    this.order.unshift(id);
    this.ariaTabId = id;

    const wc = view.webContents;

    wc.on('did-stop-loading', () => {
      tab.isLoading = false;
      this.notifyChrome();
    });

    wc.on('did-start-loading', () => {
      tab.isLoading = true;
      this.notifyChrome();
    });

    wc.loadURL(finalUrl);
    this.window.contentView.addChildView(view);
    this.switchTab(id);

    return id;
  }

  reloadBookmarks() {
    try {
      if (fs.existsSync(this.bookmarksPath)) {
        const data = JSON.parse(fs.readFileSync(this.bookmarksPath, 'utf-8'));
        this.bookmarks = new Set(data);
      }
    } catch {}
  }

  private saveBookmarks() {
    try {
      const dir = path.dirname(this.bookmarksPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.bookmarksPath, JSON.stringify([...this.bookmarks], null, 2));
    } catch (e) {
      console.error('[bookmarks] save failed:', e);
    }
  }

  toggleBookmark(url: string): boolean {
    if (!url || url === 'about:blank' || url.startsWith('file://')) return false;
    const normalized = url.replace(/\/$/, '');
    if (this.bookmarks.has(normalized)) {
      this.bookmarks.delete(normalized);
      this.saveBookmarks();
      // Also remove from database
      try { 
        removeBookmarkFromDb(normalized); 
      } catch (e) {
        console.error('[tab-manager] Failed to remove bookmark from DB:', e);
      }
      this.notifyChrome();
      return false;
    } else {
      this.bookmarks.add(normalized);
      this.saveBookmarks();
      // Also add to database
      try { 
        addBookmark(normalized); 
      } catch (e) {
        console.error('[tab-manager] Failed to add bookmark to DB:', e);
      }
      this.notifyChrome();
      return true;
    }
  }

  isBookmarked(url: string): boolean {
    if (!url) return false;
    return this.bookmarks.has(url.replace(/\/$/, ''));
  }

  createTab(url?: string, partition?: string, opts?: { background?: boolean }): string {
    const id = randomUUID();
    const finalUrl = url || `file://${this.newtabPath}`;
    const webPrefs: Electron.WebPreferences = {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: this.contentPreloadPath,
      enableBlinkFeatures: 'FullscreenUnprefixed',
    };
    // Use the active profile's session partition by default for cookie/storage isolation.
    // Explicit partition (e.g. site-identity sessions) takes priority.
    webPrefs.partition = partition || profileManager.getSessionPartition();
    const view = new WebContentsView({
      webPreferences: webPrefs,
    });

    const tab: Tab = { id, view, title: 'New Tab', url: finalUrl, favicon: '', isLoading: true, isPinned: false };
    this.tabs.set(id, tab);
    this.order.push(id);

    const wc = view.webContents;

    wc.on('page-title-updated', (_e, title) => {
      tab.title = title;
      this.notifyChrome();
    });

    wc.on('did-start-loading', () => {
      tab.isLoading = true;
      this.notifyChrome();
    });

    wc.on('did-stop-loading', () => {
      tab.isLoading = false;
      this.notifyChrome();
    });

    wc.on('did-navigate', (_e, navUrl) => {
      tab.url = navUrl;
      // Record history
      try { addHistory(navUrl, tab.title); } catch {}
      this.notifyChrome();
    });

    wc.on('did-navigate-in-page', (_e, navUrl) => {
      tab.url = navUrl;
      this.notifyChrome();
    });

    wc.on('page-favicon-updated', (_e, favicons) => {
      tab.favicon = favicons[0] || '';
      this.notifyChrome();
    });

    // Forward find-in-page results to chrome UI
    wc.on('found-in-page', (_e, result) => {
      this.window.webContents.send('find:result', {
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
      });
    });

    wc.setWindowOpenHandler(({ url: openUrl }) => {
      // F8: Rate-limit — max 3 new tabs per second per source webContents
      const wcId = wc.id;
      const now = Date.now();
      let timestamps = this.windowOpenTimestamps.get(wcId);
      if (!timestamps) {
        timestamps = [];
        this.windowOpenTimestamps.set(wcId, timestamps);
      }
      // Remove timestamps older than 1 second
      const cutoff = now - 1000;
      while (timestamps.length > 0 && timestamps[0] < cutoff) timestamps.shift();
      if (timestamps.length >= 3) {
        console.warn('[tab] Rate-limited window.open from webContents', wcId);
        return { action: 'deny' };
      }
      timestamps.push(now);

      // If Aria is the active tab, keep new tabs in the background
      // so the user's chat view isn't interrupted by page popups/redirects.
      const isAriaActive = this.activeId === this.ariaTabId;
      this.createTab(openUrl, undefined, isAriaActive ? { background: true } : undefined);
      return { action: 'deny' };
    });

    // Intercept non-standard URL schemes before Chromium tries to load them
    // (prevents SIGSEGV crashes from unknown scheme navigation)
    wc.on('will-frame-navigate', (e: any) => {
      const url: string = e.url;
      if (/^(https?|file|chrome-extension|about|data|blob|javascript):\/?\/?/i.test(url)) return;
      e.preventDefault();
      console.log('[tab] Delegating custom scheme to OS:', url);
      const { spawn } = require('child_process');
      if (process.platform === 'darwin') {
        spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
      } else if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
      } else {
        spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
      }
    });

    wc.on('did-start-navigation', (_e: any, url: string, isInPlace: boolean, isMainFrame: boolean) => {
      // Only log main frame navigations to reduce noise from SPA routing/redirects
      if (isMainFrame && !isInPlace) {
        console.log('[tab] navigating:', url);
      }
    });

    // Handle tab crashes — auto-reload
    wc.on('render-process-gone', (_e, details) => {
      console.error(`[tab] Renderer crashed (${details.reason}):`, tab.url);
      tab.title = '⚠️ Crashed';
      this.notifyChrome();
      // Auto-reload after a short delay
      setTimeout(() => {
        try {
          if (!wc.isDestroyed()) wc.reload();
        } catch {}
      }, 1500);
    });

    wc.on('unresponsive', () => {
      console.warn('[tab] Unresponsive:', tab.url);
      tab.title = '⏳ ' + tab.title;
      this.notifyChrome();
    });

    wc.on('responsive', () => {
      this.notifyChrome();
    });

    wc.on('enter-html-full-screen', () => {
      console.log('[tab] ENTER fullscreen fired');
      // Save pre-fullscreen layout so we can restore accurately on exit.
      // lastLayout* gets overwritten by resize events while in fullscreen,
      // so we must capture it NOW before setFullScreen(true) triggers a resize.
      this.preFullscreenLayoutWidth = this.lastLayoutWidth;
      this.preFullscreenLayoutHeight = this.lastLayoutHeight;
      this.preFullscreenStatusBarHeight = this.lastStatusBarHeight;
      this.isFullscreen = true;
      this.window.setFullScreen(true);
      setTimeout(() => {
        const [w, h] = this.window.getContentSize();
        view.setBounds({ x: 0, y: 0, width: w, height: h });
      }, 100);
    });

    wc.on('leave-html-full-screen', () => {
      console.log('[tab] LEAVE fullscreen fired');
      this.isFullscreen = false;

      // Restore pre-fullscreen layout values before calling layoutActiveTab().
      // Without this, lastLayoutWidth/Height contain the fullscreen dimensions
      // (set by resize events during fullscreen) and the WebContentsView stays
      // oversized until the OS-level leave-full-screen event fires.
      if (this.preFullscreenLayoutWidth > 0) {
        this.lastLayoutWidth = this.preFullscreenLayoutWidth;
        this.lastLayoutHeight = this.preFullscreenLayoutHeight;
        this.lastStatusBarHeight = this.preFullscreenStatusBarHeight;
      }

      // Restore WebContentsView bounds to normal layout immediately so YouTube's
      // JS sees the correct viewport size and exits its fullscreen player mode.
      this.layoutActiveTab();

      // Also tell the OS window to exit fullscreen.
      // The mainWindow 'leave-full-screen' event will call layoutViews() again
      // once the animation completes, ensuring final correct bounds.
      this.window.setFullScreen(false);

      // Safety-net: re-layout after the OS fullscreen animation ends (~600 ms on macOS).
      // Handles cases where leave-full-screen fires before the window has fully resized.
      setTimeout(() => {
        if (!this.isFullscreen) {
          this.layoutActiveTab();
        }
      }, 700);
    });

    // Notify callback (for page context menu setup, etc.)
    if (this.onWebContentsReady) {
      this.onWebContentsReady(wc);
    }

    wc.loadURL(finalUrl);
    this.window.contentView.addChildView(view);
    if (opts?.background) {
      // Background tab: add view with proper bounds so Chromium renders it
      // (needed for capturePage/screenshots). Then re-add the active tab on top
      // since Electron's last addChildView is highest z-order.
      const [contentW, contentH] = this.window.getContentSize();
      const w = this.lastLayoutWidth || contentW;
      const h = this.lastLayoutHeight || contentH;
      const sbh = this.lastStatusBarHeight || 0;
      const extra = this.lastExtraChrome || 0;
      view.setBounds({
        x: 0,
        y: this.chromeHeight + extra,
        width: w,
        height: h - this.chromeHeight - extra - sbh,
      });
      // Re-add the active tab so it stays on top (last child = highest z-order)
      if (this.activeId) {
        const activeTab = this.tabs.get(this.activeId);
        if (activeTab) {
          this.window.contentView.removeChildView(activeTab.view);
          this.window.contentView.addChildView(activeTab.view);
        }
      }
      this.notifyChrome(); // Update tab bar to show the new tab
    } else {
      this.switchTab(id);
    }

    return id;
  }

  closeTab(id: string) {
    const tab = this.tabs.get(id);
    if (!tab) return;

    // Phase 8.35: Aria tab cannot be closed
    if (tab.isAria) return;

    if (tab.url && !tab.url.startsWith('file://') && tab.url !== 'about:blank') {
      this.closedStack.push({ url: tab.url, title: tab.title });
      if (this.closedStack.length > 20) this.closedStack.shift();
    }

    this.window.contentView.removeChildView(tab.view);
    tab.view.webContents.close();

    this.tabs.delete(id);
    const idx = this.order.indexOf(id);
    this.order = this.order.filter(oid => oid !== id);

    if (this.activeId === id) {
      this.activeId = null;
      if (this.order.length > 0) {
        const newIdx = Math.min(idx, this.order.length - 1);
        this.switchTab(this.order[newIdx]);
      }
    }
    this.notifyChrome();
  }

  reopenClosedTab(): string | null {
    if (this.closedStack.length === 0) return null;
    const closed = this.closedStack.pop()!;
    return this.createTab(closed.url);
  }

  switchTab(id: string) {
    const tab = this.tabs.get(id);
    if (!tab) return;

    // Hide ALL WebContentsViews, then show only the active one.
    // This prevents inactive tabs (especially the full-width Aria tab)
    // from peeking through and covering the agent strip area.
    for (const [tid, t] of this.tabs) {
      if (tid !== id) {
        this.window.contentView.removeChildView(t.view);
      }
    }
    // Add the active one last — last child is on top with WebContentsView
    this.window.contentView.addChildView(tab.view);

    this.activeId = id;
    this.layoutActiveTab();
    this.notifyChrome();
  }

  switchToIndex(index: number) {
    if (index < 0 || index >= this.order.length) return;
    this.switchTab(this.order[index]);
  }

  switchToLast() {
    if (this.order.length === 0) return;
    this.switchTab(this.order[this.order.length - 1]);
  }

  navigate(id: string, url: string) {
    const tab = this.tabs.get(id);
    if (!tab) return;

    let finalUrl = url;
    if (!/^https?:\/\//i.test(url) && !/^file:\/\//i.test(url)) {
      if (/^[^\s]+\.[^\s]+$/.test(url)) {
        finalUrl = 'https://' + url;
      } else {
        finalUrl = `https://www.google.com/search?q=${encodeURIComponent(url)}`;
      }
    }
    tab.view.webContents.loadURL(finalUrl);
  }

  duplicateTab(id: string): string | null {
    const tab = this.tabs.get(id);
    if (!tab) return null;
    return this.createTab(tab.url);
  }

  pinTab(id: string) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.isPinned = !tab.isPinned;

    if (tab.isPinned) {
      this.order = this.order.filter(oid => oid !== id);
      const firstUnpinned = this.order.findIndex(oid => !this.tabs.get(oid)?.isPinned);
      if (firstUnpinned === -1) {
        this.order.push(id);
      } else {
        this.order.splice(firstUnpinned, 0, id);
      }
    }
    this.notifyChrome();
  }

  closeOtherTabs(id: string) {
    const toClose = this.order.filter(oid => oid !== id && !this.tabs.get(oid)?.isPinned && !this.tabs.get(oid)?.isAria);
    toClose.forEach(oid => this.closeTab(oid));
  }

  closeTabsToRight(id: string) {
    const idx = this.order.indexOf(id);
    if (idx === -1) return;
    const toClose = this.order.slice(idx + 1).filter(oid => !this.tabs.get(oid)?.isPinned);
    toClose.forEach(oid => this.closeTab(oid));
  }

  reorderTab(id: string, newIndex: number) {
    const oldIndex = this.order.indexOf(id);
    if (oldIndex === -1 || oldIndex === newIndex) return;

    const tab = this.tabs.get(id);
    if (!tab) return;

    // Phase 8.35: Aria tab always stays at index 0, can't be moved
    if (tab.isAria) return;
    // Don't allow moving other tabs before the Aria tab
    const ariaIdx = this.ariaTabId ? this.order.indexOf(this.ariaTabId) : -1;
    if (ariaIdx >= 0 && newIndex <= ariaIdx) return;

    const firstUnpinned = this.order.findIndex(oid => !this.tabs.get(oid)?.isPinned);
    if (tab.isPinned && newIndex >= firstUnpinned && firstUnpinned !== -1) return;
    if (!tab.isPinned && firstUnpinned !== -1 && newIndex < firstUnpinned) return;

    this.order.splice(oldIndex, 1);
    this.order.splice(newIndex, 0, id);
    this.notifyChrome();
  }

  muteTab(id: string) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const wc = tab.view.webContents;
    wc.setAudioMuted(!wc.isAudioMuted());
    this.notifyChrome();
  }

  /**
   * Layout the active tab's WebContentsView.
   * @param availableWidth - width available for the tab (excluding agent panel)
   * @param totalHeight - total content height
   * @param statusBarHeight - height reserved for status bar at bottom
   */
  private lastExtraChrome: number = 0;

  layoutActiveTab(availableWidth?: number, totalHeight?: number, statusBarHeight?: number, extraChromeHeight?: number) {
    if (!this.activeId) return;
    const tab = this.tabs.get(this.activeId);
    if (!tab) return;
    const [contentW, contentH] = this.window.getContentSize();

    // Store last known values for when called without args (e.g. from switchTab)
    if (availableWidth !== undefined) this.lastLayoutWidth = availableWidth;
    if (totalHeight !== undefined) this.lastLayoutHeight = totalHeight;
    if (statusBarHeight !== undefined) this.lastStatusBarHeight = statusBarHeight;
    if (extraChromeHeight !== undefined) this.lastExtraChrome = extraChromeHeight;

    const w = this.lastLayoutWidth || contentW;
    const h = this.lastLayoutHeight || contentH;
    const sbh = this.lastStatusBarHeight || 0;
    const extra = this.lastExtraChrome || 0;

    if (this.isFullscreen) {
      tab.view.setBounds({ x: 0, y: 0, width: contentW, height: contentH });
    } else {
      tab.view.setBounds({
        x: 0,
        y: this.chromeHeight + extra,
        width: w,
        height: h - this.chromeHeight - extra - sbh,
      });
    }
  }

  getTabInfo(id: string) {
    const tab = this.tabs.get(id);
    if (!tab) return null;
    return {
      id: tab.id,
      title: tab.title,
      url: tab.url,
      isPinned: tab.isPinned,
      isMuted: tab.view.webContents.isAudioMuted(),
    };
  }

  /** Phase 8.95: Get WebContentsView by tab ID (primary method). */
  getView(tabId: string): WebContentsView | null {
    return this.tabs.get(tabId)?.view ?? null;
  }

  /**
   * Phase 8.5 / 8.95: Backward-compatible alias for getView().
   * Kept for media-engine.ts until it is updated to call getView() directly.
   */
  getBrowserView(tabId: string): WebContentsView | null {
    return this.getView(tabId);
  }

  /** Phase 8.5: Find tab ID by webContents ID (for media IPC event routing). */
  getTabIdByWebContentsId(wcId: number): string | null {
    for (const [id, tab] of this.tabs) {
      if (tab.view.webContents.id === wcId) return id;
    }
    return null;
  }

  private notifyChrome() {
    const tabData = this.order.map(id => {
      const tab = this.tabs.get(id)!;
      return {
        id: tab.id,
        title: tab.title,
        url: tab.url,
        favicon: tab.favicon,
        isLoading: tab.isLoading,
        isActive: tab.id === this.activeId,
        isPinned: tab.isPinned,
        isMuted: tab.view.webContents.isAudioMuted(),
        isBookmarked: this.isBookmarked(tab.url),
        isAria: !!tab.isAria,
      };
    });
    this.window.webContents.send('tabs:updated', tabData);
  }

  hideAllViews() {
    for (const [, tab] of this.tabs) {
      this.window.contentView.removeChildView(tab.view);
    }
  }

  showAllViews() {
    // Only re-add the active tab — inactive tabs stay hidden.
    // The old BrowserView code re-added everything, which caused the Aria tab
    // to "peek through" in the agent strip gap. With WebContentsView, only
    // the active tab should ever be a child view.
    if (this.activeId) {
      const active = this.tabs.get(this.activeId);
      if (active) {
        this.window.contentView.addChildView(active.view);
        this.layoutActiveTab();
      }
    }
  }

  destroy() {
    for (const [, tab] of this.tabs) {
      // WebContentsView does NOT auto-destroy webContents on window close,
      // so explicit cleanup here is critical.
      try { tab.view.webContents.close(); } catch {}
    }
    this.tabs.clear();
    this.order = [];
  }
}
