# HTTP Tools

Tools for making HTTP requests, managing API keys, and registering API services. All requests originate from the user's machine — no proxy involved.

---

## `http_request`

Make an HTTP request with support for all standard methods, headers, JSON bodies, authentication, and binary file saving.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `url` | `string` | ✅ | Full request URL. |
| `method` | `string` | ❌ | HTTP method: `GET`, `POST`, `PUT`, `PATCH`, `DELETE` (default: `GET`). |
| `body` | `string` | ❌ | Raw request body string (e.g. form-encoded data). |
| `jsonBody` | `string` | ❌ | JSON body as a string — will be parsed and sent with `Content-Type: application/json`. |
| `auth` | `string` | ❌ | `"@service"` to auto-resolve a stored API key (e.g. `"@openai"`), or a raw value like `"Bearer sk-..."`. |
| `saveToFile` | `string` | ❌ | File path to save a binary response (e.g. for images, PDFs). |
| `timeout` | `number` | ❌ | Request timeout in milliseconds (default: 30 000). |

### Auth Resolution

When `auth` starts with `@`, Tappi looks up the stored API key for that service and builds the `Authorization` header automatically using the service's configured `authHeader` prefix (e.g. `Bearer sk-...`). Use [`api_key_store`](#api_key_store) and [`register_api_service`](#register_api_service) to configure services.

### Returns

A compact summary with status, timing, size, and a 500-character preview of the response body. The full response is saved to a temp file and the path is included so you can use [`file_read`](./file-tools.md#file_read) for large payloads.

```
200 OK (312ms, 4.1KB)
Response saved: /Users/you/.tappi-browser/api-responses/resp-1705000000.json
Type: JSON | Size: 4.1KB
Preview (first 500 chars):
{"id":"chatcmpl-abc","object":"chat.completion",...}
Top-level keys: id, object, created, model, choices, usage
```

### Example — POST to OpenAI with stored key

```json
{
  "url": "https://api.openai.com/v1/chat/completions",
  "method": "POST",
  "auth": "@openai",
  "jsonBody": "{\"model\":\"gpt-4o\",\"messages\":[{\"role\":\"user\",\"content\":\"Hello!\"}]}"
}
```

### Example — Download a file

```json
{
  "url": "https://example.com/report.pdf",
  "saveToFile": "~/tappi-workspace/report.pdf"
}
```

---

## `api_key_store`

Store an API key securely. Keys are encrypted using Electron's `safeStorage` (OS keychain-backed AES) and stored per-profile.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `service` | `string` | ✅ | Service name (e.g. `"openai"`, `"github"`). Case-sensitive. |
| `key` | `string` | ✅ | The API key to store. |

### Returns

```
API key stored for "openai" (encrypted)
```

### Example

```json
{
  "service": "openai",
  "key": "sk-proj-..."
}
```

---

## `api_key_list`

List the names of all services that have a stored API key. Does not reveal the key values.

### Parameters

None.

### Returns

```
Stored API keys:
  • openai
  • github
  • stripe
```

Or `No API keys stored.` if the vault is empty.

### Example

```json
{}
```

---

## `api_key_delete`

Delete a stored API key for a given service. Does not affect the service registration (use `register_api_service` separately).

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `service` | `string` | ✅ | Service name whose key should be deleted. |

### Returns

```
API key deleted for "stripe"
```

Or an error if no key was found for that service.

### Example

```json
{
  "service": "stripe"
}
```

---

## `register_api_service`

> **Registered name in tool-registry:** `register_api`

Register an API service with its base URL, auth style, and description. Once registered, the service appears in your context every turn so you always know it exists. Pair with [`api_key_store`](#api_key_store) to make it fully usable.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | `string` | ✅ | Short service name used as a key (e.g. `"openai"`, `"stripe"`). |
| `baseUrl` | `string` | ✅ | API base URL (e.g. `"https://api.openai.com/v1"`). |
| `authHeader` | `string` | ❌ | Authorization prefix: `"Bearer"` (default), `"Basic"`, `"token"`, or custom. |
| `description` | `string` | ✅ | Human-readable description (e.g. `"OpenAI — GPT, DALL-E, Whisper"`). |
| `endpoints` | `string[]` | ❌ | List of key endpoint paths for quick reference. |

### Returns

```
API service "openai" registered: https://api.openai.com/v1 — OpenAI — GPT, DALL-E, Whisper
```

### Example

```json
{
  "name": "openai",
  "baseUrl": "https://api.openai.com/v1",
  "authHeader": "Bearer",
  "description": "OpenAI — GPT, DALL-E, Whisper, embeddings",
  "endpoints": ["/chat/completions", "/images/generations", "/embeddings"]
}
```

---

## See Also

- [`file_read`](./file-tools.md#file_read) — read the full response body saved by `http_request`
- [`file_write`](./file-tools.md#file_write) — write data you build from API responses to disk
- [`exec`](./shell-tools.md#exec) — run `curl` or other CLI HTTP tools when needed
