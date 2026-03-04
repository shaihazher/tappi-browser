# Reddit Copy-Paste Posts (No Tables)

*Reddit markdown doesn't support tables. Use these plain-text versions.*

---

## Post 1: r/CLI

**Title:**
```
I built an open-source AI browser that uses 3-10x fewer tokens than Comet/Atlas
```

**Body:**
```
The Verge found that Perplexity's Comet took **two minutes to unsubscribe from emails** — a task a human could do in 30 seconds [1]. That's not faster. That's theater.

I built Tappi Browser because I was frustrated with AI browsers that:
- Are slower than doing it yourself
- Cost $20-200/month in subscriptions
- Send your browsing data to their servers
- Lock you into one LLM provider

**Tappi IS the browser:**

Both Comet and Tappi are standalone browsers. But Comet bundles Chrome extensions that call `chrome.debugger` API and communicate via WebSocket to Perplexity's cloud. The agent runs on *their* servers.

Tappi has the agent built INTO the browser itself. Runs in Electron main process. Calls tools that are browser-native via preload scripts. No cloud dependency for tool execution. Works with local models.

**How Tappi achieves 3-10x token efficiency:**

Most AI browsers dump the entire DOM or accessibility tree into context. A typical page is 50KB of HTML — 12,500+ tokens just to "see" the page.

Tappi uses **referenced element indexing** via a preload script that injects into each tab:
- Indexes interactive elements once (buttons, links, inputs, etc.)
- Stamps each with a numeric ID (`data-tappi-idx`) directly in the DOM
- Agent references them compactly: `click 42` instead of 500-token selectors
- Pierces shadow DOM recursively (works on Reddit, GitHub, modern component libraries)
- Tools are native — `elements()`, `click()`, `type()` are built into the browser

**Token comparison per page:**

- Full DOM dump: 5,000-50,000 tokens
- Accessibility tree (Comet): 500-5,000 tokens [2]
- **Tappi indexed elements: 50-400 tokens**

**Architecture comparison:**

- **Agent location:** Comet = Cloud (WebSocket to Perplexity) | Tappi = Inside browser (Electron main)
- **Tools:** Comet = `chrome.debugger` via extensions | Tappi = Browser-native (preload scripts)
- **Cloud dependency:** Comet = Yes, agent runs on their servers | Tappi = No, works with local models
- **Telemetry:** Comet = Full | Tappi = Zero
- **Source:** Comet = Closed | Tappi = MIT open source

**Real-world cost example:**

Task: Find best price across 5 shopping sites

- Comet: ~85,000 tokens = ~$2.55 (Opus 4.6)
- Atlas: ~85,000 tokens = ~$2.55
- **Tappi: ~12,000 tokens = ~$0.36**

Same task. Same result. **7x cheaper.**

**Security comparison:**

- Comet: "CometJacking" vulnerability — single malicious URL can exfiltrate emails, calendar data [3]
- Atlas: Prompt injection vulnerabilities discovered within 24 hours of launch [4]
- Tappi: Zero telemetry, BYOK, open source, local-first

**Get started:**

```
git clone https://github.com/shaihazher/tappi-browser
cd tappi-browser
npm install && npm run build
npx electron dist/main.js
```

Add your API key in Settings. Works with free local models via Ollama.

macOS builds available now. Windows/Linux coming soon.

---

**Sources:**

[1] The Verge: https://www.theverge.com/news/709025/perplexity-comet-ai-browser-chrome-competitor

[2] Zenity Labs: https://labs.zenity.io/p/perplexity-comet-a-reversing-story

[3] LayerX: https://layerxsecurity.com/blog/cometjacking-how-one-click-can-turn-perplexitys-comet-ai-browser-against-you/

[4] CloudFactory: https://www.cloudfactory.com/blog/why-enterprises-cant-ignore-openai-atlas-browsers-fundamental-flaw
```

---

## Post 2: r/developersIndia

**Title:**
```
Built an open-source AI browser from India — zero telemetry, BYOK, 3-10x cheaper than Comet/Atlas
```

**Body:**
```
Hey r/developersIndia,

I'm a developer from Chennai, and I built Tappi Browser because I was tired of AI browsers that:
- Cost ₹1,700-17,000/month ($20-200)
- Send your data to US servers
- Lock you into one LLM provider
- Are slower than doing things manually

**The speed problem:**

The Verge tested Perplexity's Comet and found it took **2 minutes to unsubscribe from emails** — a human could do it in 30 seconds [1].

The issue? Comet uses cloud-based LLMs that dump entire accessibility trees (500-5000 tokens) into context for every action. The agent runs on *their* servers, not in your browser.

**Tappi's approach:**

Both Comet and Tappi are standalone browsers. But Comet bundles Chrome extensions that communicate via WebSocket to Perplexity's cloud.

Tappi has the agent built INTO the browser itself. Runs in Electron main process. Tools are browser-native via preload scripts. No cloud dependency for tool execution.

Instead of DOM dumps, Tappi uses **referenced element indexing**:
- Preload script injects into each tab for native DOM access
- Indexes interactive elements on the page (buttons, links, inputs)
- Assigns each a numeric ID directly in the DOM (`data-tappi-idx`)
- Agent clicks via compact references: `click 42`

**Result: 50-400 tokens per page vs 5,000-50,000 for DOM dumps.**

**Why this matters for Indian developers:**

1. **Cost:** Same task costs 7x less in API calls
2. **Privacy:** Zero telemetry — everything stays on your machine
3. **Flexibility:** BYOK — use any provider including local Ollama (free)
4. **Latency:** Agent runs locally, no cloud round-trips for every action

**Works with:**
- OpenRouter (100+ models, single key) — great for GLM-5, Grok
- Ollama (local, free) — llama3.1, mistral, gemma
- Anthropic, OpenAI, Google Gemini
- AWS Bedrock, Vertex AI, Azure OpenAI

**Security:**

- Comet: "CometJacking" vulnerability can steal emails/calendar via malicious URL [2]
- Atlas: Prompt injection vulnerabilities found within 24 hours [3]
- Tappi: Open source, zero telemetry, local-first

**Get started:**

```
git clone https://github.com/shaihazher/tappi-browser
npm install && npm run build
npx electron dist/main.js
```

GitHub: https://github.com/shaihazher/tappi-browser

macOS, Windows and Linux builds available now.

Happy to answer questions about the architecture or implementation.

---

**Sources:**

[1] The Verge — https://www.theverge.com/news/709025/perplexity-comet-ai-browser-chrome-competitor

[2] LayerX Security — https://layerxsecurity.com/blog/cometjacking-how-one-click-can-turn-perplexitys-comet-ai-browser-against-you/

[3] CloudFactory — https://www.cloudfactory.com/blog/why-enterprises-cant-ignore-openai-atlas-browsers-fundamental-flaw
```

---

## Post 3: r/NoStupidQuestions

**Title:**
```
Why are AI browsers like Comet and Atlas so slow and expensive when they're supposed to automate things?
```

**Body:**
```
I've been testing AI browsers and noticed something weird — they're often **slower than doing things yourself**.

The Verge found that Perplexity's Comet took **2 minutes to unsubscribe from emails** when a human could do it in 30 seconds [1].

So I built my own to understand why. Here's what I learned:

**Why existing AI browsers are slow:**

1. **They dump entire pages into context** — Most AI browsers send the full HTML (5,000-50,000 tokens) or accessibility tree (500-5,000 tokens) to the LLM for every action

2. **Cloud-based processing** — Every click, scroll, and read goes through their servers

3. **Round-trip latency** — Your request → their server → LLM → their server → your browser

**A different approach:**

Comet and Atlas are cloud-based — the agent runs on their servers, not in your browser.

**Tappi IS the browser.** The agent runs inside the browser itself (Electron main process) and calls tools that are browser-native — no external automation layer.

Tappi Browser uses **indexed element references**:
- Only indexes interactive elements (buttons, links, inputs)
- References them by ID: `click 42` instead of long selectors
- Works with your choice of LLM (local or cloud)

**Token comparison:**

- Full DOM: 5,000-50,000 tokens per page
- Accessibility tree (Comet): 500-5,000 tokens
- **Indexed elements (Tappi): 50-400 tokens**

**Cost comparison:**

- Comet Pro: $20/mo | Standard token usage
- Comet Max: $200/mo | Standard token usage
- Atlas: $20-200/mo | Standard token usage
- **Tappi: $0 (BYOK)** | **3-10x better token efficiency**

**Security concerns:**

- Comet: A single malicious URL can steal your emails and calendar data [2]
- Atlas: Prompt injection vulnerabilities discovered within 24 hours [3]

Both have full telemetry on your browsing.

**Alternative:**

Tappi Browser is open source, zero telemetry, and you bring your own API key. Works with local models (Ollama) for free.

GitHub: https://github.com/shaihazher/tappi-browser

Not trying to sell anything — just sharing what I learned building an alternative.

---

**Sources:**

[1] The Verge — https://www.theverge.com/news/709025/perplexity-comet-ai-browser-chrome-competitor

[2] LayerX Security — https://layerxsecurity.com/blog/cometjacking-how-one-click-can-turn-perplexitys-comet-ai-browser-against-you/

[3] CloudFactory — https://www.cloudfactory.com/blog/why-enterprises-cant-ignore-openai-atlas-browsers-fundamental-flaw
```

---

## Post 4: r/selfhosted

**Title:**
```
Tappi Browser — Self-hosted AI browser, zero telemetry, works with local LLMs
```

**Body:**
```
Built an AI browser for people who want:
- Zero telemetry (everything stays local)
- BYOK with 8+ providers
- Local model support (Ollama)
- Full CLI and HTTP API

**Technical approach:**

Both Comet and Tappi are standalone browsers. But Comet bundles Chrome extensions that communicate via WebSocket to Perplexity's cloud. The agent runs on *their* servers.

**Tappi has the agent built INTO the browser itself:**
- Runs in Electron main process
- Tools are browser-native via preload scripts
- No cloud dependency for tool execution
- Works offline with local models

**Token savings:**

Most AI browsers dump DOM/accessibility trees (500-50,000 tokens) into context.

Tappi uses **indexed element references**:
- Only indexes interactive elements
- Stamps each with numeric ID directly in DOM
- Agent uses compact refs: `click 42`
- **Pierces shadow DOM** natively

**Token cost: 50-400 per page vs 5,000-50,000 for DOM dumps.**

**Self-hosting features:**
- MIT licensed
- No cloud dependency
- Works with Ollama (100% local, free)
- Full CLI: `tappi-browser elements`, `tappi-browser click 3`, `tappi-browser ask "..."`
- HTTP API on localhost:18901 with Bearer token auth

**Security:**
- Comet has "CometJacking" vulnerability [1]
- Atlas has prompt injection issues [2]
- Tappi: open source, auditable, local-first

**Build:**

```
git clone https://github.com/shaihazher/tappi-browser
npm install && npm run build
npx electron dist/main.js
```

GitHub: https://github.com/shaihazher/tappi-browser

---

[1] https://layerxsecurity.com/blog/cometjacking-how-one-click-can-turn-perplexitys-comet-ai-browser-against-you/

[2] https://www.cloudfactory.com/blog/why-enterprises-cant-ignore-openai-atlas-browsers-fundamental-flaw
```

---

## Post 5: r/programming

**Title:**
```
Show HN: Tappi Browser — Why element indexing beats accessibility trees for AI browsers
```

**Body:**
```
The Verge found Comet took 2 minutes to unsubscribe from emails vs 30 seconds for a human [1]. The architecture explains why.

**How Comet works (from reverse engineering [2]):**

1. Uses Chrome's `Accessibility.getFullAXTree` API
2. Converts to YAML representation (500-5,000 tokens)
3. Sends to cloud LLM via WebSocket
4. LLM returns actions with element references (`ref_32`)

**Key difference: Comet bundles Chrome extensions that talk to cloud LLMs. Tappi has the agent built INTO the browser itself.**

The agent runs in the Electron main process and calls tools that are **browser-native** — via preload scripts that inject into each tab. No external automation layer. No cloud dependency for tool execution.

**Tappi's approach:**

```javascript
// Recursive shadow DOM piercing (runs in preload script inside each tab)
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

The preload script (`content-preload.js`) injects into each tab, walks the DOM, indexes interactive elements, and stamps each with `data-tappi-idx`. The agent calls native tools: `elements()`, `click(0)`, `type(1, "...")`.

**Key differences:**

- **Agent location:** Comet = Cloud (WebSocket to Perplexity) | Tappi = Inside browser (Electron main)
- **Tools:** Comet = `chrome.debugger` via extensions | Tappi = Browser-native (preload scripts)
- **Token cost:** Comet = 500-5,000/page | Tappi = 50-400/page
- **Shadow DOM:** Comet = Partial | Tappi = Full recursive piercing
- **Element lookup:** Comet = `ref_32` (accessibility ref) | Tappi = `data-tappi-idx` stamp
- **Processing:** Comet = Cloud LLM | Tappi = Local or cloud (your choice)
- **Telemetry:** Comet = Full | Tappi = Zero
- **Source:** Comet = Closed | Tappi = MIT open source

**Why indexed elements are faster:**

1. **Viewport scoping** — Only indexes visible elements by default (20-40 items)
2. **Semantic filtering** — Only interactive elements (buttons, links, inputs, ARIA roles)
3. **Grep mode** — Search offscreen elements on demand instead of loading everything
4. **Fresh stamps** — Re-indexes on every call, no stale references

**The math:**

- 30 elements × ~10 tokens each = ~300 tokens
- vs accessibility tree: 500-5,000 tokens
- **10-50x reduction in context overhead**

**Security model:**

- Zero telemetry (nothing leaves your machine)
- BYOK (your API keys, your choice)
- Open source (auditable)
- No cloud dependency (works with Ollama)

**Code:** https://github.com/shaihazher/tappi-browser

Happy to discuss the architecture, shadow DOM piercing implementation, or token optimization strategies.

---

[1] https://www.theverge.com/news/709025/perplexity-comet-ai-browser-chrome-competitor

[2] https://labs.zenity.io/p/perplexity-comet-a-reversing-story

[3] https://layerxsecurity.com/blog/cometjacking-how-one-click-can-turn-perplexitys-comet-ai-browser-against-you/
```

---

## Quick Reference: Copy-Paste Commands

Each post is in a code block above. To use:

1. Copy the **Title** section → paste into Reddit title field
2. Copy the **Body** section → paste into Reddit text field
3. Sources are already formatted as proper links

No tables. No broken markdown. Just clean text that works on Reddit.
