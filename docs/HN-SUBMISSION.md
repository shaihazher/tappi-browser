# Hacker News Submission Draft

## Post at: 7:00 PM IST (Thursday, Feb 26, 2026)

---

## Submission URL

https://news.ycombinator.com/submit

---

## Title (copy exactly)

```
Show HN: Tappi Browser - Open source AI browser, 3-10x fewer tokens
```

---

## URL

```
https://github.com/shaihazher/tappi-browser
```

---

## First Comment (post immediately after submission)

```
I built Tappi because I was frustrated with AI browsers that:

- Are slower than doing things manually (Comet took 2 minutes to unsubscribe from emails - a human could do it in 30 seconds)
- Cost a fortune in tokens
- Require monthly subscriptions
- Harvest browsing data

Tappi is different:

- 3-10x fewer tokens via referenced element indexing (no DOM dumps)
- Zero telemetry - everything stays local
- Open source (MIT)
- BYOK - works with Anthropic, OpenAI, Gemini, OpenRouter, Ollama, Bedrock, Vertex, Azure
- Full CLI and HTTP API for programmatic control
- Developer mode with shell access

The key innovation: instead of dumping 50KB HTML into context, we index elements once and reference them by ID. Click commands become `click e42` instead of 500-token selectors.

Happy to answer questions about the architecture, token efficiency approach, or anything else.

GitHub: https://github.com/shaihazher/tappi-browser
```

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
| "How is this different from Comet/Atlas?" | Zero telemetry, open source, BYOK, 3-10x token efficiency, CLI/API control, shell access |
| "Why Electron?" | Fastest way to ship a cross-platform browser. CDP-native automation works great. |
| "What about performance?" | Element indexing is the key. No DOM parsing in the hot path. |
| "Can I use it without an API key?" | Yes! Use Ollama for local models, zero cost. |
| "Is it production ready?" | macOS is solid. Windows/Linux builds coming soon. Open to contributions. |

---

## Timing

- Post at 7:00 PM IST = 8:30 AM EST = optimal HN window
- Reminder will fire at 7 PM IST via OpenClaw
