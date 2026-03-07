import { app, BrowserWindow, ipcMain, session, Menu, safeStorage, dialog, shell } from 'electron';
// Phase 8.5: Media Engine
import {
  initMediaEngine,
  initTabMedia,
  destroyTabMedia,
  onTabHidden,
  onTabShown,
  onTabNavigated,
  handleVideoDetected,
  handleVideoGeometryChanged,
  handleVideoPlayPause,
  handleVideoSeeked,
  isMediaEngineAvailable,
} from './media-engine';

process.on('uncaughtException', (e) => console.error('[CRASH]', e));
process.on('unhandledRejection', (e) => console.error('[REJECT]', e));

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// ─── Kerberos / SPNEGO SSO for enterprise auth ──────────────────────────────
// Must be set before app.ready(). Reads enterprise.authServerWhitelist and
// enterprise.authDelegateWhitelist from the user's config.json.
// These mirror the Chromium AuthServerAllowlist / AuthNegotiateDelegateAllowlist
// policies used in managed browser configuration profiles.
try {
  const _cfgPath = path.join(os.homedir(), '.tappi-browser', 'profiles', 'default', 'config.json');
  const _cfg = JSON.parse(fs.readFileSync(_cfgPath, 'utf-8'));
  if (_cfg.enterprise?.authServerWhitelist) {
    app.commandLine.appendSwitch('auth-server-whitelist', _cfg.enterprise.authServerWhitelist);
  }
  if (_cfg.enterprise?.authDelegateWhitelist) {
    app.commandLine.appendSwitch('auth-negotiate-delegate-whitelist', _cfg.enterprise.authDelegateWhitelist);
  }
} catch {
  // No config or no enterprise settings — Kerberos SSO disabled (default)
}
import * as http from 'http';
import { URL } from 'url';
import { createHash, randomBytes } from 'crypto';
import { TabManager } from './tab-manager';
import { executeCommand, getMenu, type ExecutorContext } from './command-executor';
import type { BrowserContext } from './browser-tools';
import { runAgent, stopAgent, clearHistory, agentProgressData, interruptMainSession, generateQuickTitle, detectPlanIntent, isPlanPending, resetAgentPlanState, getPendingPlanOpts } from './agent';
import { addMessage } from './conversation';
import { agentEvents } from './agent-bus';
import { loadServices, registerService, removeService, storeApiKey, getApiKey, listApiKeys, deleteApiKey } from './http-tools';
import { initDatabase, getDb, closeDatabase, reinitDatabase, addHistory, searchHistory, getRecentHistory, clearHistory as clearDbHistory, migrateBookmarksFromJson, getPermission, setPermission, getAllBookmarks, searchBookmarks, removeBookmark } from './database';
import { invalidateWorkspaceCache } from './file-tools';
import { profileManager } from './profile-manager';
import { sessionManager } from './session-manager';
import { startAdBlocker, stopAdBlocker, isAdBlockerEnabled, getBlockedCount, resetBlockedCount, addSiteException, removeSiteException, toggleAdBlocker, applyAdBlockerToPartition } from './ad-blocker';
import { initDownloadManager, getDownloadsSummary, getAllDownloads, cancelDownload, clearCompleted, getActiveDownloads, attachDownloadHandlerToPartition } from './download-manager';
import { storePassword, getPasswordsForDomain, getPasswordForAutofill, removePassword, listSavedDomains, generatePassword, buildAutofillScript, listIdentities } from './password-vault';
import { setLoginHint, clearLoginHint } from './login-state';
import { checkCredentials, testConnection } from './credential-checker';
import { getDefaultModel } from './llm-client';
import { listModelsForProvider } from './model-list';
import { loadTools, verifyAllTools } from './tool-manager';
import { setProjectUpdateCallback } from './tool-registry';
import { cleanupAll as cleanupShell } from './shell-tools';
import { listPlaybooks, getPlaybook, upsertPlaybook, deletePlaybook } from './domain-playbook';
import { cleanupAllTeams, getActiveTeam, getTeamStatusUI, setTeamUpdateCallback, getActiveTeamId } from './team-manager';
import { sendMessage as sendMailboxMessage } from './mailbox';
import { scheduleProfileUpdate, deleteProfile, loadUserProfileTxt, saveUserProfileTxt, loadProfile, generateProfile } from './user-profile';
import { purgeSession } from './output-buffer';
import { installExtension, installFromCrx, listExtensions, getExtension, removeExtension, enableExtension, disableExtension, loadPersistedExtensionsForProfile, extensionHasPermission } from './extension-manager';
import { discoverNativeHosts, cleanupNativeHosts } from './native-messaging';
import { startNativeMessagingBridge, stopNativeMessagingBridge, buildPolyfillScript, setCookieSession } from './native-messaging-bridge';
import { initCronManager, updateCronContext, addJob as cronAddJob, listJobs as cronListJobs, updateJob as cronUpdateJob, deleteJob as cronDeleteJob, runJobNow as cronRunJobNow, getJobsList, getActiveJobCount, cleanupCron } from './cron-manager';
import {
  createConversation,
  listConversations,
  deleteConversation as deleteConvFromStore,
  updateConversationTitle,
  getConversationMessages,
  addConversationMessage,
  searchConversations,
  getConversation,
  generateAutoTitleFallback,
  saveClaudeCodeSessionId,
  getClaudeCodeSessionId,
} from './conversation-store';
import { listScripts, getScript, deleteScript, incrementRunCount, getScriptsByDomain } from './script-store';
import { scriptifyConversation, scriptifyConversationViaCli, updateScriptDefinition, buildExecutionPrompt, parseBulkFile, validateAuthRequirements, reconcileScriptWithPlaybook } from './scriptify-engine';
import type { CliAuthConfig } from './claude-code-provider';
import {
  createProject,
  getProject,
  listProjects,
  getArtifacts,
  linkConversation as linkConvToProject,
  getProjectConversations,
  findExistingProject,
  updateProject as updateProjectRecord,
} from './project-manager';
// Phase 8.6: Self-Capture
import { captureCleanupOnQuit, getRecordingStatus, handleRecord } from './capture-tools';
// Phase 8.45: Local HTTP API server
import { startApiServer, stopApiServer, ensureApiToken, API_PORT, resetApiPlaybookSession, getApiPlaybookSession } from './api-server';

let mainWindow: BrowserWindow;
let tabManager: TabManager;
let activeConversationId: string | null = null;  // Phase 8.35

// ─── Attachment Processing ───

interface AttachmentPayload {
  name: string;
  mimeType: string;
  size: number;
  data: ArrayBuffer | Buffer;
}

export interface ProcessedAttachment {
  name: string;
  mimeType: string;
  size: number;
  base64: string;
  category: 'image' | 'document' | 'text';
  tempPath?: string;
}

function processAttachments(raw: AttachmentPayload[]): ProcessedAttachment[] {
  return raw.map(att => {
    const buffer = Buffer.isBuffer(att.data) ? att.data : Buffer.from(att.data as any);
    let category: 'image' | 'document' | 'text' = 'text';
    if (att.mimeType.startsWith('image/')) category = 'image';
    else if (att.mimeType === 'application/pdf') category = 'document';
    return { name: att.name, mimeType: att.mimeType, size: att.size, base64: buffer.toString('base64'), category };
  });
}

const CHROME_HEIGHT = 102; // tab bar (38) + address bar (36) + bookmarks bar (28)
const STATUS_BAR_HEIGHT = 34;
const AGENT_STRIP_WIDTH = 40;
const AGENT_PANEL_WIDTH = 380;

let agentPanelOpen = false;

// ─── Config ───
const CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.tappi-browser');

// Initialize profile manager early so we can resolve profile-relative paths
profileManager.initialize();

function getConfigPath(): string {
  return profileManager.getConfigPath();
}

// Legacy flat path (fallback)
const CONFIG_PATH_LEGACY = path.join(CONFIG_DIR, 'config.json');

interface TappiConfig {
  llm: {
    provider: string;
    model: string;
    apiKey: string; // encrypted — active provider's key (kept for backward compat)
    providerApiKeys?: Record<string, string>; // encrypted keys per provider (Phase 9.1)
    thinking?: boolean;      // true = medium thinking (default), false = off
    thinkingEffort?: 'low' | 'medium' | 'high';  // reasoning effort level (default: medium)
    codingMode?: boolean;    // true = team tools + coding system prompt (Phase 8.38)
    worktreeIsolation?: boolean; // Phase 8.39: git worktree per teammate (default: true when codingMode + git repo)
    // Cloud provider fields
    region?: string;         // Bedrock: AWS region
    projectId?: string;      // Vertex: GCP project ID
    location?: string;       // Vertex: GCP location
    endpoint?: string;       // Azure: resource endpoint URL
    baseUrl?: string;        // Ollama/OpenRouter: custom base URL
    // Secondary model fields (Phase 8.85)
    secondaryProvider?: string;  // deprecated (Phase 9.14): ignored, always primary
    secondaryModel?: string;     // deprecated (Phase 9.14): ignored, always primary
    secondaryApiKey?: string;    // deprecated (Phase 9.14): ignored, always primary
    // Timeout fields (Phase 8.40)
    agentTimeoutMs?: number;      // main agent timeout (default: 1800000 = 30 min)
    teammateTimeoutMs?: number;   // per-teammate timeout (default: 1800000 = 30 min)
    subtaskTimeoutMs?: number;    // per subtask timeout (default: 300000 = 5 min)
    // Claude Code provider fields
    claudeCodeMode?: 'plan' | 'ask' | 'full';  // CC permission mode (default: ask)
    claudeCodeAuth?: 'api-key' | 'oauth' | 'bedrock'; // CC auth method (default: oauth — uses CC's built-in login)
    claudeCodeBedrockRegion?: string;   // AWS region for Claude Code Bedrock mode
    claudeCodeBedrockProfile?: string;  // AWS profile name for Claude Code Bedrock mode
    claudeCodeBedrockModelId?: string;  // Bedrock model ID for Claude Code
    claudeCodeBedrockSmallModelId?: string; // Bedrock small/fast model ID for Claude Code
    claudeCodeAwsAuthRefresh?: string;  // AWS credential refresh command for Claude Code Bedrock
    claudeCodeAgentTeams?: boolean;     // Enable experimental agent teams
  };
  searchEngine: string;
  features: {
    adBlocker: boolean;
    darkMode: boolean;
  };
  developerMode: boolean;
  privacy?: {
    agentBrowsingDataAccess?: boolean;
    profileEnrichHistory?: boolean;
    profileEnrichBookmarks?: boolean;
  };
  workspacePath?: string;  // User-defined workspace directory (default: ~/Documents/Tappi/)
  enterprise?: {
    authServerWhitelist?: string;    // Kerberos/SPNEGO auth servers (comma-separated domains)
    authDelegateWhitelist?: string;  // Kerberos delegation targets (comma-separated domains)
  };
}

const DEFAULT_CONFIG: TappiConfig = {
  llm: { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: '', thinking: true, thinkingEffort: 'medium', codingMode: false, worktreeIsolation: true, agentTimeoutMs: 1_800_000, teammateTimeoutMs: 1_800_000, subtaskTimeoutMs: 300_000 },
  searchEngine: 'google',
  features: { adBlocker: false, darkMode: false },
  developerMode: false,
  privacy: { agentBrowsingDataAccess: false, profileEnrichHistory: true, profileEnrichBookmarks: true },
  workspacePath: undefined,  // undefined = use platform default
};

function normalizeLoadedConfig(raw: any): TappiConfig {
  const merged: TappiConfig = {
    ...DEFAULT_CONFIG,
    ...raw,
    llm: { ...DEFAULT_CONFIG.llm, ...(raw?.llm || {}) },
    features: { ...DEFAULT_CONFIG.features, ...(raw?.features || {}) },
    privacy: { ...DEFAULT_CONFIG.privacy, ...(raw?.privacy || {}) },
    developerMode: raw?.developerMode ?? false,
  };

  // Phase 10: Secondary model routing re-enabled for token efficiency.
  // Users can configure a cheaper secondary model (e.g., Haiku) for teammates.

  return merged;
}

function loadConfig(): TappiConfig {
  try {
    // Try profile-relative path first
    const profileConfigPath = getConfigPath();
    if (fs.existsSync(profileConfigPath)) {
      const raw = JSON.parse(fs.readFileSync(profileConfigPath, 'utf-8'));
      return normalizeLoadedConfig(raw);
    }
    // Fallback to legacy path (pre-profile-manager)
    if (fs.existsSync(CONFIG_PATH_LEGACY)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH_LEGACY, 'utf-8'));
      return normalizeLoadedConfig(raw);
    }
  } catch (e) {
    console.error('[config] load failed:', e);
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config: TappiConfig) {
  try {
    const profileConfigPath = getConfigPath();
    const dir = path.dirname(profileConfigPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(profileConfigPath, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('[config] save failed:', e);
  }
}

// API key storage: try safeStorage encryption, fallback to plain text with prefix marker.
// Keys are prefixed: "enc:" = safeStorage encrypted, "raw:" = plain text, no prefix = legacy.
const ENC_PREFIX = 'enc:';
const RAW_PREFIX = 'raw:';

// OpenAI Codex OAuth constants (mirrors official Codex login flow)
const OPENAI_OAUTH_ISSUER = 'https://auth.openai.com';
const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_CODEX_ORIGINATOR = 'codex_cli_rs';
const OPENAI_CODEX_BASE_URL = process.env.OPENAI_CODEX_BASE_URL || 'https://chatgpt.com/backend-api/codex';

function encryptApiKey(key: string): string {
  if (!key) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(key).toString('base64');
    }
  } catch (e) {
    console.error('[config] encryption unavailable:', e);
  }
  // Fallback: store with raw prefix so we know it's plain text
  return RAW_PREFIX + key;
}

function decryptApiKey(stored: string): string {
  if (!stored) return '';

  // Raw prefix: plain text, just strip prefix
  if (stored.startsWith(RAW_PREFIX)) {
    return stored.slice(RAW_PREFIX.length);
  }

  // Enc prefix: try safeStorage decrypt
  if (stored.startsWith(ENC_PREFIX)) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'));
      }
    } catch (e) {
      console.error('[config] safeStorage decrypt failed');
    }
    // Can't decrypt — return empty so we don't pass garbage to the API
    return '';
  }

  // No prefix (legacy): could be plain text or old encrypted blob.
  // Check if it looks like a known API key format
  if (stored.startsWith('sk-') || stored.startsWith('AI') || stored.startsWith('gsk_')) {
    return stored; // Plain text API key
  }

  // Try safeStorage as last resort (old encrypted format)
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    }
  } catch (e) {
    console.error('[config] legacy decrypt failed, key unusable');
  }
  return '';
}

/** Build a CliAuthConfig from the current config — used by standalone CLI calls. */
function buildCliAuthConfig(): CliAuthConfig {
  return {
    authMethod: ((currentConfig.llm as any).claudeCodeAuth || 'oauth') as any,
    apiKey: decryptApiKey(currentConfig.llm.apiKey) || undefined,
    model: currentConfig.llm.model,
    awsRegion: (currentConfig.llm as any).claudeCodeBedrockRegion,
    awsProfile: (currentConfig.llm as any).claudeCodeBedrockProfile,
    bedrockModelId: (currentConfig.llm as any).claudeCodeBedrockModelId,
    bedrockSmallModelId: (currentConfig.llm as any).claudeCodeBedrockSmallModelId,
  };
}

function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function generateOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

function parseOpenAIAuthClaimsFromJwt(jwt: string): Record<string, any> {
  try {
    const parts = jwt.split('.');
    if (parts.length < 2 || !parts[1]) return {};
    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson) as Record<string, any>;
    const namespaced = payload?.['https://api.openai.com/auth'];
    if (namespaced && typeof namespaced === 'object') return namespaced;
    return payload;
  } catch {
    return {};
  }
}

function buildOpenAICodexAuthorizeUrl(redirectUri: string, challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OPENAI_CODEX_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'openid profile email offline_access',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: OPENAI_CODEX_ORIGINATOR,
  });
  return `${OPENAI_OAUTH_ISSUER}/oauth/authorize?${params.toString()}`;
}

async function exchangeOpenAICodexCodeForTokens(code: string, redirectUri: string, verifier: string): Promise<{ idToken: string; accessToken: string; refreshToken: string; }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: OPENAI_CODEX_CLIENT_ID,
    code_verifier: verifier,
  });

  const response = await fetch(`${OPENAI_OAUTH_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Token exchange failed (${response.status}): ${text || 'no details'}`);
  }

  const json = await response.json() as any;
  if (!json?.id_token || !json?.access_token || !json?.refresh_token) {
    throw new Error('OAuth token response was incomplete.');
  }

  return {
    idToken: json.id_token,
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
  };
}

async function exchangeOpenAIIdTokenForApiKey(idToken: string, accessToken?: string): Promise<string> {
  const exchangeWith = async (subjectToken: string, subjectTokenType: string): Promise<{ ok: boolean; status: number; text: string; accessToken?: string }> => {
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      client_id: OPENAI_CODEX_CLIENT_ID,
      requested_token: 'openai-api-key',
      subject_token: subjectToken,
      subject_token_type: subjectTokenType,
    });

    const response = await fetch(`${OPENAI_OAUTH_ISSUER}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { ok: false, status: response.status, text };
    }

    const json = await response.json() as any;
    if (!json?.access_token) {
      return { ok: false, status: 500, text: 'token endpoint returned success but no access_token' };
    }

    return { ok: true, status: response.status, text: '', accessToken: json.access_token };
  };

  // Canonical Codex flow: ID token as subject token.
  const primary = await exchangeWith(idToken, 'urn:ietf:params:oauth:token-type:id_token');
  if (primary.ok && primary.accessToken) return primary.accessToken;

  const primaryText = primary.text || '';
  const normalized = primaryText.toLowerCase();

  // Pragmatic fallback: some tenants/accounts appear to reject id_token as subject token.
  // Retry once with access_token as subject token type.
  if (accessToken && primary.status === 401 && (normalized.includes('invalid_subject_token') || normalized.includes('missing organization id'))) {
    const fallback = await exchangeWith(accessToken, 'urn:ietf:params:oauth:token-type:access_token');
    if (fallback.ok && fallback.accessToken) return fallback.accessToken;

    const fallbackText = fallback.text || '';
    const fallbackNormalized = fallbackText.toLowerCase();
    if (fallback.status === 401 && (fallbackNormalized.includes('missing organization id') || fallbackNormalized.includes('invalid_subject_token'))) {
      throw new Error('API key minting failed: your ChatGPT token does not currently include a valid API organization. Finish API org onboarding on platform.openai.com (including billing) or sign in with the correct account/workspace, then retry.');
    }

    throw new Error(`API key exchange failed after fallback (${fallback.status}): ${fallbackText || 'no details'}`);
  }

  if (primary.status === 401 && (normalized.includes('missing organization id') || normalized.includes('invalid_subject_token'))) {
    throw new Error('API key minting failed: your ChatGPT token does not currently include a valid API organization. Finish API org onboarding on platform.openai.com (including billing) or sign in with the correct account/workspace, then retry.');
  }

  throw new Error(`API key exchange failed (${primary.status}): ${primaryText || 'no details'}`);
}

let currentConfig = DEFAULT_CONFIG;

function getAgentWidth(): number {
  return agentPanelOpen ? AGENT_PANEL_WIDTH : AGENT_STRIP_WIDTH;
}

function buildAppMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Settings',
      submenu: [
        {
          label: 'Open Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => mainWindow?.webContents.send('settings:open'),
        },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          click: () => tabManager?.createTab(),
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            if (!tabManager || !tabManager.activeTabId) return;
            tabManager.closeTab(tabManager.activeTabId);
            if (tabManager.tabCount === 0) mainWindow.close();
          },
        },
        {
          label: 'Reopen Closed Tab',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => tabManager?.reopenClosedTab(),
        },
        { type: 'separator' },
        {
          label: 'Focus Address Bar',
          accelerator: 'CmdOrCtrl+L',
          click: () => mainWindow?.webContents.send('focus:addressbar'),
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload Page',
          accelerator: 'CmdOrCtrl+R',
          click: () => tabManager?.activeWebContents?.reload(),
        },
        { type: 'separator' },
        {
          label: 'Toggle Bookmark',
          accelerator: 'CmdOrCtrl+D',
          click: () => {
            const wc = tabManager?.activeWebContents;
            if (wc) {
              const url = wc.getURL();
              tabManager.toggleBookmark(url);
              // Send bookmarks:updated so the bookmarks bar refreshes
              const bookmarks = getAllBookmarks();
              mainWindow?.webContents.send('bookmarks:updated', {
                url,
                added: tabManager.isBookmarked(url),
                bookmarks,
              });
            }
          },
        },
        {
          label: 'Toggle Agent Panel',
          accelerator: 'CmdOrCtrl+J',
          click: () => toggleAgentPanel(),
        },
        {
          label: 'Find on Page',
          accelerator: 'CmdOrCtrl+F',
          click: () => mainWindow?.webContents.send('find:open'),
        },
        {
          label: 'Print',
          accelerator: 'CmdOrCtrl+P',
          click: () => tabManager?.activeWebContents?.print(),
        },
        { type: 'separator' },
        {
          label: 'History',
          accelerator: 'CmdOrCtrl+Y',
          click: () => mainWindow?.webContents.send('panel:open', 'history'),
        },
        {
          label: 'Bookmarks',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => mainWindow?.webContents.send('panel:open', 'bookmarks'),
        },
        {
          label: 'Downloads',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => mainWindow?.webContents.send('panel:open', 'downloads'),
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Tab',
      submenu: [
        ...Array.from({ length: 8 }, (_, i) => ({
          label: `Tab ${i + 1}`,
          accelerator: `CmdOrCtrl+${i + 1}` as string,
          click: () => tabManager?.switchToIndex(i),
        })),
        {
          label: 'Last Tab',
          accelerator: 'CmdOrCtrl+9',
          click: () => tabManager?.switchToLast(),
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function toggleAgentPanel() {
  // Fix 2: Aria tab has no agent sidebar to toggle — skip
  if (tabManager && tabManager.activeTabId === tabManager.ariaTabId) return;
  agentPanelOpen = !agentPanelOpen;
  mainWindow.webContents.send('agent:toggled', agentPanelOpen);
  layoutViews();
}

function layoutViews() {
  if (!mainWindow || !tabManager) return;
  const [width, height] = mainWindow.getContentSize();
  // Fix 2: Hide agent sidebar when Aria tab is active (it IS the agent experience)
  const isAriaActive = tabManager.activeTabId === tabManager.ariaTabId;
  const agentWidth = isAriaActive ? 0 : getAgentWidth();
  // Tell chrome renderer to show/hide agent strip + panel
  mainWindow.webContents.send('agent:visible', !isAriaActive);
  // Fix 3: Log bounds to aid debugging BrowserView overlap issues
  const bvWidth = width - agentWidth;
  console.log(`[layout] isAria=${isAriaActive} agentWidth=${agentWidth} bvWidth=${bvWidth} contentW=${width}`);
  // extraChromeHeight is undefined here — tabManager uses its stored lastExtraChrome value
  tabManager.layoutActiveTab(bvWidth, height, STATUS_BAR_HEIGHT);
}

function createWindow() {
  currentConfig = loadConfig();

  // Initialize database with profile-relative path & run migrations
  initDatabase(profileManager.getDatabasePath());
  migrateBookmarksFromJson();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 600,
    minHeight: 400,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 10 },
    backgroundColor: '#1a1a2e',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Load chrome UI in the main window's webContents
  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

  // F5: Prevent main window navigation to non-file URLs
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });

  // F6: Deny window.open from main chrome window
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' as const }));

  // Tab manager uses BrowserViews for web content
  tabManager = new TabManager(mainWindow, CHROME_HEIGHT, (wc) => {
    setupPageContextMenu(wc);
  });

  // Layout on resize
  mainWindow.on('resize', layoutViews);

  // Hide/show chrome on fullscreen (HTML5 fullscreen from tab content)
  mainWindow.on('enter-full-screen', () => {
    mainWindow.webContents.send('fullscreen:changed', true);
  });
  mainWindow.on('leave-full-screen', () => {
    mainWindow.webContents.send('fullscreen:changed', false);
    // When macOS exits fullscreen (e.g. Esc), the tab's webContents may still
    // be in HTML5 fullscreen mode (leave-html-full-screen hasn't fired yet).
    // Force the tab manager out of fullscreen state so layoutActiveTab() uses
    // normal bounds, then tell the page to exit HTML5 fullscreen too.
    if (tabManager) {
      tabManager.isFullscreen = false;
      const wc = tabManager.activeWebContents;
      if (wc && !wc.isDestroyed()) {
        wc.executeJavaScript('if (document.fullscreenElement) document.exitFullscreen().catch(()=>{})').catch(() => {});
      }
    }
    layoutViews();
  });

  // Build app menu with keyboard shortcuts
  buildAppMenu();

  // Once chrome UI is ready, open first tab
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[main] Chrome UI loaded');
    // Send initial state
    mainWindow.webContents.send('agent:toggled', agentPanelOpen);
    mainWindow.webContents.send('config:loaded', {
      ...currentConfig,
      llm: { ...currentConfig.llm, apiKey: currentConfig.llm.apiKey ? '••••••••' : '' },
    });
    // Send active profile info to UI (Phase 8.4.4)
    mainWindow.webContents.send('profile:loaded', {
      name: profileManager.activeProfile,
      profiles: profileManager.listProfiles(),
    });
    try {
      // Phase 8.35: Create Aria tab first (always at index 0)
      // Fix 1: Only create the Aria tab on startup — no extra regular tab.
      // Users can open new tabs via Cmd+T or the + button.
      const ariaId = tabManager.createAriaTab();
      initTabMedia(ariaId);
      // Debug aria console (same as chrome console-message listener)
      const ariaWC = tabManager.ariaWebContents;
      if (ariaWC) {
        ariaWC.on('console-message', (_e: any, _level: number, message: string) => {
          console.log('[aria]', message);
        });
      }
      console.log('[main] Aria tab created');

      // Reuse the most recent empty conversation on startup, or create one if none exist
      const existingConvs = listConversations(50);
      const latestEmpty = existingConvs.find(c => c.message_count === 0);
      if (latestEmpty) {
        activeConversationId = latestEmpty.id;
        console.log('[main] Reusing existing empty conversation:', activeConversationId);
      } else if (existingConvs.length === 0) {
        const conv = createConversation();
        activeConversationId = conv.id;
        console.log('[main] Initial conversation created:', activeConversationId);
      } else {
        // All existing conversations have messages — start with the most recent
        activeConversationId = existingConvs[0].id;
        console.log('[main] Resuming most recent conversation:', activeConversationId);
      }
    } catch (e) {
      console.error('[main] Tab creation failed:', e);
    }
    // Layout AFTER tab creation so stored values persist into switchTab
    layoutViews();
  });

  // Initialize download manager (default session + active profile session)
  initDownloadManager(mainWindow);
  attachDownloadHandlerToPartition(profileManager.getSessionPartition());

  // Relay agent download_card events to Electron windows (belt-and-suspenders for Electron mode)
  agentEvents.on('download_card', (payload: any) => {
    console.log('[main] Broadcasting download_card to all windows');
    // Send to main window (chrome UI / app.js)
    try { mainWindow?.webContents.send('agent:present-download', payload); } catch (e) { console.error('[main] Error sending to mainWindow:', e); }
    // Send to Aria BrowserView webContents (aria.js) — belt-and-suspenders alongside tool-registry direct send
    try {
      const ariaWC = tabManager?.ariaWebContents;
      if (ariaWC && !ariaWC.isDestroyed()) {
        ariaWC.send('agent:present-download', payload);
        console.log('[main] Sent download_card to aria webContents');
      }
    } catch (e) { console.error('[main] Error sending to aria:', e); }
  });

  // Start ad blocker if enabled in config (apply to both default + profile session)
  if (currentConfig.features.adBlocker) {
    startAdBlocker().then(() => {
      applyAdBlockerToPartition(profileManager.getSessionPartition());
      mainWindow?.webContents.send('adblock:count', getBlockedCount());
    });
  }

  // ── Native Messaging Bridge ──
  // Start bridge BEFORE loading extensions so MV3 service worker polyfills
  // can be written with valid port/token during patchServiceWorkerPolyfill().
  discoverNativeHosts();
  startNativeMessagingBridge(extensionHasPermission).then(({ port: bridgePort, token: bridgeToken }) => {
    // Provide the profile session to the bridge for chrome.cookies API
    setCookieSession(session.fromPartition(profileManager.getSessionPartition()));

    // Now load persisted extensions — bridge is ready for polyfill injection
    loadPersistedExtensionsForProfile().catch(e =>
      console.error('[main] Extension auto-load error:', e)
    );

    // Inject polyfill into MV2 extension background pages via dom-ready
    app.on('web-contents-created', (_event, webContents) => {
      webContents.on('dom-ready', () => {
        const url = webContents.getURL();
        if (!url.startsWith('chrome-extension://')) return;

        try {
          const extId = new URL(url).hostname;
          if (!extensionHasPermission(extId, 'nativeMessaging')) return;

          webContents.executeJavaScript(buildPolyfillScript(extId, bridgePort, bridgeToken))
            .catch(() => {}); // Ignore if context is destroyed
          console.log(`[tappi] Native messaging polyfill injected for extension: ${extId}`);
        } catch {}
      });
    });
  }).catch(e => console.error('[main] Native messaging bridge start error:', e));

  // ─── Polyfill chrome.webstore.install() for web pages ─────────────────────
  // Some enterprise sites call chrome.webstore.install()
  // which doesn't exist in Electron. This polyfill extracts the extension ID
  // from the Chrome Web Store URL, constructs a CRX download URL, and triggers
  // a download that the existing download-manager auto-install handles.
  app.on('web-contents-created', (_ev, wc) => {
    wc.on('dom-ready', () => {
      const url = wc.getURL();
      // Only inject into web pages, not extension pages
      if (url.startsWith('chrome-extension://')) return;
      if (!url.startsWith('http://') && !url.startsWith('https://')) return;

      wc.executeJavaScript(`
        (function() {
          if (typeof chrome === 'undefined') window.chrome = {};
          if (!chrome.webstore) chrome.webstore = {};
          if (chrome.webstore.install) return; // Already polyfilled or real

          chrome.webstore.install = function(url, successCb, failureCb) {
            try {
              // Extract extension ID from Chrome Web Store URL
              // e.g. https://chrome.google.com/webstore/detail/<id>
              var match = (url || '').match(/\\/detail\\/([a-z]{32})/);
              if (!match) {
                match = (url || '').match(/\\/detail\\/[^/]+\\/([a-z]{32})/);
              }
              if (!match) {
                if (failureCb) failureCb('Could not extract extension ID from URL: ' + url);
                return;
              }
              var extId = match[1];
              var prodVersion = navigator.userAgent.match(/Chrome\\/(\\d+\\.\\d+\\.\\d+\\.\\d+)/);
              var ver = prodVersion ? prodVersion[1] : '120.0.0.0';
              var crxUrl = 'https://clients2.google.com/service/update2/crx'
                + '?response=redirect&prodversion=' + ver
                + '&x=id%3D' + extId + '%26installsource%3Dondemand%26uc';

              console.log('[tappi] Webstore polyfill: downloading CRX for ' + extId);

              // Trigger download via hidden anchor — download-manager handles .crx install
              var a = document.createElement('a');
              a.href = crxUrl;
              a.download = extId + '.crx';
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);

              if (successCb) setTimeout(successCb, 100);
            } catch(e) {
              console.error('[tappi] Webstore polyfill error:', e);
              if (failureCb) failureCb(e.message || String(e));
            }
          };
          console.log('[tappi] chrome.webstore.install polyfill ready');
        })();
      `).catch(() => {}); // Ignore if context destroyed
    });
  });

  // Initialize cron manager
  {
    const apiKey = decryptApiKey(currentConfig.llm.apiKey);
    const isCC = currentConfig.llm.provider === 'claude-code';
    if (apiKey || isCC) {
      const cronBrowserCtx: BrowserContext = { window: mainWindow, tabManager, config: currentConfig };
      initCronManager(mainWindow, cronBrowserCtx, {
        provider: currentConfig.llm.provider,
        model: currentConfig.llm.model,
        apiKey: apiKey || '',
        thinking: currentConfig.llm.thinking,
        thinkingEffort: currentConfig.llm.thinkingEffort,
        region: currentConfig.llm.region,
        projectId: currentConfig.llm.projectId,
        location: currentConfig.llm.location,
        endpoint: currentConfig.llm.endpoint,
        baseUrl: currentConfig.llm.baseUrl,
      }, currentConfig.developerMode, isCC ? buildCliAuthConfig() : undefined);
    }
  }

  // Schedule user profile update (Phase 8.4.2) — non-blocking, fire-and-forget
  // Only runs if agentBrowsingDataAccess is enabled and profile is stale
  if (currentConfig.privacy?.agentBrowsingDataAccess) {
    const profileApiKey = decryptApiKey(currentConfig.llm.apiKey);
    const isCC = currentConfig.llm.provider === 'claude-code';
    if (profileApiKey || isCC) {
      const profileDb = getDb();
      scheduleProfileUpdate(profileDb, {
        provider: currentConfig.llm.provider,
        model: currentConfig.llm.model,
        apiKey: profileApiKey || '',
        thinking: false, // No thinking needed for profile generation
        region: currentConfig.llm.region,
        projectId: currentConfig.llm.projectId,
        location: currentConfig.llm.location,
        endpoint: currentConfig.llm.endpoint,
        baseUrl: currentConfig.llm.baseUrl,
      }, {
        history: currentConfig.privacy?.profileEnrichHistory !== false,
        bookmarks: currentConfig.privacy?.profileEnrichBookmarks !== false,
      }, isCC ? buildCliAuthConfig() : undefined);
    }
  }

  // Debug chrome console
  mainWindow.webContents.on('console-message', (_e: any, _level: number, message: string) => {
    console.log('[chrome]', message);
  });

  // ─── Phase 8.45: Local HTTP API Server ───
  // Only start when developer mode is enabled (same as dev TCP server)
  if (currentConfig.developerMode) {
    ensureApiToken();
    startApiServer(API_PORT, {
      mainWindow,
      tabManager,
      getConfig: () => currentConfig,
      decryptApiKey,
      updateConfig: applyConfigUpdates,
    });
  } else {
    console.log(`[api] HTTP API server disabled (Developer Mode is off). Enable in Settings to use port ${API_PORT}.`);
  }

  // ─── Media Engine Initialization (Phase 8.5) ───
  initMediaEngine(
    mainWindow,
    (tabId) => tabManager.getBrowserView(tabId),
    () => tabManager.activeTabId,
  ).catch(e => console.error('[media-engine] init error:', e));

  // Media IPC routing: events from page content-preload → media engine
  ipcMain.on('media:video-detected-from-page', (event, data) => {
    const tabId = tabManager.getTabIdByWebContentsId(event.sender.id);
    if (tabId) handleVideoDetected(tabId, data);
  });

  ipcMain.on('media:geometry-changed-from-page', (event, data) => {
    const tabId = tabManager.getTabIdByWebContentsId(event.sender.id);
    if (tabId) handleVideoGeometryChanged(tabId, data.rect);
  });

  ipcMain.on('media:play-pause-from-page', (event, data) => {
    const tabId = tabManager.getTabIdByWebContentsId(event.sender.id);
    if (tabId) handleVideoPlayPause(tabId, data.playing);
  });

  ipcMain.on('media:seeked-from-page', (event, data) => {
    const tabId = tabManager.getTabIdByWebContentsId(event.sender.id);
    if (tabId) handleVideoSeeked(tabId, data.position);
  });

  // UI: media toggle from status bar
  ipcMain.handle('media:toggle-active', async () => {
    const activeId = tabManager.activeTabId;
    if (!activeId) return { success: false, error: 'No active tab' };
    const { toggleOverlay } = require('./media-engine');
    return toggleOverlay(activeId);
  });

  // UI: set global media enabled/disabled
  ipcMain.handle('media:set-enabled', (_e, enabled: boolean) => {
    const { setGlobalMediaEnabled } = require('./media-engine');
    setGlobalMediaEnabled(enabled);
    return { success: true };
  });

  // ─── Capture IPC (Phase 8.6) ───
  ipcMain.handle('capture:record-status', () => getRecordingStatus());

  ipcMain.handle('capture:record-stop', async () => {
    return handleRecord(
      mainWindow,
      () => tabManager.activeWebContents,
      { action: 'stop' },
      (status) => {
        try { mainWindow.webContents.send('capture:recording-update', status); } catch {}
      },
    );
  });

  // ─── Tab IPC ───
  ipcMain.on('tab:create', (_e, url?: string) => {
    const newId = tabManager.createTab(url || undefined);
    initTabMedia(newId);
    // Fix 3: Re-layout so new tab's BrowserView gets correct bounds
    layoutViews();
  });

  ipcMain.on('tab:close', (_e, id: string) => {
    destroyTabMedia(id);
    tabManager.closeTab(id);
    if (tabManager.tabCount === 0) {
      mainWindow.close();
      return; // window closing — no layout needed
    }
    // Re-layout after close (active tab changed, agent visibility may change)
    layoutViews();
  });

  ipcMain.on('tab:switch', (_e, id: string) => {
    const prevId = tabManager.activeTabId;
    if (prevId && prevId !== id) onTabHidden(prevId);
    tabManager.switchTab(id);
    onTabShown(id);
    // Fix 2 + 3: Re-layout after tab switch so agent visibility and BrowserView
    // bounds are correct (lastLayoutWidth stored for Aria tab may differ from
    // the correct width for regular tabs with agent strip).
    layoutViews();
  });

  ipcMain.on('tab:navigate', (_e, id: string, url: string) => {
    onTabNavigated(id);
    tabManager.navigate(id, url);
  });

  ipcMain.on('tab:reopen', () => {
    tabManager.reopenClosedTab();
  });

  ipcMain.on('tab:duplicate', (_e, id: string) => {
    tabManager.duplicateTab(id);
  });

  ipcMain.on('tab:pin', (_e, id: string) => {
    tabManager.pinTab(id);
  });

  ipcMain.on('tab:mute', (_e, id: string) => {
    tabManager.muteTab(id);
  });

  ipcMain.on('tab:close-others', (_e, id: string) => {
    tabManager.closeOtherTabs(id);
  });

  ipcMain.on('tab:close-right', (_e, id: string) => {
    tabManager.closeTabsToRight(id);
  });

  ipcMain.on('tab:reorder', (_e, id: string, newIndex: number) => {
    tabManager.reorderTab(id, newIndex);
  });

  ipcMain.on('tab:switch-index', (_e, index: number) => {
    if (index === 9) {
      tabManager.switchToLast();
    } else {
      tabManager.switchToIndex(index);
    }
  });

  // ─── Bookmark IPC ───
  ipcMain.on('bookmark:toggle', (_e, url: string) => {
    const added = tabManager.toggleBookmark(url);
    const bookmarks = getAllBookmarks();
    mainWindow?.webContents.send('bookmarks:updated', { url, added, bookmarks });
  });

  // ─── Navigation IPC ───
  ipcMain.on('nav:back', () => {
    tabManager.activeWebContents?.goBack();
  });

  ipcMain.on('nav:forward', () => {
    tabManager.activeWebContents?.goForward();
  });

  ipcMain.on('nav:reload', () => {
    tabManager.activeWebContents?.reload();
  });

  // ─── Agent IPC ───
  ipcMain.on('agent:toggle', () => {
    toggleAgentPanel();
  });

  ipcMain.on('agent:send', async (_e, message: string) => {
    console.log('[agent] Message:', message);

    // Claude Code conversations should use the Aria tab instead
    if (currentConfig.llm.provider === 'claude-code') {
      mainWindow.webContents.send('agent:response', {
        role: 'assistant',
        content: 'Claude Code conversations are available in the Aria tab. Please use the Aria panel instead.',
        timestamp: Date.now(),
      });
      return;
    }

    // Check if agent has an API key configured
    const apiKey = decryptApiKey(currentConfig.llm.apiKey);
    if (!apiKey) {
      // Fall back to text command executor (dev mode)
      console.log('[agent] No API key — using text command executor');
      const browserCtx: BrowserContext = {
        window: mainWindow,
        tabManager,
        config: currentConfig,
      };
      try {
        const result = await executeCommand(message, { browserCtx });
        mainWindow.webContents.send('agent:response', {
          role: 'assistant',
          content: result,
          timestamp: Date.now(),
        });
      } catch (err: any) {
        mainWindow.webContents.send('agent:response', {
          role: 'assistant',
          content: `❌ Error: ${err.message}`,
          timestamp: Date.now(),
        });
      }
      return;
    }

    // Run the LLM agent
    const browserCtx: BrowserContext = {
      window: mainWindow,
      tabManager,
      config: currentConfig,
    };

    // Phase 8.35: Ensure active conversation exists (reuse empty rather than creating new)
    if (!activeConversationId) {
      const existing = listConversations(50);
      const emptyConv = existing.find(c => c.message_count === 0);
      if (emptyConv) {
        activeConversationId = emptyConv.id;
      } else {
        const conv = createConversation();
        activeConversationId = conv.id;
      }
    }

    runAgent({
      userMessage: message,
      browserCtx,
      llmConfig: {
        provider: currentConfig.llm.provider,
        model: currentConfig.llm.model,
        apiKey,
        thinking: currentConfig.llm.thinking,
        thinkingEffort: currentConfig.llm.thinkingEffort,
        region: currentConfig.llm.region,
        projectId: currentConfig.llm.projectId,
        location: currentConfig.llm.location,
        endpoint: currentConfig.llm.endpoint,
        baseUrl: currentConfig.llm.baseUrl,
        // Secondary model (Phase 8.85)
        secondaryProvider: currentConfig.llm.secondaryProvider,
        secondaryModel: currentConfig.llm.secondaryModel,
        secondaryApiKey: currentConfig.llm.secondaryApiKey ? decryptApiKey(currentConfig.llm.secondaryApiKey) : undefined,
        // Timeouts (Phase 8.40)
        agentTimeoutMs: currentConfig.llm.agentTimeoutMs,
        teammateTimeoutMs: currentConfig.llm.teammateTimeoutMs,
        subtaskTimeoutMs: currentConfig.llm.subtaskTimeoutMs,
      },
      window: mainWindow,
      developerMode: currentConfig.developerMode,
      sessionId: activeConversationId || 'default',
      conversationId: activeConversationId,
      ariaWebContents: tabManager?.ariaWebContents,
    });
  });

  ipcMain.on('agent:stop', () => {
    stopAgent();
  });

  // Phase 8.40: Get current agent progress (elapsed, toolCalls, timeoutMs, running)
  ipcMain.handle('agent:get-progress', () => {
    return agentProgressData;
  });

  ipcMain.on('agent:clear', () => {
    clearHistory('default');
    mainWindow.webContents.send('agent:cleared', {});
  });

  // ─── Aria Tab IPC (Phase 8.35) ───
  // ─── Claude Code Provider State ──────────────────────────────────────────
  let activeClaudeCodeProvider: any = null;

  // ─── Script Execution: pending scriptId/inputs for agent persist-fix tool ───
  let pendingScriptId: string | null = null;
  let pendingScriptInputs: Record<string, any> | null = null;

  ipcMain.on('aria:send', async (_e, message: string, conversationId?: string, codingMode?: boolean, attachments?: Array<{ name: string; mimeType: string; size: number; data: ArrayBuffer }>) => {
    const apiKey = decryptApiKey(currentConfig.llm.apiKey);
    // Claude Code with OAuth/Bedrock doesn't need an API key — it handles its own auth
    const ccAuth = (currentConfig.llm as any).claudeCodeAuth;
    const isClaudeCodeNoKey = currentConfig.llm.provider === 'claude-code' && (ccAuth === 'oauth' || ccAuth === 'bedrock');
    if (!apiKey && !isClaudeCodeNoKey) {
      try {
        const ariaWC = tabManager?.ariaWebContents;
        if (ariaWC) ariaWC.send('agent:stream-chunk', { text: '⚙️ No API key configured. Add one in Settings.', done: true });
      } catch {}
      return;
    }

    // Process attachments if provided
    let processedAttachments: ProcessedAttachment[] | undefined;
    if (attachments && attachments.length > 0) {
      processedAttachments = processAttachments(attachments);
    }

    // Use provided conversationId or active one
    const convId = conversationId || activeConversationId;
    let isNewConversation = false;
    if (!convId) {
      const existing = listConversations(50);
      const emptyConv = existing.find(c => c.message_count === 0);
      if (emptyConv) {
        activeConversationId = emptyConv.id;
        isNewConversation = emptyConv.message_count === 0;
      } else {
        const conv = createConversation();
        activeConversationId = conv.id;
        isNewConversation = true;
      }
    } else {
      // Check if this conversation has no messages yet
      const conv = getConversation(convId);
      isNewConversation = !conv || conv.message_count === 0;
    }

    // Phase 9.13: Generate title in parallel for new conversations
    if (isNewConversation && activeConversationId) {
      if (currentConfig.llm.provider === 'claude-code') {
        // Use Claude Code CLI for title generation (works for both OAuth and API key)
        const { generateTitleViaCli } = await import('./claude-code-provider');
        const convIdForTitle = activeConversationId;
        generateTitleViaCli(message, buildCliAuthConfig()).then((title) => {
          if (title) {
            updateConversationTitle(convIdForTitle, title);
            console.log('[main] CC CLI title set:', title);
            try {
              const ariaWC = tabManager?.ariaWebContents;
              if (ariaWC && !ariaWC.isDestroyed()) {
                ariaWC.send('aria:conversation-updated', { conversationId: convIdForTitle });
              }
            } catch {}
          } else {
            generateAutoTitleFallback(convIdForTitle, message);
          }
        }).catch(() => {
          generateAutoTitleFallback(convIdForTitle, message);
        });
      } else {
        // Non-Claude-Code providers: use Vercel AI SDK path
        const llmConfigForTitle = {
          provider: currentConfig.llm.provider,
          model: currentConfig.llm.model,
          apiKey,
          secondaryProvider: currentConfig.llm.secondaryProvider,
          secondaryModel: currentConfig.llm.secondaryModel,
          secondaryApiKey: currentConfig.llm.secondaryApiKey ? decryptApiKey(currentConfig.llm.secondaryApiKey) : undefined,
        };
        generateQuickTitle(activeConversationId, message, llmConfigForTitle, tabManager?.ariaWebContents).catch(() => {});
      }
    }

    // ─── Claude Code Provider Routing ──────────────────────────────────────
    if (currentConfig.llm.provider === 'claude-code') {
      const { ClaudeCodeProvider, isClaudeCodeInstalled, installClaudeCode: installCC } = await import('./claude-code-provider');
      const { ensureApiToken } = await import('./api-server');

      let ccMode: 'plan' | 'full' = (currentConfig.llm as any).claudeCodeMode || 'full';
      const ccAuth: 'api-key' | 'oauth' | 'bedrock' = (currentConfig.llm as any).claudeCodeAuth || 'oauth';
      const ariaWC = tabManager?.ariaWebContents;

      // Conversational plan mode switching: detect intent from message
      if (detectPlanIntent(message) && ccMode !== 'plan') {
        ccMode = 'plan';
        (currentConfig.llm as any).claudeCodeMode = 'plan';
        try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('aria:cc-mode-switched', { mode: 'plan' }); } catch {}
      }

      // Auto-install if not present
      const installed = await isClaudeCodeInstalled(ccAuth);
      if (!installed) {
        const label = 'Claude Code CLI';
        try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('agent:stream-chunk', { text: `⚙️ Installing ${label}...`, done: false }); } catch {}
        try {
          await installCC(ccAuth, (msg) => {
            console.log('[claude-code] install:', msg);
            try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('agent:stream-chunk', { text: `\n${msg}`, done: false }); } catch {}
          });
          try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('agent:stream-chunk', { text: `\n✓ ${label} installed. Processing your message...\n\n`, done: false }); } catch {}
        } catch (installErr: any) {
          console.error('[claude-code] auto-install error:', installErr);
          try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('agent:stream-chunk', { text: `\n\n❌ Failed to install ${label}: ${installErr.message || installErr}`, done: true }); } catch {}
          return;
        }
      }

      // Auto-login for OAuth if not authenticated
      if (ccAuth === 'oauth') {
        const { checkClaudeAuthStatus } = await import('./claude-code-provider');
        const authStatus = await checkClaudeAuthStatus();
        if (!authStatus.loggedIn) {
          try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('agent:stream-chunk', { text: '🔑 Claude Code needs authentication. Opening sign-in...', done: false }); } catch {}
          const loginResult = await runCCOAuthLogin();
          if (!loginResult.success) {
            try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('agent:stream-chunk', { text: `\n\n❌ Sign-in failed: ${loginResult.error || 'Unknown error'}`, done: true }); } catch {}
            return;
          }
          try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('agent:stream-chunk', { text: '\n✓ Signed in. Processing your message...\n\n', done: false }); } catch {}
        }
      }

      // Auto-check for Bedrock credentials
      if (ccAuth === 'bedrock') {
        const { checkBedrock } = await import('./credential-checker');
        const bedrockStatus = checkBedrock();
        if (!bedrockStatus.found) {
          try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('agent:stream-chunk', { text: '❌ No AWS credentials found. Configure AWS credentials (env vars, ~/.aws/credentials, or SSO) to use Bedrock.', done: true }); } catch {}
          return;
        }
      }

      const apiToken = ensureApiToken();

      // Reuse or create provider (preserves session for multi-turn)
      const ccModel = currentConfig.llm.model !== 'claude-code' ? currentConfig.llm.model : undefined;

      if (!activeClaudeCodeProvider) {
        activeClaudeCodeProvider = new ClaudeCodeProvider({
          authMethod: ccAuth,
          apiKey: ccAuth === 'api-key' ? apiKey : undefined,
          mode: ccMode,
          model: ccModel,
          tappiApiToken: apiToken,
          workingDir: (currentConfig as any).workspacePath || require('os').homedir(),
          awsRegion: (currentConfig.llm as any).claudeCodeBedrockRegion,
          awsProfile: (currentConfig.llm as any).claudeCodeBedrockProfile,
          bedrockModelId: (currentConfig.llm as any).claudeCodeBedrockModelId,
          bedrockSmallModelId: (currentConfig.llm as any).claudeCodeBedrockSmallModelId,
          awsAuthRefresh: (currentConfig.llm as any).claudeCodeAwsAuthRefresh,
          agentTeams: !!(currentConfig.llm as any).claudeCodeAgentTeams,
        });
      } else {
        // Capture previous values to detect model/auth changes
        const prevModel = activeClaudeCodeProvider.config.model;
        const prevBedrockModelId = activeClaudeCodeProvider.config.bedrockModelId;
        const prevAuth = activeClaudeCodeProvider.config.authMethod;
        // Update mode/auth/model in case they changed
        activeClaudeCodeProvider.config = {
          ...activeClaudeCodeProvider.config,
          authMethod: ccAuth,
          apiKey: ccAuth === 'api-key' ? apiKey : undefined,
          mode: ccMode,
          model: ccModel,
          tappiApiToken: apiToken,
          awsRegion: (currentConfig.llm as any).claudeCodeBedrockRegion,
          awsProfile: (currentConfig.llm as any).claudeCodeBedrockProfile,
          bedrockModelId: (currentConfig.llm as any).claudeCodeBedrockModelId,
          bedrockSmallModelId: (currentConfig.llm as any).claudeCodeBedrockSmallModelId,
          awsAuthRefresh: (currentConfig.llm as any).claudeCodeAwsAuthRefresh,
          agentTeams: !!(currentConfig.llm as any).claudeCodeAgentTeams,
        };
        // Reset session if model-affecting fields changed (prevents stale --resume)
        if (ccModel !== prevModel ||
            (currentConfig.llm as any).claudeCodeBedrockModelId !== prevBedrockModelId ||
            ccAuth !== prevAuth) {
          activeClaudeCodeProvider.resetSession();
        }
      }

      const effectiveConvId = convId || activeConversationId || 'default';

      // Restore persisted session for current conversation (e.g. after app restart)
      if (activeClaudeCodeProvider.getSessionId() === null && effectiveConvId !== 'default') {
        const savedSid = getClaudeCodeSessionId(effectiveConvId);
        if (savedSid) activeClaudeCodeProvider.setSessionId(savedSid);
      }

      // Broadcast stream start
      try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('agent:stream-start', {}); } catch {}
      try { mainWindow.webContents.send('agent:stream-start', {}); } catch {}

      // Wire up chunk events — accumulate response for persistence
      let ccResponseBuffer = '';
      const onChunk = (data: { text: string; done: boolean }) => {
        if (data.text) ccResponseBuffer += data.text;
        try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('agent:stream-chunk', data); } catch {}
        try { mainWindow.webContents.send('agent:stream-chunk', data); } catch {}
      };
      const onError = (error: string) => {
        const errChunk = { text: `\n\n❌ ${error}`, done: true };
        try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('agent:stream-chunk', errChunk); } catch {}
        try { mainWindow.webContents.send('agent:stream-chunk', errChunk); } catch {}
      };

      const _ccToolInputCache = new Map<string, any>(); // toolId -> input from tool-complete
      const onToolStart = (data: any) => {
        // Save any text accumulated before this tool as a partial assistant message
        if (ccResponseBuffer.trim()) {
          addConversationMessage(effectiveConvId, 'assistant', ccResponseBuffer);
          ccResponseBuffer = '';
        }
        try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('cc:tool-start', data); } catch {}
      };
      const onToolComplete = (data: any) => {
        if (data?.toolId) _ccToolInputCache.set(data.toolId, data.input);
        try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('cc:tool-complete', data); } catch {}
      };
      const onToolResult = (data: any) => {
        try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('cc:tool-result', data); } catch {}
        // Persist tool card
        if (data?.toolId || data?.toolName) {
          const persistData = {
            toolId: data.toolId || '',
            toolName: data.toolName || '',
            input: _ccToolInputCache.get(data.toolId) || {},
            result: data.content || '',
            isError: data.isError || false,
          };
          addConversationMessage(effectiveConvId, 'cc-tool-card', JSON.stringify(persistData));
          _ccToolInputCache.delete(data.toolId);
        }
      };

      activeClaudeCodeProvider.removeAllListeners('chunk');
      activeClaudeCodeProvider.removeAllListeners('error');
      activeClaudeCodeProvider.removeAllListeners('tool-start');
      activeClaudeCodeProvider.removeAllListeners('tool-complete');
      activeClaudeCodeProvider.removeAllListeners('tool-result');
      activeClaudeCodeProvider.on('chunk', onChunk);
      activeClaudeCodeProvider.on('error', onError);
      activeClaudeCodeProvider.on('tool-start', onToolStart);
      activeClaudeCodeProvider.on('tool-complete', onToolComplete);
      activeClaudeCodeProvider.on('tool-result', onToolResult);

      // Persist user message (with attachment metadata if present, no base64)
      if (processedAttachments && processedAttachments.length > 0) {
        const persistContent = JSON.stringify({
          text: message,
          attachments: processedAttachments.map(a => ({ name: a.name, mimeType: a.mimeType, size: a.size })),
        });
        addConversationMessage(effectiveConvId, 'user', persistContent);
      } else {
        addConversationMessage(effectiveConvId, 'user', message);
      }

      // ─── Conversational plan approval ───
      // If a plan is pending and user says "do it" / "go ahead", auto-approve
      const EXECUTE_PATTERNS = [
        /^do it\b/i, /^execute\b/i, /^go ahead\b/i, /^proceed\b/i,
        /^implement\b/i, /^run it\b/i, /^ship it\b/i, /^let'?s do/i,
        /^build it\b/i, /^approved?\b/i, /^yes[,.]?\s*(do|go|execute|proceed)/i,
        /^make it\b/i, /^lgtm\b/i,
      ];
      if (activeClaudeCodeProvider.isPlanPending && EXECUTE_PATTERNS.some(p => p.test(message.trim()))) {
        try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('agent:stream-start', {}); } catch {}
        try { mainWindow.webContents.send('agent:stream-start', {}); } catch {}
        try {
          await activeClaudeCodeProvider.approvePlan();
          if (ccResponseBuffer.trim()) {
            addConversationMessage(effectiveConvId, 'assistant', ccResponseBuffer);
          }
          if (activeClaudeCodeProvider.isPlanPending) {
            try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('aria:cc-plan-complete', { conversationId: effectiveConvId }); } catch {}
          }
        } catch (err: any) {
          console.error('[main] conversational cc-approve error:', err);
          const errChunk = { text: `\n\n❌ ${err.message || 'Plan execution failed'}`, done: true };
          try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('agent:stream-chunk', errChunk); } catch {}
          try { mainWindow.webContents.send('agent:stream-chunk', errChunk); } catch {}
        }
        return;
      }

      // Send to Claude Code
      resetApiPlaybookSession(); // Track domains visited during this turn
      try {
        await activeClaudeCodeProvider.sendMessage(message, processedAttachments);
        // Persist assistant response to conversation store
        if (ccResponseBuffer.trim()) {
          addConversationMessage(effectiveConvId, 'assistant', ccResponseBuffer);
        }
        // Persist Claude Code session for resume across restarts
        const ccSid = activeClaudeCodeProvider.getSessionId();
        if (ccSid) saveClaudeCodeSessionId(effectiveConvId, ccSid);
        // If plan mode completed, notify UI so it can show approve/edit buttons
        if (activeClaudeCodeProvider.isPlanPending) {
          try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('aria:cc-plan-complete', { conversationId: effectiveConvId }); } catch {}
        }
        // ─── Domain Playbook Update (CC path) ────────────────────────────────
        try {
          const pbSession = getApiPlaybookSession();
          if (pbSession && pbSession.domainsVisited.size > 0) {
            const { updatePlaybooksFromSession } = await import('./domain-playbook');
            console.log(`[main] CC playbook update for: ${[...pbSession.domainsVisited].join(', ')}`);
            const syntheticEvents: Array<{ role: string; content: string }> = [
              { role: 'user', content: message },
              ...pbSession.toolCallLog,
              { role: 'tool', content: ccResponseBuffer || '' },
            ];
            const pbResult = await updatePlaybooksFromSession(
              pbSession.domainsVisited,
              pbSession.domainToolCounts,
              syntheticEvents,
              ccResponseBuffer || '',
              { provider: currentConfig.llm.provider, model: currentConfig.llm.model, apiKey: '' } as any,
              buildCliAuthConfig(),
            );
            if (pbResult.updated.length > 0) {
              console.log(`[main] CC playbooks updated: ${pbResult.updated.map((u: any) => `${u.domain} (${u.reason})`).join(', ')}`);
              if (ariaWC && !ariaWC.isDestroyed()) {
                ariaWC.send('domain:playbook-updated', { updates: pbResult.updated });
              }
              try { mainWindow.webContents.send('playbooks:updated'); } catch {}
            }
            if (pbResult.errors.length > 0) {
              console.warn(`[main] CC playbook warnings: ${pbResult.errors.join('; ')}`);
            }
          }
        } catch (pbErr: any) {
          console.error('[main] CC playbook update error (non-fatal):', pbErr?.message);
        }
      } catch (err: any) {
        console.error('[main] claude-code send error:', err);
        onError(err.message || 'Claude Code failed');
      }
      return;
    }

    // ─── Standard Agent Routing ────────────────────────────────────────────
    // Consume pendingScriptId (set by scripts:execute handler) so the agent
    // gets the script_persist_fix tool when executing a stored script.
    const scriptId = pendingScriptId;
    const scriptInputs = pendingScriptInputs;
    pendingScriptId = null;
    pendingScriptInputs = null;

    // ─── Conversational plan approval (Vercel SDK path) ───
    // If plan is pending and user says "do it" / "go ahead", auto-approve
    const SDK_EXECUTE_PATTERNS = [
      /^do it\b/i, /^execute\b/i, /^go ahead\b/i, /^proceed\b/i,
      /^implement\b/i, /^run it\b/i, /^ship it\b/i, /^let'?s do/i,
      /^build it\b/i, /^approved?\b/i, /^yes[,.]?\s*(do|go|execute|proceed)/i,
      /^make it\b/i, /^lgtm\b/i,
    ];
    if (isPlanPending() && SDK_EXECUTE_PATTERNS.some(p => p.test(message.trim()))) {
      const pendingOpts = getPendingPlanOpts();
      resetAgentPlanState();
      if (pendingOpts) {
        const effectiveConvId = convId || activeConversationId || 'default';
        addMessage(pendingOpts.sessionId || 'default', { role: 'user', content: 'Approved. Execute the plan.' });
        addConversationMessage(effectiveConvId, 'user', 'Approved. Execute the plan.');
        await runAgent({ ...pendingOpts, userMessage: 'Approved. Execute the plan.', planMode: false });
        return;
      }
    }

    // Reset any stale plan state when user sends a new message
    resetAgentPlanState();

    const planMode = detectPlanIntent(message);

    const browserCtx: BrowserContext = { window: mainWindow, tabManager, config: currentConfig };
    await runAgent({
      userMessage: message,
      browserCtx,
      llmConfig: {
        provider: currentConfig.llm.provider,
        model: currentConfig.llm.model,
        apiKey,
        thinking: currentConfig.llm.thinking,
        thinkingEffort: currentConfig.llm.thinkingEffort,
        region: currentConfig.llm.region,
        projectId: currentConfig.llm.projectId,
        location: currentConfig.llm.location,
        endpoint: currentConfig.llm.endpoint,
        baseUrl: currentConfig.llm.baseUrl,
        // Secondary model (Phase 8.85)
        secondaryProvider: currentConfig.llm.secondaryProvider,
        secondaryModel: currentConfig.llm.secondaryModel,
        secondaryApiKey: currentConfig.llm.secondaryApiKey ? decryptApiKey(currentConfig.llm.secondaryApiKey) : undefined,
        // Timeouts (Phase 8.40)
        agentTimeoutMs: currentConfig.llm.agentTimeoutMs,
        teammateTimeoutMs: currentConfig.llm.teammateTimeoutMs,
        subtaskTimeoutMs: currentConfig.llm.subtaskTimeoutMs,
      },
      window: mainWindow,
      developerMode: currentConfig.developerMode,
      sessionId: convId || activeConversationId || 'default',
      conversationId: convId || activeConversationId || undefined,
      ariaWebContents: tabManager?.ariaWebContents,
      attachments: processedAttachments,
      scriptId: scriptId || undefined,
      scriptInputs: scriptInputs || undefined,
      cliAuth: currentConfig.llm.provider === 'claude-code' ? buildCliAuthConfig() : undefined,
      planMode,
    });

    // After runAgent completes: if plan mode produced a plan, notify UI
    if (isPlanPending()) {
      const ariaWC = tabManager?.ariaWebContents;
      const effectiveConvId = convId || activeConversationId;
      try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('aria:plan-complete', { conversationId: effectiveConvId }); } catch {}
    }
  });

  ipcMain.on('aria:stop', () => {
    stopAgent();
    // Also stop active Claude Code provider
    if (activeClaudeCodeProvider) {
      try { activeClaudeCodeProvider.stop(); } catch {}
    }
  });

  // ─── Claude Code Plan Mode: Approve & Edit ─────────────────────────────

  ipcMain.handle('aria:cc-approve-plan', async () => {
    if (!activeClaudeCodeProvider) return;
    const ariaWC = tabManager?.ariaWebContents;
    const effectiveConvId = activeConversationId || 'default';

    // Wire up streaming events — accumulate response for persistence
    let ccResponseBuffer = '';
    const onChunk = (data: { text: string; done: boolean }) => {
      if (data.text) ccResponseBuffer += data.text;
      try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('agent:stream-chunk', data); } catch {}
      try { mainWindow.webContents.send('agent:stream-chunk', data); } catch {}
    };
    const onError = (error: string) => {
      const errChunk = { text: `\n\n❌ ${error}`, done: true };
      try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('agent:stream-chunk', errChunk); } catch {}
      try { mainWindow.webContents.send('agent:stream-chunk', errChunk); } catch {}
    };

    const onToolStart = (data: any) => {
      try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('cc:tool-start', data); } catch {}
    };
    const onToolComplete = (data: any) => {
      try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('cc:tool-complete', data); } catch {}
    };
    const onToolResult = (data: any) => {
      try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('cc:tool-result', data); } catch {}
    };

    activeClaudeCodeProvider.removeAllListeners('chunk');
    activeClaudeCodeProvider.removeAllListeners('error');
    activeClaudeCodeProvider.removeAllListeners('tool-start');
    activeClaudeCodeProvider.removeAllListeners('tool-complete');
    activeClaudeCodeProvider.removeAllListeners('tool-result');
    activeClaudeCodeProvider.on('chunk', onChunk);
    activeClaudeCodeProvider.on('error', onError);
    activeClaudeCodeProvider.on('tool-start', onToolStart);
    activeClaudeCodeProvider.on('tool-complete', onToolComplete);
    activeClaudeCodeProvider.on('tool-result', onToolResult);

    try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('agent:stream-start', {}); } catch {}
    try { mainWindow.webContents.send('agent:stream-start', {}); } catch {}

    try {
      await activeClaudeCodeProvider.approvePlan();
      // Persist the execution response
      if (ccResponseBuffer.trim()) {
        addConversationMessage(effectiveConvId, 'assistant', ccResponseBuffer);
      }
    } catch (err: any) {
      console.error('[main] cc-approve-plan error:', err);
      onError(err.message || 'Plan execution failed');
    }
  });

  ipcMain.handle('aria:cc-edit-plan', async (_e, { feedback }: { feedback: string }) => {
    if (!activeClaudeCodeProvider) return;
    const ariaWC = tabManager?.ariaWebContents;
    const effectiveConvId = activeConversationId || 'default';

    // Accumulate response for persistence
    let ccResponseBuffer = '';
    const onChunk = (data: { text: string; done: boolean }) => {
      if (data.text) ccResponseBuffer += data.text;
      try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('agent:stream-chunk', data); } catch {}
      try { mainWindow.webContents.send('agent:stream-chunk', data); } catch {}
    };
    const onError = (error: string) => {
      const errChunk = { text: `\n\n❌ ${error}`, done: true };
      try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('agent:stream-chunk', errChunk); } catch {}
      try { mainWindow.webContents.send('agent:stream-chunk', errChunk); } catch {}
    };

    const onToolStart2 = (data: any) => {
      try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('cc:tool-start', data); } catch {}
    };
    const onToolComplete2 = (data: any) => {
      try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('cc:tool-complete', data); } catch {}
    };
    const onToolResult2 = (data: any) => {
      try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('cc:tool-result', data); } catch {}
    };

    activeClaudeCodeProvider.removeAllListeners('chunk');
    activeClaudeCodeProvider.removeAllListeners('error');
    activeClaudeCodeProvider.removeAllListeners('tool-start');
    activeClaudeCodeProvider.removeAllListeners('tool-complete');
    activeClaudeCodeProvider.removeAllListeners('tool-result');
    activeClaudeCodeProvider.on('chunk', onChunk);
    activeClaudeCodeProvider.on('error', onError);
    activeClaudeCodeProvider.on('tool-start', onToolStart2);
    activeClaudeCodeProvider.on('tool-complete', onToolComplete2);
    activeClaudeCodeProvider.on('tool-result', onToolResult2);

    try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('agent:stream-start', {}); } catch {}
    try { mainWindow.webContents.send('agent:stream-start', {}); } catch {}

    try {
      // Persist user feedback
      addConversationMessage(effectiveConvId, 'user', feedback);
      await activeClaudeCodeProvider.sendPlanFeedback(feedback);
      // Persist updated plan response
      if (ccResponseBuffer.trim()) {
        addConversationMessage(effectiveConvId, 'assistant', ccResponseBuffer);
      }
      // If plan mode completed again, notify UI for another round
      if (activeClaudeCodeProvider.isPlanPending) {
        try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('aria:cc-plan-complete', {}); } catch {}
      }
    } catch (err: any) {
      console.error('[main] cc-edit-plan error:', err);
      onError(err.message || 'Plan feedback failed');
    }
  });

  // Reset Claude Code plan state (e.g. when user switches permission mode)
  ipcMain.handle('aria:cc-reset-plan', () => {
    if (activeClaudeCodeProvider) {
      activeClaudeCodeProvider.resetPlanState();
      activeClaudeCodeProvider.resetSession(); // Don't resume old plan-mode session
    }
    return { success: true };
  });

  // ─── Vercel SDK Plan Mode: Approve & Edit ─────────────────────────────

  ipcMain.handle('aria:approve-plan', async () => {
    const pendingOpts = getPendingPlanOpts();
    if (!pendingOpts) return;
    resetAgentPlanState();

    const ariaWC = tabManager?.ariaWebContents;
    const effectiveConvId = activeConversationId || 'default';

    // Add approval message to conversation history
    addMessage(pendingOpts.sessionId || 'default', {
      role: 'user', content: 'Approved. Execute the plan.',
    });
    if (effectiveConvId) {
      addConversationMessage(effectiveConvId, 'user', 'Approved. Execute the plan.');
    }

    // Re-run agent with full tools (planMode=false), same session
    await runAgent({
      ...pendingOpts,
      userMessage: 'Approved. Execute the plan.',
      planMode: false,
    });
  });

  ipcMain.handle('aria:edit-plan', async (_e, { feedback }: { feedback: string }) => {
    const pendingOpts = getPendingPlanOpts();
    if (!pendingOpts) return;
    resetAgentPlanState();

    const ariaWC = tabManager?.ariaWebContents;
    const effectiveConvId = activeConversationId || 'default';

    // Persist feedback
    addMessage(pendingOpts.sessionId || 'default', {
      role: 'user', content: feedback,
    });
    if (effectiveConvId) {
      addConversationMessage(effectiveConvId, 'user', feedback);
    }

    // Re-run in plan mode with feedback as the new message
    await runAgent({
      ...pendingOpts,
      userMessage: feedback,
      planMode: true,
    });

    // If plan completed again, notify UI for another cycle
    if (isPlanPending()) {
      try { if (ariaWC && !ariaWC.isDestroyed()) ariaWC.send('aria:plan-complete', { conversationId: effectiveConvId }); } catch {}
    }
  });

  ipcMain.handle('aria:reset-plan', () => {
    resetAgentPlanState();
    return { success: true };
  });

  // ─── Scripts (Scriptify) ───────────────────────────────────────────────

  ipcMain.handle('scripts:list', () => listScripts());
  ipcMain.handle('scripts:get', (_e, id: string) => getScript(id));
  ipcMain.handle('scripts:delete', (_e, id: string) => deleteScript(id));

  ipcMain.handle('scripts:scriptify', async (_e, conversationId: string, additionalInstructions?: string) => {
    const apiKey = decryptApiKey(currentConfig.llm.apiKey);
    const ccAuth = (currentConfig.llm as any).claudeCodeAuth;
    const isClaudeCodeNoKey = currentConfig.llm.provider === 'claude-code' && (ccAuth === 'oauth' || ccAuth === 'bedrock');
    if (!apiKey && !isClaudeCodeNoKey) {
      return { success: false, error: 'No API key configured.' };
    }

    // Route to CLI path for Claude Code provider (OAuth/Bedrock — no direct API key)
    if (currentConfig.llm.provider === 'claude-code') {
      return scriptifyConversationViaCli(conversationId, buildCliAuthConfig(), additionalInstructions);
    }

    // All other providers: use Vercel AI SDK
    const llmConfig = {
      provider: currentConfig.llm.provider,
      model: currentConfig.llm.model,
      apiKey,
      thinking: currentConfig.llm.thinking,
    };
    return scriptifyConversation(conversationId, llmConfig, additionalInstructions);
  });

  ipcMain.handle('scripts:update', async (_e, scriptId: string, instructions: string) => {
    const apiKey = decryptApiKey(currentConfig.llm.apiKey);
    const ccAuth = (currentConfig.llm as any).claudeCodeAuth;
    const isClaudeCodeNoKey = currentConfig.llm.provider === 'claude-code' && (ccAuth === 'oauth' || ccAuth === 'bedrock');
    if (!apiKey && !isClaudeCodeNoKey) {
      return { success: false, error: 'No API key configured.' };
    }

    const llmConfig: any = {
      provider: currentConfig.llm.provider,
      model: currentConfig.llm.model,
      apiKey: apiKey || undefined,
      thinking: currentConfig.llm.thinking,
    };
    const isCC = currentConfig.llm.provider === 'claude-code';
    return updateScriptDefinition(scriptId, instructions, llmConfig, isCC ? buildCliAuthConfig() : undefined);
  });

  ipcMain.on('scripts:execute', async (_e, scriptId: string, inputs: any, conversationId?: string, skipAuthCheck?: boolean, specialInstructions?: string) => {
    const ariaWC = tabManager?.ariaWebContents;

    const script = getScript(scriptId);
    if (!script) {
      if (ariaWC && !ariaWC.isDestroyed()) {
        ariaWC.send('scripts:execute-error', { error: 'Script not found. It may have been deleted.' });
      }
      return;
    }

    if (!ariaWC || ariaWC.isDestroyed()) {
      console.error('[scripts] Aria webContents unavailable for script execution.');
      return;
    }

    // Auth validation (skip if user chose "Run Anyway")
    if (!skipAuthCheck && script.authRequirements && script.authRequirements.length > 0) {
      const authResult = validateAuthRequirements(script.authRequirements);
      if (!authResult.satisfied) {
        ariaWC.send('scripts:auth-required', {
          scriptId,
          inputs,
          conversationId,
          missing: authResult.missing,
        });
        return;
      }
    }

    const executionMessage = buildExecutionPrompt(script, inputs, specialInstructions || undefined);
    incrementRunCount(scriptId);

    pendingScriptId = scriptId;
    pendingScriptInputs = Array.isArray(inputs) ? inputs[0] : inputs;
    ariaWC.send('scripts:execute-ready', { message: executionMessage, conversationId });
  });

  ipcMain.handle('scripts:check-auth', (_e, domains: string[]) => {
    return domains.map(domain => ({
      domain,
      hasCredentials: getPasswordsForDomain(domain).length > 0,
    }));
  });

  ipcMain.handle('scripts:parse-bulk', async (_e, scriptId: string, fileData: ArrayBuffer, filename: string) => {
    return parseBulkFile(scriptId, Buffer.from(fileData), filename);
  });

  // ─── Script Scheduling ──────────────────────────────────────────────────
  ipcMain.handle('scripts:schedule', (_e, data: { scriptId: string; inputs: any; schedule: any; name?: string }) => {
    try {
      const script = getScript(data.scriptId);
      if (!script) return { success: false, error: 'Script not found.' };

      // Prevent duplicate active schedules for the same script
      const existing = getJobsList().find(j => j.scriptId === data.scriptId && j.enabled);
      if (existing) return { success: false, error: 'An active schedule already exists for this script. Cancel it first.' };

      const jobName = data.name || `Script: ${script.name}`;
      const taskPlaceholder = `[Scheduled script: ${script.name}]`;
      const result = cronAddJob(jobName, taskPlaceholder, data.schedule, data.scriptId, data.inputs);
      return { success: true, result };
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to schedule script.' };
    }
  });

  ipcMain.handle('scripts:get-schedules', (_e, scriptId: string) => {
    return getJobsList().filter(j => j.scriptId === scriptId);
  });

  ipcMain.handle('scripts:cancel-schedule', (_e, jobId: string) => {
    try {
      const result = cronDeleteJob(jobId);
      return { success: true, result };
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to cancel schedule.' };
    }
  });

  ipcMain.handle('aria:new-chat', () => {
    // Create a new conversation and switch to it
    const conv = createConversation();
    activeConversationId = conv.id;
    // Clear in-memory history for the new session
    clearHistory('default');
    // Reset Claude Code session so new chat starts fresh
    if (activeClaudeCodeProvider) {
      activeClaudeCodeProvider.resetSession();
    }
    // Notify Aria tab
    try {
      const ariaWC = tabManager?.ariaWebContents;
      if (ariaWC) ariaWC.send('aria:conversation-switched', { conversationId: conv.id });
    } catch {}
    return conv;
  });

  ipcMain.handle('aria:switch-conversation', async (_e, conversationId: string) => {
    activeConversationId = conversationId;
    // Clear in-memory history so next agent run starts fresh with the loaded conv
    clearHistory('default');
    // Restore Claude Code session for the switched-to conversation
    if (activeClaudeCodeProvider) {
      const savedSid = getClaudeCodeSessionId(conversationId);
      activeClaudeCodeProvider.setSessionId(savedSid); // null if no CC session
    }
    return { success: true, conversationId };
  });

  ipcMain.handle('aria:delete-conversation', async (_e, conversationId: string) => {
    deleteConvFromStore(conversationId);
    // If we deleted the active one, clear the active ID — let the frontend decide what to show next
    // (the frontend already handles switching to the next conversation or creating a new one)
    if (activeConversationId === conversationId) {
      activeConversationId = '';
      clearHistory('default');
    }
    return { success: true };
  });

  ipcMain.handle('aria:rename-conversation', async (_e, conversationId: string, title: string) => {
    updateConversationTitle(conversationId, title);
    return { success: true };
  });

  ipcMain.handle('aria:list-conversations', () => {
    return listConversations(50);
  });

  ipcMain.handle('aria:get-messages', (_e, conversationId: string, offset = 0, limit = 100) => {
    return getConversationMessages(conversationId, offset, limit);
  });

  ipcMain.handle('aria:search-conversations', (_e, query: string) => {
    return searchConversations(query, undefined, 20);
  });

  ipcMain.handle('aria:get-active-conversation', () => {
    return activeConversationId;
  });

  // ─── Export Conversation as PDF ─────────────────────────────────────────────

  /**
   * Extract display-friendly text from a stored message content string.
   * User messages may be JSON `{ text, attachments }` or plain strings.
   * Assistant messages are returned as-is (markdown).
   * Tool messages are included as tool output. Thinking/download roles are skipped.
   */
  function extractDisplayContent(role: string, content: string): string | null {
    if (role === 'thinking' || role === 'download') return null;
    if (role === 'user') {
      try {
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') {
          let result = parsed.text;
          if (Array.isArray(parsed.attachments) && parsed.attachments.length > 0) {
            const names = parsed.attachments.map((a: any) => a.name || 'file').join(', ');
            result += `\n\n[Attachments: ${names}]`;
          }
          return result;
        }
      } catch { /* not JSON, treat as plain string */ }
      return content;
    }
    if (role === 'tool') {
      // Skip download cards, include other tool output
      if (content.startsWith('{"type":"download"') || content.startsWith('{"card":"download"')) return null;
      return content;
    }
    return content; // assistant
  }

  function buildConversationHtml(
    title: string,
    createdAt: string,
    messages: Array<{ role: string; content: string; timestamp?: number }>
  ): string {
    const { marked } = require('marked') as typeof import('marked');

    const escapeHtml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const messageCards = messages.map(msg => {
      const displayContent = extractDisplayContent(msg.role, msg.content);
      if (displayContent === null) return '';

      const roleLabel = msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'Aria' : 'Tool';
      const borderColor = msg.role === 'user' ? '#3b82f6' : msg.role === 'assistant' ? '#e94560' : '#6b7280';
      const ts = msg.timestamp ? new Date(msg.timestamp).toLocaleString() : '';

      let bodyHtml: string;
      if (msg.role === 'assistant') {
        try {
          bodyHtml = (marked as any).parse(displayContent);
        } catch {
          bodyHtml = `<pre>${escapeHtml(displayContent)}</pre>`;
        }
      } else if (msg.role === 'tool') {
        bodyHtml = `<pre class="tool-output">${escapeHtml(displayContent)}</pre>`;
      } else {
        bodyHtml = `<p>${escapeHtml(displayContent).replace(/\n/g, '<br>')}</p>`;
      }

      return `
        <div class="message-card" style="border-left: 4px solid ${borderColor};">
          <div class="message-header">
            <span class="role-label">${roleLabel}</span>
            <span class="timestamp">${ts}</span>
          </div>
          <div class="message-body">${bodyHtml}</div>
        </div>`;
    }).filter(Boolean).join('\n');

    const dateStr = createdAt ? new Date(createdAt).toLocaleString() : '';
    const msgCount = messages.filter(m => extractDisplayContent(m.role, m.content) !== null).length;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 24px; line-height: 1.6; color: #1a1a2e; background: #fff; }
  .header { margin-bottom: 32px; border-bottom: 2px solid #e94560; padding-bottom: 16px; }
  .header h1 { margin: 0 0 8px 0; font-size: 1.6em; color: #0f3460; }
  .header .meta { color: #666; font-size: 0.9em; }
  .message-card { margin: 16px 0; padding: 12px 16px; background: #fafafa; border-radius: 6px; break-inside: avoid; }
  .message-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .role-label { font-weight: 600; font-size: 0.85em; text-transform: uppercase; color: #444; }
  .timestamp { font-size: 0.8em; color: #999; }
  .message-body { font-size: 0.95em; }
  .message-body p { margin: 0.4em 0; }
  pre { background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 6px; padding: 12px; overflow-x: auto; font-size: 0.85em; white-space: pre-wrap; word-wrap: break-word; }
  code { background: #f0f0f0; padding: 2px 5px; border-radius: 3px; font-size: 0.9em; }
  pre code { background: none; padding: 0; }
  .tool-output { background: #f9f9f9; border-left: 3px solid #6b7280; color: #555; font-size: 0.8em; max-height: 300px; overflow-y: auto; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
  th { background: #f0f0f0; }
  blockquote { border-left: 4px solid #e94560; margin: 0; padding: 0 16px; color: #555; }
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #ddd; text-align: center; font-size: 0.8em; color: #999; }
  @media print { .message-card { break-inside: avoid; } }
</style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">${dateStr} &middot; ${msgCount} messages</div>
  </div>
  ${messageCards}
  <div class="footer">Exported from Tappi Browser</div>
</body>
</html>`;
  }

  ipcMain.handle('aria:export-conversation-pdf', async (_e, conversationId: string) => {
    try {
      const conv = getConversation(conversationId);
      if (!conv) return { success: false, error: 'Conversation not found' };

      const msgs = getConversationMessages(conversationId, 0, 10000);
      if (!msgs || msgs.length === 0) return { success: false, error: 'No messages to export' };

      const htmlContent = buildConversationHtml(conv.title || 'Untitled', conv.created_at, msgs);

      // Create hidden BrowserWindow to render PDF
      const pdfWin = new BrowserWindow({ show: false, webPreferences: { sandbox: false } });

      // For large HTML, write to temp file; otherwise use data URL
      if (htmlContent.length > 1_000_000) {
        const tmpPath = path.join(os.tmpdir(), `tappi-conv-${Date.now()}.html`);
        fs.writeFileSync(tmpPath, htmlContent, 'utf-8');
        await pdfWin.loadFile(tmpPath);
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      } else {
        await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent));
      }

      const pdfData = await pdfWin.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        marginsType: 1,
      } as any);
      pdfWin.destroy();

      // Build filename: aria-{sanitized-title}-{timestamp}.pdf
      const sanitizedTitle = (conv.title || 'untitled')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 50);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `aria-${sanitizedTitle}-${timestamp}.pdf`;
      const outPath = path.join(os.homedir(), 'Downloads', filename);

      fs.writeFileSync(outPath, pdfData);
      return { success: true, path: outPath };
    } catch (e: any) {
      console.error('[aria] export PDF error:', e);
      return { success: false, error: e.message || 'PDF export failed' };
    }
  });

  // ─── Claude Code Provider IPC ────────────────────────────────────────────────

  ipcMain.handle('claude-code:check-installed', async (_e, authMethod?: 'api-key' | 'oauth' | 'bedrock') => {
    const { isClaudeCodeInstalled } = await import('./claude-code-provider');
    return isClaudeCodeInstalled(authMethod || 'oauth');
  });

  ipcMain.handle('claude-code:install', async (_e, authMethod?: 'api-key' | 'oauth' | 'bedrock') => {
    const { installClaudeCode } = await import('./claude-code-provider');
    try {
      await installClaudeCode(authMethod || 'oauth', (msg) => console.log('[claude-code] install:', msg));
      return { success: true };
    } catch (err: any) {
      console.error('[claude-code] install error:', err);
      return { success: false, error: err.message || 'Installation failed' };
    }
  });

  ipcMain.handle('claude-code:get-version', async () => {
    const { getCliVersion, getLatestCliVersion } = await import('./claude-code-provider');
    const [current, latest] = await Promise.all([getCliVersion(), getLatestCliVersion()]);
    return { current, latest, updateAvailable: !!(current && latest && current !== latest) };
  });

  ipcMain.handle('claude-code:update', async () => {
    const { updateClaudeCli } = await import('./claude-code-provider');
    try {
      await updateClaudeCli((msg) => console.log('[claude-code] update:', msg));
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Update failed' };
    }
  });

  ipcMain.handle('claude-code:check-auth', async (_e, authMethod?: string) => {
    const { checkClaudeAuthStatus } = await import('./claude-code-provider');
    return checkClaudeAuthStatus(authMethod as any);
  });

  ipcMain.handle('claude-code:check-bedrock', async () => {
    const { checkBedrock } = await import('./credential-checker');
    return checkBedrock();
  });

  // ─── Claude Code OAuth Login Flow ──────────────────────────────────────────

  let ccOAuthPopup: BrowserWindow | null = null;
  let ccOAuthInFlight = false;
  let ccOAuthTimeout: NodeJS.Timeout | null = null;

  const finishCCOAuthFlow = () => {
    ccOAuthInFlight = false;
    if (ccOAuthTimeout) {
      clearTimeout(ccOAuthTimeout);
      ccOAuthTimeout = null;
    }
    if (ccOAuthPopup && !ccOAuthPopup.isDestroyed()) {
      try { ccOAuthPopup.close(); } catch {}
    }
    ccOAuthPopup = null;
  };

  const emitCCOAuthStatus = (phase: 'started' | 'progress' | 'success' | 'error', message: string) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('oauth:claude-code:status', { phase, message, ts: Date.now() });
    // Also send to aria webcontents
    const ariaWC = tabManager?.ariaWebContents;
    if (ariaWC && !ariaWC.isDestroyed()) {
      try { ariaWC.send('oauth:claude-code:status', { phase, message, ts: Date.now() }); } catch {}
    }
  };

  /**
   * Internal function to run the Claude Code OAuth login flow.
   * Opens a BrowserWindow popup for the OAuth page (never the system browser).
   * Returns a promise that resolves when login completes or fails.
   */
  const runCCOAuthLogin = async (): Promise<{ success: boolean; error?: string }> => {
    if (ccOAuthInFlight) {
      return { success: false, error: 'OAuth flow already in progress.' };
    }

    const { checkClaudeAuthStatus, loginClaudeCode } = await import('./claude-code-provider');

    // Already logged in? Return early.
    const status = await checkClaudeAuthStatus();
    if (status.loggedIn) {
      return { success: true };
    }

    ccOAuthInFlight = true;
    emitCCOAuthStatus('started', 'Starting Claude Code sign-in...');

    // 10-minute timeout
    ccOAuthTimeout = setTimeout(() => {
      emitCCOAuthStatus('error', 'OAuth timed out after 10 minutes. Please try again.');
      finishCCOAuthFlow();
    }, 10 * 60 * 1000);

    try {
      const result = await loginClaudeCode((url) => {
        // This callback fires when Claude Code emits the OAuth URL.
        // Open it in a Tappi BrowserWindow popup instead of the system browser.
        emitCCOAuthStatus('progress', 'Sign-in window opening...');

        ccOAuthPopup = new BrowserWindow({
          width: 980,
          height: 760,
          parent: mainWindow,
          modal: false,
          autoHideMenuBar: true,
          title: 'Claude Code Sign In',
          webPreferences: {
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
          },
        });

        ccOAuthPopup.on('closed', () => {
          ccOAuthPopup = null;
          // Don't finish the flow here — the login process may still complete
          // via the localhost callback even after the popup closes.
        });

        ccOAuthPopup.loadURL(url);
        ccOAuthPopup.focus();

        emitCCOAuthStatus('progress', 'Sign-in window opened. Complete login in the popup.');
      });

      finishCCOAuthFlow();

      if (result.success) {
        emitCCOAuthStatus('success', 'Claude Code sign-in complete.');
      } else {
        emitCCOAuthStatus('error', result.error || 'Sign-in failed.');
      }

      return result;
    } catch (err: any) {
      finishCCOAuthFlow();
      const msg = err.message || 'Sign-in failed';
      emitCCOAuthStatus('error', msg);
      return { success: false, error: msg };
    }
  };

  ipcMain.handle('claude-code:login', async () => {
    return runCCOAuthLogin();
  });

  // ─── Prompt Enhancement (Phase 9.098) ───────────────────────────────────────
  ipcMain.handle('aria:enhance-prompt', async (_e, prompt: string, webSearch: boolean, mode: 'quick' | 'deep' = 'quick', conversationId?: string) => {
    // Prompt enhancement is not available with Claude Code provider
    if (currentConfig.llm.provider === 'claude-code') {
      return { error: 'Prompt enhancement is not available when using Claude Code as the provider.' };
    }

    const { generateText, streamText } = await import('ai');
    const { createModel, buildProviderOptions, withCodexProviderOptions } = await import('./llm-client');
    const { SYSTEM_PROMPT } = await import('./agent');
    const { TOOL_USAGE_GUIDE } = await import('./tool-registry');
    const { getConversationMessages } = await import('./conversation-store');

    if (!currentConfig.llm?.apiKey) {
      return { error: 'No API key configured' };
    }

    const apiKey = decryptApiKey(currentConfig.llm.apiKey);

    const QUICK_ENHANCEMENT_PROMPT = `You are a prompt enhancement assistant. Your job is to rewrite user prompts to be clearer and more actionable for an AI agent that controls a web browser.

Rewrite the user's prompt using this structure:

**Goal**: [What they want - one sentence]

**Context**: [What you understand about their situation]

**Deliverable**: [What a successful response looks like]

**Constraints**: [Any limits, preferences, or requirements]

Rules:
- Preserve the user's intent - don't change what they're asking
- Add clarity where ambiguous
- If searching the web, include relevant context you found
- Keep it concise (under 300 words)
- Don't add requirements they didn't mention
- You will receive [Agent Capabilities], [Available Tools], and [Recent Conversation] sections — use these to tailor the enhancement to what the agent can actually do
- Reference specific tool names when the user's intent maps to available tools
- If there's conversation context, build on what's been discussed
- Always end the enhanced prompt with: "First understand this request clearly. Then figure out how to fulfill this request. Then solve the problem or fulfill this request."`;

    const DEEP_ENHANCEMENT_PROMPT = `You are a prompt enhancement assistant. Rewrite the user's prompt to be clearer AND more robust by considering multiple perspectives. The prompt is for an AI agent that controls a web browser.

Think through:
- Caveats and edge cases
- Opposing viewpoints
- Blind spots the user may have missed
- Alternative approaches

Then output ONLY this format:

**Goal**: [One-sentence intent]

**Prompt**:
[The rewritten, enhanced prompt with all considerations baked in]

**Additional Considerations**:
- [Key caveat or edge case to be aware of]
- [Another consideration, if relevant]

**New Angles**:
- [Perspective or approach the user didn't consider]
- [Another angle, if relevant]

Rules:
- Preserve the user's intent exactly
- Bake all improvements into the Prompt section
- Only list considerations that genuinely matter
- Keep the enhanced prompt under 300 words
- Be specific, not generic
- You will receive [Agent Capabilities], [Available Tools], and [Recent Conversation] sections — use these to make the enhancement specific to the agent's actual capabilities
- Reference specific tool names when the user's intent maps to available tools
- If there's conversation context, tailor the enhancement to build on what's been discussed
- Always end the enhanced prompt with: "First understand this request clearly. Then figure out how to fulfill this request. Then solve the problem or fulfill this request."`;

    // Quick web search helper (uses DuckDuckGo instant answers - no API key needed)
    async function quickWebSearch(query: string): Promise<string> {
      try {
        const https = await import('https');
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
        
        return new Promise((resolve) => {
          https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try {
                const json = JSON.parse(data);
                const abstract = json.AbstractText || '';
                const related = (json.RelatedTopics || []).slice(0, 3)
                  .map((t: any) => t.Text)
                  .filter(Boolean)
                  .join('; ');
                resolve(abstract || related || '');
              } catch {
                resolve('');
              }
            });
          }).on('error', () => resolve(''));
        });
      } catch {
        return '';
      }
    }

    try {
      const enhanceProvider = currentConfig.llm.provider;
      const enhanceModel = currentConfig.llm.model;

      const model = createModel({
        provider: enhanceProvider,
        model: enhanceModel,
        apiKey,
        region: currentConfig.llm.region,
        projectId: currentConfig.llm.projectId,
        location: currentConfig.llm.location,
        endpoint: currentConfig.llm.endpoint,
        baseUrl: currentConfig.llm.baseUrl,
      });

      let contextBlock = '';

      // If web search is enabled, fetch context
      if (webSearch) {
        const searchContext = await quickWebSearch(prompt);
        if (searchContext) {
          contextBlock += `\n\n[Web Context]\n${searchContext}`;
        }
      }

      // Add agent capabilities context for richer enhancement
      contextBlock += `\n\n[Agent Capabilities]\n${SYSTEM_PROMPT.slice(0, 500)}`;
      contextBlock += `\n\n[Available Tools]\n${TOOL_USAGE_GUIDE.slice(0, 1000)}`;

      // Add recent conversation context if available
      if (conversationId) {
        try {
          const recentMsgs = getConversationMessages(conversationId, 0, 100);
          const lastMessages = recentMsgs.slice(-10);
          if (lastMessages.length > 0) {
            const convSummary = lastMessages.map(m => {
              const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
              return `[${m.role}]: ${content.slice(0, 200)}`;
            }).join('\n');
            contextBlock += `\n\n[Recent Conversation]\n${convSummary}`;
          }
        } catch {
          // Non-fatal — conversation may not exist yet
        }
      }

      const systemPrompt = mode === 'deep' ? DEEP_ENHANCEMENT_PROMPT : QUICK_ENHANCEMENT_PROMPT;
      const maxTokens = mode === 'deep' ? 800 : 600;

      const providerOptions = buildProviderOptions({
        provider: enhanceProvider,
        model: enhanceModel,
        apiKey,
        thinking: currentConfig.llm.thinking,
        thinkingEffort: currentConfig.llm.thinkingEffort,
      });
      const callProviderOptions: Record<string, any> = withCodexProviderOptions(
        enhanceProvider,
        { ...providerOptions },
        systemPrompt,
        systemPrompt,
      );

      if (enhanceProvider === 'openai-codex') {
        const streamed = streamText({
          model,
          system: systemPrompt,
          messages: [{ role: 'user', content: prompt + contextBlock }],
          ...(Object.keys(callProviderOptions).length > 0 ? { providerOptions: callProviderOptions } : {}),
        });
        let enhanced = '';
        for await (const chunk of streamed.textStream) enhanced += chunk;
        return { enhanced, mode };
      }

      const result = await generateText({
        model,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt + contextBlock }],
        maxOutputTokens: maxTokens,
        ...(Object.keys(callProviderOptions).length > 0 ? { providerOptions: callProviderOptions } : {}),
      });

      return { enhanced: result.text, mode };
    } catch (err: any) {
      console.error('[main] enhance-prompt error:', err);
      return { error: err.message || 'Enhancement failed' };
    }
  });

  // ─── Projects IPC (Phase 9.07) ───────────────────────────────────────────

  ipcMain.handle('projects:list', (_e, includeArchived = false) => {
    return listProjects(includeArchived);
  });

  ipcMain.handle('projects:get', (_e, projectId: string) => {
    return getProject(projectId);
  });

  ipcMain.handle('projects:create', (_e, name: string, workingDir: string, description?: string) => {
    // Dedup: check for existing project with same name or working_dir
    const existing = findExistingProject(name, workingDir || undefined);
    if (existing) {
      // Update working_dir/description if they were missing on the existing project
      const updates: any = {};
      if (workingDir && !existing.working_dir) updates.working_dir = workingDir;
      if (description && !existing.description) updates.description = description;
      if (Object.keys(updates).length > 0) updateProjectRecord(existing.id, updates);
      try { tabManager?.ariaWebContents?.send('projects:updated'); } catch {}
      return getProject(existing.id) || existing;
    }
    const project = createProject(name, workingDir || '', description);
    // Notify Aria tab that projects changed (Phase 9.09)
    try { tabManager?.ariaWebContents?.send('projects:updated'); } catch {}
    return project;
  });

  ipcMain.handle('projects:get-artifacts', (_e, projectId: string) => {
    return getArtifacts(projectId);
  });

  ipcMain.handle('projects:link-conversation', (_e, conversationId: string, projectId: string) => {
    linkConvToProject(conversationId, projectId);
    // Notify Aria tab that projects changed (Phase 9.09)
    try { tabManager?.ariaWebContents?.send('projects:updated'); } catch {}
    return { success: true };
  });

  ipcMain.handle('projects:get-conversations', (_e, projectId: string) => {
    return getProjectConversations(projectId);
  });

  // Phase 9.09: Create a new conversation pre-linked to a project
  ipcMain.handle('projects:new-conversation', async (_e, projectId: string) => {
    const { randomUUID } = require('crypto');
    const convId = randomUUID();
    const now = new Date().toISOString();
    const db = getDb();
    db.prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at, message_count, preview, archived, project_id, mode)
       VALUES (?, 'New conversation', ?, ?, 0, '', 0, ?, 'coding')`
    ).run(convId, now, now, projectId);
    // Bump project updated_at
    db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).run(now, projectId);
    // Switch active conversation
    activeConversationId = convId;
    clearHistory('default');
    // Notify Aria tab
    try {
      const ariaWC = tabManager?.ariaWebContents;
      if (ariaWC) {
        ariaWC.send('aria:conversation-switched', { conversationId: convId });
        ariaWC.send('projects:updated');
      }
    } catch {}
    return convId;
  });

  // Phase 9.095: Delete a project (unlink or delete-all)
  // Phase 9.096b: Hardened project deletion.
  // - 'unlink': DB-only (remove from sidebar, keep files + conversations as standalone)
  // - 'delete-all': DB delete + conversations, but directory trash requires separate explicit IPC
  // - Active project (team running) cannot be deleted at all
  ipcMain.handle('projects:delete', async (_e, projectId: string, mode: 'unlink' | 'delete-all') => {
    const db = getDb();
    const project = getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };

    // Phase 9.096b: Block deletion of currently-active project (team running on it)
    const activeTeam = getActiveTeam();
    if (activeTeam && project.working_dir) {
      const resolvedProjectDir = project.working_dir.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '.');
      const resolvedTeamDir = activeTeam.workingDir.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '.');
      if (resolvedProjectDir === resolvedTeamDir) {
        return { success: false, error: 'Cannot delete project while a team is actively working on it. Dissolve the team first.' };
      }
    }

    if (mode === 'delete-all') {
      // 1. Delete all linked conversations
      const convRows = db.prepare(
        `SELECT id FROM conversations WHERE project_id = ?`
      ).all(projectId) as { id: string }[];
      for (const row of convRows) {
        db.prepare(`DELETE FROM conversations WHERE id = ?`).run(row.id);
      }
      // 2. Delete the project record (CASCADE handles artifacts)
      db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId);
      // Phase 9.096b: Directory trash is now a SEPARATE step.
      // The UI must call 'projects:trash-dir' explicitly after showing a second confirmation.
      // This IPC no longer touches the filesystem.
    } else {
      // 'unlink': just delete the project record.
      // Conversations get project_id = NULL via ON DELETE SET NULL.
      // project_artifacts CASCADE-deleted automatically.
      db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId);
    }

    // Notify Aria tab
    try { tabManager?.ariaWebContents?.send('projects:updated'); } catch {}
    return { success: true };
  });

  // Phase 9.096b: Separate IPC for trashing a project's working directory.
  // Only callable from UI with explicit double-confirmation.
  // Never callable from agent tools.
  ipcMain.handle('projects:trash-dir', async (_e, dirPath: string) => {
    if (!dirPath) return { success: false, error: 'No directory path provided' };

    const resolved = dirPath.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '.');

    // Safety: Block trashing of protected paths
    const home = process.env.HOME || process.env.USERPROFILE || '/';
    const protectedPaths = [
      home,
      '/',
      path.join(home, '.tappi-browser'),
      path.join(home, '.tappi'),
      path.join(home, 'Desktop'),
      path.join(home, 'Documents'),
      path.join(home, 'Downloads'),
      path.resolve(__dirname, '..'),
    ];

    const normalizedResolved = path.resolve(resolved);
    for (const pp of protectedPaths) {
      if (normalizedResolved === path.resolve(pp)) {
        return { success: false, error: `Cannot trash protected path: ${pp}` };
      }
    }

    // Safety: Block if an active team is using this directory
    const activeTeam2 = getActiveTeam();
    if (activeTeam2) {
      const resolvedTeamDir = activeTeam2.workingDir.replace(/^~/, home);
      if (normalizedResolved === path.resolve(resolvedTeamDir)) {
        return { success: false, error: 'Cannot trash directory while a team is actively working on it.' };
      }
    }

    // Check directory exists
    if (!fs.existsSync(resolved)) {
      return { success: false, error: 'Directory does not exist' };
    }

    try {
      await shell.trashItem(resolved);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: `trashItem failed: ${err?.message || err}` };
    }
  });

  // ─── Overlay IPC (hide/show BrowserViews for modals) ───
  ipcMain.on('overlay:show', () => {
    tabManager.hideAllViews();
  });

  ipcMain.on('overlay:hide', () => {
    tabManager.showAllViews();
  });

  // ─── OpenAI Codex OAuth (Settings UI) ───
  let openAICodexOAuthInFlight = false;
  let openAICodexOAuthServer: http.Server | null = null;
  let openAICodexOAuthTimeout: NodeJS.Timeout | null = null;
  let openAICodexOAuthPopup: BrowserWindow | null = null;

  const emitOpenAICodexOAuthStatus = (phase: 'started' | 'progress' | 'success' | 'error', message: string) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('oauth:openai-codex:status', { phase, message, ts: Date.now() });
  };

  const finishOpenAICodexOAuthFlow = () => {
    openAICodexOAuthInFlight = false;
    if (openAICodexOAuthTimeout) {
      clearTimeout(openAICodexOAuthTimeout);
      openAICodexOAuthTimeout = null;
    }
    if (openAICodexOAuthServer) {
      try { openAICodexOAuthServer.close(); } catch {}
      openAICodexOAuthServer = null;
    }
    if (openAICodexOAuthPopup && !openAICodexOAuthPopup.isDestroyed()) {
      try { openAICodexOAuthPopup.close(); } catch {}
    }
    openAICodexOAuthPopup = null;
  };

  ipcMain.handle('oauth:openai-codex:start', async () => {
    if (openAICodexOAuthInFlight) {
      return { success: false, error: 'OAuth flow already in progress.' };
    }

    const pkce = generatePkcePair();
    const state = generateOAuthState();

    return await new Promise((resolve) => {
      const server = http.createServer(async (req, res) => {
        try {
          const requestUrl = new URL(req.url || '/', 'http://localhost');

          if (requestUrl.pathname !== '/auth/callback') {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found');
            return;
          }

          const returnedState = requestUrl.searchParams.get('state');
          if (!returnedState || returnedState !== state) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h2>State mismatch</h2><p>OAuth state did not match. Please restart login.</p>');
            emitOpenAICodexOAuthStatus('error', 'OAuth callback rejected (state mismatch).');
            finishOpenAICodexOAuthFlow();
            return;
          }

          const oauthError = requestUrl.searchParams.get('error');
          if (oauthError) {
            const description = requestUrl.searchParams.get('error_description') || oauthError;
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<h2>Sign-in failed</h2><p>${description}</p>`);
            emitOpenAICodexOAuthStatus('error', `OAuth failed: ${description}`);
            finishOpenAICodexOAuthFlow();
            return;
          }

          const code = requestUrl.searchParams.get('code');
          if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h2>Missing code</h2><p>No authorization code was returned.</p>');
            emitOpenAICodexOAuthStatus('error', 'OAuth callback missing authorization code.');
            finishOpenAICodexOAuthFlow();
            return;
          }

          emitOpenAICodexOAuthStatus('progress', 'Authorization received. Exchanging OAuth tokens…');

          const redirectUri = `http://localhost:${(server.address() as any).port}/auth/callback`;
          const exchanged = await exchangeOpenAICodexCodeForTokens(code, redirectUri, pkce.verifier);

          // Use ChatGPT OAuth access token directly for Codex backend calls.
          // This matches OpenClaw/pi-ai behavior and avoids API-org token exchange failures.
          const accessClaims = parseOpenAIAuthClaimsFromJwt(exchanged.accessToken);
          const chatgptAccountId = accessClaims?.chatgpt_account_id;
          if (!chatgptAccountId) {
            throw new Error('OAuth succeeded, but ChatGPT account metadata was missing from access token. Please retry sign-in with your intended ChatGPT account/workspace.');
          }

          const model = 'gpt-5.3-codex';
          applyConfigUpdates({
            llm: {
              provider: 'openai-codex',
              model,
              baseUrl: OPENAI_CODEX_BASE_URL,
            },
            rawApiKey: exchanged.accessToken,
          } as any);

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h2>✅ OpenAI Codex OAuth complete</h2><p>You can close this window and return to Tappi Browser.</p>');

          emitOpenAICodexOAuthStatus('success', 'OpenAI Codex OAuth complete. ChatGPT token saved.');
          finishOpenAICodexOAuthFlow();
        } catch (error: any) {
          const message = error?.message || String(error);
          try {
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<h2>OAuth failed</h2><p>${message}</p>`);
          } catch {}
          emitOpenAICodexOAuthStatus('error', `OAuth failed: ${message}`);
          finishOpenAICodexOAuthFlow();
        }
      });

      // Codex OAuth callback uses localhost:1455 in official flow.
      // Keep this fixed for compatibility with OpenAI's registered redirect expectations.
      server.listen(1455, '127.0.0.1', async () => {
        try {
          const addr = server.address() as any;
          if (!addr?.port) {
            throw new Error('Could not bind local OAuth callback server.');
          }

          openAICodexOAuthInFlight = true;
          openAICodexOAuthServer = server;

          const redirectUri = `http://localhost:${addr.port}/auth/callback`;
          const authorizeUrl = buildOpenAICodexAuthorizeUrl(redirectUri, pkce.challenge, state);

          openAICodexOAuthTimeout = setTimeout(() => {
            emitOpenAICodexOAuthStatus('error', 'OAuth timed out after 10 minutes. Please try again.');
            finishOpenAICodexOAuthFlow();
          }, 10 * 60 * 1000);

          openAICodexOAuthPopup = new BrowserWindow({
            width: 980,
            height: 760,
            parent: mainWindow,
            modal: false,
            autoHideMenuBar: true,
            title: 'OpenAI Codex Sign In',
            webPreferences: {
              contextIsolation: true,
              sandbox: true,
              nodeIntegration: false,
            },
          });

          openAICodexOAuthPopup.on('closed', () => {
            openAICodexOAuthPopup = null;
            if (openAICodexOAuthInFlight) {
              emitOpenAICodexOAuthStatus('error', 'OAuth window was closed before completion.');
              finishOpenAICodexOAuthFlow();
            }
          });

          await openAICodexOAuthPopup.loadURL(authorizeUrl);
          openAICodexOAuthPopup.focus();

          emitOpenAICodexOAuthStatus('started', 'Sign-in window opened in Tappi Browser. Complete ChatGPT login there.');
          resolve({ success: true, authorizeUrl, redirectUri });
        } catch (error: any) {
          finishOpenAICodexOAuthFlow();
          resolve({ success: false, error: error?.message || String(error) });
        }
      });

      server.on('error', (error: any) => {
        finishOpenAICodexOAuthFlow();
        const msg = error?.code === 'EADDRINUSE'
          ? 'Port 1455 is already in use. Close any other active Codex login flow and retry.'
          : (error?.message || String(error));
        resolve({ success: false, error: msg });
      });
    });
  });

  // ─── Settings IPC ───
  ipcMain.handle('config:get', () => {
    return {
      ...currentConfig,
      llm: {
        ...currentConfig.llm,
        apiKey: currentConfig.llm.apiKey ? '••••••••' : '',
        // Mask secondary key too — UI only needs to know if it's set
        secondaryApiKey: currentConfig.llm.secondaryApiKey ? '••••••••' : '',
      },
      hasApiKey: !!currentConfig.llm.apiKey,
      hasSecondaryApiKey: !!currentConfig.llm.secondaryApiKey,
    };
  });

  // Reveal the actual LLM API key (for eye toggle in settings)
  ipcMain.handle('config:reveal-api-key', () => {
    if (!currentConfig.llm.apiKey) return { key: '' };
    return { key: decryptApiKey(currentConfig.llm.apiKey) };
  });

  // Check if a specific provider has a stored API key (for settings UI provider switching)
  ipcMain.handle('config:has-provider-key', (_e, provider: string) => {
    if (provider === currentConfig.llm.provider) return { hasKey: !!currentConfig.llm.apiKey };
    return { hasKey: !!(currentConfig.llm.providerApiKeys?.[provider]) };
  });

  // List available models for a provider (Phase 9.13 — Model Picker)
  ipcMain.handle('models:list', async (_e, provider: string) => {
    const apiKey = decryptApiKey(currentConfig.llm.apiKey);
    return await listModelsForProvider(provider, {
      apiKey,
      baseUrl: currentConfig.llm.baseUrl,
      endpoint: currentConfig.llm.endpoint,
      region: currentConfig.llm.region,
      projectId: currentConfig.llm.projectId,
      location: currentConfig.llm.location,
    });
  });

  // Shared config update logic — used by both IPC handler and REST API
  function applyConfigUpdates(updates: Partial<TappiConfig & { rawApiKey?: string; rawSecondaryApiKey?: string }>): { success: boolean } {
    // Per-provider API key swap — must run BEFORE provider is updated
    if (updates.llm?.provider && updates.llm.provider !== currentConfig.llm.provider) {
      // Save current key to the old provider slot before switching
      if (currentConfig.llm.apiKey && currentConfig.llm.provider) {
        if (!currentConfig.llm.providerApiKeys) currentConfig.llm.providerApiKeys = {};
        currentConfig.llm.providerApiKeys[currentConfig.llm.provider] = currentConfig.llm.apiKey;
      }
      // Restore the new provider's stored key (or empty if none)
      currentConfig.llm.apiKey = currentConfig.llm.providerApiKeys?.[updates.llm.provider] || '';
    }
    if (updates.llm) {
      if (updates.llm.provider) currentConfig.llm.provider = updates.llm.provider;
      if (updates.llm.model !== undefined) currentConfig.llm.model = updates.llm.model;
      // Cloud provider fields
      if (updates.llm.region !== undefined) currentConfig.llm.region = updates.llm.region || undefined;
      if (updates.llm.projectId !== undefined) currentConfig.llm.projectId = updates.llm.projectId || undefined;
      if (updates.llm.location !== undefined) currentConfig.llm.location = updates.llm.location || undefined;
      if (updates.llm.endpoint !== undefined) currentConfig.llm.endpoint = updates.llm.endpoint || undefined;
      if (updates.llm.baseUrl !== undefined) currentConfig.llm.baseUrl = updates.llm.baseUrl || undefined;
      if (updates.llm.thinking !== undefined) currentConfig.llm.thinking = updates.llm.thinking;
      if ((updates.llm as any).thinkingEffort !== undefined) currentConfig.llm.thinkingEffort = (updates.llm as any).thinkingEffort;
      if ((updates.llm as any).codingMode !== undefined) currentConfig.llm.codingMode = (updates.llm as any).codingMode;
      if ((updates.llm as any).worktreeIsolation !== undefined) currentConfig.llm.worktreeIsolation = (updates.llm as any).worktreeIsolation;
      if ((updates.llm as any).claudeCodeMode !== undefined) (currentConfig.llm as any).claudeCodeMode = (updates.llm as any).claudeCodeMode;
      if ((updates.llm as any).claudeCodeAuth !== undefined) (currentConfig.llm as any).claudeCodeAuth = (updates.llm as any).claudeCodeAuth;
      if ((updates.llm as any).claudeCodeBedrockRegion !== undefined) (currentConfig.llm as any).claudeCodeBedrockRegion = (updates.llm as any).claudeCodeBedrockRegion;
      if ((updates.llm as any).claudeCodeBedrockProfile !== undefined) (currentConfig.llm as any).claudeCodeBedrockProfile = (updates.llm as any).claudeCodeBedrockProfile;
      if ((updates.llm as any).claudeCodeAgentTeams !== undefined) (currentConfig.llm as any).claudeCodeAgentTeams = (updates.llm as any).claudeCodeAgentTeams;
      if ((updates.llm as any).claudeCodeBedrockModelId !== undefined) (currentConfig.llm as any).claudeCodeBedrockModelId = (updates.llm as any).claudeCodeBedrockModelId;
      if ((updates.llm as any).claudeCodeBedrockSmallModelId !== undefined) (currentConfig.llm as any).claudeCodeBedrockSmallModelId = (updates.llm as any).claudeCodeBedrockSmallModelId;
      if ((updates.llm as any).claudeCodeAwsAuthRefresh !== undefined) (currentConfig.llm as any).claudeCodeAwsAuthRefresh = (updates.llm as any).claudeCodeAwsAuthRefresh;
      // Phase 10: Secondary model routing re-enabled — no longer force-clearing.
    }
    if ((updates as any).rawApiKey !== undefined) {
      const rawKey = (updates as any).rawApiKey;
      const encrypted = rawKey ? encryptApiKey(rawKey) : '';
      currentConfig.llm.apiKey = encrypted;
      // Store per-provider so switching back restores it
      if (encrypted && currentConfig.llm.provider) {
        if (!currentConfig.llm.providerApiKeys) currentConfig.llm.providerApiKeys = {};
        currentConfig.llm.providerApiKeys[currentConfig.llm.provider] = encrypted;
      }
    }
    // Phase 9.14: secondary API key removed with secondary routing.
    currentConfig.llm.secondaryApiKey = undefined;
    if (updates.searchEngine) currentConfig.searchEngine = updates.searchEngine;
    if (updates.features) {
      currentConfig.features = { ...currentConfig.features, ...updates.features };
    }
    if ((updates as any).developerMode !== undefined) {
      currentConfig.developerMode = (updates as any).developerMode;
    }
    if (updates.privacy) {
      const prevAccess = currentConfig.privacy?.agentBrowsingDataAccess;
      currentConfig.privacy = { ...currentConfig.privacy, ...updates.privacy };
      const newAccess = currentConfig.privacy?.agentBrowsingDataAccess;

      // If access was just turned OFF, delete the generated profile
      if (prevAccess && !newAccess) {
        deleteProfile();
      }

      // If access was just turned ON, schedule a profile generation
      if (!prevAccess && newAccess) {
        const profileApiKey = decryptApiKey(currentConfig.llm.apiKey);
        const isCC = currentConfig.llm.provider === 'claude-code';
        if (profileApiKey || isCC) {
          scheduleProfileUpdate(getDb(), {
            provider: currentConfig.llm.provider,
            model: currentConfig.llm.model,
            apiKey: profileApiKey || '',
            thinking: false,
            region: currentConfig.llm.region,
            projectId: currentConfig.llm.projectId,
            location: currentConfig.llm.location,
            endpoint: currentConfig.llm.endpoint,
            baseUrl: currentConfig.llm.baseUrl,
          }, {
            history: currentConfig.privacy?.profileEnrichHistory !== false,
            bookmarks: currentConfig.privacy?.profileEnrichBookmarks !== false,
          }, isCC ? buildCliAuthConfig() : undefined);
        }
      }
    }
    // Workspace path (Phase 9.13)
    if (updates.workspacePath !== undefined) {
      currentConfig.workspacePath = updates.workspacePath || undefined;
    }
    // Enterprise Kerberos/SPNEGO settings (requires restart to take effect)
    if ((updates as any).enterprise) {
      currentConfig.enterprise = {
        ...currentConfig.enterprise,
        ...(updates as any).enterprise,
      };
    }
    saveConfig(currentConfig);
    console.log('[config] Saved:', currentConfig.llm.provider, currentConfig.llm.model);

    // Update cron manager with new config
    const cronApiKey = decryptApiKey(currentConfig.llm.apiKey);
    const isCC = currentConfig.llm.provider === 'claude-code';
    if (cronApiKey || isCC) {
      const cronBrowserCtx: BrowserContext = { window: mainWindow, tabManager, config: currentConfig };
      updateCronContext(cronBrowserCtx, {
        provider: currentConfig.llm.provider,
        model: currentConfig.llm.model,
        apiKey: cronApiKey || '',
        thinking: currentConfig.llm.thinking,
        region: currentConfig.llm.region,
        projectId: currentConfig.llm.projectId,
        location: currentConfig.llm.location,
        endpoint: currentConfig.llm.endpoint,
        baseUrl: currentConfig.llm.baseUrl,
      }, currentConfig.developerMode, isCC ? buildCliAuthConfig() : undefined);
    }

    return { success: true };
  }

  ipcMain.handle('config:save', (_e, updates: Partial<TappiConfig & { rawApiKey?: string; rawSecondaryApiKey?: string }>) => {
    const result = applyConfigUpdates(updates);
    // Invalidate workspace cache if workspace path changed
    if (updates.workspacePath !== undefined) {
      invalidateWorkspaceCache();
    }
    return result;
  });

  // ─── Profile Management IPC (Phase 8.4.4) ───

  ipcMain.handle('profile:list', () => {
    return profileManager.listProfiles();
  });

  ipcMain.handle('profile:create', (_e, name: string, email?: string) => {
    return profileManager.createProfile(name, email);
  });

  // Shared profile switch logic — used by both IPC and agent events
  async function performProfileSwitch(name: string): Promise<{ success: boolean; error?: string; profile?: any; profiles?: any[] }> {
    const result = profileManager.switchProfile(name);
    if ('error' in result) return { success: false, error: (result as any).error };

    // Close existing db, reopen with new profile's db path
    reinitDatabase(profileManager.getDatabasePath());

    // Reload config for new profile
    currentConfig = loadConfig();
    mainWindow.webContents.send('config:loaded', {
      ...currentConfig,
      llm: { ...currentConfig.llm, apiKey: currentConfig.llm.apiKey ? '••••••••' : '' },
    });

    // Attach download handler and ad blocker to the new profile's session
    const partition = profileManager.getSessionPartition();
    attachDownloadHandlerToPartition(partition);
    applyAdBlockerToPartition(partition);

    // Load persisted extensions for the new profile
    loadPersistedExtensionsForProfile(name).catch(e =>
      console.error('[main] Extension reload on profile switch error:', e)
    );

    // Close all non-Aria tabs (they use the old profile's session partition)
    // and open a fresh tab with the new partition
    const allTabIds = tabManager.getAllTabIds();
    for (const tabId of allTabIds) {
      if (tabId !== tabManager.ariaTabId) {
        tabManager.closeTab(tabId);
      }
    }
    const newTabId = tabManager.createTab();
    initTabMedia(newTabId);
    layoutViews();

    // Reload bookmarks for new profile's database
    tabManager.reloadBookmarks();

    // Notify UI of profile change (includes fresh bookmarks for the bar)
    const freshBookmarks = getAllBookmarks();
    mainWindow.webContents.send('profile:switched', { profile: result, profiles: profileManager.listProfiles() });
    mainWindow.webContents.send('bookmarks:updated', { url: '', added: false, bookmarks: freshBookmarks });

    // Clear in-memory agent history
    clearHistory('default');
    sessionManager.clearSiteIdentities();

    console.log(`[main] Switched to profile: ${name}`);
    return { success: true, profile: result, profiles: profileManager.listProfiles() };
  }

  ipcMain.handle('profile:switch', async (_e, name: string) => {
    return performProfileSwitch(name);
  });

  // Agent-triggered profile switch via agentEvents bus
  agentEvents.on('profile:switch-request', async (name: string, callback?: (result: any) => void) => {
    const result = await performProfileSwitch(name);
    if (callback) callback(result);
  });

  // Auto-reconcile scripts when their domain playbooks are updated
  agentEvents.on('playbook:updated', async ({ domain, playbook }: { domain: string; playbook: string }) => {
    const affected = getScriptsByDomain(domain);
    if (!affected.length) return;

    const apiKey = decryptApiKey(currentConfig.llm.apiKey);
    const isCC = currentConfig.llm.provider === 'claude-code';
    const llmConfig: any = {
      provider: currentConfig.llm.provider,
      model: currentConfig.llm.model,
      apiKey: apiKey || undefined,
      thinking: currentConfig.llm.thinking,
    };
    const cliAuth = isCC ? buildCliAuthConfig() : undefined;

    for (const script of affected) {
      try {
        await reconcileScriptWithPlaybook(script.id, domain, playbook, llmConfig, cliAuth);
      } catch (err: any) {
        console.error(`[main] Playbook reconciliation failed for script ${script.id}:`, err?.message);
      }
    }
  });

  ipcMain.handle('profile:delete', (_e, name: string) => {
    return profileManager.deleteProfile(name);
  });

  ipcMain.handle('profile:export', async (_e, profileName: string, password: string) => {
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Profile',
      defaultPath: `${profileName}-${new Date().toISOString().slice(0, 10)}.tappi-profile`,
      filters: [{ name: 'Tappi Profile', extensions: ['tappi-profile'] }],
    });
    if (!filePath) return { success: false, error: 'Cancelled' };
    return await profileManager.exportProfile(profileName, password, filePath);
  });

  ipcMain.handle('profile:import', async (_e, password: string) => {
    const { filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Profile',
      filters: [{ name: 'Tappi Profile', extensions: ['tappi-profile'] }],
      properties: ['openFile'],
    });
    if (!filePaths || filePaths.length === 0) return { success: false, error: 'Cancelled' };
    const result = await profileManager.importProfile(filePaths[0], password);
    if (result.success) {
      mainWindow.webContents.send('profile:updated', profileManager.listProfiles());
    }
    return result;
  });

  ipcMain.handle('profile:get-active', () => {
    return {
      name: profileManager.activeProfile,
      profiles: profileManager.listProfiles(),
    };
  });

  // ─── Profile Native Menu (renders above tab views, no z-order issues) ───
  ipcMain.on('profile:show-menu', () => {
    const profiles = profileManager.listProfiles();
    const active = profileManager.activeProfile;
    const template: Electron.MenuItemConstructorOptions[] = [];

    for (const p of profiles) {
      template.push({
        label: p.name,
        type: 'checkbox',
        checked: p.name === active,
        click: async () => {
          if (p.name === active) return;
          await performProfileSwitch(p.name);
        },
      });
    }

    template.push({ type: 'separator' });
    template.push({
      label: 'New Profile…',
      click: () => {
        mainWindow.webContents.send('settings:open');
        mainWindow.webContents.send('settings:switch-tab', 'profiles');
      },
    });
    template.push({
      label: 'Manage Profiles…',
      click: () => {
        mainWindow.webContents.send('settings:open');
        mainWindow.webContents.send('settings:switch-tab', 'profiles');
      },
    });

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: mainWindow });
  });

  // ─── Site Identity IPC (Phase 8.4.6) ───

  ipcMain.handle('profile:open-site-identity', (_e, domain: string, username: string) => {
    const partition = sessionManager.getSiteIdentityPartition(domain, username);
    sessionManager.registerSiteIdentity(domain, username);
    // Create a new tab with the site-specific session partition
    const url = `https://${domain}`;
    tabManager.createTab(url, partition);
    layoutViews();
    return { success: true, partition };
  });

  ipcMain.handle('profile:site-identities', (_e, domain: string) => {
    return sessionManager.getSiteIdentities(domain);
  });

  // ─── Credential Check & Test Connection IPC ───
  ipcMain.handle('credentials:check', async (_e, provider: string, options?: { ollamaUrl?: string }) => {
    return await checkCredentials(provider, options);
  });

  ipcMain.handle('credentials:test', async (_e, provider: string, config: any) => {
    // Decrypt API key if we're testing with the stored key
    if (!config.apiKey && currentConfig.llm.apiKey && currentConfig.llm.provider === provider) {
      config.apiKey = decryptApiKey(currentConfig.llm.apiKey);
    }
    return await testConnection(provider, config);
  });

  ipcMain.handle('provider:default-model', (_e, provider: string) => {
    return getDefaultModel(provider);
  });

  // ─── Directory Selection IPC ───
  ipcMain.handle('dialog:select-directory', async (_e, options: { title?: string; defaultPath?: string }) => {
    const { filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: options.title || 'Select Directory',
      defaultPath: options.defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!filePaths || filePaths.length === 0) return null;
    return { path: filePaths[0] };
  });

  // ─── File Selection IPC ───
  ipcMain.handle('dialog:select-file', async (_e, options: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options?.title || 'Select File',
      filters: options?.filters || [],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return { path: result.filePaths[0] };
  });

  // ─── Extensions IPC ───
  ipcMain.handle('extensions:list', () => listExtensions());
  ipcMain.handle('extensions:install', async (_e, data: { path: string; allowFileAccess?: boolean }) => {
    return installExtension(data.path, { allowFileAccess: data.allowFileAccess });
  });
  ipcMain.handle('extensions:get', (_e, id: string) => getExtension(id));
  ipcMain.handle('extensions:remove', (_e, id: string) => removeExtension(id));
  ipcMain.handle('extensions:enable', (_e, id: string) => enableExtension(id));
  ipcMain.handle('extensions:disable', (_e, id: string) => disableExtension(id));

  // ─── API Services IPC ───
  ipcMain.handle('api-services:list', () => {
    const services = loadServices();
    const keys: Record<string, boolean> = {};
    for (const name of Object.keys(services)) {
      keys[name] = !!getApiKey(name);
    }
    // Find orphan keys (keys without service config)
    const keyList = listApiKeys();
    const orphans: string[] = [];
    if (keyList && !keyList.startsWith('No API')) {
      const lines = keyList.split('\n').slice(1);
      for (const line of lines) {
        const match = line.match(/• (\S+)/);
        if (match && !services[match[1]]) {
          orphans.push(match[1]);
          keys[match[1]] = true;
        }
      }
    }
    return { services, keys, orphans };
  });

  ipcMain.handle('api-services:add', (_e, data: { name: string; baseUrl: string; authHeader: string; description: string; apiKey?: string }) => {
    if (!data.name) return { success: false, error: 'Name is required' };
    registerService(data.name, data.baseUrl || '', data.authHeader || 'Bearer', data.description || '');
    if (data.apiKey) storeApiKey(data.name, data.apiKey);
    mainWindow.webContents.send('api-services:updated', null);
    return { success: true };
  });

  ipcMain.handle('api-services:update', (_e, oldName: string, data: { name: string; baseUrl: string; authHeader: string; description: string; apiKey?: string }) => {
    if (oldName !== data.name) {
      removeService(oldName);
      deleteApiKey(oldName);
    }
    registerService(data.name, data.baseUrl || '', data.authHeader || 'Bearer', data.description || '');
    if (data.apiKey) storeApiKey(data.name, data.apiKey);
    mainWindow.webContents.send('api-services:updated', null);
    return { success: true };
  });

  ipcMain.handle('api-services:delete', (_e, name: string) => {
    removeService(name);
    deleteApiKey(name);
    mainWindow.webContents.send('api-services:updated', null);
    return { success: true };
  });

  ipcMain.handle('api-services:reveal-key', (_e, name: string) => {
    const key = getApiKey(name);
    if (!key) return { key: '' };
    return { key };
  });

  // ─── Domain Playbooks IPC ───
  ipcMain.handle('playbooks:list', () => listPlaybooks());

  ipcMain.handle('playbooks:get', (_e, domain: string) => getPlaybook(domain));

  ipcMain.handle('playbooks:update', (_e, domain: string, content: string) => {
    if (!domain || !content?.trim()) return { success: false, error: 'Domain and content required' };
    try {
      upsertPlaybook(domain, content);
      mainWindow.webContents.send('playbooks:updated');
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Failed to update playbook' };
    }
  });

  ipcMain.handle('playbooks:delete', (_e, domain: string) => {
    if (!domain) return { success: false, error: 'Domain required' };
    try {
      deletePlaybook(domain);
      mainWindow.webContents.send('playbooks:updated');
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Failed to delete playbook' };
    }
  });

  // ─── Developer Mode IPC ───
  ipcMain.handle('devmode:get', () => currentConfig.developerMode);

  ipcMain.handle('devmode:api-token', () => {
    if (!currentConfig.developerMode) return '';
    try { return require('fs').readFileSync(require('path').join(process.env.HOME || '.', '.tappi-browser', 'api-token'), 'utf-8').trim(); } catch { return ''; }
  });

  ipcMain.handle('devmode:set', (_e, enabled: boolean) => {
    currentConfig.developerMode = enabled;
    saveConfig(currentConfig);
    mainWindow.webContents.send('devmode:changed', enabled);
    // Fix 4: Also notify Aria tab so it can show/hide the </> coding mode button
    try { tabManager?.ariaWebContents?.send('devmode:changed', enabled); } catch {}
    // If dev mode turned off, deactivate coding mode (it requires dev mode)
    if (!enabled && currentConfig.llm.codingMode) {
      const codingActive = false;
      mainWindow.webContents.send('codingmode:changed', codingActive);
      try { tabManager?.ariaWebContents?.send('codingmode:changed', codingActive); } catch {}
    }
    // Start/stop API server based on developer mode
    if (enabled) {
      ensureApiToken();
      startApiServer(API_PORT, {
        mainWindow,
        tabManager,
        getConfig: () => currentConfig,
        decryptApiKey,
        updateConfig: applyConfigUpdates,
      });
    } else {
      stopApiServer();
    }
    console.log('[config] Developer mode:', enabled);
    return { success: true, developerMode: enabled };
  });

  // ─── Coding Mode IPC (Phase 8.38) ───
  ipcMain.handle('codingmode:get', () => ({
    enabled: currentConfig.developerMode && (currentConfig.llm.codingMode === true),
    devModeRequired: !currentConfig.developerMode,
  }));

  ipcMain.handle('codingmode:set', (_e, enabled: boolean) => {
    currentConfig.llm.codingMode = enabled;
    saveConfig(currentConfig);
    const active = currentConfig.developerMode && enabled;
    mainWindow.webContents.send('codingmode:changed', active);
    // Fix 4: Also notify Aria tab for its </> button state
    try { tabManager?.ariaWebContents?.send('codingmode:changed', active); } catch {}
    console.log('[config] Coding mode:', enabled, '(effective:', active, ')');
    return { success: true, codingMode: active };
  });

  // ─── Worktree Isolation IPC (Phase 8.39) ───
  ipcMain.handle('worktree-isolation:get', () => ({
    enabled: currentConfig.developerMode && (currentConfig.llm.codingMode === true) && (currentConfig.llm.worktreeIsolation !== false),
    codingModeRequired: !currentConfig.llm.codingMode,
    devModeRequired: !currentConfig.developerMode,
  }));

  ipcMain.handle('worktree-isolation:set', (_e, enabled: boolean) => {
    currentConfig.llm.worktreeIsolation = enabled;
    saveConfig(currentConfig);
    const active = currentConfig.developerMode && (currentConfig.llm.codingMode === true) && enabled;
    mainWindow.webContents.send('worktree-isolation:changed', active);
    try { tabManager?.ariaWebContents?.send('worktree-isolation:changed', active); } catch {}
    console.log('[config] Worktree isolation:', enabled, '(effective:', active, ')');
    return { success: true, worktreeIsolation: enabled };
  });

  // ─── Team IPC (Phase 8.38) ───
  ipcMain.handle('team:status', () => getTeamStatusUI());

  // Setup team update callback to push UI updates
  setTeamUpdateCallback((_teamId, _team) => {
    const teamStatus = getTeamStatusUI();
    try { mainWindow?.webContents.send('team:updated', teamStatus); } catch {}
    // Fix 4: Also notify Aria tab's team status card
    try { tabManager?.ariaWebContents?.send('team:updated', teamStatus); } catch {}
  });

  // ─── Phase 9.096d: Unified Interrupt IPC ────────────────────────────────
  // Routes interrupt/redirect requests from the renderer to the correct backend handler.
  // target: 'main' = main agent session, 'teammate' = team member
  ipcMain.handle('agent:interrupt', async (_event, { target, targetName, message }: { target: string; targetName?: string; message: string }) => {
    try {
      switch (target) {
        case 'main':
          return await interruptMainSession(message);
        case 'teammate': {
          const teamId = getActiveTeamId();
          if (!teamId) return '❌ No active team';
          return sendMailboxMessage(teamId, '@lead', targetName || '', message, { type: 'shutdown_request' });
        }
        default:
          return `❌ Unknown interrupt target: ${target}`;
      }
    } catch (err: any) {
      console.error('[main] agent:interrupt error:', err?.message);
      return `❌ Interrupt failed: ${err?.message}`;
    }
  });

  // Forward new team live events to both windows (team-manager sends directly to ariaWC,
  // but we also forward from here in case mainWindow needs them)
  // Note: team:teammate-pulse, team:teammate-reasoning, team:teammate-interrupt are sent
  // directly from team-manager to ariaWebContents — this forwarding handles mainWindow
  const _teamLiveEvents = ['team:teammate-pulse', 'team:teammate-reasoning', 'team:teammate-interrupt'];
  // (These events flow from team-manager → ariaWebContents directly; no main.ts forwarding needed)

  // Phase 9.09: Register project update callback so agent tools can push sidebar refreshes
  setProjectUpdateCallback(() => {
    try { tabManager?.ariaWebContents?.send('projects:updated'); } catch {}
  });

  // ─── CLI Tools IPC ───
  ipcMain.handle('tools:list', () => {
    return loadTools();
  });

  ipcMain.handle('tools:verify', () => {
    return verifyAllTools();
  });

  // ─── Cron Jobs IPC ───
  ipcMain.handle('cron:list', () => getJobsList());

  ipcMain.handle('cron:add', (_e, data: { name: string; task: string; schedule: any }) => {
    return cronAddJob(data.name, data.task, data.schedule);
  });

  ipcMain.handle('cron:update', (_e, id: string, updates: any) => {
    return cronUpdateJob(id, updates);
  });

  ipcMain.handle('cron:delete', (_e, id: string) => {
    return cronDeleteJob(id);
  });

  ipcMain.handle('cron:run-now', (_e, id: string) => {
    return cronRunJobNow(id);
  });

  ipcMain.handle('cron:active-count', () => getActiveJobCount());

  // ─── Dark Mode IPC (direct toggle) ───
  ipcMain.on('darkmode:toggle', async (_e, enable: boolean) => {
    // Save dark mode preference to config
    currentConfig.features.darkMode = enable;
    saveConfig(currentConfig);

    // Notify Aria tab about theme change
    const ariaWc = tabManager?.ariaWebContents;
    if (ariaWc) {
      ariaWc.send('theme:changed', enable);
    }

    // Apply dark mode CSS to the active web page content
    const wc = tabManager?.activeWebContents;
    if (!wc) return;
    const { bDarkMode } = require('./browser-tools');
    await bDarkMode({ window: mainWindow, tabManager, config: currentConfig }, [enable ? 'on' : 'off']);
  });

  ipcMain.handle('theme:get', () => {
    return currentConfig.features.darkMode || false;
  });

  // ─── History IPC ───
  ipcMain.handle('history:search', (_e, query: string, limit?: number) => {
    return searchHistory(query, limit || 10);
  });

  ipcMain.handle('history:recent', (_e, limit?: number) => {
    return getRecentHistory(limit || 20);
  });

  ipcMain.handle('history:clear', (_e, range?: string) => {
    return clearDbHistory(range as any);
  });

  // ─── Search Suggestions IPC ───
  ipcMain.handle('suggest:search', async (_e, query: string) => {
    if (!query || query.length < 2) return [];
    try {
      const resp = await fetch(
        `https://suggestqueries.google.com/complete/search?client=chrome&q=${encodeURIComponent(query)}`
      );
      if (!resp.ok) return [];
      const data: any = await resp.json();
      return Array.isArray(data[1]) ? data[1].slice(0, 8) : [];
    } catch {
      return [];
    }
  });

  // ─── Ad Blocker IPC ───
  ipcMain.handle('adblock:toggle', async (_e, enable: boolean) => {
    toggleAdBlocker(enable);
    currentConfig.features.adBlocker = enable;
    saveConfig(currentConfig);
    return { enabled: enable };
  });

  ipcMain.handle('adblock:count', () => getBlockedCount());

  ipcMain.handle('adblock:site-exception', (_e, domain: string, add: boolean) => {
    if (add) addSiteException(domain);
    else removeSiteException(domain);
    return { success: true };
  });

  // Periodically send ad block count to UI
  setInterval(() => {
    if (isAdBlockerEnabled() && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('adblock:count', getBlockedCount());
    }
  }, 3000);

  // ─── Download IPC ───
  ipcMain.handle('downloads:list', () => {
    return getAllDownloads().map(d => ({
      id: d.id,
      filename: d.filename,
      totalBytes: d.totalBytes,
      receivedBytes: d.receivedBytes,
      state: d.state,
      savePath: d.savePath,
      startTime: d.startTime,
    }));
  });

  ipcMain.handle('downloads:cancel', (_e, id: string) => cancelDownload(id));
  ipcMain.handle('downloads:clear', () => { clearCompleted(); return { success: true }; });

  // ─── Bookmarks (panel) IPC ───
  ipcMain.handle('bookmarks:all', () => {
    return getAllBookmarks();
  });

  ipcMain.handle('bookmarks:search', (_e, query: string) => {
    return searchBookmarks(query);
  });

  ipcMain.handle('bookmarks:remove', (_e, url: string) => {
    removeBookmark(url);
    return { success: true };
  });

  // ─── Extra Chrome Height (find bar, autocomplete push tab view down) ───
  const FIND_BAR_HEIGHT = 40;
  let findBarOpen = false;
  let autocompleteHeight = 0;

  function getExtraChromeHeight(): number {
    return (findBarOpen ? FIND_BAR_HEIGHT : 0) + autocompleteHeight;
  }

  function relayoutWithExtraChrome() {
    if (!mainWindow || !tabManager) return;
    const [width, height] = mainWindow.getContentSize();
    const agentWidth = getAgentWidth();
    tabManager.layoutActiveTab(width - agentWidth, height, STATUS_BAR_HEIGHT, getExtraChromeHeight());
  }

  // ─── Find on Page IPC ───
  ipcMain.on('findbar:toggle', (_e, open: boolean) => {
    findBarOpen = open;
    relayoutWithExtraChrome();
  });

  // ─── Autocomplete overlay (push tab down instead of blanking page) ───
  ipcMain.on('autocomplete:resize', (_e, height: number) => {
    autocompleteHeight = Math.max(0, Math.min(height, 360)); // cap at 360px
    relayoutWithExtraChrome();
  });

  let lastFindText = '';
  ipcMain.on('find:start', (_e, text: string, options?: { forward?: boolean }) => {
    const wc = tabManager?.activeWebContents;
    if (!wc || !text) return;
    lastFindText = text;
    wc.findInPage(text, { forward: options?.forward !== false });
  });

  ipcMain.on('find:next', (_e, forward?: boolean) => {
    const wc = tabManager?.activeWebContents;
    if (!wc || !lastFindText) return;
    wc.findInPage(lastFindText, { forward: forward !== false, findNext: true });
  });

  ipcMain.on('find:stop', () => {
    const wc = tabManager?.activeWebContents;
    if (!wc) return;
    wc.stopFindInPage('clearSelection');
  });

  // ─── Print IPC ───
  ipcMain.on('page:print', () => {
    const wc = tabManager?.activeWebContents;
    if (!wc) return;
    wc.print();
  });

  // ─── Zoom IPC ───
  ipcMain.on('zoom:in', () => {
    const wc = tabManager?.activeWebContents;
    if (!wc) return;
    const current = wc.getZoomLevel();
    wc.setZoomLevel(Math.min(current + 0.5, 5));
    mainWindow?.webContents.send('zoom:changed', wc.getZoomFactor());
  });

  ipcMain.on('zoom:out', () => {
    const wc = tabManager?.activeWebContents;
    if (!wc) return;
    const current = wc.getZoomLevel();
    wc.setZoomLevel(Math.max(current - 0.5, -5));
    mainWindow?.webContents.send('zoom:changed', wc.getZoomFactor());
  });

  ipcMain.on('zoom:reset', () => {
    const wc = tabManager?.activeWebContents;
    if (!wc) return;
    wc.setZoomLevel(0);
    mainWindow?.webContents.send('zoom:changed', 1);
  });

  ipcMain.handle('zoom:get', () => {
    const wc = tabManager?.activeWebContents;
    if (!wc) return 1;
    return wc.getZoomFactor();
  });

  // ─── Navigate or create tab from panels ───
  ipcMain.on('tab:navigate-or-create', (_e, url: string) => {
    if (!tabManager) return;
    const wc = tabManager.activeWebContents;
    if (wc) {
      wc.loadURL(url.startsWith('http') ? url : `https://${url}`);
    } else {
      tabManager.createTab(url);
    }
  });

  // ─── Password Vault IPC ───
  ipcMain.handle('vault:list-domains', () => listSavedDomains());

  ipcMain.handle('vault:get-for-domain', (_e, domain: string) => {
    return getPasswordsForDomain(domain);
  });

  ipcMain.handle('vault:save', (_e, domain: string, username: string, password: string) => {
    storePassword(domain, username, password);
    return { success: true };
  });

  ipcMain.handle('vault:delete', (_e, id: number) => {
    removePassword(id);
    return { success: true };
  });

  ipcMain.handle('vault:generate', (_e, length?: number) => {
    return { password: generatePassword(length || 20) };
  });

  ipcMain.handle('vault:autofill', async (_e, domain: string, username?: string) => {
    const wc = tabManager?.activeWebContents;
    if (!wc) return { success: false, error: 'No active tab' };

    const cred = getPasswordForAutofill(domain, username || '');
    if (!cred) return { success: false, error: 'No credentials found' };

    const script = buildAutofillScript(cred.username, cred.password);
    const result = await wc.executeJavaScript(script);
    return { success: true, result };
  });

  // Handle credential save prompts from content preload
  // Password is stored temporarily in main process memory (never sent to UI renderer)
  let pendingCredentialSave: { domain: string; username: string; password: string; timestamp: number } | null = null;

  ipcMain.on('vault:credential-detected', (_e, data: { domain: string; username: string; password: string }) => {
    // Store credential temporarily in main process memory
    pendingCredentialSave = {
      domain: data.domain,
      username: data.username,
      password: data.password,
      timestamp: Date.now(),
    };
    // Show save prompt in UI (password NOT sent to renderer)
    mainWindow?.webContents.send('vault:save-prompt', { domain: data.domain, username: data.username });
  });

  // User confirmed saving the credential
  ipcMain.handle('vault:confirm-save', () => {
    if (!pendingCredentialSave) return { success: false, error: 'No pending credential' };
    // Expire after 60 seconds
    if (Date.now() - pendingCredentialSave.timestamp > 60000) {
      pendingCredentialSave = null;
      return { success: false, error: 'Credential save expired' };
    }
    try {
      storePassword(pendingCredentialSave.domain, pendingCredentialSave.username, pendingCredentialSave.password);
      const saved = { domain: pendingCredentialSave.domain, username: pendingCredentialSave.username };
      pendingCredentialSave = null;
      console.log(`[vault] Saved credentials for ${saved.domain} (${saved.username})`);
      return { success: true, ...saved };
    } catch (e: any) {
      pendingCredentialSave = null;
      return { success: false, error: e?.message || 'Failed to store password' };
    }
  });

  // User dismissed the save prompt
  ipcMain.handle('vault:dismiss-save', () => {
    pendingCredentialSave = null;
    return { success: true };
  });

  // ─── Login Detection IPC (Phase 8.4.3) ───
  // content-preload sends this when it detects a password field on a page.
  // Main process looks up the vault and stores a hint for the next agent context assembly.
  ipcMain.on('page:login-detected', (event, data: { domain: string }) => {
    const { domain } = data;
    const wcId = event.sender.id;

    const usernames = listIdentities(domain);
    let hint: string;
    if (usernames.length === 0) {
      hint = `[🔑 Login page detected. No stored credential for ${domain}.]`;
    } else if (usernames.length === 1) {
      hint = `[🔑 Login page detected. Matching credential found for ${domain}.]`;
    } else {
      hint = `[🔑 Login page detected. ${usernames.length} credentials stored for ${domain}: ${usernames.join(', ')}.]`;
    }

    setLoginHint(wcId, domain, hint);
    console.log(`[vault] Login detected — ${domain} (wcId=${wcId}): ${usernames.length} credential(s)`);
  });

  // ─── Permission IPC ───
  ipcMain.handle('permission:get', (_e, domain: string, perm: string) => {
    return getPermission(domain, perm);
  });

  ipcMain.handle('permission:set', (_e, domain: string, perm: string, allowed: boolean) => {
    setPermission(domain, perm, allowed);
    return { success: true };
  });

  // ─── User Profile (Phase 9.096c) ───
  ipcMain.handle('user-profile:load', () => {
    return loadUserProfileTxt();
  });

  ipcMain.handle('user-profile:save', (_e, text: string) => {
    const result = saveUserProfileTxt(text);
    return result;
  });

  ipcMain.handle('user-profile:enrichment-status', () => {
    const autoProfile = loadProfile();
    return {
      lastEnriched: autoProfile?.updated_at || null,
      enrichHistory: currentConfig.privacy?.profileEnrichHistory !== false,
      enrichBookmarks: currentConfig.privacy?.profileEnrichBookmarks !== false,
    };
  });

  ipcMain.handle('user-profile:refresh-enrichment', async () => {
    if (!currentConfig.privacy?.agentBrowsingDataAccess) {
      return { error: 'Browsing data access is disabled.' };
    }
    const apiKey = decryptApiKey(currentConfig.llm.apiKey);
    const isCC = currentConfig.llm.provider === 'claude-code';
    if (!apiKey && !isCC) return { error: 'No API key configured.' };
    try {
      const result = await generateProfile(getDb(), {
        provider: currentConfig.llm.provider,
        model: currentConfig.llm.model,
        apiKey: apiKey || '',
        thinking: false,
        region: currentConfig.llm.region,
        projectId: currentConfig.llm.projectId,
        location: currentConfig.llm.location,
        endpoint: currentConfig.llm.endpoint,
        baseUrl: currentConfig.llm.baseUrl,
      }, {
        history: currentConfig.privacy?.profileEnrichHistory !== false,
        bookmarks: currentConfig.privacy?.profileEnrichBookmarks !== false,
      });
      return { success: !!result, lastEnriched: result?.updated_at || null };
    } catch (e: any) {
      return { error: e?.message || 'Generation failed' };
    }
  });

  // ─── Deep Mode Report Save (legacy — handler kept for backward compat) ───
  const _deepSaveReportHandler = async (_e: Electron.IpcMainInvokeEvent, outputDirAbsolute: string, format: string = 'md') => {
    const fsSync = require('fs') as typeof import('fs');
    const pathMod = require('path') as typeof import('path');
    const os = require('os') as typeof import('os');
    const { execSync } = require('child_process') as typeof import('child_process');

    // Find the final report markdown file in the output directory
    let reportPath = '';
    if (fsSync.existsSync(outputDirAbsolute)) {
      const files = fsSync.readdirSync(outputDirAbsolute).filter((f: string) => f.endsWith('.md')).sort();
      const finalReport = files.find((f: string) => f.includes('final_report') || f.includes('final'));
      reportPath = pathMod.join(outputDirAbsolute, finalReport || files[files.length - 1] || '');
    }

    if (!reportPath || !fsSync.existsSync(reportPath)) {
      return { success: false, error: 'Report file not found' };
    }

    const mdContent = fsSync.readFileSync(reportPath, 'utf-8');
    const baseName = pathMod.basename(reportPath, '.md');

    // Determine output format details
    const fmt = (format || 'md').toLowerCase();
    let outExt = fmt;
    let outContent: string | Buffer = mdContent;
    let filterName = 'Markdown';
    let filterExts = ['md'];

    if (fmt === 'html') {
      filterName = 'HTML';
      filterExts = ['html'];
      // Use marked (available in main process via require)
      try {
        const { marked } = require('marked') as typeof import('marked');
        const htmlBody = (marked as any).parse(mdContent);
        outContent = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${baseName}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 900px; margin: 40px auto; padding: 0 24px; line-height: 1.6; color: #1a1a2e; background: #fff; }
  h1, h2, h3, h4 { color: #0f3460; margin-top: 1.5em; }
  h1 { font-size: 2em; border-bottom: 2px solid #e94560; padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #ddd; padding-bottom: 0.2em; }
  pre { background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 6px; padding: 16px; overflow-x: auto; font-size: 0.9em; }
  code { background: #f0f0f0; padding: 2px 5px; border-radius: 3px; font-size: 0.9em; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 4px solid #e94560; margin: 0; padding: 0 16px; color: #555; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
  th { background: #f0f0f0; font-weight: 600; }
  a { color: #0f3460; }
  img { max-width: 100%; }
</style>
</head>
<body>
${htmlBody}
</body>
</html>`;
      } catch (e) {
        // If marked fails, produce basic wrapped content
        const escaped = mdContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        outContent = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${baseName}</title></head><body><pre>${escaped}</pre></body></html>`;
      }
    } else if (fmt === 'pdf') {
      filterName = 'PDF';
      filterExts = ['pdf'];
      outExt = 'pdf';
      // We'll write the HTML to a temp file and use weasyprint or Electron printToPDF
      // This will be handled AFTER the save dialog (we need the output path first).
      outContent = mdContent; // placeholder; PDF generation happens below
    } else if (fmt === 'txt') {
      filterName = 'Text';
      filterExts = ['txt'];
      // Strip markdown formatting
      let txt = mdContent;
      txt = txt.replace(/^#{1,6}\s+/gm, '');           // headings
      txt = txt.replace(/\*\*(.+?)\*\*/g, '$1');         // bold
      txt = txt.replace(/\*(.+?)\*/g, '$1');             // italic
      txt = txt.replace(/__(.+?)__/g, '$1');             // bold alt
      txt = txt.replace(/_(.+?)_/g, '$1');               // italic alt
      txt = txt.replace(/~~(.+?)~~/g, '$1');             // strikethrough
      txt = txt.replace(/`{3}[\s\S]*?`{3}/g, (m) => {   // code fences
        const lines = m.split('\n');
        return lines.slice(1, -1).join('\n');
      });
      txt = txt.replace(/`(.+?)`/g, '$1');               // inline code
      txt = txt.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // links [text](url) → text
      txt = txt.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1'); // images
      txt = txt.replace(/^[-*+]\s+/gm, '• ');            // unordered lists
      txt = txt.replace(/^\d+\.\s+/gm, '');              // ordered lists
      txt = txt.replace(/^>\s+/gm, '');                  // blockquotes
      txt = txt.replace(/^-{3,}$/gm, '─'.repeat(40));   // horizontal rules
      txt = txt.replace(/\|/g, ' | ');                   // table pipes → spaced
      outContent = txt;
    }

    // Determine default output filename
    const defaultName = `${baseName}.${outExt}`;

    const saveResult = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Research Report',
      defaultPath: pathMod.join(os.homedir(), 'Downloads', defaultName),
      filters: [
        { name: filterName, extensions: filterExts },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return { success: false, error: 'Cancelled' };
    }

    const outPath = saveResult.filePath;

    if (fmt === 'pdf') {
      // Try weasyprint first, fall back to Electron printToPDF
      try {
        // Build HTML for PDF
        let htmlForPdf = '';
        try {
          const { marked } = require('marked') as typeof import('marked');
          const htmlBody = (marked as any).parse(mdContent);
          htmlForPdf = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${baseName}</title><style>body{font-family:sans-serif;max-width:900px;margin:40px auto;line-height:1.6;}h1,h2,h3{color:#333;}pre{background:#f6f8fa;padding:16px;border-radius:6px;}code{background:#f0f0f0;padding:2px 5px;}table{border-collapse:collapse;}th,td{border:1px solid #ddd;padding:8px;}th{background:#eee;}</style></head><body>${htmlBody}</body></html>`;
        } catch {
          htmlForPdf = `<!DOCTYPE html><html><body><pre>${mdContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></body></html>`;
        }

        // Check if weasyprint is available
        let weasyprintAvailable = false;
        try {
          execSync('which weasyprint', { stdio: 'ignore' });
          weasyprintAvailable = true;
        } catch { /* not available */ }

        if (weasyprintAvailable) {
          // Write HTML to temp file and convert
          const tmpHtml = pathMod.join(os.tmpdir(), `tappi-report-${Date.now()}.html`);
          fsSync.writeFileSync(tmpHtml, htmlForPdf, 'utf-8');
          execSync(`weasyprint "${tmpHtml}" "${outPath}"`, { timeout: 30000 });
          try { fsSync.unlinkSync(tmpHtml); } catch { /* ignore */ }
        } else {
          // Use Electron's printToPDF via hidden BrowserWindow
          const { BrowserWindow: BW } = require('electron');
          const pdfWin = new BW({ show: false, webPreferences: { sandbox: false } });
          await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlForPdf));
          const pdfData = await pdfWin.webContents.printToPDF({
            printBackground: true,
            pageSize: 'A4',
            marginsType: 1,
          });
          pdfWin.destroy();
          fsSync.writeFileSync(outPath, pdfData);
        }
      } catch (e: any) {
        return { success: false, error: 'PDF generation failed: ' + (e.message || e) };
      }
    } else {
      // Write text/html/md content
      fsSync.writeFileSync(outPath, outContent as string, 'utf-8');
    }

    return { success: true, path: outPath };
  };

  ipcMain.handle('deep:save-report', _deepSaveReportHandler);

  // ─── File Download (Phase 9.07 Track 5) — general-purpose file → save dialog ───
  ipcMain.handle('file:download', async (_e, sourcePath: string, format: string, defaultName?: string) => {
    const fsSync = require('fs') as typeof import('fs');
    const pathMod = require('path') as typeof import('path');
    const os = require('os') as typeof import('os');
    const { execSync } = require('child_process') as typeof import('child_process');

    if (!sourcePath || !fsSync.existsSync(sourcePath)) {
      return { success: false, error: 'File not found: ' + sourcePath };
    }

    const baseName = defaultName || pathMod.basename(sourcePath);
    const baseNoExt = baseName.replace(/\.[^.]+$/, '');
    const sourceExt = pathMod.extname(sourcePath).toLowerCase();
    const fmt = (format || sourceExt.slice(1) || 'bin').toLowerCase();

    // Determine dialog filter + default name
    const filterMap: Record<string, { name: string; exts: string[] }> = {
      md:   { name: 'Markdown', exts: ['md'] },
      html: { name: 'HTML', exts: ['html'] },
      pdf:  { name: 'PDF', exts: ['pdf'] },
      txt:  { name: 'Text', exts: ['txt'] },
      csv:  { name: 'CSV', exts: ['csv'] },
      json: { name: 'JSON', exts: ['json'] },
    };
    const fmtInfo = filterMap[fmt] || { name: 'File', exts: [fmt] };
    const saveDefaultName = baseNoExt + '.' + (fmtInfo.exts[0] || fmt);

    const saveResult = await dialog.showSaveDialog(mainWindow, {
      title: 'Save File',
      defaultPath: pathMod.join(os.homedir(), 'Downloads', saveDefaultName),
      filters: [
        { name: fmtInfo.name, extensions: fmtInfo.exts },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return { success: false, error: 'Cancelled' };
    }

    const outPath = saveResult.filePath;

    const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    function buildHtmlDoc(title: string, body: string): string {
      return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Georgia, serif; max-width: 820px; margin: 48px auto; padding: 0 24px; line-height: 1.75; color: #1a1a2e; background: #fff; font-size: 16px; }
  h1, h2, h3, h4, h5, h6 { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #0f3460; margin: 1.5em 0 0.5em; }
  h1 { font-size: 2em; border-bottom: 2px solid #e94560; padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #e0e0e0; padding-bottom: 0.2em; }
  p { margin: 0.9em 0; }
  pre { background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 6px; padding: 16px; overflow-x: auto; font-size: 0.88em; line-height: 1.45; }
  code { background: #f0f2f4; padding: 2px 5px; border-radius: 3px; font-size: 0.88em; font-family: 'Courier New', Consolas, monospace; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 4px solid #e94560; margin: 1em 0; padding: 0.5em 1em; color: #555; background: #fafafa; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
  th { background: #f5f5f5; font-weight: 600; }
  tr:nth-child(even) { background: #fafafa; }
  a { color: #0f3460; }
  img { max-width: 100%; }
  hr { border: none; border-top: 1px solid #e0e0e0; margin: 2em 0; }
  ul, ol { margin: 0.8em 0; padding-left: 2em; }
  li { margin: 0.3em 0; }
</style>
</head>
<body>
${body}
</body>
</html>`;
    }

    function stripMarkdownToText(md: string): string {
      return md
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/__(.+?)__/g, '$1')
        .replace(/_(.+?)_/g, '$1')
        .replace(/~~(.+?)~~/g, '$1')
        .replace(/`{3}[\s\S]*?`{3}/gm, (m) => m.split('\n').slice(1, -1).join('\n'))
        .replace(/`(.+?)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
        .replace(/^[-*+]\s+/gm, '• ')
        .replace(/^\d+\.\s+/gm, '')
        .replace(/^>\s*/gm, '')
        .replace(/^-{3,}$/gm, '─'.repeat(40))
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    try {
      const sourceContent = fsSync.readFileSync(sourcePath, 'utf-8');

      if (fmt === 'html') {
        let htmlBody = '';
        if (sourceExt === '.md') {
          try {
            const { marked } = require('marked') as typeof import('marked');
            htmlBody = (marked as any).parse(sourceContent) as string;
          } catch {
            htmlBody = '<pre>' + escHtml(sourceContent) + '</pre>';
          }
        } else {
          htmlBody = '<pre>' + escHtml(sourceContent) + '</pre>';
        }
        fsSync.writeFileSync(outPath, buildHtmlDoc(baseNoExt, htmlBody), 'utf-8');

      } else if (fmt === 'pdf') {
        let htmlForPdf = '';
        try {
          const { marked } = require('marked') as typeof import('marked');
          const htmlBody = sourceExt === '.md'
            ? ((marked as any).parse(sourceContent) as string)
            : '<pre>' + escHtml(sourceContent) + '</pre>';
          htmlForPdf = buildHtmlDoc(baseNoExt, htmlBody);
        } catch {
          htmlForPdf = buildHtmlDoc(baseNoExt, '<pre>' + escHtml(sourceContent) + '</pre>');
        }

        let weasyprintAvailable = false;
        try { execSync('which weasyprint', { stdio: 'ignore' }); weasyprintAvailable = true; } catch {}

        if (weasyprintAvailable) {
          const tmpHtml = pathMod.join(os.tmpdir(), `tappi-dl-${Date.now()}.html`);
          fsSync.writeFileSync(tmpHtml, htmlForPdf, 'utf-8');
          try {
            execSync(`weasyprint "${tmpHtml}" "${outPath}"`, { timeout: 30000 });
          } finally {
            try { fsSync.unlinkSync(tmpHtml); } catch {}
          }
        } else {
          const { BrowserWindow: BW } = require('electron');
          const pdfWin = new BW({ show: false, webPreferences: { sandbox: false } });
          await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlForPdf));
          const pdfData = await pdfWin.webContents.printToPDF({ printBackground: true, pageSize: 'A4', marginsType: 1 });
          pdfWin.destroy();
          fsSync.writeFileSync(outPath, pdfData);
        }

      } else if (fmt === 'txt') {
        const txt = sourceExt === '.md' ? stripMarkdownToText(sourceContent) : sourceContent;
        fsSync.writeFileSync(outPath, txt, 'utf-8');

      } else {
        // md, csv, json, original extension — copy as-is
        fsSync.copyFileSync(sourcePath, outPath);
      }

      return { success: true, path: outPath };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  // ─── Context menu IPC ───
  // ─── Overflow menu (native popup) ───
  ipcMain.on('overflow:popup', () => {
    if (!mainWindow || !tabManager) return;
    const wc = tabManager.activeWebContents;
    const zoomFactor = wc ? wc.getZoomFactor() : 1;
    const zoomPercent = Math.round(zoomFactor * 100);

    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: 'History',
        accelerator: 'CmdOrCtrl+Y',
        click: () => mainWindow.webContents.send('panel:open', 'history'),
      },
      {
        label: 'Bookmarks',
        accelerator: 'CmdOrCtrl+Shift+B',
        click: () => mainWindow.webContents.send('panel:open', 'bookmarks'),
      },
      {
        label: 'Downloads',
        accelerator: 'CmdOrCtrl+Shift+D',
        click: () => mainWindow.webContents.send('panel:open', 'downloads'),
      },
      { type: 'separator' },
      {
        label: 'Find on Page',
        accelerator: 'CmdOrCtrl+F',
        click: () => mainWindow.webContents.send('find:open'),
      },
      {
        label: `Zoom (${zoomPercent}%)`,
        submenu: [
          {
            label: 'Zoom In',
            accelerator: 'CmdOrCtrl+Plus',
            click: () => {
              if (!wc) return;
              wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 5));
              mainWindow.webContents.send('zoom:changed', wc.getZoomFactor());
            },
          },
          {
            label: 'Zoom Out',
            accelerator: 'CmdOrCtrl+-',
            click: () => {
              if (!wc) return;
              wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -5));
              mainWindow.webContents.send('zoom:changed', wc.getZoomFactor());
            },
          },
          {
            label: 'Reset Zoom',
            accelerator: 'CmdOrCtrl+0',
            click: () => {
              if (!wc) return;
              wc.setZoomLevel(0);
              mainWindow.webContents.send('zoom:changed', 1);
            },
          },
        ],
      },
      { type: 'separator' },
      {
        label: 'Print',
        accelerator: 'CmdOrCtrl+P',
        click: () => wc?.print(),
      },
      { type: 'separator' },
      {
        label: 'Settings',
        accelerator: 'CmdOrCtrl+,',
        click: () => mainWindow.webContents.send('settings:open'),
      },
    ];

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: mainWindow });
  });

  // ─── Page right-click context menu ───
  function setupPageContextMenu(wc: Electron.WebContents) {
    // Clear stale login hint when the tab navigates away (Phase 8.4.3)
    wc.on('did-navigate', () => {
      clearLoginHint(wc.id);
      // Phase 8.5: notify media engine of navigation (kills mpv session)
      const tabId = tabManager.getTabIdByWebContentsId(wc.id);
      if (tabId) onTabNavigated(tabId);
    });
    wc.on('did-navigate-in-page', () => clearLoginHint(wc.id));

    wc.on('context-menu', (_e, params) => {
      const template: Electron.MenuItemConstructorOptions[] = [];

      // Navigation
      template.push(
        { label: 'Back', enabled: wc.canGoBack(), click: () => wc.goBack() },
        { label: 'Forward', enabled: wc.canGoForward(), click: () => wc.goForward() },
        { label: 'Reload', click: () => wc.reload() },
        { type: 'separator' },
      );

      // Link-specific
      if (params.linkURL) {
        template.push(
          {
            label: 'Open Link in New Tab',
            click: () => tabManager?.createTab(params.linkURL),
          },
          {
            label: 'Copy Link Address',
            click: () => {
              const { clipboard } = require('electron');
              clipboard.writeText(params.linkURL);
            },
          },
          { type: 'separator' },
        );
      }

      // Image-specific
      if (params.hasImageContents && params.srcURL) {
        template.push(
          {
            label: 'Open Image in New Tab',
            click: () => tabManager?.createTab(params.srcURL),
          },
          {
            label: 'Copy Image Address',
            click: () => {
              const { clipboard } = require('electron');
              clipboard.writeText(params.srcURL);
            },
          },
          { type: 'separator' },
        );
      }

      // Text selection
      if (params.selectionText) {
        template.push(
          { label: 'Copy', role: 'copy' },
          { type: 'separator' },
          {
            label: `Search Google for "${params.selectionText.slice(0, 30)}${params.selectionText.length > 30 ? '…' : ''}"`,
            click: () => {
              tabManager?.createTab(`https://www.google.com/search?q=${encodeURIComponent(params.selectionText)}`);
            },
          },
          { type: 'separator' },
        );
      }

      // Editable field (input, textarea, contenteditable)
      if (params.isEditable) {
        template.push(
          { label: 'Undo', role: 'undo' },
          { label: 'Redo', role: 'redo' },
          { type: 'separator' },
          { label: 'Cut', role: 'cut' },
          { label: 'Copy', role: 'copy' },
          { label: 'Paste', role: 'paste' },
          { label: 'Select All', role: 'selectAll' },
          { type: 'separator' },
        );
      }

      // Always available
      if (!params.isEditable && !params.selectionText) {
        template.push(
          { label: 'Select All', role: 'selectAll' },
          { type: 'separator' },
        );
      }

      template.push(
        {
          label: 'View Page Source',
          click: () => {
            const url = wc.getURL();
            tabManager?.createTab(`view-source:${url}`);
          },
        },
        { label: 'Inspect Element', click: () => wc.inspectElement(params.x, params.y) },
      );

      const menu = Menu.buildFromTemplate(template);
      menu.popup({ window: mainWindow! });
    });
  }

  ipcMain.on('tab:context-menu', (_e, id: string) => {
    const info = tabManager.getTabInfo(id);
    if (!info) return;

    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: info.isPinned ? 'Unpin Tab' : 'Pin Tab',
        click: () => tabManager.pinTab(id),
      },
      {
        label: info.isMuted ? 'Unmute Tab' : 'Mute Tab',
        click: () => tabManager.muteTab(id),
      },
      { type: 'separator' },
      {
        label: 'Duplicate Tab',
        click: () => tabManager.duplicateTab(id),
      },
      { type: 'separator' },
      {
        label: 'Close Tab',
        click: () => {
          tabManager.closeTab(id);
          if (tabManager.tabCount === 0) mainWindow.close();
        },
      },
      {
        label: 'Close Other Tabs',
        click: () => tabManager.closeOtherTabs(id),
      },
      {
        label: 'Close Tabs to the Right',
        click: () => tabManager.closeTabsToRight(id),
      },
    ];

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: mainWindow });
  });

  mainWindow.on('closed', () => {
    tabManager.destroy();
  });
}


// Permission handling — with per-site remember-choice
app.on('ready', () => {
  const ses = session.defaultSession;
  const alwaysAllow = ['clipboard-read', 'clipboard-write', 'fullscreen', 'background-sync'];
  const askable = ['media', 'geolocation', 'notifications', 'midi'];

  ses.setPermissionCheckHandler((_wc, permission) => {
    if (alwaysAllow.includes(permission)) return true;
    // For askable permissions, check the database
    if (askable.includes(permission) && _wc) {
      try {
        const url = _wc.getURL();
        if (url) {
          const domain = new URL(url).hostname;
          const saved = getPermission(domain, permission);
          if (saved !== null) return saved;
        }
      } catch {}
    }
    return false;
  });

  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (alwaysAllow.includes(permission)) { callback(true); return; }

    if (askable.includes(permission) && _wc) {
      try {
        const url = _wc.getURL();
        if (url) {
          const domain = new URL(url).hostname;
          const saved = getPermission(domain, permission);
          if (saved !== null) { callback(saved); return; }

          // Ask the user
          if (mainWindow && !mainWindow.isDestroyed()) {
            dialog.showMessageBox(mainWindow, {
              type: 'question',
              title: 'Permission Request',
              message: `${domain} wants to use ${permission}`,
              detail: 'Do you want to allow this? Your choice will be remembered for this site.',
              buttons: ['Deny', 'Allow'],
              defaultId: 0,
              cancelId: 0,
            }).then(({ response }) => {
              const allowed = response === 1;
              setPermission(domain, permission, allowed);
              callback(allowed);
            });
            return;
          }
        }
      } catch {}
    }
    callback(false);
  });
});

// ─── Auto-select client certificate for enterprise mTLS ─────────────────────
app.on('select-client-certificate', (event, _webContents, url, list, callback) => {
  try {
    console.log('[auth] Client certificate requested by', url, '—', list.length, 'cert(s)');
    if (list.length > 0) {
      event.preventDefault();
      callback(list[0]);
    }
  } catch (e) {
    console.warn('[auth] Certificate selection error:', e);
  }
});

// ─── Strip Electron from User-Agent + relax CSP for extension localhost ──────
app.on('session-created', (ses) => {
  // Strip "Electron/X.Y.Z" and "tappi/X.Y.Z" from UA so sites don't detect Electron
  const ua = ses.getUserAgent();
  if (ua.includes('Electron/')) {
    ses.setUserAgent(ua.replace(/\s*Electron\/[\d.]+/g, '').replace(/\s*tappi\/[\d.]+/gi, ''));
  }


  // Combined onHeadersReceived handler:
  // 1) Intercept HTTP redirects (3xx) to custom URL schemes — prevents SIGSEGV
  // 2) Relax CSP for extension pages to allow localhost connections (native messaging polyfill)
  ses.webRequest.onHeadersReceived(
    (details, callback) => {
      const headers = details.responseHeaders || {};

      // (1) Catch HTTP redirects to non-standard schemes before Chromium follows them
      if (details.statusCode >= 300 && details.statusCode < 400) {
        const locKey = Object.keys(headers).find(k => k.toLowerCase() === 'location');
        const location = locKey && headers[locKey]?.[0];
        if (location && location.includes('://') && !/^(https?|file|chrome-extension|about|data|blob|javascript):\/?\/?/i.test(location)) {
          console.log('[main] Intercepting redirect to custom scheme:', location);
          openExternalUrl(location);
          callback({ cancel: true });
          return;
        }
      }

      // (2) Relax CSP for extension pages
      if (details.url.startsWith('chrome-extension://')) {
        const cspKey = Object.keys(headers).find(k => k.toLowerCase() === 'content-security-policy');
        if (cspKey && headers[cspKey]) {
          headers[cspKey] = headers[cspKey].map((val: string) => {
            if (val.includes('connect-src')) {
              return val.replace(
                /connect-src\s+/,
                'connect-src ws://127.0.0.1:* http://127.0.0.1:* '
              );
            }
            return val;
          });
        }
      }

      callback({ responseHeaders: headers });
    }
  );
});

// ─── Delegate custom URL schemes to the OS ───────────────────────────────────
// Intercept navigation to non-standard schemes (enterprise device registration,
// native app launchers, etc.) and hand them off to the OS.
// Uses macOS `open` command instead of shell.openExternal to avoid SIGSEGV
// crashes with custom URL schemes in some Electron/macOS configurations.
const STANDARD_SCHEME_RE = /^(https?|file|chrome-extension|about|data|blob|javascript):\/?\/?/i;

// IPC from content-preload: custom scheme link clicks intercepted at DOM level
ipcMain.on('open-custom-scheme', (_event, url: unknown) => {
  if (typeof url !== 'string' || url.length > 2048) return;
  if (STANDARD_SCHEME_RE.test(url)) return;
  openExternalUrl(url);
});

function openExternalUrl(url: string): void {
  console.log('[main] Opening external URL:', url);
  const { spawn } = require('child_process') as typeof import('child_process');
  if (process.platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  } else if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
  } else {
    spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  }
}

app.on('web-contents-created', (_ev, wc) => {
  // will-navigate covers link clicks and JS-initiated navigation
  wc.on('will-navigate', (event, url) => {
    if (/^(https?|file|chrome-extension):\/\//i.test(url)) return;
    event.preventDefault();
    openExternalUrl(url);
  });

  // did-start-navigation catches server redirects that will-navigate misses
  wc.on('did-start-navigation', (_e: any, url: string) => {
    if (/^(https?|file|chrome-extension|about|data):\/?\/?/i.test(url)) return;
    wc.stop();
    openExternalUrl(url);
  });
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  cleanupCron();
  cleanupShell();
  cleanupAllTeams();
  captureCleanupOnQuit(); // Phase 8.6: stop any in-progress recording
  stopApiServer();        // Phase 8.45: stop HTTP API server
  cleanupNativeHosts();   // Kill all native host processes
  stopNativeMessagingBridge(); // Stop bridge HTTP/WS server
  purgeSession('default');
  closeDatabase();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── Dev CLI server (Phase 4 testing) ───
// Allows running commands from terminal: echo "elements" | nc localhost 18900
import * as net from 'net';
const DEV_PORT = 18900;

function startDevServer() {
  // F12: Read API token for TCP auth
  const tokenPath = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.tappi-browser', 'api-token');
  let devToken = '';
  try { devToken = fs.readFileSync(tokenPath, 'utf-8').trim(); } catch {}

  const server = net.createServer((socket) => {
    let buffer = '';
    let processing = false;
    let authenticated = false;

    async function processCommand(cmd: string) {
      if (!cmd || processing) return;
      processing = true;

      // F12: First command must be the auth token
      if (!authenticated) {
        if (!devToken || cmd !== devToken) {
          if (!socket.destroyed) socket.write('Error: Authentication failed. Send API token as first line.\n');
          if (!socket.destroyed) socket.end();
          processing = false;
          return;
        }
        authenticated = true;
        if (!socket.destroyed) socket.write('OK\n');
        processing = false;
        return;
      }
      console.log('[dev] Command:', cmd);

      // "agent: <message>" → run through LLM agent
      if (cmd.startsWith('agent:') || cmd.startsWith('agent ')) {
        const agentMsg = cmd.replace(/^agent[: ]+/, '').trim();
        if (!agentMsg) {
          if (!socket.destroyed) socket.write('Usage: agent: <message>\n');
          processing = false;
          if (!socket.destroyed) socket.end();
          return;
        }
        const apiKey = decryptApiKey(currentConfig.llm.apiKey);
        if (!apiKey) {
          if (!socket.destroyed) socket.write('Error: No API key configured\n');
          processing = false;
          if (!socket.destroyed) socket.end();
          return;
        }
        const browserCtx: BrowserContext = { window: mainWindow, tabManager, config: currentConfig };
        // Also show in the agent panel
        mainWindow?.webContents.send('agent:stream-start', {});
        runAgent({
          userMessage: agentMsg,
          browserCtx,
          llmConfig: {
            provider: currentConfig.llm.provider, model: currentConfig.llm.model, apiKey,
            thinking: currentConfig.llm.thinking,
            thinkingEffort: currentConfig.llm.thinkingEffort,
            region: currentConfig.llm.region, projectId: currentConfig.llm.projectId,
            location: currentConfig.llm.location, endpoint: currentConfig.llm.endpoint,
            baseUrl: currentConfig.llm.baseUrl,
            // Timeouts (Phase 8.40)
            agentTimeoutMs: currentConfig.llm.agentTimeoutMs,
            teammateTimeoutMs: currentConfig.llm.teammateTimeoutMs,
            subtaskTimeoutMs: currentConfig.llm.subtaskTimeoutMs,
          },
          window: mainWindow,
          developerMode: currentConfig.developerMode,
          agentBrowsingDataAccess: currentConfig.privacy?.agentBrowsingDataAccess === true,
        });
        if (!socket.destroyed) socket.write('[agent] Running: ' + agentMsg + '\n');
        processing = false;
        if (!socket.destroyed) socket.end();
        return;
      }

      try {
        const browserCtx: BrowserContext = { window: mainWindow, tabManager, config: currentConfig };
        const result = await executeCommand(cmd, { browserCtx });
        if (!socket.destroyed) socket.write(result + '\n');
        mainWindow?.webContents.send('agent:response', {
          role: 'assistant',
          content: result,
          timestamp: Date.now(),
        });
      } catch (err: any) {
        if (!socket.destroyed) socket.write('Error: ' + err.message + '\n');
      }
      processing = false;
      if (!socket.destroyed) socket.end();
    }

    socket.setKeepAlive(true);
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes('\n') || buffer.includes('\r')) {
        const cmd = buffer.trim();
        buffer = '';
        processCommand(cmd);
      }
    });
    socket.on('end', () => {
      const cmd = buffer.trim();
      buffer = '';
      if (cmd && !processing) processCommand(cmd);
    });
    socket.on('error', () => {});
  });
  server.listen(DEV_PORT, '127.0.0.1', () => {
    console.log(`[dev] CLI server on port ${DEV_PORT}. Usage: echo "elements" | nc localhost ${DEV_PORT}`);
  });
  server.on('error', (e: any) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`[dev] Port ${DEV_PORT} in use, skipping dev server.`);
    }
  });
}

app.whenReady().then(() => {
  // Dev TCP server (port 18900) — only when Developer Mode is ON
  setTimeout(() => {
    if (currentConfig.developerMode) {
      startDevServer();
    } else {
      console.log('[dev] TCP CLI server disabled (Developer Mode is off). Enable in Settings to use port 18900.');
    }
  }, 1000); // Wait for window and config to be fully ready
});
