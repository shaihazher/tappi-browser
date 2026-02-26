/**
 * workspace-resolver.ts — Centralized workspace path resolution.
 *
 * Priority:
 * 1. Project working_dir (coding mode) — passed as parameter
 * 2. User-configured workspace path (from config.json)
 * 3. Platform-appropriate default:
 *      - macOS/Linux: ~/Documents/Tappi/
 *      - Windows: Documents\Tappi\
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Config path for workspace setting
const CONFIG_DIR = path.join(os.homedir(), '.tappi-browser');

/**
 * Get the platform-appropriate default workspace directory.
 * Uses Documents folder for cross-platform compatibility.
 */
function getDefaultWorkspace(): string {
  const home = os.homedir();
  
  // Platform-specific Documents folder
  // On all major platforms, the Documents folder is a standard location
  // macOS: ~/Documents
  // Windows: C:\Users\<user>\Documents
  // Linux: ~/Documents (or XDG_DOCUMENTS_DIR if set)
  
  let documentsDir: string;
  
  // Check for XDG_DOCUMENTS_DIR on Linux
  if (process.platform === 'linux' && process.env.XDG_DOCUMENTS_DIR) {
    documentsDir = process.env.XDG_DOCUMENTS_DIR;
  } else {
    documentsDir = path.join(home, 'Documents');
  }
  
  return path.join(documentsDir, 'Tappi');
}

function getConfigPath(): string {
  // Respect profile manager if available
  try {
    const { profileManager } = require('./profile-manager');
    return profileManager.getConfigPath();
  } catch {
    return path.join(CONFIG_DIR, 'config.json');
  }
}

interface TappiConfig {
  workspacePath?: string;
}

function loadConfig(): TappiConfig {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return { workspacePath: raw.workspacePath };
    }
  } catch (e) {
    console.error('[workspace-resolver] load config failed:', e);
  }
  return {};
}

/**
 * Get the resolved workspace path.
 * @param projectWorkingDir - Optional project working directory (takes priority)
 * @returns Absolute path to workspace
 */
export function getWorkspacePath(projectWorkingDir?: string): string {
  // Priority 1: Project working dir (coding mode)
  if (projectWorkingDir) {
    return expandTilde(projectWorkingDir);
  }

  // Priority 2: User-configured workspace path
  const config = loadConfig();
  if (config.workspacePath) {
    return expandTilde(config.workspacePath);
  }

  // Priority 3: Platform-appropriate default workspace
  return getDefaultWorkspace();
}

/**
 * Expand ~ to home directory.
 */
export function expandTilde(p: string): string {
  if (!p) return p;
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p === '~') return os.homedir();
  return p;
}

/**
 * Default workspace path constant (platform-aware).
 */
export const DEFAULT_WORKSPACE = getDefaultWorkspace();
