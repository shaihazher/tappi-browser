# Tappi Browser — Tool Passthrough API

The **tool passthrough** API lets you invoke any registered browser tool directly — the same tools the AI agent uses autonomously. This gives you fine-grained, scriptable control over the browser without going through the agent.

---

## Endpoints

| Method | Path                    | Description                     |
| ------ | ----------------------- | ------------------------------- |
| GET    | `/api/tools`            | List all available tools        |
| POST   | `/api/tools/:toolName`  | Execute a specific tool by name |

---

## How It Works

The tool registry (`createTools`) builds the same set of tools used by the AI agent at runtime. The set is dynamic — it depends on:

- **Developer Mode** — additional tools (e.g. `exec`) are included when `developerMode: true`
- **Coding Mode** — enabled when both `developerMode` and `llm.codingMode` are `true`
- **Agent Browsing Data Access** — tools accessing cookies/history are gated by `privacy.agentBrowsingDataAccess`

You can check which tools are currently available with `GET /api/tools`.

---

## `GET /api/tools`

Lists all tools registered in the current session.

**Shell shorthand:**

```bash
TOKEN=$(cat ~/.tappi-browser/api-token)
alias tap='curl -s -H "Authorization: Bearer $TOKEN"'
```

**Request:**

```bash
tap http://127.0.0.1:18901/api/tools
```

**Response:**

```json
[
  { "name": "open_url",       "description": "Navigate the browser to a URL." },
  { "name": "page_elements",  "description": "Index interactive elements on the page." },
  { "name": "page_click",     "description": "Click an element by index." },
  { "name": "page_type",      "description": "Type text into an element." },
  { "name": "page_paste",     "description": "Paste text into an element." },
  { "name": "page_text",      "description": "Extract visible text from the page." },
  { "name": "page_screenshot","description": "Capture a screenshot." },
  { "name": "page_scroll",    "description": "Scroll the page." },
  { "name": "page_keys",      "description": "Send keyboard keys." },
  { "name": "page_eval",      "description": "Evaluate JavaScript in the page." },
  { "name": "back_forward",   "description": "Navigate browser history." },
  { "name": "dark_mode",      "description": "Toggle dark mode." },
  { "name": "zoom",           "description": "Adjust zoom level." },
  { "name": "find",           "description": "Find text in page." },
  { "name": "cookies",        "description": "Manage browser cookies." },
  { "name": "screenshot",     "description": "Take a full screenshot." },
  { "name": "exec",           "description": "Run a shell command. (developer mode)" }
]
```

> Tool names and descriptions come directly from the registry. The exact set depends on configuration — always call `GET /api/tools` to see what's available in your session.

---

## `POST /api/tools/:toolName`

Executes a tool by name. Pass the tool's parameters as a JSON request body.

**Path parameter:**

| Parameter  | Type     | Description                                  |
| ---------- | -------- | -------------------------------------------- |
| `toolName` | `string` | Exact name from the `GET /api/tools` list    |

**Request body:** JSON object — parameters are tool-specific (see examples below).

**Response (success):**

```json
{ "result": "<tool output>" }
```

**Response (tool not found):**

```json
HTTP 404
{ "error": "Tool \"bad_name\" not found. GET /api/tools for list." }
```

**Response (tool execution error):**

```json
HTTP 500
{ "error": "<error message from tool>" }
```

---

## Common Tool Examples

### `open_url` — Navigate to a URL

```bash
tap -X POST http://127.0.0.1:18901/api/tools/open_url \
  -H "Content-Type: application/json" \
  -d '{"url": "https://github.com"}'
```

```json
{ "result": "Navigated to https://github.com" }
```

---

### `page_elements` — Index interactive elements

```bash
tap -X POST http://127.0.0.1:18901/api/tools/page_elements \
  -H "Content-Type: application/json" \
  -d '{}'
```

```json
{ "result": "0 [button] Sign in\n1 [input] Search GitHub\n2 [a] Explore\n..." }
```

With grep filter:

```bash
tap -X POST http://127.0.0.1:18901/api/tools/page_elements \
  -H "Content-Type: application/json" \
  -d '{"grep": "sign"}'
```

---

### `page_click` — Click an element by index

```bash
tap -X POST http://127.0.0.1:18901/api/tools/page_click \
  -H "Content-Type: application/json" \
  -d '{"index": 0}'
```

```json
{ "result": "Clicked element 0" }
```

---

### `page_type` — Type text into an element

```bash
tap -X POST http://127.0.0.1:18901/api/tools/page_type \
  -H "Content-Type: application/json" \
  -d '{"index": 1, "text": "tappi browser"}'
```

```json
{ "result": "Typed into element 1" }
```

---

### `page_text` — Extract page text

```bash
tap -X POST http://127.0.0.1:18901/api/tools/page_text \
  -H "Content-Type: application/json" \
  -d '{}'
```

```json
{ "result": "GitHub · Build and ship software on a single, collaborative platform\n..." }
```

---

### `page_screenshot` — Screenshot current page

```bash
tap -X POST http://127.0.0.1:18901/api/tools/page_screenshot \
  -H "Content-Type: application/json" \
  -d '{}'
```

```json
{ "result": "<base64 PNG data or saved path>" }
```

---

### `page_scroll` — Scroll the page

```bash
# Scroll down
tap -X POST http://127.0.0.1:18901/api/tools/page_scroll \
  -H "Content-Type: application/json" \
  -d '{"direction": "down", "amount": 300}'

# Jump to bottom
tap -X POST http://127.0.0.1:18901/api/tools/page_scroll \
  -H "Content-Type: application/json" \
  -d '{"direction": "bottom"}'
```

---

### `page_keys` — Send keyboard keys

```bash
tap -X POST http://127.0.0.1:18901/api/tools/page_keys \
  -H "Content-Type: application/json" \
  -d '{"keys": "Return"}'
```

---

### `page_eval` — Evaluate JavaScript

```bash
tap -X POST http://127.0.0.1:18901/api/tools/page_eval \
  -H "Content-Type: application/json" \
  -d '{"js": "document.title"}'
```

```json
{ "result": "GitHub: Let's build from here" }
```

---

### `back_forward` — Browser history navigation

```bash
# Go back
tap -X POST http://127.0.0.1:18901/api/tools/back_forward \
  -H "Content-Type: application/json" \
  -d '{"direction": "back"}'

# Go forward
tap -X POST http://127.0.0.1:18901/api/tools/back_forward \
  -H "Content-Type: application/json" \
  -d '{"direction": "forward"}'
```

---

### `exec` — Run a shell command _(developer mode only)_

> Requires `developerMode: true` in config. Enable with `PATCH /api/config`.

```bash
tap -X POST http://127.0.0.1:18901/api/tools/exec \
  -H "Content-Type: application/json" \
  -d '{"command": "ls ~/Desktop"}'
```

```json
{ "result": "project-folder\nnotes.txt\nscreenshots\n" }
```

---

## LLM-Powered Tools

Some tools in the registry use the configured LLM (e.g. for analysis, summarization, or complex reasoning). The API server passes the decrypted API key from config when calling these tools, so they work identically to how the agent invokes them.

If no API key is configured, LLM-powered tools will return an error.

---

## Automation Pattern: Discover → Use

```bash
#!/usr/bin/env bash
# Full workflow: open a page, find a search box, type, and submit

TOKEN=$(cat ~/.tappi-browser/api-token)
H="-H Authorization: Bearer $TOKEN"
BASE="http://127.0.0.1:18901"

function tap() {
  curl -s -H "Authorization: Bearer $TOKEN" "$@"
}

# 1. Navigate to the page
tap -X POST "$BASE/api/tools/open_url" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://duckduckgo.com"}'

sleep 1

# 2. Find the search input
ELEMENTS=$(tap "$BASE/api/tools/page_elements" \
  -X POST -H "Content-Type: application/json" -d '{"grep":"search"}')
echo "Elements: $ELEMENTS"

# 3. Type in index 0 (the search box)
tap -X POST "$BASE/api/tools/page_type" \
  -H "Content-Type: application/json" \
  -d '{"index": 0, "text": "tappi browser"}'

# 4. Press Enter to submit
tap -X POST "$BASE/api/tools/page_keys" \
  -H "Content-Type: application/json" \
  -d '{"keys": "Return"}'

sleep 2

# 5. Extract results text
tap -X POST "$BASE/api/tools/page_text" \
  -H "Content-Type: application/json" -d '{}' | jq -r '.result'
```

---

## CLI Equivalent

The [`tappi-browser tool`](../cli/commands.md#tool) command is a direct wrapper around `POST /api/tools/:toolName`:

```bash
# API call
curl -X POST .../api/tools/page_text -d '{}'

# Equivalent CLI
tappi-browser tool page_text '{}'
```

See [CLI Commands — tool](../cli/commands.md#tool) and [CLI Commands — tools](../cli/commands.md#tools).
