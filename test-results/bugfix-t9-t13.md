# Bug Fix Summary — T9 & T13

**Date:** 2026-02-22  
**Files changed:** `src/api-server.ts`, `src/agent.ts`, `src/subtask-runner.ts`

---

## Bug T9 — Leading `\n` in API response (Deep Mode)

**Root cause:**  
When deep mode falls back to the direct loop (task is simple), it emits `sendChunk(mainWindow, '\n', false, ...)` to clear the "Analyzing..." message from the UI. The API's `chunkHandler` captured this `'\n'` chunk into `fullResponse` because the existing filter only skipped lines starting with `'🧠'`. The `'\n'` passed the filter and prepended the entire API response.

**Fix — `src/api-server.ts`** (inside `POST /api/agent/ask` chunkHandler):

```typescript
// BEFORE:
if (!text.startsWith('🧠')) {
  fullResponse += text;
}
// ...
json(res, 200, { response: fullResponse });

// AFTER:
if (!text.startsWith('🧠') && text.trim() !== '') {   // skip whitespace-only chunks
  fullResponse += text;
}
// ...
json(res, 200, { response: fullResponse.trimStart() }); // belt-and-suspenders trim
```

Two-layer fix:
1. Skip any chunk whose text is whitespace-only (catches `'\n'`)
2. `trimStart()` on return as an additional safety net

---

## Bug T13 — Empty string returned for `team_create` in Coding Mode

**Root cause (two-part):**

### Part 1 — Early `done=true` closes API before deep mode finishes

In `src/agent.ts`, when the task is successfully decomposed (complex task), the code immediately called:

```typescript
sendChunk(mainWindow, '', true, ariaWebContents);  // done=true, empty text
```

This was intended to clear the "Analyzing…" UI message. However, this `done=true` event is also emitted via `agentEvents`, which the API's `chunkHandler` listens to. The API resolved immediately with `fullResponse = ''` — before `runDeepMode()` even ran.

**Fix — `src/agent.ts`:** Remove the early `sendChunk(…, '', true, …)`. Instead, after `runDeepMode()` completes, emit the final output with `done=true`:

```typescript
// REMOVED:
sendChunk(mainWindow, '', true, ariaWebContents);

// ADDED (after runDeepMode and broadcast('agent:deep-complete',...)):
const deepFinalText = result.aborted
  ? `[Task aborted — ${completed}/${total} steps completed]`
  : result.finalOutput || '[Deep mode complete]';
sendChunk(mainWindow, deepFinalText, true, ariaWebContents);
```

### Part 2 — `codingMode` not forwarded to subtask runner

`runDeepMode()` was called without `codingMode`, so subtask mini-agents were created without team tools. Even if the task reached a subtask, `createTools()` had `codingMode=undefined` (falsy) → no team_create, team_status, etc.

**Fix — `src/agent.ts`:** Add `codingMode` to the `runDeepMode` call:
```typescript
const result = await runDeepMode({
  ...
  codingMode,   // ← added
  ...
});
```

**Fix — `src/subtask-runner.ts`:** Three changes:

1. **`SubtaskRunnerOptions` interface** — add `codingMode?: boolean`
2. **`runDeepMode` destructure** — extract `codingMode = false`
3. **`runBrowsingSubtask` signature + call** — accept and forward `codingMode`:

```typescript
// Interface:
codingMode?: boolean;  // added

// runDeepMode destructure:
codingMode = false,    // added

// runBrowsingSubtask call:
result = await runBrowsingSubtask(..., agentBrowsingDataAccess, codingMode);  // codingMode added

// runBrowsingSubtask signature:
async function runBrowsingSubtask(..., agentBrowsingDataAccess = false, codingMode = false)

// createTools call inside runBrowsingSubtask:
const tools = createTools(browserCtx, subSessionId, { developerMode, llmConfig, codingMode, agentBrowsingDataAccess });
```

---

## Build

```
npx tsc        → 0 errors
cp -r src/ui dist/
cp src/content-preload.js dist/
```
