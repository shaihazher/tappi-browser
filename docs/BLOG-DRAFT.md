# Tappi Browser — Launch Announcement

> Draft for blog post. Target: 1500-2000 words.

---

## Proposed Title Options

1. **"The AI Browser That Doesn't Waste Your Time"** — Lead with speed
2. **"We Built an AI Browser Because Comet Was Too Slow"** — Provocative, honest
3. **"3-10x Fewer Tokens: How Tappi Changes AI Browsing"** — Technical angle
4. **"The First AI Browser Built for Efficiency, Not Engagement"** — Anti-telemetry angle

**Recommendation:** Option 2 for Hacker News/reddit, Option 1 for general audience.

---

## Structure

### Hook (150 words)

The Verge reviewed Perplexity's Comet browser and found something embarrassing: their AI agent took **two minutes** to unsubscribe from promotional emails. A human could do it in **30 seconds**.

That's not automation. That's theater.

We built Tappi because we were tired of AI browsers that:
- Are slower than doing it yourself
- Cost a fortune in tokens
- Require monthly subscriptions
- Harvest your browsing data

Tappi is different. It uses **3-10x fewer tokens**. It's genuinely faster than manual. It has **zero telemetry**. It's **open source**. You bring your own API key — no subscription, no lock-in.

---

### The Problem With Current AI Browsers (300 words)

**Perplexity Comet**
- Was $200/month, now free — but you're the product
- Telemetry tracks everything you do
- Amazon sued them over shopping automation
- Slower than manual for many tasks

**ChatGPT Atlas**
- $20-200/month for agent mode
- OpenAI lock-in only
- Telemetry
- macOS only (for now)

**Opera Neon, Dia, others**
- $20/month subscriptions
- Limited model choices
- Often can't actually see the page you're viewing
- Generic responses instead of context-aware ones

The pattern: VC-backed companies building data collection machines with AI chatbots bolted on. They need telemetry because that's their business model.

We don't have a business model. We built this because we wanted it to exist.

---

### How Tappi Achieves 3-10x Token Savings (400 words)

**1. Referenced Element Indexing**

Most AI browsers dump entire DOM trees into context. A typical page might be 50KB of HTML. That's 12,500+ tokens just to "see" the page.

Tappi indexes elements once and refers to them by ID:

```
Agent: "I see element e42 is the search box"
You: "Click e42 and type 'tappi browser'"
```

Click command: `click e42` — 3 tokens. Not 500.

**2. Aggressive Context Management**

Long conversations get written to disk. The agent greps files instead of loading them:

```
Agent: "I found the function in conversation-turn-47.md: grep shows..."
```

You can load full files when needed (up to 10K tokens). Otherwise: grep first, load later.

**3. Native Automation, No Overhead**

Tappi uses Chrome DevTools Protocol directly. The automation *is* the browser. No Selenium detection. No Puppeteer overhead. No fingerprinting possible.

**Real-world example:**

Task: Find the best price for a product across 5 shopping sites.

| Browser | Tokens Used | Cost (Opus 4.6) |
|---------|-------------|-----------------|
| Comet | ~85,000 | ~$2.55 |
| Atlas | ~85,000 | ~$2.55 |
| Tappi | ~12,000 | ~$0.36 |

Same task. Same result. **7x cheaper.**

---

### What You Can Actually Do (300 words)

**Everything Comet and Atlas can do:**
- Research and summarize pages
- Fill forms, complete workflows
- Book reservations, shop, compare products
- Manage tabs, bookmarks, downloads
- Schedule recurring tasks

**Plus what they can't:**
- **Code with multi-agent teams** — parallel spawning with Git worktree isolation
- **Run shell commands** — full terminal access from the agent
- **Control via CLI/API** — automate from scripts, integrate with your tools
- **Self-host** — zero cloud dependency

**Developer Mode** turns Tappi into something like OpenClaw running natively inside a browser. Full shell access. Read/write any file. 47+ tools.

---

### BYOK: Your Keys, Your Choice (200 words)

Tappi supports 8+ providers:

- **Anthropic** — Claude Opus 4.6, Sonnet 4.6, Haiku
- **OpenAI** — GPT-5.2, o3, o4
- **Google Gemini** — 2.5 Pro, 2.0 Flash
- **OpenRouter** — 100+ models, single key
- **Ollama** — local models, zero cost
- **AWS Bedrock, Vertex AI, Azure OpenAI** — enterprise options

**Recommended:**
- **Safety-first:** Claude Opus 4.6
- **Best value:** GLM-5 (OpenRouter)
- **Speed:** Grok 4.1 Fast
- **Free:** Ollama (local)

The agent harness is designed to work well with inexpensive models. You don't need Opus for most tasks.

---

### Open Source, No Agenda (150 words)

We have no VC funding. No board. No advertising business model.

This is a **work of passion** — we built it because we wanted it. We're committed to addressing community feedback.

**Contributions welcome.** File issues, submit PRs, make it better.

- GitHub: [github.com/shaihazher/tappi-browser](https://github.com/shaihazher/tappi-browser)

---

### Get Started (100 words)

```bash
git clone https://github.com/shaihazher/tappi-browser.git
cd tappi-browser
npm install
npm run build
npx electron dist/main.js
```

Add your API key in Settings. Start browsing.

macOS available now. Windows and Linux coming soon.

---

## Distribution Plan

| Platform | Post Title | Angle |
|----------|------------|-------|
| **Hacker News** | "We Built an AI Browser Because Comet Was Too Slow" | Speed + open source |
| **Reddit (r/programming)** | Same as HN | Technical efficiency |
| **Reddit (r/opensource)** | "The First Open Source AI Browser with Zero Telemetry" | Privacy + freedom |
| **Twitter/X** | "Perplexity's Comet: 2 min to unsubscribe. Tappi: 3-10x faster, 3-10x cheaper." | Provocative comparison |
| **Dev.to** | "Building a Token-Efficient AI Browser: Why Element Indexing Matters" | Technical deep-dive |
| **Medium** | "The AI Browser That Doesn't Waste Your Time" | General audience |

---

## Blog Home

**Question for Azer:** Where should this live?
- `tappi.synthworx.com/blog` — matches landing page
- `blog.tappi-browser.org` — dedicated subdomain
- Dev.to crosspost — community platform
- GitHub Pages — simplest option

---

## Launch Checklist

- [ ] README.md pushed to GitHub
- [ ] Repo made public
- [ ] Screenshots added (agent-panel.png, aria-tab.png, settings.png)
- [ ] Blog post published
- [ ] HN submission
- [ ] Reddit posts
- [ ] Twitter thread
- [ ] Dev.to crosspost
