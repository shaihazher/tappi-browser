# Security — Known Risks

Tappi Browser is an AI-powered browser with agent capabilities. These are the known security considerations you should be aware of.

## 1. Developer Mode = Full System Access

Developer mode gives the AI agent unrestricted shell, filesystem, and browser access. This is by design — it's what makes the agent useful for development. Only enable it if you understand and accept this.

## 2. Prompt Injection

Malicious web pages can embed hidden instructions that attempt to influence the agent. With developer mode on, a successfully injected prompt could lead to unintended shell commands or file operations. No AI agent has a reliable defense against this today. Be mindful of what pages you visit while the agent is active.

## 3. Local API Access

Any process running as your OS user can read `~/.tappi-browser/api-token` and control the browser via the local API (port 18901). This is the same trust boundary as any desktop application. Protect your user session.

## 4. Credential Storage

Uses OS keychain (macOS Keychain, Windows DPAPI, Linux Secret Service) when available. On systems without a keyring daemon, credentials are stored with restrictive file permissions (`600`) but not encrypted at rest. A startup warning is shown when this occurs.

## 5. LLM Provider Data

Conversations — including page content and browsing data when agent browsing data access is enabled — are sent to your configured LLM provider (Anthropic, OpenAI, Google, etc.). Choose your provider accordingly. Self-hosted models via Ollama keep everything local.

## 6. Cron Jobs

Scheduled tasks run with the same capabilities as the main agent. A cron job created during a session persists and runs automatically. Review your cron jobs periodically (`Settings → Cron`).
