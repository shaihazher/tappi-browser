# Getting Started with Tappi Browser

This guide walks you through building Tappi from source, configuring your LLM provider, and having your first conversation with the Aria agent.

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Node.js** | 18 + | v25 recommended |
| **npm** | 9 + | Bundled with Node |
| **Git** | any | For cloning |
| **mpv** *(optional)* | any | For enhanced media playback — see [Media Playback](media.md) |

---

## 1. Clone and Install

```bash
git clone https://github.com/your-org/tappi-browser.git
cd tappi-browser
npm install
```

`npm install` fetches all runtime and dev dependencies, including Electron, the Vercel AI SDK adapters for each LLM provider, `better-sqlite3`, and `marked`.

---

## 2. Build

```bash
npm run build
```

This runs TypeScript compilation (`tsc`) and copies the UI assets:

```
dist/
  main.js          ← Electron main process
  preload.js       ← IPC bridge preload
  content-preload.js ← Page-level element indexer
  aria-preload.js  ← Aria tab IPC bridge
  ui/              ← index.html, aria.html, styles.css, app.js, aria.js …
  cli.js           ← Local CLI (Developer Mode)
```

---

## 3. Launch

```bash
npx electron dist/main.js
```

Tappi opens a `1280 × 820` window with the Aria tab selected and no regular tabs. Press **`⌘T`** to open your first web tab.

> **Tip:** During development, `npm run dev` rebuilds and launches in a single command.

---

## 4. First-Run Configuration

On first launch Tappi creates its data directory:

```
~/.tappi-browser/
  profiles/
    default/
      config.json        ← all settings for this profile
      database.sqlite    ← history, bookmarks, credentials, conversations
      api-keys.json      ← service API keys (encrypted)
      cron-jobs.json     ← scheduled agent tasks
```

Config is profile-scoped — each profile has its own `config.json`. The active profile name is stored in `~/.tappi-browser/active_profile`.

---

## 5. Set Up Your API Key

1. Press **`⌘,`** (or open the **Settings** menu → **Open Settings**).
2. In the **LLM Provider** section, choose your provider from the dropdown.
3. Fill in the required fields for that provider:

### Provider-specific fields

| Provider | Required Fields |
|----------|----------------|
| Anthropic | API Key |
| OpenAI | API Key |
| Google Gemini | API Key |
| OpenRouter | API Key, (optional) Base URL |
| Ollama | Base URL (default: `http://localhost:11434/v1`) |
| AWS Bedrock | AWS Region (credentials from `~/.aws/credentials` or env vars) |
| Vertex AI | GCP Project ID, Location (uses Google ADC) |
| Azure OpenAI | Resource Endpoint URL, API Key |

4. In the **Model** field, enter the model ID. The default for each provider is:

| Provider | Default Model |
|----------|--------------|
| Anthropic | `claude-sonnet-4-6` |
| OpenAI | `gpt-4o` |
| Google | `gemini-2.0-flash` |
| OpenRouter | `anthropic/claude-sonnet-4-6` |
| Ollama | `llama3.1` |
| Bedrock | `anthropic.claude-sonnet-4-6-v2:0` |
| Vertex | `gemini-2.0-flash` |
| Azure | `gpt-4o` |

5. Click **Save**. Your API key is immediately encrypted with Electron's `safeStorage` (OS keychain-backed) — it is never stored in plain text.

> **Testing the connection:** After saving, use the **Test Connection** button to verify credentials before browsing.

---

## 6. Choose Your Agent Mode

In Settings, a few toggles shape how the agent behaves:

| Toggle | Default | Effect |
|--------|---------|--------|
| **Thinking** | On | Enables adaptive reasoning (Claude) / reasoning effort (OpenAI o-series) / thinking budget (Gemini 2.5) |
| **Deep Mode** | On | Agent decomposes complex tasks into subtasks automatically |
| **Coding Mode** | Off | Enables agent teams + Git worktree isolation (requires Developer Mode) |

---

## 7. Your First Conversation

1. Click the **🪷 Aria** tab (always pinned at position 0, can't be closed).
2. Type a message in the input at the bottom and press **Enter** (or click ▶).
3. Aria streams her response with inline markdown rendering.

Or, open a web page first and use the sidebar:

1. Press **`⌘T`** → navigate to any website.
2. Press **`⌘J`** to open the agent side panel.
3. Ask: *"What does this page say about refund policies?"*

Aria will call `elements()` to index the page, then `text({ grep: "refund" })` to find the relevant passage — you'll see tool-call annotations as she works.

---

## 8. Next Steps

| Topic | Guide |
|-------|-------|
| Managing tabs, bookmarks, downloads | [Browsing](browsing.md) |
| Full agent capabilities | [AI Agent (Aria)](agent.md) |
| Multiple browser identities | [Browser Profiles](profiles.md) |
| All settings explained | [Settings](settings.md) |
| Keyboard shortcuts | [Keyboard Shortcuts](keyboard-shortcuts.md) |
