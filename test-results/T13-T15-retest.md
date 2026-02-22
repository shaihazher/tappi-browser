# T13 + T15 Re-test Results
**Date:** 2026-02-22  
**Time:** ~09:42 GMT+5:30  
**API Base:** http://127.0.0.1:18901  
**Tester:** Subagent (T13-T15-retest session)

---

## Summary

| Group | Tests | Pass | Fail | Notes |
|-------|-------|------|------|-------|
| T13 — Coding Mode | 5 | 4 | 1 | T13.4 agent returned empty response |
| T15 — Downloads | 2 | 2 | 0 | — |
| **Total** | **7** | **6** | **1** | |

---

## T13 — Coding Mode

### T13.1 — Config Toggle ✅ PASS

**Test:** PATCH codingMode false → verify → PATCH back to true → verify.

```
PATCH {"llm":{"codingMode":false}}  → {"success":true}
GET /api/config                     → codingMode: false ✅ PERSISTS
PATCH {"llm":{"codingMode":true}}   → {"success":true}
GET /api/config                     → codingMode: true  ✅ PERSISTS
```

**Result:** Config toggles and persists correctly. The previously-reported PATCH bug is **FIXED**.

---

### T13.2 — Tools Gated OFF (codingMode=false) ✅ PASS

**Test:** With codingMode false, GET /api/tools — count team-specific tools.

```
GET /api/tools (codingMode=false)
Total tools: 80
Team-specific tools: 0
  (spawn_agent and sub_agent_status present but are base tools, not team mode tools)
```

**Result:** 0 dedicated team tools when codingMode is false. ✅

> **Note:** The keyword search for "team/agent/spawn/dissolve/assign/member/colleague" returned `spawn_agent` and `sub_agent_status` which are baseline tools present regardless. The 7 true team tools (`team_create`, `team_status`, `team_message`, `team_task_update`, `team_task_add`, `team_run_teammate`, `team_dissolve`) are absent. Expectation of "0 team tools" is fully met.

---

### T13.3 — Tools Present ON (codingMode=true) ✅ PASS

**Test:** With codingMode true, GET /api/tools — count team tools.

```
GET /api/tools (codingMode=true)
Total tools: 87 (was 80 — 7 added)
New team tools: team_create, team_status, team_message, team_task_update,
                team_task_add, team_run_teammate, team_dissolve
Team tool count: 7
```

**Result:** Exactly **7 team tools** added when codingMode is enabled. ✅

---

### T13.4 — Create Team (Live) ⚠️ PARTIAL / ANOMALOUS

**Test:** POST /api/agent/ask with team creation prompt, --max-time 60.

```json
Request: {"message": "Create a coding team with @backend and @tester to work on
          ~/tappi-workspace/test-project/. Start by creating a simple index.js file."}
Response: {"response": ""}
HTTP status: 200 (exit code 0)
Elapsed: < 60s
```

**Result:** Agent returned an **empty string response** (`""`). The call did not timeout, did not error, but produced no content. This may indicate:
- The agent session has a separate state from the API tool list (agent session may not have team tools loaded for its own execution context)
- The agent's LLM turn produced an empty completion
- Session initialization issue on the agent side

This is worth investigating. The API correctly exposes team tools and codingMode is respected for tool gating — but the `/api/agent/ask` endpoint returns empty when prompted to create a team.

---

### T13.9 — Team Dissolve ✅ PASS (informative)

**Test:** POST /api/agent/ask with `"Dissolve the team"`, --max-time 30.

```
Response: "There's no active team to dissolve. It looks like the previous team
           session wasn't fully initialized (the earlier task was aborted mid-way),
           so there's nothing currently running. Would you like me to create a fresh
           team with @backend and @tester...?"
```

**Result:** Agent responded meaningfully and correctly identified no active team. The dissolve intent was understood. ✅

> **Cross-reference with T13.4:** The agent's response here confirms T13.4's team creation silently failed (it produced empty response instead of a rejection message). The agent did not have an active team after T13.4.

---

## T15 — Downloads

### T15.3 — Browse Downloads Tool ✅ PASS

**Step 1 — Tool presence:**
```
browse_downloads present: True  ✅
```

**Step 2 — Invoke tool:**
```
POST /api/tools/browse_downloads  body: {}
```

**Response:**
```
test-download.txt (0.0 KB, completed)
  2026-02-22T03:28:25.961Z
  From: data:text/plain;charset=utf-8,Hello Download Test
  Saved: /Users/azeruddinsheik/Downloads/test-download.txt

file_example_XLS_10.xls (8.5 KB, completed)
  2026-02-22T03:26:04.818Z
  From: https://file-examples.com/storage/fe44a32385699a5b29cc58d/2017/02/file_example_XLS_10.xls
  Saved: /Users/azeruddinsheik/Downloads/file_example_XLS_10.xls
```

**Result:** Returns 2 download records from SQLite with timestamp, source URL, and save path. ✅

---

### T15.3b — Browse History Tool ✅ PASS

**Test:** POST /api/tools/browse_history with `{"grep":"ycombinator"}`

**Response:**
```
[2026-02-22T03:24:50.825Z] (×10) New Tab
  https://news.ycombinator.com/

[2026-02-22T02:53:13.387Z] (×2) Hacker News
  https://news.ycombinator.com/item?id=47103506

[2026-02-22T02:47:14.038Z] (×1) Hacker News
  https://news.ycombinator.com/item?id=47103931
```

**Result:** Returns 3 history entries matching "ycombinator" with visit counts and timestamps. ✅

---

## Settings Restored

| Setting | Before | After |
|---------|--------|-------|
| `codingMode` | true | **false** ✅ |
| `agentBrowsingDataAccess` | true | **false** ✅ |

Both restored via `PATCH /api/config {"llm":{"codingMode":false},"privacy":{"agentBrowsingDataAccess":false}}` → `{"success":true}`.

---

## Key Findings

1. **PATCH /api/config is fully fixed** — codingMode toggles and persists correctly both ways. Previously-blocked tests can now execute.

2. **Tool gating works perfectly** — 0 team tools with codingMode off, 7 team tools with codingMode on. Delta = exactly 7.

3. **T15 Download/History tools work** — `browse_downloads` returns SQLite-backed records. `browse_history` with grep filters correctly.

4. **Agent endpoint anomaly (T13.4)** — `/api/agent/ask` returns empty string when prompted for team creation. The API layer is correct but the agent's execution context may not have team tools available in its own session, or there's a response serialization issue. Recommend follow-up investigation.

5. **Team dissolve via agent works** (T13.9) — The agent understands dissolve intent and responds with context-aware messaging even when no team exists.
