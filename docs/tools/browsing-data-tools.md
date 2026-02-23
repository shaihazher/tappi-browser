# Browsing Data Tools

Tools for querying the browser's navigation history, bookmarks, and download records. All data is stored in SQLite at `~/.tappi-browser/tappi.db`.

> **Privacy gate:** These tools are only available when **Agent Browsing Data Access** is enabled in Settings. When disabled, the tool schemas are not sent to the model.

---

## `browse_history`

Search and filter browser navigation history. Supports text search, domain filtering, date ranges, visit frequency sorting, and result limits.

> **Tool name in registry:** `browsing_history` (action: `recent` or `search`)

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | `"recent" \| "search" \| "clear"` | ✅ | `recent` — return latest entries; `search` — filter by params; `clear` — delete history (not covered here). |
| `grep` | `string` | ❌ | Case-insensitive filter on URL and title. |
| `query` | `string` | ❌ | Alias for `grep`. |
| `domain` | `string` | ❌ | Filter by exact domain (e.g. `"github.com"`). Case-insensitive. |
| `since` | `string` | ❌ | ISO 8601 date — only entries after this date/time. |
| `sort` | `"recent" \| "frequent"` | ❌ | Sort order: `recent` (default — newest first) or `frequent` (most visited first). |
| `limit` | `number` | ❌ | Maximum results to return (default: 50). |

### Returns

A formatted list of history entries with visit time, visit count, title, and URL.

```
[2024-01-15T09:12:00.000Z] (×5) Tappi Browser – GitHub
  https://github.com/shaihazher/tappi-browser

[2024-01-15T08:47:00.000Z] (×1) Railway Dashboard
  https://railway.app/dashboard
```

Or `No history entries found.`

### Example — find all GitHub visits

```json
{
  "action": "search",
  "domain": "github.com",
  "sort": "frequent",
  "limit": 20
}
```

### Example — search by keyword

```json
{
  "action": "search",
  "grep": "railway deploy"
}
```

### Example — recent history

```json
{
  "action": "recent",
  "limit": 10
}
```

---

## `browse_bookmarks`

Search and filter saved bookmarks. Supports text search, folder filtering, and multiple sort orders.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `grep` | `string` | ❌ | Case-insensitive search in bookmark title or URL. |
| `folder` | `string` | ❌ | Filter by exact folder name (case-insensitive). |
| `sort` | `"recent" \| "alpha" \| "frequent"` | ❌ | Sort order: `recent` (default — newest first), `alpha` (alphabetical by title), `frequent` (most visited first). |
| `limit` | `number` | ❌ | Maximum results to return (default: 50). |

### Returns

A formatted list of bookmarks with title, folder, visit count, URL, and save date.

```
Tappi Browser – GitHub [dev] (×12)
  https://github.com/shaihazher/tappi-browser
  Saved: 2024-01-10T14:22:00.000Z

Railway Dashboard (×3)
  https://railway.app/dashboard
  Saved: 2024-01-12T09:05:00.000Z
```

Or `No bookmarks found.`

### Example — find bookmarks in a folder

```json
{
  "folder": "dev",
  "sort": "alpha"
}
```

### Example — search by keyword

```json
{
  "grep": "vercel",
  "limit": 5
}
```

---

## `browse_downloads`

Query the download history. Supports text search (filename/URL), date filtering, and file type filtering.

> **Tool name in registry:** `downloads` (action: `list`)

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `grep` | `string` | ❌ | Case-insensitive search in filename or source URL. |
| `since` | `string` | ❌ | ISO 8601 date — only downloads after this date. |
| `type` | `string` | ❌ | Filter by file extension (e.g. `"pdf"` or `".pdf"`). |
| `limit` | `number` | ❌ | Maximum results to return (default: 50). |

### Returns

A formatted list of download records with filename, source URL, file size, save path, date, and status.

```
report-q4.pdf
  From: https://example.com/reports/q4.pdf
  Path: /Users/you/Downloads/report-q4.pdf
  Size: 2.1MB | Downloaded: 2024-01-14T16:30:00.000Z | Status: completed

tappi-v1.0.0.dmg
  From: https://github.com/releases/tappi-v1.0.0.dmg
  Path: /Users/you/Downloads/tappi-v1.0.0.dmg
  Size: 84.3MB | Downloaded: 2024-01-10T11:15:00.000Z | Status: completed
```

Or `No downloads found.`

### Example — find PDF downloads

```json
{
  "type": "pdf",
  "limit": 10
}
```

### Example — find recent downloads from GitHub

```json
{
  "grep": "github.com",
  "since": "2024-01-01"
}
```

---

## Database Schema

The underlying SQLite tables for reference:

| Table | Key columns |
|-------|-------------|
| `history` | `url`, `title`, `domain`, `visit_time` (ms epoch), `visit_count` |
| `bookmarks` | `url`, `title`, `folder`, `created_at` (ms epoch), `visit_count` |
| `downloads` | `filename`, `url`, `path`, `size`, `created_at` (ISO string), `status` |

---

## See Also

- [`conversations_search`](./conversation-tools.md#conversations_search) — search Aria conversation history (not browser navigation)
- [`file_list`](./file-tools.md#file_list) — list files in the workspace or Downloads folder
- [`http_request`](./http-tools.md#http_request) — make new requests; `saveToFile` to re-download something
