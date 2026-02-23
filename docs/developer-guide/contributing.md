# Contributing

## Code Style

- **Language:** TypeScript with `strict: true`. No `any` without comment justification.
- **Module system:** CommonJS (`require`/`module.exports`) — Electron main process only.
- **File header:** Every source file starts with a JSDoc block explaining purpose and architecture.
- **Section dividers:** Use `// ─── Section Name ───` style comments to separate logical blocks.
- **Error returns:** Tool implementations return human-readable error strings prefixed with `❌`. Success strings prefixed with `✓` or an emoji where appropriate.
- **No unused imports:** TypeScript strict mode will catch these.

---

## File Organization

The `src/` directory is flat — no subdirectories. Files are named by their domain:

| Pattern | Examples |
|---------|---------|
| `<domain>-tools.ts` | `page-tools.ts`, `browser-tools.ts`, `file-tools.ts`, `shell-tools.ts` |
| `<domain>-manager.ts` | `team-manager.ts`, `worktree-manager.ts`, `tool-manager.ts` |
| `<domain>-store.ts` | `conversation-store.ts` |
| `<domain>-engine.ts` | `media-engine.ts` |

The main files are:
- **`tool-registry.ts`** — the single source of truth for all tool definitions.
- **`main.ts`** — Electron main process, config, IPC handlers, startup.
- **`agent.ts`** — agent loop (streamText invocation).

---

## How to Add a New Tool

All tools are defined in `src/tool-registry.ts` using the Vercel AI SDK `tool()` function with Zod schemas.

### Step 1: Implement the function

Add a new exported function to the appropriate implementation file:

```typescript
// src/file-tools.ts

export function fileStats(filePath: string): string {
  const resolved = resolvePath(filePath);
  if (!fs.existsSync(resolved)) return `File not found: ${resolved}`;
  const stat = fs.statSync(resolved);
  return `${resolved}: ${formatBytes(stat.size)}, modified ${stat.mtime.toISOString()}`;
}
```

### Step 2: Define the tool in tool-registry.ts

Inside `createTools()` (or one of the sub-factory functions like `createShellTools()`), add:

```typescript
file_stats: tool({
  description: 'Get size and modification time of a file.',
  inputSchema: z.object({
    path: z.string().describe('File path'),
  }),
  execute: async ({ path }: { path: string }) => fileTools.fileStats(path),
}),
```

### Step 3: Follow the naming conventions

- Tool names are **snake_case** strings.
- Parameter names are **snake_case**.
- Descriptions explain what the tool does and when to use it (seen by the LLM).
- Each parameter's `.describe()` call explains what the LLM should pass.

### Step 4: Add to a conditional block if needed

Some tools are only available under certain conditions:

```typescript
// Developer Mode only
...(options?.developerMode ? createShellTools(sessionId, browserCtx, options.llmConfig) : {}),

// Coding Mode + Developer Mode only
...(options?.developerMode && options?.codingMode
  ? createTeamTools(sessionId, browserCtx, options.llmConfig, options.teamId, options.agentName)
  : {}),

// Privacy gate — only when agentBrowsingDataAccess is ON
...(options?.agentBrowsingDataAccess ? createBrowsingDataTools() : {}),
```

If your tool should only be available in a specific mode, put it in the appropriate sub-factory function.

### Step 5: Document it

Add a row to the appropriate tool doc in `docs/tools/` following the existing format.

---

## Testing via CLI

With Developer Mode on, you can test tools directly via the TCP CLI server:

```bash
# Test navigate
echo "navigate to https://example.com" | nc localhost 18900

# Test file tools
echo "file_write test.txt 'hello world'" | nc localhost 18900

# Test exec
echo "exec('ls -la')" | nc localhost 18900
```

Or via the HTTP API (port 18901):

```bash
TOKEN=$(cat ~/.tappi-browser/api-token)

# Call a tool directly
curl -X POST http://localhost:18901/tool/elements \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'

# Send an agent prompt
curl -X POST http://localhost:18901/agent \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "what is the title of the current page?"}'
```

---

## Tool Description Quality

Good descriptions directly affect agent quality. Guidelines:

- **Lead with the verb:** "Search", "Create", "Delete", "Toggle".
- **Mention when to use it** vs alternatives: `"Prefer paste for long content"`, `"Fallback for elements not reachable by index"`.
- **Mention return format** if non-obvious.
- **Alias handling:** If the tool accepts `grep` and `pattern` as aliases, document both.

---

## Adding a New LLM Provider

LLM providers are abstracted in `src/llm-client.ts`. To add a new provider:

1. Install the AI SDK package: `npm install @ai-sdk/<provider>`.
2. Add the provider to `createModel()` in `llm-client.ts`.
3. Add the provider to the `LLMConfig.provider` union type.
4. Add the provider option to the Settings UI.

---

## Phase Numbering

The codebase uses phase comments (`Phase 8.35`, `Phase 8.38`, etc.) to track when features were added. New work should be tagged with the next available phase number for traceability.

---

## IPC Pattern

Main process → Renderer communication uses Electron IPC:

```typescript
// Main → Renderer (send)
mainWindow.webContents.send('channel:event', payload);

// Renderer → Main (handle)
ipcMain.handle('channel:action', async (event, args) => {
  return result;
});
```

When a tool changes state visible to the UI (tool registered, team updated, recording started), it should send an IPC notification via the `browserCtx.window`:

```typescript
try { browserCtx.window.webContents.send('tools:updated', null); } catch {}
```

The `try/catch` is defensive — the window may be closing.

---

## See Also

- [Building from Source](building-from-source.md)
- [Developer Mode](dev-mode.md)
- [Tool Overview](../tools/overview.md)
