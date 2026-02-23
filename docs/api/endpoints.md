# Tappi Browser — REST API Endpoints

Complete reference for every route exposed by `api-server.ts`. All endpoints require a valid `Authorization: Bearer <token>` header. See [API Overview](./overview.md) for authentication details.

**Base URL:** `http://127.0.0.1:18901`  
**Shell shorthand used in examples:**

```bash
TOKEN=$(cat ~/.tappi-browser/api-token)
alias tap='curl -s -H "Authorization: Bearer $TOKEN"'
```

---

## Table of Contents

- [Status](#status)
- [Tabs](#tabs)
- [Page Interaction](#page-interaction)
- [Agent](#agent)
- [Browser](#browser)
- [Configuration](#configuration)
- [Tools](#tools)

---

## Status

### `GET /api/status`

Returns the current state of the browser: tab count, active tab, model, agent progress, and configuration flags.

**Parameters:** none

**Response:**

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

| Field           | Type      | Description                                      |
| --------------- | --------- | ------------------------------------------------ |
| `running`       | `boolean` | Always `true` when the server responds           |
| `tabCount`      | `number`  | Number of open tabs                              |
| `activeTabId`   | `string`  | ID of the currently focused tab                  |
| `hasApiKey`     | `boolean` | Whether an LLM API key is configured             |
| `model`         | `string`  | Active LLM as `"provider/model"`                 |
| `developerMode` | `boolean` | Whether developer mode is enabled                |
| `profile`       | `string`  | Browser profile name (currently always `default`)|
| `agentRunning`  | `boolean` | Whether an agent task is currently executing     |
| `elapsed`       | `number`  | Milliseconds the current agent task has run      |
| `toolCalls`     | `number`  | Number of tool calls made in current agent run   |
| `timeoutMs`     | `number`  | Configured agent timeout in milliseconds         |

**Example:**

```bash
tap http://127.0.0.1:18901/api/status | jq .
```

---

## Tabs

### `GET /api/tabs`

Lists all open tabs.

**Parameters:** none

**Response:** Array of tab objects.

```json
[
  {
    "id": "tab-1",
    "title": "Google",
    "url": "https://www.google.com",
    "active": false,
    "isAria": false,
    "index": 0
  },
  {
    "id": "tab-2",
    "title": "Aria",
    "url": "about:blank",
    "active": true,
    "isAria": true,
    "index": 1
  }
]
```

| Field    | Type      | Description                              |
| -------- | --------- | ---------------------------------------- |
| `id`     | `string`  | Unique tab identifier                    |
| `title`  | `string`  | Page title                               |
| `url`    | `string`  | Current URL                              |
| `active` | `boolean` | Whether this is the focused tab          |
| `isAria` | `boolean` | Whether this is the protected Aria tab   |
| `index`  | `number`  | Zero-based position in the tab bar       |

**Example:**

```bash
tap http://127.0.0.1:18901/api/tabs | jq '.[] | {id, title, url}'
```

---

### `POST /api/tabs`

Creates a new tab, optionally navigating to a URL.

**Request body:**

| Field | Type     | Required | Description                          |
| ----- | -------- | -------- | ------------------------------------ |
| `url` | `string` | No       | URL to open in the new tab           |

**Response:** The newly created tab object (same shape as `GET /api/tabs` items).

```json
{
  "id": "tab-3",
  "title": "New Tab",
  "url": "https://example.com",
  "active": true,
  "isAria": false,
  "index": 2
}
```

**Example:**

```bash
tap -X POST http://127.0.0.1:18901/api/tabs \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

---

### `DELETE /api/tabs/:id`

Closes a tab by its ID.

**Path parameters:**

| Parameter | Type     | Description           |
| --------- | -------- | --------------------- |
| `id`      | `string` | Tab ID to close       |

**Constraints:** The Aria tab (`isAria: true`) cannot be closed — returns `400`.

**Response:**

```json
{ "success": true }
```

**Example:**

```bash
tap -X DELETE http://127.0.0.1:18901/api/tabs/tab-3
```

---

### `POST /api/tabs/:id/activate`

Brings a tab into focus (makes it the active tab).

**Path parameters:**

| Parameter | Type     | Description              |
| --------- | -------- | ------------------------ |
| `id`      | `string` | Tab ID to activate       |

**Response:**

```json
{
  "success": true,
  "tab": { "id": "tab-1", "title": "Google", "index": 0 }
}
```

**Example:**

```bash
tap -X POST http://127.0.0.1:18901/api/tabs/tab-1/activate
```

---

### `POST /api/tabs/:id/navigate`

Navigates a specific tab to a URL.

**Path parameters:**

| Parameter | Type     | Description          |
| --------- | -------- | -------------------- |
| `id`      | `string` | Tab ID to navigate   |

**Request body:**

| Field | Type     | Required | Description      |
| ----- | -------- | -------- | ---------------- |
| `url` | `string` | **Yes**  | Destination URL  |

**Response:**

```json
{ "success": true }
```

**Example:**

```bash
tap -X POST http://127.0.0.1:18901/api/tabs/tab-1/navigate \
  -H "Content-Type: application/json" \
  -d '{"url":"https://news.ycombinator.com"}'
```

---

## Page Interaction

All page interaction endpoints operate on a specific tab identified by `:id`. Use `GET /api/status` to find `activeTabId`, or `GET /api/tabs` to enumerate all tab IDs.

---

### `GET /api/tabs/:id/elements`

Indexes all interactive elements on the page and returns a numbered list. Each element gets an index number used by `/click` and `/type`.

**Path parameters:**

| Parameter | Type     | Description  |
| --------- | -------- | ------------ |
| `id`      | `string` | Tab ID       |

**Query parameters:**

| Parameter | Type     | Required | Description                                   |
| --------- | -------- | -------- | --------------------------------------------- |
| `grep`    | `string` | No       | Filter elements by text match (case-insensitive) |

**Response:**

```json
{
  "result": "0 [button] Sign in\n1 [input] Search\n2 [a] About\n..."
}
```

**Example:**

```bash
# All elements
tap "http://127.0.0.1:18901/api/tabs/tab-1/elements"

# Only elements matching "sign"
tap "http://127.0.0.1:18901/api/tabs/tab-1/elements?grep=sign"
```

---

### `POST /api/tabs/:id/click`

Clicks an element by its index (from `/elements`).

**Path parameters:**

| Parameter | Type     | Description  |
| --------- | -------- | ------------ |
| `id`      | `string` | Tab ID       |

**Request body:**

| Field   | Type     | Required | Description                    |
| ------- | -------- | -------- | ------------------------------ |
| `index` | `number` | **Yes**  | Element index from `/elements` |

**Response:**

```json
{ "result": "Clicked element 0" }
```

**Example:**

```bash
tap -X POST http://127.0.0.1:18901/api/tabs/tab-1/click \
  -H "Content-Type: application/json" \
  -d '{"index": 0}'
```

---

### `POST /api/tabs/:id/type`

Types text into an element (clears and types).

**Path parameters:**

| Parameter | Type     | Description  |
| --------- | -------- | ------------ |
| `id`      | `string` | Tab ID       |

**Request body:**

| Field   | Type     | Required | Description                    |
| ------- | -------- | -------- | ------------------------------ |
| `index` | `number` | **Yes**  | Element index from `/elements` |
| `text`  | `string` | **Yes**  | Text to type into the element  |

**Response:**

```json
{ "result": "Typed into element 1" }
```

**Example:**

```bash
tap -X POST http://127.0.0.1:18901/api/tabs/tab-1/type \
  -H "Content-Type: application/json" \
  -d '{"index": 1, "text": "hello world"}'
```

---

### `POST /api/tabs/:id/paste`

Pastes text into an element (uses clipboard-style insertion, suitable for long text or content with special characters).

**Path parameters:**

| Parameter | Type     | Description  |
| --------- | -------- | ------------ |
| `id`      | `string` | Tab ID       |

**Request body:**

| Field   | Type     | Required | Description                             |
| ------- | -------- | -------- | --------------------------------------- |
| `index` | `number` | **Yes**  | Element index from `/elements`          |
| `text`  | `string` | **Yes**  | Text to paste (supports long content)   |

**Response:**

```json
{ "result": "Pasted into element 1" }
```

**Example:**

```bash
tap -X POST http://127.0.0.1:18901/api/tabs/tab-1/paste \
  -H "Content-Type: application/json" \
  -d '{"index": 1, "text": "A long paragraph of text..."}'
```

---

### `GET /api/tabs/:id/text`

Extracts the visible text content of the current page.

**Path parameters:**

| Parameter | Type     | Description  |
| --------- | -------- | ------------ |
| `id`      | `string` | Tab ID       |

**Query parameters:**

| Parameter | Type     | Required | Description                          |
| --------- | -------- | -------- | ------------------------------------ |
| `grep`    | `string` | No       | Filter lines containing this string  |

**Response:**

```json
{ "result": "Hacker News\nTop | New | Ask | Show | Jobs | Submit\n..." }
```

**Example:**

```bash
# Full page text
tap "http://127.0.0.1:18901/api/tabs/tab-1/text"

# Only lines containing "price"
tap "http://127.0.0.1:18901/api/tabs/tab-1/text?grep=price"
```

---

### `GET /api/tabs/:id/screenshot`

Captures a screenshot of the tab's current content.

**Path parameters:**

| Parameter | Type     | Description  |
| --------- | -------- | ------------ |
| `id`      | `string` | Tab ID       |

**Response:**

```json
{ "result": "<base64-encoded PNG or file path>" }
```

**Example:**

```bash
tap "http://127.0.0.1:18901/api/tabs/tab-1/screenshot" | jq -r '.result' > screenshot.png
```

---

### `POST /api/tabs/:id/click-xy`

Clicks at specific pixel coordinates within the tab.

**Path parameters:**

| Parameter | Type     | Description  |
| --------- | -------- | ------------ |
| `id`      | `string` | Tab ID       |

**Request body:**

| Field | Type     | Required | Description              |
| ----- | -------- | -------- | ------------------------ |
| `x`   | `number` | **Yes**  | X coordinate in pixels   |
| `y`   | `number` | **Yes**  | Y coordinate in pixels   |

**Response:**

```json
{ "result": "Clicked at (320, 240)" }
```

**Example:**

```bash
tap -X POST http://127.0.0.1:18901/api/tabs/tab-1/click-xy \
  -H "Content-Type: application/json" \
  -d '{"x": 320, "y": 240}'
```

---

### `POST /api/tabs/:id/hover-xy`

Moves the mouse cursor to specific pixel coordinates (without clicking).

**Path parameters:**

| Parameter | Type     | Description  |
| --------- | -------- | ------------ |
| `id`      | `string` | Tab ID       |

**Request body:**

| Field | Type     | Required | Description              |
| ----- | -------- | -------- | ------------------------ |
| `x`   | `number` | **Yes**  | X coordinate in pixels   |
| `y`   | `number` | **Yes**  | Y coordinate in pixels   |

**Response:**

```json
{ "result": "Hovered at (320, 240)" }
```

**Example:**

```bash
tap -X POST http://127.0.0.1:18901/api/tabs/tab-1/hover-xy \
  -H "Content-Type: application/json" \
  -d '{"x": 320, "y": 240}'
```

---

### `POST /api/tabs/:id/scroll`

Scrolls the page in a given direction.

**Path parameters:**

| Parameter | Type     | Description  |
| --------- | -------- | ------------ |
| `id`      | `string` | Tab ID       |

**Request body:**

| Field       | Type     | Required | Description                                            |
| ----------- | -------- | -------- | ------------------------------------------------------ |
| `direction` | `string` | **Yes**  | `"up"`, `"down"`, `"top"`, or `"bottom"`               |
| `amount`    | `number` | No       | Pixel amount to scroll (direction `up`/`down` only)    |

**Response:**

```json
{ "result": "Scrolled down" }
```

**Example:**

```bash
# Scroll down 500 pixels
tap -X POST http://127.0.0.1:18901/api/tabs/tab-1/scroll \
  -H "Content-Type: application/json" \
  -d '{"direction": "down", "amount": 500}'

# Jump to bottom of page
tap -X POST http://127.0.0.1:18901/api/tabs/tab-1/scroll \
  -H "Content-Type: application/json" \
  -d '{"direction": "bottom"}'
```

---

### `POST /api/tabs/:id/keys`

Sends keyboard key(s) to the page (e.g. `Enter`, `Tab`, `Escape`, `Control+a`).

**Path parameters:**

| Parameter | Type     | Description  |
| --------- | -------- | ------------ |
| `id`      | `string` | Tab ID       |

**Request body:**

| Field  | Type     | Required | Description                                       |
| ------ | -------- | -------- | ------------------------------------------------- |
| `keys` | `string` | **Yes**  | Key or key combination (Electron accelerator syntax) |

**Response:**

```json
{ "result": "Sent keys: Return" }
```

**Example:**

```bash
# Press Enter
tap -X POST http://127.0.0.1:18901/api/tabs/tab-1/keys \
  -H "Content-Type: application/json" \
  -d '{"keys": "Return"}'

# Select all
tap -X POST http://127.0.0.1:18901/api/tabs/tab-1/keys \
  -H "Content-Type: application/json" \
  -d '{"keys": "Control+a"}'
```

---

### `POST /api/tabs/:id/eval`

Evaluates a JavaScript expression in the context of the tab's renderer process and returns the result.

**Path parameters:**

| Parameter | Type     | Description  |
| --------- | -------- | ------------ |
| `id`      | `string` | Tab ID       |

**Request body:**

| Field | Type     | Required | Description                          |
| ----- | -------- | -------- | ------------------------------------ |
| `js`  | `string` | **Yes**  | JavaScript expression to evaluate    |

**Response:**

```json
{ "result": "https://news.ycombinator.com/" }
```

**Example:**

```bash
# Get current URL via JS
tap -X POST http://127.0.0.1:18901/api/tabs/tab-1/eval \
  -H "Content-Type: application/json" \
  -d '{"js": "location.href"}'

# Count all links
tap -X POST http://127.0.0.1:18901/api/tabs/tab-1/eval \
  -H "Content-Type: application/json" \
  -d '{"js": "document.querySelectorAll(\"a\").length"}'
```

---

## Agent

The AI agent uses the configured LLM (set in Tappi Browser settings). An API key must be configured — if not, both endpoints return `400`.

See also: [SSE Streaming](./sse-streaming.md) for the streaming endpoint protocol.

---

### `POST /api/agent/ask`

Sends a message to the AI agent and waits for the full response (blocking). The agent can use browser tools autonomously before responding.

**Request body:**

| Field     | Type     | Required | Description               |
| --------- | -------- | -------- | ------------------------- |
| `message` | `string` | **Yes**  | The user message/task     |

**Response:**

```json
{ "response": "I navigated to GitHub and found 3 open issues matching your query..." }
```

**Timeout:** Automatically uses the configured `agentTimeoutMs` (default 600,000 ms / 10 minutes) plus a 10-second buffer.

**Example:**

```bash
tap -X POST http://127.0.0.1:18901/api/agent/ask \
  -H "Content-Type: application/json" \
  -d '{"message": "What is the top story on Hacker News right now?"}'
```

---

### `POST /api/agent/ask/stream`

Sends a message to the AI agent and streams the response as **Server-Sent Events** (SSE). Each event delivers a chunk of the agent's response as it is generated.

**Request body:**

| Field     | Type     | Required | Description           |
| --------- | -------- | -------- | --------------------- |
| `message` | `string` | **Yes**  | The user message/task |

**Response:** `Content-Type: text/event-stream` — see [SSE Streaming](./sse-streaming.md) for full protocol.

**Example:**

```bash
tap -X POST http://127.0.0.1:18901/api/agent/ask/stream \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"message": "Summarize the current page"}' \
  --no-buffer
```

---

## Browser

### `POST /api/browser/dark-mode`

Enables or disables dark mode for the browser.

**Request body:**

| Field     | Type      | Required | Description                   |
| --------- | --------- | -------- | ----------------------------- |
| `enabled` | `boolean` | **Yes**  | `true` to enable, `false` to disable |

**Response:**

```json
{ "result": "Dark mode enabled" }
```

**Example:**

```bash
# Enable dark mode
tap -X POST http://127.0.0.1:18901/api/browser/dark-mode \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'

# Disable dark mode
tap -X POST http://127.0.0.1:18901/api/browser/dark-mode \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

---

### `GET /api/browser/cookies`

Lists browser cookies, optionally filtered by domain.

**Query parameters:**

| Parameter | Type     | Required | Description                             |
| --------- | -------- | -------- | --------------------------------------- |
| `domain`  | `string` | No       | Filter cookies to this domain           |

**Response:**

```json
{ "result": "name=session_id; domain=.example.com; path=/\n..." }
```

**Example:**

```bash
# All cookies
tap "http://127.0.0.1:18901/api/browser/cookies"

# Cookies for a specific domain
tap "http://127.0.0.1:18901/api/browser/cookies?domain=github.com"
```

---

### `DELETE /api/browser/cookies`

Deletes cookies. Clears all cookies or only those for a specific domain.

**Request body:**

| Field    | Type     | Required | Description                                          |
| -------- | -------- | -------- | ---------------------------------------------------- |
| `domain` | `string` | No       | Domain to clear cookies for. Omit (or `"all"`) to clear all |

**Response:**

```json
{ "result": "Cookies deleted for github.com" }
```

**Example:**

```bash
# Clear all cookies
tap -X DELETE http://127.0.0.1:18901/api/browser/cookies \
  -H "Content-Type: application/json" \
  -d '{}'

# Clear cookies for one domain
tap -X DELETE http://127.0.0.1:18901/api/browser/cookies \
  -H "Content-Type: application/json" \
  -d '{"domain": "github.com"}'
```

---

### `POST /api/browser/zoom`

Controls page zoom level.

**Request body:**

| Field    | Type     | Required | Description                                                  |
| -------- | -------- | -------- | ------------------------------------------------------------ |
| `action` | `string` | **Yes**  | `"in"`, `"out"`, `"reset"`, or a level string (e.g. `"150"`) |

**Response:**

```json
{ "result": "Zoom set to 150%" }
```

**Example:**

```bash
tap -X POST http://127.0.0.1:18901/api/browser/zoom \
  -H "Content-Type: application/json" \
  -d '{"action": "in"}'

tap -X POST http://127.0.0.1:18901/api/browser/zoom \
  -H "Content-Type: application/json" \
  -d '{"action": "reset"}'
```

---

### `POST /api/browser/find`

Triggers find-in-page for the active tab.

**Request body:**

| Field  | Type     | Required | Description         |
| ------ | -------- | -------- | ------------------- |
| `text` | `string` | No       | Text to search for  |

**Response:**

```json
{ "result": "Found 5 matches for \"error\"" }
```

**Example:**

```bash
tap -X POST http://127.0.0.1:18901/api/browser/find \
  -H "Content-Type: application/json" \
  -d '{"text": "error"}'
```

---

### `POST /api/browser/screenshot`

Captures a screenshot of the active tab or the full browser window.

**Request body:**

| Field    | Type     | Required | Description                                        |
| -------- | -------- | -------- | -------------------------------------------------- |
| `target` | `string` | No       | `"tab"` (default) or `"window"`                    |
| `format` | `string` | No       | `"png"` (default) or `"jpeg"`                      |
| `quality`| `number` | No       | JPEG quality 1–100 (only for `format: "jpeg"`)     |
| `saveTo` | `string` | No       | Absolute file path to save the screenshot to       |

**Response:**

```json
{
  "path": "/Users/you/Downloads/screenshot-2026-02-22.png",
  "width": 1440,
  "height": 900,
  "size": 284731
}
```

| Field    | Type     | Description                       |
| -------- | -------- | --------------------------------- |
| `path`   | `string` | Path where the screenshot was saved |
| `width`  | `number` | Image width in pixels             |
| `height` | `number` | Image height in pixels            |
| `size`   | `number` | File size in bytes                |

**Example:**

```bash
tap -X POST http://127.0.0.1:18901/api/browser/screenshot \
  -H "Content-Type: application/json" \
  -d '{"target": "tab", "format": "png"}'
```

---

### `POST /api/browser/record`

Controls screen recording (start, stop, or query status).

**Request body:**

| Field    | Type     | Required | Description                                  |
| -------- | -------- | -------- | -------------------------------------------- |
| `action` | `string` | **Yes**  | `"start"`, `"stop"`, or `"status"`           |

Additional fields may be passed depending on the action (forwarded to `captureTools.handleRecord`).

**Response:**

```json
{ "result": "Recording started" }
```

**Example:**

```bash
# Start recording
tap -X POST http://127.0.0.1:18901/api/browser/record \
  -H "Content-Type: application/json" \
  -d '{"action": "start"}'

# Stop recording
tap -X POST http://127.0.0.1:18901/api/browser/record \
  -H "Content-Type: application/json" \
  -d '{"action": "stop"}'

# Check status
tap -X POST http://127.0.0.1:18901/api/browser/record \
  -H "Content-Type: application/json" \
  -d '{"action": "status"}'
```

---

## Configuration

### `GET /api/config`

Returns the full current browser configuration. API keys are redacted (shown as `"••••••••"`).

**Parameters:** none

**Response:**

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-opus-4-6",
    "apiKey": "••••••••",
    "secondaryApiKey": "••••••••",
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

**Example:**

```bash
tap http://127.0.0.1:18901/api/config | jq '.llm | {provider, model}'
```

---

### `PATCH /api/config`

Updates one or more configuration values. Deep-merged into the existing config and persisted immediately.

**Request body:** A (potentially nested) JSON object containing only the fields to update.

**Response:**

```json
{ "success": true }
```

**Example:**

```bash
# Enable developer mode
tap -X PATCH http://127.0.0.1:18901/api/config \
  -H "Content-Type: application/json" \
  -d '{"developerMode": true}'

# Update LLM model
tap -X PATCH http://127.0.0.1:18901/api/config \
  -H "Content-Type: application/json" \
  -d '{"llm": {"model": "claude-3-5-sonnet-20241022"}}'
```

---

## Tools

### `GET /api/tools`

Lists all tools registered in the tool registry, including those conditionally available based on developer mode.

**Parameters:** none

**Response:** Array of tool descriptor objects.

```json
[
  { "name": "open_url",        "description": "Navigate the browser to a URL." },
  { "name": "page_elements",   "description": "Index interactive elements on the current page." },
  { "name": "page_click",      "description": "Click an element by index." },
  { "name": "page_type",       "description": "Type text into an element." },
  { "name": "page_text",       "description": "Extract visible text from the page." },
  { "name": "screenshot",      "description": "Capture a screenshot of the page." },
  { "name": "back_forward",    "description": "Navigate browser history." },
  { "name": "exec",            "description": "Execute a shell command. (developer mode only)" }
]
```

**Example:**

```bash
tap http://127.0.0.1:18901/api/tools | jq '.[].name'
```

---

### `POST /api/tools/:toolName`

Executes a registered tool by name, passing arbitrary parameters.

**Path parameters:**

| Parameter  | Type     | Description                                     |
| ---------- | -------- | ----------------------------------------------- |
| `toolName` | `string` | Name of the tool (from `GET /api/tools`)        |

**Request body:** JSON object with the tool's parameters (tool-specific — varies per tool).

**Response:**

```json
{ "result": "<tool output as string>" }
```

**Error (tool not found):**

```json
{ "error": "Tool \"bad_name\" not found. GET /api/tools for list." }
```

**Example:**

```bash
# Navigate the browser
tap -X POST http://127.0.0.1:18901/api/tools/open_url \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'

# Go back in history
tap -X POST http://127.0.0.1:18901/api/tools/back_forward \
  -H "Content-Type: application/json" \
  -d '{"direction": "back"}'

# Execute a shell command (developer mode required)
tap -X POST http://127.0.0.1:18901/api/tools/exec \
  -H "Content-Type: application/json" \
  -d '{"command": "ls ~/Desktop"}'
```

See [Tool Passthrough](./tool-passthrough.md) for detailed documentation of the tool execution model and common tool examples.

---

## Quick Reference Table

| Method   | Path                              | Description                        |
| -------- | --------------------------------- | ---------------------------------- |
| GET      | `/api/status`                     | Browser status + agent progress    |
| GET      | `/api/tabs`                       | List all tabs                      |
| POST     | `/api/tabs`                       | Create a new tab                   |
| DELETE   | `/api/tabs/:id`                   | Close a tab                        |
| POST     | `/api/tabs/:id/activate`          | Focus a tab                        |
| POST     | `/api/tabs/:id/navigate`          | Navigate tab to URL                |
| GET      | `/api/tabs/:id/elements`          | Index page elements                |
| POST     | `/api/tabs/:id/click`             | Click element by index             |
| POST     | `/api/tabs/:id/type`              | Type text into element             |
| POST     | `/api/tabs/:id/paste`             | Paste text into element            |
| GET      | `/api/tabs/:id/text`              | Extract page text                  |
| GET      | `/api/tabs/:id/screenshot`        | Screenshot of tab                  |
| POST     | `/api/tabs/:id/click-xy`          | Click at coordinates               |
| POST     | `/api/tabs/:id/hover-xy`          | Hover at coordinates               |
| POST     | `/api/tabs/:id/scroll`            | Scroll the page                    |
| POST     | `/api/tabs/:id/keys`              | Send keyboard keys                 |
| POST     | `/api/tabs/:id/eval`              | Evaluate JavaScript                |
| POST     | `/api/agent/ask`                  | Ask agent (blocking)               |
| POST     | `/api/agent/ask/stream`           | Ask agent (SSE streaming)          |
| POST     | `/api/browser/dark-mode`          | Toggle dark mode                   |
| GET      | `/api/browser/cookies`            | List cookies                       |
| DELETE   | `/api/browser/cookies`            | Delete cookies                     |
| POST     | `/api/browser/zoom`               | Set zoom level                     |
| POST     | `/api/browser/find`               | Find in page                       |
| POST     | `/api/browser/screenshot`         | Screenshot active tab/window       |
| POST     | `/api/browser/record`             | Control screen recording           |
| GET      | `/api/config`                     | Get configuration                  |
| PATCH    | `/api/config`                     | Update configuration               |
| GET      | `/api/tools`                      | List available tools               |
| POST     | `/api/tools/:toolName`            | Execute a tool                     |
