# T11 — User Profile Testing (Tappi Browser)

**Date:** 2026-02-22  
**Method:** Source code analysis (`src/user-profile.ts`, `src/agent.ts`, `src/main.ts`)  
**Approach:** Static analysis (API-based live testing skipped due to known PATCH /api/config bug)

---

## Results Summary

| ID | Test | Status | Notes |
|----|------|--------|-------|
| T11.1 | Profile generation logic | ✅ PASS | Full pipeline implemented |
| T11.2 | Token limit (≤200) | ✅ PASS | Enforced with retry + ~4 chars/token estimate |
| T11.3 | Context injection in agent | ✅ PASS | Injected as `[User Profile: {...}]` in system context |
| T11.4 | 24h staleness check | ✅ PASS | `isStale()` checks `updated_at` against 24h threshold |
| T11.5 | Privacy cleanup (delete profile) | ✅ PASS | `deleteProfile()` called on toggle-off in `main.ts` |
| T11.6 | Config bug (known) | ⚠️ KNOWN BUG | PATCH /api/config has no IPC listener — live toggle untestable via API |

---

## Detailed Findings

### T11.1 — Profile Generation (`src/user-profile.ts`)

**Status: ✅ PASS**

`generateProfile(db, llmConfig)` implements a full pipeline:

1. **Browsing data query** via `getBrowsingDataSummary(db)`:
   - Top 100 domains by frequency from `history` table (last 7 days)
   - Top 50 most recent visits (last 7 days)
   - Top 100 bookmarks from `bookmarks` table
2. **LLM call** via Vercel AI SDK `generateText()` with a structured prompt
3. **JSON validation** — parses response, strips markdown fences, retries if invalid
4. **Saves to disk** at profile-relative path (`getUserProfilePath()`, defaults to `~/.tappi-browser/user_profile.json`)

Generation is fire-and-forget via `scheduleProfileUpdate()` with a 5-second startup delay.

```
Profile shape:
{
  interests, frequent_sites (top 5), work_context,
  preferred_sources, shopping_patterns, locale_hints, updated_at
}
```

---

### T11.2 — Token Limit (`src/user-profile.ts`)

**Status: ✅ PASS**

Token constraint is enforced at multiple levels:

- **Constant:** `MAX_TOKENS = 200`, `MAX_CHARS = 800`
- **Estimation:** `estimateTokens(text)` = `Math.ceil(text.length / 4)` (~1 token ≈ 4 chars)
- **Prompt instruction:** `"≤200 tokens"` in the base prompt
- **Post-generation check:** If `estimateTokens(profileStr) > 200`, retries with a `strictPrompt` that adds:  
  > `"CRITICAL: Output must be under 200 tokens. Use very short values. No explanations."`
- **LLM `maxOutputTokens`:** 400 on first attempt, 300 on retry

---

### T11.3 — Context Injection (`src/agent.ts`)

**Status: ✅ PASS**

In `assembleContext()` (called every agent turn), the injection block:

```typescript
const config = (browserCtx as any).config as { privacy?: { agentBrowsingDataAccess?: boolean } } | undefined;
const accessEnabled = config?.privacy?.agentBrowsingDataAccess === true;
if (accessEnabled) {
  const profile = loadProfile();
  if (profile) {
    const { updated_at, ...compactProfile } = profile;
    parts.push('', `[User Profile: ${JSON.stringify(compactProfile)}]`);
  }
}
```

- Only injects when `agentBrowsingDataAccess === true` (privacy gate)
- Strips `updated_at` from the injected JSON (token efficiency)
- Format: `[User Profile: {...}]` appended to the context block

The context block is injected into the **last user message** of each turn (not the system prompt directly), keeping it fresh per-turn.

---

### T11.4 — Staleness Check (`src/user-profile.ts`)

**Status: ✅ PASS**

```typescript
export function isStale(profile: UserProfile): boolean {
  const updated = new Date(profile.updated_at).getTime();
  const now = Date.now();
  return now - updated > 24 * 60 * 60 * 1000;
}
```

- Exactly 24 hours (86,400,000 ms)
- Called in `scheduleProfileUpdate()` before deciding whether to re-generate:
  ```typescript
  const existing = loadProfile();
  if (existing && !isStale(existing)) {
    console.log('[user-profile] Profile is fresh, skipping update');
    return;
  }
  ```

---

### T11.5 — Privacy Cleanup (`src/main.ts`)

**Status: ✅ PASS**

In the IPC config update handler (around line 941–947):

```typescript
const prevAccess = currentConfig.privacy?.agentBrowsingDataAccess;
currentConfig.privacy = { ...currentConfig.privacy, ...updates.privacy };
const newAccess = currentConfig.privacy?.agentBrowsingDataAccess;

// If access was just turned OFF, delete the generated profile
if (prevAccess && !newAccess) {
  deleteProfile();
}

// If access was just turned ON, schedule a profile generation
if (!prevAccess && newAccess) {
  // schedules new generation with secondary model
}
```

`deleteProfile()` in `user-profile.ts`:
```typescript
export function deleteProfile(): void {
  const profilePath = getUserProfilePath();
  if (fs.existsSync(profilePath)) {
    fs.unlinkSync(profilePath);
    console.log('[user-profile] Profile deleted (browsing data access disabled)');
  }
}
```

Cleanup is reactive (triggered by config change), not on-demand.

---

### T11.6 — Config API Bug (Known)

**Status: ⚠️ KNOWN BUG — Not a T11 defect**

- `PATCH /api/config` sends an IPC event but no listener is registered in `main.ts` to handle it
- This was discovered in T13/T15 testing
- **Impact on T11:** The privacy toggle (`agentBrowsingDataAccess`) cannot be flipped via the REST API, so `deleteProfile()` cleanup (T11.5) and on-demand profile generation cannot be triggered through external test scripts
- The code logic is correct — the bug is in API wiring only
- Live verification of T11.5 requires the browser UI or direct IPC access

---

## Notes

- **Storage path:** Profile-relative via `profileManager.getUserProfilePath()`, fallback to `~/.tappi-browser/user_profile.json`
- **Generation trigger:** On startup (5s delay) via `scheduleProfileUpdate()` in `main.ts` line 500–502 — only if `agentBrowsingDataAccess` is enabled
- **Secondary model used for generation** (Phase 8.85 — cheaper/faster model for non-interactive background task)
- **No profile file found** at `~/.tappi-browser/profiles/default/user_profile.json` at time of testing (generation requires `agentBrowsingDataAccess` to be enabled in config, and browsing history to exist)
