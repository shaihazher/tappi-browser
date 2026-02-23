# Tappi Browser — Source File Map

> **Last updated:** 2026-02-22  
> **Total files:** 49 source files across 9 categories  
> Paths are relative to the project root (`tappi-browser/`).

---

## Table of Contents

1. [Core](#1-core)
2. [Agent](#2-agent)
3. [Tools](#3-tools)
4. [Features](#4-features)
5. [Teams](#5-teams)
6. [Data](#6-data)
7. [UI](#7-ui)
8. [Preloads](#8-preloads)
9. [Infrastructure](#9-infrastructure)

---

## 1. Core

The application backbone: Electron entry point, tab management, and the SQLite data layer.

### `src/main.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 2,030 |
| **Description** | Electron main-process entry point; wires every subsystem together via IPC handlers. |
| **Key exports / symbols** | `TappiConfig` interface, `mainWindow`, `tabManager`, `activeConversationId`; all IPC handlers (`tab:*`, `agent:*`, `bookmark:*`, `nav:*`, `config:*`, `media:*`, `aria:*`, `profile:*`, `cron:*`). |
| **Internal dependencies** | `tab-manager`, `command-executor`, `browser-tools`, `agent`, `http-tools`, `database`, `profile-manager`, `session-manager`, `ad-blocker`, `download-manager`, `password-vault`, `login-state`, `credential-checker`, `llm-client`, `tool-manager`, `shell-tools`, `sub-agent`, `team-manager`, `user-profile`, `output-buffer`, `cron-manager`, `conversation-store`, `capture-tools`, `api-server`, `media-engine` |

---

### `src/tab-manager.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 632 |
| **Description** | Manages all browser tabs as Electron `WebContentsView` instances, handling creation, switching, layout, bookmarks, and pinned/muted state. |
| **Key exports / symbols** | `class TabManager`, `interface Tab`, `interface ClosedTab`; methods: `createTab()`, `closeTab()`, `switchTab()`, `navigate()`, `layoutTabs()`, `getActiveWebContents()`, `activeWebTabWebContents` (getter), `ariaTabId`. |
| **Internal dependencies** | `database` (addHistory) |

---

### `src/database.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 539 |
| **Description** | SQLite storage layer (via `better-sqlite3`) for browsing history, bookmarks, credentials, permissions, settings, downloads, conversations, and cron jobs. |
| **Key exports / symbols** | `initDatabase()`, `getDb()`, `closeDatabase()`, `reinitDatabase()`, `addHistory()`, `searchHistory()`, `getRecentHistory()`, `clearHistory()`, `migrateBookmarksFromJson()`, `getPermission()`, `setPermission()`, `getAllBookmarks()`, `searchBookmarks()`, `removeBookmark()`, `saveCredential()`, `getCredentials()`, `deleteCredential()`, `listCredentialDomains()`, `updateCredentialLastUsed()`, `recordDownload()`, `queryHistory()`, `queryBookmarks()`, `queryDownloads()` |
| **Internal dependencies** | *(none — leaf module)* |

---

## 2. Agent

The LLM agent loop, conversation management, task decomposition, and context assembly.

### `src/agent.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 788 |
| **Description** | Primary agent loop (Deep Mode); streams LLM responses via Vercel AI SDK, dispatches tools, manages conversation context, and emits progress events to the UI. |
| **Key exports / symbols** | `runAgent()`, `stopAgent()`, `clearHistory()`, `agentEvents` (EventEmitter), `agentProgressData`, `AgentProgressData` interface |
| **Internal dependencies** | `llm-client`, `tool-registry`, `browser-tools`, `http-tools`, `tool-manager`, `user-profile`, `conversation`, `conversation-store`, `decompose`, `subtask-runner`, `login-state`, `profile-manager`, `session-manager`, `password-vault` |

---

### `src/conversation.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 309 |
| **Description** | In-memory rolling-window conversation history with token-aware eviction and summary pinning; keeps the active LLM context under 100 K tokens. |
| **Key exports / symbols** | `ChatMessage` type, `getFullHistory()`, `getWindow()`, `addMessage()`, `addMessages()`, `clearHistory()`, `getUnsummarizedEvictedMessages()`, `setEvictionSummary()`, `buildSummaryPrompt()`, `searchHistory()` |
| **Internal dependencies** | *(none — leaf module)* |

---

### `src/conversation-store.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 346 |
| **Description** | Persistent conversation history backed by SQLite; CRUD, pagination, full-text search, and auto-title generation for the Aria conversation sidebar. |
| **Key exports / symbols** | `Conversation`, `ConversationMessage` interfaces; `createConversation()`, `getConversation()`, `listConversations()`, `updateConversationTitle()`, `deleteConversation()`, `archiveConversation()`, `addConversationMessage()`, `getConversationMessages()`, `searchConversations()`, `generateAutoTitle()`, `getConversationMessageCount()`, `agentListConversations()`, `agentSearchConversations()`, `agentReadConversation()` |
| **Internal dependencies** | `database` |

---

### `src/llm-client.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 313 |
| **Description** | Multi-provider LLM client factory; wraps Vercel AI SDK adapters for Anthropic, OpenAI, Gemini, OpenRouter, Ollama, AWS Bedrock, Vertex AI, and Azure OpenAI. |
| **Key exports / symbols** | `LLMConfig` interface, `createModel()`, `buildProviderOptions()`, `getModelConfig()`, `getDefaultModel()` |
| **Internal dependencies** | *(none — leaf module; uses `@ai-sdk/*` externals)* |

---

### `src/decompose.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 328 |
| **Description** | Task decomposition planner for Deep Mode; calls the LLM to classify a task as simple/action/research and returns an ordered list of `Subtask` objects. |
| **Key exports / symbols** | `Subtask`, `DecompositionResult` interfaces; `decomposeTask()`, `SUBTASK_SYSTEM_PROMPT`, `RESEARCH_SUBTASK_SYSTEM_PROMPT`, `COMPILE_SYSTEM_PROMPT`, `makeRunDirname()` |
| **Internal dependencies** | `llm-client` |

---

### `src/subtask-runner.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 418 |
| **Description** | Sequentially executes Deep Mode subtasks; each subtask runs a mini agent loop (or a compile LLM call), saves output to disk, and emits progress events to the main window. |
| **Key exports / symbols** | `SubtaskRunnerOptions`, `DeepRunResult` interfaces; `runDeepMode()` |
| **Internal dependencies** | `llm-client`, `tool-registry`, `browser-tools`, `conversation`, `output-buffer`, `shell-tools`, `decompose` |

---

### `src/sub-agent.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 209 |
| **Description** | Spawns and manages parallel sub-agents (max 3 concurrent); each sub-agent gets an isolated conversation session and reports a summary back to the parent on completion. |
| **Key exports / symbols** | `SubAgentTask` interface; `spawnSubAgent()`, `getSubAgentStatus()`, `listSubAgents()`, `cleanupAllSubAgents()` |
| **Internal dependencies** | `llm-client`, `tool-registry`, `browser-tools`, `http-tools`, `conversation`, `output-buffer`, `shell-tools` |

---

### `src/output-buffer.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 245 |
| **Description** | Shell output discipline layer; captures full stdout/stderr per session, exposes only head+tail to the LLM, and makes the full buffer grep-searchable. |
| **Key exports / symbols** | `OutputEntry` interface; `captureOutput()`, `appendOutput()`, `finishEntry()`, `grepOutput()`, `listOutputs()`, `getOutputView()`, `purgeSession()` |
| **Internal dependencies** | *(none — leaf module)* |

---

## 3. Tools

Agent-callable tools — wrapped by `tool-registry.ts` into Vercel AI SDK tool definitions.

### `src/tool-registry.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 1,433 |
| **Description** | Central Vercel AI SDK tool factory; dynamically composes all agent tools (page, browser, HTTP, file, shell, sub-agent, cron, team, capture, worktree) based on current config flags. |
| **Key exports / symbols** | `ToolRegistryOptions` interface; `createTools()`, `TOOL_USAGE_GUIDE` constant |
| **Internal dependencies** | `page-tools`, `browser-tools`, `http-tools`, `file-tools`, `shell-tools`, `tool-manager`, `sub-agent`, `cron-manager`, `conversation`, `conversation-store`, `database`, `team-manager`, `mailbox`, `shared-task-list`, `capture-tools`, `worktree-manager` |

---

### `src/tool-manager.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 186 |
| **Description** | Tracks installed CLI and API tools in `~/.tappi-browser/tools.json`; verifies paths with `which` on startup and injects a compact summary into the agent context. |
| **Key exports / symbols** | `CliTool`, `ToolsRegistry` interfaces; `loadTools()`, `verifyAllTools()`, `registerTool()`, `unregisterTool()`, `getToolsContext()` |
| **Internal dependencies** | *(none — leaf module)* |

---

### `src/page-tools.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 344 |
| **Description** | Page-level DOM operations via `content-preload.js`; provides elements indexing, click, type, paste, focus, check, text extraction, scrolling, keyboard input, and JS evaluation. |
| **Key exports / symbols** | `pageElements()`, `pageClick()`, `pageType()`, `pagePaste()`, `pageFocus()`, `pageCheck()`, `pageText()`, `pageScroll()`, `pageKeys()`, `pageEvalJs()`, `pageNavigate()` |
| **Internal dependencies** | *(none — uses Electron `WebContents` directly)* |

---

### `src/browser-tools.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 580 |
| **Description** | Browser-level B-commands (tabs, cookies, zoom, dark mode, devtools, history, bookmarks); also generates the compact B-command menu injected into agent context. |
| **Key exports / symbols** | `BrowserContext` interface; `getBrowserState()`, `executeBCommand()`, `getBCommandMenu()`; individual handlers for B0–B9 commands |
| **Internal dependencies** | `tab-manager` |

---

### `src/http-tools.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 473 |
| **Description** | General-purpose HTTP client for the agent (GET/POST/PUT/PATCH/DELETE); manages an encrypted API-key registry and a structured API-service catalogue with per-endpoint docs. |
| **Key exports / symbols** | `ServiceEntry`, `EndpointDoc` interfaces; `httpRequest()`, `loadServices()`, `registerService()`, `removeService()`, `storeApiKey()`, `getApiKey()`, `listApiKeys()`, `deleteApiKey()`, `getServiceContext()` |
| **Internal dependencies** | *(none — uses Electron `net` and `safeStorage`)* |

---

### `src/file-tools.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 357 |
| **Description** | Workspace file management for the agent (`~/tappi-workspace/`); supports read (with grep + chunked reading), write, append, list, delete, and move operations. |
| **Key exports / symbols** | `FileReadOptions` interface; `fileWrite()`, `fileRead()`, `fileAppend()`, `fileList()`, `fileDelete()`, `fileMove()` |
| **Internal dependencies** | *(none — leaf module)* |

---

### `src/shell-tools.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 271 |
| **Description** | Developer-mode shell access (exec / exec_bg / exec_status / exec_kill) with install-detection nudges and output discipline via `output-buffer.ts`. |
| **Key exports / symbols** | `exec()`, `execBackground()`, `execStatus()`, `execKill()`, `grepShellOutput()`, `listShellOutputs()`, `cleanupSession()`, `cleanupAll()` |
| **Internal dependencies** | `output-buffer` |

---

### `src/capture-tools.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 443 |
| **Description** | Self-capture tools (Phase 8.6): screenshot (window/tab/full-page) and video recording via Electron `capturePage` polling + ffmpeg; saves to `~/tappi-workspace/`. |
| **Key exports / symbols** | `ScreenshotParams`, `ScreenshotResult` interfaces; `takeScreenshot()`, `startRecording()`, `stopRecording()`, `getRecordingStatus()`, `handleRecord()`, `captureCleanupOnQuit()` |
| **Internal dependencies** | *(none — uses Electron `nativeImage` and Node `child_process`)* |

---

## 4. Features

Self-contained feature subsystems that extend the browser.

### `src/ad-blocker.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 293 |
| **Description** | EasyList-based ad blocker using `session.webRequest`; downloads and caches EasyList, parses filter rules, maintains a fast-path known-ad-domain set, and supports per-site exceptions. |
| **Key exports / symbols** | `startAdBlocker()`, `stopAdBlocker()`, `isAdBlockerEnabled()`, `toggleAdBlocker()`, `getBlockedCount()`, `resetBlockedCount()`, `addSiteException()`, `removeSiteException()` |
| **Internal dependencies** | *(none — uses Electron `session` and `tldts`)* |

---

### `src/download-manager.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 198 |
| **Description** | Hooks into Electron's `will-download` session event; tracks download progress, speed, and state; reports to UI via IPC and records completed downloads in SQLite. |
| **Key exports / symbols** | `DownloadItem` interface; `initDownloadManager()`, `getDownloadsSummary()`, `getAllDownloads()`, `cancelDownload()`, `clearCompleted()`, `getActiveDownloads()` |
| **Internal dependencies** | `database` (recordDownload) |

---

### `src/media-engine.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 769 |
| **Description** | Phase 8.5 media engine: detects `<video>` elements, extracts stream URLs via yt-dlp, spawns mpv as a borderless floating window positioned over the video element, and syncs geometry on resize/scroll/theater mode. |
| **Key exports / symbols** | `VideoRect`, `VideoInfo`, `MpvSession` interfaces; `initMediaEngine()`, `initTabMedia()`, `destroyTabMedia()`, `onTabHidden()`, `onTabShown()`, `onTabNavigated()`, `handleVideoDetected()`, `handleVideoGeometryChanged()`, `handleVideoPlayPause()`, `handleVideoSeeked()`, `isMediaEngineAvailable()` |
| **Internal dependencies** | `mpv-ipc`, `stream-extractor` |

---

### `src/mpv-ipc.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 196 |
| **Description** | mpv JSON IPC client over a Unix socket; sends typed commands, resolves request IDs, and emits property-change / event notifications via `EventEmitter`. |
| **Key exports / symbols** | `MpvProperty` interface; `class MpvIPC extends EventEmitter` with `connect()`, `disconnect()`, `sendCommand()`, `setProperty()`, `getProperty()`, `observeProperty()` |
| **Internal dependencies** | *(none — leaf module)* |

---

### `src/stream-extractor.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 209 |
| **Description** | yt-dlp wrapper that extracts stream URLs (separate video + audio for DASH) for YouTube, Twitch, and Vimeo; TTL-based in-memory cache (6 h) and DRM-site detection. |
| **Key exports / symbols** | `QualityPreference` type, `StreamInfo` interface; `extractStreamUrl()`, `isSupportedSite()`, `isDrmSite()`, `SUPPORTED_SITES`, `DRM_SITES` |
| **Internal dependencies** | *(none — leaf module)* |

---

### `src/password-vault.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 213 |
| **Description** | Encrypted credential storage using Electron `safeStorage` + SQLite; autofills login forms by injecting credentials into the active tab without exposing raw passwords to the agent. |
| **Key exports / symbols** | `storePassword()`, `getPasswordsForDomain()`, `getPasswordForAutofill()`, `removePassword()`, `listSavedDomains()`, `generatePassword()`, `buildAutofillScript()`, `listIdentities()` |
| **Internal dependencies** | `database` (saveCredential, getCredentials, deleteCredential, listCredentialDomains, updateCredentialLastUsed) |

---

### `src/cron-manager.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 494 |
| **Description** | In-browser scheduled task manager (Phase 7.99); runs isolated agent turns on interval/cron/daily schedules, persists jobs to JSON, and tracks run history with pass/fail status. |
| **Key exports / symbols** | `CronJobSchedule`, `CronJobRun`, `CronJob` interfaces; `initCronManager()`, `updateCronContext()`, `addJob()`, `listJobs()`, `updateJob()`, `deleteJob()`, `runJobNow()`, `getJobsList()`, `getActiveJobCount()`, `cleanupCron()` |
| **Internal dependencies** | `llm-client`, `tool-registry`, `browser-tools`, `conversation`, `output-buffer`, `shell-tools`, `profile-manager` |

---

## 5. Teams

Multi-agent orchestration: lead + teammates with shared task lists, mailboxes, and git worktrees.

### `src/team-manager.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 630 |
| **Description** | Central orchestration engine (Phase 8.38); lead decomposes tasks, spawns teammate agent sessions, monitors progress, handles mailbox communication, and synthesizes final results. |
| **Key exports / symbols** | `TeamSession`, `Teammate` interfaces; `createTeam()`, `disbandTeam()`, `runTeammate()`, `getTeamStatus()`, `getTeamStatusUI()`, `setTeamUpdateCallback()`, `cleanupAllTeams()` |
| **Internal dependencies** | `llm-client`, `tool-registry`, `browser-tools`, `conversation`, `output-buffer`, `shell-tools`, `mailbox`, `shared-task-list`, `worktree-manager` |

---

### `src/mailbox.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 131 |
| **Description** | Inter-agent messaging system; each teammate has an inbox keyed by team ID + agent name; unread messages are injected into context on each turn; supports broadcast to `@all`. |
| **Key exports / symbols** | `MailboxMessage`, `Mailbox` interfaces; `initMailbox()`, `sendMessage()`, `getUnreadMessages()`, `markRead()`, `formatInboxForContext()`, `cleanupTeamMailbox()` |
| **Internal dependencies** | *(none — leaf module)* |

---

### `src/shared-task-list.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 299 |
| **Description** | Shared task registry for agent teams; tasks have statuses, dependency chains, and file-conflict detection; persisted to `~/tappi-workspace/teams/<team-id>/tasks.json`. |
| **Key exports / symbols** | `TaskStatus` type, `SharedTask`, `FileConflict` interfaces; `initTaskList()`, `createTask()`, `getTaskList()`, `getTask()`, `updateTask()`, `claimTask()`, `formatTaskListForContext()`, `getTeamSummary()`, `detectFileConflicts()`, `cleanupTeamTaskList()` |
| **Internal dependencies** | *(none — leaf module)* |

---

### `src/worktree-manager.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 625 |
| **Description** | Git worktree lifecycle manager (Phase 8.39); creates isolated branches per coding teammate, handles merge/rebase back to the base branch, detects conflicts, and cleans up on team disband. |
| **Key exports / symbols** | `WorktreeInfo`, `MergeResult`, `RemoveResult` interfaces; `class WorktreeManager` with `createWorktree()`, `mergeWorktree()`, `removeWorktree()`, `listWorktrees()`, `getWorktree()`; `createWorktreeManager()` factory |
| **Internal dependencies** | *(none — uses Node `child_process` `execSync`)* |

---

## 6. Data

Profile management, session isolation, user modelling, and credential detection.

### `src/profile-manager.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 408 |
| **Description** | Browser profile manager; each profile gets an isolated directory (config, SQLite DB, api-keys, cron-jobs, user-profile), an Electron session partition, and a registry entry under `~/.tappi-browser/profiles/`. |
| **Key exports / symbols** | `ProfileInfo`, `ProfileRegistry` interfaces; `class ProfileManager` (singleton) with `initialize()`, `createProfile()`, `switchProfile()`, `deleteProfile()`, `listProfiles()`, `getConfigPath()`, `getDbPath()`, `getApiKeysPath()`, `getSessionPartition()`, `getSiteSessionPartition()`, `getCronJobsPath()`, `getUserProfilePath()`; `profileManager` singleton export |
| **Internal dependencies** | *(none — leaf module)* |

---

### `src/session-manager.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 145 |
| **Description** | Electron session partition manager; resolves per-profile and per-site-identity session partitions, enabling multi-account browsing without cookie leakage. |
| **Key exports / symbols** | `SiteIdentity` interface; `class SessionManager` (singleton) with `getProfileSession()`, `getProfilePartition()`, `getSiteIdentitySession()`, `getSiteIdentityPartition()`, `registerSiteIdentity()`, `listSiteIdentities()`; `sessionManager` singleton export |
| **Internal dependencies** | `profile-manager` |

---

### `src/user-profile.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 280 |
| **Description** | LLM-generated compact user profile (≤200 tokens) derived from browsing history + bookmarks; injected into agent context when `agentBrowsingDataAccess` is enabled. |
| **Key exports / symbols** | `UserProfile` interface; `loadProfile()`, `scheduleProfileUpdate()`, `deleteProfile()` |
| **Internal dependencies** | `llm-client`, `profile-manager`, `database` (via `better-sqlite3` direct import) |

---

### `src/credential-checker.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 404 |
| **Description** | Auto-detects cloud LLM provider credentials from env vars, config files, and local services (AWS `~/.aws/credentials`, GCP ADC, Azure env, Ollama `/api/tags`). |
| **Key exports / symbols** | `CredentialStatus`, `OllamaModel`, `OllamaStatus` interfaces; `checkBedrock()`, `checkVertex()`, `checkAzure()`, `checkOllama()`, `checkCredentials()`, `testConnection()` |
| **Internal dependencies** | *(none — leaf module)* |

---

### `src/login-state.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 37 |
| **Description** | Lightweight shared store for login-form hints detected by `content-preload.js`; keyed by `webContents` ID with a 5-minute TTL to avoid circular imports between `main.ts` and `agent.ts`. |
| **Key exports / symbols** | `setLoginHint()`, `getLoginHint()`, `clearLoginHint()` |
| **Internal dependencies** | *(none — leaf module)* |

---

## 7. UI

All renderer-side code: browser chrome, Aria chat tab, new-tab page, and stylesheets.

### `src/ui/app.js`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 3,073 |
| **Description** | Main browser chrome UI controller; manages tabs, address bar (with autocomplete), agent panel, settings overlay, bookmarks, history, download panel, profile switcher, and deep-mode progress visualization. |
| **Key exports / symbols** | *(renderer script — no ES exports)*; key globals: `currentTabs`, `activeTabId`, `isAgentOpen`, `chatMessages`; major sections: tab rendering, URL navigation, agent message streaming, settings persistence, deep-mode plan display, team status cards. |
| **Internal dependencies** | Uses `window.tappi` (from `preload.ts`); uses `marked` (from `vendor/marked.min.js`). |

---

### `src/ui/aria.js`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 1,033 |
| **Description** | Full Aria chat tab UI controller; handles conversation sidebar (CRUD, search, pagination), markdown streaming, token progress bar, coding-mode toggle, and team status card. |
| **Key exports / symbols** | *(renderer script — no ES exports)*; key globals: `currentConversationId`, `isStreaming`, `messages`, `conversations`, `streamBuffer`. |
| **Internal dependencies** | Uses `window.aria` (from `aria-preload.ts`); uses `marked` (from `vendor/marked.min.js`). |

---

### `src/ui/index.html`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 600 |
| **Description** | Main browser window HTML shell; declares the tab bar, address bar, profile switcher popup, agent strip/panel, settings overlay (LLM config, tools, privacy, profile, cron, API), and the status bar. |
| **Key exports / symbols** | *(HTML shell — no exports)*; links `styles.css`, `vendor/marked.min.js`, `app.js`. |
| **Internal dependencies** | `src/ui/styles.css`, `src/ui/vendor/marked.min.js`, `src/ui/app.js` |

---

### `src/ui/aria.html`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 77 |
| **Description** | HTML shell for the full Aria chat tab; two-column layout — conversation sidebar on the left, chat area with token progress bar and input on the right. |
| **Key exports / symbols** | *(HTML shell — no exports)*; links `aria.css`, `vendor/marked.min.js`, `aria.js`. |
| **Internal dependencies** | `src/ui/aria.css`, `src/ui/vendor/marked.min.js`, `src/ui/aria.js` |

---

### `src/ui/newtab.html`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 154 |
| **Description** | New-tab page; dark-themed greeting with a centered search box that navigates via the configured search engine; all CSS is self-contained inline. |
| **Key exports / symbols** | *(HTML page — no exports)*; inline `<script>` handles search box submission. |
| **Internal dependencies** | *(none)* |

---

### `src/ui/styles.css`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 2,495 |
| **Description** | Full browser chrome stylesheet; defines CSS custom properties (dark theme palette), tab bar, address bar, agent strip/panel, settings overlay, history/bookmark/download panels, deep-mode plan cards, team status, and all responsive states. |
| **Key exports / symbols** | *(stylesheet — no exports)*; root variables: `--bg-primary`, `--accent`, `--lotus`, `--agent-panel-width`, `--status-bar-height`, etc. |
| **Internal dependencies** | *(none)* |

---

### `src/ui/aria.css`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 1,045 |
| **Description** | Stylesheet for the Aria chat tab; mirrors the design language of `styles.css` (same CSS variables), adds conversation sidebar, message bubbles, token progress bar, team card, and coding-mode button. |
| **Key exports / symbols** | *(stylesheet — no exports)*; root variables: `--bg-primary`, `--accent`, `--lotus`, `--lotus-soft`, etc. |
| **Internal dependencies** | *(none)* |

---

### `src/ui/vendor/marked.min.js`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 74 |
| **Description** | Vendored minified build of **marked v17.0.3**; Markdown → HTML parser used by both `app.js` and `aria.js` for rendering agent responses. |
| **Key exports / symbols** | `marked` global object with `marked()`, `marked.setOptions()`, `marked.Renderer`, `marked.lexer()`, `marked.parser()`. |
| **Internal dependencies** | *(none — standalone vendor library)* |

---

## 8. Preloads

Scripts injected into Electron renderer contexts to bridge the renderer ↔ main-process boundary.

### `src/preload.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 297 |
| **Description** | Chrome preload for the browser UI window; exposes `window.tappi` via `contextBridge`, bridging all tab, navigation, agent, bookmark, settings, media, download, profile, deep-mode, and team IPC events to the renderer. |
| **Key exports / symbols** | *(no exports — `contextBridge.exposeInMainWorld('tappi', {...})` exposes ~80 IPC wrappers including `createTab`, `navigate`, `sendAgentMessage`, `onAgentStreamChunk`, `onDeepPlan`, `getTeamStatus`, etc.)* |
| **Internal dependencies** | *(uses Electron `contextBridge` + `ipcRenderer`)* |

---

### `src/aria-preload.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 103 |
| **Description** | Preload for the Aria full-chat tab; exposes `window.aria` with IPC wrappers for agent messaging, conversation CRUD, search, team events, settings, and deep-mode events. |
| **Key exports / symbols** | *(no exports — exposes `window.aria` with `sendMessage`, `stopAgent`, `newChat`, `switchConversation`, `listConversations`, `onStreamChunk`, `onToolResult`, `onTeamUpdate`, etc.)* |
| **Internal dependencies** | *(uses Electron `contextBridge` + `ipcRenderer`)* |

---

### `src/content-preload.js`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 737 |
| **Description** | Injected into every web tab; implements the shadow-DOM-piercing element indexer, semantic label generation, compact element output (≤50 elements), click/type/paste/focus/check/scroll/keys dispatch, and login-form detection that fires `tappi:login-detected` IPC. |
| **Key exports / symbols** | *(exposes `window.__tappi` object with `indexElements()`, `clickElement()`, `typeElement()`, `pasteElement()`, `focusElement()`, `checkElement()`, `extractText()`, `scrollPage()`, `sendKeys()`, `evalJs()`; also posts `tappi:login-detected` and `tappi:video-detected` IPC messages)* |
| **Internal dependencies** | *(uses Electron `contextBridge` + `ipcRenderer`)* |

---

## 9. Infrastructure

CLI client, local HTTP API server, and the unified command dispatcher.

### `src/cli.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 546 |
| **Description** | Node CLI (`tappi-browser <command>`) that reads the API token from `~/.tappi-browser/api-token` and makes authenticated HTTP calls to the local API server on port 18901; supports agent, tool calls, tabs, config, and streaming. |
| **Key exports / symbols** | *(binary entry point — no exports)*; commands: `agent`, `run`, `open`, `tabs`, `elements`, `click`, `type`, `navigate`, `screenshot`, `status`, `config`, `token`. |
| **Internal dependencies** | *(standalone — reads `api-token` file; no project imports)* |

---

### `src/api-server.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 716 |
| **Description** | Local HTTP API server bound to `127.0.0.1:18901`; authenticates requests via Bearer token, rate-limits at 100 req/min, and exposes the full tool repertoire plus streaming agent access to external CLI clients. |
| **Key exports / symbols** | `ApiServerDeps` interface; `API_PORT` constant; `ensureApiToken()`, `startApiServer()`, `stopApiServer()` |
| **Internal dependencies** | `agent` (agentEvents, runAgent, agentProgressData), `tool-registry`, `page-tools`, `browser-tools`, `capture-tools` |

---

### `src/command-executor.ts`

| Attribute | Detail |
|-----------|--------|
| **Lines** | 477 |
| **Description** | Unified command dispatcher; parses text commands (page commands like `elements`, `click 4`, `type 1 text`; and B-commands like `B0 on`) and routes them to the appropriate tool module — used by both the LLM agent output and dev-mode manual testing. |
| **Key exports / symbols** | `ExecutorContext` interface; `executeCommand()`, `getMenu()` |
| **Internal dependencies** | `tab-manager`, `browser-tools`, `page-tools`, `http-tools`, `file-tools` |

---

## Dependency Graph (Summary)

```
main.ts
├── tab-manager.ts ──────────────────────────── database.ts
├── agent.ts
│   ├── llm-client.ts
│   ├── tool-registry.ts
│   │   ├── page-tools.ts
│   │   ├── browser-tools.ts ───────────────── tab-manager.ts
│   │   ├── http-tools.ts
│   │   ├── file-tools.ts
│   │   ├── shell-tools.ts ─────────────────── output-buffer.ts
│   │   ├── capture-tools.ts
│   │   ├── sub-agent.ts ──────────────────── (above tools)
│   │   ├── cron-manager.ts ───────────────── (above tools)
│   │   ├── team-manager.ts
│   │   │   ├── mailbox.ts
│   │   │   ├── shared-task-list.ts
│   │   │   └── worktree-manager.ts
│   │   ├── conversation-store.ts ─────────── database.ts
│   │   └── worktree-manager.ts
│   ├── conversation.ts
│   ├── conversation-store.ts
│   ├── decompose.ts ──────────────────────── llm-client.ts
│   ├── subtask-runner.ts
│   ├── login-state.ts
│   ├── profile-manager.ts
│   ├── session-manager.ts ────────────────── profile-manager.ts
│   └── password-vault.ts ─────────────────── database.ts
├── ad-blocker.ts
├── download-manager.ts ─────────────────────── database.ts
├── media-engine.ts
│   ├── mpv-ipc.ts
│   └── stream-extractor.ts
├── credential-checker.ts
├── user-profile.ts ─────────────────────────── llm-client.ts
├── tool-manager.ts
├── api-server.ts ───────────────────────────── agent.ts, tool-registry.ts
└── command-executor.ts ─────────────────────── (page/browser/http/file tools)

Preloads (renderer context — no imports from main process):
  preload.ts          → window.tappi  (UI ↔ main IPC bridge)
  aria-preload.ts     → window.aria   (Aria tab ↔ main IPC bridge)
  content-preload.js  → window.__tappi (web tab DOM operations)

UI (renderer scripts):
  ui/app.js    → uses window.tappi + marked
  ui/aria.js   → uses window.aria  + marked
```

---

## File Count by Category

| Category | Files | Total Lines |
|----------|------:|------------:|
| Core | 3 | 3,201 |
| Agent | 8 | 2,848 |
| Tools | 7 | 3,707 |
| Features | 6 | 2,222 |
| Teams | 4 | 1,685 |
| Data | 5 | 1,274 |
| UI | 8 | 9,551 |
| Preloads | 3 | 1,137 |
| Infrastructure | 3 | 1,739 |
| **Total** | **49** | **27,364** |
