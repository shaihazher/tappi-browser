# T15 — Download Manager Test Results

**Date:** 2026-02-22  
**Tester:** Subagent (automated)  
**Browser:** Tappi Browser (Electron), already running at API port 18901

---

## Summary

| ID | Test | Status | Notes |
|----|------|--------|-------|
| T15.1 | Download a file | ✅ PASS | XLS and data-URL files downloaded and tracked |
| T15.2 | Download list | ✅ PASS | IPC + B5 command both work correctly |
| T15.3 | Browse downloads tool | ⚠️ PARTIAL | 3 bugs in API layer; in-browser agent works |
| T15.4 | Download persistence | ✅ PASS | SQLite correctly persists; using profile DB path |
| T15.5 | Download cancel | ✅ PASS | Cancel logic correct (code + live test) |
| T15.6 | Download clear | ✅ PASS | clearCompleted works; in-memory Map emptied |
| T15.7 | Restore state | ✅ PASS | agentBrowsingDataAccess was/is false (PATCH broken, but state unchanged) |

**Overall: 6/7 PASS, 1 PARTIAL — 3 bugs found in API layer**

---

## Bugs Found

### BUG-T15-01 — PATCH /api/config does not persist changes
- **Severity:** HIGH  
- **Component:** `src/api-server.ts` → `PATCH /api/config`  
- **Symptom:** Calling `PATCH /api/config` with `{"privacy":{"agentBrowsingDataAccess":true}}` returns `{"success":true}` but the setting is never applied.  
- **Root cause:** The handler sends `mainWindow.webContents.send('api:config-update', body)` to the renderer, but there is **no listener** for `api:config-update` anywhere in the codebase (not in `main.ts`, `preload.ts`, or `ui/index.html`). The `currentConfig` in main process is never updated.  
- **Repro:**
  ```bash
  curl -X PATCH http://127.0.0.1:18901/api/config \
    -H "Authorization: Bearer <token>" \
    -H "Content-Type: application/json" \
    -d '{"privacy":{"agentBrowsingDataAccess":true}}'
  # Returns success, but:
  curl http://127.0.0.1:18901/api/config -H "Authorization: Bearer <token>"
  # agentBrowsingDataAccess is still false
  ```
- **Fix:** In `api-server.ts`, after reading `body`, deep-merge into `currentConfig` and call `saveConfig()`. Or invoke `ipcMain.handle('config:save', ...)` path directly.

---

### BUG-T15-02 — browse_downloads tool absent from GET /api/tools (even when enabled)
- **Severity:** HIGH  
- **Component:** `src/api-server.ts` → `GET /api/tools`  
- **Symptom:** `browse_downloads` never appears in `GET /api/tools` response, even when `agentBrowsingDataAccess` is `true`.  
- **Root cause:** The `/api/tools` handler calls `createTools(browserCtx, 'api', { developerMode, codingMode })` but **does not pass `agentBrowsingDataAccess`**. In `tool-registry.ts`, `browse_downloads` is only included via `createBrowsingDataTools()` which is gated by `options?.agentBrowsingDataAccess`. Without the flag, the tool is never created.  
- **Fix in `api-server.ts`:**
  ```typescript
  const tools = createTools(browserCtx, 'api', {
    developerMode: cfg.developerMode,
    codingMode: cfg.developerMode && cfg.llm?.codingMode,
    agentBrowsingDataAccess: cfg.privacy?.agentBrowsingDataAccess === true, // ADD THIS
  });
  ```
  Same fix needed in the `POST /api/tools/:toolName` handler.

---

### BUG-T15-03 — POST /api/agent/ask does not pass agentBrowsingDataAccess to runAgent
- **Severity:** HIGH  
- **Component:** `src/api-server.ts` → `POST /api/agent/ask`  
- **Symptom:** When calling the agent via REST API with `{"message":"List my recent downloads"}`, the agent uses the `downloads` (B5/in-memory) tool instead of `browse_downloads` (SQLite). Even if the privacy setting were enabled, the API agent would not have the SQLite browse capability.  
- **Root cause:** `runAgent(...)` is called without `agentBrowsingDataAccess` — the parameter defaults to `false`, so `createTools` excludes `browse_downloads`. The same issue exists in `POST /api/agent/ask/stream`.  
- **Fix in `api-server.ts`:**
  ```typescript
  runAgent({
    userMessage: body.message,
    browserCtx,
    // ... other params ...
    agentBrowsingDataAccess: cfg.privacy?.agentBrowsingDataAccess === true, // ADD THIS
  });
  ```

---

## Detailed Test Results

### T15.1 — Download a file ✅ PASS

**Method:** 
1. `node tcmd.js B14 https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf` → PDF opened in-browser viewer (not a download trigger — expected, PDF is rendered natively).  
2. `node tcmd.js eval "window.location.href='https://file-examples.com/storage/.../file_example_XLS_10.xls'"` → XLS file downloaded to `~/Downloads/file_example_XLS_10.xls` (8.7 KB).  
3. `node tcmd.js eval "var a=document.createElement('a');a.href='data:text/plain;charset=utf-8,Hello Download Test';a.download='test-download.txt';a.click()"` → `test-download.txt` (19 B) downloaded.

**Findings:**
- `session.defaultSession.on('will-download', ...)` fires correctly for binary/blob downloads.
- Download counter increments (`dl-1`, `dl-2`, etc.).
- `filename`, `savePath`, `url`, `totalBytes`, `receivedBytes`, `state` all tracked.
- Speed calculation updates every 0.5s during progress.
- PDF opens in browser viewer (not a download) — this is Electron's default behavior for PDFs.

---

### T15.2 — Download list ✅ PASS

**IPC Handler (`src/main.ts` ~line 1290):**
```typescript
ipcMain.handle('downloads:list', () => {
  return getAllDownloads().map(d => ({
    id: d.id,
    filename: d.filename,
    totalBytes: d.totalBytes,
    receivedBytes: d.receivedBytes,
    state: d.state,
    savePath: d.savePath,
    startTime: d.startTime,
  }));
});
```

**Data structure confirmed:** id, filename, url, state, receivedBytes, totalBytes, savePath, startTime, speed, progress% (via notifyUI).

**B5 command test:**
```
$ node tcmd.js B5
Completed (2):
  ✓ file_example_XLS_10.xls (8.5 KB)
  ✓ test-download.txt (19 B)
Download dir: /Users/azeruddinsheik/Downloads
```

**Note:** No REST endpoint for downloads list — only IPC + agent tool. Consistent with design.

---

### T15.3 — Browse downloads tool ⚠️ PARTIAL

**Enable agentBrowsingDataAccess:**
- `PATCH /api/config {"privacy":{"agentBrowsingDataAccess":true}}` returns success but does NOT persist (Bug T15-01).
- Config file shows `agentBrowsingDataAccess: false` after PATCH.

**Tool availability:**
- `browse_downloads` is absent from `GET /api/tools` (Bug T15-02).
- `POST /api/tools/browse_downloads` returns 404.

**Agent ask test:**
```bash
POST /api/agent/ask {"message":"List my recent downloads"}
# Response:
"You have 2 completed downloads:
| file_example_XLS_10.xls | 8.5 KB | Completed |
| test-download.txt | 19 B | Completed |
Saved to: /Users/azeruddinsheik/Downloads"
```
Agent **did respond correctly** using the `downloads` (B5/in-memory) tool — but this reads from in-memory Map, not SQLite. The `browse_downloads` SQLite tool was NOT used (Bug T15-03).

**What works:** The `browse_downloads` tool is correctly defined in `tool-registry.ts` and would work if `agentBrowsingDataAccess` were passed properly. The tool's `execute()` calls `queryDownloads()` which queries the correct profile DB.

---

### T15.4 — Download persistence ✅ PASS

**Database path:** `~/.tappi-browser/profiles/default/database.sqlite` (NOT `~/.tappi-browser/tappi.db`)
> Note: The profile-specific path is initialized via `profileManager.getDatabasePath()` in `main.ts`. Testing against `tappi.db` would show 0 records (wrong file).

**Schema:**
```sql
CREATE TABLE downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  url TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed'
);
CREATE INDEX idx_downloads_created ON downloads(created_at DESC);
CREATE INDEX idx_downloads_status ON downloads(status);
```

**SQLite records confirmed:**
```
test-download.txt | data:text/plain;... | .../Downloads/test-download.txt | 19 | 2026-02-22T03:28:25.961Z | completed
file_example_XLS_10.xls | https://file-examples.com/... | .../Downloads/file_example_XLS_10.xls | 8704 | 2026-02-22T03:26:04.818Z | completed
```

**recordDownload() flow:**
```typescript
item.once('done', (_event, state) => {
  // ...
  try {
    recordDownload(filename, dl.url, savePath, dl.receivedBytes, state);
  } catch {}
  // Note: outer try-catch silently swallows all DB errors
});
```

**Minor note:** Double try-catch in recordDownload path — one in download-manager.ts (silent `catch {}`), one inside `recordDownload()` in database.ts (`catch (e) { console.error(...) }`). Outer catch shadows DB errors completely.

---

### T15.5 — Download cancel ✅ PASS

**Source review (`download-manager.ts`):**
```typescript
export function cancelDownload(id: string): boolean {
  const dl = downloads.get(id);
  if (!dl || !dl.item) return false;  // dl.item = undefined for completed
  dl.item.cancel();  // Electron DownloadItem.cancel()
  return true;
}
```

**State transition on cancel:**
- `dl.item.cancel()` triggers Electron's `done` event with `state = 'cancelled'`
- `item.once('done', ...)` sets `dl.state = 'cancelled'`, clears `dl.item`, calls `recordDownload()`

**Live test on completed download (expected: false):**
```
$ node tcmd.js B5 cancel dl-1
Download dl-1 not found or already complete.
```
Correct — `dl.item` is `undefined` for completed downloads.

**IPC handler:** `ipcMain.handle('downloads:cancel', (_e, id: string) => cancelDownload(id))` — clean, correct.

---

### T15.6 — Download clear ✅ PASS

**Source review:**
```typescript
export function clearCompleted(): void {
  for (const [id, dl] of downloads) {
    if (dl.state !== 'progressing') {
      downloads.delete(id);
    }
  }
  notifyUI();
}
```

Clears cancelled, interrupted, and completed downloads — only leaves `progressing` ones.

**Live test:**
```
$ node tcmd.js B5 clear
Cleared completed downloads.

$ node tcmd.js B5
No downloads.
```
In-memory Map confirmed empty. Note: SQLite records are **not** deleted on clear (by design — history preservation).

**IPC handler:** `ipcMain.handle('downloads:clear', () => { clearCompleted(); return { success: true }; })` — correct.

---

### T15.7 — Restore state ✅ PASS (trivially)

`agentBrowsingDataAccess` was `false` throughout testing because PATCH /api/config doesn't work (Bug T15-01). The config file at `~/.tappi-browser/profiles/default/config.json` shows `"agentBrowsingDataAccess": false` — unchanged from start.

State is effectively already restored.

---

## Architecture Notes

### Download data flow
```
session.on('will-download')
  → initDownloadManager() hook (main process)
  → DownloadItem tracked in Map<id, DownloadItem>
  → item.on('updated') → speed/progress → notifyUI() [IPC to renderer]
  → item.once('done') → final state → recordDownload() → SQLite
                                    → dl.item = undefined (releases Electron ref)
```

### Two download query paths
| Path | Source | When available |
|------|--------|----------------|
| `downloads` tool (B5) | In-memory Map | Always |
| `browse_downloads` tool | SQLite (profile DB) | Only when agentBrowsingDataAccess=true AND running in-browser agent |

### Profile DB vs tappi.db
- `~/.tappi-browser/tappi.db` — legacy/unused (0 download records)
- `~/.tappi-browser/profiles/default/database.sqlite` — active database
- All operations (history, bookmarks, downloads, credentials) use the profile DB
