# T13 — Coding Mode + Agent Teams Test Results

**Date:** 2026-02-22  
**Tester:** Claude Code Subagent (T13-coding-teams)  
**Project:** `~/Desktop/Claude_Space/projects/tappi-browser/`  
**API Base:** `http://127.0.0.1:18901`  
**Status at start:** Browser running, developerMode=true, codingMode=false

---

## 📊 Summary

| Test | Status | Notes |
|------|--------|-------|
| T13.1 | ❌ FAIL | PATCH /api/config doesn't persist codingMode — Bug #1 |
| T13.2 | ✅ PASS | 0 team tools present when codingMode=false |
| T13.3 | ⚠️ PARTIAL | Source code gating correct; live test blocked by Bug #1 |
| T13.4 | ⚠️ BLOCKED | No team tools available due to Bug #1 + Bug #2 |
| T13.5 | ⚠️ BLOCKED | No team created (depends on T13.4) |
| T13.6 | ✅ PASS | shared-task-list.ts — full CRUD + status transitions + dependency tracking |
| T13.7 | ✅ PASS | mailbox.ts — send/receive + broadcast + unread tracking |
| T13.8 | ✅ PASS | team-manager.ts — detectFileConflicts() fully implemented |
| T13.9 | ⚠️ BLOCKED | No team created (depends on T13.4) |
| T13.10 | ✅ PASS | codingMode restored to false (was never changed) |

**Source-verified PASS:** 5/10  
**Live API PASS:** 2/10  
**Bugs found:** 2 (both HIGH severity)

---

## 🐛 Bugs Found

### Bug #1 — PATCH /api/config doesn't persist codingMode
**Severity:** HIGH  
**Component:** `src/api-server.ts` — PATCH `/api/config` handler  
**Description:**  
The PATCH endpoint fires `mainWindow.webContents.send('api:config-update', body)` to signal the renderer, but **no listener for `api:config-update` exists anywhere in the UI** (`src/ui/app.js`, `src/ui/aria.js`, `src/preload.ts` — all searched). The signal is lost in the void.

**Repro:**
```bash
# Enable coding mode
curl -X PATCH http://127.0.0.1:18901/api/config \
  -H "Authorization: Bearer ..." \
  -H "Content-Type: application/json" \
  -d '{"llm":{"codingMode":true}}'
# Returns: {"success":true,"note":"Config update signaled to main process"}

# Verify — still false!
curl http://127.0.0.1:18901/api/config | jq '.llm.codingMode'
# Returns: false
```

**Root Cause:**  
`api-server.ts` only has `getConfig` in its `ApiServerDeps` interface — no `setConfig` or `updateConfig`. The PATCH handler cannot update the in-memory `currentConfig` directly, and the renderer signal path has no listener.

**Correct path in Electron:** `ipcMain.handle('codingmode:set', ...)` at line 1179 of `main.ts` updates `currentConfig.llm.codingMode` and saves it — but this can only be called via `ipcRenderer.invoke()` from the renderer, not via the API.

**Fix Options:**
1. Add `updateConfig: (updates: Partial<TappiConfig>) => void` to `ApiServerDeps`, wire it to update `currentConfig` directly in the PATCH handler
2. OR use `mainWindow.webContents.executeJavaScript("window.tappi.saveConfig({llm:{codingMode:true}})")` in the PATCH handler (uses the exposed preload API)

---

### Bug #2 — POST /api/agent/ask doesn't pass codingMode to the agent
**Severity:** HIGH  
**Component:** `src/api-server.ts` — POST `/api/agent/ask` handler (line ~510)  
**Description:**  
When the agent runs via the REST API (`/api/agent/ask`), `runAgent()` is called without the `codingMode` parameter. Even if `codingMode=true` were properly set in config, the agent would still not have team tools because `runAgent()` defaults to `codingMode=false`.

**Repro:**
```bash
# Even if codingMode WERE enabled in config, this won't give the agent team tools:
curl -X POST http://127.0.0.1:18901/api/agent/ask \
  -H "Authorization: Bearer ..." \
  -d '{"message":"What team_ tools do you have?"}'
# Agent replies: "I don't have any team_ tools"
```

**Root Cause (api-server.ts ~line 503):**
```js
runAgent({
  userMessage: body.message,
  browserCtx,
  llmConfig: { provider, model, apiKey, thinking, deepMode, ... },
  window: mainWindow,
  developerMode: cfg.developerMode,
  deepMode: cfg.llm.deepMode !== false,
  // ❌ MISSING: codingMode: cfg.developerMode && cfg.llm?.codingMode,
})
```

**Fix:** Add `codingMode: cfg.developerMode && cfg.llm?.codingMode` to the `runAgent()` call in the `/api/agent/ask` handler (same pattern already used in `/api/tools` and `/api/tools/:toolName` at lines 634 and 652).

---

## 📋 Detailed Test Results

### T13.1 — Coding Mode Toggle
**Status:** ❌ FAIL

**Steps:**
1. GET /api/config → `codingMode: false` (initial state)
2. PATCH /api/config `{"llm":{"codingMode":true}}` → Returns `{"success":true,"note":"Config update signaled to main process"}`
3. GET /api/config → `codingMode: false` (unchanged!)

**Expected:** codingMode should toggle to true and persist  
**Actual:** PATCH signals renderer via `mainWindow.webContents.send('api:config-update', body)` but no renderer listener exists. Config unchanged.

```json
// Initial + Post-PATCH state (unchanged):
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "codingMode": false,
    "thinking": true,
    "deepMode": true
  },
  "developerMode": true
}
```

---

### T13.2 — Team Tools Gated (codingMode OFF)
**Status:** ✅ PASS

PATCH codingMode=false (already false). GET /api/tools returns **78 tools, 0 team tools**.

```
Team tools: []
Total: 78
```

The gating logic in `tool-registry.ts` is correct:
```ts
...(options?.developerMode && options?.codingMode
  ? createTeamTools(sessionId, browserCtx, options.llmConfig, options.teamId, options.agentName)
  : {}),
```
When `codingMode=false`, `createTeamTools()` is not called and no team tools are added. ✅

---

### T13.3 — Team Tools Present (codingMode ON)
**Status:** ⚠️ PARTIAL PASS (source verified, live blocked by Bug #1)

**Source Analysis:**  
When `createTeamTools()` IS called (codingMode=true, developerMode=true), it creates:
- `team_status` — team overview (all agents)
- `team_message` — inter-agent messaging (all agents)
- `team_task_update` — update task status/result/files (all agents)
- `team_task_add` — add task to shared list (all agents)
- `team_create` — create team with teammates (lead only, `!isTeammate`)
- `team_run_teammate` — assign & start a teammate (lead only)
- `team_dissolve` — end team, generate report (lead only)

**Total: 7 team tools** (4 for all agents + 3 lead-only). This matches the expected 7 from the test spec.

**Live test:** Cannot verify because Bug #1 prevents codingMode from being set via API.

---

### T13.4 — Create Team
**Status:** ⚠️ BLOCKED (Bug #1 + Bug #2)

**Agent response when asked about team tools:**
> "I don't have any **team_** tools — none exist in my current toolset."

The agent has access to 78 tools (shell, browser, file, HTTP, etc.) but zero team tools. Even though developerMode=true, codingMode was never successfully enabled via the API. Additionally, Bug #2 means /api/agent/ask wouldn't pass codingMode even if the config were correct.

**Agent tool inventory (relevant for team work):**
- Shell: `exec`, `exec_bg`, `exec_status`, `exec_kill`, `exec_grep`, `exec_list`
- File: `file_write`, `file_read`, `file_list`, etc.
- Sub-agent: `spawn_agent`, `sub_agent_status`
- HTTP: `http_request`, `register_api`, etc.

---

### T13.5 — Team Status
**Status:** ⚠️ BLOCKED

Direct tool invocation:
```bash
curl -X POST http://127.0.0.1:18901/api/tools/team_status -d '{}'
# Returns: {"error":"Tool \"team_status\" not found. GET /api/tools for list."}
```
Expected — tool not registered because codingMode=false (gating works correctly, just can't enable it via API).

---

### T13.6 — Source Verification: Shared Task List
**Status:** ✅ PASS

File: `src/shared-task-list.ts`

**Verified capabilities:**

| Feature | Implementation | Status |
|---------|---------------|--------|
| Task creation | `createTask()` with title, description, assignee, dependencies | ✅ |
| Task read | `getTask()`, `getTaskList()` | ✅ |
| Task update | `updateTask()` with status, result, files_touched, blockedBy | ✅ |
| Claim task | `claimTask()` with ownership check | ✅ |
| Status: pending | Initial state, auto-set on dep unblock | ✅ |
| Status: in-progress | Via `claimTask()` or `updateTask({status:'in-progress'})` | ✅ |
| Status: done | Via `updateTask({status:'done'})` | ✅ |
| Status: blocked | Auto-set on create if deps unmet, or manual via `blockedBy` | ✅ |
| Dependency tracking | `dependencies: string[]` — checked on create and task completion | ✅ |
| Auto-unblock | When a task is marked done, blocked dependents are auto-unblocked if all deps met | ✅ |
| Persistence | JSON persistence to `~/tappi-workspace/teams/<teamId>/tasks.json` | ✅ |
| Conflict detection | `detectFileConflicts()` checks `files_touched` across non-done tasks | ✅ |
| Context formatting | `formatTaskListForContext()` with emoji status indicators | ✅ |

**Key code excerpt (auto-unblock on done):**
```ts
if (task.status === 'done') {
  for (const other of tasks) {
    if (other.status === 'blocked' && other.dependencies.includes(taskId)) {
      const unmetDeps = other.dependencies.filter(depId => {
        const dep = tasks.find(t => t.id === depId);
        return dep && dep.status !== 'done';
      });
      if (unmetDeps.length === 0) {
        other.status = 'pending';
        other.blockedBy = undefined;
      }
    }
  }
}
```

---

### T13.7 — Source Verification: Mailbox
**Status:** ✅ PASS

File: `src/mailbox.ts`

**Verified capabilities:**

| Feature | Implementation | Status |
|---------|---------------|--------|
| Per-team mailboxes | `teamMailboxes: Map<string, Map<string, Mailbox>>` | ✅ |
| Init mailbox | `initMailbox(teamId, agentName)` | ✅ |
| Send to specific agent | `sendMessage(teamId, from, to, content)` | ✅ |
| Broadcast to all | `to === '@all'` → sends to all except sender | ✅ |
| Unread tracking | `read: boolean` field on each message | ✅ |
| Get unread + mark read | `getUnreadMessages()` — marks as read on retrieval | ✅ |
| Get all messages | `getAllMessages()` — read + unread | ✅ |
| Lead reads all | `getAllTeamMessages()` — all mailboxes | ✅ |
| Context injection | `formatInboxForContext()` — formatted string for LLM prompt | ✅ |
| Cleanup | `cleanupTeamMailbox(teamId)` — clears all mailboxes for a team | ✅ |
| Error handling | Returns descriptive error strings for unknown team/teammate | ✅ |

**Note:** Mailboxes are in-memory only (no disk persistence). Messages are lost on restart.

---

### T13.8 — Source Verification: File Conflict Detection
**Status:** ✅ PASS

File: `src/team-manager.ts` (uses `detectFileConflicts` from `shared-task-list.ts`)

**Algorithm (shared-task-list.ts `detectFileConflicts()`):**
```ts
export function detectFileConflicts(tasks: SharedTask[]): FileConflict[] {
  const fileMap = new Map<string, { taskId: string; taskTitle: string }[]>();

  for (const task of tasks) {
    if (task.status === 'done') continue; // Only check ACTIVE tasks
    for (const file of task.files_touched) {
      if (!fileMap.has(file)) fileMap.set(file, []);
      fileMap.get(file)!.push({ taskId: task.id, taskTitle: task.title });
    }
  }

  const conflicts: FileConflict[] = [];
  for (const [file, taskRefs] of fileMap) {
    if (taskRefs.length > 1) {
      conflicts.push({
        file,
        taskIds: taskRefs.map(r => r.taskId),
        taskTitles: taskRefs.map(r => r.taskTitle),
      });
    }
  }
  return conflicts;
}
```

**Integration points:**
1. `getTeamStatus()` — calls `detectFileConflicts(tasks)` and appends to status output with `⚠️ File Conflicts:`
2. `updateTask()` — returns `{ message, conflicts }` so the calling tool can report conflicts to the lead immediately after a task update
3. `createTeamTools()` → `team_task_update` tool — reports conflicts in its response

**Behavior:**
- Only non-done tasks are checked (done tasks can't conflict)
- Multiple tasks touching the same file → FileConflict returned
- Lead is notified inline when conflicts detected via `team_task_update` response

---

### T13.9 — Team Dissolve
**Status:** ⚠️ BLOCKED (no team created in T13.4)

**Source analysis** of `dissolveTeam()` in `team-manager.ts`:
- Generates a summary via `getTeamSummary(teamId)` (task counts, completed/blocked)
- Reports each teammate's status and result (up to 200 chars)
- Duration: calculated from `team.created_at` to now in minutes
- Cleanup: calls `cleanupSession()`, `purgeSession()`, `clearHistory()` for each teammate session
- Clears mailboxes: `cleanupTeamMailbox(teamId)`
- Clears task list: `cleanupTeamTaskList(teamId)`
- Removes from `activeTeams` map
- Notifies UI via `team:updated` IPC with `null` (clears team panel)

---

### T13.10 — Restore State
**Status:** ✅ PASS

Config was never changed (PATCH failed silently). codingMode remains `false`.  
Verified via `GET /api/config`:
```json
{
  "llm": {
    "codingMode": false,
    "thinking": true,
    "deepMode": true
  },
  "developerMode": true
}
```

---

## 🏗️ Architecture Notes

### How codingMode is correctly set via UI (not API):
1. User clicks the `</>` button in the Aria tab
2. `app.js` calls `window.tappi.invoke('codingmode:set', newVal)` 
3. Preload forwards to `ipcRenderer.invoke('codingmode:set', newVal)`
4. Main process `ipcMain.handle('codingmode:set', ...)` updates `currentConfig.llm.codingMode` and calls `saveConfig()`
5. Broadcasts `codingmode:changed` to both mainWindow and Aria tab

### Team tool hierarchy (Lead vs Teammate):
- **Lead tools (7):** `team_create`, `team_status`, `team_message`, `team_task_add`, `team_task_update`, `team_run_teammate`, `team_dissolve`
- **Teammate tools (4):** `team_status`, `team_message`, `team_task_add`, `team_task_update`
- Teammates cannot create or dissolve teams (`!isTeammate` guard)

### Teammate execution model:
- Teammates run as independent `streamText` sessions (`stepCountIs(100)`)
- They use the **secondary model** (cheaper/faster) by default
- Each teammate gets their own session ID: `${teamId}:${name}`
- Mailbox context (unread messages) is injected into user content
- On completion, teammate sends mail to `@lead` with results
- Runs in background (`runTeammateSession().catch(...)`) — non-blocking

---

## 🔧 Recommended Fixes (Priority Order)

### Fix 1 (Critical): PATCH /api/config — Add direct config update path
In `api-server.ts`, add `updateConfig` to `ApiServerDeps`:
```ts
interface ApiServerDeps {
  mainWindow: BrowserWindow;
  tabManager: TabManager;
  getConfig: () => TappiConfig;
  updateConfig: (updates: DeepPartial<TappiConfig>) => void;  // ADD
  decryptApiKey: (encrypted: string) => string;
}
```
Then in the PATCH handler, call `updateConfig(body)` directly instead of `mainWindow.webContents.send(...)`.

### Fix 2 (Critical): POST /api/agent/ask — Pass codingMode
In `api-server.ts` PATCH handler for `/api/agent/ask`:
```ts
runAgent({
  userMessage: body.message,
  browserCtx,
  llmConfig: { ... },
  window: mainWindow,
  developerMode: cfg.developerMode,
  deepMode: cfg.llm.deepMode !== false,
  codingMode: cfg.developerMode && cfg.llm?.codingMode,  // ADD THIS
})
```

### Fix 3 (Minor): Add renderer listener for api:config-update (fallback)
In `src/ui/app.js`, add:
```js
window.tappi.on('api:config-update', async (updates) => {
  await window.tappi.saveConfig(updates);
});
```
This provides a fallback path while Fix 1 is implemented.
