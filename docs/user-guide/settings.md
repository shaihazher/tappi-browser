# Settings

Open Settings with **`⌘,`** (or **Settings → Open Settings** from the menu bar). All changes are saved immediately to the active profile's `config.json`.

---

## Where Configuration is Stored

```
~/.tappi-browser/
  active_profile          ← name of the currently active profile
  profiles.json           ← profile registry (names, email, timestamps)
  profiles/
    default/
      config.json         ← all settings for the default profile
      database.sqlite     ← history, bookmarks, credentials, conversations
      api-keys.json       ← external service API keys
      cron-jobs.json      ← scheduled agent tasks
    <other-profile>/
      config.json
      database.sqlite
      …
```

Each profile has its own `config.json`. Switching profiles reloads from the new profile's file — settings are never shared between profiles.

---

## LLM Provider

### Provider

Select your LLM provider from the dropdown. Available providers:

| Value | Display Name | Auth Method |
|-------|--------------|-------------|
| `anthropic` | Anthropic | API key |
| `openai` | OpenAI | API key |
| `google` | Google Gemini | API key |
| `openrouter` | OpenRouter | API key |
| `ollama` | Ollama (local) | None (Base URL) |
| `bedrock` | AWS Bedrock | IAM credential chain |
| `vertex` | Vertex AI | Google ADC |
| `azure` | Azure OpenAI | Endpoint + API key |

### Model

Enter the model ID for your chosen provider. Defaults per provider:

| Provider | Default |
|----------|---------|
| Anthropic | `claude-sonnet-4-6` |
| OpenAI | `gpt-4o` |
| Google | `gemini-2.0-flash` |
| OpenRouter | `anthropic/claude-sonnet-4-6` |
| Ollama | `llama3.1` |
| Bedrock | `anthropic.claude-sonnet-4-6-v2:0` |
| Vertex | `gemini-2.0-flash` |
| Azure | `gpt-4o` |

### API Key

Paste your API key here. Tappi encrypts it immediately using Electron's `safeStorage` (backed by the OS keychain / system secret store) before writing it to `config.json`. The value stored on disk is prefixed `enc:` and is a base64-encoded encrypted blob.

If `safeStorage` is unavailable (rare), the key is stored with a `raw:` prefix in plain text. This fallback is logged as a warning.

### Cloud Provider Fields

Additional fields appear based on the selected provider:

| Provider | Fields |
|----------|--------|
| Ollama | **Base URL** (default: `http://localhost:11434/v1`) |
| OpenRouter | **Base URL** (default: `https://openrouter.ai/api/v1`) |
| AWS Bedrock | **AWS Region** (e.g. `us-east-1`). Uses `~/.aws/credentials` or env vars for auth. |
| Vertex AI | **GCP Project ID**, **Location** (e.g. `us-central1`). Uses Google ADC. |
| Azure OpenAI | **Resource Endpoint** (e.g. `https://myresource.openai.azure.com`), **API Key** |

---

## Secondary Model

*(Phase 8.85)* Configure a separate model for background tasks (profile generation, deep-mode subtasks). If unset, the primary model handles everything.

| Field | Description |
|-------|-------------|
| **Secondary Provider** | Provider for background tasks (defaults to primary) |
| **Secondary Model** | Model ID for background tasks |
| **Secondary API Key** | API key for secondary provider (defaults to primary key) |

---

## Agent Behaviour

| Setting | Default | Description |
|---------|---------|-------------|
| **Thinking** | On | Enables extended reasoning: adaptive thinking (Claude), reasoning effort (OpenAI o-series), thinking budget (Gemini 2.5+) |
| **Deep Mode** | On | Automatically decomposes complex tasks into sequential subtasks |
| **Coding Mode** | Off | Enables agent teams + Git worktree isolation (requires Developer Mode) |
| **Worktree Isolation** | On (when Coding Mode on) | Each teammate works in its own git worktree (branch), eliminating file conflicts |

### Timeouts

| Setting | Default | Description |
|---------|---------|-------------|
| **Agent Timeout** | 600,000 ms (10 min) | Maximum runtime for the main agent loop |
| **Teammate Timeout** | 600,000 ms (10 min) | Maximum runtime per coding teammate |
| **Subtask Timeout** | 300,000 ms (5 min) | Maximum runtime per deep-mode subtask |

---

## Search Engine

Select the default search engine used when a non-URL query is entered in the address bar. The query is URL-encoded and appended to the engine's search template.

Available options include: **Google**, **DuckDuckGo**, **Bing**, and others.

---

## Features

| Toggle | Default | Description |
|--------|---------|-------------|
| **Ad Blocker** | Off | EasyList-based ad and tracker blocking (see [Browsing](browsing.md#ad-blocker)) |
| **Dark Mode** | Off | CSS inversion filter injected into all pages |

---

## Privacy

| Setting | Default | Description |
|---------|---------|-------------|
| **Agent Browsing Data Access** | Off | When on, Aria can access your browsing history, bookmarks, and download records to build a user profile summary (`user_profile.json`). Turning this off deletes the profile file. |

---

## Developer Mode

**Developer Mode** unlocks advanced capabilities:

- **Shell access** for the agent (`exec`, `exec_bg`, `spawn_agent`, etc.)
- **Coding Mode** (agent teams, worktree isolation)
- **Local HTTP API server** on `localhost:18901` with Bearer token auth
- **Cron jobs** (schedule recurring agent tasks)

### Enabling Developer Mode

Settings → **Developer Mode** → toggle on.

When enabled, a token file is created at `~/.tappi-browser/api-token` with a 64-character hex token. Use this token as `Authorization: Bearer <token>` for API requests.

### API Token

In Settings → Developer Mode, the API token is displayed (masked). Click to reveal or copy. You can also retrieve it via:

```bash
cat ~/.tappi-browser/api-token
```

---

## API Services

The **API Services** tab lets you register named HTTP services that Aria can call via `http_request(auth: "@service-name")`.

| Field | Description |
|-------|-------------|
| **Name** | Service identifier (e.g. `github`, `openweather`) |
| **Base URL** | Service root URL |
| **Auth Header** | Auth scheme (default: `Bearer`) |
| **Description** | Human-readable description for Aria's context |
| **API Key** | Key stored encrypted in `api-keys.json` |

---

## Profiles

The **Profiles** tab lists all browser profiles. From here you can:

- Create a new profile (name, optional email).
- Switch to a different profile.
- Export a profile as an encrypted `.tappi-profile` file.
- Import a `.tappi-profile` file.
- Delete a profile (except default and active).

See [Browser Profiles](profiles.md) for full details.

---

## Credential Check

In Settings, a **Test Connection** button verifies that your configured API key and model are valid before you start chatting. Results show success or a descriptive error (wrong key, unknown model, network error).

---

## Related Guides

- [Getting Started](getting-started.md) — first-time API key setup
- [Privacy & Security](privacy-security.md) — how keys and passwords are stored
- [Browser Profiles](profiles.md) — per-profile configuration isolation
- [AI Agent (Aria)](agent.md) — agent behaviour settings
