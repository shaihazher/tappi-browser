/**
 * login-state.ts — Shared login-detection hint store.
 *
 * Keyed by webContents ID. Main process writes hints when content-preload
 * detects a login form. Agent reads hints during context assembly.
 *
 * Lives in its own module to avoid circular imports between main.ts ↔ agent.ts.
 */

interface LoginHintEntry {
  domain: string;
  hint: string;
  detectedAt: number;
}

const loginHints = new Map<number, LoginHintEntry>();

/** 5-minute TTL — page may have navigated away */
const HINT_TTL_MS = 5 * 60 * 1000;

export function setLoginHint(wcId: number, domain: string, hint: string): void {
  loginHints.set(wcId, { domain, hint, detectedAt: Date.now() });
}

export function getLoginHint(wcId: number): string | null {
  const entry = loginHints.get(wcId);
  if (!entry) return null;
  if (Date.now() - entry.detectedAt > HINT_TTL_MS) {
    loginHints.delete(wcId);
    return null;
  }
  return entry.hint;
}

export function clearLoginHint(wcId: number): void {
  loginHints.delete(wcId);
}
