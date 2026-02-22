# Phase 8.9 Functional Testing — Track C Results

**Date:** 2026-02-22  
**Tester:** Subagent (test-track-c)  
**Tracks:** Conversations, Browsing Data, Password Vault, Ad Blocker, Downloads

---

## T7 — Conversation Persistence

| ID | Test | Result | Notes |
|----|------|--------|-------|
| T7.1 | conversations_list `{}` | ✅ PASS | Returns 6 conversations with date, short ID, title preview, msg count |
| T7.2 | conversations_read `{conversation_id, limit:5}` | ⚠️ FAIL (short ID) / PASS (full UUID) | **BUG:** T7.1 returns 8-char short IDs (e.g. `86faa83d`). conversations_read requires **full UUIDs** (e.g. `35175468-e2fe-4260-8f87-f05bcbfbfa54`). Short IDs fail with "Conversation not found." Tested with full UUID — works correctly. |
| T7.3 | conversations_read with grep | ✅ PASS | `grep:"screenshot"` with full UUID correctly filters to 2 matching messages out of 4 |
| T7.4 | conversations_search `{grep:"screenshot"}` | ✅ PASS | Cross-conversation search returned 4 matches across 2 conversations with ±context snippets |
| T7.5 | conversations_list with grep | ✅ PASS | `grep:"screenshot"` returns 2 filtered conversations (vs 6 unfiltered) |
| T7.6 | conversations_read with offset | ✅ PASS | `{offset:2, limit:2}` returns messages 2–3 of 4 correctly |
| T7.7 | conversations_read truncation | ✅ PASS | Message of 589 chars in DB is returned as 513 chars with `...(truncated)` marker; all messages ≤~500 chars |

---

## T10 — Browsing Data Tools

| ID | Test | Result | Notes |
|----|------|--------|-------|
| T10.1 | browsing_history `{limit:5}` | ✅ PASS | Returns recent history; extra params like `limit` are silently ignored, tool returns ~10 entries from browser history |
| T10.2 | browsing_history `{grep:"google"}` | ❌ FAIL | **BUG:** `grep` param not supported by `browsing_history` tool. Correct param is `{action:"search", query:"google"}`. With wrong params, falls back to "recent" — no filtering applied, no error. |
| T10.3 | browsing_history `{domain:"news.ycombinator.com"}` | ❌ FAIL | **BUG:** `domain` param ignored. Tool returns full recent history regardless. Domain-scoped filtering requires `browse_history` tool (not exposed in API). |
| T10.4 | browsing_history `{since:"2026-02-21"}` | ❌ FAIL | **BUG:** `since` param ignored. Returns full recent history. Date filtering requires `browse_history` tool (not API-exposed). |
| T10.5 | browsing_history `{sort:"frequent"}` | ❌ FAIL | **BUG:** `sort` param ignored. Returns recent order regardless. Sort-by-frequency requires `browse_history` tool (not API-exposed). |
| T10.6 | downloads `{}` / `{action:"list"}` | ✅ PASS | Both forms return `"No downloads."` — tool is functional |
| T10.7 | browse_bookmarks exists | ❌ FAIL | **BUG:** `browse_bookmarks` is defined in tool-registry.ts but returns `{"error":"Tool \"browse_bookmarks\" not found."}` — not exposed via API passthrough |

---

## T12 — Password Vault

| ID | Test | Result | Notes |
|----|------|--------|-------|
| T12.1 | password_vault `{action:"list"}` | ✅ PASS | Returns `"No saved passwords."` — tool responds correctly |
| T12.2 | password_vault `{action:"save",...}` | ❌ FAIL | **BUG:** `save` action not implemented. Returns `"Unknown action."`. Zod schema enumerates: `list`, `list_credentials`, `autofill`, `generate`, `delete` — no `save`. |
| T12.3 | password_vault save second credential | ❌ FAIL | Same as T12.2 — `save` action missing |
| T12.4 | password_vault list (after save) | ❌ FAIL | Still `"No saved passwords."` — T12.2/T12.3 failed, nothing was saved |
| T12.5 | password_vault `{action:"list_credentials","domain":"test.example.com"}` | ❌ FAIL | Returns `"No credentials saved for test.example.com."` — no data because save failed. Tool itself works correctly for valid data. |
| T12.6 | password_vault `{action:"generate"}` | ✅ PASS | Returns `"Generated password: 8MFG*z5nsVbeVfZ6ZgLM"` — 20-char secure password |
| T12.7 | password_vault `{action:"delete","domain":"test.example.com"}` | ❌ FAIL | **BUG:** delete action requires numeric `id` param, not `domain`. Returns `"Need a credential ID to delete."`. No way to delete by domain. |

---

## T14 — Ad Blocker

| ID | Test | Result | Notes |
|----|------|--------|-------|
| T14.1 | ad_blocker `{action:"status"}` | ✅ PASS | Returns `"Ad blocker: OFF \| Blocked: 0"` — correct format |
| T14.2 | ad_blocker enable | ✅ PASS (with `on`) | `{action:"on"}` → `"Ad blocker: ON"`. Note: `{action:"enable"}` returns usage error — not supported. Spec should use `on`/`off`. |
| T14.3 | Navigate to ad-heavy site, check blocked count | ✅ PASS | Navigated to msn.com; status returned `"Ad blocker: ON \| Blocked: 6"` after page load |
| T14.4 | ad_blocker disable | ✅ PASS | `{action:"off"}` → `"Ad blocker: OFF"` |

---

## T15 — Download Manager

| ID | Test | Result | Notes |
|----|------|--------|-------|
| T15.1 | downloads `{}` / `{action:"list"}` | ✅ PASS | Returns `"No downloads."` — tool is functional |

---

## TA — History Tool (Conversation History Grep)

| ID | Test | Result | Notes |
|----|------|--------|-------|
| TA.1 | history `{grep:"test"}` | ✅ PASS | Returns `"No conversation history."` — expected for new subagent session. Tool is functional; confirmed it exists and responds correctly. |

---

## Summary

| Category | Total | PASS | FAIL |
|----------|-------|------|------|
| T7 Conversations | 7 | 6 | 1 (T7.2 short ID bug) |
| T10 Browsing Data | 7 | 2 | 5 (4 ignored params + 1 missing tool) |
| T12 Password Vault | 7 | 2 | 5 (missing save, wrong delete API) |
| T14 Ad Blocker | 4 | 4 | 0 |
| T15 Downloads | 1 | 1 | 0 |
| TA History | 1 | 1 | 0 |
| **Total** | **27** | **16** | **11** |
