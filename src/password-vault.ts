/**
 * password-vault.ts — Encrypted credential storage + autofill.
 *
 * Uses safeStorage for encryption, SQLite for persistence.
 * Agent triggers autofill but never sees raw passwords.
 */

import { safeStorage } from 'electron';
import { saveCredential, getCredentials, deleteCredential, listCredentialDomains, updateCredentialLastUsed } from './database';
import * as crypto from 'crypto';
import * as fs from 'fs';

const ENC_PREFIX = 'vlt:';

// ─── Encryption ───

function encryptPassword(password: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(password).toString('base64');
    }
  } catch (e) {
    console.error('[vault] Encryption unavailable:', e);
  }
  // Fallback: base64 encode (not secure, but functional)
  console.warn('[security] OS keychain unavailable — credentials stored with file permissions only (chmod 600)');
  return 'b64:' + Buffer.from(password).toString('base64');
}

function decryptPassword(stored: string): string {
  if (stored.startsWith(ENC_PREFIX)) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'));
      }
    } catch {
      console.error('[vault] Decrypt failed');
    }
    return '';
  }
  if (stored.startsWith('b64:')) {
    return Buffer.from(stored.slice(4), 'base64').toString('utf-8');
  }
  return '';
}

// ─── Public API ───

export function storePassword(domain: string, username: string, password: string): void {
  const enc = encryptPassword(password);
  saveCredential(domain, username, enc);

  // If safeStorage is unavailable, ensure credential files have restrictive permissions
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      const dbPath = require('path').join(process.env.HOME || process.env.USERPROFILE || '.', '.tappi-browser', 'tappi.db');
      if (fs.existsSync(dbPath)) {
        fs.chmodSync(dbPath, 0o600);
      }
    }
  } catch {}

  console.log(`[vault] Stored credentials for ${username}@${domain}`);
}

export function getPasswordsForDomain(domain: string): Array<{ id: number; username: string; last_used: number }> {
  // Returns metadata only — no passwords exposed
  return getCredentials(domain).map(c => ({
    id: c.id,
    username: c.username,
    last_used: c.last_used,
  }));
}

/**
 * Get the actual password for autofill purposes.
 * This is used internally by the autofill system — never exposed to the agent.
 */
export function getPasswordForAutofill(domain: string, username: string): { username: string; password: string } | null {
  const creds = getCredentials(domain);
  const match = creds.find(c => c.username === username) || creds[0];
  if (!match) return null;

  const password = decryptPassword(match.password_enc);
  if (!password) return null;

  updateCredentialLastUsed(match.id);
  return { username: match.username, password };
}

export function removePassword(id: number): void {
  deleteCredential(id);
}

export function listSavedDomains(): string[] {
  return listCredentialDomains();
}

/**
 * List all credentials for a domain — returns metadata only, never passwords.
 * Supports multiple credentials per domain (different usernames).
 * Includes the numeric row ID so users can reference it for delete.
 */
export function listCredentials(domain: string): Array<{ id: number; username: string; created_at: string }> {
  return getCredentials(domain).map(c => ({
    id: c.id,
    username: c.username,
    created_at: new Date(c.created_at || c.last_used || 0).toISOString(),
  }));
}

/**
 * Return just the usernames for a domain — used for agent context hints.
 */
export function listIdentities(domain: string): string[] {
  return getCredentials(domain).map(c => c.username);
}

export function generatePassword(length = 20): string {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

/**
 * Build the JavaScript to inject into a page for autofill.
 * Fills username and password fields without exposing credentials to the agent.
 */
export function buildAutofillScript(username: string, password: string): string {
  // Escape for safe injection
  const safeUser = JSON.stringify(username);
  const safePass = JSON.stringify(password);

  return `
    (function() {
      // Find login form fields
      const inputs = document.querySelectorAll('input');
      let userField = null, passField = null;

      for (const input of inputs) {
        const type = (input.type || '').toLowerCase();
        const name = (input.name || '').toLowerCase();
        const id = (input.id || '').toLowerCase();
        const auto = (input.autocomplete || '').toLowerCase();
        const placeholder = (input.placeholder || '').toLowerCase();

        if (type === 'password' || auto === 'current-password' || auto === 'new-password') {
          passField = input;
        } else if (
          type === 'email' || type === 'text' || type === 'tel' ||
          auto === 'username' || auto === 'email' ||
          name.includes('user') || name.includes('email') || name.includes('login') ||
          id.includes('user') || id.includes('email') || id.includes('login') ||
          placeholder.includes('email') || placeholder.includes('username')
        ) {
          userField = input;
        }
      }

      function fillField(field, value) {
        if (!field) return false;
        field.focus();
        field.value = value;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }

      const filled = [];
      if (fillField(userField, ${safeUser})) filled.push('username');
      if (fillField(passField, ${safePass})) filled.push('password');

      return filled.length > 0
        ? 'Autofilled: ' + filled.join(' + ')
        : 'No login fields found on this page.';
    })()
  `;
}

/**
 * Build JavaScript to detect a login form submission and extract credentials.
 * This runs in the content preload to intercept form submissions.
 */
export function buildCredentialInterceptScript(): string {
  return `
    (function() {
      if (window.__tappi_credentialWatcher) return;
      window.__tappi_credentialWatcher = true;

      document.addEventListener('submit', function(e) {
        const form = e.target;
        if (!form || form.tagName !== 'FORM') return;

        const inputs = form.querySelectorAll('input');
        let username = '', password = '';

        for (const input of inputs) {
          const type = (input.type || '').toLowerCase();
          const name = (input.name || '').toLowerCase();
          const auto = (input.autocomplete || '').toLowerCase();
          const placeholder = (input.placeholder || '').toLowerCase();

          if (type === 'password' || auto === 'current-password') {
            password = input.value;
          } else if (
            (type === 'email' || type === 'text' || type === 'tel') &&
            (auto === 'username' || auto === 'email' ||
             name.includes('user') || name.includes('email') || name.includes('login') ||
             placeholder.includes('email') || placeholder.includes('username'))
          ) {
            username = input.value;
          }
        }

        if (username && password) {
          // Send to main process via IPC
          window.__tappi_reportCredential && window.__tappi_reportCredential({
            domain: location.hostname,
            username: username,
            hasPassword: true
          });
        }
      }, true);
    })()
  `;
}
