/**
 * native-messaging-bridge.ts — Local HTTP + WebSocket Bridge Server
 *
 * Bridges extension polyfill (renderer-side fetch/WebSocket) to the native host
 * manager (main process). Hand-rolled minimal WebSocket implementation — no `ws`
 * dependency, matching the project's zero-extra-deps style.
 *
 * Architecture:
 *   Extension background page  →  fetch / WebSocket to 127.0.0.1:<port>
 *   →  Bridge validates auth token + extension permissions
 *   →  Native Host Manager spawns host process (4-byte length-prefixed JSON)
 *   →  Responses flow back through the same chain
 */

import * as http from 'http';
import { createHash, randomBytes } from 'crypto';
import {
  sendOneShot,
  connectPort,
  postMessage,
  disconnect,
  validateAccess,
} from './native-messaging';

// ─── State ───────────────────────────────────────────────────────────────────

let server: http.Server | null = null;
let bridgePort = 0;
let bridgeToken = '';

// Track active WebSocket connections for cleanup
const activeWebSockets = new Map<string, { socket: import('net').Socket; connectionId: string }>();

// ─── Minimal WebSocket helpers ───────────────────────────────────────────────
// Implements just enough of RFC 6455 for text frames, close, and ping/pong.

const WS_GUID = '258EAFA5-E914-47DA-95CA-5AB5A70AD34C';

function computeAcceptKey(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

function buildWsFrame(data: string | Buffer, opcode: number = 0x01): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  const len = payload.length;
  let header: Buffer;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode; // FIN + opcode
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    // Write as two 32-bit values (safe for messages < 4GB)
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }

  return Buffer.concat([header, payload]);
}

interface WsFrame {
  opcode: number;
  payload: Buffer;
  complete: boolean;
  bytesConsumed: number;
}

function parseWsFrame(buf: Buffer): WsFrame | null {
  if (buf.length < 2) return null;

  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    // Read lower 32 bits only (safe for practical message sizes)
    payloadLen = buf.readUInt32BE(6);
    offset = 10;
  }

  if (masked) {
    if (buf.length < offset + 4 + payloadLen) return null;
    const maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = buf[offset + i] ^ maskKey[i % 4];
    }
    return { opcode, payload, complete: true, bytesConsumed: offset + payloadLen };
  }

  if (buf.length < offset + payloadLen) return null;
  return {
    opcode,
    payload: buf.subarray(offset, offset + payloadLen),
    complete: true,
    bytesConsumed: offset + payloadLen,
  };
}

// ─── HTTP request body reader ────────────────────────────────────────────────

function readBody(req: http.IncomingMessage, maxBytes = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// ─── Bridge Server ───────────────────────────────────────────────────────────

/**
 * Start the native messaging bridge server.
 * Returns { port, token } for injection into extension polyfills.
 */
export function startNativeMessagingBridge(
  permissionCheck: (extensionId: string, permission: string) => boolean,
): Promise<{ port: number; token: string }> {
  return new Promise((resolve, reject) => {
    bridgeToken = randomBytes(32).toString('hex');

    server = http.createServer(async (req, res) => {
      // CORS headers for extension contexts
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // ── POST /native-messaging/send — One-shot messaging ──
      if (req.method === 'POST' && req.url === '/native-messaging/send') {
        // Validate auth token
        const auth = req.headers.authorization;
        if (!auth || auth !== `Bearer ${bridgeToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        try {
          const body = JSON.parse(await readBody(req));
          const { hostName, extensionId, message } = body;

          if (!hostName || !extensionId || message === undefined) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing hostName, extensionId, or message' }));
            return;
          }

          // Permission check
          if (!permissionCheck(extensionId, 'nativeMessaging')) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Extension lacks nativeMessaging permission' }));
            return;
          }

          // Access validation
          const access = validateAccess(hostName, extensionId);
          if (!access.ok) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: access.error }));
            return;
          }

          const response = await sendOneShot(hostName, extensionId, message);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ response }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message || String(e) }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    // ── WebSocket upgrade for /native-messaging/connect ──
    server.on('upgrade', (req: http.IncomingMessage, socket: import('net').Socket, head: Buffer) => {
      const url = new URL(req.url || '/', `http://127.0.0.1`);

      if (url.pathname !== '/native-messaging/connect') {
        socket.destroy();
        return;
      }

      // Validate auth token from query string
      const token = url.searchParams.get('token');
      if (token !== bridgeToken) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const hostName = url.searchParams.get('hostName');
      const extensionId = url.searchParams.get('extensionId');

      if (!hostName || !extensionId) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }

      // Permission check
      if (!permissionCheck(extensionId, 'nativeMessaging')) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      // Access validation
      const access = validateAccess(hostName, extensionId);
      if (!access.ok) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      // Complete WebSocket handshake
      const wsKey = req.headers['sec-websocket-key'];
      if (!wsKey) {
        socket.destroy();
        return;
      }

      const acceptKey = computeAcceptKey(wsKey);
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
        '\r\n',
      );

      // Generate connection ID
      const connectionId = `port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Set up native host connection
      const result = connectPort(
        hostName,
        extensionId,
        connectionId,
        // onMessage from native host → send to WebSocket
        (msg) => {
          try {
            socket.write(buildWsFrame(JSON.stringify(msg)));
          } catch {}
        },
        // onDisconnect from native host → close WebSocket
        (error) => {
          try {
            const reason = error || 'Native host disconnected';
            const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
            payload.writeUInt16BE(1000, 0);
            payload.write(reason, 2);
            socket.write(buildWsFrame(payload, 0x08)); // close frame
          } catch {}
          activeWebSockets.delete(connectionId);
          socket.destroy();
        },
      );

      if (!result.ok) {
        const errMsg = result.error || 'Failed to connect';
        const payload = Buffer.alloc(2 + Buffer.byteLength(errMsg));
        payload.writeUInt16BE(1011, 0);
        payload.write(errMsg, 2);
        socket.write(buildWsFrame(payload, 0x08));
        socket.destroy();
        return;
      }

      activeWebSockets.set(connectionId, { socket, connectionId });

      // Handle incoming WebSocket frames
      let wsBuf = Buffer.alloc(0);

      socket.on('data', (chunk: Buffer) => {
        wsBuf = Buffer.concat([wsBuf, chunk]);

        while (true) {
          const frame = parseWsFrame(wsBuf);
          if (!frame) break;
          wsBuf = wsBuf.subarray(frame.bytesConsumed);

          if (frame.opcode === 0x01) {
            // Text frame — forward to native host
            try {
              const msg = JSON.parse(frame.payload.toString('utf-8'));
              postMessage(connectionId, msg);
            } catch (e) {
              console.error('[tappi] Invalid JSON from WebSocket:', e);
            }
          } else if (frame.opcode === 0x08) {
            // Close frame
            disconnect(connectionId);
            activeWebSockets.delete(connectionId);
            socket.destroy();
            break;
          } else if (frame.opcode === 0x09) {
            // Ping → Pong
            socket.write(buildWsFrame(frame.payload, 0x0a));
          }
          // 0x0a (pong) — ignore
        }
      });

      socket.on('close', () => {
        disconnect(connectionId);
        activeWebSockets.delete(connectionId);
      });

      socket.on('error', () => {
        disconnect(connectionId);
        activeWebSockets.delete(connectionId);
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address() as import('net').AddressInfo;
      bridgePort = addr.port;
      console.log(`[tappi] Native messaging bridge listening on 127.0.0.1:${bridgePort}`);
      resolve({ port: bridgePort, token: bridgeToken });
    });

    server.on('error', (err) => {
      console.error('[tappi] Native messaging bridge server error:', err);
      reject(err);
    });
  });
}

/**
 * Stop the bridge server and disconnect all WebSocket clients.
 */
export function stopNativeMessagingBridge(): void {
  for (const [id, ws] of activeWebSockets) {
    try {
      disconnect(id);
      ws.socket.destroy();
    } catch {}
  }
  activeWebSockets.clear();

  if (server) {
    server.close();
    server = null;
    console.log('[tappi] Native messaging bridge stopped');
  }
}

// ─── Polyfill Builder ────────────────────────────────────────────────────────

/**
 * Get current bridge connection info (port + token).
 * Returns null if the bridge is not running.
 */
export function getBridgeInfo(): { port: number; token: string } | null {
  if (!server || !bridgePort || !bridgeToken) return null;
  return { port: bridgePort, token: bridgeToken };
}

/**
 * Build the JavaScript polyfill to inject into extension background pages.
 * Overrides chrome.runtime.sendNativeMessage and chrome.runtime.connectNative.
 */
export function buildPolyfillScript(extensionId: string, port: number, token: string): string {
  return `
(function() {
  if (window.__tappiNativeMessagingInjected) return;
  window.__tappiNativeMessagingInjected = true;

  const BRIDGE_PORT = ${port};
  const BRIDGE_TOKEN = ${JSON.stringify(token)};
  const EXTENSION_ID = ${JSON.stringify(extensionId)};
  const BRIDGE_BASE = 'http://127.0.0.1:' + BRIDGE_PORT;

  // ── chrome.runtime.sendNativeMessage ──
  const origSendNativeMessage = chrome.runtime.sendNativeMessage;
  chrome.runtime.sendNativeMessage = function(application, message, responseCallback) {
    // Support both (app, msg, cb) and promise-based
    const promise = fetch(BRIDGE_BASE + '/native-messaging/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + BRIDGE_TOKEN,
      },
      body: JSON.stringify({
        hostName: application,
        extensionId: EXTENSION_ID,
        message: message,
      }),
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (data.error) {
        chrome.runtime.lastError = { message: data.error };
        if (responseCallback) responseCallback(undefined);
        throw new Error(data.error);
      }
      chrome.runtime.lastError = undefined;
      if (responseCallback) responseCallback(data.response);
      return data.response;
    })
    .catch(function(err) {
      chrome.runtime.lastError = { message: err.message };
      if (responseCallback) responseCallback(undefined);
    });

    if (!responseCallback) return promise;
  };

  // ── chrome.runtime.connectNative ──
  const origConnectNative = chrome.runtime.connectNative;
  chrome.runtime.connectNative = function(application) {
    const messageListeners = [];
    const disconnectListeners = [];
    let connected = false;
    let ws = null;
    const messageQueue = [];

    const port = {
      name: application,
      sender: undefined,
      onMessage: {
        addListener: function(cb) { messageListeners.push(cb); },
        removeListener: function(cb) {
          const idx = messageListeners.indexOf(cb);
          if (idx >= 0) messageListeners.splice(idx, 1);
        },
        hasListener: function(cb) { return messageListeners.includes(cb); },
        hasListeners: function() { return messageListeners.length > 0; },
      },
      onDisconnect: {
        addListener: function(cb) { disconnectListeners.push(cb); },
        removeListener: function(cb) {
          const idx = disconnectListeners.indexOf(cb);
          if (idx >= 0) disconnectListeners.splice(idx, 1);
        },
        hasListener: function(cb) { return disconnectListeners.includes(cb); },
        hasListeners: function() { return disconnectListeners.length > 0; },
      },
      postMessage: function(msg) {
        if (connected && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        } else {
          messageQueue.push(msg);
        }
      },
      disconnect: function() {
        if (ws) {
          ws.close();
          ws = null;
        }
        connected = false;
      },
    };

    // Establish WebSocket connection
    var wsUrl = 'ws://127.0.0.1:' + BRIDGE_PORT + '/native-messaging/connect'
      + '?token=' + encodeURIComponent(BRIDGE_TOKEN)
      + '&hostName=' + encodeURIComponent(application)
      + '&extensionId=' + encodeURIComponent(EXTENSION_ID);

    ws = new WebSocket(wsUrl);

    ws.onopen = function() {
      connected = true;
      // Flush queued messages
      while (messageQueue.length > 0) {
        ws.send(JSON.stringify(messageQueue.shift()));
      }
    };

    ws.onmessage = function(event) {
      try {
        var msg = JSON.parse(event.data);
        for (var i = 0; i < messageListeners.length; i++) {
          messageListeners[i](msg);
        }
      } catch (e) {
        console.error('[tappi-polyfill] Failed to parse message:', e);
      }
    };

    ws.onclose = function(event) {
      connected = false;
      ws = null;
      if (event.reason) {
        chrome.runtime.lastError = { message: event.reason };
      }
      for (var i = 0; i < disconnectListeners.length; i++) {
        disconnectListeners[i](port);
      }
    };

    ws.onerror = function(err) {
      console.error('[tappi-polyfill] WebSocket error for', application, err);
    };

    return port;
  };

  console.log('[tappi] Native messaging polyfill injected for extension:', EXTENSION_ID);
})();
`;
}

/**
 * Build the JavaScript polyfill for MV3 service worker contexts.
 * Uses globalThis/self instead of window; uses chrome.runtime.id for auto-detection.
 * Designed to be written as a standalone ES module file and imported before the
 * extension's original service worker.
 */
export function buildServiceWorkerPolyfill(port: number, token: string): string {
  return `
// Tappi native messaging polyfill for MV3 service workers
if (!self.__tappiNativeMessagingInjected) {
  self.__tappiNativeMessagingInjected = true;

  const BRIDGE_PORT = ${port};
  const BRIDGE_TOKEN = ${JSON.stringify(token)};
  const BRIDGE_BASE = 'http://127.0.0.1:' + BRIDGE_PORT;

  // Auto-detect extension ID from the service worker runtime
  const EXTENSION_ID = chrome.runtime.id;

  // ── chrome.runtime.sendNativeMessage ──
  chrome.runtime.sendNativeMessage = function(application, message, responseCallback) {
    const promise = fetch(BRIDGE_BASE + '/native-messaging/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + BRIDGE_TOKEN,
      },
      body: JSON.stringify({
        hostName: application,
        extensionId: EXTENSION_ID,
        message: message,
      }),
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (data.error) {
        chrome.runtime.lastError = { message: data.error };
        if (responseCallback) responseCallback(undefined);
        throw new Error(data.error);
      }
      chrome.runtime.lastError = undefined;
      if (responseCallback) responseCallback(data.response);
      return data.response;
    })
    .catch(function(err) {
      chrome.runtime.lastError = { message: err.message };
      if (responseCallback) responseCallback(undefined);
    });

    if (!responseCallback) return promise;
  };

  // ── chrome.runtime.connectNative ──
  chrome.runtime.connectNative = function(application) {
    const messageListeners = [];
    const disconnectListeners = [];
    let connected = false;
    let ws = null;
    const messageQueue = [];

    const port = {
      name: application,
      sender: undefined,
      onMessage: {
        addListener: function(cb) { messageListeners.push(cb); },
        removeListener: function(cb) {
          const idx = messageListeners.indexOf(cb);
          if (idx >= 0) messageListeners.splice(idx, 1);
        },
        hasListener: function(cb) { return messageListeners.includes(cb); },
        hasListeners: function() { return messageListeners.length > 0; },
      },
      onDisconnect: {
        addListener: function(cb) { disconnectListeners.push(cb); },
        removeListener: function(cb) {
          const idx = disconnectListeners.indexOf(cb);
          if (idx >= 0) disconnectListeners.splice(idx, 1);
        },
        hasListener: function(cb) { return disconnectListeners.includes(cb); },
        hasListeners: function() { return disconnectListeners.length > 0; },
      },
      postMessage: function(msg) {
        if (connected && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        } else {
          messageQueue.push(msg);
        }
      },
      disconnect: function() {
        if (ws) {
          ws.close();
          ws = null;
        }
        connected = false;
      },
    };

    // Establish WebSocket connection
    var wsUrl = 'ws://127.0.0.1:' + BRIDGE_PORT + '/native-messaging/connect'
      + '?token=' + encodeURIComponent(BRIDGE_TOKEN)
      + '&hostName=' + encodeURIComponent(application)
      + '&extensionId=' + encodeURIComponent(EXTENSION_ID);

    ws = new WebSocket(wsUrl);

    ws.onopen = function() {
      connected = true;
      while (messageQueue.length > 0) {
        ws.send(JSON.stringify(messageQueue.shift()));
      }
    };

    ws.onmessage = function(event) {
      try {
        var msg = JSON.parse(event.data);
        for (var i = 0; i < messageListeners.length; i++) {
          messageListeners[i](msg);
        }
      } catch (e) {
        console.error('[tappi-polyfill] Failed to parse message:', e);
      }
    };

    ws.onclose = function(event) {
      connected = false;
      ws = null;
      if (event.reason) {
        chrome.runtime.lastError = { message: event.reason };
      }
      for (var i = 0; i < disconnectListeners.length; i++) {
        disconnectListeners[i](port);
      }
    };

    ws.onerror = function(err) {
      console.error('[tappi-polyfill] WebSocket error for', application, err);
    };

    return port;
  };

  console.log('[tappi] Native messaging polyfill injected for extension:', EXTENSION_ID);
}
`;
}
