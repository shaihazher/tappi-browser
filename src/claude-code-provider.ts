/**
 * claude-code-provider.ts — Claude Code integration for Tappi Browser.
 *
 * Two authentication paths, per Anthropic's terms:
 *
 *   1. **API Key** → Uses the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
 *      which spawns a Claude Code subprocess via `query()`. OAuth tokens are
 *      explicitly prohibited on the Agent SDK by Anthropic's ToS.
 *
 *   2. **OAuth** → Spawns the actual `claude` CLI directly with `--print` and
 *      `--output-format stream-json`. This is the only officially permitted way
 *      to use OAuth tokens — through the Claude Code interface itself.
 *
 * Both paths install to dedicated Tappi-managed directories under
 * ~/.tappi-browser/ — never using or interfering with the user's own
 * Claude Code installation.
 *
 * Both paths get access to Tappi's full tool set via the HTTP API server
 * (localhost:18901) through the system prompt / CLAUDE.md.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { EventEmitter } from 'events';

// ── Types ────────────────────────────────────────────────────────────────────

export type CCMode = 'plan' | 'ask' | 'full';

export type CCAuthMethod = 'api-key' | 'oauth';

export interface CCProviderConfig {
  authMethod: CCAuthMethod;
  apiKey?: string;           // Only used when authMethod === 'api-key'
  mode: CCMode;
  model?: string;            // e.g. 'claude-sonnet-4-6' — passed via --model flag
  tappiApiToken?: string;
  workingDir?: string;
}

export interface CCChunkEvent {
  text: string;
  done: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Agent SDK install dir (API key path) */
const SDK_INSTALL_DIR = path.join(os.homedir(), '.tappi-browser', 'claude-code');
const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

/** CLI install dir (OAuth path) — dedicated, never uses user's own installation */
const CLI_INSTALL_DIR = path.join(os.homedir(), '.tappi-browser', 'claude-code-cli');
const CLI_PACKAGE = '@anthropic-ai/claude-code';

/** Path to Tappi's dedicated claude binary after npm install */
const TAPPI_CLAUDE_BIN = path.join(CLI_INSTALL_DIR, 'node_modules', '.bin', 'claude');

// ── Helpers ──────────────────────────────────────────────────────────────────

function getPermissionMode(mode: CCMode): string {
  switch (mode) {
    case 'plan': return 'plan';
    case 'ask': return 'default';
    case 'full': return 'bypassPermissions';
  }
}

/**
 * Convert CCMode to CLI flags for the `claude` command.
 */
function getCliModeArgs(mode: CCMode): string[] {
  switch (mode) {
    case 'plan': return ['--permission-mode', 'plan'];
    case 'ask': return ['--permission-mode', 'default'];
    case 'full': return ['--dangerously-skip-permissions'];
  }
}

// ── Installation ─────────────────────────────────────────────────────────────

/**
 * Check if the Agent SDK is installed (for API key auth path).
 */
export async function isAgentSdkInstalled(): Promise<boolean> {
  const pkgDir = path.join(SDK_INSTALL_DIR, 'node_modules', SDK_PACKAGE);
  return fs.existsSync(pkgDir);
}

/**
 * Check if Tappi's dedicated Claude CLI is installed (for OAuth auth path).
 * Only checks our own managed installation — never the user's.
 */
export async function isCliInstalled(): Promise<boolean> {
  return fs.existsSync(TAPPI_CLAUDE_BIN);
}

/**
 * Check if Claude Code is available for the given auth method.
 * - API key: needs the Agent SDK in ~/.tappi-browser/claude-code/
 * - OAuth:   needs the CLI in ~/.tappi-browser/claude-code-cli/
 */
export async function isClaudeCodeInstalled(authMethod: CCAuthMethod = 'oauth'): Promise<boolean> {
  if (authMethod === 'api-key') {
    return isAgentSdkInstalled();
  }
  return isCliInstalled();
}

/**
 * Install the Agent SDK to Tappi's dedicated directory (API key path).
 */
export async function installAgentSdk(
  onProgress?: (msg: string) => void,
): Promise<void> {
  if (await isAgentSdkInstalled()) return;

  fs.mkdirSync(SDK_INSTALL_DIR, { recursive: true });

  const pkgJsonPath = path.join(SDK_INSTALL_DIR, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    fs.writeFileSync(pkgJsonPath, JSON.stringify({
      name: 'tappi-claude-code-sdk',
      version: '1.0.0',
      private: true,
    }, null, 2));
  }

  return new Promise((resolve, reject) => {
    onProgress?.('Installing Claude Agent SDK...');

    const proc = spawn('npm', ['install', SDK_PACKAGE], {
      cwd: SDK_INSTALL_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stderr = '';
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.stdout?.on('data', (d) => { onProgress?.(d.toString().trim()); });

    proc.on('exit', (code) => {
      if (code === 0) {
        onProgress?.('Claude Agent SDK installed successfully.');
        resolve();
      } else {
        reject(new Error(`npm install failed (code ${code}): ${stderr.slice(0, 500)}`));
      }
    });

    proc.on('error', (err) => reject(err));
  });
}

/**
 * Install the Claude Code CLI to Tappi's dedicated directory (OAuth path).
 *
 * Installs `@anthropic-ai/claude-code` via npm into ~/.tappi-browser/claude-code-cli/.
 * The binary ends up at node_modules/.bin/claude. This is a completely separate
 * installation that never conflicts with the user's own Claude Code.
 */
export async function installClaudeCli(
  onProgress?: (msg: string) => void,
): Promise<void> {
  if (await isCliInstalled()) return;

  fs.mkdirSync(CLI_INSTALL_DIR, { recursive: true });

  const pkgJsonPath = path.join(CLI_INSTALL_DIR, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    fs.writeFileSync(pkgJsonPath, JSON.stringify({
      name: 'tappi-claude-code-cli',
      version: '1.0.0',
      private: true,
    }, null, 2));
  }

  return new Promise((resolve, reject) => {
    onProgress?.('Installing Claude Code CLI...');

    const proc = spawn('npm', ['install', CLI_PACKAGE], {
      cwd: CLI_INSTALL_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stderr = '';
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.stdout?.on('data', (d) => { onProgress?.(d.toString().trim()); });

    proc.on('exit', (code) => {
      if (code === 0) {
        onProgress?.('Claude Code CLI installed successfully.');
        resolve();
      } else {
        reject(new Error(`npm install failed (code ${code}): ${stderr.slice(0, 500)}`));
      }
    });

    proc.on('error', (err) => reject(err));
  });
}

/**
 * Unified install entry point. Installs the right component based on auth method.
 */
export async function installClaudeCode(
  authMethod: CCAuthMethod,
  onProgress?: (msg: string) => void,
): Promise<void> {
  if (authMethod === 'api-key') {
    return installAgentSdk(onProgress);
  }
  return installClaudeCli(onProgress);
}

// ── Authentication ───────────────────────────────────────────────────────────

/**
 * Check if the Tappi-managed Claude Code CLI is authenticated.
 * Runs `claude auth status` and checks the exit code.
 * Exit code 0 = logged in, 1 = not logged in.
 */
export async function checkClaudeAuthStatus(): Promise<{ loggedIn: boolean; email?: string }> {
  if (!(await isCliInstalled())) {
    return { loggedIn: false };
  }

  return new Promise((resolve) => {
    const proc = spawn(TAPPI_CLAUDE_BIN, ['auth', 'status', '--text'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });

    proc.on('exit', (code) => {
      if (code === 0) {
        // Try to extract email from output like "Logged in as user@example.com"
        const emailMatch = stdout.match(/([^\s]+@[^\s]+\.[^\s]+)/);
        resolve({ loggedIn: true, email: emailMatch?.[1] });
      } else {
        resolve({ loggedIn: false });
      }
    });

    proc.on('error', () => {
      resolve({ loggedIn: false });
    });
  });
}

/**
 * Run `claude auth login` with the BROWSER env var redirected so that
 * the OAuth URL is captured and forwarded to Tappi instead of opening
 * the system browser.
 *
 * @param onUrl  Called with the OAuth URL once Claude Code emits it.
 *               The caller should open this URL in a Tappi BrowserWindow.
 * @returns      Promise that resolves when the login process completes.
 */
export async function loginClaudeCode(
  onUrl: (url: string) => void,
): Promise<{ success: boolean; error?: string }> {
  if (!(await isCliInstalled())) {
    return { success: false, error: 'Claude Code CLI is not installed.' };
  }

  // Ensure onboarding flag exists — without this, Claude Code prompts
  // for theme selection even with valid credentials.
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  if (!fs.existsSync(claudeJsonPath)) {
    try {
      fs.writeFileSync(claudeJsonPath, JSON.stringify({ hasCompletedOnboarding: true }, null, 2));
    } catch {
      // Non-fatal — login may still prompt for onboarding
    }
  } else {
    // Ensure flag is set even if file exists
    try {
      const existing = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
      if (!existing.hasCompletedOnboarding) {
        existing.hasCompletedOnboarding = true;
        fs.writeFileSync(claudeJsonPath, JSON.stringify(existing, null, 2));
      }
    } catch {
      // Non-fatal
    }
  }

  // Create a temp file where the helper script will write the OAuth URL.
  const urlTempFile = path.join(os.tmpdir(), `tappi-cc-oauth-url-${Date.now()}`);

  // Write a helper script that captures the URL instead of opening a browser.
  // Claude Code (via Node's `open` package) calls: BROWSER <url>
  const helperScript = path.join(CLI_INSTALL_DIR, 'open-url.sh');
  fs.writeFileSync(helperScript, `#!/bin/bash\necho "$1" > "${urlTempFile}"\n`, { mode: 0o755 });

  return new Promise((resolve) => {
    const env: Record<string, string> = { ...process.env as any };
    env.BROWSER = helperScript;

    const proc = spawn(TAPPI_CLAUDE_BIN, ['auth', 'login'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    let urlDelivered = false;
    let pollTimer: NodeJS.Timeout | null = null;
    let stderrBuf = '';

    proc.stdout?.on('data', (d) => {
      console.log('[claude-login stdout]', d.toString().trim());
    });
    proc.stderr?.on('data', (d) => {
      stderrBuf += d.toString();
      console.log('[claude-login stderr]', d.toString().trim());
    });

    // Poll for the URL file — the helper script writes it when BROWSER is invoked.
    const startPoll = () => {
      pollTimer = setInterval(() => {
        try {
          if (fs.existsSync(urlTempFile)) {
            const url = fs.readFileSync(urlTempFile, 'utf-8').trim();
            if (url && !urlDelivered) {
              urlDelivered = true;
              onUrl(url);
              // Clean up temp file
              try { fs.unlinkSync(urlTempFile); } catch {}
              if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
              }
            }
          }
        } catch {
          // File not ready yet, keep polling
        }
      }, 200);
    };

    startPoll();

    // Timeout: stop polling after 30 seconds if URL never appears
    const urlTimeout = setTimeout(() => {
      if (!urlDelivered) {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        try { fs.unlinkSync(urlTempFile); } catch {}
        // Don't kill the process — it might still be working via fallback
        console.warn('[claude-login] OAuth URL not captured after 30s');
      }
    }, 30_000);

    proc.on('exit', (code) => {
      clearTimeout(urlTimeout);
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      try { fs.unlinkSync(urlTempFile); } catch {}

      if (code === 0) {
        resolve({ success: true });
      } else {
        const errMsg = stderrBuf.trim().slice(0, 500) || `Login exited with code ${code}`;
        resolve({ success: false, error: errMsg });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(urlTimeout);
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      try { fs.unlinkSync(urlTempFile); } catch {}
      resolve({ success: false, error: err.message });
    });
  });
}

// ── System Prompt / CLAUDE.md ────────────────────────────────────────────────

/**
 * Generate a system prompt that tells Claude Code about Tappi's API.
 * Used by both the SDK path (as systemPrompt) and CLI path (written to CLAUDE.md).
 */
export function buildTappiSystemPrompt(toolGuide: string): string {
  return `You are Aria, an AI assistant integrated into Tappi Browser. You have full access to the browser's capabilities via its HTTP API.

## Tappi Browser API

Base URL: http://localhost:18901
Auth: All requests require header \`Authorization: Bearer $TAPPI_API_TOKEN\` (the token is in your TAPPI_API_TOKEN environment variable).

### Quick Reference

**Navigate & Read Pages:**
\`\`\`bash
# Navigate to URL
curl -s -X POST http://localhost:18901/api/tabs/1/navigate -H "Authorization: Bearer $TAPPI_API_TOKEN" -H "Content-Type: application/json" -d '{"url":"https://example.com"}'

# List interactive elements
curl -s http://localhost:18901/api/tabs/1/elements -H "Authorization: Bearer $TAPPI_API_TOKEN"

# Read page text
curl -s http://localhost:18901/api/tabs/1/text -H "Authorization: Bearer $TAPPI_API_TOKEN"

# Click element by index
curl -s -X POST http://localhost:18901/api/tabs/1/click -H "Authorization: Bearer $TAPPI_API_TOKEN" -H "Content-Type: application/json" -d '{"index":5}'

# Type into element
curl -s -X POST http://localhost:18901/api/tabs/1/type -H "Authorization: Bearer $TAPPI_API_TOKEN" -H "Content-Type: application/json" -d '{"index":3,"text":"hello"}'
\`\`\`

**Execute Any Tool (generic endpoint):**
\`\`\`bash
curl -s -X POST http://localhost:18901/api/tools/<toolName> -H "Authorization: Bearer $TAPPI_API_TOKEN" -H "Content-Type: application/json" -d '{ ...params }'
\`\`\`

### Key Tools Available via /api/tools/:toolName

**User Profile (persist preferences across sessions):**
- \`update_user_profile\` — \`{ "action": "read" }\` to read, \`{ "action": "append", "text": "- Prefers dark mode" }\` to add, \`{ "action": "update", "text": "full new profile" }\` to rewrite

**Cron Jobs (scheduled tasks):**
- \`cron_add\` — \`{ "name": "...", "task": "...", "schedule": { "kind": "daily", "timeOfDay": "09:00" } }\`
- \`cron_list\` — \`{}\` to list all jobs
- \`cron_update\` — \`{ "id": "...", "enabled": false }\` to pause, \`{ "id": "...", "task": "new prompt" }\` to change
- \`cron_delete\` — \`{ "id": "..." }\`

**Browser:**
- \`navigate\`, \`search\`, \`elements\`, \`click\`, \`type\`, \`paste\`, \`text\`, \`links\`, \`screenshot\`, \`keys\`, \`eval_js\`
- \`switch_tab\`, \`new_tab\`, \`close_tab\`
- \`dark_mode\`, \`zoom\`, \`find\`

**Files:**
- \`file_read\`, \`file_write\`, \`file_append\`, \`file_delete\`, \`file_list\`, \`file_head\`, \`file_tail\`, \`file_grep\`

**Shell:**
- \`exec\` — \`{ "command": "ls -la" }\`

**HTTP:**
- \`http_request\` — \`{ "method": "GET", "url": "..." }\`

**Agent status:**
- GET \`/api/status\` — running status, tab count, model info
- GET \`/api/tabs\` — list open tabs
- GET \`/api/tools\` — list all available tools with descriptions

## Problem-Solving Directive
For EVERY request:
1. **Understand** this request clearly.
2. **Figure out** how to fulfill this request/problem.
3. **Solve** the problem or fulfill the request.
4. **Verify** — confirm it worked.
5. **Present** — explain what you did concisely.

## Style
- Concise. Say what you did and what happened.
- If something fails, try an alternative before giving up.
- For casual questions, just answer directly without using tools.

${toolGuide.slice(0, 2000)}
`;
}

/**
 * Write a CLAUDE.md file to a temp directory for the CLI OAuth path.
 * The CLI reads CLAUDE.md from its CWD for project instructions.
 * Returns the directory path where CLAUDE.md was written.
 */
function writeTappiClaudeMd(toolGuide: string, tappiApiToken: string): string {
  const dir = path.join(os.tmpdir(), 'tappi-claude-code');
  fs.mkdirSync(dir, { recursive: true });

  const content = buildTappiSystemPrompt(toolGuide)
    // Replace the env var reference with the actual token for the CLI path,
    // since we can't guarantee the CLI inherits the env var in all contexts.
    // The CLAUDE.md is in a temp dir with restricted access.
    .replace(/\$TAPPI_API_TOKEN/g, tappiApiToken);

  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), content, 'utf-8');
  return dir;
}

// ── Provider Class ───────────────────────────────────────────────────────────

export class ClaudeCodeProvider extends EventEmitter {
  config: CCProviderConfig;
  private abortController: AbortController | null = null;
  private activeQuery: any = null;
  private activeProcess: ChildProcess | null = null;
  private sessionId: string | null = null;

  constructor(config: CCProviderConfig) {
    super();
    this.config = config;
  }

  /**
   * Send a message and stream output back via 'chunk' events.
   *
   * Routes to the appropriate backend:
   * - API Key → Agent SDK `query()` (SDK is allowed to use API keys)
   * - OAuth  → `claude` CLI with `--print` (only official way to use OAuth)
   */
  async sendMessage(message: string, toolGuide: string): Promise<void> {
    if (this.config.authMethod === 'api-key') {
      return this._sendViaSdk(message, toolGuide);
    } else {
      return this._sendViaCli(message, toolGuide);
    }
  }

  /**
   * API Key path: use the Claude Agent SDK's query() function.
   * Anthropic allows API key authentication for the Agent SDK.
   */
  private async _sendViaSdk(message: string, toolGuide: string): Promise<void> {
    if (!(await isAgentSdkInstalled())) {
      this.emit('error', 'Claude Agent SDK is not installed. Select Claude Code provider to auto-install.');
      return;
    }

    // Dynamic import from the on-demand install directory
    const sdkPath = path.join(SDK_INSTALL_DIR, 'node_modules', SDK_PACKAGE);
    let queryFn: any;
    try {
      const sdk = require(sdkPath);
      queryFn = sdk.query;
      if (!queryFn) throw new Error('query() not found in SDK exports');
    } catch (err: any) {
      this.emit('error', `Failed to load Claude Agent SDK: ${err.message}`);
      return;
    }

    this.abortController = new AbortController();

    const systemPrompt = buildTappiSystemPrompt(toolGuide);
    const permissionMode = getPermissionMode(this.config.mode);

    const env: Record<string, string> = { ...process.env as any };
    if (this.config.apiKey) {
      env.ANTHROPIC_API_KEY = this.config.apiKey;
    }
    if (this.config.tappiApiToken) {
      env.TAPPI_API_TOKEN = this.config.tappiApiToken;
    }

    const options: Record<string, any> = {
      systemPrompt,
      permissionMode,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      cwd: this.config.workingDir || os.homedir(),
      env,
      abortController: this.abortController,
      maxTurns: 30,
      includePartialMessages: true,
      ...(this.config.model ? { model: this.config.model } : {}),
    };

    if (this.config.mode === 'full') {
      options.allowDangerouslySkipPermissions = true;
    }

    if (this.sessionId) {
      options.resume = this.sessionId;
    }

    try {
      const q = queryFn({ prompt: message, options });
      this.activeQuery = q;

      for await (const msg of q) {
        if (!msg || !msg.type) continue;

        if (msg.type === 'system' && msg.subtype === 'init') {
          this.sessionId = msg.session_id;
          continue;
        }

        if (msg.type === 'stream_event' && msg.event) {
          const event = msg.event;
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            this.emit('chunk', { text: event.delta.text, done: false } as CCChunkEvent);
          }
          continue;
        }

        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              this.emit('chunk', { text: block.text, done: false } as CCChunkEvent);
            }
          }
          continue;
        }

        if (msg.type === 'result') {
          this.emit('chunk', { text: '', done: true } as CCChunkEvent);
          break;
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        this.emit('chunk', { text: '\n\n[Stopped]', done: true } as CCChunkEvent);
      } else {
        console.error('[claude-code-provider] SDK query error:', err);
        this.emit('error', err.message || 'Claude Code query failed');
        this.emit('chunk', { text: '', done: true } as CCChunkEvent);
      }
    } finally {
      this.activeQuery = null;
      this.abortController = null;
    }
  }

  /**
   * OAuth path: spawn Tappi's dedicated `claude` CLI with `--print`.
   *
   * This is the ONLY officially permitted way to use OAuth tokens.
   * Anthropic's ToS explicitly prohibits OAuth on the Agent SDK.
   * The CLI reads OAuth credentials from macOS Keychain / credential store
   * (set up via `claude login`).
   *
   * Uses Tappi's own CLI install at ~/.tappi-browser/claude-code-cli/ —
   * never the user's personal installation.
   *
   * Output format: `--output-format stream-json` gives us newline-delimited
   * JSON with streaming text deltas.
   */
  private async _sendViaCli(message: string, toolGuide: string): Promise<void> {
    if (!(await isCliInstalled())) {
      this.emit('error', 'Claude Code CLI is not installed. Select Claude Code provider to auto-install.');
      return;
    }

    // Write CLAUDE.md to a temp dir so the CLI picks up Tappi's tool instructions
    const tappiToken = this.config.tappiApiToken || '';
    const claudeMdDir = writeTappiClaudeMd(toolGuide, tappiToken);

    const args: string[] = [
      '--print',                        // Non-interactive, print result
      '--output-format', 'stream-json', // Streaming JSON lines
      '--verbose',                      // Include tool use info
      ...(this.config.model ? ['--model', this.config.model] : []),
      ...getCliModeArgs(this.config.mode),
      message,
    ];

    // Resume session for multi-turn
    if (this.sessionId) {
      args.unshift('--resume', this.sessionId);
    }

    const env: Record<string, string> = { ...process.env as any };
    if (this.config.tappiApiToken) {
      env.TAPPI_API_TOKEN = this.config.tappiApiToken;
    }
    // DO NOT set ANTHROPIC_API_KEY for OAuth — let the CLI use its OAuth credentials

    return new Promise<void>((resolve) => {
      const proc = spawn(TAPPI_CLAUDE_BIN, args, {
        cwd: claudeMdDir,  // CWD with CLAUDE.md for project context
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });

      this.activeProcess = proc;
      let stderrBuf = '';
      let lineBuffer = '';

      proc.stdout?.on('data', (data: Buffer) => {
        lineBuffer += data.toString();
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';  // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this._handleCliStreamMessage(msg);
          } catch {
            // Not JSON — might be raw text output, emit as-is
            if (line.trim()) {
              this.emit('chunk', { text: line, done: false } as CCChunkEvent);
            }
          }
        }
      });

      proc.stderr?.on('data', (d: Buffer) => {
        stderrBuf += d.toString();
        // Log but don't show stderr to user unless it's an error
        console.log('[claude-cli stderr]', d.toString().trim());
      });

      proc.on('exit', (code) => {
        this.activeProcess = null;

        // Process any remaining buffered data
        if (lineBuffer.trim()) {
          try {
            const msg = JSON.parse(lineBuffer);
            this._handleCliStreamMessage(msg);
          } catch {
            if (lineBuffer.trim()) {
              this.emit('chunk', { text: lineBuffer.trim(), done: false } as CCChunkEvent);
            }
          }
        }

        if (code !== 0 && code !== null) {
          const errMsg = stderrBuf.trim().slice(0, 500) || `CLI exited with code ${code}`;
          // Check for common OAuth errors
          if (stderrBuf.includes('not logged in') || stderrBuf.includes('authentication') || stderrBuf.includes('login')) {
            this.emit('error', 'Not logged in to Claude Code. Run `claude login` in your terminal to authenticate.');
          } else {
            this.emit('error', errMsg);
          }
        }

        this.emit('chunk', { text: '', done: true } as CCChunkEvent);
        resolve();
      });

      proc.on('error', (err) => {
        this.activeProcess = null;
        console.error('[claude-code-provider] CLI spawn error:', err);
        this.emit('error', `Failed to start Claude CLI: ${err.message}`);
        this.emit('chunk', { text: '', done: true } as CCChunkEvent);
        resolve();
      });
    });
  }

  /**
   * Parse a stream-json message from the `claude --output-format stream-json` output.
   *
   * Message types:
   * - { type: "system", subtype: "init", session_id: "..." }
   * - { type: "assistant", message: { content: [{ type: "text", text: "..." }] } }
   * - { type: "content_block_delta", delta: { type: "text_delta", text: "..." } }
   * - { type: "result", result: "...", session_id: "..." }
   */
  private _handleCliStreamMessage(msg: any): void {
    if (!msg || !msg.type) return;

    // Capture session ID
    if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
      this.sessionId = msg.session_id;
      return;
    }

    // Streaming text delta
    if (msg.type === 'content_block_delta' && msg.delta?.type === 'text_delta') {
      this.emit('chunk', { text: msg.delta.text, done: false } as CCChunkEvent);
      return;
    }

    // Full assistant message
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) {
          this.emit('chunk', { text: block.text, done: false } as CCChunkEvent);
        }
      }
      return;
    }

    // Result — capture session ID for resume
    if (msg.type === 'result') {
      if (msg.session_id) {
        this.sessionId = msg.session_id;
      }
      return;
    }
  }

  /**
   * Stop the current query/process.
   */
  stop(): void {
    // SDK path
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.activeQuery?.close) {
      try { this.activeQuery.close(); } catch {}
    }
    this.activeQuery = null;

    // CLI path
    if (this.activeProcess) {
      try { this.activeProcess.kill('SIGTERM'); } catch {}
      this.activeProcess = null;
    }
  }

  /**
   * Get the current session ID for conversation continuity.
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Reset the session (start fresh conversation).
   */
  resetSession(): void {
    this.sessionId = null;
  }
}
