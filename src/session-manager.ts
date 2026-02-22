/**
 * session-manager.ts — Electron session partition manager.
 *
 * Manages named session partitions for:
 *   - Per-profile isolation: `persist:profile-{name}`
 *   - Per-site multi-identity: `persist:profile-{name}:site-{domain}-{username}`
 *
 * Phase 8.4.6
 */

import { session } from 'electron';
import { profileManager } from './profile-manager';

export interface SiteIdentity {
  domain: string;
  username: string;
  partition: string;
}

export class SessionManager {
  private static instance: SessionManager;

  // Track which site-identity sessions have been created
  private activeSiteIdentities: Map<string, SiteIdentity[]> = new Map(); // domain → identities

  private constructor() {}

  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  /** Get (or create) the session partition for the active profile */
  getProfileSession(profileName?: string): Electron.Session {
    const partition = profileManager.getSessionPartition(profileName);
    return session.fromPartition(partition);
  }

  /** Get session partition string for the active profile */
  getProfilePartition(profileName?: string): string {
    return profileManager.getSessionPartition(profileName);
  }

  /** Get (or create) a site-scoped session for a specific identity */
  getSiteIdentitySession(domain: string, username: string, profileName?: string): Electron.Session {
    const partition = profileManager.getSiteSessionPartition(domain, username, profileName);
    return session.fromPartition(partition);
  }

  /** Get site-scoped session partition string */
  getSiteIdentityPartition(domain: string, username: string, profileName?: string): string {
    return profileManager.getSiteSessionPartition(domain, username, profileName);
  }

  /**
   * Register a site-identity session so the agent knows about it.
   */
  registerSiteIdentity(domain: string, username: string): void {
    if (!this.activeSiteIdentities.has(domain)) {
      this.activeSiteIdentities.set(domain, []);
    }
    const list = this.activeSiteIdentities.get(domain)!;
    if (!list.find(i => i.username === username)) {
      list.push({
        domain,
        username,
        partition: this.getSiteIdentityPartition(domain, username),
      });
    }
  }

  /** Get all registered identities for a domain */
  getSiteIdentities(domain: string): SiteIdentity[] {
    return this.activeSiteIdentities.get(domain) || [];
  }

  /** Clear registered site identities (e.g. on profile switch) */
  clearSiteIdentities(): void {
    this.activeSiteIdentities.clear();
  }

  /**
   * Export cookies from a session to a JSON-serializable array.
   * Used for profile export (Phase 8.4.5).
   */
  async exportCookies(partition: string): Promise<Electron.Cookie[]> {
    try {
      const ses = session.fromPartition(partition);
      return await ses.cookies.get({});
    } catch (e) {
      console.error('[session] Failed to export cookies:', e);
      return [];
    }
  }

  /**
   * Import cookies into a session.
   * Used for profile import (Phase 8.4.5).
   */
  async importCookies(partition: string, cookies: any[]): Promise<void> {
    try {
      const ses = session.fromPartition(partition);
      for (const cookie of cookies) {
        try {
          // Cookies need a url to set
          const scheme = cookie.secure ? 'https' : 'http';
          const url = `${scheme}://${cookie.domain?.startsWith('.') ? cookie.domain.slice(1) : cookie.domain}${cookie.path || '/'}`;
          await ses.cookies.set({
            url,
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            expirationDate: cookie.expirationDate,
            sameSite: cookie.sameSite,
          });
        } catch {
          // Skip invalid cookies
        }
      }
    } catch (e) {
      console.error('[session] Failed to import cookies:', e);
    }
  }

  /**
   * Clear all data for a session partition.
   * Used when deleting a profile.
   */
  async clearSession(partition: string): Promise<void> {
    try {
      const ses = session.fromPartition(partition);
      await ses.clearStorageData();
      await ses.clearCache();
    } catch (e) {
      console.error('[session] Failed to clear session:', e);
    }
  }
}

export const sessionManager = SessionManager.getInstance();
