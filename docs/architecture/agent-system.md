# Agent System

How Tappi's AI agent works: context assembly, the tool-calling loop, conversation history, deep mode, and sub-agents.

---

## Overview

The agent is a **streaming, multi-step tool-calling loop** built on the [Vercel AI SDK](https://sdk.vercel.ai/) (`streamText` / `generateText`). It runs in the Electron main process and communicates with renderers via IPC.

```
User message
    │
    ▼
main.ts (ipcMain.on 'agent:send' or 'aria:send')
    │
    ▼
agent.ts → runAgent()
    ├─ assembleContext()          ← browser state only, ZERO page content
    ├─ deepMode gate → decomposeTask()
    │     ├─ simple → direct loop
    │     └─ complex → runDeepMode()
    │
    └─ Direct Loop (streamText with tools)
          ├─ LLM generates text + tool calls
          ├─ onStepFinish → broadcast tool results
          ├─ prepareStep → inject warnings / detect duplicates
          └─ done → persist messages, send done=true chunk
```

---

## Entry Points

| IPC Channel | Source | Notes |
|-------------|--------|-------|
| `agent:send` | Chrome UI sidebar | No API key → falls back to text command executor |
| `aria:send` | Aria tab full-chat | Same `runAgent()` call, different `ariaWebContents` target |
| `api-server.ts` | HTTP `POST /api/agent/run` | Developer Mode only — emits via `agentEvents` EventEmitter |
| `cron-manager.ts` | Scheduled jobs | Isolated `runAgent()` call per job |

---

## Context Assembly (`assembleContext()`)

Called once per agent run. **Does not include any page content.** Returns a string (~70–300 tokens) injected into the last user message as `[Browser: ...]`.

### What Gets Injected

| Item | Source | Tokens | Condition |
|------|--------|--------|-----------|
| Current time + timezone | `new Date()` | ~20 | Always |
| Primary + secondary model labels | `llmConfig` | ~10 | Always |
| Browser state (URL, title, tab count) | `browserTools.getBrowserState()` | ~50 | Always |
| API services context | `httpTools.getServiceContext()` | ~30–200 | Only if services registered |
| CLI tools context | `toolManagerMod.getToolsContext()` | ~30–100 | Only if tools registered |
| User profile (interests, browsing habits) | `loadProfile()` | ~200 | Only if `agentBrowsingDataAccess=true` |
| Login hint | `getLoginHint(wc.id)` | ~30 | Only if password field detected on current page |
| Active profile name | `profileManager.activeProfile` | ~5 | Only if non-default profile |
| Multi-identity hint | `listIdentities(domain)` | ~30 | Only if ≥2 identities for current domain |

### Why Not Page Content?

The page is a deliberate black box. Injecting DOM or text on every turn would:
1. Waste thousands of tokens on content the agent may not need
2. Become stale immediately on SPAs (React, Vue)
3. Miss shadow DOM content that the indexer pierces

Instead, the agent calls `elements()` when it needs to see interactive elements, `text()` when it needs to read content, and `grep` variants when it needs to search. This is 10–50× more token-efficient.

---

## Deep Mode Gate

If `deepMode !== false`, `runAgent()` first calls `decomposeTask()` before the direct loop:

```typescript
const decomposition = await decomposeTask(userMessage, llmConfig);

if (decomposition) {
    // Complex task → run through subtask runner
    await runDeepMode({ decomposition, ... });
    return;
}
// Simple task → fall through to direct loop
```

`decomposeTask()` calls the LLM once with a classification prompt. The LLM returns JSON:
- `{ "simple": true }` → direct loop
- `{ "mode": "action"|"research", "subtasks": [...] }` → deep mode

If decomposition fails (LLM error, JSON parse failure), it falls through to the direct loop silently.

See [Data Flow](data-flow.md) for a sequence diagram of deep mode.

---

## Direct Agent Loop (`streamText`)

```typescript
result = streamText({
    model,
    system: SYSTEM_PROMPT,          // fixed Aria personality + tool usage guide
    messages,                       // rolling window from conversation.ts
    tools,                          // created by tool-registry.ts
    providerOptions,                // thinking config (adaptive for Anthropic, etc.)
    abortSignal: abortController.signal,
    prepareStep,                    // inject warnings, detect idle/duplicate
    onStepFinish,                   // broadcast tool results per step
});
```

### Step Lifecycle

```
streamText ─── step 1: LLM generates text + tool calls
                 ├─ onStepFinish: broadcast tool results
                 └─ prepareStep: check timeouts, inject warnings
           ─── step 2: tool results go back as messages
                 └─ ...
           ─── step N: LLM generates final text (no tool calls)
                 └─ stream ends
```

### Termination Conditions

| Condition | How | Note |
|-----------|-----|------|
| Model stops naturally | `finishReason: stop` | Normal completion |
| Timeout | `setTimeout → abortController.abort()` | Default 10 min; preserves partial output |
| Idle detection | 5 consecutive text-only turns → abort | Agent stuck in a loop |
| Duplicate detection | Same tool + same args 3× in a row → inject hint | Prevents spinning |
| Manual stop | `stopAgent()` → `activeRun.abort()` | User-initiated |

### Timeout Warning

At 80% of `agentTimeoutMs`, `prepareStep` injects a user message:
> `[⏰ Approaching timeout (Xm of Ym). Wrap up your current task.]`

---

## Tool Dispatch

Tools are created by `createTools(browserCtx, sessionId, options)` in `tool-registry.ts`. Each tool is a Vercel AI SDK `tool()` object with a Zod input schema and an async `execute` function.

### Tool Categories

| Category | Always Available | Dev Mode Only | Coding Mode Only |
|----------|-----------------|---------------|-----------------|
| Page | `elements`, `click`, `type`, `paste`, `focus`, `check`, `text`, `keys`, `scroll`, `screenshot`, `check_element` | — | — |
| Navigation | `navigate`, `search`, `back_forward`, `new_tab`, `switch_tab`, `close_tab` | — | — |
| Browser | `get_page_state`, `get_tabs`, `screenshot` | — | — |
| Conversation | `history` | — | — |
| Conversations DB | `list_conversations`, `search_conversations`, `read_conversation` | — | — |
| Browsing data | `browser_history`, `browser_bookmarks`, `browser_downloads` | — | `agentBrowsingDataAccess` |
| HTTP | `http_request`, `register_api`, `api_key_store`, `get_endpoint_docs`, `document_endpoint` | — | — |
| Files | `file_read`, `file_write`, `file_append`, `file_list`, `file_exists`, `file_delete`, `file_head`, `file_tail`, `file_move` | — | — |
| Shell | `exec`, `exec_bg`, `exec_status`, `exec_kill`, `exec_grep`, `exec_log`, `exec_input`, `exec_wait` | ✓ | — |
| Sub-agents | `spawn_agent`, `sub_agent_status`, `sub_agent_result`, `list_sub_agents` | ✓ | — |
| Cron | `cron_add`, `cron_list`, `cron_update`, `cron_delete`, `cron_run_now` | — | — |
| Tools | `register_tool`, `update_tool`, `remove_tool`, `list_tools` | — | — |
| Password | `password_lookup`, `generate_password` | — | — |
| Capture | `record_start`, `record_stop`, `record_status` | — | — |
| Team | `team_create`, `team_task_add`, `team_run_teammate`, `team_status`, `team_message`, `team_dissolve` | — | ✓ |
| Worktree | `worktree_status`, `worktree_diff`, `worktree_merge`, `worktree_remove` | — | ✓ + isolation |
| Mailbox | `mailbox_send`, `mailbox_read`, `mailbox_reply` | — | ✓ (team) |
| Task list | `task_list_add`, `task_list_get`, `task_list_update` | — | ✓ (team) |

The `getWC()` helper inside `createTools` always uses `tabManager.activeWebTabWebContents` — it explicitly skips the Aria tab, preventing the agent from accidentally targeting its own chat UI.

---

## Conversation History (`src/conversation.ts`)

In-memory per session (keyed by `sessionId = 'default'` for main agent).

### Rolling Window

```
Token budget: 100,000 tokens (estimated as chars / 4)
Reserved: ~500 tokens for eviction summary
Reserved: first user message (pinned)
```

`getWindow(sessionId)` builds the message array sent to the LLM:

```
[pinned first user message]
[eviction summary (system message)]
[...recent messages within budget]
```

### Eviction Summaries

When messages fall outside the window, `generateEvictionSummaryIfNeeded()` generates a 2–4 bullet summary using the **secondary model** (cheap call). The summary is stored as a `system` message prepended to the next window, giving the LLM continuity without the full token cost.

### Full History (for grep)

`getFullHistory()` returns **all** messages ever added — no truncation. This is what `history({ grep: "..." })` tool uses. The agent can search its entire session history regardless of window size.

### Structured Messages

After each `streamText` run, `result.response.messages` (Vercel AI SDK `ResponseMessage[]`) is persisted — **not** just the text. This preserves tool call content parts and tool result messages, giving the LLM accurate memory of what tools it called and what they returned.

### SQLite Persistence (`src/conversation-store.ts`)

Separate from in-memory history. Each agent response also persists to SQLite:
- User message text
- Assistant response text
- Auto-generated title (after first exchange, using secondary model)

The SQLite store powers the Aria tab's conversation sidebar (list, search, paginated messages).

---

## Deep Mode (`src/decompose.ts` + `src/subtask-runner.ts`)

### Modes

| Mode | Use Case | Compile Step? |
|------|----------|---------------|
| `action` | Multi-step DO tasks (fill form, deploy, post) | No — last subtask IS the action |
| `research` | Information gathering across sources | Yes — compile step synthesizes findings |

### Decomposition Prompt

The LLM receives a structured prompt that returns:
```json
{
  "mode": "action",
  "subtasks": [
    { "task": "...", "tool": "browser|files|shell|http|compile", "output": "step_1.md" }
  ]
}
```
or `{ "simple": true }` to skip deep mode.

### Subtask Runner (`runDeepMode`)

1. Creates a run directory: `~/tappi-workspace/deep-runs/{slug}-{date}/`
2. Sends `agent:deep-plan` to UI with the full plan
3. For each subtask (sequential):
   - `tool === 'compile'` → `runCompileStep()` using **primary model**
   - Otherwise → `runBrowsingSubtask()` using **secondary model**
   - Saves output as `step_N.md` in the run directory
   - Sends `agent:deep-subtask-start` / `agent:deep-subtask-done` events
4. Returns `DeepRunResult` with final output, duration, abort status

### Browsing Subtasks

Each subtask runs its own mini-agent loop (`streamText`) with a focused system prompt. Prior step outputs are referenced as file paths in the task prompt — the subtask can `file_read` them to access previous findings.

Subtask timeout: `subtaskTimeoutMs` (default 5 minutes).

---

## Sub-Agents (`src/sub-agent.ts`)

The main agent can spawn background workers via the `spawn_agent` tool:

```
max concurrent: 3
model: secondary (by default)
isolation: own session ID, own conversation history, own output buffer
```

Sub-agents:
- Run asynchronously (non-blocking to the main agent)
- Have `stepCountIs(50)` limit (fewer steps than the main agent)
- Report results via `sub_agent_status(id)` and `sub_agent_result(id)` tool calls
- Are cleaned up (session + output buffer + history) when they finish or on app quit

---

## LLM Client (`src/llm-client.ts`)

### Supported Providers

| Provider | Auth | Thinking Support |
|----------|------|-----------------|
| `anthropic` | API key or OAuth token | Adaptive (`type: 'adaptive'`) |
| `openai` | API key | `reasoning_effort: 'medium'` for o1/o3/o4 |
| `google` | API key | `thinkingBudget: 8192` for Gemini 2.5+ |
| `openrouter` | API key | Passes through to underlying provider |
| `ollama` | None (local) | Not supported |
| `bedrock` | AWS credential chain (env / `~/.aws` / IAM role) | Adaptive via Anthropic pass-through |
| `vertex` | Google ADC | `thinkingBudget: 8192` for Gemini 2.5+ |
| `azure` | Endpoint + API key | `reasoning_effort: 'medium'` for o1/o3/o4 |

### Primary vs Secondary

`getModelConfig('secondary', config)` returns a derived config:
- Provider: `secondaryProvider` or primary
- Model: `secondaryModel` (must be set; if not, returns primary config)
- API key: `secondaryApiKey` or primary
- Thinking: always `false` for secondary

Used by: subtask runner (execution steps), sub-agents, eviction summaries, user profile generation.

---

## System Prompt (`SYSTEM_PROMPT` in `agent.ts`)

The system prompt is **fixed** (not regenerated per turn). Key sections:

1. **Identity** — "You are Aria 🪷, an AI agent built into a web browser."
2. **Core Rule** — "The page is a black box. Never assume — look."
3. **Tool reference table** — when to use which tool
4. **The Grep Philosophy** — grep > scroll > read-all
5. **elements / text / HTTP / shell / file / cron details** — tool-specific usage patterns
6. **Style** — concise narration, alternative on failure

In Coding Mode, `CODING_MODE_SYSTEM_PROMPT_ADDENDUM` is appended, covering team orchestration, git worktree isolation, and coding standards.

---

## Agent Progress Tracking

`agentProgressData` is a module-level variable updated every second via `setInterval` while the agent runs:

```typescript
{ running: boolean; elapsed: number; toolCalls: number; timeoutMs: number }
```

Broadcast via:
- `agent:progress` IPC to chrome + aria renderers (1-second interval)
- `GET /api/agent/status` HTTP endpoint (Developer Mode)

---

## Related Docs

- [Overview](overview.md)
- [Electron Structure](electron-structure.md)
- [Indexer](indexer.md)
- [Data Flow](data-flow.md)
- [Source Map](../source-map/files.md)
