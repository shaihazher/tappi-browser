# 🪷 Tappi Browser

> **A standalone desktop browser with a built-in AI agent. Bring your own API key. No subscription. No cloud lock-in.**

Tappi is an [Electron](https://www.electronjs.org/)-based desktop browser that pairs full web browsing with a native AI agent — **Aria** — that can see pages, click buttons, fill forms, run shell commands, manage files, and orchestrate multi-agent coding teams. Everything runs locally. Your API key goes directly to your chosen provider.

![Screenshot of Tappi Browser agent panel](screenshots/agent-panel.png)

---

## ✨ Key Features

- 🤖 **Built-in AI agent (Aria)** — chat in a sidebar or a full-width Aria tab; agent controls the browser through indexed page elements
- 🔑 **Bring Your Own Key** — works with Anthropic, OpenAI, Google Gemini, OpenRouter, Ollama (local), AWS Bedrock, Vertex AI, and Azure OpenAI
- 🚫 **No subscription** — pay only what you pay your LLM provider
- 🧠 **Deep Mode** — automatic task decomposition into focused subtasks with a built-in subtask runner
- 💻 **Coding Mode** — multi-agent coding teams with optional Git worktree isolation per teammate
- 🛡️ **Ad blocker** — EasyList-based, with per-site exceptions and live blocked-request counter
- 🌙 **Dark mode** — one-click dark mode injection into any page
- 🔖 **Bookmarks** — star any page with `⌘D`; stored in SQLite with folder support
- 🕰️ **Browsing history** — full-text search over all visited pages
- 📥 **Download manager** — tracks all downloads with status and progress
- 👤 **Browser profiles** — isolated cookies, history, bookmarks, and credentials per profile; export/import as encrypted `.tappi-profile` packs
- 🔒 **Password vault** — encrypted credential storage (Electron safeStorage) with agent-triggered autofill; agent never sees raw passwords
- 🎬 **Media engine** — mpv overlay for YouTube and streaming sites with yt-dlp quality selection
- 📸 **Self-capture** — screenshot and video recording of any tab
- 🔌 **Local HTTP API** — REST + SSE API on `localhost:18901` for external CLI control (Developer Mode)
- ⏰ **Cron jobs** — schedule recurring agent tasks with cron expressions
- 💬 **Persistent conversation history** — all chats stored in SQLite with full-text search

---

## 📸 Screenshots

| Agent Panel | Aria Tab | Settings |
|-------------|----------|----------|
| ![Agent Panel](screenshots/agent-panel.png) | ![Aria Tab](screenshots/aria-tab.png) | ![Settings](screenshots/settings.png) |

---

## 🚀 Quick Start

### 1. Install dependencies and build

```bash
git clone https://github.com/your-org/tappi-browser.git
cd tappi-browser
npm install
npm run build
```

### 2. Launch

```bash
npx electron dist/main.js
```

### 3. Add your API key

Press **`⌘,`** to open Settings. Choose your LLM provider, paste your API key, pick a model, and click **Save**.

### 4. Browse and talk to Aria

- Open a new tab with **`⌘T`** and browse normally.
- Press **`⌘J`** to slide open the AI agent panel — or click the **Aria** tab (always the first tab) for a full-width chat experience.
- Ask Aria anything: *"Summarize this page"*, *"Fill in this form with my info"*, *"Find me the best price for X"*.

---

## 🤖 Supported LLM Providers

| Provider | Auth | Notes |
|----------|------|-------|
| **Anthropic** | API key | Claude models; adaptive thinking (Sonnet 4.6+) |
| **OpenAI** | API key | GPT-4o, o1, o3, o4; reasoning effort for o-series |
| **Google Gemini** | API key | Gemini 2.0 Flash, 2.5 Pro; thinking budget support |
| **OpenRouter** | API key | Gateway to 100+ models with a single key |
| **Ollama** | None | Local models (llama3.1, mistral, etc.) at `localhost:11434` |
| **AWS Bedrock** | IAM credential chain | Set region in Settings |
| **Vertex AI** | Google ADC | Set project ID + location in Settings |
| **Azure OpenAI** | Endpoint + API key | Set resource endpoint in Settings |

---

## 🏗️ Architecture

Tappi is a single Electron process: the main process manages tabs as `WebContentsView` instances, runs the agent loop, and exposes an IPC bridge; a lightweight renderer (`src/ui/`) draws the chrome (tab bar, address bar, agent strip). See [docs/user-guide/getting-started.md](user-guide/getting-started.md) for a full build walkthrough.

---

## 📚 Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](user-guide/getting-started.md) | Build from source, first-run setup, first conversation |
| [Browsing](user-guide/browsing.md) | Tabs, navigation, bookmarks, find on page, dark mode, ad blocker |
| [AI Agent (Aria)](user-guide/agent.md) | Agent panel, Aria tab, deep mode, tools, conversation history |
| [Browser Profiles](user-guide/profiles.md) | Create, switch, export/import profiles |
| [Media Playback](user-guide/media.md) | mpv overlay, YouTube enhancement, keyboard controls |
| [Settings](user-guide/settings.md) | All configuration options and where data is stored |
| [Keyboard Shortcuts](user-guide/keyboard-shortcuts.md) | Complete shortcut reference |
| [Privacy & Security](user-guide/privacy-security.md) | Local-only storage, encryption, BYOK model |
| [Changelog](../changelog.md) | Phase-by-phase release history |

---

## 🔧 CLI

When Developer Mode is enabled, Tappi also exposes a CLI and local HTTP API:

```bash
# From the project root
node dist/cli.js --help
```

See [docs/user-guide/settings.md](user-guide/settings.md#developer-mode) for API token setup.

---

## 📄 License

<!-- TODO: add LICENSE file -->
License TBD. All rights reserved until an open-source license is chosen.
