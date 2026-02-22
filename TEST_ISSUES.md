# TEST_ISSUES.md — Phase 8.9 Functional Testing

## Bugs Found

### BUG-001: /api/browser/screenshot returns empty file
- **Severity:** Medium
- **Endpoint:** `POST /api/browser/screenshot`
- **Behavior:** Creates 0-byte file, returns `width:0, height:0, size:0`
- **Workaround:** Use `POST /api/tools/browser_screenshot` instead (works correctly)
- **Root cause:** Likely the `captureTools.captureScreenshot()` call in the specific endpoint is getting `mainWindow` + `wc` but `wc` might be the Aria webContents, not the active tab's webContents. The tool passthrough creates a proper `browserCtx` and routes through the tool registry which handles tab selection correctly.
- **Fix needed:** In `api-server.ts`, the `/api/browser/screenshot` handler uses `tabManager.activeWebContents` — check if this returns null when the Aria tab is selected but the API caller expects the non-Aria active tab.

---

### BUG-002: Agent API returns empty response when deep mode classifies task as "simple" ✅ FIXED
- **Severity:** Critical
- **Endpoint:** `POST /api/agent/ask` and `/api/agent/ask/stream`
- **Behavior:** Deep mode sends `sendChunk("🧠 Analyzing...", done=false)` then `sendChunk("", done=true)` to "clear" the analyzing message. The `done=true` terminates the SSE connection before the direct agent loop produces its actual response.
- **Root cause:** The "clear analyzing message" sends `done=true` which the API server interprets as stream end, closing the HTTP response. The actual agent response chunks go to a dead listener.
- **Fix applied:** Changed the fallthrough `sendChunk` calls to use `done=false` (sending `"\n"` instead of `""` with `done=true`). The direct agent loop sends its own `done=true` when it completes.
- **File:** `src/agent.ts` lines ~367-372
- **Verified:** Agent now correctly returns full responses via both SSE streaming and non-streaming API endpoints.

### BUG-003: "🧠 Analyzing task complexity..." prefix leaks into API responses
- **Severity:** Low (cosmetic)
- **Endpoint:** `POST /api/agent/ask` (non-streaming)
- **Behavior:** The non-streaming endpoint accumulates ALL chunks including the "🧠 Analyzing task complexity..." text. The final response includes this UI indicator as a prefix.
- **Expected:** The analyzing message should be stripped from the final response or only sent as a status indicator.
- **Workaround:** Clients can strip lines starting with "🧠" from the response.

### BUG-004: SqliteError in conversation store FTS search
- **Severity:** Medium
- **Location:** `conversation-store.ts:188` `agentSearchConversations`
- **Error:** `SqliteError: SQL logic error` when doing FTS search
- **Impact:** Conversation search via the agent's `conversations_search` tool may fail silently
- **Observed in:** `/tmp/tappi-browser.log` during startup/agent runs

---

## Track B Bugs (Phase 8.9 — T4/T5/T6/T8/T16)

### BUG-T5A: exec_status / exec_kill parameter name mismatch
- **Severity:** Medium (API inconsistency / doc bug)
- **Tools:** `exec_status`, `exec_kill`
- **Behavior:** Tool spec/docs say the parameter is `{"id": "<pid>"}` but the actual API uses `{"pid": <number>}`. Passing `{"id": 60680}` returns "PID undefined not found". Must use `{"pid": 60680}` (number, not string).
- **Source confirmation:** `src/shell-tools.ts` — exec_status/exec_kill use `pid` parameter name.
- **Fix needed:** Either update tool schema to use `id` consistently, or update docs/test spec to reflect `pid` as the correct parameter name.

### BUG-T5B: exec_grep id parameter accepts only number, not "out-N" string
- **Severity:** Low (API inconsistency / doc bug)
- **Tool:** `exec_grep`
- **Behavior:** Passing `{"id": "out-7", "pattern": "250"}` returns `[out-out-7] not found`. Must pass `{"id": 7}` (numeric) to match output buffer. String format "out-7" (as shown in exec_list output) does not work.
- **Source confirmation:** `shellExecGrep` accepts `id?: number`.
- **Fix needed:** Support "out-N" string format in exec_grep id param, or clarify docs that the numeric ID must be passed as a plain number.

### BUG-T6A: register_tool confirmation message shows version as "(undefined)"
- **Severity:** Low (cosmetic display bug)
- **Tool:** `register_tool`
- **Behavior:** `{"name":"test-tool","version":"1.0","description":"Test tool","source":"installed"}` returns `✓ Registered tool: test-tool (undefined) ⚠️ not found on PATH`. Version should show "1.0" but shows "undefined".
- **Note:** `list_tools` correctly shows `test-tool v1.0` — only the registration confirmation message is broken.
- **Fix needed:** Check version interpolation in register_tool result message.

### BUG-T16A: browser_screenshot tab/fullpage/jpeg fails with "No active tab" when no content tab is focused
- **Severity:** Low (state-dependent)
- **Tool:** `browser_screenshot` (targets: tab, fullpage, jpeg)
- **Behavior:** Fails with `"❌ Screenshot failed: No active tab to capture."` if only the Aria tab is active or no content tab is focused. The `window` target always works (uses mainWindow).
- **Reproduction:** Browser started with only Aria tab active; tab/fullpage/jpeg targets all fail.
- **Workaround:** Navigate to any URL to ensure a content tab is active before calling screenshot.
- **Fix needed:** Fallback to first non-Aria tab if no active content tab found, rather than erroring.

### BUG-T16B: /api/browser/screenshot response body is JSON metadata, not PNG binary (update to BUG-001)
- **Severity:** Low (behavior update — BUG-001 severity reduced)
- **Endpoint:** `POST /api/browser/screenshot`
- **Updated behavior (Phase 8.9):** The endpoint NOW correctly saves the PNG file to the `saveTo` path (valid image, correct size ~768KB). Previous BUG-001 said "returns empty file" — this appears fixed or was environment-specific.
- **Remaining issue:** HTTP response body is JSON metadata `{"path":"...","width":2560,"height":1424,"size":767945}`, not the PNG binary. Clients using `curl -o image.png` will save JSON, not the image.
- **Tool passthrough comparison:** `POST /api/tools/browser_screenshot` returns human-readable string `✅ Screenshot saved: /tmp/... (2560×1424, 749.9 KB)` and saves the file correctly. Both routes save the file; only the HTTP response body format differs.
- **Verdict:** BUG-001 downgraded — file saves correctly; response format is JSON (may be intentional). Recommend documenting that `/api/browser/screenshot` is a "save-to-file" endpoint (not image streaming).


---

## Track C Bugs (Phase 8.9, 2026-02-22)

### BUG-005: conversations_list returns short IDs incompatible with conversations_read

- **Track:** T7 — Conversations (T7.2)
- **Severity:** High
- **Description:** `conversations_list` returns 8-character short IDs (e.g. `86faa83d`) in its output, but `conversations_read` requires **full UUIDs** (e.g. `35175468-e2fe-4260-8f87-f05bcbfbfa54`). Using a short ID from the list results in `"Conversation not found."` error.
- **Repro:** Call `conversations_list`, take any displayed ID, pass it to `conversations_read { conversation_id: "86faa83d" }` → fails.
- **Expected:** Either conversations_list should return full UUIDs, or conversations_read should accept 8-char prefix matching.
- **File:** `src/tool-registry.ts` — `conversations_list` / `agentListConversations` formatting

---

### BUG-006: browsing_history tool silently ignores unsupported params (grep, domain, since, sort, limit)

- **Track:** T10 — Browsing Data (T10.2, T10.3, T10.4, T10.5)
- **Severity:** Medium
- **Description:** The `browsing_history` tool's actual schema only accepts `action` (`recent`/`search`/`clear`) and `query`. When called with params like `grep`, `domain`, `since`, `sort`, or `limit`, these are silently ignored and the tool falls back to "recent" behavior with no error or warning. A richer `browse_history` tool exists in the registry but is **not exposed via the API passthrough**.
- **Repro:** `POST /api/tools/browsing_history` with `{"grep":"google"}` — returns recent history, not Google-filtered results.
- **Expected:** Either support rich params in `browsing_history`, or expose `browse_history` tool via the API.
- **File:** `src/tool-registry.ts` — `browsing_history` schema vs. `browse_history` implementation

---

### BUG-007: browse_bookmarks tool defined in registry but not exposed via API passthrough

- **Track:** T10 — Browsing Data (T10.7)
- **Severity:** Medium
- **Description:** `browse_bookmarks` is fully implemented in `tool-registry.ts` (line ~1181) with grep, folder, sort, limit support, but calling `POST /api/tools/browse_bookmarks` returns `{"error":"Tool \"browse_bookmarks\" not found."}`.
- **Repro:** `curl ... POST /api/tools/browse_bookmarks -d '{}'` → 404 tool error
- **Expected:** `browse_bookmarks` should be accessible via API passthrough like other tools.
- **File:** Tool registration/exposure mechanism — browse_bookmarks and browse_history are likely in a conditional code path not included in the default API tool set.

---

### BUG-008: password_vault missing `save` action — no way to save credentials via tool API

- **Track:** T12 — Password Vault (T12.2, T12.3, T12.4, T12.5)
- **Severity:** High
- **Description:** The `password_vault` tool schema only enumerates: `list`, `list_credentials`, `autofill`, `generate`, `delete`. There is no `save` action. Calling `{action:"save", domain:..., username:..., password:...}` returns `"Unknown action."`. The vault can only be populated via browser form autofill capture, not via tool API.
- **Repro:** `POST /api/tools/password_vault -d '{"action":"save","domain":"test.example.com","username":"u","password":"p"}'` → `"Unknown action."`
- **Expected:** A `save` action should exist for programmatic credential storage, or it should be clearly documented that save only works via browser form capture.
- **File:** `src/tool-registry.ts` — `password_vault` execute handler

---

### BUG-009: password_vault `delete` action requires numeric `id` instead of domain

- **Track:** T12 — Password Vault (T12.7)
- **Severity:** Medium
- **Description:** The `delete` action requires a numeric credential `id` (database row ID), not a human-friendly `domain` string. The caller has no way to discover the numeric ID through the tool API — `list` only returns domain names, not IDs. This makes programmatic deletion effectively impossible without direct DB access.
- **Repro:** `{"action":"delete","domain":"test.example.com"}` → `"Need a credential ID to delete."`
- **Expected:** Support delete-by-domain, or have `list_credentials` return the numeric IDs alongside usernames.
- **File:** `src/tool-registry.ts` — `password_vault` `delete` case

---

### BUG-010: ad_blocker `enable`/`disable` action aliases not supported

- **Track:** T14 — Ad Blocker (T14.2)
- **Severity:** Low
- **Description:** The `ad_blocker` tool schema only accepts `on`, `off`, `status`, `exception`. The more intuitive aliases `enable` and `disable` return a usage error string. Documentation (or the test spec) expects `enable`/`disable` to work.
- **Repro:** `{"action":"enable"}` → `"Usage: B1 on|off|status|exception <domain>"`
- **Expected:** Either add `enable`/`disable` as aliases for `on`/`off`, or clearly document that only `on`/`off` are valid.
- **File:** `src/tool-registry.ts` — `ad_blocker` inputSchema enum

---

---

## Track A Bugs (Phase 8.9, 2026-02-22)

### BUG-A01: REST API routes /api/tabs/:id/click-xy and /api/tabs/:id/hover-xy return 404

- **Track:** T1 — Page Tools (T1.12, T1.13)
- **Severity:** Medium
- **Endpoint:** `POST /api/tabs/:id/click-xy`, `POST /api/tabs/:id/hover-xy`
- **Behavior:** Both routes return `{"error":"Route not found: POST /api/tabs/.../click-xy"}`.
- **Workaround:** Use tool passthrough `POST /api/tools/click_xy` and `POST /api/tools/hover_xy` instead (work correctly).
- **Fix needed:** Register `/api/tabs/:id/click-xy` and `/api/tabs/:id/hover-xy` REST routes in `api-server.ts`, or document that these ops only work via tool passthrough.

---

### BUG-A02: back_forward tool passthrough prematurely returns "Cannot go forward"

- **Track:** T2 — Browser Tools (T2.3)
- **Severity:** Low
- **Tool:** `POST /api/tools/back_forward {"direction":"forward"}`
- **Behavior:** After calling `{"direction":"back"}`, immediately calling `{"direction":"forward"}` returns `"Cannot go forward."` even though forward navigation was possible. The CLI `tappi-browser forward` command correctly navigates forward.
- **Root cause:** Likely a timing/state race — the tab hasn't finished updating its history state before the forward check runs.
- **Fix needed:** Add a short delay/retry, or return the actual navigation result rather than a pre-check.

---

### BUG-A03: zoom tool passthrough returns usage string instead of performing action

- **Track:** T2 — Browser Tools (T2.14)
- **Severity:** Medium
- **Tool:** `POST /api/tools/zoom {"action":"in"}` / `{"action":"out"}` / `{"action":"reset"}`
- **Behavior:** All three return `{"result":"Usage: B8 in|out|reset|<percent>"}` without actually zooming.
- **Workaround:** CLI `tappi-browser zoom in/out/reset/<percent>` works correctly.
- **Root cause:** The tool handler likely checks for a different param name (e.g., `level` or `value`) and falls through to a usage message when `action` is passed.
- **Fix needed:** Update tool handler to accept `action` param, or document the correct param name.

---

### BUG-A04: find tool — `text` param clears search; correct param is `query`

- **Track:** T2 — Browser Tools (T2.15)
- **Severity:** Low (doc/API inconsistency)
- **Tool:** `POST /api/tools/find`
- **Behavior:** `{"text":"example"}` → "Find cleared." (text="" behavior). `{"query":"example"}` → correctly finds 2 matches.
- **Root cause:** Tool implementation uses `query` as the param name. Callers using `text` accidentally trigger clear.
- **Fix needed:** Either accept both `text` and `query`, or add the param name to the tool description schema.

---

### BUG-A05: print_pdf tool cannot save PDF — always opens interactive print dialog

- **Track:** T2 — Browser Tools (T2.16)
- **Severity:** High
- **Tool:** `POST /api/tools/print_pdf`
- **Behavior:** Any call (with or without `saveTo`) → "Print dialog opened." No PDF file is saved to disk. There is no silent/headless save path.
- **Impact:** Automated testing and agent workflows cannot programmatically generate PDFs.
- **Fix needed:** Add a `{"silent": true, "saveTo": "/path/file.pdf"}` code path that uses Electron's `printToPDF()` method and writes the buffer to disk without user interaction.

---

### BUG-A06: browser_screenshot returns 0×0 empty file when print dialog is open

- **Track:** T2 — Browser Tools (T2.17)
- **Severity:** Medium
- **Tool:** `POST /api/tools/browser_screenshot`
- **Behavior:** After `print_pdf` opens the print dialog, subsequent `browser_screenshot` calls return `(0×0, 0.0 KB)` empty files.
- **Root cause:** Print dialog blocks webContents rendering, causing `capturePage()` to return empty data.
- **Fix needed:** Detect open dialogs before screenshot capture, or return an error rather than silently writing an empty file.

---

### BUG-A07: 🔴 CRITICAL SECURITY — file_read allows reading arbitrary absolute paths (no sandbox enforcement)

- **Track:** T3 — File Tools (T3.5)
- **Severity:** CRITICAL
- **Tool:** `POST /api/tools/file_read {"path":"/etc/passwd"}`
- **Behavior:** Returns the full content of `/etc/passwd` (100+ lines of system user data). Any absolute path outside the tappi-workspace is accessible.
- **Relative traversal:** `../../etc/passwd` is safely blocked (resolves to `/Users/etc/passwd`, not found). Only the relative path sandbox is enforced.
- **Impact:** Any client or agent with API access can read any file on the host filesystem (SSH keys, tokens, config files, application secrets, etc.).
- **Fix needed:** Validate that the **resolved absolute path** starts with the configured workspace directory (`~/tappi-workspace/`). Reject any path that resolves outside the workspace, regardless of whether it's relative or absolute.

---

### BUG-A08: file_grep schema documents "pattern" param but actual param name is "grep"

- **Track:** T3 — File Tools (T3.8, supplementary)
- **Severity:** Low (documentation/schema inconsistency)
- **Tool:** `POST /api/tools/file_grep`
- **Behavior:** `{"path":"file.txt","pattern":"foo"}` → "Usage: file_grep(path, grep)". `{"path":"file.txt","grep":"foo"}` → works correctly.
- **Fix needed:** Either rename param to `pattern` for consistency with tool description, or update description to explicitly mention the `grep` parameter name.

---
