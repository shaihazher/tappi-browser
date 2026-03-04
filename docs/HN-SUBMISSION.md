# Hacker News Submission Draft

## Post at: 7:00 PM IST (Thursday, Feb 26, 2026)

---

## Submission URL

https://news.ycombinator.com/submit

---

## Title (copy exactly)

```
Show HN: Tappi Browser – Open source AI browser, 3-10x fewer tokens, zero telemetry
```

---

## URL

```
https://github.com/shaihazher/tappi-browser
```

---

## First Comment (post immediately after submission)

I built Tappi because I was frustrated with AI browsers that are slower than doing things yourself.

**The speed problem:**

The Verge tested Perplexity's Comet and found it took **2 minutes to unsubscribe from emails** — a human could do it in 30 seconds. [1]

The architecture explains why. Zenity Labs reverse-engineered Comet and found it uses Chrome's Accessibility API, converting pages to YAML-formatted accessibility trees (500-5,000 tokens per page) that get sent to cloud LLMs via WebSocket. [2]

**Key difference: Comet is a Chromium browser with bundled extensions that talk to cloud LLMs. Tappi has the agent built INTO the browser itself.**

Both are standalone browsers. But Comet uses 3 bundled Chrome extensions (`comet-agent`, `perplexity.crx`, etc.) that call `chrome.debugger` API and communicate via WebSocket to Perplexity's cloud. The agent doesn't run in the browser — it runs on their servers.

Tappi's agent runs **inside the Electron main process** and calls tools that are **browser-native** — via preload scripts that inject into each tab. No cloud round-trips for tool execution. Works with local models via Ollama.

**Tappi's approach:**

Instead of DOM/accessibility tree dumps, Tappi uses **indexed element references**:

1. Preload script (`content-preload.js`) injects into each tab renderer
2. Walks DOM with recursive shadow DOM piercing
3. Indexes only interactive elements (buttons, links, inputs, ARIA roles)
4. Stamps each with a numeric ID (`data-tappi-idx`) directly in the DOM
5. Agent references them compactly: `click 42` instead of 500-token selectors

**Token comparison:**
| Approach | Tokens per page |
|----------|-----------------|
| Full DOM dump | 5,000-50,000 |
| Accessibility tree (Comet) | 500-5,000 |
| Indexed elements (Tappi) | 50-400 |

**Key differentiators:**

- **Zero telemetry** — everything stays local
- **BYOK** — works with Anthropic, OpenAI, Gemini, OpenRouter, Ollama, Bedrock, Vertex, Azure
- **Local models** — Ollama support means $0 cost
- **Full CLI + HTTP API** — programmatic control
- **Security** — no cloud dependency, open source

**Security context:**

- Comet has "CometJacking" — a single malicious URL can exfiltrate emails/calendar [3]
- Atlas had prompt injection vulnerabilities discovered within 24 hours of launch [4]
- Tappi: zero telemetry, BYOK, auditable

**Get started:**
```bash
git clone https://github.com/shaihazher/tappi-browser
npm install && npm run build
npx electron dist/main.js
```

macOS available now. Windows/Linux builds coming soon.

Happy to answer questions about the architecture, shadow DOM piercing implementation, or token optimization.

---

**Sources:**
[1] The Verge: https://www.theverge.com/news/709025/perplexity-comet-ai-browser-chrome-competitor
[2] Zenity Labs: https://labs.zenity.io/p/perplexity-comet-a-reversing-story
[3] LayerX: https://layerxsecurity.com/blog/cometjacking-how-one-click-can-turn-perplexitys-comet-ai-browser-against-you/
[4] CloudFactory: https://www.cloudfactory.com/blog/why-enterprises-cant-ignore-openai-atlas-browsers-fundamental-flaw

---

## Tips for HN Success

1. **Be present for the first 30-60 minutes** - Answer comments quickly
2. **Don't beg for upvotes** - It gets you flagged
3. **Be honest about limitations** - HN appreciates transparency
4. **If someone points out a flaw** - Acknowledge it, don't get defensive
5. **Thank people** - Even critical feedback is valuable

---

## Common HN Questions to Prepare For

| Question | Suggested Answer |
|----------|------------------|
| "How is this different from Comet/Atlas?" | Tappi IS the browser — agent runs inside Electron main process, tools are browser-native. Comet is a Chrome extension, Atlas is ChatGPT integration. Plus: token efficiency, zero telemetry, BYOK, open source. |
| "Why Electron?" | Agent + browser in one process. Tools are native via preload scripts. No external CDP layer. Full DOM access inside each tab. |
| "Why not accessibility tree?" | Verbose (500-5000 tokens), partial shadow DOM. Indexed elements get 10-50x savings and full shadow DOM piercing. |
| "Can I use it without an API key?" | Yes — Ollama for local models, zero cost |
| "Is it production ready?" | macOS is solid. Windows/Linux coming soon. Contributions welcome. |
| "What about Comet's 'human-in-the-loop'?" | Comet still has cloud dependency and CometJacking vulnerability. Tappi keeps everything local — agent IS the browser. |
| "Is this just Puppeteer/Playwright with an LLM?" | No — Puppeteer/Playwright are external automation layers. Tappi's tools run INSIDE the browser via preload scripts. The agent calls native browser functions, not external APIs. |

---

## Technical Backup (for deep-dive questions)

**Architecture: Tappi IS the browser**

```
┌─────────────────────────────────────────────────────────────┐
│  Electron Main Process (Node.js)                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ agent.ts    │  │ tool-registry│  │ llm-client.ts      │  │
│  │ (Vercel AI) │──│ (47+ tools) │──│ (Anthropic/OpenAI/ │  │
│  └─────────────┘  └─────────────┘  │  Gemini/Ollama/...) │  │
│         │                          └─────────────────────┘  │
│         │ IPC                                               │
│         ▼                                                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Tab Renderer (WebContentsView)                       │   │
│  │ ┌─────────────────────────────────────────────────┐ │   │
│  │ │ content-preload.js                              │ │   │
│  │ │ - window.__tappi.indexElements()                │ │   │
│  │ │ - window.__tappi.clickElement(idx)              │ │   │
│  │ │ - Recursive shadow DOM piercing                 │ │   │
│  │ │ - data-tappi-idx stamps                         │ │   │
│  │ └─────────────────────────────────────────────────┘ │   │
│  │                   │                                  │   │
│  │                   ▼                                  │   │
│  │              [Web Page DOM]                          │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**vs. Comet:**
```
┌─────────────────┐         WebSocket          ┌─────────────────┐
│ Chrome Browser  │ ──────────────────────────▶│ Perplexity API  │
│ + Extension     │                            │ (Cloud LLM)     │
└─────────────────┘ ◀──────────────────────────└─────────────────┘
                      Accessibility tree YAML
                      (500-5000 tokens/page)
```

**Shadow DOM piercing implementation (runs inside each tab):**
```javascript
function deepQueryAll(root, selectors) {
  const results = [];
  results.push(...root.querySelectorAll(selectors));
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) {
      results.push(...deepQueryAll(el.shadowRoot, selectors));
    }
  }
  return results;
}
```

**Why accessibility trees are verbose:**
- Include ALL nodes, not just interactive ones
- Contain structural metadata (parent/child relationships)
- Don't natively pierce shadow DOM on all sites
- Comet's approach: `Accessibility.getFullAXTree` → YAML

**Tappi's viewport scoping:**
- Only visible elements indexed by default (20-40 items)
- Offscreen elements counted but not loaded
- `grep` mode for searching offscreen elements
- Modal detection: dialog elements prioritized

---

## Timing

- Post at 7:00 PM IST = 8:30 AM EST = optimal HN window
- Reminder will fire at 7 PM IST via OpenClaw
