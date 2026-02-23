# AI Agent (Aria)

Aria 🪷 is the AI agent built into Tappi Browser. She controls the browser through a rich set of tools, keeps a persistent conversation history, and can decompose complex tasks into coordinated subtasks.

---

## Two Ways to Chat

### Sidebar Panel (`⌘J`)

Press **`⌘J`** to slide the agent panel open on the right side of any web tab. The panel is 380 px wide. Use it while browsing to ask questions about the current page without leaving it.

> **Note:** The agent panel is hidden when the Aria tab is active (the Aria tab *is* the agent experience).

### Aria Tab (always first)

The **🪷 Aria** tab is pinned at position 0 and cannot be closed. It provides a full-width, dedicated chat interface with:

- A **conversation sidebar** (left) listing all saved conversations, with a search box.
- A **message thread** (centre) with inline markdown rendering for code blocks, tables, and lists.
- A **token bar** showing context usage against the 200K-token limit.
- A **coding mode button** (`</>`) when Developer Mode is active.
- A **team status card** when an agent team is running.

---

## Starting a Conversation

Type your message in the input field at the bottom and press **Enter** (or click **▶**). Aria streams her response token by token. You can press **■ Stop** at any time to interrupt mid-stream.

### Conversation Persistence

Every conversation is saved to the profile's SQLite database (`database.sqlite`). Conversations persist across app restarts. On startup, Tappi automatically resumes the most recent conversation (or reuses an empty one if none exists).

### Managing Conversations

| Action | How |
|--------|-----|
| New conversation | Click **＋ New Chat** in the Aria tab sidebar |
| Switch conversation | Click any entry in the sidebar |
| Rename conversation | Double-click the conversation title in the sidebar |
| Delete conversation | Hover → click **🗑** |
| Search conversations | Type in the **Search conversations** box — full-text search across all messages |

Auto-titles are generated from the first assistant response (first 6 words, then trimmed to 40 characters).

---

## How Aria Sees Pages

**The page is a black box.** Aria never receives raw HTML or DOM content automatically. Instead, she calls tools when she wants to look at something:

| Tool | What it does |
|------|-------------|
| `elements()` | Lists all interactive elements in the viewport (buttons, links, inputs, etc.) with numeric indexes |
| `elements({ grep: "checkout" })` | Searches all elements (including offscreen) by text match |
| `text()` | Returns ~1.5 KB overview of visible page text |
| `text({ grep: "refund policy" })` | Searches the entire page text for a specific passage |
| `click(index)` | Clicks an indexed element |
| `type(index, text)` | Types into an indexed input field |
| `paste(index, text)` | Pastes text into an input field |
| `navigate(url)` | Navigates the active tab to a URL |
| `search(query)` | Searches using the configured search engine |
| `back_forward()` | Goes back or forward in tab history |

This **grep philosophy** keeps Aria fast and token-efficient: she finds what she needs, rather than reading everything.

---

## What Aria Can Do

### Browsing & Page Interaction

- Navigate to URLs, search the web.
- Click buttons, links, and form elements.
- Type and paste into input fields.
- Scroll pages, trigger keyboard shortcuts on pages.
- Read page content with targeted or grep-based extraction.
- Detect and autofill login forms (credentials never exposed to Aria — see [Privacy & Security](privacy-security.md)).

### File Operations

- Read files (with grep, head/tail, and chunked reading for large files).
- Write files.
- List directory contents.

### HTTP Requests

- Make HTTP requests to any URL.
- Register named API services with base URLs and auth headers.
- Store per-service API keys (encrypted).
- Document API endpoints (schema registry) — persisted across sessions.

### Shell (Developer Mode only)

When **Developer Mode** is enabled in Settings:

- `exec` — run shell commands; output always truncated to first 20 + last 20 lines (full output searchable via `exec_grep`).
- `exec_bg` — run long-running background processes (servers, builds); check with `exec_status`, stop with `exec_kill`.
- `spawn_agent` — spawn a sub-agent for parallel or isolated work.
- `team_create` / `team_task_add` / `team_run_teammate` — orchestrate multi-agent coding teams.

### Conversation History Access

Aria can search and read past conversations:

- `history({ grep: "what I said about X" })` — full-text search over the current session.
- `conversations_list()` — list all stored conversations.
- `conversations_search(query)` — search across all conversation messages.
- `conversations_read({ conversation_id })` — read messages from a specific conversation.

### Cron Jobs

Aria can schedule recurring tasks using `cron_add`, `cron_list`, `cron_update`, `cron_delete`, and `cron_run_now`. Jobs run as isolated agent sessions with full tool access whenever the browser is open.

---

## Deep Mode (Task Decomposition)

With **Deep Mode** on (default), Aria first analyzes your request complexity. If the task is complex, she decomposes it:

1. **Decomposition** — A quick LLM call decides if the task is simple (direct loop) or complex (action/research).
2. **Action mode** — Multi-step tasks where Aria takes sequential browser actions.
3. **Research mode** — Gather information from multiple sources, then compile a final report.

You'll see `🧠 Analyzing task complexity...` while decomposition runs, then a step-by-step progress view as subtasks execute. Each subtask has a configurable timeout (default: 5 minutes).

**Turn off Deep Mode** in Settings if you prefer Aria to always respond directly without decomposition.

---

## Coding Mode

Requires **Developer Mode** to be enabled first.

When **Coding Mode** is active, Aria gains:

- **Agent teams** (`team_create`) — spawn specialized teammates (e.g. `@backend`, `@frontend`, `@tester`) that work in parallel.
- **Git worktree isolation** — each teammate gets an isolated git worktree (its own branch), eliminating file conflicts.
- A richer coding-focused system prompt with team orchestration guidance.

The `</>` button in the Aria tab header toggles Coding Mode on/off.

---

## Secondary Model

You can configure a **secondary model** in Settings (Phase 8.85). Background tasks (like generating your browsing profile, running subtasks) use the secondary model, while your primary model handles main conversations. This lets you use a fast/cheap model for background work and a powerful model for direct chat.

---

## Context Injection

Each agent turn Aria automatically receives (without you asking):

- Current date/time and timezone.
- Active tab title, URL, and total tab count.
- Configured API services (name and endpoint only; schemas via `get_endpoint_docs`).
- Registered CLI tools (if Developer Mode is on).
- Your browsing profile summary (if **Agent Browsing Data Access** is enabled in Settings → Privacy).
- Login form detection hints (when a login form is detected on the current page).
- Active browser profile name (if not "default").
- Multi-identity hints for sites where multiple usernames are stored.

---

## Timeouts

| Scope | Default | Setting |
|-------|---------|---------|
| Main agent | 10 minutes | `agentTimeoutMs` |
| Per teammate | 10 minutes | `teammateTimeoutMs` |
| Per deep-mode subtask | 5 minutes | `subtaskTimeoutMs` |

All timeouts are configurable in Settings.

---

## Related Guides

- [Getting Started](getting-started.md) — setting up your API key
- [Settings](settings.md) — provider, model, deep mode, coding mode
- [Privacy & Security](privacy-security.md) — what agent can and cannot access
- [Browser Profiles](profiles.md) — per-profile conversation isolation
