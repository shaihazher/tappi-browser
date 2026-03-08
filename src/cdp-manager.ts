/**
 * cdp-manager.ts — CDP Session Manager (singleton).
 *
 * Manages per-tab Chrome DevTools Protocol debugger sessions with lazy
 * attachment and ring buffers for console, network, and error entries.
 * Uses Electron's webContents.debugger API.
 */

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ConsoleEntry {
  timestamp: number;
  level: string;     // 'log' | 'warn' | 'error' | 'info' | 'debug'
  text: string;
  stackTrace?: string;
}

export interface NetworkEntry {
  requestId: string;
  timestamp: number;
  method: string;
  url: string;
  status?: number;
  mimeType?: string;
  responseHeaders?: Record<string, string>;
  size?: number;
  timing?: number;    // duration in ms
  error?: string;
  fromCache?: boolean;
}

export interface ErrorEntry {
  timestamp: number;
  message: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  stackTrace?: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface RingBuffer<T> {
  items: T[];
  maxSize: number;
}

interface CDPSession {
  webContents: Electron.WebContents;
  attached: boolean;
  enabledDomains: Set<string>;
  consoleBuffer: RingBuffer<ConsoleEntry>;
  networkBuffer: RingBuffer<NetworkEntry>;
  errorBuffer: RingBuffer<ErrorEntry>;
  /** Pending (in-flight) network requests, keyed by requestId. */
  pendingRequests: Map<string, NetworkEntry>;
  /** Timestamp when the request started, for computing timing. */
  requestStartTimes: Map<string, number>;
  /** Error message if attachment failed. */
  attachError?: string;
}

// ---------------------------------------------------------------------------
// Ring buffer helpers
// ---------------------------------------------------------------------------

function createRingBuffer<T>(maxSize: number): RingBuffer<T> {
  return { items: [], maxSize };
}

function pushToRing<T>(ring: RingBuffer<T>, entry: T): void {
  if (ring.items.length >= ring.maxSize) {
    ring.items.shift();
  }
  ring.items.push(entry);
}

function clearRing<T>(ring: RingBuffer<T>): void {
  ring.items.length = 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map CDP console type strings to canonical levels. */
function mapConsoleLevel(cdpType: string): string {
  switch (cdpType) {
    case 'log':       return 'log';
    case 'warning':   return 'warn';
    case 'error':     return 'error';
    case 'info':      return 'info';
    case 'debug':     return 'debug';
    case 'dir':       return 'log';
    case 'dirxml':    return 'log';
    case 'table':     return 'log';
    case 'trace':     return 'debug';
    case 'assert':    return 'error';
    case 'count':     return 'log';
    case 'timeEnd':   return 'log';
    default:          return 'log';
  }
}

/** Extract a readable string from a CDP RemoteObject. */
function remoteObjectToString(obj: any): string {
  if (obj.value !== undefined) {
    if (typeof obj.value === 'string') return obj.value;
    try { return JSON.stringify(obj.value); } catch { return String(obj.value); }
  }
  if (obj.description) return obj.description;
  if (obj.unserializableValue) return obj.unserializableValue;
  return obj.type ?? 'undefined';
}

/** Format a CDP StackTrace into a readable multi-line string. */
function formatStackTrace(stackTrace: any): string | undefined {
  if (!stackTrace || !stackTrace.callFrames || stackTrace.callFrames.length === 0) {
    return undefined;
  }
  return stackTrace.callFrames
    .map((f: any) => `    at ${f.functionName || '(anonymous)'} (${f.url}:${f.lineNumber}:${f.columnNumber})`)
    .join('\n');
}

/** Check if a status code matches a filter like '4xx', '5xx', '200', etc. */
function statusMatches(status: number | undefined, filter: string): boolean {
  if (status === undefined) return false;
  if (filter.endsWith('xx')) {
    const prefix = parseInt(filter[0], 10);
    return Math.floor(status / 100) === prefix;
  }
  return status === parseInt(filter, 10);
}

// ---------------------------------------------------------------------------
// CDPManager
// ---------------------------------------------------------------------------

export class CDPManager {
  private sessions: Map<string, CDPSession> = new Map();

  // ---------- Public API ----------

  /**
   * Lazy-attach CDP debugger to a tab's webContents and enable the requested
   * domains (e.g. 'Runtime', 'Network', 'Page', 'DOM', 'Performance').
   *
   * If the debugger is already attached, any *new* domains are enabled
   * without re-attaching.
   */
  async ensureSession(
    tabId: string,
    webContents: Electron.WebContents,
    domains: string[],
  ): Promise<{ ok: boolean; error?: string }> {
    let sess = this.sessions.get(tabId);

    // First time — create session record
    if (!sess) {
      sess = {
        webContents,
        attached: false,
        enabledDomains: new Set(),
        consoleBuffer: createRingBuffer<ConsoleEntry>(500),
        networkBuffer: createRingBuffer<NetworkEntry>(200),
        errorBuffer: createRingBuffer<ErrorEntry>(100),
        pendingRequests: new Map(),
        requestStartTimes: new Map(),
      };
      this.sessions.set(tabId, sess);
    }

    // Attach debugger if not already attached
    if (!sess.attached) {
      try {
        webContents.debugger.attach('1.3');
        sess.attached = true;
        sess.attachError = undefined;

        // Wire up CDP event router
        this.installEventRouter(tabId, sess);

        // Handle unexpected detach (e.g. DevTools opened by user)
        webContents.debugger.on('detach', (_event: any, reason: string) => {
          console.log(`[cdp] Debugger detached from tab ${tabId}: ${reason}`);
          if (sess) {
            sess.attached = false;
            sess.enabledDomains.clear();
          }
        });
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        console.error(`[cdp] Failed to attach debugger to tab ${tabId}: ${msg}`);
        sess.attachError = msg;
        return { ok: false, error: msg };
      }
    }

    // Enable any domains that haven't been enabled yet
    const newDomains = domains.filter((d) => !sess!.enabledDomains.has(d));
    for (const domain of newDomains) {
      try {
        await webContents.debugger.sendCommand(`${domain}.enable`);
        sess.enabledDomains.add(domain);
      } catch (err: any) {
        console.warn(`[cdp] Failed to enable domain ${domain} on tab ${tabId}: ${err?.message}`);
      }
    }

    return { ok: true };
  }

  /**
   * Detach the debugger and flush all buffers for a tab.
   */
  destroySession(tabId: string): void {
    const sess = this.sessions.get(tabId);
    if (!sess) return;

    if (sess.attached) {
      try {
        sess.webContents.debugger.detach();
      } catch {
        // May already be detached — ignore.
      }
    }

    // Flush buffers
    clearRing(sess.consoleBuffer);
    clearRing(sess.networkBuffer);
    clearRing(sess.errorBuffer);
    sess.pendingRequests.clear();
    sess.requestStartTimes.clear();

    this.sessions.delete(tabId);
  }

  /**
   * Read from the console ring buffer with optional filtering.
   */
  getConsoleEntries(
    tabId: string,
    filter?: { level?: string; grep?: string; limit?: number },
  ): ConsoleEntry[] {
    const sess = this.sessions.get(tabId);
    if (!sess) return [];

    let entries = [...sess.consoleBuffer.items];

    if (filter?.level) {
      const lvl = filter.level.toLowerCase();
      entries = entries.filter((e) => e.level === lvl);
    }
    if (filter?.grep) {
      const pattern = filter.grep.toLowerCase();
      entries = entries.filter(
        (e) =>
          e.text.toLowerCase().includes(pattern) ||
          (e.stackTrace && e.stackTrace.toLowerCase().includes(pattern)),
      );
    }
    if (filter?.limit && filter.limit > 0) {
      entries = entries.slice(-filter.limit);
    }

    return entries;
  }

  /**
   * Read from the network ring buffer with optional filtering.
   *
   * `status` can be a specific code ('200'), a class ('4xx', '5xx'), etc.
   */
  getNetworkEntries(
    tabId: string,
    filter?: {
      status?: string;
      method?: string;
      grep?: string;
      limit?: number;
      details?: boolean;
    },
  ): NetworkEntry[] {
    const sess = this.sessions.get(tabId);
    if (!sess) return [];

    let entries = [...sess.networkBuffer.items];

    if (filter?.status) {
      entries = entries.filter((e) => statusMatches(e.status, filter.status!));
    }
    if (filter?.method) {
      const m = filter.method.toUpperCase();
      entries = entries.filter((e) => e.method.toUpperCase() === m);
    }
    if (filter?.grep) {
      const pattern = filter.grep.toLowerCase();
      entries = entries.filter(
        (e) =>
          e.url.toLowerCase().includes(pattern) ||
          (e.error && e.error.toLowerCase().includes(pattern)),
      );
    }
    if (filter?.limit && filter.limit > 0) {
      entries = entries.slice(-filter.limit);
    }

    // When details is false/undefined, strip verbose fields to keep output compact
    if (!filter?.details) {
      entries = entries.map((e) => {
        const { responseHeaders, ...rest } = e;
        return rest;
      });
    }

    return entries;
  }

  /**
   * Read from the error ring buffer with optional filtering.
   */
  getErrorEntries(
    tabId: string,
    filter?: { grep?: string; limit?: number },
  ): ErrorEntry[] {
    const sess = this.sessions.get(tabId);
    if (!sess) return [];

    let entries = [...sess.errorBuffer.items];

    if (filter?.grep) {
      const pattern = filter.grep.toLowerCase();
      entries = entries.filter(
        (e) =>
          e.message.toLowerCase().includes(pattern) ||
          (e.stackTrace && e.stackTrace.toLowerCase().includes(pattern)) ||
          (e.url && e.url.toLowerCase().includes(pattern)),
      );
    }
    if (filter?.limit && filter.limit > 0) {
      entries = entries.slice(-filter.limit);
    }

    return entries;
  }

  /**
   * Clear a specific ring buffer for a tab.
   */
  clearBuffer(tabId: string, type: 'console' | 'network' | 'error'): void {
    const sess = this.sessions.get(tabId);
    if (!sess) return;

    switch (type) {
      case 'console':
        clearRing(sess.consoleBuffer);
        break;
      case 'network':
        clearRing(sess.networkBuffer);
        sess.pendingRequests.clear();
        sess.requestStartTimes.clear();
        break;
      case 'error':
        clearRing(sess.errorBuffer);
        break;
    }
  }

  /**
   * Send a raw CDP command to a tab. Used by devtools_inspect and other
   * advanced tooling.
   */
  async sendCommand(tabId: string, method: string, params?: any): Promise<any> {
    const sess = this.sessions.get(tabId);
    if (!sess) throw new Error(`No CDP session for tab ${tabId}`);
    if (!sess.attached) throw new Error(`CDP debugger not attached for tab ${tabId}`);

    return sess.webContents.debugger.sendCommand(method, params ?? {});
  }

  // ---------- Internal ----------

  /**
   * Install the CDP event router on the debugger message channel.
   * Routes incoming events to the appropriate ring buffer handler.
   */
  private installEventRouter(tabId: string, sess: CDPSession): void {
    sess.webContents.debugger.on('message', (_event: any, method: string, params: any) => {
      switch (method) {
        case 'Runtime.consoleAPICalled':
          this.handleConsoleAPI(sess, params);
          break;
        case 'Runtime.exceptionThrown':
          this.handleExceptionThrown(sess, params);
          break;
        case 'Network.requestWillBeSent':
          this.handleRequestWillBeSent(sess, params);
          break;
        case 'Network.responseReceived':
          this.handleResponseReceived(sess, params);
          break;
        case 'Network.loadingFinished':
          this.handleLoadingFinished(sess, params);
          break;
        case 'Network.loadingFailed':
          this.handleLoadingFailed(sess, params);
          break;
        case 'Page.frameNavigated':
          this.handleFrameNavigated(sess, params);
          break;
        default:
          // Other CDP events are ignored — they can be consumed via sendCommand.
          break;
      }
    });
  }

  // ---- Console ----

  private handleConsoleAPI(sess: CDPSession, params: any): void {
    const args: any[] = params.args ?? [];
    const text = args.map(remoteObjectToString).join(' ');
    const level = mapConsoleLevel(params.type ?? 'log');
    const entry: ConsoleEntry = {
      timestamp: Date.now(),
      level,
      text,
      stackTrace: formatStackTrace(params.stackTrace),
    };
    pushToRing(sess.consoleBuffer, entry);
  }

  // ---- Errors ----

  private handleExceptionThrown(sess: CDPSession, params: any): void {
    const detail = params.exceptionDetails ?? {};
    const exception = detail.exception;
    const message =
      (exception && (exception.description || exception.value)) ||
      detail.text ||
      'Unknown error';

    const entry: ErrorEntry = {
      timestamp: Date.now(),
      message: String(message),
      url: detail.url,
      lineNumber: detail.lineNumber,
      columnNumber: detail.columnNumber,
      stackTrace: formatStackTrace(detail.stackTrace),
    };
    pushToRing(sess.errorBuffer, entry);
  }

  // ---- Network ----

  private handleRequestWillBeSent(sess: CDPSession, params: any): void {
    const request = params.request ?? {};
    const entry: NetworkEntry = {
      requestId: params.requestId,
      timestamp: Date.now(),
      method: request.method ?? 'GET',
      url: request.url ?? '',
    };
    sess.pendingRequests.set(params.requestId, entry);
    sess.requestStartTimes.set(params.requestId, params.timestamp ?? Date.now() / 1000);
  }

  private handleResponseReceived(sess: CDPSession, params: any): void {
    const pending = sess.pendingRequests.get(params.requestId);
    if (!pending) return;

    const response = params.response ?? {};
    pending.status = response.status;
    pending.mimeType = response.mimeType;
    pending.fromCache = response.fromDiskCache || response.fromServiceWorker || false;

    // Flatten response headers
    if (response.headers && typeof response.headers === 'object') {
      pending.responseHeaders = response.headers;
    }
  }

  private handleLoadingFinished(sess: CDPSession, params: any): void {
    const pending = sess.pendingRequests.get(params.requestId);
    if (!pending) return;

    // Compute timing
    const startTimestamp = sess.requestStartTimes.get(params.requestId);
    if (startTimestamp !== undefined && params.timestamp !== undefined) {
      pending.timing = Math.round((params.timestamp - startTimestamp) * 1000);
    }

    pending.size = params.encodedDataLength;

    // Move from pending to completed buffer
    pushToRing(sess.networkBuffer, pending);
    sess.pendingRequests.delete(params.requestId);
    sess.requestStartTimes.delete(params.requestId);
  }

  private handleLoadingFailed(sess: CDPSession, params: any): void {
    const pending = sess.pendingRequests.get(params.requestId);
    if (!pending) return;

    pending.error = params.errorText ?? 'Loading failed';

    // Compute timing if available
    const startTimestamp = sess.requestStartTimes.get(params.requestId);
    if (startTimestamp !== undefined && params.timestamp !== undefined) {
      pending.timing = Math.round((params.timestamp - startTimestamp) * 1000);
    }

    // Move from pending to completed buffer
    pushToRing(sess.networkBuffer, pending);
    sess.pendingRequests.delete(params.requestId);
    sess.requestStartTimes.delete(params.requestId);
  }

  // ---- Navigation ----

  private handleFrameNavigated(sess: CDPSession, params: any): void {
    const frame = params.frame ?? {};
    // Only insert marker for main frame navigations (no parentId)
    if (frame.parentId) return;

    const marker: ConsoleEntry = {
      timestamp: Date.now(),
      level: 'info',
      text: `--- Page navigated to: ${frame.url ?? 'unknown'} ---`,
    };
    pushToRing(sess.consoleBuffer, marker);
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

export const cdpManager = new CDPManager();
