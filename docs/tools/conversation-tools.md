# Conversation Tools

Tools for listing, searching, and reading past Aria conversations stored in SQLite. Useful for recalling earlier findings, tool results, or instructions from previous sessions.

> **Tip:** For searching within the *current* session's scrolled-out history, use the `history` tool instead. These tools access the persistent cross-session conversation database.

---

## `conversations_list`

List recent Aria conversations with titles, dates, message counts, and a short preview. Use `grep` to filter by title or preview text.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `limit` | `number` | ❌ | Maximum number of conversations to return (default: 20, max: 50). |
| `grep` | `string` | ❌ | Case-insensitive filter applied to conversation titles and previews. |

### Returns

A formatted list of matching conversations, each with a short ID (first 8 chars of UUID), date, title, message count, and preview.

```
Conversations (3):
• [a1b2c3d4] 2024-01-15 | Research session (42 msgs) — "Find competitors for..."
• [e5f6g7h8] 2024-01-14 | (untitled) (7 msgs) — "How do I set up OAuth..."
• [i9j0k1l2] 2024-01-13 | Deployment notes (15 msgs) — "Deploy the API to Railway"

Use conversations_read({ conversation_id: "..." }) to read messages.
```

### Example — find conversations about a project

```json
{
  "limit": 10,
  "grep": "railway"
}
```

---

## `conversations_search`

Full-text search across all Aria conversation messages. Returns matching snippets with surrounding context (±2 messages). Uses SQLite FTS5 for fast full-text indexing, with a LIKE fallback for edge cases.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `grep` | `string` | ✅ | Text to search for across all conversation messages. |
| `conversation_id` | `string` | ❌ | Scope the search to a specific conversation ID (from `conversations_list`). |
| `limit` | `number` | ❌ | Maximum number of results to return (default: 20, max: 50). |

### Returns

Matching messages grouped by conversation, with `>>>` marking the exact match and surrounding context. Each message is truncated at ~500 characters.

```
Search results for "Railway API key" (2 matches):

Conversation: Deployment notes [i9j0k1l2]
    [msg#41] user: Deploy the API to Railway
>>> [msg#42] assistant: To deploy, you'll need the Railway API key. Go to railway.app/account...
    [msg#43] user: Got it, what's next?
    ---

Use conversations_read({ conversation_id: "...", offset: 0 }) for full messages.
```

### Example — find where an API key was discussed

```json
{
  "grep": "Railway API key",
  "limit": 5
}
```

### Example — search within one conversation

```json
{
  "grep": "error",
  "conversation_id": "i9j0k1l2-...",
  "limit": 10
}
```

---

## `conversations_read`

Read messages from a specific conversation in chronological order. Returns up to 20 messages per call (each truncated to ~500 characters). Use `offset` to paginate through long conversations, or `grep` to filter within the conversation.

Short ID prefixes are supported — if the short ID uniquely matches one conversation, it's resolved automatically.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `conversation_id` | `string` | ✅ | Full conversation UUID or unique short prefix (from `conversations_list` or `conversations_search`). |
| `offset` | `number` | ❌ | Message index to start from (0-based, default: 0). |
| `limit` | `number` | ❌ | Maximum messages to return (default: 20, capped at 20). |
| `grep` | `string` | ❌ | Filter messages within this conversation to only those containing this text. |

### Returns

A paginated view of conversation messages.

```
Conversation: Deployment notes [i9j0k1l2-...]
Messages 0–4 of 15 total:

[0] user: Deploy the API to Railway
[1] assistant: Sure! First, install the Railway CLI: npm install -g @railway/cli...
[2] user: Done. What's next?
[3] assistant: Now run `railway login` and then `railway up` from your project root...
[4] user: It worked! Can you save the deployment notes?

[10 more messages] Use offset=5 to continue.
```

### Example — read the beginning of a conversation

```json
{
  "conversation_id": "i9j0k1l2",
  "limit": 10
}
```

### Example — paginate to message 20

```json
{
  "conversation_id": "i9j0k1l2-1234-5678-abcd-ef0123456789",
  "offset": 20
}
```

### Example — find error messages within a conversation

```json
{
  "conversation_id": "i9j0k1l2",
  "grep": "failed"
}
```

---

## See Also

- `history` tool — search the *current* session's scrolled-out message history
- [`browsing-data-tools`](./browsing-data-tools.md) — search browser navigation history, not conversations
- [`cron_list`](./cron-tools.md#cron_list) — review scheduled job results (also stored as conversation runs)
