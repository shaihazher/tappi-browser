# Tappi Browser — CLI Command Reference

Complete reference for every command in `tappi-browser` (CLI Phase 8.45). Commands are grouped by category.

**Prerequisites:** Tappi Browser must be running. See [CLI Overview](./overview.md).

**Global flags** (place before the command):

| Flag       | Description                                      |
| ---------- | ------------------------------------------------ |
| `--json`   | Machine-readable JSON output                     |
| `--stream` | Enable SSE streaming (for `ask` only)            |

---

## Table of Contents

- [Status](#status)
- [Navigation](#navigation)
- [Tab Management](#tab-management)
- [Page Interaction](#page-interaction)
- [Agent](#agent)
- [Browser Controls](#browser-controls)
- [Tools](#tools)
- [Configuration](#configuration)
- [Developer Mode](#developer-mode)

---

## Status

### `status`

Shows the current state of the running Tappi Browser instance.

**API:** `GET /api/status`

**Usage:**

```bash
tappi-browser status
tappi-browser --json status
```

**Output (default):**

```
Tappi Browser ● running
Model:       anthropic/claude-opus-4-6
Tabs:        3
Dev Mode:    off
API Key:     configured
```

**Output (`--json`):**

```json
{
  "running": true,
  "tabCount": 3,
  "activeTabId": "tab-2",
  "hasApiKey": true,
  "model": "anthropic/claude-opus-4-6",
  "developerMode": false,
  "profile": "default",
  "agentRunning": false,
  "elapsed": 0,
  "toolCalls": 0,
  "timeoutMs": 600000
}
```

---

## Navigation

### `open <url>`

Navigates the current active tab to a URL.

**Alias:** `navigate` (identical behavior)

**API:** `POST /api/tabs/:activeTabId/navigate`

**Usage:**

```bash
tappi-browser open https://github.com
tappi-browser navigate https://news.ycombinator.com
```

**Arguments:**

| Argument | Required | Description      |
| -------- | -------- | ---------------- |
| `url`    | **Yes**  | URL to navigate to |

**Output:**

```
✓ Navigating to: https://github.com
```

---

### `navigate <url>`

Alias for `open`. See [`open`](#open-url).

---

### `back`

Navigates the active tab back in browser history.

**API:** `POST /api/tools/back_forward` with `{ "direction": "back" }`

**Usage:**

```bash
tappi-browser back
```

**Output:**

```
✓ Going back
```

---

### `forward`

Navigates the active tab forward in browser history.

**API:** `POST /api/tools/back_forward` with `{ "direction": "forward" }`

**Usage:**

```bash
tappi-browser forward
```

**Output:**

```
✓ Going forward
```

---

## Tab Management

### `tabs`

Lists all open tabs with their index, title, URL, and active state.

**API:** `GET /api/tabs`

**Usage:**

```bash
tappi-browser tabs
tappi-browser --json tabs
```

**Output (default):**

```
▶ 0. Google
      https://www.google.com
  1. [Aria] Aria
      about:blank
  2. Hacker News
      https://news.ycombinator.com
```

- `▶` (green) marks the active tab
- `[Aria]` (cyan) marks the protected Aria tab

**Output (`--json`):**

```json
[
  {
    "id": "tab-1",
    "title": "Google",
    "url": "https://www.google.com",
    "active": true,
    "isAria": false,
    "index": 0
  }
]
```

---

### `tab new [url]`

Opens a new tab, optionally navigating to a URL.

**API:** `POST /api/tabs`

**Usage:**

```bash
tappi-browser tab new
tappi-browser tab new https://example.com
tappi-browser --json tab new https://example.com
```

**Arguments:**

| Argument | Required | Description                              |
| -------- | -------- | ---------------------------------------- |
| `url`    | No       | URL to open in the new tab (blank if omitted) |

**Output:**

```
✓ New tab opened: https://example.com
```

---

### `tab close [index]`

Closes a tab. Closes the active tab if no index is provided, or the tab at the specified index.

**API:** `DELETE /api/tabs/:id` (resolves ID from index or active tab)

**Usage:**

```bash
tappi-browser tab close          # close active tab
tappi-browser tab close 2        # close tab at index 2
tappi-browser --json tab close 2
```

**Arguments:**

| Argument | Required | Description                               |
| -------- | -------- | ----------------------------------------- |
| `index`  | No       | Zero-based tab index (from `tabs` output) |

**Output:**

```
✓ Tab closed: Hacker News
```

or (no index):

```
✓ Active tab closed
```

**Error cases:**
- `No tab at index N` — index out of range
- `No active tab` — no tab is currently active
- Cannot close the Aria tab (API returns `400`)

---

### `tab switch <index>`

Switches focus to the tab at the given index.

**API:** Resolves tab ID from index, then `POST /api/tabs/:id/navigate`

**Usage:**

```bash
tappi-browser tab switch 0
tappi-browser tab switch 2
```

**Arguments:**

| Argument | Required | Description                               |
| -------- | -------- | ----------------------------------------- |
| `index`  | **Yes**  | Zero-based tab index (from `tabs` output) |

**Output:**

```
✓ Switched to tab: Hacker News
```

**Error cases:**
- `Usage: tab switch <index>` — non-numeric index
- `No tab at index N` — index out of range

---

## Page Interaction

All page interaction commands operate on the **currently active tab** (resolved via `GET /api/status → activeTabId`).

### `elements [--grep <text>]`

Indexes all interactive elements on the current page and prints a numbered list. Element indices are used with `click` and `type`.

**API:** `GET /api/tabs/:id/elements[?grep=...]`

**Usage:**

```bash
tappi-browser elements
tappi-browser elements --grep search
tappi-browser --json elements
```

**Flags:**

| Flag     | Type     | Required | Description                          |
| -------- | -------- | -------- | ------------------------------------ |
| `--grep` | `string` | No       | Filter elements by text (next arg after `--grep`) |

**Output:**

```
0 [button] Sign in
1 [input] Search
2 [a] About
3 [a] Pricing
```

**Example — find and click the search box:**

```bash
tappi-browser elements --grep search
# → 1 [input] Search
tappi-browser click 1
tappi-browser type 1 "tappi browser"
```

---

### `click <index>`

Clicks a page element by its index from `elements`.

**API:** `POST /api/tabs/:id/click` with `{ "index": N }`

**Usage:**

```bash
tappi-browser click 0
tappi-browser click 3
tappi-browser --json click 0
```

**Arguments:**

| Argument | Required | Description                          |
| -------- | -------- | ------------------------------------ |
| `index`  | **Yes**  | Element index from `elements` output |

**Output:**

```
Clicked element 0
```

**Error:** `Usage: click <index>` — non-numeric argument.

---

### `type <index> <text>`

Types text into an element (clears existing content first).

**API:** `POST /api/tabs/:id/type` with `{ "index": N, "text": "..." }`

**Usage:**

```bash
tappi-browser type 1 "hello world"
tappi-browser type 1 search query with multiple words
```

**Arguments:**

| Argument | Required | Description                                     |
| -------- | -------- | ----------------------------------------------- |
| `index`  | **Yes**  | Element index from `elements`                   |
| `text`   | **Yes**  | Text to type (all remaining args joined by space) |

**Output:**

```
Typed into element 1
```

**Error:** `Usage: type <index> <text>` — missing index or text.

---

### `text [--grep <text>]`

Extracts the visible text content of the current page.

**API:** `GET /api/tabs/:id/text[?grep=...]`

**Usage:**

```bash
tappi-browser text
tappi-browser text --grep price
tappi-browser --json text
```

**Flags:**

| Flag     | Type     | Required | Description                           |
| -------- | -------- | -------- | ------------------------------------- |
| `--grep` | `string` | No       | Return only lines containing this text |

**Output:**

```
Hacker News
Top | New | Ask | Show | Jobs | Submit
...
```

---

### `screenshot [file]`

Takes a screenshot of the active tab.

**API:** `POST /api/browser/screenshot` with `{ "target": "tab", "format": "png" }`

**Usage:**

```bash
tappi-browser screenshot
tappi-browser --json screenshot
```

> The `[file]` argument shown in help is accepted as a positional arg but the save path is determined by the API/capture tools — pass `saveTo` via the raw API or use `--json` to retrieve the path.

**Output:**

```
✓ Screenshot saved: /Users/you/Desktop/screenshot-2026-02-22.png
```

**JSON output:**

```json
{
  "path": "/Users/you/Desktop/screenshot-2026-02-22.png",
  "width": 1440,
  "height": 900,
  "size": 284731
}
```

---

## Agent

### `ask <message>`

Sends a message to the AI agent and prints the response. The agent can use browser tools autonomously to complete the task.

**API:** `POST /api/agent/ask` (blocking) or `POST /api/agent/ask/stream` (with `--stream`)

**Usage:**

```bash
tappi-browser ask "What is the top story on HN?"
tappi-browser ask --stream "Summarize this page"
tappi-browser --json ask "What is on this page?"
tappi-browser --json ask --stream "Explain the code on screen"
```

**Arguments:**

| Argument   | Required | Description                                      |
| ---------- | -------- | ------------------------------------------------ |
| `message`  | **Yes**  | The prompt or task for the agent (all remaining args joined by space) |

**Flags:**

| Flag       | Description                                               |
| ---------- | --------------------------------------------------------- |
| `--stream` | Enable SSE streaming — prints response as it's generated  |

**Output (default, blocking):**

```
The top story on Hacker News right now is "Tappi Browser v8.45 Released"
with 342 points and 87 comments...
```

While waiting (blocking mode only), a spinner appears on stdout:

```
🤔 Thinking...
```

This is cleared before the response prints.

**Output (streaming, `--stream`):**

Text is written to stdout incrementally as each chunk arrives. A newline is added at the end.

**Output (`--json`, blocking):**

```json
{
  "response": "The top story on Hacker News right now is..."
}
```

**Error:**

```
✗ No API key configured in Tappi Browser settings
```

**See also:** [SSE Streaming](../api/sse-streaming.md) for the full streaming protocol.

---

## Browser Controls

### `dark-mode on|off`

Enables or disables dark mode for the browser.

**API:** `POST /api/browser/dark-mode`

**Usage:**

```bash
tappi-browser dark-mode on
tappi-browser dark-mode off
tappi-browser --json dark-mode on
```

**Arguments:**

| Argument | Required | Description                 |
| -------- | -------- | --------------------------- |
| `on\|off`| **Yes**  | `on` to enable, `off` to disable |

**Output:**

```
Dark mode enabled
```

**Error:** `Usage: dark-mode on|off` — invalid argument.

---

### `zoom in|out|reset|<level>`

Adjusts the zoom level for the active tab.

**API:** `POST /api/browser/zoom`

**Usage:**

```bash
tappi-browser zoom in
tappi-browser zoom out
tappi-browser zoom reset
tappi-browser zoom 150
tappi-browser --json zoom in
```

**Arguments:**

| Argument | Required | Description                                        |
| -------- | -------- | -------------------------------------------------- |
| `action` | **Yes**  | `in`, `out`, `reset`, or a percentage level like `150` |

**Output:**

```
Zoom set to 150%
```

**Error:** `Usage: zoom in|out|reset|<level>` — missing argument.

---

### `find <text>`

Triggers find-in-page for the active tab.

**API:** `POST /api/browser/find`

**Usage:**

```bash
tappi-browser find "error"
tappi-browser find TODO
tappi-browser --json find error
```

**Arguments:**

| Argument | Required | Description              |
| -------- | -------- | ------------------------ |
| `text`   | **Yes**  | Text to search for (all remaining args joined by space) |

**Output:**

```
Found 5 matches for "error"
```

---

## Tools

### `tools`

Lists all tools currently registered and available for execution.

**API:** `GET /api/tools`

**Usage:**

```bash
tappi-browser tools
tappi-browser --json tools
```

**Output (default):**

```
47 available tools:

  open_url                  Navigate the browser to a URL
  page_elements             Index interactive elements on the page
  page_click                Click an element by index
  page_type                 Type text into an element
  page_text                 Extract visible text from the page
  screenshot                Capture a screenshot
  back_forward              Navigate browser history
  exec                      Run a shell command (developer mode)
  ...
```

**Output (`--json`):**

```json
[
  { "name": "open_url", "description": "Navigate the browser to a URL." },
  { "name": "page_click", "description": "Click an element by index." }
]
```

---

### `tool <name> [json-args]`

Executes a registered tool by name, passing optional JSON arguments.

**API:** `POST /api/tools/:toolName`

**Usage:**

```bash
tappi-browser tool page_text '{}'
tappi-browser tool open_url '{"url": "https://github.com"}'
tappi-browser tool back_forward '{"direction": "back"}'
tappi-browser tool exec '{"command": "ls ~/Desktop"}'
tappi-browser --json tool page_elements '{}'
```

**Arguments:**

| Argument    | Required | Description                                            |
| ----------- | -------- | ------------------------------------------------------ |
| `name`      | **Yes**  | Tool name (from `tools` output)                        |
| `json-args` | No       | JSON object string of tool parameters (default: `{}`) |

**Output:**

Prints the tool's `result` field. If the result is a string, it's printed directly. If JSON, formatted with 2-space indent.

**Error cases:**

- `Usage: tool <name> [json-args]` — no name provided
- `Invalid JSON args: ...` — malformed JSON string
- API returns `404` if tool not found
- API returns `500` if tool execution fails

**Examples:**

```bash
# Navigate
tappi-browser tool open_url '{"url": "https://example.com"}'

# Get page title via JS
tappi-browser tool page_eval '{"js": "document.title"}'

# Run a shell command (developer mode required)
tappi-browser tool exec '{"command": "whoami"}'
```

See [Tool Passthrough](../api/tool-passthrough.md) for full tool documentation.

---

## Configuration

### `config get`

Displays the current browser configuration. API keys are redacted.

**API:** `GET /api/config`

**Usage:**

```bash
tappi-browser config get
tappi-browser --json config get
```

**Output:**

Prints the full config JSON with 2-space indentation. API keys appear as `"••••••••"`.

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-opus-4-6",
    "apiKey": "••••••••",
    "thinking": false,
    "deepMode": true,
    "agentTimeoutMs": 600000
  },
  "developerMode": false,
  "privacy": {
    "agentBrowsingDataAccess": false
  }
}
```

---

### `config set <key> <value>`

Updates a single configuration value. Supports **dot-notation** for nested keys.

**API:** `PATCH /api/config`

**Usage:**

```bash
tappi-browser config set developerMode true
tappi-browser config set llm.model claude-3-5-sonnet-20241022
tappi-browser config set llm.agentTimeoutMs 300000
tappi-browser --json config set developerMode true
```

**Arguments:**

| Argument | Required | Description                                                   |
| -------- | -------- | ------------------------------------------------------------- |
| `key`    | **Yes**  | Config key, dot-notation for nested (e.g. `llm.model`)        |
| `value`  | **Yes**  | Value to set (all remaining args joined by space)             |

**How dot-notation works:**

`config set llm.model claude-3-5-sonnet-20241022` sends:

```json
{ "llm": { "model": "claude-3-5-sonnet-20241022" } }
```

This is deep-merged into existing config — other `llm.*` fields are preserved.

**Output:**

```
✓ Config updated: llm.model = claude-3-5-sonnet-20241022
```

**Common config keys:**

| Key                              | Description                          |
| -------------------------------- | ------------------------------------ |
| `developerMode`                  | Enable developer mode (`true`/`false`) |
| `llm.provider`                   | LLM provider name                   |
| `llm.model`                      | Model identifier                     |
| `llm.thinking`                   | Enable extended thinking             |
| `llm.deepMode`                   | Enable deep mode                     |
| `llm.agentTimeoutMs`             | Agent task timeout in milliseconds   |
| `privacy.agentBrowsingDataAccess`| Allow agent to access cookies/history |

---

## Developer Mode

### `exec <command>`

Runs a shell command via the browser's tool passthrough. Requires `developerMode: true` in config.

**API:** `POST /api/tools/exec`

**Usage:**

```bash
tappi-browser exec ls ~/Desktop
tappi-browser exec "cat /etc/hosts"
tappi-browser --json exec "echo hello"
```

**Arguments:**

| Argument   | Required | Description                                      |
| ---------- | -------- | ------------------------------------------------ |
| `command`  | **Yes**  | Shell command (all remaining args joined by space) |

**Output:**

Prints the command's stdout.

```
project-folder
notes.txt
screenshots
```

**Error:** Returns `500` from the API if developer mode is off or the command fails.

**Enable developer mode:**

```bash
tappi-browser config set developerMode true
```

---

## Help

### `help` / `--help` / `-h`

Prints the full help text and exits.

**Usage:**

```bash
tappi-browser help
tappi-browser --help
tappi-browser -h
tappi-browser        # (no arguments also prints help)
```

**Output:**

```
tappi-browser — Tappi Browser CLI (Phase 8.45)

USAGE
  tappi-browser <command> [args...]
  tappi-browser --json <command>   # Machine-readable JSON output

NAVIGATION
  open <url>              Open URL in current tab
  navigate <url>          Navigate current tab to URL
  back                    Go back
  forward                 Go forward
...
```

---

## Command → API Mapping

| CLI Command                | Method   | API Path                          |
| -------------------------- | -------- | --------------------------------- |
| `status`                   | GET      | `/api/status`                     |
| `tabs`                     | GET      | `/api/tabs`                       |
| `tab new [url]`            | POST     | `/api/tabs`                       |
| `tab close [index]`        | DELETE   | `/api/tabs/:id`                   |
| `tab switch <index>`       | POST     | `/api/tabs/:id/navigate`          |
| `open <url>`               | POST     | `/api/tabs/:id/navigate`          |
| `navigate <url>`           | POST     | `/api/tabs/:id/navigate`          |
| `back`                     | POST     | `/api/tools/back_forward`         |
| `forward`                  | POST     | `/api/tools/back_forward`         |
| `elements [--grep]`        | GET      | `/api/tabs/:id/elements[?grep=]`  |
| `click <index>`            | POST     | `/api/tabs/:id/click`             |
| `type <index> <text>`      | POST     | `/api/tabs/:id/type`              |
| `text [--grep]`            | GET      | `/api/tabs/:id/text[?grep=]`      |
| `screenshot`               | POST     | `/api/browser/screenshot`         |
| `ask <message>`            | POST     | `/api/agent/ask`                  |
| `ask --stream <message>`   | POST     | `/api/agent/ask/stream`           |
| `dark-mode on\|off`        | POST     | `/api/browser/dark-mode`          |
| `zoom <action>`            | POST     | `/api/browser/zoom`               |
| `find <text>`              | POST     | `/api/browser/find`               |
| `tools`                    | GET      | `/api/tools`                      |
| `tool <name> [args]`       | POST     | `/api/tools/:toolName`            |
| `config get`               | GET      | `/api/config`                     |
| `config set <key> <val>`   | PATCH    | `/api/config`                     |
| `exec <command>`           | POST     | `/api/tools/exec`                 |
