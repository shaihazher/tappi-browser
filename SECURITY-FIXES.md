# Tappi Browser — Security Fixes Plan

**Date:** 2026-02-22  
**Based on:** Phase 9 Security Audit (106 findings across 4 parallel audits)  
**Principle:** Harden everything possible without reducing agent capabilities. Document the rest as known risks.

---

## ✅ Free Fixes (Zero Capability Loss)

These fixes harden the app without changing what the agent can do. ~5-6 hours total.

### Electron / Renderer Hardening

| # | Fix | File | What to do | Effort |
|---|-----|------|------------|--------|
| F1 | Remove generic `invoke`/`on` from preload | `preload.ts:252-258` | Replace with named channel methods. Agent keeps all IPC — just through explicit bridges instead of a wildcard. | 1h |
| F2 | `sandbox: true` everywhere | `tab-manager.ts:128, 185` | Set `sandbox: true` on Aria tab and partitioned content tabs. IPC + preload works fine sandboxed. | 15min |
| F3 | Install DOMPurify | `app.js:69-80`, `aria.js:68-79` | `npm i dompurify`, wrap all `marked.parse()` output and `_raw` innerHTML with `DOMPurify.sanitize()`. Agent responses render identically. | 30min |
| F4 | CSP on chrome UI | `main.ts` | Add `<meta>` CSP to `index.html`: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src * data:; connect-src 'none'`. Fix `aria.html` — remove `'unsafe-inline'` from `script-src`. | 30min |
| F5 | `will-navigate` guard on main window | `main.ts` | `mainWindow.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) e.preventDefault(); })` | 5min |
| F6 | `setWindowOpenHandler` on main window | `main.ts` | `mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))` | 5min |
| F7 | Explicit `nodeIntegration: false`, `webSecurity: true` | `tab-manager.ts:183-192` | Add both to all `webPreferences` blocks. Already the defaults — just make explicit. | 5min |
| F8 | Rate-limit `window.open` tab creation | `tab-manager.ts:213-216` | Max 3 new tabs per second per source tab. Normal pages never hit this. | 15min |

### API / Network Hardening

| # | Fix | File | What to do | Effort |
|---|-----|------|------------|--------|
| F9 | `timingSafeEqual` for API token | `api-server.ts:121` | Replace `!==` with `crypto.timingSafeEqual(Buffer.from(token), Buffer.from(valid))`. | 5min |
| F10 | Origin header check on API server | `api-server.ts:109-130` | Reject requests with an `Origin` header (browsers set it; CLI/local tools don't). | 15min |
| F11 | Restrict `PATCH /api/config` — field whitelist | `api-server.ts:279-288` | Only allow `llm.model`, `llm.provider`, `features.*`, `searchEngine`. Block `llm.baseUrl`, `developerMode`, `apiKey`. | 20min |
| F12 | Auth on dev TCP server | `main.ts:1900-1960` | Require same API token as HTTP server. First line of each command = token. | 15min |
| F13 | SSRF protection on HTTP tools | `http-tools.ts:196-250` | Block `127.0.0.1`, `::1`, `169.254.*`, `10.*`, `192.168.*`, `172.16-31.*`, `metadata.google.internal`, non-HTTP protocols. Agent can still hit any public URL. | 30min |

### Agent / Tool Hardening

| # | Fix | File | What to do | Effort |
|---|-----|------|------------|--------|
| F14 | `exec_kill` — only agent-spawned PIDs | `shell-tools.ts:133-142` | Remove the fallback `process.kill()` for untracked PIDs. Return error instead. Agent can still kill its own bg processes. | 5min |
| F15 | Fix teammate devMode inheritance | `team-manager.ts:194` | Pass parent session's `developerMode` flag instead of hardcoded `true`. If user chose dev mode off, teammates respect it. | 15min |
| F16 | Resource limits | `sub-agent.ts`, `team-manager.ts`, `output-buffer.ts` | Max 10 teammates, 50MB total output buffer cap with LRU eviction, max 20 background processes. Nobody legitimately exceeds these. | 30min |
| F17 | Cron: re-check devMode at runtime | `cron-manager.ts:166-227` | Read `currentConfig.developerMode` at execution time, not stale init-time value. | 10min |
| F18 | API key logging — 4 chars not 12 | `agent.ts:236` | `llmConfig.apiKey.slice(0, 4) + '***'`. Still enough for debugging. | 2min |

### Path / File Hardening

| # | Fix | File | What to do | Effort |
|---|-----|------|------------|--------|
| F19 | Download path traversal | `download-manager.ts:53-57` | `const safeName = path.basename(filename)` before `path.join(downloadDir, safeName)`. Downloads still work. | 5min |
| F20 | Screenshot/saveToFile path validation | `capture-tools.ts:44-49` | Validate resolved path starts with workspace or downloads dir. Agent can still save screenshots — just not to `~/.ssh/`. | 15min |
| F21 | `--` before mpv URLs | `media-engine.ts:278-316` | Add `args.push('--')` before URL arguments. Prevents `--script=` injection. Playback identical. | 5min |

### Credential Storage Hardening

| # | Fix | File | What to do | Effort |
|---|-----|------|------------|--------|
| F22 | Credential storage: warn + `chmod 600` | `password-vault.ts`, `http-tools.ts`, `main.ts` | When safeStorage unavailable: set `chmod 600` on all credential files, log a clear warning on startup. Don't refuse to store (breaks Linux users without keyring). | 30min |

---

## ❌ Don't Fix (Would Neuter the Agent)

These findings are real but fixing them would fundamentally reduce what the agent can do. They are the inherent tradeoffs of an AI agent with system access.

| Finding | Why we leave it |
|---------|----------------|
| **Shell command confirmation dialog** (C5) | Kills autonomous execution. The entire value is hands-free operation. OpenClaw doesn't confirm shell commands either. User opted into dev mode explicitly. |
| **File system sandbox** (C6, H15) | Agent needs to read/edit code, configs, dotfiles anywhere on disk. Sandboxing to `~/tappi-workspace/` makes it useless for real development work. Same access model as Claude Code, Codex, OpenClaw. |
| **`eval_js` gated behind dev mode** (C7) | The agent already executes JavaScript via page tools (`click`, `type`, `elements` all use `executeJavaScript`). Gating `eval_js` separately is inconsistent theater. |
| **Cron job tool restrictions** (C15 partial) | Cron jobs need the same tools as the main agent — that's the point. A cron job that can't browse or write files is useless. (We DO fix the stale devMode bug — F17.) |
| **Prompt injection "defense"** (C4) | Content boundary markers (`[PAGE CONTENT START]`) are security theater — LLMs don't reliably respect them and they add token overhead. The real defense is the user understanding what an AI agent with system access means. We document this clearly. |
| **User confirmation for API eval/tools** (C9, C10) | The API exists for programmatic control (scripts, extensions, CLI). Adding confirmation dialogs defeats the entire purpose. The API token IS the authorization. |
| **Restricting cookies/browsing data via API** (M13) | The agent needs cookie and session access to do its job (autofill, session management). The API token gates access. |
| **Conversation data encryption** (H25) | Encrypting SQLite conversations adds complexity for minimal gain — any process with user-level access can also keylog, screenshot, etc. File permissions suffice. |
| **Autofill running in page context** (H12, M12) | The autofill script needs to interact with page DOM to fill forms. Running in an isolated world would break compatibility with many sites' form handling. |

---

## 📄 SECURITY.md (Ship with Repo)

Create `SECURITY.md` in the repo root with these documented known risks:

### 1. Developer Mode = Full System Access
Developer mode gives the AI agent unrestricted shell, filesystem, and browser access. This is by design — it's what makes the agent useful for development. Only enable it if you understand and accept this.

### 2. Prompt Injection
Malicious web pages can embed hidden instructions that attempt to influence the agent. With developer mode on, a successfully injected prompt could lead to unintended shell commands or file operations. No AI agent has a reliable defense against this today. Be mindful of what pages you visit while the agent is active.

### 3. Local API Access
Any process running as your OS user can read `~/.tappi-browser/api-token` and control the browser via the local API (port 18901). This is the same trust boundary as any desktop application. Protect your user session.

### 4. Credential Storage
Uses OS keychain (macOS Keychain, Windows DPAPI, Linux Secret Service) when available. On systems without a keyring daemon, credentials are stored with restrictive file permissions (`600`) but not encrypted at rest. A startup warning is shown when this occurs.

### 5. LLM Provider Data
Conversations — including page content and browsing data when agent browsing data access is enabled — are sent to your configured LLM provider (Anthropic, OpenAI, Google, etc.). Choose your provider accordingly. Self-hosted models via Ollama keep everything local.

### 6. Cron Jobs
Scheduled tasks run with the same capabilities as the main agent. A cron job created during a session persists and runs automatically. Review your cron jobs periodically (`Settings → Cron`).

---

## Summary

| Category | Count | Estimated Effort |
|----------|-------|-----------------|
| Free fixes (do now) | 22 | ~5-6 hours |
| Don't fix (document) | 9 | — |
| SECURITY.md | 1 | 30 min |
| **Total** | — | **~6 hours** |
