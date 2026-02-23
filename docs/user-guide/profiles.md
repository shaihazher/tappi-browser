# Browser Profiles

Browser profiles give you fully isolated browsing identities — each with its own cookies, history, bookmarks, saved credentials, conversation history, and settings.

---

## What Profiles Isolate

Each profile has its own directory under `~/.tappi-browser/profiles/<name>/`:

| Data | File / Location |
|------|----------------|
| Settings & LLM config | `config.json` |
| SQLite database (history, bookmarks, credentials, conversations) | `database.sqlite` |
| Service API keys | `api-keys.json` |
| Scheduled cron jobs | `cron-jobs.json` |
| Agent-generated browsing profile summary | `user_profile.json` |
| Browser session (cookies, localStorage, IndexedDB) | Electron session partition `persist:profile-<name>` |

Switching profiles reloads the database and config — previous profile's data is untouched.

---

## Default Profile

Tappi starts with a **default** profile. Existing data (from installs before profiles were introduced) is automatically migrated to `profiles/default/` on first launch.

---

## Creating a Profile

1. Press **`⌘,`** → **Settings** → **Profiles** tab.
2. Click **New Profile**.
3. Enter a profile name (letters, numbers, `@`, `.`, `-`, `_`). An email address works well as a profile name.
4. Click **Create**.

The new profile directory is created immediately with an empty database and no config. You'll need to add an API key for the new profile after switching to it.

---

## Switching Profiles

**From Settings → Profiles:** Click **Switch** next to any profile.

**From the profile menu:** Click the profile badge in the tab bar (top-left area) to open a native menu listing all profiles. Click any profile name to switch instantly.

Switching profiles:
1. Closes the current profile's database.
2. Opens the new profile's SQLite database.
3. Loads the new profile's `config.json`.
4. Clears the in-memory agent conversation history.
5. Clears site-identity session state.

> **Note:** Tab content (already-loaded pages) is not reloaded on profile switch. New navigations will use the new profile's session partition.

---

## Deleting a Profile

1. Settings → **Profiles** tab.
2. Click **Delete** next to the profile you want to remove.

Restrictions:
- The **default** profile cannot be deleted.
- The **currently active** profile cannot be deleted. Switch to another profile first.

Deletion permanently removes the profile directory and all its data. There is no undo.

---

## Export & Import

### Exporting a Profile

Profiles can be exported as encrypted `.tappi-profile` files — useful for backups or moving to another machine.

1. Settings → **Profiles** tab → click **Export** next to the profile.
2. Enter a password (used to encrypt the export).
3. Choose a save location. The file will have a `.tappi-profile` extension.

The export format:
- Bundles all profile files (config, database, API keys, cron jobs, user profile).
- Compresses with gzip.
- Encrypts with **AES-256-GCM** using a **PBKDF2-derived key** (100,000 iterations, SHA-256, 32-byte salt).
- File header magic: `TPPI` (4 bytes) + version (4 bytes) + salt + IV + auth tag + ciphertext.

### Importing a Profile

1. Settings → **Profiles** tab → click **Import Profile**.
2. Select a `.tappi-profile` file.
3. Enter the password used when exporting.
4. If a profile with the same name already exists, the imported profile is renamed with a timestamp suffix.

The imported profile appears in the profile list and can be switched to immediately.

---

## Per-Site Identities (Multi-Account)

Within a single profile you can maintain **multiple identities for the same website** — for example, two different Twitter/X accounts.

This feature is accessible via the agent: ask Aria to "open Twitter as @second_account" and she can create a site-scoped session partition (`persist:profile-<name>:site-<domain>-<username>`) that keeps cookies isolated per username per site.

Stored identities (username list per domain) are visible in the agent's context hints when you visit a site with multiple saved accounts.

---

## Related Guides

- [Privacy & Security](privacy-security.md) — how profile data is encrypted and isolated
- [Settings](settings.md) — per-profile LLM config
- [AI Agent (Aria)](agent.md) — agent browsing data access toggle
