# Changelog

Tappi Browser is developed in numbered phases, each adding a discrete capability layer. Phases within a decimal range (e.g. 8.1, 8.35, 8.96) are sub-milestones of a major phase.

---

## Phase 8.96 — Documentation *(current)*

- Comprehensive user guide, README, and changelog written from source.
- Output: `docs/README.md`, `docs/user-guide/`, `docs/changelog.md`.

---

## Phase 8.95.1 — UI Testing

- Automated UI test suite covering settings panel, tab bar, agent panel interactions.
- Test results tracked in `test-results/` and `TEST_RESULTS.md`.

---

## Phase 8.95 — WebContentsView Migration

- Replaced deprecated `BrowserView` API with Electron's `WebContentsView`.
- Tab views are now proper child views of `mainWindow.contentView`.
- Fixed z-order issues where the Aria tab would "peek through" the agent strip area.
- `TabManager` updated: `getView()` as primary accessor; `getBrowserView()` kept as backward-compat alias for media engine.
- Active-tab-only rendering: only the active tab is a child view; inactive tabs are removed to prevent overlap.

---

## Phase 8.9 — Functional Testing

- Functional test suite covering agent loop, deep mode, coding mode, profiles, and API server.
- `PHASE-8.9-REPORT.md` documents test coverage and known issues.
- `TEST_ISSUES.md` tracks open bugs.

---

## Phase 8.85 — Secondary Model Config

- Added a **secondary model** configuration (provider, model, API key) for background tasks.
- Background tasks (user profile generation, deep-mode subtasks) use the secondary model; main chat uses the primary.
- `getModelConfig(purpose, config)` added to `llm-client.ts` as the central routing function.
- API key masking extended to cover the secondary key in IPC messages.

---

## Phase 8.6 — Self-Capture (Screenshot & Video Recording)

- **Screenshot:** Capture any tab's visible content as a PNG.
- **Video recording:** Record a tab's screen to a video file.
- `capture-tools.ts` implements `captureScreenshot` and `handleRecord`.
- Status bar exposes a recording indicator and stop button.
- IPC: `capture:record-status`, `capture:record-stop`, `capture:recording-update`.

---

## Phase 8.5 — Media Engine (mpv Integration)

- **mpv overlay** for YouTube, Twitch, and Vimeo.
- `media-engine.ts`: detects `<video>` elements via content preload IPC, extracts stream URLs with yt-dlp, spawns mpv as a positioned floating window.
- `mpv-ipc.ts`: JSON-IPC client over Unix socket for transport control and property sync.
- `stream-extractor.ts`: yt-dlp wrapper with 6-hour URL cache; supports `best`, `1080p`, `720p`, `480p` quality preferences.
- Geometry tracking: mpv window repositions on scroll, resize, and theater-mode changes.
- Tab lifecycle: overlay hidden on tab switch, killed on navigation.
- Graceful degradation: if mpv is absent, the media engine is disabled silently.
- DRM site detection: Netflix, Prime Video, Disney+, Max, Hulu excluded from mpv activation.

---

## Phase 8.45 — CLI + API for External Control

- `cli.ts`: CLI entry point (`tappi-browser` binary).
- `api-server.ts`: Local HTTP API on `127.0.0.1:18901` (Developer Mode only).
  - Bearer token auth (`~/.tappi-browser/api-token`, `0o600`).
  - Rate limiting: 100 req/min per IP.
  - Full tool repertoire + agent endpoint.
  - SSE streaming for agent responses.
- `agentEvents` EventEmitter in `agent.ts` broadcasts chunks to API listeners.
- `tcmd.js` command runner in project root for quick CLI access.

---

## Phase 8.4 — Browser Profiles + Identity Management

### 8.4.1 — Core Profile System
- `profile-manager.ts`: `ProfileManager` singleton managing `~/.tappi-browser/profiles/`.
- Per-profile: `config.json`, `database.sqlite`, `api-keys.json`, `cron-jobs.json`, `user_profile.json`.
- Electron session partition per profile: `persist:profile-<name>`.
- Automatic migration of existing `~/.tappi-browser/` data to `profiles/default/`.
- `profiles.json` registry with creation date, last-used, email.

### 8.4.2 — Agent Browsing Data Access + User Profile
- `user-profile.ts`: generates a compact JSON summary of browsing history and bookmarks.
- `scheduleProfileUpdate` called on startup when access is enabled.
- Secondary model used for profile generation (Phase 8.85 integration point).
- Profile injected into agent context as `[User Profile: {...}]` (~200 tokens).

### 8.4.3 — Login State Detection
- `login-state.ts`: detects login forms on active pages, injects credential hints into agent context.
- Content preload monitors form submissions for credential capture.

### 8.4.4 — Profile UI + Switching
- Settings → Profiles tab: create, switch, delete.
- Profile badge in tab bar opens a native menu for fast profile switching.
- `profile:list`, `profile:create`, `profile:switch`, `profile:delete`, `profile:get-active` IPC handlers.

### 8.4.5 — Export/Import
- `exportProfile`: AES-256-GCM encrypted `.tappi-profile` bundles (PBKDF2 key derivation, 100K iterations).
- `importProfile`: decrypts, decompresses, extracts files, registers profile.
- Native file dialogs for save/open.

### 8.4.6 — Site Identity (Multi-Account)
- `session-manager.ts`: per-site per-username Electron session partitions.
- `profile:open-site-identity` IPC: opens a new tab with a site-scoped session.
- Multi-identity hints injected into agent context when ≥2 identities exist for a domain.

---

## Phase 8.40 — Coding Mode Overhaul (Unlimited Turns + Timeouts)

- Coding mode agent loop runs without a turn limit.
- Configurable timeouts: `agentTimeoutMs`, `teammateTimeoutMs`, `subtaskTimeoutMs`.
- `agentProgressData` exported for API status endpoint (`elapsed`, `toolCalls`, `timeoutMs`, `running`).
- `_lastStopReason` tracks whether agent stopped due to timeout, completion, or abort.

---

## Phase 8.39 — Git Worktree Isolation

- `worktree-manager.ts`: git worktree creation/cleanup per coding teammate.
- Each teammate gets its own worktree (branch) — no file conflicts in parallel coding.
- `worktree_status`, `worktree_diff`, `worktree_merge`, `worktree_remove` agent tools.
- `worktreeIsolation` config flag (default: on when coding mode + git repo detected).
- IPC: `worktree-isolation:get`, `worktree-isolation:set`.

---

## Phase 8.38 — Coding Mode + Agent Teams

- `team-manager.ts`: manages named agent teams (`team_create`, `team_dissolve`).
- `sub-agent.ts`: spawns isolated sub-agent processes.
- Coding-mode system prompt addendum injected when active.
- `team_create`, `team_task_add`, `team_run_teammate`, `team_status`, `team_message` tools.
- `codingMode` config flag; IPC: `codingmode:get`, `codingmode:set`.
- Aria tab's `</>` button toggles coding mode.
- Team status card in Aria tab shows live teammate progress.

---

## Phase 8.35 — Aria Tab + Conversation History Persistence

- **Aria tab** (`aria.html`, `aria.js`, `aria-preload.ts`): permanent full-width agent chat tab pinned at index 0; non-closeable.
- `conversation-store.ts`: SQLite-backed conversation CRUD with FTS5 full-text search.
- Conversations persist across restarts; startup resumes last conversation or reuses empty one.
- Auto-title generation from first assistant response.
- Sidebar conversation list with search, rename, delete.
- Token usage bar (context vs 200K limit).
- IPC: `aria:send`, `aria:stop`, `aria:new-chat`, `aria:switch-conversation`, `aria:delete-conversation`, `aria:rename-conversation`, `aria:list-conversations`, `aria:get-messages`, `aria:search-conversations`.

---

## Phase 8.25 — Inline Markdown Rendering + Token Progress Bar

- Agent responses rendered with **marked.js** (inline markdown: code blocks, tables, bold, lists).
- Token progress bar in agent panel and Aria tab.
- Streaming render: chunks accumulate and re-render periodically.

---

## Phase 8.1 — Deep Mode (Task Decomposition + Sub-Agent Orchestration)

- `decompose.ts`: quick LLM call classifies task as simple, action-deep, or research-deep.
- `subtask-runner.ts`: sequential subtask execution with per-task timeouts.
- Agent sends `🧠 Analyzing task complexity...` while decomposing.
- Simple tasks bypass decomposition and fall through to the direct loop.
- `agent:deep-complete` IPC event with duration, step counts, and output directory.

---

## Phase 8 — UI Polish (Native Menus + Context Menus)

- `buildAppMenu()` constructs a full native macOS menu bar with all keyboard accelerators.
- Page context menu via `setupPageContextMenu()`.
- Tab context menus: Pin, Mute, Duplicate, Close Others, Close to Right.
- `hiddenInset` title bar style with traffic-light buttons at custom position.

---

## Phase 7 — Developer Mode (Shell, Tool Registry, Sub-Agents)

- `shell-tools.ts`: `exec`, `exec_bg`, `exec_status`, `exec_kill`, `exec_grep` agent tools.
- `tool-registry.ts`: agent tool definitions and the central `createTools()` factory.
- `tool-manager.ts`: CLI tool registration and verification (`register_tool`, `update_tool`).
- `sub-agent.ts`: spawn isolated sub-agent processes for parallel work.
- Developer mode gate: shell tools only available when `developerMode: true` in config.

---

## Phase 6.5 — Multi-Provider LLM

- `llm-client.ts` extended to support **Ollama**, **AWS Bedrock**, **Azure OpenAI**, and **Vertex AI** via `@ai-sdk/*` adapters.
- `buildProviderOptions()`: provider-specific thinking/reasoning options (Anthropic adaptive thinking, OpenAI reasoning effort, Gemini thinking budget).
- `getDefaultModel()` and `getProviderInfo()` helpers.
- Settings UI: dynamic provider fields (base URL, region, project ID, location, endpoint).
- `credential-checker.ts`: `checkCredentials` and `testConnection` for settings verification.

---

## Phase 6 — Ad Blocker + Dark Mode + Downloads + Reader Mode

- `ad-blocker.ts`: EasyList-based ad blocking via `session.webRequest.onBeforeRequest`.
  - Built-in known-ad-domain fast path (~40 domains).
  - EasyList download, parse, and 24-hour cache refresh.
  - Per-site exceptions.
  - `getBlockedCount()` for status bar display.
- **Dark mode**: CSS filter injection via IPC.
- `download-manager.ts`: tracks downloads with progress, stores in SQLite.
- Reader mode: article extraction and distraction-free rendering.

---

## Phase 5.5 — API Services UI

- Settings panel for registering named HTTP services (`register_api` workflow).
- API key storage per service in `api-keys.json`.
- `api-services:list`, `api-services:add`, `api-services:update`, `api-services:delete`, `api-services:reveal-key` IPC handlers.

---

## Phase 5 — LLM Client + Agent Loop + Context Assembly

- `llm-client.ts`: Anthropic + OpenAI support via Vercel AI SDK; thinking/reasoning support.
- `agent.ts`: streaming agent loop with tool calls, token tracking, and error handling.
- `conversation.ts`: in-memory message history with context window management (summarise evicted messages).
- `assembleContext()`: minimal context injection (time, browser state, API services, tools). **No page content injected by default** — the "black box" principle.
- `SYSTEM_PROMPT` and the grep philosophy for page interaction.
- Agent IPC: `agent:send`, `agent:stop`, `agent:clear`, `agent:stream-chunk`, `agent:stream-start`.

---

## Phase 4 — Element Indexer + Page Tools + Browser Tools + HTTP/File Tools

- `page-tools.ts`: `elements()`, `text()`, `scroll()`, `keys()` agent tools.
- `browser-tools.ts`: `getBrowserState()`, `navigate()`, `search()`, `back_forward()` tools.
- `http-tools.ts`: `http_request()`, `document_endpoint()`, `get_endpoint_docs()`, API service management.
- `file-tools.ts`: `file_read()`, `file_write()`, `file_head()`, `file_tail()`, directory listing.
- `content-preload.js`: page-side element indexer; assigns numeric indexes to interactive elements; reports `<video>` elements and form submissions.

---

## Phase 3 — Agent Panel + Settings + Status Bar

- Agent sidebar panel (380 px) with strip (40 px) at right edge.
- `⌘J` toggle via `toggleAgentPanel()` and `layoutViews()`.
- Settings panel (modal overlay) with LLM config, search engine, feature toggles.
- Status bar (34 px) at window bottom: URL, ad block count, media indicator.
- `safeStorage` encryption for API keys introduced.

---

## Phase 2 — Navigation + Address Bar + Bookmarks + Tab Management

- Address bar with URL/search smart routing.
- Back, forward, reload buttons.
- Bookmark toggle (`⌘D`); `bookmarks.json` storage (later migrated to SQLite).
- Tab pinning, muting, duplicate, close-others, close-to-right, reorder.
- Closed-tab stack (up to 20 entries); `⌘⇧T` to reopen.
- `TabManager` fully implemented with `notifyChrome()` IPC.

---

## Phase 1 — Electron Scaffold + Tabs

- Electron `BrowserWindow` with `hiddenInset` title bar.
- `TabManager` with `createTab()`, `closeTab()`, `switchTab()`.
- Chrome UI (`index.html`, `app.js`, `styles.css`) rendered in main window's WebContents.
- `WebContentsView` (updated in Phase 8.95) for tab content.
- Basic `preload.ts` IPC bridge with `contextIsolation: true`.
- TypeScript + `tsconfig.json` build pipeline.
- `package.json` with `npm run build` and `npm run dev` scripts.

---

*Phases are numbered by development order, not semantic versioning. Decimal sub-phases within a major phase are ordered but not exhaustive.*
