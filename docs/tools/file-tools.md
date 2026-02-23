# File Tools

Tools for reading, writing, and managing files in the workspace. Relative paths resolve to `~/tappi-workspace/` (created automatically on first use). Absolute paths pass through unchanged.

---

## `file_write`

Create or overwrite a file with the given content. Parent directories are created automatically.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | `string` | ✅ | File path. Relative paths resolve to `~/tappi-workspace/`. |
| `content` | `string` | ✅ | Full content to write to the file. |

### Returns

A confirmation string with the resolved path and file size.

```
Written: /Users/you/tappi-workspace/report.md (4.2KB)
```

### Example

```json
{
  "path": "report.md",
  "content": "# Weekly Report\n\nSummary of findings..."
}
```

---

## `file_read`

Read a file's contents. For files larger than ~80 KB (≈ 20K tokens), returns a summary with options instead of content. Use `grep`, `offset`, or `limit` params to efficiently handle large files without flooding context.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | `string` | ✅ | File path. |
| `grep` | `string` | ❌ | Search the file for this text — returns matching lines with ±2 lines of context. Recommended for large files. |
| `offset` | `number` | ❌ | Byte offset to start reading from. Useful for chunked reads by sub-agents. |
| `limit` | `number` | ❌ | Max bytes to read. Default/max is ~80 KB. |

### Returns

- **Small file (< 80 KB):** full file content as a string.
- **Large file:** a warning with file stats, a 5-line preview, and suggested next steps (`grep`, `offset/limit`, `file_head`, `file_tail`).
- **Grep mode:** matching lines prefixed with `>>>`, surrounded by context lines, with a total match count.

### Example — grep a large log

```json
{
  "path": "/var/log/app.log",
  "grep": "ERROR"
}
```

---

## `file_head`

Read the first N lines of a file. Useful for previewing structure without reading the whole file.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | `string` | ✅ | File path. |
| `lines` | `number` | ❌ | Number of lines to return (default: 20). |

### Returns

First N lines of the file as a string, with a trailing `... (X more lines)` note if the file is longer.

### Example

```json
{
  "path": "data.csv",
  "lines": 5
}
```

---

## `file_tail`

Read the last N lines of a file. Useful for checking recent log output or appended data.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | `string` | ✅ | File path. |
| `lines` | `number` | ❌ | Number of lines to return (default: 20). |

### Returns

Last N lines of the file as a string, with a `... (X lines above)` prefix if the file is longer.

### Example

```json
{
  "path": "server.log",
  "lines": 50
}
```

---

## `file_append`

Append content to an existing file. If the file doesn't exist, it will be created. A newline is automatically added after the appended content.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | `string` | ✅ | File path. |
| `content` | `string` | ✅ | Content to append. |

### Returns

Confirmation string with the resolved file path.

```
Appended to: /Users/you/tappi-workspace/notes.md
```

### Example

```json
{
  "path": "notes.md",
  "content": "\n## 2024-01-15\n\n- Reviewed PR #42"
}
```

---

## `file_delete`

Delete a file or directory. Directories are removed recursively.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | `string` | ✅ | Path to the file or directory to delete. |

### Returns

Confirmation of deletion, or an error if the path was not found.

```
Deleted: /Users/you/tappi-workspace/old-draft.txt
Deleted directory: /Users/you/tappi-workspace/tmp/
```

### Example

```json
{
  "path": "tmp/"
}
```

---

## `file_list`

List files and directories at a given path. Defaults to `~/tappi-workspace/` if no path is provided.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | `string` | ❌ | Directory path to list (default: `~/tappi-workspace/`). |

### Returns

A formatted directory listing with icons (`📁` for directories, `📄` for files with their size).

```
/Users/you/tappi-workspace/
📁 reports/
📄 notes.md (2.1KB)
📄 data.csv (18.4KB)
```

### Example

```json
{
  "path": "reports/"
}
```

---

## `file_copy`

Copy a file from one location to another. Destination parent directories are created automatically.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `source` | `string` | ✅ | Source file path. |
| `destination` | `string` | ✅ | Destination file path. |

### Returns

Confirmation with the resolved source and destination paths.

```
Copied: /Users/you/tappi-workspace/template.md → /Users/you/tappi-workspace/reports/report-jan.md
```

### Example

```json
{
  "source": "template.md",
  "destination": "reports/report-jan.md"
}
```

---

## `file_move`

Move or rename a file. Destination parent directories are created automatically.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `source` | `string` | ✅ | Source file path. |
| `destination` | `string` | ✅ | Destination file path. |

### Returns

Confirmation with the resolved source and destination paths.

```
Moved: /Users/you/tappi-workspace/draft.md → /Users/you/tappi-workspace/final.md
```

### Example

```json
{
  "source": "draft.md",
  "destination": "final.md"
}
```

---

## `file_grep`

Search a file for lines matching a text pattern (case-insensitive). Returns matching lines with line numbers and configurable surrounding context. Prefer this over reading an entire file when you know what you're looking for.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | `string` | ✅ | File path to search. |
| `grep` | `string` | ❌ | Text to search for (case-insensitive). Alias: `pattern`. At least one of `grep` or `pattern` is required. |
| `pattern` | `string` | ❌ | Alias for `grep`. |
| `context` | `number` | ❌ | Lines of context to show around each match (default: 1). |

### Returns

Match results with line numbers. Matching lines are prefixed with `>>>`, context lines with spaces. Results are capped at ~5,000 tokens.

```
/path/to/file.ts — 3 matches for "apiKey":
---
   42:   const config = {
>>> 43:     apiKey: process.env.API_KEY,
   44:   };
---
```

### Example

```json
{
  "path": "src/config.ts",
  "grep": "apiKey",
  "context": 2
}
```

---

## See Also

- [`exec`](./shell-tools.md#exec) — run shell commands to process files with CLI tools
- [`http_request`](./http-tools.md#http_request) — download files via HTTP with `saveToFile`
- [`browser_screenshot`](./capture-tools.md#browser_screenshot) — save screenshots to the workspace
