/**
 * claude-code-provider.ts — Claude Code integration for Tappi Browser.
 *
 * Uses the Claude Code CLI (`@anthropic-ai/claude-code`) for both auth methods:
 *
 *   - **OAuth** → CLI reads OAuth credentials from macOS Keychain / credential
 *     store (set up via `claude login`).
 *
 *   - **API Key** → CLI uses `ANTHROPIC_API_KEY` environment variable.
 *
 * The CLI is installed to a dedicated Tappi-managed directory under
 * ~/.tappi-browser/claude-code-cli/ — never using or interfering with the
 * user's own Claude Code installation.
 *
 * Claude Code gets access to Tappi's browser, file, and shell tools via the
 * HTTP API server (localhost:18901) documented in the system prompt / CLAUDE.md.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { EventEmitter } from 'events';

// ── Types ────────────────────────────────────────────────────────────────────

export type CCMode = 'plan' | 'full';

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

/** CLI install dir — dedicated, never uses user's own installation */
const CLI_INSTALL_DIR = path.join(os.homedir(), '.tappi-browser', 'claude-code-cli');
const CLI_PACKAGE = '@anthropic-ai/claude-code';

/** Path to Tappi's dedicated claude binary after npm install */
const TAPPI_CLAUDE_BIN = path.join(CLI_INSTALL_DIR, 'node_modules', '.bin', 'claude');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert CCMode to CLI flags for the `claude` command.
 */
function getCliModeArgs(mode: CCMode): string[] {
  switch (mode) {
    case 'plan': return ['--permission-mode', 'plan'];
    case 'full': return ['--dangerously-skip-permissions'];
  }
}

// ── Installation ─────────────────────────────────────────────────────────────

/**
 * Check if Tappi's dedicated Claude CLI is installed.
 * Only checks our own managed installation — never the user's.
 */
export async function isCliInstalled(): Promise<boolean> {
  return fs.existsSync(TAPPI_CLAUDE_BIN);
}

/**
 * Check if Claude Code CLI is available.
 * Both auth methods (OAuth and API key) use the same CLI binary.
 */
export async function isClaudeCodeInstalled(_authMethod: CCAuthMethod = 'oauth'): Promise<boolean> {
  return isCliInstalled();
}

/**
 * Install the Claude Code CLI to Tappi's dedicated directory.
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
 * Unified install entry point. Both auth methods use the same CLI.
 */
export async function installClaudeCode(
  _authMethod: CCAuthMethod,
  onProgress?: (msg: string) => void,
): Promise<void> {
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
 * Generate a system prompt that tells Claude Code about Tappi's HTTP API.
 * Written to CLAUDE.md so the CLI picks up Tappi's browser/file/shell capabilities.
 * Claude Code uses its own internal tools (Bash, Read, etc.) to call these HTTP endpoints.
 */
export function buildTappiSystemPrompt(): string {
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
`;
}

/**
 * Write a CLAUDE.md file to a temp directory for the CLI.
 * The CLI reads CLAUDE.md from its CWD for project instructions.
 * Returns the directory path where CLAUDE.md was written.
 */
function writeTappiClaudeMd(tappiApiToken: string): string {
  const dir = path.join(os.tmpdir(), 'tappi-claude-code');
  fs.mkdirSync(dir, { recursive: true });

  const content = buildTappiSystemPrompt()
    // Replace the env var reference with the actual token for the CLI path,
    // since we can't guarantee the CLI inherits the env var in all contexts.
    // The CLAUDE.md is in a temp dir with restricted access.
    .replace(/\$TAPPI_API_TOKEN/g, tappiApiToken);

  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), content, 'utf-8');
  return dir;
}

// ── Title Generation ─────────────────────────────────────────────────────────

/**
 * Generate a conversation title using the Claude Code CLI.
 * Lightweight one-shot call — no session management, no tools, no CLAUDE.md.
 * Works for both OAuth and API key auth methods.
 * Returns the title string, or null on failure.
 */
export async function generateTitleViaCli(
  userMessage: string,
  apiKey?: string,
): Promise<string | null> {
  if (!(await isCliInstalled())) {
    return null;
  }

  const titlePrompt = `Generate a short, descriptive title (3-6 words) for a conversation that starts with this message. Return ONLY the title text — no quotes, no punctuation at the end, no explanation.\n\nMessage: ${userMessage.slice(0, 300)}\n\nTitle:`;

  const args: string[] = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', 'claude-haiku-4-5',
    titlePrompt,
  ];

  const env: Record<string, string> = { ...process.env as any };
  if (apiKey) {
    env.ANTHROPIC_API_KEY = apiKey;
  }

  return new Promise((resolve) => {
    const proc = spawn(TAPPI_CLAUDE_BIN, args, {
      cwd: os.tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    let textResult = '';
    let stderr = '';
    let lineBuffer = '';

    proc.stdout?.on('data', (data: Buffer) => {
      lineBuffer += data.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          // Collect text from streaming deltas
          if (msg.type === 'content_block_delta' && msg.delta?.type === 'text_delta') {
            textResult += msg.delta.text;
          }
          // Also collect from assistant messages
          if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text) {
                textResult += block.text;
              }
            }
          }
          // Collect from result
          if (msg.type === 'result' && msg.result) {
            textResult += msg.result;
          }
        } catch {
          // Not JSON — might be raw text
          if (line.trim()) textResult += line.trim();
        }
      }
    });

    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    // Timeout: title generation should be fast
    const timeout = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      resolve(null);
    }, 15_000);

    proc.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        console.error('[claude-code] title gen failed:', stderr.slice(0, 200));
        resolve(null);
        return;
      }
      const title = textResult.replace(/^["']|["']$/g, '').replace(/[.!?]+$/, '').trim();
      resolve(title && title.length > 2 && title.length < 80 ? title : null);
    });

    proc.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

// ── Provider Class ───────────────────────────────────────────────────────────

export class ClaudeCodeProvider extends EventEmitter {
  config: CCProviderConfig;
  private activeProcess: ChildProcess | null = null;
  private sessionId: string | null = null;
  private pendingPlanApproval: boolean = false;

  // Pending tool_use state for streaming tool blocks
  private _pendingToolName?: string;
  private _pendingToolId?: string;
  private _pendingToolInput: string = '';

  constructor(config: CCProviderConfig) {
    super();
    this.config = config;
  }

  /** Whether the last plan-mode turn completed and is awaiting user review. */
  get isPlanPending(): boolean {
    return this.pendingPlanApproval;
  }

  /** Reset plan approval state (e.g. when starting a new conversation). */
  resetPlanState(): void {
    this.pendingPlanApproval = false;
  }

  /**
   * Send a message and stream output back via 'chunk' events.
   * Both auth methods (OAuth and API key) use the CLI.
   */
  async sendMessage(message: string): Promise<void> {
    return this._sendViaCli(message);
  }

  /**
   * Spawn Tappi's dedicated `claude` CLI with `--print`.
   *
   * - OAuth: CLI reads OAuth credentials from macOS Keychain / credential store.
   * - API Key: CLI uses ANTHROPIC_API_KEY environment variable.
   *
   * Uses Tappi's own CLI install at ~/.tappi-browser/claude-code-cli/ —
   * never the user's personal installation.
   *
   * Output format: `--output-format stream-json` gives us newline-delimited
   * JSON with streaming text deltas.
   */
  private async _sendViaCli(message: string): Promise<void> {
    if (!(await isCliInstalled())) {
      this.emit('error', 'Claude Code CLI is not installed. Select Claude Code provider to auto-install.');
      return;
    }

    // Write CLAUDE.md to a temp dir so the CLI picks up Tappi's HTTP API instructions
    const tappiToken = this.config.tappiApiToken || '';
    const claudeMdDir = writeTappiClaudeMd(tappiToken);

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
    // Set API key for api-key auth — CLI uses it instead of OAuth credentials
    if (this.config.authMethod === 'api-key' && this.config.apiKey) {
      env.ANTHROPIC_API_KEY = this.config.apiKey;
    }

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

        // If plan mode completed successfully, signal that plan is ready for review
        if (this.config.mode === 'plan' && (code === 0 || code === null)) {
          this.pendingPlanApproval = true;
          this.emit('plan-complete');
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
   * Message types handled:
   * - { type: "system", subtype: "init", session_id: "..." }
   * - { type: "assistant", message: { content: [{ type: "text"|"tool_use", ... }] } }
   * - { type: "content_block_start", content_block: { type: "tool_use", name, id } }
   * - { type: "content_block_delta", delta: { type: "text_delta"|"input_json_delta", ... } }
   * - { type: "content_block_stop" }
   * - { type: "tool_result", content: "..." }
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

    // Streaming tool input delta — accumulate JSON input chunks
    if (msg.type === 'content_block_delta' && msg.delta?.type === 'input_json_delta') {
      this._pendingToolInput += msg.delta.partial_json || '';
      return;
    }

    // Full assistant message — handle both text and tool_use content blocks
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) {
          this.emit('chunk', { text: block.text, done: false } as CCChunkEvent);
        } else if (block.type === 'tool_use') {
          const toolMd = this._formatToolUse(block.name, block.input);
          this.emit('chunk', { text: toolMd, done: false } as CCChunkEvent);
        }
      }
      return;
    }

    // Streaming tool_use start — emit tool header, begin accumulating input
    if (msg.type === 'content_block_start' && msg.content_block?.type === 'tool_use') {
      const block = msg.content_block;
      this._pendingToolName = block.name;
      this._pendingToolId = block.id;
      this._pendingToolInput = '';
      this.emit('chunk', { text: `\n\n> **🔧 ${block.name}**\n`, done: false } as CCChunkEvent);
      return;
    }

    // Content block finished — if tool_use, emit the formatted input details
    if (msg.type === 'content_block_stop') {
      if (this._pendingToolName && this._pendingToolInput) {
        try {
          const input = JSON.parse(this._pendingToolInput);
          const detail = this._formatToolInput(this._pendingToolName, input);
          if (detail) {
            this.emit('chunk', { text: detail, done: false } as CCChunkEvent);
          }
        } catch { /* partial JSON — skip detail formatting */ }
      }
      this._pendingToolName = undefined;
      this._pendingToolId = undefined;
      this._pendingToolInput = '';
      return;
    }

    // Tool result — show output of tool execution
    if (msg.type === 'tool_result' || (msg.role === 'user' && msg.content && Array.isArray(msg.content))) {
      const content = msg.content;
      if (typeof content === 'string' && content.trim()) {
        this.emit('chunk', { text: `\n> _Result:_ ${this._truncate(content, 500)}\n\n`, done: false } as CCChunkEvent);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result' && block.content) {
            const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            this.emit('chunk', { text: `\n> _Result:_ ${this._truncate(text, 500)}\n\n`, done: false } as CCChunkEvent);
          }
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

  /** Format a tool_use block from a complete assistant message as markdown */
  private _formatToolUse(name: string, input: any): string {
    let md = `\n\n> **🔧 ${name}**\n`;
    md += this._formatToolInput(name, input) || '';
    return md;
  }

  /** Format tool input details based on tool name */
  private _formatToolInput(name: string, input: any): string {
    if (!input) return '';
    switch (name) {
      case 'Write':
      case 'Read':
        return `> \`${input.file_path || ''}\`\n\n`;
      case 'Edit':
        return `> \`${input.file_path || ''}\`\n\n`;
      case 'Bash':
        return `> \`\`\`\n> ${this._truncate(input.command || '', 200)}\n> \`\`\`\n\n`;
      case 'Glob':
        return `> Pattern: \`${input.pattern || ''}\`\n\n`;
      case 'Grep':
        return `> Pattern: \`${input.pattern || ''}\`${input.path ? ` in \`${input.path}\`` : ''}\n\n`;
      case 'TodoWrite':
        return `> Updating task list\n\n`;
      default: {
        // Generic: show first meaningful key
        const keys = Object.keys(input).slice(0, 2);
        const summary = keys.map(k => `${k}: ${this._truncate(String(input[k] ?? ''), 100)}`).join(', ');
        return summary ? `> ${summary}\n\n` : '';
      }
    }
  }

  /** Truncate text to maxLen with ellipsis */
  private _truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + '…';
  }

  /**
   * Approve the pending plan and execute it with full permissions.
   * Temporarily switches mode to 'full' for this turn, then restores 'plan'.
   */
  async approvePlan(): Promise<void> {
    this.pendingPlanApproval = false;
    const savedMode = this.config.mode;
    this.config.mode = 'full';
    try {
      await this._sendViaCli('Approved. Execute the plan.');
    } finally {
      this.config.mode = savedMode;
    }
  }

  /**
   * Send user feedback on the plan. Stays in plan mode so CC updates the plan.
   */
  async sendPlanFeedback(feedback: string): Promise<void> {
    this.pendingPlanApproval = false;
    await this._sendViaCli(feedback);
  }

  /**
   * Stop the current CLI process.
   */
  stop(): void {
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
