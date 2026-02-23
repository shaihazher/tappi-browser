# Shell Tools

Tools for running shell commands synchronously or in the background, monitoring processes, and searching command output.

> **⚠️ Developer Mode only.** These tools are only available when Developer Mode is enabled. When it's off, their schemas are not sent to the model at all.

Default working directory: `~/tappi-workspace/` (created automatically).

---

## `exec`

Run a shell command synchronously and capture its output. Output is intelligently truncated for context — first 20 lines + last 20 lines — with the full output buffered and searchable via [`exec_grep`](#exec_grep).

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `command` | `string` | ✅ | Shell command to run. Executed via `$SHELL` (typically `bash`). |
| `cwd` | `string` | ❌ | Working directory (default: `~/tappi-workspace/`). |
| `timeout` | `number` | ❌ | Timeout in milliseconds (default: 30 000). Command is killed with exit code 124 on timeout. |

### Returns

A truncated view of stdout/stderr, exit code, and an output ID. If the command installs a tool (detected via `brew install`, `npm install -g`, etc.) and exits successfully, a nudge is appended reminding you to call `register_tool`.

```
[out-3] exit 0 — npm test (2.4s)
stdout (first 20 lines):
  PASS src/utils.test.ts
  PASS src/api.test.ts

  Test Suites: 2 passed, 2 total
  Tests:       14 passed, 14 total
...
(full output buffered — use exec_grep to search it)
```

### Example

```json
{
  "command": "npm test",
  "cwd": "~/Desktop/my-project"
}
```

---

## `exec_bg`

Run a command in the background (non-blocking). Returns immediately with a PID. Use `exec_status` to poll output and `exec_kill` to stop the process.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `command` | `string` | ✅ | Shell command to run in the background. |
| `cwd` | `string` | ❌ | Working directory (default: `~/tappi-workspace/`). |

### Returns

A summary with the PID and output buffer ID.

```
⏳ Background process started: PID 84312
  Command: npm run dev
  Output: out-5
  Check: exec_status(84312) | Kill: exec_kill(84312)
```

### Example

```json
{
  "command": "npm run dev",
  "cwd": "~/Desktop/my-project"
}
```

---

## `exec_status`

Check the status of a background process started with `exec_bg`. Shows whether it's running, how long it's been up, and its recent output (truncated).

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pid` | `number` | ❌ | Process ID returned by `exec_bg`. Alias: `id`. At least one is required. |
| `id` | `number` | ❌ | Alias for `pid`. |

### Returns

```
PID 84312: ⏳ running (42s)
Command: npm run dev

[out-5 — 86 lines]
  vite v5.0.0 dev server running at:
  ➜  Local:   http://localhost:5173/
  ➜  Network: http://192.168.1.10:5173/
... (83 more lines)
```

### Example

```json
{
  "pid": 84312
}
```

---

## `exec_kill`

Kill a background process by PID. Sends `SIGTERM` first, then `SIGKILL` after 3 seconds if the process hasn't exited.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pid` | `number` | ❌ | Process ID to kill. Alias: `id`. At least one is required. |
| `id` | `number` | ❌ | Alias for `pid`. |

### Returns

```
✓ Sent SIGTERM to PID 84312 (npm run dev)
```

### Example

```json
{
  "pid": 84312
}
```

---

## `exec_grep`

Search through captured command output. By default searches the last command's output. Use `id` to target a specific output buffer, or `all: true` to search everything in the current session.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pattern` | `string` | ✅ | Text to search for (case-insensitive). |
| `id` | `number \| string` | ❌ | Output buffer ID — numeric (`7`) or string (`"out-7"`). Defaults to the last output. |
| `all` | `boolean` | ❌ | If `true`, search all outputs in this session. |
| `context` | `number` | ❌ | Lines of context around each match (default: 2). |

### Returns

Matching lines with context, prefixed with line numbers and match markers.

```
Searching "out-5" for "error":
--- match at line 47 ---
  45:   bundling...
  46:   processing index.ts
>>> 47:   ERROR: Cannot find module './utils'
  48:   at Object.<anonymous> (src/index.ts:3:1)
  49:
```

### Example — search last output

```json
{
  "pattern": "ERROR"
}
```

### Example — search a specific buffer

```json
{
  "pattern": "failed",
  "id": "out-3",
  "context": 3
}
```

---

## See Also

- [`file_read`](./file-tools.md#file_read) — read files produced by shell commands
- [`exec_bg`](#exec_bg) / [`exec_status`](#exec_status) / [`exec_kill`](#exec_kill) — background process lifecycle
- [`http_request`](./http-tools.md#http_request) — make API calls without shell tooling
