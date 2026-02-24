import { app, BrowserWindow, ipcMain, session, Menu, safeStorage, dialog, shell } from 'electron';
// Phase 8.5: Media Engine
import {
  initMediaEngine,
  initTabMedia,
  destroyTabMedia,
  onTabHidden,
  onTabShown,
  onTabNavigated,
  handleVideoDetected,
  handleVideoGeometryChanged,
  handleVideoPlayPause,
  handleVideoSeeked,
  isMediaEngineAvailable,
} from './media-engine';

process.on('uncaughtException', (e) => console.error('[CRASH]', e));
process.on('unhandledRejection', (e) => console.error('[REJECT]', e));
import * as path from 'path';
import * as fs from 'fs';
import { TabManager } from './tab-manager';
import { executeCommand, getMenu, type ExecutorContext } from './command-executor';
import type { BrowserContext } from './browser-tools';
import { runAgent, stopAgent, clearHistory, agentProgressData, interruptMainSession } from './agent';
import { interruptSubtask } from './subtask-runner';
import { loadServices, registerService, removeService, storeApiKey, getApiKey, listApiKeys, deleteApiKey } from './http-tools';
import { initDatabase, getDb, closeDatabase, reinitDatabase, addHistory, searchHistory, getRecentHistory, clearHistory as clearDbHistory, migrateBookmarksFromJson, getPermission, setPermission, getAllBookmarks, searchBookmarks, removeBookmark } from './database';
import { profileManager } from './profile-manager';
import { sessionManager } from './session-manager';
import { startAdBlocker, stopAdBlocker, isAdBlockerEnabled, getBlockedCount, resetBlockedCount, addSiteException, removeSiteException, toggleAdBlocker } from './ad-blocker';
import { initDownloadManager, getDownloadsSummary, getAllDownloads, cancelDownload, clearCompleted, getActiveDownloads } from './download-manager';
import { storePassword, getPasswordsForDomain, getPasswordForAutofill, removePassword, listSavedDomains, generatePassword, buildAutofillScript, listIdentities } from './password-vault';
import { setLoginHint, clearLoginHint } from './login-state';
import { checkCredentials, testConnection } from './credential-checker';
import { getDefaultModel } from './llm-client';
import { loadTools, verifyAllTools } from './tool-manager';
import { setProjectUpdateCallback } from './tool-registry';
import { cleanupAll as cleanupShell } from './shell-tools';
import { cleanupAllSubAgents } from './sub-agent';
import { cleanupAllTeams, getActiveTeam, getTeamStatusUI, setTeamUpdateCallback, interruptTeammate, getActiveTeamId } from './team-manager';
import { scheduleProfileUpdate, deleteProfile, loadUserProfileTxt, saveUserProfileTxt, loadProfile, generateProfile } from './user-profile';
import { purgeSession } from './output-buffer';
import { initCronManager, updateCronContext, addJob as cronAddJob, listJobs as cronListJobs, updateJob as cronUpdateJob, deleteJob as cronDeleteJob, runJobNow as cronRunJobNow, getJobsList, getActiveJobCount, cleanupCron } from './cron-manager';
import {
  createConversation,
  listConversations,
  deleteConversation as deleteConvFromStore,
  updateConversationTitle,
  getConversationMessages,
  searchConversations,
} from './conversation-store';
import {
  createProject,
  getProject,
  listProjects,
  getArtifacts,
  linkConversation as linkConvToProject,
  getProjectConversations,
} from './project-manager';
// Phase 8.6: Self-Capture
import { captureCleanupOnQuit, getRecordingStatus, handleRecord } from './capture-tools';
// Phase 8.45: Local HTTP API server
import { startApiServer, stopApiServer, ensureApiToken, API_PORT } from './api-server';

let mainWindow: BrowserWindow;
let tabManager: TabManager;
let activeConversationId: string | null = null;  // Phase 8.35

const CHROME_HEIGHT = 74; // tab bar (38) + address bar (36)
const STATUS_BAR_HEIGHT = 34;
const AGENT_STRIP_WIDTH = 40;
const AGENT_PANEL_WIDTH = 380;

let agentPanelOpen = false;

// ─── Config ───
const CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.tappi-browser');

// Initialize profile manager early so we can resolve profile-relative paths
profileManager.initialize();

function getConfigPath(): string {
  return profileManager.getConfigPath();
}

// Legacy flat path (fallback)
const CONFIG_PATH_LEGACY = path.join(CONFIG_DIR, 'config.json');

interface TappiConfig {
  llm: {
    provider: string;
    model: string;
    apiKey: string; // encrypted — active provider's key (kept for backward compat)
    providerApiKeys?: Record<string, string>; // encrypted keys per provider (Phase 9.1)
    thinking?: boolean;      // true = medium thinking (default), false = off
    deepMode?: boolean;      // true = deep mode (default), false = always direct
    codingMode?: boolean;    // true = team tools + coding system prompt (Phase 8.38)
    worktreeIsolation?: boolean; // Phase 8.39: git worktree per teammate (default: true when codingMode + git repo)
    // Cloud provider fields
    region?: string;         // Bedrock: AWS region
    projectId?: string;      // Vertex: GCP project ID
    location?: string;       // Vertex: GCP location
    endpoint?: string;       // Azure: resource endpoint URL
    baseUrl?: string;        // Ollama/OpenRouter: custom base URL
    // Secondary model fields (Phase 8.85)
    secondaryProvider?: string;  // defaults to same as primary
    secondaryModel?: string;     // if unset, secondary == primary (no separate secondary)
    secondaryApiKey?: string;    // encrypted; defaults to same as primary
    // Timeout fields (Phase 8.40)
    agentTimeoutMs?: number;      // main agent timeout (default: 1800000 = 30 min)
    teammateTimeoutMs?: number;   // per-teammate timeout (default: 1800000 = 30 min)
    subtaskTimeoutMs?: number;    // per deep-mode subtask timeout (default: 300000 = 5 min)
  };
  searchEngine: string;
  features: {
    adBlocker: boolean;
    darkMode: boolean;
  };
  developerMode: boolean;
  privacy?: {
    agentBrowsingDataAccess?: boolean;
    profileEnrichHistory?: boolean;
    profileEnrichBookmarks?: boolean;
  };
}

const DEFAULT_CONFIG: TappiConfig = {
  llm: { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: '', thinking: true, deepMode: true, codingMode: false, worktreeIsolation: true, agentTimeoutMs: 1_800_000, teammateTimeoutMs: 1_800_000, subtaskTimeoutMs: 300_000 },
  searchEngine: 'google',
  features: { adBlocker: false, darkMode: false },
  developerMode: false,
  privacy: { agentBrowsingDataAccess: false, profileEnrichHistory: true, profileEnrichBookmarks: true },
};

function loadConfig(): TappiConfig {
  try {
    // Try profile-relative path first
    const profileConfigPath = getConfigPath();
    if (fs.existsSync(profileConfigPath)) {
      const raw = JSON.parse(fs.readFileSync(profileConfigPath, 'utf-8'));
      return { ...DEFAULT_CONFIG, ...raw, llm: { ...DEFAULT_CONFIG.llm, ...raw.llm }, features: { ...DEFAULT_CONFIG.features, ...raw.features }, privacy: { ...DEFAULT_CONFIG.privacy, ...raw.privacy }, developerMode: raw.developerMode ?? false };
    }
    // Fallback to legacy path (pre-profile-manager)
    if (fs.existsSync(CONFIG_PATH_LEGACY)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH_LEGACY, 'utf-8'));
      return { ...DEFAULT_CONFIG, ...raw, llm: { ...DEFAULT_CONFIG.llm, ...raw.llm }, features: { ...DEFAULT_CONFIG.features, ...raw.features }, privacy: { ...DEFAULT_CONFIG.privacy, ...raw.privacy }, developerMode: raw.developerMode ?? false };
    }
  } catch (e) {
    console.error('[config] load failed:', e);
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config: TappiConfig) {
  try {
    const profileConfigPath = getConfigPath();
    const dir = path.dirname(profileConfigPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(profileConfigPath, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('[config] save failed:', e);
  }
}

// API key storage: try safeStorage encryption, fallback to plain text with prefix marker.
// Keys are prefixed: "enc:" = safeStorage encrypted, "raw:" = plain text, no prefix = legacy.
const ENC_PREFIX = 'enc:';
const RAW_PREFIX = 'raw:';

function encryptApiKey(key: string): string {
  if (!key) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(key).toString('base64');
    }
  } catch (e) {
    console.error('[config] encryption unavailable:', e);
  }
  // Fallback: store with raw prefix so we know it's plain text
  return RAW_PREFIX + key;
}

function decryptApiKey(stored: string): string {
  if (!stored) return '';

  // Raw prefix: plain text, just strip prefix
  if (stored.startsWith(RAW_PREFIX)) {
    return stored.slice(RAW_PREFIX.length);
  }

  // Enc prefix: try safeStorage decrypt
  if (stored.startsWith(ENC_PREFIX)) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'));
      }
    } catch (e) {
      console.error('[config] safeStorage decrypt failed');
    }
    // Can't decrypt — return empty so we don't pass garbage to the API
    return '';
  }

  // No prefix (legacy): could be plain text or old encrypted blob.
  // Check if it looks like a known API key format
  if (stored.startsWith('sk-') || stored.startsWith('AI') || stored.startsWith('gsk_')) {
    return stored; // Plain text API key
  }

  // Try safeStorage as last resort (old encrypted format)
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    }
  } catch (e) {
    console.error('[config] legacy decrypt failed, key unusable');
  }
  return '';
}

let currentConfig = DEFAULT_CONFIG;

function getAgentWidth(): number {
  return agentPanelOpen ? AGENT_PANEL_WIDTH : AGENT_STRIP_WIDTH;
}

function buildAppMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Settings',
      submenu: [
        {
          label: 'Open Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => mainWindow?.webContents.send('settings:open'),
        },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          click: () => tabManager?.createTab(),
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            if (!tabManager || !tabManager.activeTabId) return;
            tabManager.closeTab(tabManager.activeTabId);
            if (tabManager.tabCount === 0) mainWindow.close();
          },
        },
        {
          label: 'Reopen Closed Tab',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => tabManager?.reopenClosedTab(),
        },
        { type: 'separator' },
        {
          label: 'Focus Address Bar',
          accelerator: 'CmdOrCtrl+L',
          click: () => mainWindow?.webContents.send('focus:addressbar'),
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload Page',
          accelerator: 'CmdOrCtrl+R',
          click: () => tabManager?.activeWebContents?.reload(),
        },
        { type: 'separator' },
        {
          label: 'Toggle Bookmark',
          accelerator: 'CmdOrCtrl+D',
          click: () => {
            const wc = tabManager?.activeWebContents;
            if (wc) tabManager.toggleBookmark(wc.getURL());
          },
        },
        {
          label: 'Toggle Agent Panel',
          accelerator: 'CmdOrCtrl+J',
          click: () => toggleAgentPanel(),
        },
        {
          label: 'Find on Page',
          accelerator: 'CmdOrCtrl+F',
          click: () => mainWindow?.webContents.send('find:open'),
        },
        {
          label: 'Print',
          accelerator: 'CmdOrCtrl+P',
          click: () => tabManager?.activeWebContents?.print(),
        },
        { type: 'separator' },
        {
          label: 'History',
          accelerator: 'CmdOrCtrl+Y',
          click: () => mainWindow?.webContents.send('panel:open', 'history'),
        },
        {
          label: 'Bookmarks',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => mainWindow?.webContents.send('panel:open', 'bookmarks'),
        },
        {
          label: 'Downloads',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => mainWindow?.webContents.send('panel:open', 'downloads'),
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Tab',
      submenu: [
        ...Array.from({ length: 8 }, (_, i) => ({
          label: `Tab ${i + 1}`,
          accelerator: `CmdOrCtrl+${i + 1}` as string,
          click: () => tabManager?.switchToIndex(i),
        })),
        {
          label: 'Last Tab',
          accelerator: 'CmdOrCtrl+9',
          click: () => tabManager?.switchToLast(),
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function toggleAgentPanel() {
  // Fix 2: Aria tab has no agent sidebar to toggle — skip
  if (tabManager && tabManager.activeTabId === tabManager.ariaTabId) return;
  agentPanelOpen = !agentPanelOpen;
  mainWindow.webContents.send('agent:toggled', agentPanelOpen);
  layoutViews();
}

function layoutViews() {
  if (!mainWindow || !tabManager) return;
  const [width, height] = mainWindow.getContentSize();
  // Fix 2: Hide agent sidebar when Aria tab is active (it IS the agent experience)
  const isAriaActive = tabManager.activeTabId === tabManager.ariaTabId;
  const agentWidth = isAriaActive ? 0 : getAgentWidth();
  // Tell chrome renderer to show/hide agent strip + panel
  mainWindow.webContents.send('agent:visible', !isAriaActive);
  // Fix 3: Log bounds to aid debugging BrowserView overlap issues
  const bvWidth = width - agentWidth;
  console.log(`[layout] isAria=${isAriaActive} agentWidth=${agentWidth} bvWidth=${bvWidth} contentW=${width}`);
  // extraChromeHeight is undefined here — tabManager uses its stored lastExtraChrome value
  tabManager.layoutActiveTab(bvWidth, height, STATUS_BAR_HEIGHT);
}

function createWindow() {
  currentConfig = loadConfig();

  // Initialize database with profile-relative path & run migrations
  initDatabase(profileManager.getDatabasePath());
  migrateBookmarksFromJson();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 600,
    minHeight: 400,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 10 },
    backgroundColor: '#1a1a2e',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Load chrome UI in the main window's webContents
  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

  // F5: Prevent main window navigation to non-file URLs
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });

  // F6: Deny window.open from main chrome window
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' as const }));

  // Tab manager uses BrowserViews for web content
  tabManager = new TabManager(mainWindow, CHROME_HEIGHT, (wc) => {
    setupPageContextMenu(wc);
  });

  // Layout on resize
  mainWindow.on('resize', layoutViews);

  // Hide/show chrome on fullscreen (HTML5 fullscreen from tab content)
  mainWindow.on('enter-full-screen', () => {
    mainWindow.webContents.send('fullscreen:changed', true);
  });
  mainWindow.on('leave-full-screen', () => {
    mainWindow.webContents.send('fullscreen:changed', false);
    // When macOS exits fullscreen (e.g. Esc), the tab's webContents may still
    // be in HTML5 fullscreen mode (leave-html-full-screen hasn't fired yet).
    // Force the tab manager out of fullscreen state so layoutActiveTab() uses
    // normal bounds, then tell the page to exit HTML5 fullscreen too.
    if (tabManager) {
      tabManager.isFullscreen = false;
      const wc = tabManager.activeWebContents;
      if (wc && !wc.isDestroyed()) {
        wc.executeJavaScript('if (document.fullscreenElement) document.exitFullscreen().catch(()=>{})').catch(() => {});
      }
    }
    layoutViews();
  });

  // Build app menu with keyboard shortcuts
  buildAppMenu();

  // Once chrome UI is ready, open first tab
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[main] Chrome UI loaded');
    // Send initial state
    mainWindow.webContents.send('agent:toggled', agentPanelOpen);
    mainWindow.webContents.send('config:loaded', {
      ...currentConfig,
      llm: { ...currentConfig.llm, apiKey: currentConfig.llm.apiKey ? '••••••••' : '' },
    });
    // Send active profile info to UI (Phase 8.4.4)
    mainWindow.webContents.send('profile:loaded', {
      name: profileManager.activeProfile,
      profiles: profileManager.listProfiles(),
    });
    try {
      // Phase 8.35: Create Aria tab first (always at index 0)
      // Fix 1: Only create the Aria tab on startup — no extra regular tab.
      // Users can open new tabs via Cmd+T or the + button.
      const ariaId = tabManager.createAriaTab();
      initTabMedia(ariaId);
      console.log('[main] Aria tab created');

      // Reuse the most recent empty conversation on startup, or create one if none exist
      const existingConvs = listConversations(50);
      const latestEmpty = existingConvs.find(c => c.message_count === 0);
      if (latestEmpty) {
        activeConversationId = latestEmpty.id;
        console.log('[main] Reusing existing empty conversation:', activeConversationId);
      } else if (existingConvs.length === 0) {
        const conv = createConversation();
        activeConversationId = conv.id;
        console.log('[main] Initial conversation created:', activeConversationId);
      } else {
        // All existing conversations have messages — start with the most recent
        activeConversationId = existingConvs[0].id;
        console.log('[main] Resuming most recent conversation:', activeConversationId);
      }
    } catch (e) {
      console.error('[main] Tab creation failed:', e);
    }
    // Layout AFTER tab creation so stored values persist into switchTab
    layoutViews();
  });

  // Initialize download manager
  initDownloadManager(mainWindow);

  // Start ad blocker if enabled in config
  if (currentConfig.features.adBlocker) {
    startAdBlocker().then(() => {
      mainWindow?.webContents.send('adblock:count', getBlockedCount());
    });
  }

  // Initialize cron manager
  {
    const apiKey = decryptApiKey(currentConfig.llm.apiKey);
    if (apiKey) {
      const cronBrowserCtx: BrowserContext = { window: mainWindow, tabManager, config: currentConfig };
      initCronManager(mainWindow, cronBrowserCtx, {
        provider: currentConfig.llm.provider,
        model: currentConfig.llm.model,
        apiKey,
        thinking: currentConfig.llm.thinking,
        region: currentConfig.llm.region,
        projectId: currentConfig.llm.projectId,
        location: currentConfig.llm.location,
        endpoint: currentConfig.llm.endpoint,
        baseUrl: currentConfig.llm.baseUrl,
      }, currentConfig.developerMode);
    }
  }

  // Schedule user profile update (Phase 8.4.2) — non-blocking, fire-and-forget
  // Only runs if agentBrowsingDataAccess is enabled and profile is stale
  if (currentConfig.privacy?.agentBrowsingDataAccess) {
    const profileApiKey = decryptApiKey(currentConfig.llm.apiKey);
    if (profileApiKey) {
      const profileDb = getDb();
      // Use secondary model for profile generation (Phase 8.85 — lightweight task)
      const secProfileApiKey = currentConfig.llm.secondaryApiKey
        ? decryptApiKey(currentConfig.llm.secondaryApiKey)
        : profileApiKey;
      scheduleProfileUpdate(profileDb, {
        provider: currentConfig.llm.secondaryModel ? (currentConfig.llm.secondaryProvider || currentConfig.llm.provider) : currentConfig.llm.provider,
        model: currentConfig.llm.secondaryModel || currentConfig.llm.model,
        apiKey: secProfileApiKey,
        thinking: false, // No thinking needed for profile generation
        region: currentConfig.llm.region,
        projectId: currentConfig.llm.projectId,
        location: currentConfig.llm.location,
        endpoint: currentConfig.llm.endpoint,
        baseUrl: currentConfig.llm.baseUrl,
      }, {
        history: currentConfig.privacy?.profileEnrichHistory !== false,
        bookmarks: currentConfig.privacy?.profileEnrichBookmarks !== false,
      });
    }
  }

  // Debug chrome console
  mainWindow.webContents.on('console-message', (_e: any, _level: number, message: string) => {
    console.log('[chrome]', message);
  });

  // ─── Phase 8.45: Local HTTP API Server ───
  // Only start when developer mode is enabled (same as dev TCP server)
  if (currentConfig.developerMode) {
    ensureApiToken();
    startApiServer(API_PORT, {
      mainWindow,
      tabManager,
      getConfig: () => currentConfig,
      decryptApiKey,
      updateConfig: applyConfigUpdates,
    });
  } else {
    console.log(`[api] HTTP API server disabled (Developer Mode is off). Enable in Settings to use port ${API_PORT}.`);
  }

  // ─── Media Engine Initialization (Phase 8.5) ───
  initMediaEngine(
    mainWindow,
    (tabId) => tabManager.getBrowserView(tabId),
    () => tabManager.activeTabId,
  ).catch(e => console.error('[media-engine] init error:', e));

  // Media IPC routing: events from page content-preload → media engine
  ipcMain.on('media:video-detected-from-page', (event, data) => {
    const tabId = tabManager.getTabIdByWebContentsId(event.sender.id);
    if (tabId) handleVideoDetected(tabId, data);
  });

  ipcMain.on('media:geometry-changed-from-page', (event, data) => {
    const tabId = tabManager.getTabIdByWebContentsId(event.sender.id);
    if (tabId) handleVideoGeometryChanged(tabId, data.rect);
  });

  ipcMain.on('media:play-pause-from-page', (event, data) => {
    const tabId = tabManager.getTabIdByWebContentsId(event.sender.id);
    if (tabId) handleVideoPlayPause(tabId, data.playing);
  });

  ipcMain.on('media:seeked-from-page', (event, data) => {
    const tabId = tabManager.getTabIdByWebContentsId(event.sender.id);
    if (tabId) handleVideoSeeked(tabId, data.position);
  });

  // UI: media toggle from status bar
  ipcMain.handle('media:toggle-active', async () => {
    const activeId = tabManager.activeTabId;
    if (!activeId) return { success: false, error: 'No active tab' };
    const { toggleOverlay } = require('./media-engine');
    return toggleOverlay(activeId);
  });

  // UI: set global media enabled/disabled
  ipcMain.handle('media:set-enabled', (_e, enabled: boolean) => {
    const { setGlobalMediaEnabled } = require('./media-engine');
    setGlobalMediaEnabled(enabled);
    return { success: true };
  });

  // ─── Capture IPC (Phase 8.6) ───
  ipcMain.handle('capture:record-status', () => getRecordingStatus());

  ipcMain.handle('capture:record-stop', async () => {
    return handleRecord(
      mainWindow,
      () => tabManager.activeWebContents,
      { action: 'stop' },
      (status) => {
        try { mainWindow.webContents.send('capture:recording-update', status); } catch {}
      },
    );
  });

  // ─── Tab IPC ───
  ipcMain.on('tab:create', (_e, url?: string) => {
    const newId = tabManager.createTab(url || undefined);
    initTabMedia(newId);
    // Fix 3: Re-layout so new tab's BrowserView gets correct bounds
    layoutViews();
  });

  ipcMain.on('tab:close', (_e, id: string) => {
    destroyTabMedia(id);
    tabManager.closeTab(id);
    if (tabManager.tabCount === 0) {
      mainWindow.close();
      return; // window closing — no layout needed
    }
    // Re-layout after close (active tab changed, agent visibility may change)
    layoutViews();
  });

  ipcMain.on('tab:switch', (_e, id: string) => {
    const prevId = tabManager.activeTabId;
    if (prevId && prevId !== id) onTabHidden(prevId);
    tabManager.switchTab(id);
    onTabShown(id);
    // Fix 2 + 3: Re-layout after tab switch so agent visibility and BrowserView
    // bounds are correct (lastLayoutWidth stored for Aria tab may differ from
    // the correct width for regular tabs with agent strip).
    layoutViews();
  });

  ipcMain.on('tab:navigate', (_e, id: string, url: string) => {
    onTabNavigated(id);
    tabManager.navigate(id, url);
  });

  ipcMain.on('tab:reopen', () => {
    tabManager.reopenClosedTab();
  });

  ipcMain.on('tab:duplicate', (_e, id: string) => {
    tabManager.duplicateTab(id);
  });

  ipcMain.on('tab:pin', (_e, id: string) => {
    tabManager.pinTab(id);
  });

  ipcMain.on('tab:mute', (_e, id: string) => {
    tabManager.muteTab(id);
  });

  ipcMain.on('tab:close-others', (_e, id: string) => {
    tabManager.closeOtherTabs(id);
  });

  ipcMain.on('tab:close-right', (_e, id: string) => {
    tabManager.closeTabsToRight(id);
  });

  ipcMain.on('tab:reorder', (_e, id: string, newIndex: number) => {
    tabManager.reorderTab(id, newIndex);
  });

  ipcMain.on('tab:switch-index', (_e, index: number) => {
    if (index === 9) {
      tabManager.switchToLast();
    } else {
      tabManager.switchToIndex(index);
    }
  });

  // ─── Bookmark IPC ───
  ipcMain.on('bookmark:toggle', (_e, url: string) => {
    tabManager.toggleBookmark(url);
  });

  // ─── Navigation IPC ───
  ipcMain.on('nav:back', () => {
    tabManager.activeWebContents?.goBack();
  });

  ipcMain.on('nav:forward', () => {
    tabManager.activeWebContents?.goForward();
  });

  ipcMain.on('nav:reload', () => {
    tabManager.activeWebContents?.reload();
  });

  // ─── Agent IPC ───
  ipcMain.on('agent:toggle', () => {
    toggleAgentPanel();
  });

  ipcMain.on('agent:send', async (_e, message: string) => {
    console.log('[agent] Message:', message);

    // Check if agent has an API key configured
    const apiKey = decryptApiKey(currentConfig.llm.apiKey);
    if (!apiKey) {
      // Fall back to text command executor (dev mode)
      console.log('[agent] No API key — using text command executor');
      const browserCtx: BrowserContext = {
        window: mainWindow,
        tabManager,
        config: currentConfig,
      };
      try {
        const result = await executeCommand(message, { browserCtx });
        mainWindow.webContents.send('agent:response', {
          role: 'assistant',
          content: result,
          timestamp: Date.now(),
        });
      } catch (err: any) {
        mainWindow.webContents.send('agent:response', {
          role: 'assistant',
          content: `❌ Error: ${err.message}`,
          timestamp: Date.now(),
        });
      }
      return;
    }

    // Run the LLM agent
    const browserCtx: BrowserContext = {
      window: mainWindow,
      tabManager,
      config: currentConfig,
    };

    // Phase 8.35: Ensure active conversation exists (reuse empty rather than creating new)
    if (!activeConversationId) {
      const existing = listConversations(50);
      const emptyConv = existing.find(c => c.message_count === 0);
      if (emptyConv) {
        activeConversationId = emptyConv.id;
      } else {
        const conv = createConversation();
        activeConversationId = conv.id;
      }
    }

    runAgent({
      userMessage: message,
      browserCtx,
      llmConfig: {
        provider: currentConfig.llm.provider,
        model: currentConfig.llm.model,
        apiKey,
        thinking: currentConfig.llm.thinking,
        deepMode: currentConfig.llm.deepMode,
        region: currentConfig.llm.region,
        projectId: currentConfig.llm.projectId,
        location: currentConfig.llm.location,
        endpoint: currentConfig.llm.endpoint,
        baseUrl: currentConfig.llm.baseUrl,
        // Secondary model (Phase 8.85)
        secondaryProvider: currentConfig.llm.secondaryProvider,
        secondaryModel: currentConfig.llm.secondaryModel,
        secondaryApiKey: currentConfig.llm.secondaryApiKey ? decryptApiKey(currentConfig.llm.secondaryApiKey) : undefined,
        // Timeouts (Phase 8.40)
        agentTimeoutMs: currentConfig.llm.agentTimeoutMs,
        teammateTimeoutMs: currentConfig.llm.teammateTimeoutMs,
        subtaskTimeoutMs: currentConfig.llm.subtaskTimeoutMs,
      },
      window: mainWindow,
      developerMode: currentConfig.developerMode,
      deepMode: currentConfig.llm.deepMode !== false,
      conversationId: activeConversationId,
      ariaWebContents: tabManager?.ariaWebContents,
    });
  });

  ipcMain.on('agent:stop', () => {
    stopAgent();
  });

  // Phase 8.40: Get current agent progress (elapsed, toolCalls, timeoutMs, running)
  ipcMain.handle('agent:get-progress', () => {
    return agentProgressData;
  });

  ipcMain.on('agent:clear', () => {
    clearHistory('default');
    mainWindow.webContents.send('agent:cleared', {});
  });

  // ─── Aria Tab IPC (Phase 8.35) ───
  ipcMain.on('aria:send', async (_e, message: string, conversationId?: string, codingMode?: boolean) => {
    const apiKey = decryptApiKey(currentConfig.llm.apiKey);
    if (!apiKey) {
      try {
        const ariaWC = tabManager?.ariaWebContents;
        if (ariaWC) ariaWC.send('agent:stream-chunk', { text: '⚙️ No API key configured. Add one in Settings.', done: true });
      } catch {}
      return;
    }

    // Use provided conversationId or active one
    const convId = conversationId || activeConversationId;
    if (!convId) {
      const existing = listConversations(50);
      const emptyConv = existing.find(c => c.message_count === 0);
      if (emptyConv) {
        activeConversationId = emptyConv.id;
      } else {
        const conv = createConversation();
        activeConversationId = conv.id;
      }
    }

    const browserCtx: BrowserContext = { window: mainWindow, tabManager, config: currentConfig };
    runAgent({
      userMessage: message,
      browserCtx,
      llmConfig: {
        provider: currentConfig.llm.provider,
        model: currentConfig.llm.model,
        apiKey,
        thinking: currentConfig.llm.thinking,
        deepMode: currentConfig.llm.deepMode,
        region: currentConfig.llm.region,
        projectId: currentConfig.llm.projectId,
        location: currentConfig.llm.location,
        endpoint: currentConfig.llm.endpoint,
        baseUrl: currentConfig.llm.baseUrl,
        // Secondary model (Phase 8.85)
        secondaryProvider: currentConfig.llm.secondaryProvider,
        secondaryModel: currentConfig.llm.secondaryModel,
        secondaryApiKey: currentConfig.llm.secondaryApiKey ? decryptApiKey(currentConfig.llm.secondaryApiKey) : undefined,
        // Timeouts (Phase 8.40)
        agentTimeoutMs: currentConfig.llm.agentTimeoutMs,
        teammateTimeoutMs: currentConfig.llm.teammateTimeoutMs,
        subtaskTimeoutMs: currentConfig.llm.subtaskTimeoutMs,
      },
      window: mainWindow,
      developerMode: currentConfig.developerMode,
      deepMode: currentConfig.llm.deepMode !== false,
      codingMode: codingMode ?? false,
      conversationId: convId || activeConversationId || undefined,
      ariaWebContents: tabManager?.ariaWebContents,
    });
  });

  ipcMain.on('aria:stop', () => { stopAgent(); });

  ipcMain.handle('aria:new-chat', () => {
    // Create a new conversation and switch to it
    const conv = createConversation();
    activeConversationId = conv.id;
    // Clear in-memory history for the new session
    clearHistory('default');
    // Notify Aria tab
    try {
      const ariaWC = tabManager?.ariaWebContents;
      if (ariaWC) ariaWC.send('aria:conversation-switched', { conversationId: conv.id });
    } catch {}
    return conv;
  });

  ipcMain.handle('aria:switch-conversation', async (_e, conversationId: string) => {
    activeConversationId = conversationId;
    // Clear in-memory history so next agent run starts fresh with the loaded conv
    clearHistory('default');
    return { success: true, conversationId };
  });

  ipcMain.handle('aria:delete-conversation', async (_e, conversationId: string) => {
    deleteConvFromStore(conversationId);
    // If we deleted the active one, clear the active ID — let the frontend decide what to show next
    // (the frontend already handles switching to the next conversation or creating a new one)
    if (activeConversationId === conversationId) {
      activeConversationId = '';
      clearHistory('default');
    }
    return { success: true };
  });

  ipcMain.handle('aria:rename-conversation', async (_e, conversationId: string, title: string) => {
    updateConversationTitle(conversationId, title);
    return { success: true };
  });

  ipcMain.handle('aria:list-conversations', () => {
    return listConversations(50);
  });

  ipcMain.handle('aria:get-messages', (_e, conversationId: string, offset = 0, limit = 100) => {
    return getConversationMessages(conversationId, offset, limit);
  });

  ipcMain.handle('aria:search-conversations', (_e, query: string) => {
    return searchConversations(query, undefined, 20);
  });

  ipcMain.handle('aria:get-active-conversation', () => {
    return activeConversationId;
  });

  // ─── Projects IPC (Phase 9.07) ───────────────────────────────────────────

  ipcMain.handle('projects:list', (_e, includeArchived = false) => {
    return listProjects(includeArchived);
  });

  ipcMain.handle('projects:get', (_e, projectId: string) => {
    return getProject(projectId);
  });

  ipcMain.handle('projects:create', (_e, name: string, workingDir: string, description?: string) => {
    const project = createProject(name, workingDir || '', description);
    // Notify Aria tab that projects changed (Phase 9.09)
    try { tabManager?.ariaWebContents?.send('projects:updated'); } catch {}
    return project;
  });

  ipcMain.handle('projects:get-artifacts', (_e, projectId: string) => {
    return getArtifacts(projectId);
  });

  ipcMain.handle('projects:link-conversation', (_e, conversationId: string, projectId: string) => {
    linkConvToProject(conversationId, projectId);
    // Notify Aria tab that projects changed (Phase 9.09)
    try { tabManager?.ariaWebContents?.send('projects:updated'); } catch {}
    return { success: true };
  });

  ipcMain.handle('projects:get-conversations', (_e, projectId: string) => {
    return getProjectConversations(projectId);
  });

  // Phase 9.09: Create a new conversation pre-linked to a project
  ipcMain.handle('projects:new-conversation', async (_e, projectId: string) => {
    const { randomUUID } = require('crypto');
    const convId = randomUUID();
    const now = new Date().toISOString();
    const db = getDb();
    db.prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at, message_count, preview, archived, project_id, mode)
       VALUES (?, 'New conversation', ?, ?, 0, '', 0, ?, 'coding')`
    ).run(convId, now, now, projectId);
    // Bump project updated_at
    db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).run(now, projectId);
    // Switch active conversation
    activeConversationId = convId;
    clearHistory('default');
    // Notify Aria tab
    try {
      const ariaWC = tabManager?.ariaWebContents;
      if (ariaWC) {
        ariaWC.send('aria:conversation-switched', { conversationId: convId });
        ariaWC.send('projects:updated');
      }
    } catch {}
    return convId;
  });

  // Phase 9.095: Delete a project (unlink or delete-all)
  // Phase 9.096b: Hardened project deletion.
  // - 'unlink': DB-only (remove from sidebar, keep files + conversations as standalone)
  // - 'delete-all': DB delete + conversations, but directory trash requires separate explicit IPC
  // - Active project (team running) cannot be deleted at all
  ipcMain.handle('projects:delete', async (_e, projectId: string, mode: 'unlink' | 'delete-all') => {
    const db = getDb();
    const project = getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };

    // Phase 9.096b: Block deletion of currently-active project (team running on it)
    const activeTeam = getActiveTeam();
    if (activeTeam && project.working_dir) {
      const resolvedProjectDir = project.working_dir.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '.');
      const resolvedTeamDir = activeTeam.workingDir.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '.');
      if (resolvedProjectDir === resolvedTeamDir) {
        return { success: false, error: 'Cannot delete project while a team is actively working on it. Dissolve the team first.' };
      }
    }

    if (mode === 'delete-all') {
      // 1. Delete all linked conversations
      const convRows = db.prepare(
        `SELECT id FROM conversations WHERE project_id = ?`
      ).all(projectId) as { id: string }[];
      for (const row of convRows) {
        db.prepare(`DELETE FROM conversations WHERE id = ?`).run(row.id);
      }
      // 2. Delete the project record (CASCADE handles artifacts)
      db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId);
      // Phase 9.096b: Directory trash is now a SEPARATE step.
      // The UI must call 'projects:trash-dir' explicitly after showing a second confirmation.
      // This IPC no longer touches the filesystem.
    } else {
      // 'unlink': just delete the project record.
      // Conversations get project_id = NULL via ON DELETE SET NULL.
      // project_artifacts CASCADE-deleted automatically.
      db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId);
    }

    // Notify Aria tab
    try { tabManager?.ariaWebContents?.send('projects:updated'); } catch {}
    return { success: true };
  });

  // Phase 9.096b: Separate IPC for trashing a project's working directory.
  // Only callable from UI with explicit double-confirmation.
  // Never callable from agent tools.
  ipcMain.handle('projects:trash-dir', async (_e, dirPath: string) => {
    if (!dirPath) return { success: false, error: 'No directory path provided' };

    const resolved = dirPath.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '.');

    // Safety: Block trashing of protected paths
    const home = process.env.HOME || process.env.USERPROFILE || '/';
    const protectedPaths = [
      home,
      '/',
      path.join(home, '.tappi-browser'),
      path.join(home, '.tappi'),
      path.join(home, 'Desktop'),
      path.join(home, 'Documents'),
      path.join(home, 'Downloads'),
      path.resolve(__dirname, '..'),
    ];

    const normalizedResolved = path.resolve(resolved);
    for (const pp of protectedPaths) {
      if (normalizedResolved === path.resolve(pp)) {
        return { success: false, error: `Cannot trash protected path: ${pp}` };
      }
    }

    // Safety: Block if an active team is using this directory
    const activeTeam2 = getActiveTeam();
    if (activeTeam2) {
      const resolvedTeamDir = activeTeam2.workingDir.replace(/^~/, home);
      if (normalizedResolved === path.resolve(resolvedTeamDir)) {
        return { success: false, error: 'Cannot trash directory while a team is actively working on it.' };
      }
    }

    // Check directory exists
    if (!fs.existsSync(resolved)) {
      return { success: false, error: 'Directory does not exist' };
    }

    try {
      await shell.trashItem(resolved);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: `trashItem failed: ${err?.message || err}` };
    }
  });

  // ─── Overlay IPC (hide/show BrowserViews for modals) ───
  ipcMain.on('overlay:show', () => {
    tabManager.hideAllViews();
  });

  ipcMain.on('overlay:hide', () => {
    tabManager.showAllViews();
  });

  // ─── Settings IPC ───
  ipcMain.handle('config:get', () => {
    return {
      ...currentConfig,
      llm: {
        ...currentConfig.llm,
        apiKey: currentConfig.llm.apiKey ? '••••••••' : '',
        // Mask secondary key too — UI only needs to know if it's set
        secondaryApiKey: currentConfig.llm.secondaryApiKey ? '••••••••' : '',
      },
      hasApiKey: !!currentConfig.llm.apiKey,
      hasSecondaryApiKey: !!currentConfig.llm.secondaryApiKey,
    };
  });

  // Reveal the actual LLM API key (for eye toggle in settings)
  ipcMain.handle('config:reveal-api-key', () => {
    if (!currentConfig.llm.apiKey) return { key: '' };
    return { key: decryptApiKey(currentConfig.llm.apiKey) };
  });

  // Check if a specific provider has a stored API key (for settings UI provider switching)
  ipcMain.handle('config:has-provider-key', (_e, provider: string) => {
    if (provider === currentConfig.llm.provider) return { hasKey: !!currentConfig.llm.apiKey };
    return { hasKey: !!(currentConfig.llm.providerApiKeys?.[provider]) };
  });

  // Shared config update logic — used by both IPC handler and REST API
  function applyConfigUpdates(updates: Partial<TappiConfig & { rawApiKey?: string; rawSecondaryApiKey?: string }>): { success: boolean } {
    // Per-provider API key swap — must run BEFORE provider is updated
    if (updates.llm?.provider && updates.llm.provider !== currentConfig.llm.provider) {
      // Save current key to the old provider slot before switching
      if (currentConfig.llm.apiKey && currentConfig.llm.provider) {
        if (!currentConfig.llm.providerApiKeys) currentConfig.llm.providerApiKeys = {};
        currentConfig.llm.providerApiKeys[currentConfig.llm.provider] = currentConfig.llm.apiKey;
      }
      // Restore the new provider's stored key (or empty if none)
      currentConfig.llm.apiKey = currentConfig.llm.providerApiKeys?.[updates.llm.provider] || '';
    }
    if (updates.llm) {
      if (updates.llm.provider) currentConfig.llm.provider = updates.llm.provider;
      if (updates.llm.model !== undefined) currentConfig.llm.model = updates.llm.model;
      // Cloud provider fields
      if (updates.llm.region !== undefined) currentConfig.llm.region = updates.llm.region || undefined;
      if (updates.llm.projectId !== undefined) currentConfig.llm.projectId = updates.llm.projectId || undefined;
      if (updates.llm.location !== undefined) currentConfig.llm.location = updates.llm.location || undefined;
      if (updates.llm.endpoint !== undefined) currentConfig.llm.endpoint = updates.llm.endpoint || undefined;
      if (updates.llm.baseUrl !== undefined) currentConfig.llm.baseUrl = updates.llm.baseUrl || undefined;
      if (updates.llm.thinking !== undefined) currentConfig.llm.thinking = updates.llm.thinking;
      if (updates.llm.deepMode !== undefined) currentConfig.llm.deepMode = updates.llm.deepMode;
      if ((updates.llm as any).codingMode !== undefined) currentConfig.llm.codingMode = (updates.llm as any).codingMode;
      if ((updates.llm as any).worktreeIsolation !== undefined) currentConfig.llm.worktreeIsolation = (updates.llm as any).worktreeIsolation;
      // Secondary model fields (Phase 8.85)
      if (updates.llm.secondaryProvider !== undefined) currentConfig.llm.secondaryProvider = updates.llm.secondaryProvider || undefined;
      if (updates.llm.secondaryModel !== undefined) currentConfig.llm.secondaryModel = updates.llm.secondaryModel || undefined;
    }
    if ((updates as any).rawApiKey !== undefined) {
      const rawKey = (updates as any).rawApiKey;
      const encrypted = rawKey ? encryptApiKey(rawKey) : '';
      currentConfig.llm.apiKey = encrypted;
      // Store per-provider so switching back restores it
      if (encrypted && currentConfig.llm.provider) {
        if (!currentConfig.llm.providerApiKeys) currentConfig.llm.providerApiKeys = {};
        currentConfig.llm.providerApiKeys[currentConfig.llm.provider] = encrypted;
      }
    }
    // Secondary API key (Phase 8.85)
    if ((updates as any).rawSecondaryApiKey !== undefined) {
      const rawSecKey = (updates as any).rawSecondaryApiKey;
      // Empty string means "same as primary" (clear the override)
      currentConfig.llm.secondaryApiKey = rawSecKey ? encryptApiKey(rawSecKey) : undefined;
    }
    if (updates.searchEngine) currentConfig.searchEngine = updates.searchEngine;
    if (updates.features) {
      currentConfig.features = { ...currentConfig.features, ...updates.features };
    }
    if ((updates as any).developerMode !== undefined) {
      currentConfig.developerMode = (updates as any).developerMode;
    }
    if (updates.privacy) {
      const prevAccess = currentConfig.privacy?.agentBrowsingDataAccess;
      currentConfig.privacy = { ...currentConfig.privacy, ...updates.privacy };
      const newAccess = currentConfig.privacy?.agentBrowsingDataAccess;

      // If access was just turned OFF, delete the generated profile
      if (prevAccess && !newAccess) {
        deleteProfile();
      }

      // If access was just turned ON, schedule a profile generation
      if (!prevAccess && newAccess) {
        const profileApiKey = decryptApiKey(currentConfig.llm.apiKey);
        if (profileApiKey) {
          // Use secondary model for profile generation (Phase 8.85)
          const secApiKey = currentConfig.llm.secondaryApiKey
            ? decryptApiKey(currentConfig.llm.secondaryApiKey)
            : profileApiKey;
          scheduleProfileUpdate(getDb(), {
            provider: currentConfig.llm.secondaryModel ? (currentConfig.llm.secondaryProvider || currentConfig.llm.provider) : currentConfig.llm.provider,
            model: currentConfig.llm.secondaryModel || currentConfig.llm.model,
            apiKey: secApiKey,
            thinking: false,
            region: currentConfig.llm.region,
            projectId: currentConfig.llm.projectId,
            location: currentConfig.llm.location,
            endpoint: currentConfig.llm.endpoint,
            baseUrl: currentConfig.llm.baseUrl,
          }, {
            history: currentConfig.privacy?.profileEnrichHistory !== false,
            bookmarks: currentConfig.privacy?.profileEnrichBookmarks !== false,
          });
        }
      }
    }
    saveConfig(currentConfig);
    console.log('[config] Saved:', currentConfig.llm.provider, currentConfig.llm.model);

    // Update cron manager with new config
    const cronApiKey = decryptApiKey(currentConfig.llm.apiKey);
    if (cronApiKey) {
      const cronBrowserCtx: BrowserContext = { window: mainWindow, tabManager, config: currentConfig };
      updateCronContext(cronBrowserCtx, {
        provider: currentConfig.llm.provider,
        model: currentConfig.llm.model,
        apiKey: cronApiKey,
        thinking: currentConfig.llm.thinking,
        region: currentConfig.llm.region,
        projectId: currentConfig.llm.projectId,
        location: currentConfig.llm.location,
        endpoint: currentConfig.llm.endpoint,
        baseUrl: currentConfig.llm.baseUrl,
      }, currentConfig.developerMode);
    }

    return { success: true };
  }

  ipcMain.handle('config:save', (_e, updates: Partial<TappiConfig & { rawApiKey?: string; rawSecondaryApiKey?: string }>) => {
    return applyConfigUpdates(updates);
  });

  // ─── Profile Management IPC (Phase 8.4.4) ───

  ipcMain.handle('profile:list', () => {
    return profileManager.listProfiles();
  });

  ipcMain.handle('profile:create', (_e, name: string, email?: string) => {
    return profileManager.createProfile(name, email);
  });

  ipcMain.handle('profile:switch', async (_e, name: string) => {
    const result = profileManager.switchProfile(name);
    if ('error' in result) return result;

    // Close existing db, reopen with new profile's db path
    reinitDatabase(profileManager.getDatabasePath());

    // Reload config for new profile
    currentConfig = loadConfig();
    mainWindow.webContents.send('config:loaded', {
      ...currentConfig,
      llm: { ...currentConfig.llm, apiKey: currentConfig.llm.apiKey ? '••••••••' : '' },
    });

    // Notify UI of profile change
    mainWindow.webContents.send('profile:switched', { profile: result, profiles: profileManager.listProfiles() });

    // Clear in-memory agent history
    clearHistory('default');
    sessionManager.clearSiteIdentities();

    console.log(`[main] Switched to profile: ${name}`);
    return { success: true, profile: result, profiles: profileManager.listProfiles() };
  });

  ipcMain.handle('profile:delete', (_e, name: string) => {
    return profileManager.deleteProfile(name);
  });

  ipcMain.handle('profile:export', async (_e, profileName: string, password: string) => {
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Profile',
      defaultPath: `${profileName}-${new Date().toISOString().slice(0, 10)}.tappi-profile`,
      filters: [{ name: 'Tappi Profile', extensions: ['tappi-profile'] }],
    });
    if (!filePath) return { success: false, error: 'Cancelled' };
    return await profileManager.exportProfile(profileName, password, filePath);
  });

  ipcMain.handle('profile:import', async (_e, password: string) => {
    const { filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Profile',
      filters: [{ name: 'Tappi Profile', extensions: ['tappi-profile'] }],
      properties: ['openFile'],
    });
    if (!filePaths || filePaths.length === 0) return { success: false, error: 'Cancelled' };
    const result = await profileManager.importProfile(filePaths[0], password);
    if (result.success) {
      mainWindow.webContents.send('profile:updated', profileManager.listProfiles());
    }
    return result;
  });

  ipcMain.handle('profile:get-active', () => {
    return {
      name: profileManager.activeProfile,
      profiles: profileManager.listProfiles(),
    };
  });

  // ─── Profile Native Menu (renders above tab views, no z-order issues) ───
  ipcMain.on('profile:show-menu', () => {
    const profiles = profileManager.listProfiles();
    const active = profileManager.activeProfile;
    const template: Electron.MenuItemConstructorOptions[] = [];

    for (const p of profiles) {
      template.push({
        label: p.name,
        type: 'checkbox',
        checked: p.name === active,
        click: async () => {
          if (p.name === active) return;
          const result = profileManager.switchProfile(p.name);
          if ('error' in result) return;
          reinitDatabase(profileManager.getDatabasePath());
          currentConfig = loadConfig();
          mainWindow.webContents.send('config:loaded', {
            ...currentConfig,
            llm: { ...currentConfig.llm, apiKey: currentConfig.llm.apiKey ? '••••••••' : '' },
          });
          mainWindow.webContents.send('profile:switched', { profile: result, profiles: profileManager.listProfiles() });
          clearHistory('default');
          sessionManager.clearSiteIdentities();
        },
      });
    }

    template.push({ type: 'separator' });
    template.push({
      label: 'New Profile…',
      click: () => {
        mainWindow.webContents.send('settings:open');
        mainWindow.webContents.send('settings:switch-tab', 'profiles');
      },
    });
    template.push({
      label: 'Manage Profiles…',
      click: () => {
        mainWindow.webContents.send('settings:open');
        mainWindow.webContents.send('settings:switch-tab', 'profiles');
      },
    });

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: mainWindow });
  });

  // ─── Site Identity IPC (Phase 8.4.6) ───

  ipcMain.handle('profile:open-site-identity', (_e, domain: string, username: string) => {
    const partition = sessionManager.getSiteIdentityPartition(domain, username);
    sessionManager.registerSiteIdentity(domain, username);
    // Create a new tab with the site-specific session partition
    const url = `https://${domain}`;
    tabManager.createTab(url, partition);
    layoutViews();
    return { success: true, partition };
  });

  ipcMain.handle('profile:site-identities', (_e, domain: string) => {
    return sessionManager.getSiteIdentities(domain);
  });

  // ─── Credential Check & Test Connection IPC ───
  ipcMain.handle('credentials:check', async (_e, provider: string, options?: { ollamaUrl?: string }) => {
    return await checkCredentials(provider, options);
  });

  ipcMain.handle('credentials:test', async (_e, provider: string, config: any) => {
    // Decrypt API key if we're testing with the stored key
    if (!config.apiKey && currentConfig.llm.apiKey && currentConfig.llm.provider === provider) {
      config.apiKey = decryptApiKey(currentConfig.llm.apiKey);
    }
    return await testConnection(provider, config);
  });

  ipcMain.handle('provider:default-model', (_e, provider: string) => {
    return getDefaultModel(provider);
  });

  // ─── API Services IPC ───
  ipcMain.handle('api-services:list', () => {
    const services = loadServices();
    const keys: Record<string, boolean> = {};
    for (const name of Object.keys(services)) {
      keys[name] = !!getApiKey(name);
    }
    // Find orphan keys (keys without service config)
    const keyList = listApiKeys();
    const orphans: string[] = [];
    if (keyList && !keyList.startsWith('No API')) {
      const lines = keyList.split('\n').slice(1);
      for (const line of lines) {
        const match = line.match(/• (\S+)/);
        if (match && !services[match[1]]) {
          orphans.push(match[1]);
          keys[match[1]] = true;
        }
      }
    }
    return { services, keys, orphans };
  });

  ipcMain.handle('api-services:add', (_e, data: { name: string; baseUrl: string; authHeader: string; description: string; apiKey?: string }) => {
    if (!data.name) return { success: false, error: 'Name is required' };
    registerService(data.name, data.baseUrl || '', data.authHeader || 'Bearer', data.description || '');
    if (data.apiKey) storeApiKey(data.name, data.apiKey);
    mainWindow.webContents.send('api-services:updated', null);
    return { success: true };
  });

  ipcMain.handle('api-services:update', (_e, oldName: string, data: { name: string; baseUrl: string; authHeader: string; description: string; apiKey?: string }) => {
    if (oldName !== data.name) {
      removeService(oldName);
      deleteApiKey(oldName);
    }
    registerService(data.name, data.baseUrl || '', data.authHeader || 'Bearer', data.description || '');
    if (data.apiKey) storeApiKey(data.name, data.apiKey);
    mainWindow.webContents.send('api-services:updated', null);
    return { success: true };
  });

  ipcMain.handle('api-services:delete', (_e, name: string) => {
    removeService(name);
    deleteApiKey(name);
    mainWindow.webContents.send('api-services:updated', null);
    return { success: true };
  });

  ipcMain.handle('api-services:reveal-key', (_e, name: string) => {
    const key = getApiKey(name);
    if (!key) return { key: '' };
    return { key };
  });

  // ─── Developer Mode IPC ───
  ipcMain.handle('devmode:get', () => currentConfig.developerMode);

  ipcMain.handle('devmode:api-token', () => {
    if (!currentConfig.developerMode) return '';
    try { return require('fs').readFileSync(require('path').join(process.env.HOME || '.', '.tappi-browser', 'api-token'), 'utf-8').trim(); } catch { return ''; }
  });

  ipcMain.handle('devmode:set', (_e, enabled: boolean) => {
    currentConfig.developerMode = enabled;
    saveConfig(currentConfig);
    mainWindow.webContents.send('devmode:changed', enabled);
    // Fix 4: Also notify Aria tab so it can show/hide the </> coding mode button
    try { tabManager?.ariaWebContents?.send('devmode:changed', enabled); } catch {}
    // If dev mode turned off, deactivate coding mode (it requires dev mode)
    if (!enabled && currentConfig.llm.codingMode) {
      const codingActive = false;
      mainWindow.webContents.send('codingmode:changed', codingActive);
      try { tabManager?.ariaWebContents?.send('codingmode:changed', codingActive); } catch {}
    }
    // Start/stop API server based on developer mode
    if (enabled) {
      ensureApiToken();
      startApiServer(API_PORT, {
        mainWindow,
        tabManager,
        getConfig: () => currentConfig,
        decryptApiKey,
        updateConfig: applyConfigUpdates,
      });
    } else {
      stopApiServer();
    }
    console.log('[config] Developer mode:', enabled);
    return { success: true, developerMode: enabled };
  });

  // ─── Coding Mode IPC (Phase 8.38) ───
  ipcMain.handle('codingmode:get', () => ({
    enabled: currentConfig.developerMode && (currentConfig.llm.codingMode === true),
    devModeRequired: !currentConfig.developerMode,
  }));

  ipcMain.handle('codingmode:set', (_e, enabled: boolean) => {
    currentConfig.llm.codingMode = enabled;
    saveConfig(currentConfig);
    const active = currentConfig.developerMode && enabled;
    mainWindow.webContents.send('codingmode:changed', active);
    // Fix 4: Also notify Aria tab for its </> button state
    try { tabManager?.ariaWebContents?.send('codingmode:changed', active); } catch {}
    console.log('[config] Coding mode:', enabled, '(effective:', active, ')');
    return { success: true, codingMode: active };
  });

  // ─── Worktree Isolation IPC (Phase 8.39) ───
  ipcMain.handle('worktree-isolation:get', () => ({
    enabled: currentConfig.developerMode && (currentConfig.llm.codingMode === true) && (currentConfig.llm.worktreeIsolation !== false),
    codingModeRequired: !currentConfig.llm.codingMode,
    devModeRequired: !currentConfig.developerMode,
  }));

  ipcMain.handle('worktree-isolation:set', (_e, enabled: boolean) => {
    currentConfig.llm.worktreeIsolation = enabled;
    saveConfig(currentConfig);
    const active = currentConfig.developerMode && (currentConfig.llm.codingMode === true) && enabled;
    mainWindow.webContents.send('worktree-isolation:changed', active);
    try { tabManager?.ariaWebContents?.send('worktree-isolation:changed', active); } catch {}
    console.log('[config] Worktree isolation:', enabled, '(effective:', active, ')');
    return { success: true, worktreeIsolation: enabled };
  });

  // ─── Team IPC (Phase 8.38) ───
  ipcMain.handle('team:status', () => getTeamStatusUI());

  // Setup team update callback to push UI updates
  setTeamUpdateCallback((_teamId, _team) => {
    const teamStatus = getTeamStatusUI();
    try { mainWindow?.webContents.send('team:updated', teamStatus); } catch {}
    // Fix 4: Also notify Aria tab's team status card
    try { tabManager?.ariaWebContents?.send('team:updated', teamStatus); } catch {}
  });

  // ─── Phase 9.096d: Unified Interrupt IPC ────────────────────────────────
  // Routes interrupt/redirect requests from the renderer to the correct backend handler.
  // target: 'main' = main agent session, 'teammate' = team member, 'subtask' = deep mode step
  ipcMain.handle('agent:interrupt', async (_event, { target, targetName, message }: { target: string; targetName?: string; message: string }) => {
    try {
      switch (target) {
        case 'main':
          return await interruptMainSession(message);
        case 'teammate': {
          const teamId = getActiveTeamId();
          if (!teamId) return '❌ No active team';
          return await interruptTeammate(teamId, targetName || '', message);
        }
        case 'subtask':
          return interruptSubtask(targetName ?? 0, message);
        default:
          return `❌ Unknown interrupt target: ${target}`;
      }
    } catch (err: any) {
      console.error('[main] agent:interrupt error:', err?.message);
      return `❌ Interrupt failed: ${err?.message}`;
    }
  });

  // Forward new team live events to both windows (team-manager sends directly to ariaWC,
  // but we also forward from here in case mainWindow needs them)
  // Note: team:teammate-pulse, team:teammate-reasoning, team:teammate-interrupt are sent
  // directly from team-manager to ariaWebContents — this forwarding handles mainWindow
  const _teamLiveEvents = ['team:teammate-pulse', 'team:teammate-reasoning', 'team:teammate-interrupt'];
  // (These events flow from team-manager → ariaWebContents directly; no main.ts forwarding needed)

  // Phase 9.09: Register project update callback so agent tools can push sidebar refreshes
  setProjectUpdateCallback(() => {
    try { tabManager?.ariaWebContents?.send('projects:updated'); } catch {}
  });

  // ─── CLI Tools IPC ───
  ipcMain.handle('tools:list', () => {
    return loadTools();
  });

  ipcMain.handle('tools:verify', () => {
    return verifyAllTools();
  });

  // ─── Cron Jobs IPC ───
  ipcMain.handle('cron:list', () => getJobsList());

  ipcMain.handle('cron:add', (_e, data: { name: string; task: string; schedule: any }) => {
    return cronAddJob(data.name, data.task, data.schedule);
  });

  ipcMain.handle('cron:update', (_e, id: string, updates: any) => {
    return cronUpdateJob(id, updates);
  });

  ipcMain.handle('cron:delete', (_e, id: string) => {
    return cronDeleteJob(id);
  });

  ipcMain.handle('cron:run-now', (_e, id: string) => {
    return cronRunJobNow(id);
  });

  ipcMain.handle('cron:active-count', () => getActiveJobCount());

  // ─── Dark Mode IPC (direct toggle) ───
  ipcMain.on('darkmode:toggle', async (_e, enable: boolean) => {
    // Save dark mode preference to config
    currentConfig.features.darkMode = enable;
    saveConfig(currentConfig);

    // Notify Aria tab about theme change
    const ariaWc = tabManager?.ariaWebContents;
    if (ariaWc) {
      ariaWc.send('theme:changed', enable);
    }

    // Apply dark mode CSS to the active web page content
    const wc = tabManager?.activeWebContents;
    if (!wc) return;
    const { bDarkMode } = require('./browser-tools');
    await bDarkMode({ window: mainWindow, tabManager, config: currentConfig }, [enable ? 'on' : 'off']);
  });

  ipcMain.handle('theme:get', () => {
    return currentConfig.features.darkMode || false;
  });

  // ─── History IPC ───
  ipcMain.handle('history:search', (_e, query: string, limit?: number) => {
    return searchHistory(query, limit || 10);
  });

  ipcMain.handle('history:recent', (_e, limit?: number) => {
    return getRecentHistory(limit || 20);
  });

  ipcMain.handle('history:clear', (_e, range?: string) => {
    return clearDbHistory(range as any);
  });

  // ─── Search Suggestions IPC ───
  ipcMain.handle('suggest:search', async (_e, query: string) => {
    if (!query || query.length < 2) return [];
    try {
      const resp = await fetch(
        `https://suggestqueries.google.com/complete/search?client=chrome&q=${encodeURIComponent(query)}`
      );
      if (!resp.ok) return [];
      const data: any = await resp.json();
      return Array.isArray(data[1]) ? data[1].slice(0, 8) : [];
    } catch {
      return [];
    }
  });

  // ─── Ad Blocker IPC ───
  ipcMain.handle('adblock:toggle', async (_e, enable: boolean) => {
    toggleAdBlocker(enable);
    currentConfig.features.adBlocker = enable;
    saveConfig(currentConfig);
    return { enabled: enable };
  });

  ipcMain.handle('adblock:count', () => getBlockedCount());

  ipcMain.handle('adblock:site-exception', (_e, domain: string, add: boolean) => {
    if (add) addSiteException(domain);
    else removeSiteException(domain);
    return { success: true };
  });

  // Periodically send ad block count to UI
  setInterval(() => {
    if (isAdBlockerEnabled() && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('adblock:count', getBlockedCount());
    }
  }, 3000);

  // ─── Download IPC ───
  ipcMain.handle('downloads:list', () => {
    return getAllDownloads().map(d => ({
      id: d.id,
      filename: d.filename,
      totalBytes: d.totalBytes,
      receivedBytes: d.receivedBytes,
      state: d.state,
      savePath: d.savePath,
      startTime: d.startTime,
    }));
  });

  ipcMain.handle('downloads:cancel', (_e, id: string) => cancelDownload(id));
  ipcMain.handle('downloads:clear', () => { clearCompleted(); return { success: true }; });

  // ─── Bookmarks (panel) IPC ───
  ipcMain.handle('bookmarks:all', () => {
    return getAllBookmarks();
  });

  ipcMain.handle('bookmarks:search', (_e, query: string) => {
    return searchBookmarks(query);
  });

  ipcMain.handle('bookmarks:remove', (_e, url: string) => {
    removeBookmark(url);
    return { success: true };
  });

  // ─── Extra Chrome Height (find bar, autocomplete push tab view down) ───
  const FIND_BAR_HEIGHT = 40;
  let findBarOpen = false;
  let autocompleteHeight = 0;

  function getExtraChromeHeight(): number {
    return (findBarOpen ? FIND_BAR_HEIGHT : 0) + autocompleteHeight;
  }

  function relayoutWithExtraChrome() {
    if (!mainWindow || !tabManager) return;
    const [width, height] = mainWindow.getContentSize();
    const agentWidth = getAgentWidth();
    tabManager.layoutActiveTab(width - agentWidth, height, STATUS_BAR_HEIGHT, getExtraChromeHeight());
  }

  // ─── Find on Page IPC ───
  ipcMain.on('findbar:toggle', (_e, open: boolean) => {
    findBarOpen = open;
    relayoutWithExtraChrome();
  });

  // ─── Autocomplete overlay (push tab down instead of blanking page) ───
  ipcMain.on('autocomplete:resize', (_e, height: number) => {
    autocompleteHeight = Math.max(0, Math.min(height, 360)); // cap at 360px
    relayoutWithExtraChrome();
  });

  let lastFindText = '';
  ipcMain.on('find:start', (_e, text: string, options?: { forward?: boolean }) => {
    const wc = tabManager?.activeWebContents;
    if (!wc || !text) return;
    lastFindText = text;
    wc.findInPage(text, { forward: options?.forward !== false });
  });

  ipcMain.on('find:next', (_e, forward?: boolean) => {
    const wc = tabManager?.activeWebContents;
    if (!wc || !lastFindText) return;
    wc.findInPage(lastFindText, { forward: forward !== false, findNext: true });
  });

  ipcMain.on('find:stop', () => {
    const wc = tabManager?.activeWebContents;
    if (!wc) return;
    wc.stopFindInPage('clearSelection');
  });

  // ─── Print IPC ───
  ipcMain.on('page:print', () => {
    const wc = tabManager?.activeWebContents;
    if (!wc) return;
    wc.print();
  });

  // ─── Zoom IPC ───
  ipcMain.on('zoom:in', () => {
    const wc = tabManager?.activeWebContents;
    if (!wc) return;
    const current = wc.getZoomLevel();
    wc.setZoomLevel(Math.min(current + 0.5, 5));
    mainWindow?.webContents.send('zoom:changed', wc.getZoomFactor());
  });

  ipcMain.on('zoom:out', () => {
    const wc = tabManager?.activeWebContents;
    if (!wc) return;
    const current = wc.getZoomLevel();
    wc.setZoomLevel(Math.max(current - 0.5, -5));
    mainWindow?.webContents.send('zoom:changed', wc.getZoomFactor());
  });

  ipcMain.on('zoom:reset', () => {
    const wc = tabManager?.activeWebContents;
    if (!wc) return;
    wc.setZoomLevel(0);
    mainWindow?.webContents.send('zoom:changed', 1);
  });

  ipcMain.handle('zoom:get', () => {
    const wc = tabManager?.activeWebContents;
    if (!wc) return 1;
    return wc.getZoomFactor();
  });

  // ─── Navigate or create tab from panels ───
  ipcMain.on('tab:navigate-or-create', (_e, url: string) => {
    if (!tabManager) return;
    const wc = tabManager.activeWebContents;
    if (wc) {
      wc.loadURL(url.startsWith('http') ? url : `https://${url}`);
    } else {
      tabManager.createTab(url);
    }
  });

  // ─── Password Vault IPC ───
  ipcMain.handle('vault:list-domains', () => listSavedDomains());

  ipcMain.handle('vault:get-for-domain', (_e, domain: string) => {
    return getPasswordsForDomain(domain);
  });

  ipcMain.handle('vault:save', (_e, domain: string, username: string, password: string) => {
    storePassword(domain, username, password);
    return { success: true };
  });

  ipcMain.handle('vault:delete', (_e, id: number) => {
    removePassword(id);
    return { success: true };
  });

  ipcMain.handle('vault:generate', (_e, length?: number) => {
    return { password: generatePassword(length || 20) };
  });

  ipcMain.handle('vault:autofill', async (_e, domain: string, username?: string) => {
    const wc = tabManager?.activeWebContents;
    if (!wc) return { success: false, error: 'No active tab' };

    const cred = getPasswordForAutofill(domain, username || '');
    if (!cred) return { success: false, error: 'No credentials found' };

    const script = buildAutofillScript(cred.username, cred.password);
    const result = await wc.executeJavaScript(script);
    return { success: true, result };
  });

  // Handle credential save prompts from content preload
  ipcMain.on('vault:credential-detected', (_e, data: { domain: string; username: string }) => {
    // Show save password prompt in the UI
    mainWindow?.webContents.send('vault:save-prompt', data);
  });

  // ─── Login Detection IPC (Phase 8.4.3) ───
  // content-preload sends this when it detects a password field on a page.
  // Main process looks up the vault and stores a hint for the next agent context assembly.
  ipcMain.on('page:login-detected', (event, data: { domain: string }) => {
    const { domain } = data;
    const wcId = event.sender.id;

    const usernames = listIdentities(domain);
    let hint: string;
    if (usernames.length === 0) {
      hint = `[🔑 Login page detected. No stored credential for ${domain}.]`;
    } else if (usernames.length === 1) {
      hint = `[🔑 Login page detected. Matching credential found for ${domain}.]`;
    } else {
      hint = `[🔑 Login page detected. ${usernames.length} credentials stored for ${domain}: ${usernames.join(', ')}.]`;
    }

    setLoginHint(wcId, domain, hint);
    console.log(`[vault] Login detected — ${domain} (wcId=${wcId}): ${usernames.length} credential(s)`);
  });

  // ─── Permission IPC ───
  ipcMain.handle('permission:get', (_e, domain: string, perm: string) => {
    return getPermission(domain, perm);
  });

  ipcMain.handle('permission:set', (_e, domain: string, perm: string, allowed: boolean) => {
    setPermission(domain, perm, allowed);
    return { success: true };
  });

  // ─── User Profile (Phase 9.096c) ───
  ipcMain.handle('user-profile:load', () => {
    return loadUserProfileTxt();
  });

  ipcMain.handle('user-profile:save', (_e, text: string) => {
    const result = saveUserProfileTxt(text);
    return result;
  });

  ipcMain.handle('user-profile:enrichment-status', () => {
    const autoProfile = loadProfile();
    return {
      lastEnriched: autoProfile?.updated_at || null,
      enrichHistory: currentConfig.privacy?.profileEnrichHistory !== false,
      enrichBookmarks: currentConfig.privacy?.profileEnrichBookmarks !== false,
    };
  });

  ipcMain.handle('user-profile:refresh-enrichment', async () => {
    if (!currentConfig.privacy?.agentBrowsingDataAccess) {
      return { error: 'Browsing data access is disabled.' };
    }
    const apiKey = decryptApiKey(currentConfig.llm.apiKey);
    if (!apiKey) return { error: 'No API key configured.' };
    const secApiKey = currentConfig.llm.secondaryApiKey
      ? decryptApiKey(currentConfig.llm.secondaryApiKey)
      : apiKey;
    try {
      const result = await generateProfile(getDb(), {
        provider: currentConfig.llm.secondaryModel ? (currentConfig.llm.secondaryProvider || currentConfig.llm.provider) : currentConfig.llm.provider,
        model: currentConfig.llm.secondaryModel || currentConfig.llm.model,
        apiKey: secApiKey,
        thinking: false,
        region: currentConfig.llm.region,
        projectId: currentConfig.llm.projectId,
        location: currentConfig.llm.location,
        endpoint: currentConfig.llm.endpoint,
        baseUrl: currentConfig.llm.baseUrl,
      }, {
        history: currentConfig.privacy?.profileEnrichHistory !== false,
        bookmarks: currentConfig.privacy?.profileEnrichBookmarks !== false,
      });
      return { success: !!result, lastEnriched: result?.updated_at || null };
    } catch (e: any) {
      return { error: e?.message || 'Generation failed' };
    }
  });

  // ─── Deep Mode Report Save ───
  const _deepSaveReportHandler = async (_e: Electron.IpcMainInvokeEvent, outputDirAbsolute: string, format: string = 'md') => {
    const fsSync = require('fs') as typeof import('fs');
    const pathMod = require('path') as typeof import('path');
    const os = require('os') as typeof import('os');
    const { execSync } = require('child_process') as typeof import('child_process');

    // Find the final report markdown file in the output directory
    let reportPath = '';
    if (fsSync.existsSync(outputDirAbsolute)) {
      const files = fsSync.readdirSync(outputDirAbsolute).filter((f: string) => f.endsWith('.md')).sort();
      const finalReport = files.find((f: string) => f.includes('final_report') || f.includes('final'));
      reportPath = pathMod.join(outputDirAbsolute, finalReport || files[files.length - 1] || '');
    }

    if (!reportPath || !fsSync.existsSync(reportPath)) {
      return { success: false, error: 'Report file not found' };
    }

    const mdContent = fsSync.readFileSync(reportPath, 'utf-8');
    const baseName = pathMod.basename(reportPath, '.md');

    // Determine output format details
    const fmt = (format || 'md').toLowerCase();
    let outExt = fmt;
    let outContent: string | Buffer = mdContent;
    let filterName = 'Markdown';
    let filterExts = ['md'];

    if (fmt === 'html') {
      filterName = 'HTML';
      filterExts = ['html'];
      // Use marked (available in main process via require)
      try {
        const { marked } = require('marked') as typeof import('marked');
        const htmlBody = (marked as any).parse(mdContent);
        outContent = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${baseName}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 900px; margin: 40px auto; padding: 0 24px; line-height: 1.6; color: #1a1a2e; background: #fff; }
  h1, h2, h3, h4 { color: #0f3460; margin-top: 1.5em; }
  h1 { font-size: 2em; border-bottom: 2px solid #e94560; padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #ddd; padding-bottom: 0.2em; }
  pre { background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 6px; padding: 16px; overflow-x: auto; font-size: 0.9em; }
  code { background: #f0f0f0; padding: 2px 5px; border-radius: 3px; font-size: 0.9em; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 4px solid #e94560; margin: 0; padding: 0 16px; color: #555; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
  th { background: #f0f0f0; font-weight: 600; }
  a { color: #0f3460; }
  img { max-width: 100%; }
</style>
</head>
<body>
${htmlBody}
</body>
</html>`;
      } catch (e) {
        // If marked fails, produce basic wrapped content
        const escaped = mdContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        outContent = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${baseName}</title></head><body><pre>${escaped}</pre></body></html>`;
      }
    } else if (fmt === 'pdf') {
      filterName = 'PDF';
      filterExts = ['pdf'];
      outExt = 'pdf';
      // We'll write the HTML to a temp file and use weasyprint or Electron printToPDF
      // This will be handled AFTER the save dialog (we need the output path first).
      outContent = mdContent; // placeholder; PDF generation happens below
    } else if (fmt === 'txt') {
      filterName = 'Text';
      filterExts = ['txt'];
      // Strip markdown formatting
      let txt = mdContent;
      txt = txt.replace(/^#{1,6}\s+/gm, '');           // headings
      txt = txt.replace(/\*\*(.+?)\*\*/g, '$1');         // bold
      txt = txt.replace(/\*(.+?)\*/g, '$1');             // italic
      txt = txt.replace(/__(.+?)__/g, '$1');             // bold alt
      txt = txt.replace(/_(.+?)_/g, '$1');               // italic alt
      txt = txt.replace(/~~(.+?)~~/g, '$1');             // strikethrough
      txt = txt.replace(/`{3}[\s\S]*?`{3}/g, (m) => {   // code fences
        const lines = m.split('\n');
        return lines.slice(1, -1).join('\n');
      });
      txt = txt.replace(/`(.+?)`/g, '$1');               // inline code
      txt = txt.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // links [text](url) → text
      txt = txt.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1'); // images
      txt = txt.replace(/^[-*+]\s+/gm, '• ');            // unordered lists
      txt = txt.replace(/^\d+\.\s+/gm, '');              // ordered lists
      txt = txt.replace(/^>\s+/gm, '');                  // blockquotes
      txt = txt.replace(/^-{3,}$/gm, '─'.repeat(40));   // horizontal rules
      txt = txt.replace(/\|/g, ' | ');                   // table pipes → spaced
      outContent = txt;
    }

    // Determine default output filename
    const defaultName = `${baseName}.${outExt}`;

    const saveResult = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Research Report',
      defaultPath: pathMod.join(os.homedir(), 'Downloads', defaultName),
      filters: [
        { name: filterName, extensions: filterExts },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return { success: false, error: 'Cancelled' };
    }

    const outPath = saveResult.filePath;

    if (fmt === 'pdf') {
      // Try weasyprint first, fall back to Electron printToPDF
      try {
        // Build HTML for PDF
        let htmlForPdf = '';
        try {
          const { marked } = require('marked') as typeof import('marked');
          const htmlBody = (marked as any).parse(mdContent);
          htmlForPdf = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${baseName}</title><style>body{font-family:sans-serif;max-width:900px;margin:40px auto;line-height:1.6;}h1,h2,h3{color:#333;}pre{background:#f6f8fa;padding:16px;border-radius:6px;}code{background:#f0f0f0;padding:2px 5px;}table{border-collapse:collapse;}th,td{border:1px solid #ddd;padding:8px;}th{background:#eee;}</style></head><body>${htmlBody}</body></html>`;
        } catch {
          htmlForPdf = `<!DOCTYPE html><html><body><pre>${mdContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></body></html>`;
        }

        // Check if weasyprint is available
        let weasyprintAvailable = false;
        try {
          execSync('which weasyprint', { stdio: 'ignore' });
          weasyprintAvailable = true;
        } catch { /* not available */ }

        if (weasyprintAvailable) {
          // Write HTML to temp file and convert
          const tmpHtml = pathMod.join(os.tmpdir(), `tappi-report-${Date.now()}.html`);
          fsSync.writeFileSync(tmpHtml, htmlForPdf, 'utf-8');
          execSync(`weasyprint "${tmpHtml}" "${outPath}"`, { timeout: 30000 });
          try { fsSync.unlinkSync(tmpHtml); } catch { /* ignore */ }
        } else {
          // Use Electron's printToPDF via hidden BrowserWindow
          const { BrowserWindow: BW } = require('electron');
          const pdfWin = new BW({ show: false, webPreferences: { sandbox: false } });
          await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlForPdf));
          const pdfData = await pdfWin.webContents.printToPDF({
            printBackground: true,
            pageSize: 'A4',
            marginsType: 1,
          });
          pdfWin.destroy();
          fsSync.writeFileSync(outPath, pdfData);
        }
      } catch (e: any) {
        return { success: false, error: 'PDF generation failed: ' + (e.message || e) };
      }
    } else {
      // Write text/html/md content
      fsSync.writeFileSync(outPath, outContent as string, 'utf-8');
    }

    return { success: true, path: outPath };
  };

  ipcMain.handle('deep:save-report', _deepSaveReportHandler);

  // ─── File Download (Phase 9.07 Track 5) — general-purpose file → save dialog ───
  ipcMain.handle('file:download', async (_e, sourcePath: string, format: string, defaultName?: string) => {
    const fsSync = require('fs') as typeof import('fs');
    const pathMod = require('path') as typeof import('path');
    const os = require('os') as typeof import('os');
    const { execSync } = require('child_process') as typeof import('child_process');

    if (!sourcePath || !fsSync.existsSync(sourcePath)) {
      return { success: false, error: 'File not found: ' + sourcePath };
    }

    const baseName = defaultName || pathMod.basename(sourcePath);
    const baseNoExt = baseName.replace(/\.[^.]+$/, '');
    const sourceExt = pathMod.extname(sourcePath).toLowerCase();
    const fmt = (format || sourceExt.slice(1) || 'bin').toLowerCase();

    // Determine dialog filter + default name
    const filterMap: Record<string, { name: string; exts: string[] }> = {
      md:   { name: 'Markdown', exts: ['md'] },
      html: { name: 'HTML', exts: ['html'] },
      pdf:  { name: 'PDF', exts: ['pdf'] },
      txt:  { name: 'Text', exts: ['txt'] },
      csv:  { name: 'CSV', exts: ['csv'] },
      json: { name: 'JSON', exts: ['json'] },
    };
    const fmtInfo = filterMap[fmt] || { name: 'File', exts: [fmt] };
    const saveDefaultName = baseNoExt + '.' + (fmtInfo.exts[0] || fmt);

    const saveResult = await dialog.showSaveDialog(mainWindow, {
      title: 'Save File',
      defaultPath: pathMod.join(os.homedir(), 'Downloads', saveDefaultName),
      filters: [
        { name: fmtInfo.name, extensions: fmtInfo.exts },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return { success: false, error: 'Cancelled' };
    }

    const outPath = saveResult.filePath;

    const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    function buildHtmlDoc(title: string, body: string): string {
      return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Georgia, serif; max-width: 820px; margin: 48px auto; padding: 0 24px; line-height: 1.75; color: #1a1a2e; background: #fff; font-size: 16px; }
  h1, h2, h3, h4, h5, h6 { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #0f3460; margin: 1.5em 0 0.5em; }
  h1 { font-size: 2em; border-bottom: 2px solid #e94560; padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #e0e0e0; padding-bottom: 0.2em; }
  p { margin: 0.9em 0; }
  pre { background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 6px; padding: 16px; overflow-x: auto; font-size: 0.88em; line-height: 1.45; }
  code { background: #f0f2f4; padding: 2px 5px; border-radius: 3px; font-size: 0.88em; font-family: 'Courier New', Consolas, monospace; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 4px solid #e94560; margin: 1em 0; padding: 0.5em 1em; color: #555; background: #fafafa; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
  th { background: #f5f5f5; font-weight: 600; }
  tr:nth-child(even) { background: #fafafa; }
  a { color: #0f3460; }
  img { max-width: 100%; }
  hr { border: none; border-top: 1px solid #e0e0e0; margin: 2em 0; }
  ul, ol { margin: 0.8em 0; padding-left: 2em; }
  li { margin: 0.3em 0; }
</style>
</head>
<body>
${body}
</body>
</html>`;
    }

    function stripMarkdownToText(md: string): string {
      return md
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/__(.+?)__/g, '$1')
        .replace(/_(.+?)_/g, '$1')
        .replace(/~~(.+?)~~/g, '$1')
        .replace(/`{3}[\s\S]*?`{3}/gm, (m) => m.split('\n').slice(1, -1).join('\n'))
        .replace(/`(.+?)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
        .replace(/^[-*+]\s+/gm, '• ')
        .replace(/^\d+\.\s+/gm, '')
        .replace(/^>\s*/gm, '')
        .replace(/^-{3,}$/gm, '─'.repeat(40))
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    try {
      const sourceContent = fsSync.readFileSync(sourcePath, 'utf-8');

      if (fmt === 'html') {
        let htmlBody = '';
        if (sourceExt === '.md') {
          try {
            const { marked } = require('marked') as typeof import('marked');
            htmlBody = (marked as any).parse(sourceContent) as string;
          } catch {
            htmlBody = '<pre>' + escHtml(sourceContent) + '</pre>';
          }
        } else {
          htmlBody = '<pre>' + escHtml(sourceContent) + '</pre>';
        }
        fsSync.writeFileSync(outPath, buildHtmlDoc(baseNoExt, htmlBody), 'utf-8');

      } else if (fmt === 'pdf') {
        let htmlForPdf = '';
        try {
          const { marked } = require('marked') as typeof import('marked');
          const htmlBody = sourceExt === '.md'
            ? ((marked as any).parse(sourceContent) as string)
            : '<pre>' + escHtml(sourceContent) + '</pre>';
          htmlForPdf = buildHtmlDoc(baseNoExt, htmlBody);
        } catch {
          htmlForPdf = buildHtmlDoc(baseNoExt, '<pre>' + escHtml(sourceContent) + '</pre>');
        }

        let weasyprintAvailable = false;
        try { execSync('which weasyprint', { stdio: 'ignore' }); weasyprintAvailable = true; } catch {}

        if (weasyprintAvailable) {
          const tmpHtml = pathMod.join(os.tmpdir(), `tappi-dl-${Date.now()}.html`);
          fsSync.writeFileSync(tmpHtml, htmlForPdf, 'utf-8');
          try {
            execSync(`weasyprint "${tmpHtml}" "${outPath}"`, { timeout: 30000 });
          } finally {
            try { fsSync.unlinkSync(tmpHtml); } catch {}
          }
        } else {
          const { BrowserWindow: BW } = require('electron');
          const pdfWin = new BW({ show: false, webPreferences: { sandbox: false } });
          await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlForPdf));
          const pdfData = await pdfWin.webContents.printToPDF({ printBackground: true, pageSize: 'A4', marginsType: 1 });
          pdfWin.destroy();
          fsSync.writeFileSync(outPath, pdfData);
        }

      } else if (fmt === 'txt') {
        const txt = sourceExt === '.md' ? stripMarkdownToText(sourceContent) : sourceContent;
        fsSync.writeFileSync(outPath, txt, 'utf-8');

      } else {
        // md, csv, json, original extension — copy as-is
        fsSync.copyFileSync(sourcePath, outPath);
      }

      return { success: true, path: outPath };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  // ─── Context menu IPC ───
  // ─── Overflow menu (native popup) ───
  ipcMain.on('overflow:popup', () => {
    if (!mainWindow || !tabManager) return;
    const wc = tabManager.activeWebContents;
    const zoomFactor = wc ? wc.getZoomFactor() : 1;
    const zoomPercent = Math.round(zoomFactor * 100);

    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: 'History',
        accelerator: 'CmdOrCtrl+Y',
        click: () => mainWindow.webContents.send('panel:open', 'history'),
      },
      {
        label: 'Bookmarks',
        accelerator: 'CmdOrCtrl+Shift+B',
        click: () => mainWindow.webContents.send('panel:open', 'bookmarks'),
      },
      {
        label: 'Downloads',
        accelerator: 'CmdOrCtrl+Shift+D',
        click: () => mainWindow.webContents.send('panel:open', 'downloads'),
      },
      { type: 'separator' },
      {
        label: 'Find on Page',
        accelerator: 'CmdOrCtrl+F',
        click: () => mainWindow.webContents.send('find:open'),
      },
      {
        label: `Zoom (${zoomPercent}%)`,
        submenu: [
          {
            label: 'Zoom In',
            accelerator: 'CmdOrCtrl+Plus',
            click: () => {
              if (!wc) return;
              wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 5));
              mainWindow.webContents.send('zoom:changed', wc.getZoomFactor());
            },
          },
          {
            label: 'Zoom Out',
            accelerator: 'CmdOrCtrl+-',
            click: () => {
              if (!wc) return;
              wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -5));
              mainWindow.webContents.send('zoom:changed', wc.getZoomFactor());
            },
          },
          {
            label: 'Reset Zoom',
            accelerator: 'CmdOrCtrl+0',
            click: () => {
              if (!wc) return;
              wc.setZoomLevel(0);
              mainWindow.webContents.send('zoom:changed', 1);
            },
          },
        ],
      },
      { type: 'separator' },
      {
        label: 'Print',
        accelerator: 'CmdOrCtrl+P',
        click: () => wc?.print(),
      },
      { type: 'separator' },
      {
        label: 'Settings',
        accelerator: 'CmdOrCtrl+,',
        click: () => mainWindow.webContents.send('settings:open'),
      },
    ];

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: mainWindow });
  });

  // ─── Page right-click context menu ───
  function setupPageContextMenu(wc: Electron.WebContents) {
    // Clear stale login hint when the tab navigates away (Phase 8.4.3)
    wc.on('did-navigate', () => {
      clearLoginHint(wc.id);
      // Phase 8.5: notify media engine of navigation (kills mpv session)
      const tabId = tabManager.getTabIdByWebContentsId(wc.id);
      if (tabId) onTabNavigated(tabId);
    });
    wc.on('did-navigate-in-page', () => clearLoginHint(wc.id));

    wc.on('context-menu', (_e, params) => {
      const template: Electron.MenuItemConstructorOptions[] = [];

      // Navigation
      template.push(
        { label: 'Back', enabled: wc.canGoBack(), click: () => wc.goBack() },
        { label: 'Forward', enabled: wc.canGoForward(), click: () => wc.goForward() },
        { label: 'Reload', click: () => wc.reload() },
        { type: 'separator' },
      );

      // Link-specific
      if (params.linkURL) {
        template.push(
          {
            label: 'Open Link in New Tab',
            click: () => tabManager?.createTab(params.linkURL),
          },
          {
            label: 'Copy Link Address',
            click: () => {
              const { clipboard } = require('electron');
              clipboard.writeText(params.linkURL);
            },
          },
          { type: 'separator' },
        );
      }

      // Image-specific
      if (params.hasImageContents && params.srcURL) {
        template.push(
          {
            label: 'Open Image in New Tab',
            click: () => tabManager?.createTab(params.srcURL),
          },
          {
            label: 'Copy Image Address',
            click: () => {
              const { clipboard } = require('electron');
              clipboard.writeText(params.srcURL);
            },
          },
          { type: 'separator' },
        );
      }

      // Text selection
      if (params.selectionText) {
        template.push(
          { label: 'Copy', role: 'copy' },
          { type: 'separator' },
          {
            label: `Search Google for "${params.selectionText.slice(0, 30)}${params.selectionText.length > 30 ? '…' : ''}"`,
            click: () => {
              tabManager?.createTab(`https://www.google.com/search?q=${encodeURIComponent(params.selectionText)}`);
            },
          },
          { type: 'separator' },
        );
      }

      // Editable field (input, textarea, contenteditable)
      if (params.isEditable) {
        template.push(
          { label: 'Undo', role: 'undo' },
          { label: 'Redo', role: 'redo' },
          { type: 'separator' },
          { label: 'Cut', role: 'cut' },
          { label: 'Copy', role: 'copy' },
          { label: 'Paste', role: 'paste' },
          { label: 'Select All', role: 'selectAll' },
          { type: 'separator' },
        );
      }

      // Always available
      if (!params.isEditable && !params.selectionText) {
        template.push(
          { label: 'Select All', role: 'selectAll' },
          { type: 'separator' },
        );
      }

      template.push(
        {
          label: 'View Page Source',
          click: () => {
            const url = wc.getURL();
            tabManager?.createTab(`view-source:${url}`);
          },
        },
        { label: 'Inspect Element', click: () => wc.inspectElement(params.x, params.y) },
      );

      const menu = Menu.buildFromTemplate(template);
      menu.popup({ window: mainWindow! });
    });
  }

  ipcMain.on('tab:context-menu', (_e, id: string) => {
    const info = tabManager.getTabInfo(id);
    if (!info) return;

    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: info.isPinned ? 'Unpin Tab' : 'Pin Tab',
        click: () => tabManager.pinTab(id),
      },
      {
        label: info.isMuted ? 'Unmute Tab' : 'Mute Tab',
        click: () => tabManager.muteTab(id),
      },
      { type: 'separator' },
      {
        label: 'Duplicate Tab',
        click: () => tabManager.duplicateTab(id),
      },
      { type: 'separator' },
      {
        label: 'Close Tab',
        click: () => {
          tabManager.closeTab(id);
          if (tabManager.tabCount === 0) mainWindow.close();
        },
      },
      {
        label: 'Close Other Tabs',
        click: () => tabManager.closeOtherTabs(id),
      },
      {
        label: 'Close Tabs to the Right',
        click: () => tabManager.closeTabsToRight(id),
      },
    ];

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: mainWindow });
  });

  mainWindow.on('closed', () => {
    tabManager.destroy();
  });
}

// Permission handling — with per-site remember-choice
app.on('ready', () => {
  const ses = session.defaultSession;
  const alwaysAllow = ['clipboard-read', 'clipboard-write', 'fullscreen', 'background-sync'];
  const askable = ['media', 'geolocation', 'notifications', 'midi'];

  ses.setPermissionCheckHandler((_wc, permission) => {
    if (alwaysAllow.includes(permission)) return true;
    // For askable permissions, check the database
    if (askable.includes(permission) && _wc) {
      try {
        const url = _wc.getURL();
        if (url) {
          const domain = new URL(url).hostname;
          const saved = getPermission(domain, permission);
          if (saved !== null) return saved;
        }
      } catch {}
    }
    return false;
  });

  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (alwaysAllow.includes(permission)) { callback(true); return; }

    if (askable.includes(permission) && _wc) {
      try {
        const url = _wc.getURL();
        if (url) {
          const domain = new URL(url).hostname;
          const saved = getPermission(domain, permission);
          if (saved !== null) { callback(saved); return; }

          // Ask the user
          if (mainWindow && !mainWindow.isDestroyed()) {
            dialog.showMessageBox(mainWindow, {
              type: 'question',
              title: 'Permission Request',
              message: `${domain} wants to use ${permission}`,
              detail: 'Do you want to allow this? Your choice will be remembered for this site.',
              buttons: ['Deny', 'Allow'],
              defaultId: 0,
              cancelId: 0,
            }).then(({ response }) => {
              const allowed = response === 1;
              setPermission(domain, permission, allowed);
              callback(allowed);
            });
            return;
          }
        }
      } catch {}
    }
    callback(false);
  });
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  cleanupCron();
  cleanupShell();
  cleanupAllSubAgents();
  cleanupAllTeams();
  captureCleanupOnQuit(); // Phase 8.6: stop any in-progress recording
  stopApiServer();        // Phase 8.45: stop HTTP API server
  purgeSession('default');
  closeDatabase();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── Dev CLI server (Phase 4 testing) ───
// Allows running commands from terminal: echo "elements" | nc localhost 18900
import * as net from 'net';
const DEV_PORT = 18900;

function startDevServer() {
  // F12: Read API token for TCP auth
  const tokenPath = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.tappi-browser', 'api-token');
  let devToken = '';
  try { devToken = fs.readFileSync(tokenPath, 'utf-8').trim(); } catch {}

  const server = net.createServer((socket) => {
    let buffer = '';
    let processing = false;
    let authenticated = false;

    async function processCommand(cmd: string) {
      if (!cmd || processing) return;
      processing = true;

      // F12: First command must be the auth token
      if (!authenticated) {
        if (!devToken || cmd !== devToken) {
          if (!socket.destroyed) socket.write('Error: Authentication failed. Send API token as first line.\n');
          if (!socket.destroyed) socket.end();
          processing = false;
          return;
        }
        authenticated = true;
        if (!socket.destroyed) socket.write('OK\n');
        processing = false;
        return;
      }
      console.log('[dev] Command:', cmd);

      // "agent: <message>" → run through LLM agent
      if (cmd.startsWith('agent:') || cmd.startsWith('agent ')) {
        const agentMsg = cmd.replace(/^agent[: ]+/, '').trim();
        if (!agentMsg) {
          if (!socket.destroyed) socket.write('Usage: agent: <message>\n');
          processing = false;
          if (!socket.destroyed) socket.end();
          return;
        }
        const apiKey = decryptApiKey(currentConfig.llm.apiKey);
        if (!apiKey) {
          if (!socket.destroyed) socket.write('Error: No API key configured\n');
          processing = false;
          if (!socket.destroyed) socket.end();
          return;
        }
        const browserCtx: BrowserContext = { window: mainWindow, tabManager, config: currentConfig };
        // Also show in the agent panel
        mainWindow?.webContents.send('agent:stream-start', {});
        runAgent({
          userMessage: agentMsg,
          browserCtx,
          llmConfig: {
            provider: currentConfig.llm.provider, model: currentConfig.llm.model, apiKey,
            thinking: currentConfig.llm.thinking,
            deepMode: currentConfig.llm.deepMode,
            region: currentConfig.llm.region, projectId: currentConfig.llm.projectId,
            location: currentConfig.llm.location, endpoint: currentConfig.llm.endpoint,
            baseUrl: currentConfig.llm.baseUrl,
            // Timeouts (Phase 8.40)
            agentTimeoutMs: currentConfig.llm.agentTimeoutMs,
            teammateTimeoutMs: currentConfig.llm.teammateTimeoutMs,
            subtaskTimeoutMs: currentConfig.llm.subtaskTimeoutMs,
          },
          window: mainWindow,
          developerMode: currentConfig.developerMode,
          deepMode: currentConfig.llm.deepMode !== false,
          codingMode: currentConfig.developerMode && (currentConfig.llm.codingMode === true),
          agentBrowsingDataAccess: currentConfig.privacy?.agentBrowsingDataAccess === true,
        });
        if (!socket.destroyed) socket.write('[agent] Running: ' + agentMsg + '\n');
        processing = false;
        if (!socket.destroyed) socket.end();
        return;
      }

      try {
        const browserCtx: BrowserContext = { window: mainWindow, tabManager, config: currentConfig };
        const result = await executeCommand(cmd, { browserCtx });
        if (!socket.destroyed) socket.write(result + '\n');
        mainWindow?.webContents.send('agent:response', {
          role: 'assistant',
          content: result,
          timestamp: Date.now(),
        });
      } catch (err: any) {
        if (!socket.destroyed) socket.write('Error: ' + err.message + '\n');
      }
      processing = false;
      if (!socket.destroyed) socket.end();
    }

    socket.setKeepAlive(true);
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes('\n') || buffer.includes('\r')) {
        const cmd = buffer.trim();
        buffer = '';
        processCommand(cmd);
      }
    });
    socket.on('end', () => {
      const cmd = buffer.trim();
      buffer = '';
      if (cmd && !processing) processCommand(cmd);
    });
    socket.on('error', () => {});
  });
  server.listen(DEV_PORT, '127.0.0.1', () => {
    console.log(`[dev] CLI server on port ${DEV_PORT}. Usage: echo "elements" | nc localhost ${DEV_PORT}`);
  });
  server.on('error', (e: any) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`[dev] Port ${DEV_PORT} in use, skipping dev server.`);
    }
  });
}

app.whenReady().then(() => {
  // Dev TCP server (port 18900) — only when Developer Mode is ON
  setTimeout(() => {
    if (currentConfig.developerMode) {
      startDevServer();
    } else {
      console.log('[dev] TCP CLI server disabled (Developer Mode is off). Enable in Settings to use port 18900.');
    }
  }, 1000); // Wait for window and config to be fully ready
});
