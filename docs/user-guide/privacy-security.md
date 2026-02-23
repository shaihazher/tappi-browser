# Privacy & Security

Tappi Browser is designed around a simple principle: **your data stays on your machine**. No telemetry, no cloud sync, no subscription accounts.

---

## What Is Stored Locally

All data lives in `~/.tappi-browser/` on your machine. Nothing is sent to Tappi's servers (there are none).

### Per-Profile SQLite Database (`database.sqlite`)

| Table | Contents |
|-------|----------|
| `history` | URL, page title, domain, visit timestamp, visit count |
| `bookmarks` | URL, title, folder, favicon, creation date, visit count |
| `downloads` | Filename, URL, local path, file size, status |
| `credentials` | Domain, username, **encrypted** password blob |
| `permissions` | Per-domain permission grants (e.g. microphone, geolocation) |
| `conversations` | Conversation IDs, titles, message counts, previews |
| `conversation_messages` | Role, content, timestamp, token estimate |
| `conversation_messages_fts` | FTS5 virtual table for full-text search over messages |

### Per-Profile Config Files

| File | Contents |
|------|----------|
| `config.json` | LLM provider, model, **encrypted** API key, feature toggles, search engine, timeouts |
| `api-keys.json` | External service API keys (encrypted) |
| `cron-jobs.json` | Scheduled agent task definitions |
| `user_profile.json` | Agent-generated browsing profile summary (only if Agent Browsing Data Access is on) |

---

## Encryption

### API Keys (`safeStorage`)

LLM API keys and external service API keys are encrypted using **Electron's `safeStorage`** before being written to disk. `safeStorage` delegates to the OS-level secret store:

- **macOS:** Keychain Services
- **Windows:** DPAPI (Data Protection API)
- **Linux:** libsecret (GNOME Keyring / KWallet)

Stored values are prefixed:

| Prefix | Meaning |
|--------|---------|
| `enc:` | Encrypted with safeStorage (normal case) |
| `raw:` | Plain text (fallback when safeStorage unavailable) |
| *(no prefix)* | Legacy format — Tappi attempts safeStorage decrypt, then treats as plain text |

If `safeStorage` is unavailable (e.g. no keychain daemon), keys fall back to plain-text storage with the `raw:` prefix. A console warning is logged in this case.

### Passwords (`safeStorage`)

Credentials stored in the password vault follow the same scheme. The `password_enc` column in the `credentials` table holds `vlt:`-prefixed safeStorage-encrypted blobs.

A `b64:`-prefixed Base64 fallback is used only when `safeStorage` is not available — this is **not encrypted**, merely obscured. Avoid relying on this fallback for sensitive credentials.

**The agent never sees raw passwords.** When Aria triggers autofill:
1. The main process decrypts the password internally.
2. A JavaScript snippet is injected into the page that fills the form fields.
3. Aria only receives confirmation ("Autofilled: username + password") — never the actual values.

### Profile Export Files (`.tappi-profile`)

Exported profile archives use **AES-256-GCM** with a **PBKDF2-derived key** (100,000 iterations, SHA-256, 32-byte random salt, 12-byte random IV). The encrypted payload is authenticated with a 16-byte GCM auth tag. A wrong password causes a decryption failure, not silent data corruption.

---

## No Telemetry

Tappi does not phone home. There are no:
- Analytics events
- Crash reporters
- Usage metrics
- Update check pings
- Cloud backup calls

The only outbound connections Tappi makes on your behalf are:
1. Requests to your LLM API provider (using your key, on your behalf).
2. Ad blocker list downloads (`easylist.to`) when the ad blocker is enabled.
3. Web pages you navigate to.
4. HTTP requests Aria makes when you ask her to.

---

## Bring Your Own Key (BYOK)

Tappi has no subscription and no Tappi-managed API proxy. Your API key is stored locally, encrypted, and sent **directly** to your chosen provider (Anthropic, OpenAI, etc.). Tappi is never in the request path — it builds and signs API calls client-side using your key.

---

## Agent Browsing Data Access

**Disabled by default.** When enabled (Settings → Privacy → Agent Browsing Data Access):

- Aria can read your browsing history, bookmarks, and download records.
- Tappi periodically generates a compact JSON profile summary (`user_profile.json`) that Aria injects into her context (~200 tokens) to personalise responses.
- Turning this setting **off** immediately deletes `user_profile.json`.

The agent cannot access cookies, localStorage, or any session data even when this toggle is on.

---

## Local HTTP API Server

When **Developer Mode** is enabled, Tappi starts a local HTTP server on **`127.0.0.1:18901`**.

Security properties:
- **Localhost only:** The server binds to `127.0.0.1`, refusing connections from any external interface.
- **Bearer token auth:** Every request must include `Authorization: Bearer <token>`. The token is a 64-character random hex string generated at first launch, stored at `~/.tappi-browser/api-token` with `0o600` file permissions (owner-read-only).
- **Rate limiting:** 100 requests per minute per IP address.
- **Developer Mode gate:** The server only runs when Developer Mode is explicitly enabled in Settings. Disabling Developer Mode stops the server.

If Developer Mode is off (the default), the API server is never started and port 18901 is never bound.

---

## Browser Session Isolation

Each browser profile uses a named Electron session partition (`persist:profile-<name>`), which isolates:
- Cookies
- LocalStorage / IndexedDB
- Cache
- Credentials (browser-level, distinct from Tappi's own password vault)

Per-site identities (multi-account support) use further sub-partitions (`persist:profile-<name>:site-<domain>-<username>`) for full cookie isolation between accounts on the same domain.

---

## No Plaintext Secrets in Logs

Tappi masks API keys in all log output and IPC messages. When the config is sent to the UI renderer (e.g. on settings open), API key values are replaced with `••••••••`. The raw key is only held in memory in the main process and passed to the LLM SDK at request time.

---

## Related Guides

- [Settings](settings.md) — where to find the privacy toggles
- [Browser Profiles](profiles.md) — profile export/import encryption details
- [AI Agent (Aria)](agent.md) — what context Aria receives
- [Getting Started](getting-started.md) — API key setup
