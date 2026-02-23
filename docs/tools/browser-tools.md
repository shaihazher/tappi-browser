# Browser Tools

Browser tools operate on the browser itself — navigation, tabs, cookies, zoom, dark mode, printing, and browsing data. Unlike page tools (which inject JS into the page), browser tools use Electron APIs directly.

---

## `navigate`

Navigate the current tab to a URL.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | URL to navigate to |

**Returns:** Confirmation or error.

**Example:**
```
navigate({ url: "https://github.com" })
navigate({ url: "https://docs.example.com/api" })
```

---

## `search`

Search the web using the browser's configured search engine.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query |

**Returns:** Confirmation string (navigation triggered to search results).

**Example:**
```
search({ query: "Electron IPC documentation" })
```

---

## `back_forward`

Go back or forward in browser navigation history.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `direction` | `"back"` \| `"forward"` | Yes | Navigation direction |

**Returns:** Confirmation or error.

**Example:**
```
back_forward({ direction: "back" })
back_forward({ direction: "forward" })
```

---

## `dark_mode`

Toggle CSS dark mode on the current page.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mode` | `"on"` \| `"off"` | Yes | Enable or disable dark mode |

**Returns:** Confirmation string.

**Notes:** Injects a CSS stylesheet that overrides background colors, text colors, input styles, scrollbars, and links. Does not invert images, videos, or canvases. The CSS key is tracked per tab and removed on `off`.

**Example:**
```
dark_mode({ mode: "on" })
dark_mode({ mode: "off" })
```

---

## `cookies`

List or delete browser cookies.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | `"list"` \| `"delete"` | Yes | Action to perform |
| `domain` | string | No | Domain to filter or delete (use `"all"` to delete all) |

**Returns:** Cookie list (for `list`) or confirmation (for `delete`).

**Example:**
```
cookies({ action: "list" })
cookies({ action: "list", domain: "github.com" })
cookies({ action: "delete", domain: "github.com" })
cookies({ action: "delete", domain: "all" })
```

---

## `tab`

Tab management — switch, list, close, mute, pin, duplicate, and batch-close tabs.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | `"switch"` \| `"list"` \| `"close"` \| `"mute"` \| `"pin"` \| `"duplicate"` \| `"others"` \| `"right"` | Yes | Tab action |
| `index` | number \| string | No | Tab index (0-based) or tab ID — required for `switch` |

**Returns:** Tab list (for `list`) or confirmation string.

**Actions:**
| Action | Effect |
|--------|--------|
| `switch` | Switch to tab at `index` |
| `list` | List all open tabs with URLs and titles |
| `close` | Close tab at `index` (or current tab if omitted) |
| `mute` | Toggle mute on tab at `index` |
| `pin` | Toggle pin on tab at `index` |
| `duplicate` | Duplicate tab at `index` |
| `others` | Close all tabs except current |
| `right` | Close all tabs to the right of current |

**Example:**
```
tab({ action: "list" })
tab({ action: "switch", index: 2 })
tab({ action: "close", index: 3 })
tab({ action: "mute", index: 0 })
tab({ action: "duplicate" })
```

---

## `bookmark`

Toggle a bookmark on the current page.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | — | — | — |

**Returns:** Confirmation (bookmarked or removed).

**Example:**
```
bookmark({})
```

---

## `zoom`

Zoom the page in, out, or to a specific percentage.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `level` | string \| number | No | `"in"` \| `"out"` \| `"reset"` \| percentage (e.g. `150` or `"150"`) |
| `action` | string \| number | No | Alias for `level` — either parameter is accepted |

**Returns:** Confirmation string showing the new zoom level.

**Example:**
```
zoom({ level: "in" })
zoom({ level: "reset" })
zoom({ level: 150 })       // 150%
zoom({ action: "out" })
```

**Notes:** `level` and `action` are interchangeable — the tool accepts either to handle LLM parameter variation.

---

## `find`

Find text on the current page (browser find bar).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | No | Text to find |
| `text` | string | No | Alias for `query` — either parameter is accepted |

**Returns:** Confirmation or match count.

**Notes:** Pass an empty string (or omit both parameters) to clear the find bar. `query` and `text` are interchangeable.

**Example:**
```
find({ query: "authentication" })
find({ text: "TODO" })
find({ query: "" })    // clear
```

---

## `print_pdf`

Print the current page or save it as a PDF.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `format` | `"print"` \| `"pdf"` | No | Output type: `"pdf"` (default) or `"print"` (opens dialog) |
| `filePath` | string | No | File path to save PDF |
| `path` | string | No | Alias for `filePath` |
| `saveTo` | string | No | Alias for `filePath` |

**Returns:** File path of saved PDF, or confirmation that print dialog was opened.

**Notes:** Provide any of `filePath`, `path`, or `saveTo` for silent PDF save. Omit all three to open the system print dialog. Any of the three path aliases resolves correctly.

**Example:**
```
print_pdf({ filePath: "~/Desktop/report.pdf" })
print_pdf({ saveTo: "~/tappi-workspace/page.pdf" })
print_pdf({ format: "print" })    // opens print dialog
```

---

## `ad_blocker`

Toggle the ad blocker or add a site exception.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | `"on"` \| `"off"` \| `"enable"` \| `"disable"` \| `"status"` \| `"exception"` | Yes | Action to perform |
| `domain` | string | No | Domain for site exception |

**Returns:** Confirmation or status string.

**Notes:** `enable` and `disable` are aliases for `on` and `off`. Use `exception` with `domain` to whitelist a specific site.

**Example:**
```
ad_blocker({ action: "on" })
ad_blocker({ action: "status" })
ad_blocker({ action: "exception", domain: "example.com" })
```

---

## `browsing_history`

Search, filter, or clear the browser navigation history.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | `"recent"` \| `"search"` \| `"clear"` | Yes | Action: `recent` (latest entries), `search` (filter), `clear` (erase) |
| `query` | string | No | Search query for URL/title |
| `grep` | string | No | Case-insensitive filter on title or URL |
| `domain` | string | No | Filter by domain (e.g. `"github.com"`) |
| `since` | string | No | ISO date — only entries after this date |
| `sort` | `"recent"` \| `"frequent"` | No | Sort by recency (default) or visit frequency |
| `limit` | number | No | Max results (default: 50) |

**Returns:** Formatted list of history entries with timestamps, visit counts, and URLs. Or confirmation for `clear`.

**Example:**
```
browsing_history({ action: "recent", limit: 10 })
browsing_history({ action: "search", grep: "github", domain: "github.com" })
browsing_history({ action: "clear", query: "today" })
```

---

## `browse_bookmarks`

Search and filter bookmarks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `grep` | string | No | Case-insensitive search in title or URL |
| `folder` | string | No | Filter by folder name |
| `sort` | `"recent"` \| `"alpha"` \| `"frequent"` | No | Sort order (default: `recent`) |
| `limit` | number | No | Max results (default: 50) |

**Returns:** Formatted list of bookmarks with titles, folders, visit counts, URLs, and save dates.

**Example:**
```
browse_bookmarks({ grep: "documentation" })
browse_bookmarks({ folder: "Dev Tools", sort: "alpha" })
```

---

## `downloads`

Check download status, cancel active downloads, or clear completed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | `"list"` \| `"cancel"` \| `"clear"` | No | Action (default: `list`) |
| `id` | string | No | Download ID to cancel |

**Returns:** Download list or confirmation string.

**Example:**
```
downloads({})                           // list all
downloads({ action: "cancel", id: "dl-3" })
downloads({ action: "clear" })          // clear completed
```

---

## `password_vault`

Manage saved passwords. The agent can list domains and credentials, trigger autofill, and generate passwords — but **never sees raw passwords**.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | `"list"` \| `"list_credentials"` \| `"autofill"` \| `"generate"` \| `"delete"` | Yes | Action to perform |
| `domain` | string | No | Domain for autofill or list_credentials |
| `username` | string | No | Specific username to autofill (omit to use first credential) |
| `id` | number | No | Credential ID to delete |
| `length` | number | No | Password length for generate (default: 20) |

**Actions:**

| Action | Effect |
|--------|--------|
| `list` | List all saved domains |
| `list_credentials` | List usernames for a domain (no passwords returned) |
| `autofill` | Fill login form on the current page |
| `generate` | Generate a secure random password |
| `delete` | Remove a saved credential by ID |

**Example:**
```
password_vault({ action: "list" })
password_vault({ action: "list_credentials", domain: "github.com" })
password_vault({ action: "autofill", domain: "github.com" })
password_vault({ action: "generate", length: 24 })
password_vault({ action: "delete", id: 3 })
```

---

## See Also

- [Page Tools](page-tools.md) — interact with page content
- [Browsing Data Tools](browsing-data-tools.md) — extended history/bookmark/download access (privacy-gated)
- [Capture Tools](capture-tools.md) — screenshots and recording
- [Tool Overview](overview.md)
