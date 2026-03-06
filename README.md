# Tappi Browser

> **The only AI browser where the agent IS the browser. Zero telemetry. Open source.**

Tappi is a Chromium-based desktop browser with a built-in AI agent that uses **3-10x fewer tokens** than competitors. Unlike every CDP-based tool (Playwright, Puppeteer, browser-use, Selenium), Tappi's agent runs inside the browser's own process - it never sets `navigator.webdriver`, never triggers bot detection, and works on sites that block every other automation framework. No subscription. No cloud lock-in. Bring your own API key.

---

### **Native Claude Code Integration**

**Tappi Browser now ships with native Claude Code CLI integration** - bringing Anthropic's world-class agentic orchestration directly into your browser.

**Claude Code empowers Tappi** with battle-tested agentic capabilities: adaptive thinking, intelligent tool use, multi-turn session management, and the same autonomous problem-solving engine trusted by developers worldwide.

**Tappi empowers Claude Code** with native browser tools - real tab control, element indexing, page interaction, shell access, and a local HTTP API - giving Claude Code the hands it needs to operate a full browser environment.

The result: a symbiotic integration where Claude Code handles the intelligence and orchestration while Tappi provides the browser-native execution layer. No wrappers. No adapters. Just direct CLI-to-browser power.

- **Two auth paths** - Sign in with `claude login` (OAuth) or bring your own Anthropic API key
- **Plan mode** - Claude Code analyzes first, you review and approve before execution
- **Full mode** - Unrestricted agentic execution with zero permission friction
- **Session continuity** - Multi-turn conversations that persist context across turns
- **Your own Claude Code, managed separately** - Tappi installs its own CLI, never interfering with your personal installation

---

### **Scriptify & Scripts - Turn Conversations Into Reusable Workflows**

Had a great conversation with Aria? **Scriptify** it. One click analyzes your conversation and generates a reusable script - complete with input fields, auth requirements, and executable steps.

**Three script types, matched to the task:**

| Type | What it does |
|------|-------------|
| **Automated** | Deterministic Python scripts that run start-to-finish |
| **Semi-automated** | Mix of code blocks + LLM reasoning for analysis steps |
| **Playbook** | Creative/orchestration tasks requiring agent judgment |

**How it works:**
1. Chat with Aria to complete a task
2. Click **📜 Scriptify** - the agent extracts the repeatable workflow
3. Open **📂 Scripts**, fill in inputs (or upload a CSV for bulk), hit Execute

**What makes it powerful:**
- **Bulk execution** - Upload a CSV or Excel file. The script runs for every row automatically.
- **Auth-aware** - Scripts detect which logins are needed and verify them before running.
- **Natural language editing** - Describe what to change; the LLM updates the script definition.
- **Self-healing** - Bugs found during execution get patched back into the saved script.
- **Special instructions** - Add one-off tweaks per run without editing the stored script.

---

### **Domain Playbooks - The Browser That Learns From Experience**

Most AI browsers treat every session like the first time. Navigate to a complex internal tool, struggle through the wrong URL paths, dismiss the same onboarding dialog, discover the right dropdown values - and then lose all of it when the conversation ends. Next session? Same struggle, same wasted tokens, same frustration.

**Tappi remembers.**

Domain Playbooks are structural learnings that Tappi automatically extracts and persists after every browsing session. When the agent navigates to a domain, struggles, and eventually figures out the right approach, that hard-won knowledge gets captured in SQLite and injected into every future session on that domain.

**What gets captured:**
- **URL patterns** - Correct paths and query parameters, so the agent never tries dead-end URLs again
- **UI navigation** - Where features actually live, menu structures, required click sequences
- **Prerequisite steps** - Dialogs to dismiss, cookie banners to clear, login flows to follow
- **Element strategies** - How to find specific elements (iframes, shadow DOM, dynamic selectors)
- **Anti-patterns** - Paths that *don't* work, so the agent avoids repeating old mistakes
- **Rate limits & timing** - Discovered API limits, required waits between requests

**What never gets captured:**
- Passwords, tokens, or personal data
- Transient content like search results or page text
- Opinions or commentary - only actionable, structural knowledge

**How it works:**
1. The agent visits a domain and interacts with it (clicks, types, navigates)
2. At the end of the turn, an LLM traces the session for error-to-correction patterns
3. Only the *final working approach* is extracted - failed attempts are discarded
4. Learnings are merged into the existing playbook (or a new one is created)
5. Next time the agent navigates to that domain, the playbook is injected automatically

**The result:** A browser that gets smarter with every session. The first time Tappi encounters a complex internal tool, it might take a few tries. The second time, it walks straight to the right URL, dismisses the right dialog, and uses the correct form values - because it already learned all of that. Every session compounds. Every mistake becomes permanent knowledge. The agent doesn't just complete tasks - it builds expertise.

This is the difference between a stateless AI tool and a genuine AI agent. Tappi doesn't forget.

---

## Screenshots

| Aria Agent | Real Conversation |
|------------|-------------------|
| ![Aria Tab](screenshots/aria-tab.png) | ![Conversation](screenshots/conversation.png) |

| Normal Browsing | Settings |
|-----------------|----------|
| ![YouTube](screenshots/normal-browsing.png) | ![Settings](screenshots/settings.png) |

---

## Why Tappi?

| | Tappi | browser-use | OpenAI Operator | Perplexity Comet | ChatGPT Atlas |
|---|---|---|---|---|---|
| **Architecture** | Browser-native | CDP (Playwright) | CDP | CDP | CDP |
| **Bot Detection** | ✅ Undetectable | ❌ Detectable | ❌ Detectable | ❌ Detectable | ❌ Detectable |
| **Token Efficiency** | ✅ 3-10x savings | Standard | Standard | Standard | Standard |
| **Telemetry** | ❌ Zero | Varies | ✅ Full | ✅ Full | ✅ Full |
| **Open Source** | ✅ MIT | ✅ Apache 2.0 | ❌ No | ❌ No | ❌ No |
| **Cost** | Free (BYOK) | Free (BYOK) | $200/mo | $20-200/mo | $20-200/mo |
| **LLM Providers** | ✅ 9 providers | ✅ Multiple | ❌ OpenAI only | ❌ Locked | ❌ Locked |
| **Shell Access** | ✅ Full | ❌ No | ❌ No | ❌ No | ❌ No |
| **Persistent Learning** | ✅ Domain Playbooks | ❌ No | ❌ No | ❌ No | ❌ No |
| **Enterprise Auth** | ✅ Kerberos/mTLS | ❌ No | ❌ No | ❌ No | ❌ No |
| **Parallel Agents** | ✅ Teams | ❌ No | ❌ Limited | ❌ No | ❌ Limited |

**The CDP problem is architectural.** Every tool built on Chrome DevTools Protocol sets `navigator.webdriver = true` - a flag that [Cloudflare (~20% of all websites)](https://www.cloudflare.com/application-services/products/bot-management/), Akamai, and DataDome check on every request. No amount of stealth plugins fixes this - it's baked into the protocol. Tappi sidesteps the entire detection surface because it IS the browser.

**The DOM-dumping tax is real.** The Verge found that Perplexity's Comet took *two minutes* to unsubscribe from emails - a task a human could do in 30 seconds. That's what happens when you dump 50KB of HTML into LLM context per page. Tappi's referenced element indexing means `click e42` instead of 500-token DOM selectors. 3-10x fewer tokens. Faster. Cheaper.

---

## How It Works

### Referenced Element Indexing

Most AI browsers dump entire DOM trees into the LLM context - 50KB of HTML, 12,500+ tokens, just to "see" the page.

Tappi indexes elements once and the agent references them by ID internally. When you ask *"Find the best price for this product"*, the agent:
1. Indexes interactive elements on the page
2. Identifies search boxes, buttons, links by their indexed IDs
3. Executes clicks and types using compact references like `click e42`

**Result:** 3-10x fewer tokens than DOM-dumping approaches.

### Aggressive Context Management

Long conversations get written to disk. The agent greps files instead of loading them:

```
Agent: "I found the function in conversation-turn-47.md - grep shows it's on line 234"
```

Load full files when needed (up to 10K tokens). Otherwise: grep first, load later.

### Native Browser Automation - Why This Changes Everything

Tappi **IS the browser** - not a CDP client, not a Chrome extension, not an automation layer on top of Chrome. The agent runs in the Electron main process and calls tools that are browser-native via preload scripts that inject into each tab.

**Why does this matter?** Every other browser automation tool - Playwright, Puppeteer, Selenium, browser-use, OpenAI Operator - remote-controls Chrome through the Chrome DevTools Protocol (CDP). This means:

- **They set `navigator.webdriver = true`** - a flag that every anti-bot system checks first
- **They expose a debugging port** detectable via TLS fingerprinting
- **They generate synthetic events** that behavioral analysis systems catch
- **They run in ephemeral sessions** that lose cookies and auth state on close

Tappi has none of these problems. The agent dispatches input through Chromium-native `sendInputEvent` APIs - the same code path that processes real keyboard and mouse events. [Cloudflare protects ~20% of all websites](https://www.cloudflare.com/application-services/products/bot-management/); [Akamai and DataDome add layers of device fingerprinting](https://www.zenrows.com/blog/bypass-bot-detection) that track mouse movement cadence, canvas rendering, and TLS handshakes. CDP-based agents fail on these sites. Tappi doesn't.

| Detection Vector | CDP Tools (Playwright, Puppeteer, etc.) | Tappi Browser |
|---|---|---|
| `navigator.webdriver` | Set to `true` (detectable) | Not set (real Chromium) |
| User Agent | Modified / headless signatures | Real Chrome UA (Electron tokens stripped) |
| Input Events | Synthetic DOM events via CDP | Chromium-native `sendInputEvent` |
| Debugging Port | Exposed (detectable) | None |
| Rendering | Headless (no GPU) or remote | Full GPU-accelerated rendering |
| Session State | Ephemeral (lost on close) | Persistent cookies/localStorage/IndexedDB |
| Extensions | Not supported / limited | Full CRX support with native messaging |

[Industry research confirms](https://scrapingant.com/blog/headless-vs-headful-browsers-in-2025-detection-tradeoffs) that headful browsers are now the de facto choice when automation must be indistinguishable from a real user. Tappi is the only open-source headful browser with a built-in AI agent.

---

## What Can You Do?

Everything Comet and Atlas can do - plus what they can't:

**Core Browsing:**
- Research and summarize any page
- Fill forms, complete workflows, book reservations
- Shop, compare products, find best prices
- Manage tabs, bookmarks, downloads
- Schedule recurring tasks with cron
- Take screenshots and record tabs
- Turn any conversation into a reusable script with Scriptify

**Developer Power:**
- Code with multi-agent teams (parallel spawning)
- Run shell commands from the agent
- Control via CLI or HTTP API
- Self-host, zero cloud dependency

---

## Installation

### Quick Install (Build from Source)

One command to clone, build, and install Tappi with desktop integration:

```bash
curl -fsSL https://raw.githubusercontent.com/shaihazher/tappi-browser/main/scripts/install.sh | bash
```

This auto-detects your OS (macOS / Linux / Windows via Git Bash), installs any missing dependencies (git, build tools, Node.js), builds from source, and creates app launchers so Tappi appears in your application menu, Spotlight, or Start Menu.

**Custom install location:**

```bash
TAPPI_INSTALL_DIR=~/my-tappi curl -fsSL https://raw.githubusercontent.com/shaihazher/tappi-browser/main/scripts/install.sh | bash
```

Re-running the installer updates an existing installation in-place.

---

### Build from Source

#### Prerequisites

- **Node.js** 18+ (20+ recommended)
- **npm** 9+
- **Git**

#### macOS

```bash
# Install Xcode Command Line Tools (if not already)
xcode-select --install

# Clone and build
git clone https://github.com/shaihazher/tappi-browser.git
cd tappi-browser
npm install
npx electron-rebuild

# Run
npm start
```

#### Windows

```bash
# Install Visual Studio Build Tools (required for native modules)
# Download from: https://visualstudio.microsoft.com/visual-cpp-build-tools/
# Select "Desktop development with C++"

# Clone and build
git clone https://github.com/shaihazher/tappi-browser.git
cd tappi-browser
npm install
npx electron-rebuild

# Run
npm start
```

#### Linux (Debian/Ubuntu)

```bash
# Install build dependencies
sudo apt update
sudo apt install -y build-essential python3

# Clone and build
git clone https://github.com/shaihazher/tappi-browser.git
cd tappi-browser
npm install
npx electron-rebuild

# Run
npm start
```

#### Linux (Fedora/Nobara/RHEL)

```bash
# Install build dependencies
sudo dnf install -y gcc-c++ make python3

# Clone and build
git clone https://github.com/shaihazher/tappi-browser.git
cd tappi-browser
npm install
npx electron-rebuild

# Run
npm start
```

---

### First Run

1. Launch Tappi
2. Press `⌘,` (macOS) or `Ctrl+,` (Windows/Linux) to open Settings
3. Choose your LLM provider, paste your API key, pick a model
4. Save and start browsing

Press `⌘,` (macOS) or `Ctrl+,` (Windows/Linux) to open Settings. Choose your provider, paste your API key, pick a model, and save.

### 4. Browse and talk to Aria

- Open tabs with `⌘T` / `Ctrl+T`
- Press `⌘J` / `Ctrl+J` to open the AI agent panel
- Or click the **Aria** tab (always first) for full-width chat

---

## Supported LLM Providers

Bring your own key. No lock-in.

| Provider | Auth | Models |
|----------|------|--------|
| **Claude Code** | OAuth or API key | **Native CLI integration** - full agentic orchestration |
| **Anthropic** | API key | Claude Opus 4.6, Sonnet 4.6, Haiku 4.5 |
| **OpenAI** | API key | GPT-5.2, o3, o4, GPT-4o |
| **Google Gemini** | API key | Gemini 2.5 Pro, 2.0 Flash |
| **OpenRouter** | API key | 100+ models, single key |
| **Ollama** | None (local) | llama3.1, mistral, gemma, etc. |
| **AWS Bedrock** | IAM | Claude, Titan, Llama via AWS |
| **Vertex AI** | Google ADC | Gemini models via GCP |
| **Azure OpenAI** | Endpoint + key | GPT deployments |

---

## Recommended Models

| Use Case | Model | Why |
|----------|-------|-----|
| **Safety-first** | Claude Opus 4.6 | Best reasoning, lowest hallucination |
| **Best value** | GLM-5 (OpenRouter) | Excellent price/performance ratio |
| **Speed** | Grok 4.1 Fast | Fast, cheap, surprisingly capable |
| **Coding** | Codex 5.3 | Optimized for code generation |
| **Free** | Ollama (local) | Runs on your hardware, zero cost |

The agent harness works well with inexpensive models - you don't need Opus for most tasks.

---

## CLI & API: Control Tappi From Anywhere

Tappi ships with a **local HTTP API** and a **CLI** that wraps it. Automate the browser from your terminal, scripts, or any HTTP client.

### Enable Developer Mode

In Settings, toggle **Developer Mode** to unlock shell access and the full tool suite.

### Using the CLI

```bash
# List all tabs
tappi-browser tabs

# Navigate
tappi-browser open https://github.com

# Index page elements
tappi-browser elements

# Click and type
tappi-browser click 3
tappi-browser type 3 "hello world"

# Ask the AI agent
tappi-browser ask "Summarize this page"

# Stream responses
tappi-browser ask --stream "What's the main point?"

# Run shell commands (dev mode)
tappi-browser exec "ls ~/Downloads"

# Get/set config
tappi-browser config get
tappi-browser config set developerMode true
```

### Using the HTTP API

The API runs on `http://127.0.0.1:18901`. Authentication uses a Bearer token stored at `~/.tappi-browser/api-token`.

```bash
# Get API token
TOKEN=$(cat ~/.tappi-browser/api-token)

# Check status
curl -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:18901/api/status

# Open a tab
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://github.com"}' \
  http://127.0.0.1:18901/api/tabs

# Ask the agent
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "What is on this page?"}' \
  http://127.0.0.1:18901/api/agent/ask

# Stream agent responses (SSE)
curl -N \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Explain the code on screen"}' \
  http://127.0.0.1:18901/api/agent/ask/stream
```

### Full Documentation

| Doc | Description |
|-----|-------------|
| [API Overview](docs/api/overview.md) | REST API concepts, auth, rate limits |
| [API Endpoints](docs/api/endpoints.md) | Every endpoint documented |
| [SSE Streaming](docs/api/sse-streaming.md) | Real-time agent responses |
| [Tool Passthrough](docs/api/tool-passthrough.md) | Invoke any tool via API |
| [CLI Overview](docs/cli/overview.md) | Command-line interface guide |
| [CLI Commands](docs/cli/commands.md) | Every command documented |
| [CLI Scripting](docs/cli/scripting.md) | Automation, jq, pipes |

---

## Developer Mode

Toggle **Developer Mode** in Settings to unlock:

- **Shell access** - agent can run `exec` commands
- **Full filesystem** - read/write any file on your machine
- **Unrestricted tools** - all 47+ tools available

This turns Tappi into something like OpenClaw running natively inside a browser. Use responsibly.

---

## Enterprise Features

Tappi ships with enterprise-grade capabilities that make it suitable for corporate deployment - without requiring MDM, group policy, or managed browser infrastructure.

### Authentication

- **Kerberos/SPNEGO SSO** - Configurable `auth-server-whitelist` and `auth-negotiate-delegate-whitelist` exposed directly in the Settings UI. Supports the same Chromium-native SPNEGO negotiation that Chrome uses for enterprise SSO, but configured per-application instead of via group policy.
- **Client certificate auto-selection** - When a server requests mTLS authentication, Tappi automatically selects the first available certificate from the system keychain. No user prompt, no wrong-cert mistakes.
- **Persistent per-profile sessions** - All session partitions use Chromium's `persist:` prefix, meaning cookies, localStorage, and IndexedDB survive browser restarts by default. Unlike Chrome (which clears session cookies on close unless "Continue where you left off" is enabled), Tappi never loses auth state accidentally.
- **Multi-identity isolation** - Per-(domain, username) session partitions allow simultaneous authenticated sessions on the same site without interference. No need for separate browser profiles.

### Extensions & Monitoring

- **CRX extension support** - Install Chrome extensions via unpacked directories or packed `.crx` files (CRX2 and CRX3). Extensions are loaded per-profile and persisted across restarts.
- **Native messaging bridge** - Local WebSocket server provides `chrome.runtime.connectNative()` support, enabling corporate extensions that communicate with native host processes.
- **Cookie API for extensions** - `chrome.cookies` polyfilled for MV3 service workers, so security and monitoring extensions operate as they would in managed Chrome.

### Why More Auth-Resilient Than Chrome?

| Feature | Chrome | Tappi | Impact |
|---|---|---|---|
| Session Persistence | Optional (user setting) | Always enabled | No accidental session loss |
| Kerberos Config | Group policy dependent | Settings UI, applied at startup | No IT overhead for auth setup |
| Client Cert Selection | User prompt dialog | Automatic (first cert) | Zero mTLS friction |
| Cookie Export/Import | Not supported | Full API | Profile migration and backup |
| Custom URL Schemes | May error on unknown schemes | Safe delegation to OS | Enterprise auth redirects work |
| Multi-Identity | Separate profiles required | Per-domain/user partitions | Simultaneous multi-account |

Chrome makes these trade-offs because its design priorities are shaped by Google's advertising business model: session cookies are cleared to manage tracking narratives, cookie APIs are restricted to control the third-party cookie ecosystem, and enterprise features require managed deployment infrastructure. These are reasonable for a consumer browser built by an ad company. But in enterprise environments where auth continuity, zero-friction SSO, and persistent sessions matter more than ad-ecosystem politics, Tappi's defaults are the right ones.

---

## Platform Support

| Platform | Arch | Status |
|----------|------|--------|
| macOS | arm64 (Apple Silicon) | ✅ Available |
| Windows | x64 | ✅ Available |
| Linux | x64 (rpm/deb/AppImage) | ✅ Available |

macOS Intel and Windows ARM64 builds available upon request.

---

## Keyboard Shortcuts

| Action | macOS | Windows/Linux |
|--------|-------|---------------|
| Open Settings | `⌘,` | `Ctrl+,` |
| New Tab | `⌘T` | `Ctrl+T` |
| Close Tab | `⌘W` | `Ctrl+W` |
| Agent Panel | `⌘J` | `Ctrl+J` |
| Find in Page | `⌘F` | `Ctrl+F` |
| Dark Mode | `⌘D` | `Ctrl+D` |

---

## FAQ

<details>
<summary><b>How is Tappi different from Playwright, Puppeteer, or browser-use?</b></summary>

Every CDP-based tool (Playwright, Puppeteer, browser-use, Selenium) remote-controls Chrome through a debugging protocol, which inherently sets `navigator.webdriver = true` - a flag that every major anti-bot system checks. These tools also expose a debugging port detectable via TLS fingerprinting and generate synthetic events that behavioral analysis catches.

Tappi is architecturally different: it IS a Chromium browser (Electron 35), not a client controlling one. The agent runs in the browser's main process and dispatches input through Chromium-native `sendInputEvent` APIs - the same code path that processes real keyboard and mouse events. No `navigator.webdriver`. No debugging port. No synthetic event signatures.
</details>

<details>
<summary><b>Will this work with enterprise SSO (Kerberos/SPNEGO) and mTLS?</b></summary>

Yes. Tappi implements Chromium-native Kerberos/SPNEGO negotiation via `auth-server-whitelist` and `auth-negotiate-delegate-whitelist` - the same authentication primitives Chrome uses for enterprise SSO, configured directly in the Settings UI instead of requiring group policy or MDM.

For mTLS, Tappi automatically selects the first available client certificate from the system keychain. Per-profile session partitions ensure complete cookie isolation, with cookies surviving browser restarts - providing resilient authenticated state persistence even across network transitions and VPN changes.
</details>

<details>
<summary><b>What's the token cost advantage?</b></summary>

Most AI browser agents dump entire DOM trees into LLM context - 50KB of HTML, 12,500+ tokens - just to "see" the page. Tappi uses referenced element indexing: it indexes interactive elements once and returns compact references like `[3] (button) Submit` instead of `<button class="btn btn-primary px-4 py-2 rounded-lg..." data-testid="submit-form-primary">`.

This produces **3-10x fewer tokens per interaction**. The indexer also pierces Shadow DOM (critical for modern web components) and caps output with grep-style filtering for busy pages. At scale, this token efficiency translates directly to significant API cost savings.
</details>

<details>
<summary><b>How does this compare to OpenAI Operator?</b></summary>

| | Tappi | OpenAI Operator |
|---|---|---|
| **Cost** | Free (MIT open source) | $200/month (ChatGPT Pro) |
| **LLM Providers** | 9 (incl. Bedrock, Ollama) | OpenAI only |
| **Source Code** | Fully auditable | Closed source |
| **Telemetry** | Zero | Full |
| **Shell Access** | Yes | No |
| **Persistent Learning** | Domain Playbooks | None |
| **Bulk Automation** | Scriptify + CSV | None |
| **Enterprise Auth** | Kerberos/SPNEGO, mTLS | None |
| **Bot Detection** | Undetectable (native browser) | CDP-based (detectable) |
</details>

<details>
<summary><b>Can I use this with cloud LLM providers like Bedrock, Vertex, or Azure?</b></summary>

Yes. Tappi has native support for 9 LLM backends: Anthropic, OpenAI, Google Gemini, AWS Bedrock (IAM auth), Vertex AI (Google ADC), Azure OpenAI, OpenRouter, Ollama (local), and Claude Code. The browser runs locally - API calls go directly to your chosen provider. Zero telemetry means no data is sent anywhere except the LLM endpoint you configure. For fully air-gapped environments, Ollama runs models on the same machine with zero network dependency.
</details>

<details>
<summary><b>What about security? It's open source.</b></summary>

Open source IS the security advantage. The entire codebase is auditable under MIT license. Specific measures:

- **Encrypted credentials** - API keys encrypted via OS keychain (macOS Keychain, Windows DPAPI, Linux Secret Service)
- **Password vault** - Never exposes raw passwords to the agent; autofill only via controlled scripts
- **API security** - Bearer token authentication for the localhost API with `0600` file permissions
- **Profile isolation** - Cookies, extensions, and storage never leak between profiles
- **Domain Playbooks** - Explicitly exclude passwords, tokens, and personal data; only structural navigation knowledge is captured
- **Zero telemetry** - No analytics, no error reporting, no cloud sync. Every byte of data stays on the machine.
</details>

<details>
<summary><b>Does it get smarter over time?</b></summary>

Yes - this is Tappi's most unique capability. **Domain Playbooks** automatically extract structural knowledge after every browsing session: URL patterns, UI navigation sequences, prerequisite steps, element-finding strategies, and anti-patterns. This knowledge is stored in versioned SQLite records and injected into the agent's context when it revisits that domain.

The first time the agent encounters a complex site, it might take several attempts. The second time, it walks straight to the correct URL and uses the right form values - because it already learned. Every session compounds.

**Scriptify** adds another layer: convert any successful conversation into a reusable, self-healing script with CSV bulk execution support - a workflow discovered once can be executed thousands of times.
</details>

<details>
<summary><b>Can it run existing Chrome extensions?</b></summary>

Yes. Tappi supports Chrome extensions via both unpacked directories and packed CRX files (CRX2 and CRX3 formats). Extensions are loaded per-profile and persisted across restarts. A native messaging bridge provides `chrome.runtime.connectNative()` support, and the `chrome.cookies` API is polyfilled for MV3 service workers.
</details>

<details>
<summary><b>Why is Tappi better for enterprise auth than Chrome?</b></summary>

Chrome is built by Google, whose primary revenue is advertising. Chrome's cookie and session behavior is architecturally shaped by this: third-party cookie deprecation was delayed multiple times to protect Google's ad business, session cookies are cleared on close by default to support Google's tracking-vs-privacy narrative, and Chrome syncs browsing data to Google's servers. Enterprise auth continuity is a secondary concern.

Tappi has no advertising business model, no telemetry, no sync servers. Cookie behavior is designed purely for the user's workflow. Specific advantages:

- **Cookies always persist** - All session partitions use `persist:` by default. Chrome clears session cookies on close unless "Continue where you left off" is enabled.
- **Kerberos config at startup** - Read from a local config file before the browser window opens. Chrome depends on Active Directory group policy push, which can be delayed or fail.
- **Auto cert selection** - mTLS just works. Chrome prompts users to pick a certificate, which causes confusion and errors.
- **Cookie export/import** - Full API for profile migration. Chrome has no equivalent.
- **Custom URL scheme handling** - Enterprise SSO redirects (e.g., device enrollment, auth callbacks) safely delegated to the OS. Chrome may error on non-HTTP schemes.
- **Multi-identity per domain** - Log into the same site with multiple accounts in separate tabs, each with fully isolated cookies. Chrome requires separate profiles.

The bottom line: Chrome's defaults protect Google's advertising business. Tappi's defaults protect your authenticated sessions.
</details>

---

## Open Source, Community-Driven

We have no VC funding. No board demanding growth metrics. No advertising business model to protect.

This is a **work of passion** - built because we wanted an AI browser that actually works, doesn't spy on us, and doesn't cost a fortune.

**Contributions welcome.** File issues, submit PRs, join the conversation.

- **GitHub:** [github.com/shaihazher/tappi-browser](https://github.com/shaihazher/tappi-browser)
- **Issues:** [github.com/shaihazher/tappi-browser/issues](https://github.com/shaihazher/tappi-browser/issues)

---

## License

MIT License. Use it, fork it, ship it.

---

## Documentation Index

| Guide | Description |
|-------|-------------|
| [Getting Started](docs/user-guide/getting-started.md) | Build, first-run, first conversation |
| [Browsing](docs/user-guide/browsing.md) | Tabs, navigation, bookmarks, dark mode |
| [AI Agent (Aria)](docs/user-guide/agent.md) | Agent panel, deep mode, tools |
| [Browser Profiles](docs/user-guide/profiles.md) | Create, switch, export/import |
| [Media Playback](docs/user-guide/media.md) | mpv overlay, YouTube enhancement |
| [Settings](docs/user-guide/settings.md) | All configuration options |
| [Keyboard Shortcuts](docs/user-guide/keyboard-shortcuts.md) | Complete reference |
| [Privacy & Security](docs/user-guide/privacy-security.md) | Local storage, encryption, BYOK |
| [Changelog](docs/changelog.md) | Release history |

---

Made with 🪷 by people who just wanted a faster browser.
