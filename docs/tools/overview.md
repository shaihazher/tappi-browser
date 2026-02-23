# Tool Overview

Tappi Browser's agent interacts with the world through a set of typed tools. Tools are defined using the [Vercel AI SDK](https://sdk.vercel.ai/) `tool()` function with [Zod](https://zod.dev/) schemas, and dispatched automatically by the underlying model.

---

## Tool Philosophy

### Grep-First Discovery

Most tools expose a `grep` parameter — a case-insensitive text filter that narrows results without loading everything into context. The pattern mirrors Unix `grep`: find what you need first, then read.

```
elements({ grep: "submit" })        # Find submit buttons without listing everything
text({ grep: "privacy policy" })    # Find relevant passages without reading full page
file_read({ path: "...", grep: "TODO" })  # Search file without loading 80KB of content
```

### Compact Indexed Menus

`elements` returns an indexed list. Every subsequent interaction (click, type, focus, check) uses the **index number**, not a CSS selector or XPath. This keeps tool calls terse and context-light:

```
[0] (button) Sign in
[1] (input) Email address
[2] (input) Password
[3] (checkbox) Remember me
```

Then: `click({ index: 0 })`, `type({ index: 1, text: "user@example.com" })`.

### Token Efficiency

- `elements` returns viewport elements only by default (~20–40 elements, hard cap 50).
- `text` returns ~1.5 KB of page text by default; scoped to a CSS selector or grepped.
- `file_read` caps at ~80 KB and offers chunked reading, grep, and line-range modes.
- Shell output is captured and truncated to first 20 + last 20 lines. `exec_grep` searches the full buffer.

---

## Tool Categories

| Category | Available When | Doc |
|----------|---------------|-----|
| **Page** | Always | [page-tools.md](page-tools.md) |
| **Browser** | Always | [browser-tools.md](browser-tools.md) |
| **File** | Always | [file-tools.md](file-tools.md) |
| **HTTP / API** | Always | [http-tools.md](http-tools.md) |
| **Media** | Always | [media-tools.md](media-tools.md) |
| **Capture** | Always | [capture-tools.md](capture-tools.md) |
| **Cron** | Always | [cron-tools.md](cron-tools.md) |
| **Conversation** | Always | [conversation-tools.md](conversation-tools.md) |
| **Shell** | Developer Mode ON | [shell-tools.md](shell-tools.md) |
| **Team** | Developer Mode + Coding Mode ON | [team-tools.md](team-tools.md) |
| **Browsing Data** | Privacy setting: Agent Access ON | [browsing-data-tools.md](browsing-data-tools.md) |

---

## How Tools Are Registered

All tool definitions live in `src/tool-registry.ts`. Tools are created at runtime via `createTools(browserCtx, sessionId, options)` because they need:

- A reference to the active tab's `WebContents` (via `getWC()`).
- The session ID (for output buffers and conversation history scoping).
- Feature flags from `options` (Developer Mode, Coding Mode, privacy settings).

### Pattern

```typescript
import { tool } from 'ai';
import { z } from 'zod';

navigate: tool({
  description: 'Navigate current tab to a URL.',
  inputSchema: z.object({
    url: z.string().describe('URL to navigate to'),
  }),
  execute: async ({ url }) => browserTools.bNavigate(browserCtx, [url]),
}),
```

- `description` — shown to the LLM; drives when and how the tool is called.
- `inputSchema` — a Zod object schema. All parameters are validated before `execute` runs.
- `execute` — the async implementation function. Returns a string (the tool result).

### Conditional Inclusion

Some tool groups are only included when certain flags are on:

```typescript
// Shell tools — only when Developer Mode is ON
...(options?.developerMode ? createShellTools(sessionId, browserCtx, options.llmConfig) : {}),

// Team tools — only when Developer Mode + Coding Mode are BOTH ON
...(options?.developerMode && options?.codingMode
  ? createTeamTools(...)
  : {}),
```

When a tool group is excluded, the tool schemas are not sent to the LLM at all — they are completely invisible.

---

## How the Agent Dispatches Tools

The agent runs via Vercel AI SDK's `streamText`:

```typescript
const result = await streamText({
  model,
  system: systemPrompt,
  messages,
  tools: createTools(browserCtx, sessionId, options),
  stopWhen: stepCountIs(100),   // max 100 tool steps per turn
});
```

The LLM decides which tool to call and with what parameters based on the tool descriptions and schemas. The SDK handles:
- Injecting tool schemas into the API request.
- Parsing the model's tool call response.
- Validating parameters against the Zod schema.
- Calling `execute(params)`.
- Feeding the result back to the model for the next step.

This continues (agentic loop) until the model produces a final text response with no tool call, or `stopWhen` triggers.

---

## Usage Guide (Injected into Agent Context)

The following guidelines are appended to the agent's system prompt:

1. **Always start with `elements`** to see what's on the page.
2. **Click/type/paste by index number** from the elements list.
3. **After navigation or major changes**, re-run `elements`.
4. **For canvas apps** (Sheets, Docs, Figma) — use `keys` instead of type/click.
5. **For API workflows** — use `http_request` to call APIs.
6. **Save research** to files — markdown for notes, CSV for tabular data.
7. **Grep first, scroll second.** When looking for something specific, use grep on elements/text/history/files.
8. **Be concise** in responses.

---

## Complete Tool List

| Tool Name | Category | Description |
|-----------|----------|-------------|
| `elements` | Page | Index interactive elements |
| `click` | Page | Click by index |
| `type` | Page | Type text into input by index |
| `paste` | Page | Paste text into element by index |
| `focus` | Page | Focus element by index |
| `check` | Page | Read element state |
| `text` | Page | Extract page text |
| `scroll` | Page | Scroll the page |
| `keys` | Page | Send keyboard input |
| `eval_js` | Page | Execute JavaScript |
| `screenshot` | Page | Save page screenshot |
| `click_xy` | Page | Click at coordinates |
| `hover_xy` | Page | Hover at coordinates |
| `wait` | Page | Wait milliseconds |
| `navigate` | Browser | Navigate to URL |
| `search` | Browser | Web search |
| `back_forward` | Browser | Browser history navigation |
| `dark_mode` | Browser | Toggle dark mode |
| `cookies` | Browser | List/delete cookies |
| `tab` | Browser | Tab management |
| `bookmark` | Browser | Toggle bookmark |
| `zoom` | Browser | Zoom page |
| `find` | Browser | Find on page |
| `print_pdf` | Browser | Print or save PDF |
| `browser_screenshot` | Capture | Capture tab/window/fullpage |
| `browser_record` | Capture | Record browser as video |
| `ad_blocker` | Browser | Toggle ad blocker |
| `browsing_history` | Browser | Search navigation history |
| `browse_bookmarks` | Browser | Search bookmarks |
| `downloads` | Browser | Download management |
| `password_vault` | Browser | Password management |
| `http_request` | HTTP | Make HTTP requests |
| `api_key_store` | HTTP | Store API key |
| `api_key_list` | HTTP | List API key services |
| `api_key_get` | HTTP | Retrieve API key |
| `api_key_delete` | HTTP | Delete API key |
| `register_api` | HTTP | Register API service |
| `list_apis` | HTTP | List API services |
| `remove_api` | HTTP | Remove API service |
| `document_endpoint` | HTTP | Document API endpoint |
| `get_endpoint_docs` | HTTP | Retrieve endpoint docs |
| `file_write` | File | Write file |
| `file_read` | File | Read file |
| `file_read_range` | File | Read line range |
| `file_head` | File | Read first N lines |
| `file_tail` | File | Read last N lines |
| `file_append` | File | Append to file |
| `file_delete` | File | Delete file/directory |
| `file_list` | File | List directory |
| `file_copy` | File | Copy file |
| `file_move` | File | Move/rename file |
| `file_grep` | File | Search file content |
| `history` | Conversation | Search conversation history |
| `register_tool` | Tool Mgmt | Register CLI tool |
| `unregister_tool` | Tool Mgmt | Unregister CLI tool |
| `update_tool` | Tool Mgmt | Update tool metadata |
| `list_tools` | Tool Mgmt | List registered tools |
| `verify_tools` | Tool Mgmt | Verify tools on PATH |
| `cron_add` | Cron | Create scheduled job |
| `cron_list` | Cron | List scheduled jobs |
| `cron_update` | Cron | Update scheduled job |
| `cron_delete` | Cron | Delete scheduled job |
| `conversations_list` | Conversation | List conversations |
| `conversations_search` | Conversation | Search conversations |
| `conversations_read` | Conversation | Read conversation messages |
| `media_status` | Media | Get playback status |
| `media_toggle` | Media | Toggle mpv overlay |
| `media_quality` | Media | Set quality preference |
| `media_seek` | Media | Seek to position |
| `media_volume` | Media | Set volume |
| `exec` | Shell* | Run shell command |
| `exec_bg` | Shell* | Run background command |
| `exec_status` | Shell* | Check background process |
| `exec_kill` | Shell* | Kill background process |
| `exec_grep` | Shell* | Search command output |
| `exec_list` | Shell* | List session outputs |
| `spawn_agent` | Shell* | Spawn sub-agent |
| `sub_agent_status` | Shell* | Check sub-agent status |
| `team_create` | Team† | Create agent team |
| `team_status` | Team† | Get team overview |
| `team_message` | Team† | Send inter-agent message |
| `team_task_add` | Team† | Add task to shared list |
| `team_task_update` | Team† | Update task status/result |
| `team_run_teammate` | Team† | Run a specific teammate |
| `team_dissolve` | Team† | Dissolve team |
| `worktree_create` | Team† | Create git worktree |
| `worktree_list` | Team† | List worktrees |
| `worktree_merge` | Team† | Merge worktree |
| `worktree_remove` | Team† | Remove worktree |
| `worktree_status` | Team† | Worktree git status |
| `worktree_diff` | Team† | Worktree diff |
| `browse_history` | Privacy‡ | Search browsing history |
| `browse_bookmarks` | Privacy‡ | Search bookmarks |
| `browse_downloads` | Privacy‡ | Search downloads |

\* Developer Mode required  
† Developer Mode + Coding Mode required  
‡ Privacy setting "Agent Browsing Data Access" required
