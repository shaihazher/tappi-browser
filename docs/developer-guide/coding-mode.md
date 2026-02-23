# Coding Mode

Coding Mode turns Tappi into a multi-agent engineering team. The lead agent (your main Aria session) decomposes a task, spawns teammate agents who work in parallel, coordinates them via a shared task list and inter-agent mailbox, and synthesizes their results into a final report.

**Prerequisite:** [Developer Mode](dev-mode.md) must be enabled first.

---

## Enabling Coding Mode

1. Enable **Developer Mode** first (Settings → Developer Mode).
2. Toggle **Coding Mode** on in Settings.
3. Click **Save**.

When Coding Mode is off, team tools are not injected into the agent's tool set at all — they are invisible to the LLM.

---

## Architecture

```
User
 └── @lead (main Aria session)
      ├── Decomposes task with team_create
      ├── Creates shared task list
      ├── Spawns @backend, @frontend, @tests, ...
      │    ├── Each runs as an isolated agent session
      │    ├── Each gets: team tools, task list, mailbox
      │    └── Each works in its own git worktree (if enabled)
      ├── Monitors via team_status
      ├── Coordinates via team_message
      └── Dissolves with team_dissolve → final report
```

---

## Team Lifecycle

### 1. Create a Team

The lead calls `team_create` with a high-level task description and a working directory:

```
team_create({
  task: "Build a REST API for user auth with JWT + SQLite",
  working_dir: "~/projects/myapp",
  teammates: [
    { name: "@backend", role: "API routes and auth logic" },
    { name: "@database", role: "SQLite schema and migrations" },
    { name: "@tests", role: "Jest test suite" }
  ],
  worktree_isolation: true
})
```

If `teammates` is omitted, the lead auto-determines the composition from the task description (via a decompose step).

On creation:
- A team ID is generated (e.g. `team-1`).
- The shared task list is initialized.
- Per-teammate mailboxes are initialized.
- If `worktree_isolation` is true and the working directory is a git repo, each teammate gets a dedicated git worktree (see [Worktree Isolation](#worktree-isolation)).
- All teammate sessions are spawned concurrently.

### 2. Teammates Work in Parallel

Each teammate runs as an independent agent session with:
- Full browser + file + HTTP tools.
- Shell tools (inherited from Developer Mode).
- Team tools: `team_status`, `team_message`, `team_task_update`, `team_task_add`.
- Their own isolated git worktree path (if enabled).
- Their mailbox auto-injected into context on each turn.

Teammates **cannot** call `team_create` or `team_dissolve` — those are lead-only.

### 3. Monitor and Coordinate

```
team_status()          → overview: teammates, tasks, recent messages, file conflicts
team_message({ to: "@backend", content: "Use bcrypt for password hashing" })
team_task_add({ title: "Add rate limiting", assignee: "@backend" })
```

### 4. Dissolve the Team

```
team_dissolve()
```

The lead:
1. Collects each teammate's result.
2. Compiles the task summary (done/blocked/pending counts).
3. Shuts down all teammate sessions.
4. Cleans up worktrees (if isolation was on — you choose whether to auto-merge).
5. Returns the final report.

---

## Shared Task List

All agents on a team share one task list, persisted to:
```
~/tappi-workspace/teams/<team-id>/tasks.json
```

### Task States

| State | Emoji | Meaning |
|-------|-------|---------|
| `pending` | ⏳ | Not yet started |
| `in-progress` | 🔄 | Claimed and being worked on |
| `done` | ✅ | Completed |
| `blocked` | 🚫 | Waiting on dependencies or external blocker |

### Dependency Tracking

Tasks can declare dependencies on other task IDs. When a task is created with `dependencies: ["task-1"]`, it automatically enters `blocked` state if `task-1` is not yet `done`. When the dependency completes, dependent tasks are automatically unblocked.

### File Conflict Detection

When a teammate calls `team_task_update` and reports `files_touched`, the system scans all active tasks for overlapping file paths. If two non-done tasks both touch `src/auth.ts`, a warning is returned:

```
⚠️ File conflict: src/auth.ts touched by task-2 and task-3
```

---

## Inter-Agent Mailbox

Each agent has a private inbox. Unread messages are automatically injected into that agent's context on every turn.

### Sending Messages

```
team_message({ to: "@frontend", content: "API base URL is /api/v1 — update your fetch calls" })
team_message({ to: "@all", content: "We're using ES modules, not CommonJS" })
```

- `@all` broadcasts to every teammate except the sender.
- Messages are lightweight text only (no attachments).

### How Messages Appear in Context

On each turn, if an agent has unread messages, they are injected as:

```
📬 Inbox (2 new messages):
[10:42:31] @lead: Use bcrypt for password hashing
[10:43:05] @backend: Done with /auth/login route
```

Messages are marked as read after injection.

---

## Worktree Isolation

When `worktree_isolation` is `true` (default when the working directory is a git repo), each teammate gets a fully isolated git working directory:

- **Branch:** `wt-<teammate-name>` (e.g. `wt-backend`)
- **Directory:** `<repo>/.tappi-worktrees/<teammate-name>/`
- **Base:** forked from the default remote branch (e.g. `main`)

Teammates work independently without stepping on each other's files. When they finish, the lead merges worktrees back with `worktree_merge`.

`.tappi-worktrees/` is automatically added to `.gitignore`.

### Worktree Tools

| Tool | Description |
|------|-------------|
| `worktree_create` | Create an isolated worktree for a name |
| `worktree_list` | List all Tappi-managed worktrees |
| `worktree_merge` | Merge a worktree branch back to base |
| `worktree_remove` | Remove a worktree and its branch |
| `worktree_status` | Show git status + recent commits in a worktree |
| `worktree_diff` | Show diff between worktree branch and base |

See [`../tools/team-tools.md`](../tools/team-tools.md) for full parameter docs.

### Merge Strategies

| Strategy | Behavior |
|----------|----------|
| `squash` (default) | All changes squashed into one commit on base |
| `merge` | Standard fast-forward or 3-way merge |
| `cherry-pick` | Individual commits applied one by one |

If a merge results in conflicts, the tool lists the conflicting files and instructs you to resolve manually.

---

## Example: Full Team Workflow

```
# 1. Lead decomposes and spawns team
team_create({
  task: "Build a blog backend: posts CRUD + auth",
  working_dir: "~/projects/blog-api"
})
→ Team "team-1" created. 3 teammates spawned in parallel.

# 2. Check progress
team_status()
→ @backend: 🔄 in-progress (task-1: POST /posts route)
  @database: ✅ done (task-2: Schema + migrations)
  @tests: ⏳ pending (task-3: Test suite — waiting for task-1)

# 3. Send a message
team_message({ to: "@backend", content: "Add pagination to GET /posts" })

# 4. Add a new task
team_task_add({
  title: "Add OpenAPI docs",
  description: "Document all endpoints in openapi.yaml",
  assignee: "@backend",
  dependencies: ["task-1"]
})

# 5. Dissolve when done
team_dissolve()
→ Final report: 5 tasks done, 0 blocked. Compiled report saved.
```

---

## Implementation Reference

| Source File | Purpose |
|------------|---------|
| [`src/team-manager.ts`](../../src/team-manager.ts) | `createTeam`, `runTeammate`, `dissolveTeam`, `getTeamStatus` |
| [`src/shared-task-list.ts`](../../src/shared-task-list.ts) | `createTask`, `updateTask`, `claimTask`, `detectFileConflicts` |
| [`src/mailbox.ts`](../../src/mailbox.ts) | `sendMessage`, `getUnreadMessages`, `formatInboxForContext` |
| [`src/worktree-manager.ts`](../../src/worktree-manager.ts) | `WorktreeManager`: create/merge/remove/status/diff |
| [`src/tool-registry.ts`](../../src/tool-registry.ts) | `createTeamTools()`, `createWorktreeTools()` — conditional inclusion |
