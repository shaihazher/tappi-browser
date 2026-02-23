# Data Flow Diagrams

End-to-end flows for the five key scenarios. File annotations show which source file handles each step.

---

## 1. User Asks Agent to Click a Button

> "Click the Sign In button"

```mermaid
sequenceDiagram
    participant User
    participant AriaUI as Aria Tab (aria.js)
    participant AriaPreload as aria-preload.ts
    participant Main as main.ts
    participant Agent as agent.ts
    participant Conversation as conversation.ts
    participant LLMClient as llm-client.ts
    participant LLM as LLM API
    participant ToolReg as tool-registry.ts
    participant PageTools as page-tools.ts
    participant Content as content-preload.js

    User->>AriaUI: types "Click the Sign In button"
    AriaUI->>AriaPreload: window.aria.sendMessage(msg)
    AriaPreload->>Main: IPC aria:send
    Main->>Agent: runAgent({ userMessage, browserCtx, llmConfig })

    Note over Agent: assembleContext() → URL + title + tab count (~70 tokens)
    Note over Agent: ZERO page content injected

    Agent->>Conversation: addMessage('user', msg)
    Agent->>Conversation: getWindow() → rolling window
    Agent->>LLMClient: createModel(llmConfig)
    Agent->>LLM: streamText({ system, messages, tools })

    LLM-->>Agent: tool_call: elements()
    Agent->>Main: broadcast agent:tool-result
    Main-->>AriaUI: IPC agent:tool-result (tool display)

    Agent->>ToolReg: elements.execute({ })
    ToolReg->>PageTools: pageElements(wc)
    PageTools->>Content: wc.executeJavaScript('window.__tappi.indexElements()')
    Content-->>PageTools: JSON { elements: [{label:"button", desc:"Sign In"}, ...], meta: {} }
    PageTools-->>ToolReg: "[0] button: Sign In\n[1] link: ..."
    ToolReg-->>Agent: tool result string

    Note over LLM: Sees element list, decides: click index 0

    LLM-->>Agent: tool_call: click({ index: 0 })
    Agent->>ToolReg: click.execute({ index: 0 })
    ToolReg->>PageTools: pageClick(wc, 0)
    PageTools->>Content: wc.executeJavaScript('window.__tappi.clickElement(0)')
    Content-->>PageTools: { label: "button", desc: "Sign In" }
    PageTools-->>ToolReg: "Clicked button: Sign In"
    ToolReg-->>Agent: tool result

    LLM-->>Agent: text: "Clicked Sign In button."
    Agent->>Main: sendChunk(text, done=true)
    Main-->>AriaUI: IPC agent:stream-chunk { text, done:true }
    AriaUI->>User: displays "Clicked Sign In button."

    Agent->>Conversation: addMessages(responseMessages)
    Agent->>ConvStore: addConversationMessage(conv_id, ...)
```

**Files involved:** `aria.js` → `aria-preload.ts` → `main.ts` → `agent.ts` → `conversation.ts` → `llm-client.ts` → `tool-registry.ts` → `page-tools.ts` → `content-preload.js`

---

## 2. User Asks Agent to Summarize Page Text

> "Summarize this article"

```mermaid
sequenceDiagram
    participant User
    participant ChromeUI as Chrome UI (app.js)
    participant Preload as preload.ts
    participant Main as main.ts
    participant Agent as agent.ts
    participant LLM as LLM API
    participant ToolReg as tool-registry.ts
    participant PageTools as page-tools.ts
    participant Content as content-preload.js

    User->>ChromeUI: types in agent sidebar
    ChromeUI->>Preload: window.tappi.sendAgentMessage(msg)
    Preload->>Main: IPC agent:send
    Main->>Agent: runAgent(...)

    Note over Agent: deepMode gate: decomposeTask() → simple=true → direct loop

    Agent->>LLM: streamText({ messages: [{user: "[Browser: URL=...]\n\nSummarize this article"}] })

    LLM-->>Agent: tool_call: text({ })
    Agent->>ToolReg: text.execute({ })
    ToolReg->>PageTools: pageText(wc, undefined, undefined)
    PageTools->>Content: wc.executeJavaScript('window.__tappi.extractText()')
    Content-->>PageTools: "Article title\n\nFirst 1500 chars of page text..."
    PageTools-->>ToolReg: text content
    ToolReg-->>Agent: tool result

    Note over LLM: Has page text. Generates summary.

    LLM-->>Agent: text (streaming): "## Summary\n\nThis article covers..."
    loop Each chunk
        Agent->>Main: sendChunk(chunk, done=false)
        Main-->>ChromeUI: IPC agent:stream-chunk
        ChromeUI->>User: live-renders markdown
    end
    Agent->>Main: sendChunk('', done=true)
```

**Files involved:** `app.js` → `preload.ts` → `main.ts` → `agent.ts` → `tool-registry.ts` → `page-tools.ts` → `content-preload.js`

---

## 3. Deep Mode Task Decomposition

> "Research the top 5 JavaScript frameworks and compare them"

```mermaid
flowchart TD
    A[User message] --> B[main.ts: runAgent]
    B --> C[agent.ts: deep mode gate]
    C --> D[decompose.ts: decomposeTask]
    D -->|LLM call: classify task| E{simple?}
    E -->|yes| F[agent.ts: direct loop]
    E -->|no| G[decomposition: mode=research, 6 subtasks]

    G --> H[subtask-runner.ts: runDeepMode]
    H --> I[Create ~/tappi-workspace/deep-runs/slug-date/]
    H --> J[Broadcast agent:deep-plan to UI]

    J --> K1[subtask 1: browser - React research]
    K1 -->|secondary model| L1[runBrowsingSubtask]
    L1 --> M1[streamText with research system prompt]
    M1 --> N1[Google search → visit 3 URLs → extract findings]
    N1 --> O1[Save findings_1.md]

    O1 --> K2[subtask 2: browser - Vue.js research]
    K2 -->|secondary model| L2[runBrowsingSubtask]
    L2 --> O2[Save findings_2.md]

    O2 --> K3[...subtasks 3-5...]
    K3 --> O3[findings_3-5.md saved]

    O3 --> K6[subtask 6: compile]
    K6 -->|primary model| L6[runCompileStep]
    L6 --> M6[Read all findings_*.md files]
    M6 --> N6[LLM synthesizes final report]
    N6 --> O6[Save final_report.md]

    O6 --> P[agent.ts: addMessage with summary]
    P --> Q[Broadcast agent:deep-complete]
    Q --> R[User sees final report]

    style D fill:#16213e,color:#e0e0ff
    style H fill:#16213e,color:#e0e0ff
    style L1 fill:#1a1a2e,color:#e0e0ff
    style L6 fill:#1a1a2e,color:#e0e0ff
```

**Key files:**
- `agent.ts` — deep mode gate, decomposeTask call, final message persistence
- `decompose.ts` — prompt construction, JSON parsing, `DecompositionResult`
- `subtask-runner.ts` — sequential execution, file I/O, progress events
- `llm-client.ts` — `getModelConfig('secondary')` for execution, primary for compile

**IPC events emitted:**
- `agent:deep-plan` — full plan with all subtask descriptions
- `agent:deep-subtask-start` — per subtask on start
- `agent:deep-stream-chunk` — streaming text per subtask
- `agent:deep-tool-result` — per tool call inside subtask
- `agent:deep-subtask-done` — per subtask on complete/fail
- `agent:deep-complete` — final summary

---

## 4. Coding Mode Team Task

> "Add a dark mode toggle to the settings page" (Coding Mode on)

```mermaid
flowchart TD
    A[User message] --> B[agent.ts: direct loop]
    B -->|system prompt includes CODING_MODE_SYSTEM_PROMPT_ADDENDUM| C[LLM: team_create]

    C --> D[tool-registry.ts: team_create.execute]
    D --> E[team-manager.ts: createTeam]
    E --> F{worktreeIsolation?}
    F -->|yes| G[worktree-manager.ts: createWorktrees]
    G --> H[git worktree add for @frontend and @backend]

    H --> I[LLM: team_task_add for each subtask]
    I --> J[shared-task-list.ts: addTask]

    J --> K[LLM: team_run_teammate @frontend]
    K --> L[team-manager.ts: runTeammate]
    L --> M[subtask-runner-like loop in teammate context]
    M --> N[teammate uses shell tools in isolated worktree]
    N --> O[mailbox.ts: teammate sends update]

    O --> P[LLM: team_run_teammate @backend]
    P --> Q[parallel or sequential teammate run]
    Q --> R[teammate completes task]

    R --> S[LLM: team_status]
    S --> T[LLM: worktree_diff → review changes]
    T --> U[LLM: worktree_merge → merge to main]
    U --> V[LLM: team_dissolve]
    V --> W[Cleanup worktrees]
    W --> X[Final response to user]

    style E fill:#16213e,color:#e0e0ff
    style L fill:#16213e,color:#e0e0ff
```

**Key files:**
- `agent.ts` — orchestrator runs in normal loop, uses team tools
- `tool-registry.ts` — team tools: `team_create`, `team_task_add`, `team_run_teammate`, `team_status`, `team_message`, `team_dissolve`
- `team-manager.ts` — team state, teammate execution (each teammate is a mini-agent loop)
- `worktree-manager.ts` — `git worktree add` per teammate, diff, merge, cleanup
- `shared-task-list.ts` — task queue shared between orchestrator and teammates
- `mailbox.ts` — async message passing between orchestrator and teammates

---

## 5. API / CLI External Request

> HTTP `POST /api/agent/run` with `{ "message": "check the weather" }` (Developer Mode)

```mermaid
sequenceDiagram
    participant CLI as External Client
    participant API as api-server.ts
    participant AgentEvents as agentEvents (EventEmitter)
    participant Main as main.ts
    participant Agent as agent.ts
    participant Tool as tool-registry.ts

    CLI->>API: POST /api/agent/run\n{ message, conversationId? }
    API->>API: Verify Bearer token
    API->>Main: runAgent({ userMessage: message, ... })
    API->>CLI: SSE headers (text/event-stream)

    Main->>Agent: runAgent(...)
    Agent->>AgentEvents: emit('chunk', { text, done })

    Note over API: Subscribed to agentEvents

    loop Each chunk
        AgentEvents-->>API: 'chunk' event
        API-->>CLI: SSE data: {"text":"...", "done":false}
    end

    Agent->>AgentEvents: emit('chunk', { text: finalText, done: true })
    API-->>CLI: SSE data: {"text":"...", "done":true}
    API->>API: Close SSE connection

    Note over CLI: Also receives tool results via SSE:\ndata: {"type":"tool","toolName":"...","display":"..."}
```

**CLI usage** (`src/cli.ts`):

```mermaid
sequenceDiagram
    participant TermUser as Terminal User
    participant CLI as cli.ts (Node CLI)
    participant API as api-server.ts (HTTP)

    TermUser->>CLI: tappi "what is on google.com" --stream
    CLI->>API: GET /api/status → check agent running
    CLI->>API: POST /api/agent/run { message: "..." }
    Note over CLI: streams SSE chunks to stdout
    CLI->>TermUser: prints response as it streams
```

**Key files:**
- `api-server.ts` — Express server, Bearer token auth, `/api/agent/run` (SSE), `/api/status`, `/api/tabs`, `/api/navigate`, `/api/screenshot`
- `cli.ts` — Node.js CLI that POSTs to the local API server
- `agent.ts` — `agentEvents` EventEmitter (module-level) bridging agent to API

**Developer Mode guard:** The HTTP API server only starts when `currentConfig.developerMode === true`. Toggling it via the UI (`devmode:set` IPC) calls `startApiServer()` or `stopApiServer()` live.

---

## Cross-Cutting: IPC Event Fan-out

Agent output is always broadcast to **both** the chrome UI and the Aria tab:

```mermaid
flowchart LR
    Agent[agent.ts: sendChunk / broadcast]
    Agent --> ChromeWC[mainWindow.webContents.send]
    Agent --> AriaWC[ariaWebContents.send]
    Agent --> EventEmitter[agentEvents.emit]

    ChromeWC --> ChromeUI[Chrome sidebar\napp.js]
    AriaWC --> AriaUI[Aria tab\naria.js]
    EventEmitter --> APIServer[api-server.ts\nSSE clients]
```

This means a message typed in the sidebar is visible in Aria tab's stream, and vice versa. Both UIs stay in sync for the current active conversation.

---

## Related Docs

- [Overview](overview.md)
- [Agent System](agent-system.md)
- [Indexer](indexer.md)
- [Electron Structure](electron-structure.md)
- [Source Map](../source-map/files.md)
