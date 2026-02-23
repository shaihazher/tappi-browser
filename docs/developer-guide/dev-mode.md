# Developer Mode

Developer Mode unlocks the full power of the Tappi Browser agent: shell access, CLI tool management, sub-agent spawning, the HTTP API server, and access to the TCP CLI debugging interface. It is off by default for safety — most browsing and research tasks work without it.

---

## Enabling Developer Mode

1. Open **Settings** (gear icon, or `Cmd+,`).
2. Toggle **Developer Mode** on.
3. Click **Save**.

When enabled, Tappi immediately:
- Injects shell tools (`exec`, `exec_bg`, etc.) into the agent's tool set.
- Starts the **TCP CLI server** on `localhost:18900`.
- Starts the **HTTP API server** on `localhost:18901`.
- Makes the **Coding Mode** toggle available (requires Developer Mode).

Turning Developer Mode off reverses all of the above. Coding Mode is also disabled when Developer Mode is toggled off.

Config persists to `~/.tappi-browser/config.json` as `"developerMode": true/false`.

---

## What Developer Mode Unlocks

### Shell Tools

Six additional tools become available to the agent (see [`shell-tools.md`](../tools/shell-tools.md)):

| Tool | Purpose |
|------|---------|
| `exec` | Run a shell command synchronously |
| `exec_bg` | Run a command in the background |
| `exec_status` | Check background process status |
| `exec_kill` | Kill a background process |
| `exec_grep` | Search captured command output |
| `exec_list` | List all captured outputs in session |

The agent can also spawn sub-agents (`spawn_agent`, `sub_agent_status`) which require shell/dev mode.

**Default working directory:** `~/tappi-workspace/` (created on first use).

**Default timeout:** 30 seconds (`execSync`). Background processes run until killed.

**Output discipline:** All command output is captured to an indexed buffer. The agent sees the first 20 + last 20 lines. Use `exec_grep` to search the full output.

### CLI Tool Registry

Four tools let the agent track installed CLI tools:

| Tool | Purpose |
|------|---------|
| `register_tool` | Register a CLI tool after installing it |
| `unregister_tool` | Remove a tool from the registry |
| `update_tool` | Update metadata (version, auth status, notes) |
| `list_tools` | List all registered tools |
| `verify_tools` | Verify all registered tools are still on PATH |

Tools are persisted to `~/.tappi-browser/tools.json` and injected into the agent's context every turn as a compact summary (~5–10 tokens per tool).

**Auto-nudge:** When the agent runs `brew install`, `npm install -g`, `pip install`, `cargo install`, or similar commands and they succeed, the output buffer includes a reminder to call `register_tool`. This is a nudge, not auto-registration.

### TCP CLI Server (Port 18900)

A TCP server for sending raw commands from a terminal without using the UI chat box:

```bash
# Send a prompt to the agent
echo "elements" | nc localhost 18900

# Multi-word prompts
echo "navigate to github.com" | nc localhost 18900
```

The server is only started when Developer Mode is on. If port 18900 is already in use, it logs a message and skips.

### HTTP API Server (Port 18901)

A local REST API server for programmatic tool and agent access. Auth via Bearer token stored at `~/.tappi-browser/api-token`. Rate limited to 100 requests per minute per IP. Binds to `127.0.0.1` only.

```bash
# Read the token
cat ~/.tappi-browser/api-token

# Run a tool
curl -X POST http://localhost:18901/tool/navigate \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'

# Send an agent prompt
curl -X POST http://localhost:18901/agent \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "what is on the current page?"}'
```

See [`src/api-server.ts`](../../src/api-server.ts) for the full endpoint list.

### Coding Mode

Developer Mode is a prerequisite for Coding Mode. Once Developer Mode is enabled, the **Coding Mode** toggle appears in Settings. See [`coding-mode.md`](coding-mode.md).

---

## Sub-Agent Spawning

In Developer Mode the agent can spawn isolated sub-agents for parallel or complex tasks.

### `spawn_agent`

```
spawn_agent(task, model?)
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | string | Yes | Self-contained task description |
| `model` | `"primary"` \| `"secondary"` | No | Model tier — `"secondary"` (default, faster) or `"primary"` (full reasoning) |

- Maximum **3 concurrent** sub-agents.
- Each sub-agent gets its own session ID, conversation history, and output buffer.
- Sub-agents inherit the parent's LLM provider, all tools, and dev mode access.
- They do **not** inherit the parent's conversation history.
- Sub-agents run asynchronously — the parent gets a handle ID and can poll with `sub_agent_status`.
- On completion (or failure), the session is automatically cleaned up (output buffers purged, conversation cleared).

### `sub_agent_status`

```
sub_agent_status(id?)
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | No | Sub-agent ID (e.g. `"sub-1"`). Omit to list all. |

Returns status (`running`, `completed`, `failed`), elapsed time, tools used, and result summary.

**Example flow:**

```
User: Research the top 5 AI frameworks and save a comparison to a file.

Agent: spawn_agent("Research top 5 AI frameworks: PyTorch, JAX, Flax, MXNet, CNTK.
       Compare by community size, production usage, and hardware support.
       Save results to ~/tappi-workspace/ai-frameworks.md")
→ ✓ Spawned sub-1. Check: sub_agent_status("sub-1")

Agent: (continues other work)

Agent: sub_agent_status("sub-1")
→ ✓ completed (14.2s). Saved ai-frameworks.md (2.1 KB).
```

---

## Implementation Reference

| Source File | Purpose |
|------------|---------|
| [`src/shell-tools.ts`](../../src/shell-tools.ts) | Shell execution (`shellExec`, `shellExecBg`, etc.) |
| [`src/tool-manager.ts`](../../src/tool-manager.ts) | CLI tool registry (`registerCliTool`, `verifyAllTools`, etc.) |
| [`src/sub-agent.ts`](../../src/sub-agent.ts) | Sub-agent lifecycle (`spawnSubAgent`, `getSubAgentStatus`) |
| [`src/main.ts`](../../src/main.ts) | `developerMode` config, TCP/API server startup |
| [`src/api-server.ts`](../../src/api-server.ts) | HTTP API server (port 18901) |
| [`src/tool-registry.ts`](../../src/tool-registry.ts) | `createShellTools()` — conditional inclusion |
