---
title: "We Built an AI Browser Because Comet Was Too Slow"
published: false
description: "Tappi Browser is open source, uses 3-10x fewer tokens, has zero telemetry, and is genuinely faster than doing things yourself."
tags: ["ai", "browser", "opensource", "llm"]
cover_image: https://raw.githubusercontent.com/shaihazher/tappi-browser/main/screenshots/aria-tab.png
---

# We Built an AI Browser Because Comet Was Too Slow

The Verge reviewed Perplexity's Comet browser and found something embarrassing: their AI agent took **two minutes** to unsubscribe from promotional emails. A human could do it in **30 seconds**.

That's not automation. That's theater.

We built Tappi because we were tired of AI browsers that are slower than doing it yourself, cost a fortune in tokens, require monthly subscriptions, and harvest your browsing data.

Tappi is different:
- **3-10x fewer tokens** than competitors
- **Zero telemetry** — nothing leaves your machine
- **Open source** — MIT licensed, fork it, ship it
- **BYOK** — bring your own API key, no subscription
- **Genuinely faster** — we measured

## The Problem With Current AI Browsers

The AI browser market exploded in 2025. Perplexity launched Comet in July. OpenAI launched Atlas in October. Opera relaunched Neon. The Browser Company announced Dia. Everyone wants to be the "AI browser."

But they all share the same problems:

### They're Slower Than Manual

The Verge found Comet took 2 minutes to unsubscribe from emails — 4x slower than doing it yourself. Why? Because most AI browsers dump entire DOM trees into the LLM context. A typical page might be 50KB of HTML. That's 12,500+ tokens just to "see" the page, then more tokens to figure out what to click, then more tokens to actually click it.

### They Cost a Fortune

If you're burning 80K+ tokens per task, you're paying $2-3 per task with premium models. That adds up fast. Comet was $200/month before going free (but you're now the product). Atlas charges $20-200/month for agent mode.

### They Harvest Your Data

Every major AI browser has telemetry. They're VC-backed companies with boards demanding growth. Your browsing data is valuable. They collect it because that's their business model.

### They Lock You In

Comet only works with Perplexity's models. Atlas only works with OpenAI. Want to try Claude? Too bad. Want to run a local model? Can't do it.

### Architecture Comparison

Both Comet and Tappi are standalone browsers. But the architecture is fundamentally different:

| Aspect | Comet | Atlas | Tappi |
|--------|-------|-------|-------|
| **Base** | Chromium + bundled extensions | ChatGPT integration | **Electron browser** |
| **Agent location** | Cloud (WebSocket to Perplexity API) | Cloud | **Inside browser (Electron main)** |
| **Tools** | `chrome.debugger` via extensions | ChatGPT tools | **Browser-native (preload scripts)** |
| **Page representation** | Accessibility tree YAML | DOM-based | **Indexed elements** |
| **Token cost per page** | 500-5,000 | 5,000-50,000 | **50-400** |
| **Shadow DOM** | Partial | Limited | **Full piercing** |
| **Cloud dependency** | Yes — agent runs on their servers | Yes | **No — BYOK, local models work** |
| **Telemetry** | Full | Full | **Zero** |
| **Source** | Closed | Closed | **MIT open source** |

Comet bundles 3 Chrome extensions (`comet-agent`, `perplexity.crx`, etc.) that use `chrome.debugger` API and communicate via WebSocket to Perplexity's cloud. The agent runs on their servers.

Tappi's agent runs **inside the browser itself** (Electron main process). Tools are native via preload scripts. No cloud dependency for tool execution.

## How Tappi Achieves 3-10x Token Savings

We designed Tappi differently from the ground up.

### 1. Referenced Element Indexing

Most AI browsers dump entire DOM trees into context — 50KB of HTML, 12,500+ tokens, just to "see" the page.

Tappi uses a preload script (`content-preload.js`) that injects into each tab and:

1. Walks the DOM with **recursive shadow DOM piercing**
2. Indexes only interactive elements (buttons, links, inputs, ARIA roles)
3. Stamps each with a numeric ID (`data-tappi-idx`) directly in the DOM
4. Agent references them compactly: `click 42` instead of 500-token selectors

**Result:** 50-400 tokens per page vs 5,000-50,000 for DOM dumps.

### 2. Aggressive Context Management

Long conversations get written to disk. The agent greps files instead of loading them:

```
Agent: "I found the function in conversation-turn-47.md — grep shows it's on line 234"
```

You can load full files when needed (up to 10K tokens). Otherwise: grep first, load later.

### 3. Tappi IS the Browser

Both Comet and Tappi are standalone browsers. But Comet bundles Chrome extensions that use `chrome.debugger` API and communicate via WebSocket to Perplexity's cloud LLMs. The agent runs on their servers.

Tappi has the AI agent built **into the browser itself**. The agent runs in the Electron main process and calls tools that are **browser-native** — via preload scripts that inject into each tab. No cloud dependency for tool execution.

This means:
- Tools run inside the browser, not as an external automation layer
- Shadow DOM piercing works natively (Reddit, GitHub, modern component frameworks)
- No fingerprinting possible — there's nothing to detect
- Zero latency between agent decision and browser action

### A Real-World Comparison

Task: Find the best price for a product across 5 shopping sites.

| Browser | Tokens Used | Cost (Claude Opus 4.6) |
|---------|-------------|------------------------|
| Perplexity Comet | ~85,000 | ~$2.55 |
| ChatGPT Atlas | ~85,000 | ~$2.55 |
| **Tappi Browser** | ~12,000 | ~$0.36 |

Same task. Same result. **7x cheaper.**

And because Tappi doesn't need to parse giant DOM dumps, it's genuinely faster — often faster than doing it manually.

## What Can You Do?

Everything Comet and Atlas can do — plus what they can't:

**Core Browsing:**
- Research and summarize any page
- Fill forms, complete workflows, book reservations
- Shop, compare products, find best prices
- Manage tabs, bookmarks, downloads
- Schedule recurring tasks with cron
- Take screenshots and record tabs

**Developer Power:**
- Code with multi-agent teams (parallel spawning)
- Run shell commands from the agent
- Control via CLI or HTTP API
- Self-host, zero cloud dependency

### Developer Mode

Toggle **Developer Mode** in Settings to unlock:
- Shell access — the agent can run `exec` commands
- Full filesystem — read/write any file on your machine
- Unrestricted tools — all 47+ tools available

This turns Tappi into something like a terminal-based agent running natively inside a browser. Use responsibly.

## CLI & API: Full Programmatic Control

Tappi ships with a local HTTP API (port 18901) and a CLI that wraps it:

```bash
# List tabs
tappi-browser tabs

# Navigate
tappi-browser open https://github.com

# Index elements
tappi-browser elements

# Click and type
tappi-browser click 3
tappi-browser type 3 "hello world"

# Ask the agent
tappi-browser ask "Summarize this page"

# Stream responses
tappi-browser ask --stream "What's the main point?"

# Run shell commands (dev mode)
tappi-browser exec "ls ~/Downloads"
```

Full API documentation: [docs/api/overview.md](https://github.com/shaihazher/tappi-browser/blob/main/docs/api/overview.md)

## BYOK: Your Keys, Your Choice

Tappi supports 8+ providers:

| Provider | Models |
|----------|--------|
| **Anthropic** | Claude Opus 4.6, Sonnet 4.6, Haiku 4.5 |
| **OpenAI** | GPT-5.2, o3, o4, GPT-4o |
| **Google Gemini** | Gemini 2.5 Pro, 2.0 Flash |
| **OpenRouter** | 100+ models with a single key |
| **Ollama** | Local models — llama3.1, mistral, gemma |
| **AWS Bedrock** | Claude, Titan, Llama via AWS |
| **Vertex AI** | Gemini models via GCP |
| **Azure OpenAI** | GPT deployments |

**Our recommendations:**
- **Safety-first:** Claude Opus 4.6 — best reasoning, lowest hallucination
- **Best value:** GLM-5 via OpenRouter — excellent price/performance
- **Speed:** Grok 4.1 Fast — fast, cheap, surprisingly capable
- **Free:** Ollama — runs on your hardware, zero cost

The agent harness is designed to work well with inexpensive models. You don't need Opus for most tasks.

## Open Source, No Agenda

We have no VC funding. No board demanding growth metrics. No advertising business model.

This is a **work of passion** — we built it because we wanted an AI browser that actually works, doesn't spy on us, and doesn't cost a fortune.

**Contributions welcome.** File issues, submit PRs, make it better.

GitHub: [github.com/shaihazher/tappi-browser](https://github.com/shaihazher/tappi-browser)

## Get Started

```bash
git clone https://github.com/shaihazher/tappi-browser.git
cd tappi-browser
npm install
npm run build
npx electron dist/main.js
```

Add your API key in Settings (`⌘,` on macOS, `Ctrl+,` on Windows/Linux). Start browsing.

macOS available now. Windows and Linux coming soon.

---

## Why We Built This

We're not a company. We don't have a product roadmap driven by revenue targets. We're developers who got frustrated with AI browsers that promised the world and delivered... slow, expensive, privacy-invasive automation.

We wanted:
- **Speed** — automation should be faster than manual
- **Efficiency** — tokens cost money; we shouldn't waste them
- **Privacy** — our browsing data is ours
- **Freedom** — use any model we want
- **Power** — shell access, coding, real automation

So we built it.

If this resonates with you, give it a try. Star the repo. File issues. Submit PRs. Help us make it better.

---

**Links:**
- GitHub: [github.com/shaihazher/tappi-browser](https://github.com/shaihazher/tappi-browser)
- Documentation: [docs/](https://github.com/shaihazher/tappi-browser/tree/main/docs)
- Issues: [github.com/shaihazher/tappi-browser/issues](https://github.com/shaihazher/tappi-browser/issues)

---

Made with 🪷 by people who just wanted a faster browser.
