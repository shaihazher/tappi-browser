import { BrowserWindow, BrowserView, session, ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { addHistory } from './database';

export interface Tab {
  id: string;
  view: BrowserView;
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
  private isFullscreen: boolean = false;
  private closedStack: ClosedTab[] = [];
  private bookmarks: Set<string> = new Set();
  private bookmarksPath: string;
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
    this.loadBookmarks();
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

  get activeTabId() { return this.activeId; }

  get ariaWebContents() {
    if (!this.ariaTabId) return null;
    return this.tabs.get(this.ariaTabId)?.view.webContents ?? null;
  }

  // Phase 8.45: API server helpers

  /** Return a flat list of all tabs (in order) for the API. */
  getTabList(): Array<{ id: string; title: string; url: string; active: boolean; isAria: boolean; isLoading: boolean; isPinned: boolean }> {
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

  /** Phase 8.35: Create the non-closeable Aria tab at index 0. */
  createAriaTab(): string {
    const id = randomUUID();
    const ariaHtmlPath = path.join(__dirname, 'ui', 'aria.html');
    const finalUrl = `file://${ariaHtmlPath}`;

    const view = new BrowserView({
      webPreferences: {
        contextIsolation: true,
        sandbox: false, // Aria tab needs IPC (preload uses ipcRenderer)
        preload: this.ariaPreloadPath,
        nodeIntegration: false,
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
    this.window.addBrowserView(view);
    this.switchTab(id);

    return id;
  }

  private loadBookmarks() {
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
      this.notifyChrome();
      return false;
    } else {
      this.bookmarks.add(normalized);
      this.saveBookmarks();
      this.notifyChrome();
      return true;
    }
  }

  isBookmarked(url: string): boolean {
    if (!url) return false;
    return this.bookmarks.has(url.replace(/\/$/, ''));
  }

  createTab(url?: string, partition?: string): string {
    const id = randomUUID();
    const finalUrl = url || `file://${this.newtabPath}`;
    const webPrefs: Electron.WebPreferences = {
      contextIsolation: true,
      sandbox: !partition, // sandbox=false when using named partition (needed for session isolation)
      preload: this.contentPreloadPath,
      enableBlinkFeatures: 'FullscreenUnprefixed',
    };
    if (partition) {
      webPrefs.partition = partition;
    }
    const view = new BrowserView({
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
      this.createTab(openUrl);
      return { action: 'deny' };
    });

    wc.on('did-start-navigation', () => {
      console.log('[tab] navigating:', tab.url);
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
      // (set by resize events during fullscreen) and the BrowserView stays
      // oversized until the OS-level leave-full-screen event fires.
      if (this.preFullscreenLayoutWidth > 0) {
        this.lastLayoutWidth = this.preFullscreenLayoutWidth;
        this.lastLayoutHeight = this.preFullscreenLayoutHeight;
        this.lastStatusBarHeight = this.preFullscreenStatusBarHeight;
      }

      // Restore BrowserView bounds to normal layout immediately so YouTube's
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
    this.window.addBrowserView(view);
    this.switchTab(id);

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

    this.window.removeBrowserView(tab.view);
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

    // Hide ALL BrowserViews, then show only the active one.
    // This prevents inactive tabs (especially the full-width Aria tab)
    // from peeking through and covering the agent strip area.
    for (const [tid, t] of this.tabs) {
      if (tid !== id) {
        this.window.removeBrowserView(t.view);
      }
    }
    // Ensure the active one is added and on top
    this.window.addBrowserView(tab.view);
    this.window.setTopBrowserView(tab.view);

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
   * Layout the active tab's BrowserView.
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

  /** Phase 8.5: Get BrowserView by tab ID (for media engine geometry calc). */
  getBrowserView(tabId: string): BrowserView | null {
    return this.tabs.get(tabId)?.view ?? null;
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
      this.window.removeBrowserView(tab.view);
    }
  }

  showAllViews() {
    for (const [, tab] of this.tabs) {
      this.window.addBrowserView(tab.view);
    }
    // Re-set the active tab on top
    if (this.activeId) {
      const active = this.tabs.get(this.activeId);
      if (active) {
        this.window.setTopBrowserView(active.view);
        this.layoutActiveTab();
      }
    }
  }

  destroy() {
    for (const [, tab] of this.tabs) {
      try { tab.view.webContents.close(); } catch {}
    }
    this.tabs.clear();
    this.order = [];
  }
}
