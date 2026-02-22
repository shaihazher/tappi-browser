/**
 * profile-manager.ts — Browser profile management for Tappi Browser.
 *
 * Manages isolated browser profiles with per-profile:
 *   - SQLite database (history, bookmarks, credentials, etc.)
 *   - config.json, api-keys.json, cron-jobs.json, user_profile.json
 *   - Electron session partition (cookies/storage isolation)
 *
 * Directory structure:
 *   ~/.tappi-browser/
 *   ├── profiles/
 *   │   ├── default/
 *   │   │   ├── config.json
 *   │   │   ├── database.sqlite
 *   │   │   └── ...
 *   │   └── user@email.com/
 *   │       └── ...
 *   ├── active_profile  ← name of active profile
 *   └── profiles.json   ← profile registry
 */

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as zlib from 'zlib';

export interface ProfileInfo {
  name: string;           // profile identifier (e.g. "default" or "user@email.com")
  displayName: string;    // human-readable label
  email?: string;
  createdAt: string;      // ISO date
  lastUsed: string;       // ISO date
  isActive: boolean;
}

export interface ProfileRegistry {
  profiles: ProfileInfo[];
  defaultProfile: string;
}

const BASE_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.tappi-browser');
const PROFILES_DIR = path.join(BASE_DIR, 'profiles');
const ACTIVE_PROFILE_PATH = path.join(BASE_DIR, 'active_profile');
const PROFILES_REGISTRY_PATH = path.join(BASE_DIR, 'profiles.json');

export class ProfileManager {
  private static instance: ProfileManager;
  private activeProfileName: string = 'default';
  private registry: ProfileRegistry = { profiles: [], defaultProfile: 'default' };

  private constructor() {}

  static getInstance(): ProfileManager {
    if (!ProfileManager.instance) {
      ProfileManager.instance = new ProfileManager();
    }
    return ProfileManager.instance;
  }

  /**
   * Initialize the profile system. Must be called once at app startup.
   * Migrates existing data to the default profile if needed.
   */
  initialize(): void {
    // Ensure base directories exist
    if (!fs.existsSync(BASE_DIR)) fs.mkdirSync(BASE_DIR, { recursive: true });
    if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });

    // Load or create registry
    this.registry = this.loadRegistry();

    // Migrate existing data if no profiles exist yet
    if (this.registry.profiles.length === 0) {
      this.migrateExistingData();
    }

    // Ensure default profile exists
    this.ensureProfileExists('default', 'Default');

    // Load active profile from disk
    if (fs.existsSync(ACTIVE_PROFILE_PATH)) {
      const stored = fs.readFileSync(ACTIVE_PROFILE_PATH, 'utf-8').trim();
      if (stored && this.getProfileDir(stored) && fs.existsSync(this.getProfileDir(stored))) {
        this.activeProfileName = stored;
      }
    }

    // Save active profile to disk
    fs.writeFileSync(ACTIVE_PROFILE_PATH, this.activeProfileName, 'utf-8');
    this.updateLastUsed(this.activeProfileName);

    console.log(`[profile] Active profile: ${this.activeProfileName}`);
  }

  /** Migrate existing ~/.tappi-browser/ files to profiles/default/ */
  private migrateExistingData(): void {
    const defaultDir = path.join(PROFILES_DIR, 'default');
    if (!fs.existsSync(defaultDir)) fs.mkdirSync(defaultDir, { recursive: true });

    const filesToMigrate = [
      'config.json', 'api-keys.json', 'cron-jobs.json',
      'user_profile.json', 'tappi.db',
    ];

    for (const file of filesToMigrate) {
      const src = path.join(BASE_DIR, file);
      const dest = path.join(defaultDir, file === 'tappi.db' ? 'database.sqlite' : file);
      if (fs.existsSync(src) && !fs.existsSync(dest)) {
        try {
          fs.copyFileSync(src, dest);
          console.log(`[profile] Migrated ${file} → profiles/default/`);
        } catch (e) {
          console.error(`[profile] Migration failed for ${file}:`, e);
        }
      }
    }

    console.log('[profile] Migration to default profile complete');
  }

  private loadRegistry(): ProfileRegistry {
    try {
      if (fs.existsSync(PROFILES_REGISTRY_PATH)) {
        return JSON.parse(fs.readFileSync(PROFILES_REGISTRY_PATH, 'utf-8'));
      }
    } catch {}
    return { profiles: [], defaultProfile: 'default' };
  }

  private saveRegistry(): void {
    try {
      fs.writeFileSync(PROFILES_REGISTRY_PATH, JSON.stringify(this.registry, null, 2));
    } catch (e) {
      console.error('[profile] Failed to save registry:', e);
    }
  }

  private ensureProfileExists(name: string, displayName: string, email?: string): ProfileInfo {
    const existing = this.registry.profiles.find(p => p.name === name);
    if (existing) return existing;

    const now = new Date().toISOString();
    const profile: ProfileInfo = {
      name,
      displayName,
      email,
      createdAt: now,
      lastUsed: now,
      isActive: name === this.activeProfileName,
    };

    this.registry.profiles.push(profile);
    this.saveRegistry();

    // Create profile directory
    const dir = this.getProfileDir(name);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    return profile;
  }

  private updateLastUsed(name: string): void {
    const profile = this.registry.profiles.find(p => p.name === name);
    if (profile) {
      profile.lastUsed = new Date().toISOString();
      this.saveRegistry();
    }
  }

  /** Get the directory for a profile */
  getProfileDir(name?: string): string {
    return path.join(PROFILES_DIR, name || this.activeProfileName);
  }

  /** Get path to the active profile's SQLite database */
  getDatabasePath(profileName?: string): string {
    return path.join(this.getProfileDir(profileName), 'database.sqlite');
  }

  /** Get path to the active profile's config.json */
  getConfigPath(profileName?: string): string {
    return path.join(this.getProfileDir(profileName), 'config.json');
  }

  /** Get path to the active profile's api-keys.json */
  getApiKeysPath(profileName?: string): string {
    return path.join(this.getProfileDir(profileName), 'api-keys.json');
  }

  /** Get path to the active profile's cron-jobs.json */
  getCronJobsPath(profileName?: string): string {
    return path.join(this.getProfileDir(profileName), 'cron-jobs.json');
  }

  /** Get path to the active profile's user_profile.json */
  getUserProfilePath(profileName?: string): string {
    return path.join(this.getProfileDir(profileName), 'user_profile.json');
  }

  /** Get Electron session partition string for a profile */
  getSessionPartition(profileName?: string): string {
    const name = profileName || this.activeProfileName;
    return `persist:profile-${name}`;
  }

  /** Get site-scoped session partition for multi-identity */
  getSiteSessionPartition(domain: string, username: string, profileName?: string): string {
    const name = profileName || this.activeProfileName;
    return `persist:profile-${name}:site-${domain}-${username}`;
  }

  get activeProfile(): string {
    return this.activeProfileName;
  }

  /** List all profiles */
  listProfiles(): ProfileInfo[] {
    return this.registry.profiles.map(p => ({
      ...p,
      isActive: p.name === this.activeProfileName,
    }));
  }

  /** Create a new profile */
  createProfile(name: string, email?: string): ProfileInfo | { error: string } {
    // Sanitize name
    const safeName = name.trim().replace(/[^a-zA-Z0-9@._-]/g, '_');
    if (!safeName) return { error: 'Invalid profile name' };
    if (this.registry.profiles.find(p => p.name === safeName)) {
      return { error: `Profile "${safeName}" already exists` };
    }

    const displayName = email || safeName;
    return this.ensureProfileExists(safeName, displayName, email);
  }

  /**
   * Switch to a different profile.
   * Returns the new profile info. Caller must reinitialize database and config.
   */
  switchProfile(name: string): ProfileInfo | { error: string } {
    const profile = this.registry.profiles.find(p => p.name === name);
    if (!profile) return { error: `Profile "${name}" not found` };

    this.activeProfileName = name;
    fs.writeFileSync(ACTIVE_PROFILE_PATH, name, 'utf-8');
    this.updateLastUsed(name);

    console.log(`[profile] Switched to: ${name}`);
    return { ...profile, isActive: true };
  }

  /** Delete a profile (cannot delete active profile or default) */
  deleteProfile(name: string): { success: boolean; error?: string } {
    if (name === 'default') return { success: false, error: 'Cannot delete the default profile' };
    if (name === this.activeProfileName) return { success: false, error: 'Cannot delete the active profile. Switch first.' };

    const idx = this.registry.profiles.findIndex(p => p.name === name);
    if (idx === -1) return { success: false, error: `Profile "${name}" not found` };

    // Remove from registry
    this.registry.profiles.splice(idx, 1);
    this.saveRegistry();

    // Remove directory
    const dir = this.getProfileDir(name);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log(`[profile] Deleted profile: ${name}`);
    return { success: true };
  }

  // ─── Phase 8.4.5: Export/Import ───

  /**
   * Export a profile to an encrypted .tappi-profile file.
   * Uses AES-256-GCM with PBKDF2-derived key (100K iterations).
   */
  async exportProfile(profileName: string, password: string, outputPath: string): Promise<{ success: boolean; error?: string }> {
    try {
      const dir = this.getProfileDir(profileName);
      if (!fs.existsSync(dir)) return { success: false, error: 'Profile directory not found' };

      // Build bundle object
      const bundle: Record<string, any> = {
        version: 1,
        profileName,
        exportedAt: new Date().toISOString(),
        files: {} as Record<string, string>,
      };

      // Bundle text files
      const textFiles = ['config.json', 'api-keys.json', 'cron-jobs.json', 'user_profile.json'];
      for (const file of textFiles) {
        const fp = path.join(dir, file);
        if (fs.existsSync(fp)) {
          bundle.files[file] = fs.readFileSync(fp, 'utf-8');
        }
      }

      // Bundle SQLite database as base64
      const dbPath = path.join(dir, 'database.sqlite');
      if (fs.existsSync(dbPath)) {
        bundle.files['database.sqlite'] = fs.readFileSync(dbPath).toString('base64');
        bundle.dbIsBase64 = true;
      }

      // Serialize and compress
      const json = JSON.stringify(bundle);
      const compressed = zlib.gzipSync(Buffer.from(json, 'utf-8'));

      // Encrypt: AES-256-GCM with PBKDF2
      const salt = crypto.randomBytes(32);
      const iv = crypto.randomBytes(12);
      const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');

      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
      const authTag = cipher.getAuthTag();

      // Format: [4 bytes magic][4 bytes version][32 bytes salt][12 bytes iv][16 bytes tag][ciphertext]
      const magic = Buffer.from('TPPI');
      const version = Buffer.alloc(4);
      version.writeUInt32BE(1, 0);

      const output = Buffer.concat([magic, version, salt, iv, authTag, encrypted]);
      fs.writeFileSync(outputPath, output);

      console.log(`[profile] Exported profile "${profileName}" to ${outputPath}`);
      return { success: true };
    } catch (e: any) {
      console.error('[profile] Export failed:', e);
      return { success: false, error: e.message };
    }
  }

  /**
   * Import a profile from an encrypted .tappi-profile file.
   */
  async importProfile(filePath: string, password: string): Promise<{ success: boolean; profileName?: string; error?: string }> {
    try {
      const data = fs.readFileSync(filePath);

      // Parse header
      const magic = data.slice(0, 4).toString('ascii');
      if (magic !== 'TPPI') return { success: false, error: 'Not a valid .tappi-profile file' };

      const version = data.readUInt32BE(4);
      if (version !== 1) return { success: false, error: `Unsupported profile format version ${version}` };

      const salt = data.slice(8, 40);
      const iv = data.slice(40, 52);
      const authTag = data.slice(52, 68);
      const ciphertext = data.slice(68);

      // Derive key and decrypt
      const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);

      let decrypted: Buffer;
      try {
        decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        return { success: false, error: 'Incorrect password or corrupted file' };
      }

      // Decompress
      const json = zlib.gunzipSync(decrypted).toString('utf-8');
      const bundle = JSON.parse(json);

      // Determine target profile name (avoid conflicts)
      let targetName = bundle.profileName || 'imported';
      if (this.registry.profiles.find(p => p.name === targetName)) {
        targetName = `${targetName}-${Date.now()}`;
      }

      // Create profile directory
      const dir = this.getProfileDir(targetName);
      fs.mkdirSync(dir, { recursive: true });

      // Extract files
      const files = bundle.files || {};
      for (const [filename, content] of Object.entries(files)) {
        const fp = path.join(dir, filename);
        if (filename === 'database.sqlite' && bundle.dbIsBase64) {
          fs.writeFileSync(fp, Buffer.from(content as string, 'base64'));
        } else {
          fs.writeFileSync(fp, content as string, 'utf-8');
        }
      }

      // Register the imported profile
      this.ensureProfileExists(targetName, targetName);

      console.log(`[profile] Imported profile as "${targetName}"`);
      return { success: true, profileName: targetName };
    } catch (e: any) {
      console.error('[profile] Import failed:', e);
      return { success: false, error: e.message };
    }
  }
}

// Singleton export
export const profileManager = ProfileManager.getInstance();
