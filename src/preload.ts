import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('tappi', {
  // Tab operations
  createTab: (url?: string) => ipcRenderer.send('tab:create', url),
  closeTab: (id: string) => ipcRenderer.send('tab:close', id),
  switchTab: (id: string) => ipcRenderer.send('tab:switch', id),
  navigate: (id: string, url: string) => ipcRenderer.send('tab:navigate', id, url),
  reopenClosedTab: () => ipcRenderer.send('tab:reopen'),
  duplicateTab: (id: string) => ipcRenderer.send('tab:duplicate', id),
  pinTab: (id: string) => ipcRenderer.send('tab:pin', id),
  muteTab: (id: string) => ipcRenderer.send('tab:mute', id),
  closeOtherTabs: (id: string) => ipcRenderer.send('tab:close-others', id),
  closeTabsToRight: (id: string) => ipcRenderer.send('tab:close-right', id),
  reorderTab: (id: string, newIndex: number) => ipcRenderer.send('tab:reorder', id, newIndex),
  switchToIndex: (index: number) => ipcRenderer.send('tab:switch-index', index),
  showContextMenu: (id: string) => ipcRenderer.send('tab:context-menu', id),

  // Bookmarks
  toggleBookmark: (url: string) => ipcRenderer.send('bookmark:toggle', url),

  // Navigation
  goBack: () => ipcRenderer.send('nav:back'),
  goForward: () => ipcRenderer.send('nav:forward'),
  reload: () => ipcRenderer.send('nav:reload'),

  // Agent panel
  toggleAgent: () => ipcRenderer.send('agent:toggle'),
  sendAgentMessage: (message: string) => ipcRenderer.send('agent:send', message),
  stopAgent: () => ipcRenderer.send('agent:stop'),
  // Phase 9.096d: Unified interrupt/redirect
  interruptAgent: (target: string, targetName: string | null, message: string) =>
    ipcRenderer.invoke('agent:interrupt', { target, targetName, message }),
  clearAgent: () => ipcRenderer.send('agent:clear'),
  onAgentToggled: (callback: (isOpen: boolean) => void) => {
    ipcRenderer.on('agent:toggled', (_e, isOpen) => callback(isOpen));
  },
  onAgentResponse: (callback: (msg: { role: string; content: string; timestamp: number }) => void) => {
    ipcRenderer.on('agent:response', (_e, msg) => callback(msg));
  },
  onAgentStreamStart: (callback: () => void) => {
    ipcRenderer.on('agent:stream-start', () => callback());
  },
  onAgentStreamChunk: (callback: (chunk: { text: string; done: boolean }) => void) => {
    ipcRenderer.on('agent:stream-chunk', (_e, chunk) => callback(chunk));
  },
  onAgentToolResult: (callback: (result: { toolName: string; result: string; display: string }) => void) => {
    ipcRenderer.on('agent:tool-result', (_e, result) => callback(result));
  },
  onAgentReasoningChunk: (callback: (data: { text: string; done: boolean }) => void) => {
    ipcRenderer.on('agent:reasoning-chunk', (_e, data) => callback(data));
  },
  onAgentCleared: (callback: () => void) => {
    ipcRenderer.on('agent:cleared', () => callback());
  },
  onSubAgentProgress: (callback: (data: { agentId: string; taskType: string; step: number; tools: string[]; url?: string; status: string; elapsed: number; done: boolean }) => void) => {
    ipcRenderer.on('agent:subagent-progress', (_e, data) => callback(data));
  },
  onAgentTokenUsage: (callback: (data: { inputTokens: number; outputTokens: number; totalTokens: number }) => void) => {
    ipcRenderer.on('agent:token-usage', (_e, data) => callback(data));
  },
  // Phase 8.40: Progress tracking (elapsed timer + tool call counter)
  onAgentProgress: (callback: (data: { elapsed: number; toolCalls: number; timeoutMs: number }) => void) => {
    ipcRenderer.on('agent:progress', (_e, data) => callback(data));
  },
  getAgentProgress: () => ipcRenderer.invoke('agent:get-progress'),

  // Overlay management (hide/show BrowserViews for modals)
  showOverlay: () => ipcRenderer.send('overlay:show'),
  hideOverlay: () => ipcRenderer.send('overlay:hide'),
  setAutocompleteHeight: (height: number) => ipcRenderer.send('autocomplete:resize', height),

  // Settings / Config
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (updates: any) => ipcRenderer.invoke('config:save', updates),
  revealProviderApiKey: () => ipcRenderer.invoke('config:reveal-api-key'),
  hasProviderKey: (provider: string) => ipcRenderer.invoke('config:has-provider-key', provider),
  onConfigLoaded: (callback: (config: any) => void) => {
    ipcRenderer.on('config:loaded', (_e, config) => callback(config));
  },

  // Listen for tab updates
  onTabsUpdated: (callback: (tabs: any[]) => void) => {
    ipcRenderer.on('tabs:updated', (_e, tabs) => callback(tabs));
  },

  // Listen for fullscreen changes
  onFullscreenChanged: (callback: (isFullscreen: boolean) => void) => {
    ipcRenderer.on('fullscreen:changed', (_e, isFullscreen) => callback(isFullscreen));
  },

  // Listen for focus address bar command
  onFocusAddressBar: (callback: () => void) => {
    ipcRenderer.on('focus:addressbar', () => callback());
  },

  // Listen for settings open command
  onSettingsOpen: (callback: () => void) => {
    ipcRenderer.on('settings:open', () => callback());
  },
  onSettingsSwitchTab: (callback: (tab: string) => void) => {
    ipcRenderer.on('settings:switch-tab', (_e, tab) => callback(tab));
  },

  // API Services
  getApiServices: () => ipcRenderer.invoke('api-services:list'),
  addApiService: (service: any) => ipcRenderer.invoke('api-services:add', service),
  updateApiService: (name: string, service: any) => ipcRenderer.invoke('api-services:update', name, service),
  deleteApiService: (name: string) => ipcRenderer.invoke('api-services:delete', name),
  revealApiKey: (name: string) => ipcRenderer.invoke('api-services:reveal-key', name),
  onApiServicesUpdated: (callback: (services: any) => void) => {
    ipcRenderer.on('api-services:updated', (_e, services) => callback(services));
  },

  // Credential detection & testing (Phase 6.5)
  checkCredentials: (provider: string, options?: any) => ipcRenderer.invoke('credentials:check', provider, options),
  testConnection: (provider: string, config: any) => ipcRenderer.invoke('credentials:test', provider, config),
  getDefaultModel: (provider: string) => ipcRenderer.invoke('provider:default-model', provider),

  // Dark Mode (direct toggle, no agent)
  toggleDarkMode: (enable: boolean) => ipcRenderer.send('darkmode:toggle', enable),

  // History / Autocomplete
  searchHistory: (query: string, limit?: number) => ipcRenderer.invoke('history:search', query, limit),
  getRecentHistory: (limit?: number) => ipcRenderer.invoke('history:recent', limit),
  clearHistory: (range?: string) => ipcRenderer.invoke('history:clear', range),
  getSearchSuggestions: (query: string) => ipcRenderer.invoke('suggest:search', query),

  // Bookmarks (panel)
  getAllBookmarks: () => ipcRenderer.invoke('bookmarks:all'),
  searchBookmarks: (query: string) => ipcRenderer.invoke('bookmarks:search', query),
  removeBookmark: (url: string) => ipcRenderer.invoke('bookmarks:remove', url),

  // Find on Page
  findOnPage: (text: string, options?: { forward?: boolean }) => ipcRenderer.send('find:start', text, options),
  findNext: (forward?: boolean) => ipcRenderer.send('find:next', forward),
  stopFind: () => ipcRenderer.send('find:stop'),
  setFindBarOpen: (open: boolean) => ipcRenderer.send('findbar:toggle', open),
  onFindResult: (callback: (result: { activeMatchOrdinal: number; matches: number }) => void) => {
    ipcRenderer.on('find:result', (_e, result) => callback(result));
  },

  // Print
  printPage: () => ipcRenderer.send('page:print'),

  // Zoom
  zoomIn: () => ipcRenderer.send('zoom:in'),
  zoomOut: () => ipcRenderer.send('zoom:out'),
  zoomReset: () => ipcRenderer.send('zoom:reset'),
  getZoomLevel: () => ipcRenderer.invoke('zoom:get'),
  onZoomChanged: (callback: (level: number) => void) => {
    ipcRenderer.on('zoom:changed', (_e, level) => callback(level));
  },

  // Overflow menu (native popup)
  showOverflowMenu: () => ipcRenderer.send('overflow:popup'),

  // Navigate to URL from panels
  openUrl: (url: string) => ipcRenderer.send('tab:navigate-or-create', url),

  // Menu command listeners
  onFindOpen: (callback: () => void) => {
    ipcRenderer.on('find:open', () => callback());
  },
  onPanelOpen: (callback: (panel: string) => void) => {
    ipcRenderer.on('panel:open', (_e, panel) => callback(panel));
  },

  // Ad Blocker
  toggleAdBlocker: (enable: boolean) => ipcRenderer.invoke('adblock:toggle', enable),
  getBlockedCount: () => ipcRenderer.invoke('adblock:count'),
  onAdBlockCount: (callback: (count: number) => void) => {
    ipcRenderer.on('adblock:count', (_e, count) => callback(count));
  },

  // Downloads
  getDownloads: () => ipcRenderer.invoke('downloads:list'),
  cancelDownload: (id: string) => ipcRenderer.invoke('downloads:cancel', id),
  clearDownloads: () => ipcRenderer.invoke('downloads:clear'),
  onDownloadsUpdated: (callback: (data: any) => void) => {
    ipcRenderer.on('downloads:updated', (_e, data) => callback(data));
  },

  // Password Vault
  listVaultDomains: () => ipcRenderer.invoke('vault:list-domains'),
  getVaultCredentials: (domain: string) => ipcRenderer.invoke('vault:get-for-domain', domain),
  saveVaultCredential: (domain: string, username: string, password: string) => ipcRenderer.invoke('vault:save', domain, username, password),
  deleteVaultCredential: (id: number) => ipcRenderer.invoke('vault:delete', id),
  generatePassword: (length?: number) => ipcRenderer.invoke('vault:generate', length),
  autofillCredential: (domain: string, username?: string) => ipcRenderer.invoke('vault:autofill', domain, username),
  onVaultSavePrompt: (callback: (data: { domain: string; username: string }) => void) => {
    ipcRenderer.on('vault:save-prompt', (_e, data) => callback(data));
  },

  // Permissions
  getSitePermission: (domain: string, perm: string) => ipcRenderer.invoke('permission:get', domain, perm),
  setSitePermission: (domain: string, perm: string, allowed: boolean) => ipcRenderer.invoke('permission:set', domain, perm, allowed),

  // Developer Mode
  getDevMode: () => ipcRenderer.invoke('devmode:get'),
  setDevMode: (enabled: boolean) => ipcRenderer.invoke('devmode:set', enabled),
  onDevModeChanged: (callback: (enabled: boolean) => void) => {
    ipcRenderer.on('devmode:changed', (_e, enabled) => callback(enabled));
  },

  // CLI Tools
  getCliTools: () => ipcRenderer.invoke('tools:list'),
  verifyCliTools: () => ipcRenderer.invoke('tools:verify'),
  onToolsUpdated: (callback: () => void) => {
    ipcRenderer.on('tools:updated', () => callback());
  },

  // Cron Jobs
  getCronJobs: () => ipcRenderer.invoke('cron:list'),
  addCronJob: (data: { name: string; task: string; schedule: any }) => ipcRenderer.invoke('cron:add', data),
  updateCronJob: (id: string, updates: any) => ipcRenderer.invoke('cron:update', id, updates),
  deleteCronJob: (id: string) => ipcRenderer.invoke('cron:delete', id),
  runCronJobNow: (id: string) => ipcRenderer.invoke('cron:run-now', id),
  getCronActiveCount: () => ipcRenderer.invoke('cron:active-count'),
  onCronJobsUpdated: (callback: (jobs: any[]) => void) => {
    ipcRenderer.on('cron:jobs-updated', (_e, jobs) => callback(jobs));
  },
  onCronJobRunning: (callback: (data: { id: string; name: string }) => void) => {
    ipcRenderer.on('cron:job-running', (_e, data) => callback(data));
  },
  onCronJobCompleted: (callback: (data: { id: string; name: string; status: string; result: string; durationMs: number }) => void) => {
    ipcRenderer.on('cron:job-completed', (_e, data) => callback(data));
  },

  // Coding Mode (Phase 8.38)
  getCodingMode: () => ipcRenderer.invoke('codingmode:get'),
  setCodingMode: (enabled: boolean) => ipcRenderer.invoke('codingmode:set', enabled),
  onCodingModeChanged: (callback: (enabled: boolean) => void) => {
    ipcRenderer.on('codingmode:changed', (_e, enabled) => callback(enabled));
  },

  // Team Status (Phase 8.38)
  getTeamStatus: () => ipcRenderer.invoke('team:status'),
  onTeamUpdated: (callback: (data: any) => void) => {
    ipcRenderer.on('team:updated', (_e, data) => callback(data));
  },

  // Worktree Isolation (Phase 8.39)
  getWorktreeIsolation: () => ipcRenderer.invoke('worktree-isolation:get'),
  setWorktreeIsolation: (enabled: boolean) => ipcRenderer.invoke('worktree-isolation:set', enabled),
  onWorktreeIsolationChanged: (callback: (enabled: boolean) => void) => {
    ipcRenderer.on('worktree-isolation:changed', (_e, enabled) => callback(enabled));
  },

  // Profile Management (Phase 8.4.4)
  showProfileMenu: () => ipcRenderer.send('profile:show-menu'),
  getApiToken: () => ipcRenderer.invoke('devmode:api-token'),
  listProfiles: () => ipcRenderer.invoke('profile:list'),
  createProfile: (name: string, email?: string) => ipcRenderer.invoke('profile:create', name, email),
  switchProfile: (name: string) => ipcRenderer.invoke('profile:switch', name),
  deleteProfile: (name: string) => ipcRenderer.invoke('profile:delete', name),
  exportProfile: (profileName: string, password: string) => ipcRenderer.invoke('profile:export', profileName, password),
  importProfile: (password: string) => ipcRenderer.invoke('profile:import', password),
  getActiveProfile: () => ipcRenderer.invoke('profile:get-active'),
  onProfileLoaded: (callback: (data: any) => void) => {
    ipcRenderer.on('profile:loaded', (_e, data) => callback(data));
  },
  onProfileSwitched: (callback: (data: any) => void) => {
    ipcRenderer.on('profile:switched', (_e, data) => callback(data));
  },
  onProfileUpdated: (callback: (profiles: any[]) => void) => {
    ipcRenderer.on('profile:updated', (_e, profiles) => callback(profiles));
  },

  // Site Identity (Phase 8.4.6)
  openSiteIdentity: (domain: string, username: string) => ipcRenderer.invoke('profile:open-site-identity', domain, username),
  getSiteIdentities: (domain: string) => ipcRenderer.invoke('profile:site-identities', domain),

  // Explicit bridges (formerly generic invoke/on — now locked to known channels)
  toggleMediaActive: () => ipcRenderer.invoke('media:toggle-active'),
  setMediaEnabled: (enabled: boolean) => ipcRenderer.invoke('media:set-enabled', enabled),

  onAgentVisible: (callback: (visible: boolean) => void) => {
    ipcRenderer.on('agent:visible', (_e, visible) => callback(visible));
  },
  onMediaStatus: (callback: (status: any) => void) => {
    ipcRenderer.on('media:status', (_e, status) => callback(status));
  },

  // ─── Capture / Self-Recording (Phase 8.6) ───
  getRecordingStatus: () => ipcRenderer.invoke('capture:record-status'),
  stopRecording: () => ipcRenderer.invoke('capture:record-stop'),
  onRecordingUpdate: (callback: (status: any) => void) => {
    ipcRenderer.on('capture:recording-update', (_e, status) => callback(status));
  },

  // ─── User Profile (Phase 9.096c) ───
  loadUserProfile: () => ipcRenderer.invoke('user-profile:load'),
  saveUserProfile: (text: string) => ipcRenderer.invoke('user-profile:save', text),
  getEnrichmentStatus: () => ipcRenderer.invoke('user-profile:enrichment-status'),
  refreshEnrichment: () => ipcRenderer.invoke('user-profile:refresh-enrichment'),
  onUserProfileUpdated: (callback: (text: string) => void) => {
    ipcRenderer.on('user-profile:updated', (_e, text) => callback(text));
  },

  // ─── File Downloads (Phase 9.07 Track 5) ───
  onPresentDownload: (callback: (data: { path: string; name: string; size: number; formats: string[]; description?: string }) => void) => {
    console.log('[preload.js] Registering onPresentDownload callback');
    ipcRenderer.on('agent:present-download', (_e, data) => {
      console.log('[preload.js] Received agent:present-download event:', data);
      callback(data);
    });
  },

  downloadFile: (sourcePath: string, format: string, defaultName?: string) =>
    ipcRenderer.invoke('file:download', sourcePath, format, defaultName),
});
