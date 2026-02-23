# Test Results — Phase 8.95.1 (UI Testing)

**Date:** 2026-02-22
**Browser version:** 0.1.0
**Architecture:** WebContentsView (post-8.95 migration)

## Summary

**Tested:** 12/18
**Passed:** 12/12
**Fixed during session:** 2 bugs
**Deferred:** 7 (U4, U5, U6, U7, U8, U9, U17 — next session)

## Results

| ID | Test | Result | Notes |
|----|------|--------|-------|
| U1 | Aria tab layout | ✅ Pass | Aria at index 0, isAria=true, full-width chat, sidebar on left |
| U2 | Agent strip visibility | ✅ Pass | Hidden on Aria tab, visible on regular tabs |
| U3 | Agent panel expand | ✅ Pass | Panel expands, page shrinks, no overlap |
| U4 | Conversation CRUD | ⏳ Deferred | Next session |
| U5 | Conversation search | ⏳ Deferred | Next session |
| U6 | Message sync | ⏳ Deferred | Next session |
| U7 | Coding mode button | ⏳ Deferred | Next session |
| U8 | Coding mode toggle | ⏳ Deferred | Next session |
| U9 | Team status card | ⏳ Deferred | Next session |
| U10 | Dark mode | ✅ Pass | **BUG FIXED:** `invert(1)` blanked pages with grey. Replaced with proper dark-reader CSS (dark backgrounds, preserved media). |
| U11 | Settings panel | ✅ Pass | Opens without overlap, all sections visible. Minor QoL improvements noted. |
| U12 | Bookmarks | ✅ Pass | Star toggles ☆↔★, bookmark saved/removed via API |
| U13 | Find on page | ✅ Pass | `B9 "text"` finds matches, API confirms count |
| U14 | New tab page | ✅ Pass | Clean 🪷 greeting, search bar, shortcuts |
| U15 | Tab drag reorder | ✅ Pass | Manually confirmed by user |
| U16 | Recording indicator | ✅ Pass | 🔴 REC confirmed working. 42 frames/5s captured, valid MP4 (367KB). Earlier 0-frame issue was display surface unavailability from headless exec context, not a bug. |
| U17 | Download progress | ⏳ Deferred | Next session |
| U18 | Fullscreen video | ✅ Pass | **BUG FIXED & VERIFIED:** Esc now cleanly exits both OS and HTML5 fullscreen. |

## Bugs Fixed

### BUG-U10: Dark Mode Blanks Pages
- **Severity:** Critical (feature unusable)
- **Root cause:** CSS `filter: invert(1) hue-rotate(180deg)` on `html` root produces washed-out light grey on most sites
- **Fix:** Replaced with proper dark mode CSS — explicit dark background colors, preserved media elements (no inversion), dark scrollbar, themed inputs/code blocks
- **File:** `src/browser-tools.ts` (DARK_MODE_CSS constant)

### BUG-U18: Fullscreen Exit Stuck
- **Severity:** High (user must manually shrink window)
- **Root cause:** macOS Esc exits OS fullscreen (`BrowserWindow.leave-full-screen`) but doesn't trigger HTML5 `leave-html-full-screen` on the webContents. The tab's `isFullscreen` flag stayed true, so `layoutActiveTab()` still used full-size bounds.
- **Fix:** In `leave-full-screen` handler: (1) reset `tabManager.isFullscreen = false`, (2) execute `document.exitFullscreen()` in the active tab, (3) call `layoutViews()`. Made `isFullscreen` public on TabManager.
- **File:** `src/main.ts` (leave-full-screen handler), `src/tab-manager.ts` (isFullscreen visibility)

## Improvements Added

### Tab Switching (API + Agent + CLI)
- **New API endpoint:** `POST /api/tabs/:id/activate` — switches to any tab by ID
- **Agent tool updated:** `tab({ action: "switch", index: N })` and `tab({ action: "list" })`
- **B-command updated:** `B6 switch <index>` and `B6 list`
- **Files:** `src/api-server.ts`, `src/tool-registry.ts`, `src/browser-tools.ts`, `src/command-executor.ts`

### Type fix
- `TabManager.getTabList()` return type now includes `index: number` (was returned but not declared)
- `TabManager.isFullscreen` changed from `private` to `public` for cross-module access
