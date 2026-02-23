# Tappi Browser — SSE Agent Streaming

The agent streaming endpoint (`POST /api/agent/ask/stream`) delivers the AI agent's response as a **Server-Sent Events (SSE)** stream. This allows you to display the response incrementally — word by word — as the agent generates it, instead of waiting for the full response.

---

## Overview

| Property          | Value                              |
| ----------------- | ---------------------------------- |
| Endpoint          | `POST /api/agent/ask/stream`       |
| Response type     | `text/event-stream`                |
| Authentication    | Bearer token (same as all routes)  |
| Blocking behavior | Streams until agent is done        |
| Disconnect safety | Listener removed on client close   |

---

## Request

**Method:** `POST`  
**Path:** `/api/agent/ask/stream`  
**Content-Type:** `application/json`

**Request body:**

| Field     | Type     | Required | Description                        |
| --------- | -------- | -------- | ---------------------------------- |
| `message` | `string` | **Yes**  | The prompt/task for the AI agent   |

**Example:**

```bash
TOKEN=$(cat ~/.tappi-browser/api-token)

curl -s -N \
  -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"message": "What is the title of the current page?"}' \
  http://127.0.0.1:18901/api/agent/ask/stream
```

> **`-N` / `--no-buffer`** — required with curl to disable output buffering so chunks print as they arrive.

---

## Response Format

The response uses the standard SSE wire format: each event is prefixed with `data: ` and followed by `\n\n`.

```
data: {"text": "The current page", "done": false}\n\n
data: {"text": " is titled", "done": false}\n\n
data: {"text": " \"Hacker News\".", "done": false}\n\n
data: {"text": "", "done": true}\n\n
```

### Event Payload Schema

Each `data:` line contains a JSON object:

| Field  | Type      | Description                                                |
| ------ | --------- | ---------------------------------------------------------- |
| `text` | `string`  | Text chunk to append to the response                       |
| `done` | `boolean` | `true` on the final event; the stream closes immediately after |

### Stream Lifecycle

1. **Connection established** — HTTP `200` with `Content-Type: text/event-stream`
2. **Chunks arrive** — one or more `data:` events with `done: false`
3. **Stream ends** — a final `data:` event with `done: true`, then the server closes the response
4. **Client disconnects early** — the server removes its event listener, stopping agent output delivery (the agent itself may continue internally)

---

## Consuming the Stream

### Bash (curl + parse)

```bash
TOKEN=$(cat ~/.tappi-browser/api-token)

curl -s -N \
  -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Summarize the page"}' \
  http://127.0.0.1:18901/api/agent/ask/stream \
| while IFS= read -r line; do
    if [[ "$line" == data:* ]]; then
      payload="${line#data: }"
      text=$(echo "$payload" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['text'], end='')")
      printf "%s" "$text"
      done=$(echo "$payload" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['done'])")
      if [[ "$done" == "True" ]]; then
        echo
        break
      fi
    fi
  done
```

### Node.js (http module)

```js
const http = require('http');
const fs   = require('fs');

const token = fs.readFileSync(
  `${process.env.HOME}/.tappi-browser/api-token`, 'utf-8'
).trim();

const body = JSON.stringify({ message: 'What is the top HN story?' });

const req = http.request({
  method:  'POST',
  host:    '127.0.0.1',
  port:    18901,
  path:    '/api/agent/ask/stream',
  headers: {
    'Authorization':  `Bearer ${token}`,
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Accept':         'text/event-stream',
  },
}, (res) => {
  let buf = '';

  res.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() || '';                 // keep incomplete line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const { text, done } = JSON.parse(line.slice(6));
        process.stdout.write(text);
        if (done) process.stdout.write('\n');
      } catch {}
    }
  });

  res.on('end', () => process.exit(0));
});

req.write(body);
req.end();
```

### Python (requests + sseclient)

```python
import requests, json, os

token = open(os.path.expanduser('~/.tappi-browser/api-token')).read().strip()

with requests.post(
    'http://127.0.0.1:18901/api/agent/ask/stream',
    headers={
        'Authorization': f'Bearer {token}',
        'Accept': 'text/event-stream',
    },
    json={'message': 'What is on this page?'},
    stream=True,
) as resp:
    for line in resp.iter_lines():
        if line and line.startswith(b'data: '):
            payload = json.loads(line[6:])
            print(payload['text'], end='', flush=True)
            if payload['done']:
                print()
                break
```

### Browser JavaScript (EventSource — not applicable here)

> **Note:** The native `EventSource` API only supports `GET` requests. Because this endpoint is `POST`, use `fetch` with `ReadableStream` in browser contexts:

```js
const token = '<your-token>';

const resp = await fetch('http://127.0.0.1:18901/api/agent/ask/stream', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ message: 'Hello, agent!' }),
});

const reader = resp.body.getReader();
const decoder = new TextDecoder();
let buf = '';

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const lines = buf.split('\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const { text, done: agentDone } = JSON.parse(line.slice(6));
    process.stdout.write(text);   // or append to DOM
    if (agentDone) return;
  }
}
```

---

## Error Handling

If the agent fails after the stream has begun, the server sends a final error chunk and closes:

```
data: {"text": "❌ Something went wrong: <error message>", "done": true}\n\n
```

If configuration is invalid **before** the stream starts (e.g. no API key), the server returns a normal JSON error response instead of an SSE stream:

```json
HTTP 400
{ "error": "No API key configured in Tappi Browser settings" }
```

Always check the HTTP status code before entering SSE parsing.

---

## Comparison: Streaming vs Blocking

| Feature               | `POST /api/agent/ask`          | `POST /api/agent/ask/stream`        |
| --------------------- | ------------------------------ | ----------------------------------- |
| Response type         | `application/json`             | `text/event-stream`                 |
| When response arrives | After agent fully completes    | Incrementally as agent generates    |
| Timeout behaviour     | Returns partial if timeout     | Stream stays open until done/close  |
| UI indicator chunks   | Filtered out (`🧠 Analyzing…`) | All chunks passed through raw       |
| Best for              | Scripts, pipelines, `--json`   | Interactive terminals, UI display   |

> **Tip:** The [`tappi-browser ask --stream`](../cli/commands.md#ask) CLI command uses this endpoint internally.

---

## See Also

- [Endpoints Reference — Agent section](./endpoints.md#agent)
- [CLI `ask` command](../cli/commands.md#ask)
- [Tool Passthrough](./tool-passthrough.md)
