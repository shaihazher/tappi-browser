# Team Tools

Tools for creating and managing **agent teams** — groups of parallel AI agents that collaborate on complex coding tasks. One agent acts as the **lead** (orchestrator); others are **teammates** (@backend, @frontend, etc.), each running in their own session with full tool access.

> **Coding Mode + Developer Mode required.** Team tools are only available when both are enabled. Lead agents get all 6 tools. Teammate agents get `team_status`, `team_message`, `team_task_add`, and `team_task_update` only.

> **Git worktree isolation:** When the working directory is a git repository, each teammate automatically gets an isolated branch (via `git worktree`) to prevent conflicts.

---

## `team_create`

Create a new team with a task description, working directory, and optional teammate configuration. Initializes the shared mailbox and task list, and creates git worktrees (if in a git repo).

> **Lead only.**

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `taskDescription` | `string` | ✅ | High-level description of the overall task the team will tackle. |
| `workingDir` | `string` | ✅ | Working directory for the project (supports `~/`). |
| `teammates` | `array` | ❌ | Custom teammate configs. If omitted, teammates are auto-detected from the task description (`@backend`, `@frontend`, `@tester`). |
| `teammates[].name` | `string` | ✅ | Teammate handle (e.g. `"@backend"`). |
| `teammates[].role` | `string` | ✅ | Role description shown in the system prompt. |
| `teammates[].model` | `string` | ❌ | Custom model override for this teammate. |
| `worktreeIsolation` | `boolean` | ❌ | Explicitly enable/disable git worktree isolation (default: auto-detect). |

### Returns

A summary of the created team, teammates, worktree status, and next steps.

```
✓ Team "team-1" created with 2 teammate(s):
- @backend [wt-backend]: Backend engineer — handles server logic, APIs, databases
- @frontend [wt-frontend]: Frontend engineer — handles UI, CSS, browser code

Task: Build a REST API with a React frontend
Working dir: ~/Desktop/my-project
🔀 Worktree isolation: ENABLED — each teammate has an isolated copy of the codebase.

Use team_task_add to create tasks, then team_run_teammate to assign work.
```

### Example

```json
{
  "taskDescription": "Build a REST API with a React frontend for task management",
  "workingDir": "~/Desktop/my-project",
  "teammates": [
    { "name": "@backend", "role": "Backend engineer — Node.js, Express, PostgreSQL" },
    { "name": "@frontend", "role": "Frontend engineer — React, TypeScript, Tailwind" }
  ]
}
```

---

## `team_status`

Get a full overview of the active team: teammate statuses, current tasks, task list, file conflicts, and worktree paths.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `team_id` | `string` | ❌ | Team ID (default: the currently active team). |

### Returns

A rich status report including:
- Team metadata and overall status
- Each teammate's current status (idle / working / blocked / done / failed), elapsed time, and worktree branch
- The full shared task list with statuses
- Any detected file conflicts (two tasks touching the same file)

```
**Team team-1** (active)
Task: Build a REST API with a React frontend
Working dir: ~/Desktop/my-project

**Teammates:**
🔄 @backend [wt-backend] (working, 45s): Backend engineer
   → Working on: Set up Express server
   📁 Worktree: /Users/you/Desktop/my-project/.git/tappi-worktrees/wt-backend
✅ @frontend [wt-frontend] (done, 120s): Frontend engineer

**Task List:**
✅ [task-1] Set up project structure [@backend]
🔄 [task-2] Set up Express server [@backend]
⏳ [task-3] Build React UI
```

### Example

```json
{
  "team_id": "team-1"
}
```

---

## `team_message`

Send a message to a specific teammate or broadcast to everyone. Messages are delivered via the team mailbox and appear in the recipient's context at the start of their next turn.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `to` | `string` | ✅ | Recipient handle: `"@backend"`, `"@frontend"`, `"@lead"`, or `"@all"` for broadcast. |
| `content` | `string` | ✅ | Message content. |
| `team_id` | `string` | ❌ | Team ID (default: active team). |

### Returns

Confirmation that the message was queued.

```
✓ Message sent to @backend
```

### Example — lead assigns extra work

```json
{
  "to": "@backend",
  "content": "Please add rate limiting to the /api/tasks endpoint before finishing."
}
```

### Example — teammate signals completion

```json
{
  "to": "@lead",
  "content": "Frontend is done. All components render correctly. Modified: src/App.tsx, src/components/TaskList.tsx"
}
```

---

## `team_task_add`

Add a task to the shared task list. Tasks can be assigned to a specific teammate, have dependencies on other tasks, and track which files they touch.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `title` | `string` | ✅ | Short task title (e.g. `"Set up Express server"`). |
| `description` | `string` | ✅ | Detailed description of what needs to be done. |
| `assignee` | `string` | ❌ | Teammate handle to assign to (e.g. `"@backend"`). |
| `dependencies` | `string[]` | ❌ | List of task IDs that must be `done` before this task can start. If unmet, the task is automatically set to `blocked`. |
| `team_id` | `string` | ❌ | Team ID (default: active team). |

### Returns

The created task object with its assigned ID.

```json
{
  "id": "task-3",
  "title": "Build React UI",
  "status": "pending",
  "assignee": "@frontend",
  "dependencies": ["task-1"],
  ...
}
```

When dependencies are unmet, status is set to `"blocked"` with a reason: `"Waiting for: task-1"`.

### Example

```json
{
  "title": "Build React task list UI",
  "description": "Create a React component that fetches tasks from GET /api/tasks and displays them. Include add/complete/delete actions.",
  "assignee": "@frontend",
  "dependencies": ["task-2"]
}
```

---

## `team_task_update`

Update a task's status, result summary, files touched, or block reason. Call this when starting work (`in-progress`), finishing (`done`), or getting blocked. Completing a task automatically unblocks any dependent tasks.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `task_id` | `string` | ✅ | Task ID (e.g. `"task-2"`). |
| `status` | `string` | ❌ | New status: `"pending"`, `"in-progress"`, `"done"`, or `"blocked"`. |
| `result` | `string` | ❌ | Summary of what was done (shown in `team_status` and dissolution report). |
| `files_touched` | `string[]` | ❌ | List of files modified by this task — used for conflict detection. |
| `blockedBy` | `string` | ❌ | Human-readable explanation of why the task is blocked. |
| `assignee` | `string` | ❌ | Reassign the task to a different teammate. |
| `team_id` | `string` | ❌ | Team ID (default: active team). |

### Returns

```
✓ Task "Set up Express server" updated to done. Unblocked: Build React UI.
```

If file conflicts are detected (multiple active tasks touching the same file), they are listed:

```
⚠️ File conflict: src/index.ts — "Set up Express server" vs "Add auth middleware"
```

### Example — mark done with files

```json
{
  "task_id": "task-2",
  "status": "done",
  "result": "Express server running on port 3000 with /api/tasks CRUD endpoints.",
  "files_touched": ["src/server.ts", "src/routes/tasks.ts", "package.json"]
}
```

### Example — mark blocked

```json
{
  "task_id": "task-4",
  "status": "blocked",
  "blockedBy": "Waiting for @backend to finish the auth middleware — need the JWT secret format."
}
```

---

## `team_dissolve`

Shut down the team, collect results from all teammates, remove git worktrees (if safe — no uncommitted changes), and return a final summary.

> **Lead only.**

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `team_id` | `string` | ❌ | Team ID to dissolve (default: active team). |

### Returns

A dissolution report with:
- Team duration
- Per-teammate status and result summaries
- Task completion counts (done / blocked / pending)
- Worktree removal results (kept if uncommitted changes present)

```
**Team team-1 dissolved.**

Task: Build a REST API with a React frontend
Duration: 8.3 minutes

**Teammate Results:**
- @backend: done
  Express server with full CRUD, JWT auth, and PostgreSQL via Prisma.
- @frontend: done
  React app with task list, add form, and Tailwind styling.

Tasks: 6 total, 6 done, 0 blocked, 0 pending/in-progress

**Completed tasks:**
✅ Set up project structure
✅ Set up Express server: Express running on port 3000...
✅ Add JWT authentication: Middleware added, tokens valid for 24h...
✅ Build React task list UI
✅ Add task creation form
✅ Wire frontend to API
```

### Example

```json
{
  "team_id": "team-1"
}
```

---

## Team Lifecycle

```
team_create → team_task_add (create tasks) → [teammates run via team_run_teammate]
            → team_status (monitor progress)
            → team_message (coordinate)
            → team_task_update (track progress)
            → team_dissolve (collect results)
```

---

## See Also

- [`exec`](./shell-tools.md#exec) — run commands within teammate sessions
- [`file_read`](./file-tools.md#file_read) / [`file_write`](./file-tools.md#file_write) — teammates use these to read and write code
- [`http_request`](./http-tools.md#http_request) — teammates can call APIs and browse documentation
- [`conversations_list`](./conversation-tools.md#conversations_list) — review what each teammate produced
