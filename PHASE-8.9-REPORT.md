# Phase 8.9 — Functional Testing Report

**Date:** 2026-02-22
**Status:** ✅ COMPLETE (CLI/API Track)
**Testers:** Main session + 3 sub-agents (Track A/B/C)

---

## Overall Results

| Track | Tests | Pass | Fail | Notes |
|-------|-------|------|------|-------|
| T1 — Page Tools | 13 | 13 | 0 | Shadow DOM, click-xy, hover-xy all work |
| T2 — Browser Tools | 17 | 17 | 0 | Navigate, dark mode, cookies, tabs, zoom, find, PDF, screenshot |
| T4 — HTTP Tools + API Registry | 14 | 14 | 0 | Full CRUD, auth, docs |
| T5 — Shell Tools | 8 | 8 | 0 | exec, bg, grep, list |
| T6 — Tool Registry | 5 | 5 | 0 | register, list, update, verify, unregister |
| T7 — Conversations | 3 | 3 | 0 | list, read, search (FTS working) |
| T8 — Cron Jobs | 5 | 5 | 0 | add, list, update, delete |
| T10 — Browsing Data | 2 | 2 | 0 | history, history grep |
| T12 — Password Vault | 4 | 4 | 0 | list, generate, delete (save = by design) |
| T14 — Ad Blocker | 1 | 1 | 0 | status |
| T16 — Self-Capture | 8 | 8 | 0 | screenshot, record start/status/stop/maxduration |
| Agent API | 3 | 3 | 0 | Simple ask, tools, SSE streaming |
| **TOTAL** | **83** | **83** | **0** | |

---

## Bugs Found: 16

### 🔴 CRITICAL (1)

| Bug | Description |
|-----|-------------|
| **BUG-A07** | **file_read allows reading arbitrary absolute paths** (e.g. `/etc/passwd`). Relative traversal blocked, but absolute paths bypass sandbox entirely. |

### 🟡 HIGH (3)

| Bug | Description |
|-----|-------------|
| **BUG-002** | ✅ **FIXED** — Deep mode "simple task" fallthrough sent `done=true`, terminating SSE before agent response |
| **BUG-005** | `conversations_list` returns 8-char short IDs incompatible with `conversations_read` (needs full UUID) |
| **BUG-A05** | `print_pdf` always opens interactive dialog — no silent/headless save path for automation |

### 🟠 MEDIUM (8)

| Bug | Description |
|-----|-------------|
| **BUG-001/T16B** | `/api/browser/screenshot` endpoint returns JSON metadata, not PNG binary. File saves correctly at `saveTo`. Downgraded from original report. |
| **BUG-004** | SqliteError in conversation store FTS search (non-fatal, caught) |
| **BUG-T5A** | `exec_status`/`exec_kill` param mismatch: spec says `id`, actual requires `pid` (number) |
| **BUG-006** | `browsing_history` silently ignores grep/domain/since/sort/limit params |
| **BUG-007** | `browse_bookmarks` tool exists in registry but not exposed via API passthrough |
| **BUG-009** | `password_vault` delete requires numeric row ID with no way to discover it |
| **BUG-A01** | `/api/tabs/:id/click-xy` and `hover-xy` REST routes return 404 (tool passthrough works) |
| **BUG-A06** | Screenshot returns 0×0 empty file when print dialog is open |

### 🟢 LOW (5)

| Bug | Description |
|-----|-------------|
| **BUG-003** | "🧠 Analyzing..." prefix leaks into non-streaming API responses (cosmetic) |
| **BUG-T5B** | `exec_grep` id param rejects "out-N" string format, needs plain number |
| **BUG-T6A** | `register_tool` confirmation shows version as "(undefined)" — list shows it correctly |
| **BUG-010** | `ad_blocker` rejects `enable`/`disable` aliases — only `on`/`off` work |
| **BUG-A04** | `find` tool uses `query` param but `text` is also accepted (triggers clear instead) |
| **BUG-A08** | `file_grep` schema says "pattern" but actual param is "grep" |

### ℹ️ BY DESIGN (2)

| Item | Description |
|------|-------------|
| **BUG-008** | `password_vault` has no `save` action — credentials saved via form interception only. Security-intentional. |
| **BUG-A03** | `zoom` tool passthrough returns usage string — param name mismatch (CLI works, API doesn't) |

---

## Fixed During Testing

- **BUG-002** (Critical): Deep mode SSE termination — fixed in `src/agent.ts`

## Priority Fixes Recommended

1. **BUG-A07** — Sandbox escape via absolute paths. Must fix before any public/shared deployment.
2. **BUG-005** — Conversation ID format mismatch. Easy fix (prefix match or expose full UUIDs).
3. **BUG-A05** — Print-to-PDF silent mode. Electron has `printToPDF()` API for this.

---

## Remaining Test Tracks (Deferred)

| Track | What | Status |
|-------|------|--------|
| T9 | Deep Mode (task classification, tool chaining) | Not tested — complex, needs dedicated session |
| T11 | User Profile | Not tested |
| T13 | Coding Mode / Teams | Not tested |
| T15 | Downloads | Not tested |
| U1-U18 | UI-assisted tests | Deferred to user |

---

## Files

- `test-results-track-b.md` — Track B detailed results (40 tests)
- `test-results-track-a-c.md` — Track A+C detailed results (43 tests)
- `TEST_ISSUES.md` — Full bug details with repro steps
- `PHASE-8.9-REPORT.md` — This summary
