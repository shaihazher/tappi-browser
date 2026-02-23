# Electron Structure

Detailed reference for Tappi's Electron architecture: processes, windows, views, preload scripts, and IPC channels.

---

## Main Process (`src/main.ts`, 2030 lines)

The main process is the application hub. It owns:

| Responsibility | Implementation |
|----------------|---------------|
| Window creation & lifecycle | `BrowserWindow` + `app` events |
| Tab management | `TabManager` (via `WebContentsView`) |
| Agent execution | `runAgent()` / `stopAgent()` from `agent.ts` |
| Configuration | `loadConfig()` / `saveConfig()` — profile-relative JSON |
| API key encryption | `safeStorage` (macOS Keychain); fallback to prefixed plain text |
| Database | SQLite via `database.ts` (history, bookmarks, permissions) |
| Download management | `download-manager.ts` |
| Ad blocker | `ad-blocker.ts` (can be toggled per-session) |
| HTTP API server | `api-server.ts` — only active in Developer Mode |
| Cron jobs | `cron-manager.ts` — periodic agent runs |
| Media engine | `media-engine.ts` — mpv overlay for video playback |
| Profile management | `profile-manager.ts` — named browser profiles |
| Session management | `session-manager.ts` — Electron session partitions |
| Capture | `capture-tools.ts` — screen recording |
| Team management | `team-manager.ts` (Coding Mode) |

### Startup Sequence

```
app.ready
  └─ createWindow()
       ├─ initDatabase(profileManager.getDatabasePath())
       ├─ new BrowserWindow({ preload: preload.js })
       ├─ mainWindow.loadFile('ui/index.html')   ← Chrome UI
       ├─ new TabManager(mainWindow, CHROME_HEIGHT)
       ├─ initDownloadManager()
       ├─ startAdBlocker()  [if enabled]
       ├─ initCronManager()
       ├─ initMediaEngine()
       ├─ startApiServer()  [Developer Mode only]
       └─ mainWindow.webContents.on('did-finish-load')
            ├─ tabManager.createAriaTab()   ← Aria tab always at index 0
            ├─ createConversation() / find existing empty conversation
            └─ layoutViews()
```

### Layout System

```
┌────────────────────────────────────────┐
│  Chrome UI (BrowserWindow, index.html) │  ← CHROME_HEIGHT = 74px (tab bar 38 + address bar 36)
├────────────────────────────────────────┤
│                        │ Agent Strip   │  ← AGENT_STRIP_WIDTH = 40px (collapsed)
│  WebContentsView       │ or            │  ← AGENT_PANEL_WIDTH = 380px (expanded)
│  (active tab content)  │ Agent Panel   │
│                        │               │
├────────────────────────┴───────────────┤
│  Status Bar                            │  ← STATUS_BAR_HEIGHT = 34px
└────────────────────────────────────────┘
```

`layoutViews()` in main.ts computes available width, then delegates to `tabManager.layoutActiveTab()`. When the Aria tab is active, the agent sidebar is hidden entirely (the Aria tab *is* the agent experience).

---

## BrowserWindow vs WebContentsView

Tappi uses **one** `BrowserWindow` for the entire application:

| Component | Type | Content |
|-----------|------|---------|
| App shell | `BrowserWindow.webContents` | `ui/index.html` (chrome, tab bar, address bar, agent panel) |
| Aria tab | `WebContentsView` | `ui/aria.html` (full-page chat UI) |
| Web tabs (× N) | `WebContentsView` | External web pages |

`WebContentsView` instances are children of `mainWindow.contentView`. The `TabManager` manages their z-order by removing all views and re-adding only the active one on each tab switch — preventing inactive views from bleeding through transparent areas.

### Why `WebContentsView` not `BrowserView`?
`BrowserView` is deprecated. `WebContentsView` is the modern API and allows proper view stacking via `addChildView` / `removeChildView`.

---

## TabManager (`src/tab-manager.ts`, 632 lines)

### Tab Data Structure

```typescript
interface Tab {
  id: string;           // UUID
  view: WebContentsView;
  title: string;
  url: string;
  favicon: string;
  isLoading: boolean;
  isPinned: boolean;
  isAria?: boolean;     // Aria tab — non-closeable, always at order[0]
}
```

### Key Methods

| Method | Description |
|--------|-------------|
| `createAriaTab()` | Creates Aria tab at order[0], loads `ui/aria.html`, uses `aria-preload.js` |
| `createTab(url?, partition?)` | Creates regular tab with `content-preload.js`; optional named session partition |
| `closeTab(id)` | Removes view, pops closed stack (max 20). Aria tab is protected (no-op) |
| `switchTab(id)` | Removes all child views, re-adds only the active one, calls `layoutActiveTab()` |
| `layoutActiveTab()` | Sets `WebContentsView.setBounds()` based on stored `lastLayoutWidth/Height` |
| `notifyChrome()` | Sends `tabs:updated` IPC to chrome UI with serialized tab list |
| `getTabIdByWebContentsId(wcId)` | Reverse lookup for media IPC event routing |
| `activeWebTabWebContents` | Like `activeWebContents` but skips the Aria tab — used by all agent interactions |
| `hideAllViews()` / `showAllViews()` | Used by overlay:show/hide to temporarily hide tabs for modals |

### Tab Lifecycle Events

Each `WebContentsView.webContents` subscribes to:
- `page-title-updated` → update tab title, `notifyChrome()`
- `did-start-loading` / `did-stop-loading` → update `isLoading`, `notifyChrome()`
- `did-navigate` / `did-navigate-in-page` → update URL, add to history DB
- `page-favicon-updated` → update favicon URL
- `found-in-page` → forward find results to chrome UI
- `enter-html-full-screen` / `leave-html-full-screen` → fullscreen layout management
- `render-process-gone` → auto-reload after 1.5s
- `unresponsive` / `responsive` → update title indicator

---

## Preload Scripts

Three distinct preload scripts serve three different renderer contexts.

### 1. `src/preload.ts` — Chrome UI Bridge

**Loaded by:** `BrowserWindow` (`webPreferences.preload`)  
**Exposes:** `window.tappi` (via `contextBridge.exposeInMainWorld`)  
**Context:** Chrome renderer (sandboxed)

Provides ~60+ methods covering:

| Category | Methods |
|----------|---------|
| Tabs | `createTab`, `closeTab`, `switchTab`, `navigate`, `reopenClosedTab`, `duplicateTab`, `pinTab`, `muteTab`, `closeOtherTabs`, `closeTabsToRight`, `reorderTab`, `switchToIndex` |
| Navigation | `goBack`, `goForward`, `reload` |
| Bookmarks | `toggleBookmark`, `getAllBookmarks`, `searchBookmarks`, `removeBookmark` |
| Agent (sidebar) | `toggleAgent`, `sendAgentMessage`, `stopAgent`, `clearAgent` |
| Agent events | `onAgentToggled`, `onAgentResponse`, `onAgentStreamStart`, `onAgentStreamChunk`, `onAgentToolResult`, `onAgentCleared`, `onAgentTokenUsage`, `onAgentProgress` |
| Deep mode events | `onDeepPlan`, `onDeepSubtaskStart`, `onDeepSubtaskDone`, `onDeepStreamChunk`, `onDeepToolResult`, `onDeepComplete` |
| Config | `getConfig`, `saveConfig`, `onConfigLoaded` |
| History | `searchHistory`, `getRecentHistory`, `clearHistory`, `getSearchSuggestions` |
| Find on Page | `findOnPage`, `findNext`, `stopFind` |
| Zoom | `zoomIn`, `zoomOut`, `zoomReset`, `getZoomLevel` |
| Ad Blocker | `toggleAdBlocker`, `getBlockedCount` |
| Downloads | `getDownloads`, `cancelDownload`, `clearDownloads` |
| Password Vault | `listVaultDomains`, `getVaultCredentials`, `saveVaultCredential`, `deleteVaultCredential`, `generatePassword`, `autofillCredential` |
| Permissions | `getSitePermission`, `setSitePermission` |
| Profiles | `listProfiles`, `createProfile`, `switchProfile`, `deleteProfile`, `exportProfile`, `importProfile`, `showProfileMenu` |
| Site Identity | `openSiteIdentity`, `getSiteIdentities` |
| Developer Mode | `getDevMode`, `setDevMode`, `getApiToken` |
| Coding Mode | `getCodingMode`, `setCodingMode` |
| Team Status | `getTeamStatus` |
| Worktree Isolation | `getWorktreeIsolation`, `setWorktreeIsolation` |
| Cron Jobs | `getCronJobs`, `addCronJob`, `updateCronJob`, `deleteCronJob`, `runCronJobNow` |
| CLI Tools | `getCliTools`, `verifyCliTools` |
| API Services | `getApiServices`, `addApiService`, `updateApiService`, `deleteApiService` |
| Credentials | `checkCredentials`, `testConnection` |
| Capture | `getRecordingStatus`, `stopRecording` |
| Media | `invoke('media:toggle-active')`, `invoke('media:set-enabled')` |
| Overlay | `showOverlay`, `hideOverlay` |
| Generic | `invoke(channel, ...args)`, `on(channel, callback)` |

### 2. `src/content-preload.js` — Tab Content Bridge

**Loaded by:** Every regular `WebContentsView` (`webPreferences.preload`)  
**Exposes:** `window.__tappi` (via `contextBridge.exposeInMainWorld`)  
**Context:** Tab content renderer (sandboxed, contextIsolation=true)

| Method | Description |
|--------|-------------|
| `indexElements(filter?, grep?)` | Core DOM indexer — returns compact JSON indexed list |
| `getElementPosition(idx)` | Returns `{x, y, width, height, tag}` for stamped element |
| `focusElement(idx)` | Focus + scroll into view + select text (for inputs) |
| `checkElement(idx)` | Returns element state: value, checked, disabled, focused |
| `extractText(selector?, grep?)` | Walk DOM text nodes, return compact text or grep matches |
| `clickElement(idx)` | Scroll into view + dispatch `mousedown`/`mouseup`/`click` |
| `getPageState()` | Returns `{url, title, dialogs}` |
| `getLoginState()` | Returns `{detected, domain}` — password field presence |
| `detectVideo()` | Returns video element info for media engine |
| `hideVideo()` / `showVideo()` | Mute/hide or restore browser's `<video>` element |

Also sets up IPC senders (one-way, no reply):
- `page:login-detected` — triggered by MutationObserver when `input[type=password]` appears
- `vault:credential-detected` — triggered on form submit with username+password
- `media:video-detected-from-page` — when a `<video>` appears or its src changes
- `media:geometry-changed-from-page` — ResizeObserver/MutationObserver/scroll on video element
- `media:play-pause-from-page` / `media:seeked-from-page` — video playback events

See [Indexer](indexer.md) for a deep dive into `indexElements`.

### 3. `src/aria-preload.ts` — Aria Tab Bridge

**Loaded by:** Aria tab `WebContentsView` (`webPreferences.preload`, `sandbox: false`)  
**Exposes:** `window.aria` (via `contextBridge.exposeInMainWorld`)  
**Context:** Aria tab renderer (sandbox=false required for IPC)

| Method | Description |
|--------|-------------|
| `sendMessage(message, conversationId?)` | Send user message to agent via `aria:send` |
| `stopAgent()` | Abort current agent run |
| `onStreamStart(cb)` / `onStreamChunk(cb)` | Streaming response events |
| `onToolResult(cb)` | Tool call display events |
| `onTokenUsage(cb)` | Token usage after each run |
| `newChat()` | Create new conversation (IPC invoke) |
| `switchConversation(id)` | Switch active conversation |
| `deleteConversation(id)` | Delete conversation from SQLite |
| `renameConversation(id, title)` | Update conversation title |
| `listConversations()` | List all conversations (max 50) |
| `getConversationMessages(id, offset?, limit?)` | Paginated message history |
| `searchConversations(query)` | Full-text search across conversations |
| `onConversationUpdated(cb)` | Fired after each agent response |
| `onConversationSwitched(cb)` | Fired when main process switches active conversation |
| `onDeepPlan(cb)`, `onDeepSubtaskStart(cb)`, etc. | Deep mode progress events |
| `getDevMode()` / `onDevModeChanged(cb)` | Developer mode state |
| `getCodingMode()` / `setCodingMode(enabled)` | Coding mode toggle (primary in Aria UI) |
| `getTeamStatus()` / `onTeamUpdated(cb)` | Team status card |

---

## IPC Channels Reference

All channels declared in `main.ts` (handlers) and reflected in `preload.ts` / `aria-preload.ts` (callers).

### One-Way: Renderer → Main (`ipcMain.on`)

| Channel | Sender | Handler |
|---------|--------|---------|
| `tab:create` | chrome | Create new tab |
| `tab:close` | chrome | Close tab by ID |
| `tab:switch` | chrome | Switch active tab |
| `tab:navigate` | chrome | Navigate tab to URL |
| `tab:reopen` | chrome | Reopen last closed tab |
| `tab:duplicate` | chrome | Duplicate tab |
| `tab:pin` | chrome | Toggle pin on tab |
| `tab:mute` | chrome | Toggle mute on tab |
| `tab:close-others` | chrome | Close all other tabs |
| `tab:close-right` | chrome | Close tabs to right |
| `tab:reorder` | chrome | Reorder tab to index |
| `tab:switch-index` | chrome | Switch to tab by 0-based index (9 = last) |
| `tab:navigate-or-create` | chrome | Navigate active tab or open new tab |
| `tab:context-menu` | chrome | Show native context menu for tab |
| `bookmark:toggle` | chrome | Toggle bookmark for URL |
| `nav:back` | chrome | Navigate active tab back |
| `nav:forward` | chrome | Navigate active tab forward |
| `nav:reload` | chrome | Reload active tab |
| `agent:toggle` | chrome | Toggle agent sidebar panel |
| `agent:send` | chrome | Send message to agent (sidebar mode) |
| `agent:stop` | chrome | Abort current agent run |
| `agent:clear` | chrome | Clear in-memory conversation history |
| `aria:send` | aria | Send message to agent (Aria tab mode) |
| `aria:stop` | aria | Abort current agent run |
| `darkmode:toggle` | chrome | Toggle dark mode CSS injection on active tab |
| `find:start` | chrome | Start find-in-page |
| `find:next` | chrome | Find next/previous |
| `find:stop` | chrome | Stop find-in-page |
| `findbar:toggle` | chrome | Notify tab of findbar open state |
| `page:print` | chrome | Print active tab |
| `zoom:in` / `zoom:out` / `zoom:reset` | chrome | Zoom active tab |
| `overflow:popup` | chrome | Show native overflow menu |
| `overlay:show` | chrome | Hide all WebContentsViews (for modal) |
| `overlay:hide` | chrome | Restore active WebContentsView |
| `autocomplete:resize` | chrome | Adjust autocomplete dropdown height |
| `profile:show-menu` | chrome | Show native profile switcher menu |
| `page:login-detected` | content | Log login form detection, set login hint |
| `vault:credential-detected` | content | Prompt to save credentials |
| `media:video-detected-from-page` | content | Route to media engine |
| `media:geometry-changed-from-page` | content | Route to media engine |
| `media:play-pause-from-page` | content | Route to media engine |
| `media:seeked-from-page` | content | Route to media engine |

### Invoke: Renderer → Main, with reply (`ipcMain.handle`)

| Channel | Returns |
|---------|---------|
| `config:get` | Config object (API key masked) |
| `config:save` | `{ success }` |
| `agent:get-progress` | `AgentProgressData` |
| `aria:new-chat` | New conversation object |
| `aria:switch-conversation` | `{ success, conversationId }` |
| `aria:delete-conversation` | `{ success }` |
| `aria:rename-conversation` | `{ success }` |
| `aria:list-conversations` | Array of conversations (max 50) |
| `aria:get-messages` | Paginated messages array |
| `aria:search-conversations` | Matching conversations array |
| `aria:get-active-conversation` | Active conversation ID string |
| `history:search` | Matching history items |
| `history:recent` | Recent history items |
| `history:clear` | Cleared rows count |
| `suggest:search` | Search suggestions array |
| `bookmarks:all` | All bookmarks |
| `bookmarks:search` | Matching bookmarks |
| `bookmarks:remove` | `{ success }` |
| `zoom:get` | Current zoom level |
| `adblock:toggle` | `{ enabled, count }` |
| `adblock:count` | Blocked count number |
| `downloads:list` | Downloads summary |
| `downloads:cancel` | `{ success }` |
| `downloads:clear` | `{ success }` |
| `vault:list-domains` | Array of saved domains |
| `vault:get-for-domain` | Array of credentials |
| `vault:save` | `{ success }` |
| `vault:delete` | `{ success }` |
| `vault:generate` | Generated password string |
| `vault:autofill` | Injects autofill script into active tab |
| `permission:get` | Permission value |
| `permission:set` | `{ success }` |
| `devmode:get` | Boolean |
| `devmode:set` | `{ success, developerMode }` |
| `devmode:api-token` | Token string (dev mode only) |
| `codingmode:get` | `{ enabled, devModeRequired }` |
| `codingmode:set` | `{ success, codingMode }` |
| `worktree-isolation:get` | `{ enabled, codingModeRequired, devModeRequired }` |
| `worktree-isolation:set` | `{ success, worktreeIsolation }` |
| `team:status` | Team status UI object |
| `tools:list` | Array of registered CLI tools |
| `tools:verify` | Tool verification results |
| `cron:list` | Array of cron jobs |
| `cron:add` | New cron job object |
| `cron:update` | Updated job object |
| `cron:delete` | `{ success }` |
| `cron:run-now` | `{ success }` |
| `cron:active-count` | Number of active jobs |
| `api-services:list` | `{ services, keys, orphans }` |
| `api-services:add` | `{ success }` |
| `api-services:update` | `{ success }` |
| `api-services:delete` | `{ success }` |
| `api-services:reveal-key` | `{ key }` |
| `credentials:check` | Credential check result |
| `credentials:test` | Connection test result |
| `provider:default-model` | Default model string |
| `profile:list` | Array of profile objects |
| `profile:create` | New profile object |
| `profile:switch` | `{ success, profile, profiles }` |
| `profile:delete` | `{ success }` |
| `profile:export` | `{ success }` |
| `profile:import` | `{ success }` |
| `profile:get-active` | `{ name, profiles }` |
| `profile:open-site-identity` | `{ success, partition }` |
| `profile:site-identities` | Array of SiteIdentity objects |
| `media:toggle-active` | `{ success }` |
| `media:set-enabled` | `{ success }` |
| `capture:record-status` | Recording status object |
| `capture:record-stop` | Recording result |

### One-Way: Main → Renderer (`webContents.send`)

| Channel | Target | Payload |
|---------|--------|---------|
| `tabs:updated` | chrome | Serialized tab list array |
| `agent:toggled` | chrome | `boolean` |
| `agent:visible` | chrome | `boolean` |
| `agent:response` | chrome | `{ role, content, timestamp }` (text-command mode only) |
| `agent:stream-start` | chrome + aria | `{}` |
| `agent:stream-chunk` | chrome + aria | `{ text, done }` |
| `agent:tool-result` | chrome + aria | `{ toolName, result, display }` |
| `agent:cleared` | chrome | `{}` |
| `agent:token-usage` | chrome + aria | `{ inputTokens, outputTokens, totalTokens }` |
| `agent:progress` | chrome + aria | `{ elapsed, toolCalls, timeoutMs }` |
| `agent:deep-plan` | chrome + aria | `{ mode, subtasks }` |
| `agent:deep-subtask-start` | chrome + aria | `{ index, task, tool }` |
| `agent:deep-subtask-done` | chrome + aria | `{ index, status, duration, error? }` |
| `agent:deep-stream-chunk` | chrome + aria | `{ index, chunk }` |
| `agent:deep-tool-result` | chrome + aria | `{ index, toolName, display }` |
| `agent:deep-complete` | chrome + aria | `{ mode, durationSeconds, outputDir, aborted, completedSteps, totalSteps }` |
| `aria:conversation-updated` | aria | `{ conversationId }` |
| `aria:conversation-switched` | aria | `{ conversationId }` |
| `config:loaded` | chrome | Config object (key masked) |
| `profile:loaded` | chrome | `{ name, profiles }` |
| `profile:switched` | chrome | `{ profile, profiles }` |
| `profile:updated` | chrome | Profiles array |
| `devmode:changed` | chrome + aria | `boolean` |
| `codingmode:changed` | chrome + aria | `boolean` |
| `worktree-isolation:changed` | chrome + aria | `boolean` |
| `team:updated` | chrome + aria | Team status object |
| `fullscreen:changed` | chrome | `boolean` |
| `focus:addressbar` | chrome | — |
| `settings:open` | chrome | — |
| `settings:switch-tab` | chrome | Tab name string |
| `find:open` | chrome | — |
| `find:result` | chrome | `{ activeMatchOrdinal, matches }` |
| `panel:open` | chrome | Panel name string |
| `adblock:count` | chrome | Count number |
| `downloads:updated` | chrome | Downloads summary |
| `vault:save-prompt` | chrome | `{ domain, username }` |
| `zoom:changed` | chrome | Zoom level |
| `api-services:updated` | chrome | — |
| `cron:jobs-updated` | chrome | Jobs array |
| `cron:job-running` | chrome | `{ id, name }` |
| `cron:job-completed` | chrome | `{ id, name, status, result, durationMs }` |
| `capture:recording-update` | chrome | Recording status |

---

## Session / Partition Management (`src/session-manager.ts`)

Tappi uses Electron's named session partitions for isolation:

| Partition Pattern | Purpose |
|-------------------|---------|
| `persist:profile-{name}` | Per-profile browsing data (cookies, localStorage, cache) |
| `persist:profile-{name}:site-{domain}-{username}` | Per-site multi-identity isolation |

`SessionManager` is a singleton. It delegates partition naming to `ProfileManager`, then calls `session.fromPartition()` to get the live `Electron.Session` object.

When a tab is created with a `partition`, `WebContentsView` uses `webPreferences.partition` so its network requests and storage are isolated from other partitions. This allows, for example, a user to be logged into two different Twitter/X accounts simultaneously in different tabs.

Session operations:
- `exportCookies(partition)` — for profile export
- `importCookies(partition, cookies)` — for profile import
- `clearSession(partition)` — called when a profile is deleted

---

## Config & API Key Storage

Config is stored as JSON at `~/.tappi-browser/{profile}/config.json` (or legacy `~/.tappi-browser/config.json`). API keys are encrypted with Electron's `safeStorage` (macOS Keychain, Windows DPAPI) and stored as base64 with an `enc:` prefix. If `safeStorage` is unavailable, they fall back to plain text with a `raw:` prefix. The UI always receives `••••••••` for any stored key; the raw key is only decrypted in main process memory when an agent run starts.

---

## Related Docs

- [Overview](overview.md)
- [Agent System](agent-system.md)
- [Indexer](indexer.md)
- [Source Map](../source-map/files.md)
