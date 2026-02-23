# Tappi Browser — API Overview

Tappi Browser exposes a **local HTTP REST API** that allows external programs, scripts, and the bundled CLI to control the browser programmatically. The API is the backbone of every [`tappi-browser` CLI command](../cli/commands.md) and can be consumed by any HTTP client.

---

## What the API Does

The API gives full programmatic access to:

- **Tab lifecycle** — create, close, list, activate tabs
- **Page interaction** — click, type, scroll, eval JS, extract text/elements, take screenshots
- **AI agent** — send messages to the built-in agent, receive responses (blocking or streaming SSE)
- **Tool passthrough** — invoke any registered browser tool by name
- **Browser controls** — dark mode, zoom, find-in-page, cookie management, screen recording
- **Configuration** — read and update all browser settings at runtime

---

## How to Enable the API Server

The API server starts automatically when Tappi Browser launches. It always binds to `127.0.0.1:18901` (loopback only). You do not need to do anything special to enable it — if the browser is running, the API is available.

> **Developer Mode** unlocks additional tools (e.g. shell `exec`) exposed via the tool-passthrough endpoint. Toggle it in the browser's settings UI or via `PATCH /api/config`.

---

## Base URL and Port

```
http://127.0.0.1:18901
```

| Constant       | Value                          |
| -------------- | ------------------------------ |
| Host           | `127.0.0.1` (localhost only)   |
| Port           | `18901`                        |
| Scheme         | `http` (plain HTTP, no TLS)    |
| Path prefix    | `/api`                         |

All endpoints are prefixed with `/api`. Example:

```
http://127.0.0.1:18901/api/status
http://127.0.0.1:18901/api/tabs
http://127.0.0.1:18901/api/agent/ask
```

---

## Security Model

### Localhost-Only Binding

The server **only** binds to `127.0.0.1`. It is not reachable from external networks, other machines on a LAN, or over the internet. This is enforced at the OS socket level — no firewall rule needed.

### Bearer Token Authentication

Every request (except nothing — all routes require auth) must include a `Bearer` token in the `Authorization` header:

```
Authorization: Bearer <token>
```

The token is a **64-character hex string** (32 random bytes) generated on first launch and stored at:

```
~/.tappi-browser/api-token
```

The file is written with mode `0600` (owner read/write only). The token persists across browser restarts.

**Reading the token:**

```bash
cat ~/.tappi-browser/api-token
```

**Using it in curl:**

```bash
TOKEN=$(cat ~/.tappi-browser/api-token)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:18901/api/status
```

Requests with a missing or incorrect token receive:

```json
HTTP 401
{ "error": "Unauthorized: invalid or missing Bearer token" }
```

### Rate Limiting

The API enforces a rate limit of **100 requests per minute** per IP address. Exceeding the limit returns:

```json
HTTP 429
{ "error": "Rate limit exceeded: 100 req/min" }
```

The rate window resets every 60 seconds. Stale rate entries are garbage-collected every 5 minutes.

---

## Request / Response Format

- All request bodies must be **JSON** (`Content-Type: application/json`).
- All responses are **JSON** unless the endpoint uses SSE streaming (see [`sse-streaming.md`](./sse-streaming.md)).
- Errors always return `{ "error": "<message>" }` with an appropriate HTTP status code.
- The maximum request body size is **1 MB**.

---

## Error Codes

| HTTP Status | Meaning                                         |
| ----------- | ----------------------------------------------- |
| `200`       | Success                                         |
| `400`       | Bad request — missing or invalid parameters     |
| `401`       | Unauthorized — missing or wrong Bearer token    |
| `404`       | Resource not found (tab ID, route, tool name)   |
| `429`       | Rate limit exceeded                             |
| `500`       | Internal server error                           |

---

## Further Reading

- [Endpoints Reference](./endpoints.md) — every route documented
- [SSE Streaming](./sse-streaming.md) — real-time agent response streaming
- [Tool Passthrough](./tool-passthrough.md) — invoking registered tools via the API
- [CLI Overview](../cli/overview.md) — command-line interface that wraps this API
