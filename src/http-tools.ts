/**
 * http-tools.ts — General-purpose HTTP client for the agent.
 *
 * Gives the agent the ability to call any API — REST, GraphQL, webhooks,
 * image generation services, etc. The browser is for browsing; this is for
 * programmatic interaction with the web.
 *
 * Capabilities:
 *   - GET/POST/PUT/PATCH/DELETE with headers, body, auth
 *   - Response handling: JSON, text, binary (save to file)
 *   - API key management: store/retrieve keys per service
 *   - Chain-friendly: returns structured results the agent can act on
 *
 * Security model:
 *   - All requests originate from the user's machine (no proxy)
 *   - API keys stored encrypted via safeStorage (same as LLM keys)
 *   - Agent can store keys it discovers (e.g. signs up on a site, copies key)
 *   - No ambient credentials — agent must explicitly pass auth
 */

import { safeStorage, net } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.tappi-browser');
// api-keys.json is profile-relative (per-user API keys)
// api-services.json is global (shared service definitions across profiles)
const SERVICES_PATH = path.join(CONFIG_DIR, 'api-services.json');

function getKeysPath(): string {
  try {
    const { profileManager } = require('./profile-manager');
    return profileManager.getApiKeysPath();
  } catch {
    return path.join(CONFIG_DIR, 'api-keys.json');
  }
}

// Convenience accessor used throughout this file
const KEYS_PATH = CONFIG_DIR + '/api-keys.json'; // fallback for legacy reads

// ─── API Service Registry ───

interface EndpointDoc {
  path: string;          // e.g. "/chat/completions"
  method: string;        // e.g. "POST"
  summary: string;       // one-line description (~10 words)
  requestSchema: string; // compact JSON example of request body
  responseSchema: string; // compact JSON example of response body
}

interface ServiceEntry {
  name: string;          // e.g. "openai"
  baseUrl: string;       // e.g. "https://api.openai.com/v1"
  authHeader: string;    // e.g. "Bearer" — prepended to key in Authorization header
  description: string;   // e.g. "OpenAI API — GPT, DALL-E, Whisper, embeddings"
  endpoints?: string[];  // legacy flat list — superseded by endpointDocs
  endpointDocs?: EndpointDoc[];  // structured per-endpoint documentation
}

interface ServiceRegistry {
  [name: string]: ServiceEntry;
}

export function loadServices(): ServiceRegistry {
  try {
    if (fs.existsSync(SERVICES_PATH)) {
      return JSON.parse(fs.readFileSync(SERVICES_PATH, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveServices(registry: ServiceRegistry) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(SERVICES_PATH, JSON.stringify(registry, null, 2));
  } catch (e) {
    console.error('[http] service registry save failed:', e);
  }
}

export function registerService(name: string, baseUrl: string, authHeader: string, description: string, endpoints?: string[]): string {
  if (!name || !baseUrl) return 'Usage: register_api(name, baseUrl, authHeader, description)';
  const registry = loadServices();
  const existing = registry[name];
  registry[name] = {
    name, baseUrl, authHeader: authHeader || 'Bearer', description, endpoints,
    endpointDocs: existing?.endpointDocs || [],  // preserve existing docs on re-register
  };
  saveServices(registry);
  return `API service "${name}" registered: ${baseUrl} — ${description}`;
}

export function documentEndpoint(
  serviceName: string,
  endpoint: EndpointDoc,
): string {
  const registry = loadServices();
  const service = registry[serviceName];
  if (!service) return `No service "${serviceName}" found. Register it first with register_api.`;

  if (!service.endpointDocs) service.endpointDocs = [];

  // Upsert — replace if same path+method exists
  const key = `${endpoint.method} ${endpoint.path}`;
  const idx = service.endpointDocs.findIndex(d => `${d.method} ${d.path}` === key);
  if (idx >= 0) {
    service.endpointDocs[idx] = endpoint;
  } else {
    service.endpointDocs.push(endpoint);
  }

  saveServices(registry);
  return `Documented ${key} on "${serviceName}". ${service.endpointDocs.length} endpoint(s) documented.`;
}

export function getEndpointDocs(serviceName: string, grep?: string): string {
  const registry = loadServices();
  const service = registry[serviceName];
  if (!service) return `No service "${serviceName}" found.`;
  if (!service.endpointDocs?.length) return `No endpoint docs for "${serviceName}". Use document_endpoint to add them.`;

  let docs = service.endpointDocs;
  if (grep) {
    const q = grep.toLowerCase();
    docs = docs.filter(d =>
      d.path.toLowerCase().includes(q) ||
      d.summary.toLowerCase().includes(q) ||
      d.method.toLowerCase().includes(q)
    );
  }

  if (docs.length === 0) return `No endpoints matching "${grep}" in "${serviceName}".`;

  const lines: string[] = [`${serviceName} API (${docs.length} endpoint${docs.length > 1 ? 's' : ''}):`];
  for (const d of docs) {
    lines.push(`\n  ${d.method} ${d.path} — ${d.summary}`);
    lines.push(`  Request: ${d.requestSchema}`);
    lines.push(`  Response: ${d.responseSchema}`);
  }
  return lines.join('\n');
}

export function listServices(): string {
  const registry = loadServices();
  const vault = loadVault();
  const names = Object.keys(registry);
  if (names.length === 0 && Object.keys(vault).length === 0) return 'No API services configured.';

  const lines: string[] = ['Configured API services:'];
  for (const name of names) {
    const s = registry[name];
    const hasKey = !!vault[name];
    lines.push(`  • ${name} ${hasKey ? '🔑' : '⚠ no key'} — ${s.description}`);
    lines.push(`    ${s.baseUrl}`);
    if (s.endpoints?.length) lines.push(`    Endpoints: ${s.endpoints.join(', ')}`);
  }

  // Show keys without service entries
  const orphanKeys = Object.keys(vault).filter(k => !registry[k]);
  if (orphanKeys.length > 0) {
    lines.push('  Keys without service config:');
    for (const k of orphanKeys) lines.push(`    • ${k} 🔑`);
  }

  return lines.join('\n');
}

export function getServiceContext(): string {
  const registry = loadServices();
  const vault = loadVault();
  const names = [...new Set([...Object.keys(registry), ...Object.keys(vault)])];
  if (names.length === 0) return '';

  const parts: string[] = ['API services:'];
  for (const name of names) {
    const s = registry[name];
    const hasKey = !!vault[name];
    if (s) {
      parts.push(`  ${name} ${hasKey ? '🔑' : '⚠'}: ${s.description} (${s.baseUrl})`);
      // Compact endpoint list — just method+path, agent uses get_endpoint_docs for schemas
      if (s.endpointDocs?.length) {
        parts.push(`    Endpoints: ${s.endpointDocs.map(d => `${d.method} ${d.path}`).join(', ')}`);
      } else if (s.endpoints?.length) {
        parts.push(`    Endpoints: ${s.endpoints.join(', ')}`);
      }
    } else {
      parts.push(`  ${name} 🔑: key stored, no service config`);
    }
  }
  return parts.join('\n');
}

export function removeService(name: string): string {
  const registry = loadServices();
  if (!registry[name]) return `No service "${name}" found.`;
  delete registry[name];
  saveServices(registry);
  return `Service "${name}" removed. API key (if any) kept — use api_key_delete to remove it.`;
}

/**
 * Resolve @service auth shorthand. Returns the full Authorization header value.
 */
export function resolveAuth(auth: string): string {
  if (!auth) return '';
  if (!auth.startsWith('@')) return auth;

  const service = auth.slice(1);
  const key = getApiKey(service);
  if (!key) return `ERROR: No API key stored for "${service}". Use api_key_store first.`;

  const registry = loadServices();
  const entry = registry[service];
  const prefix = entry?.authHeader || 'Bearer';
  return `${prefix} ${key}`;
}

// ─── API Key Vault ───

interface KeyVault {
  [service: string]: string; // encrypted key
}

function loadVault(): KeyVault {
  try {
    const keysPath = getKeysPath();
    if (fs.existsSync(keysPath)) {
      return JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveVault(vault: KeyVault) {
  try {
    const keysPath = getKeysPath();
    const dir = path.dirname(keysPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keysPath, JSON.stringify(vault, null, 2));
    fs.chmodSync(keysPath, 0o600);
  } catch (e) {
    console.error('[http] vault save failed:', e);
  }
}

function encryptKey(key: string): string {
  if (!key) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(key).toString('base64');
    }
  } catch {}
  return key;
}

function decryptKey(encrypted: string): string {
  if (!encrypted) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    }
  } catch {}
  return encrypted;
}

// ─── HTTP Request ───

export interface HttpRequest {
  url: string;
  method?: string;              // GET, POST, PUT, PATCH, DELETE (default: GET)
  headers?: Record<string, string>;
  body?: string;                // Raw body (JSON string, form data, etc.)
  json?: any;                   // Auto-serialized to JSON, sets Content-Type
  auth?: string;                // "Bearer <token>" or "Basic <b64>" — sets Authorization header
  saveToFile?: string;          // If set, write binary response to this path
  timeout?: number;             // Timeout in ms (default: 30000)
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;                 // Response body (text/JSON) or file path if saved
  size: number;                 // Response size in bytes
  duration: number;             // Request duration in ms
  json?: any;                   // Parsed JSON if content-type is application/json
}

/** F13: SSRF protection — block requests to private/internal addresses */
function isBlockedUrl(urlStr: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return 'Invalid URL';
  }

  // Block non-HTTP(S) protocols
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Blocked: protocol "${parsed.protocol}" is not allowed (only http/https)`;
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block known internal hostnames
  if (hostname === 'localhost' || hostname === 'metadata.google.internal') {
    return 'Blocked: requests to private/internal addresses are not allowed';
  }

  // Block IPv6 loopback
  if (hostname === '::1' || hostname === '[::1]') {
    return 'Blocked: requests to private/internal addresses are not allowed';
  }

  // Check IP ranges
  const ipMatch = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipMatch) {
    const [, a, b] = ipMatch.map(Number);
    if (a === 127) return 'Blocked: requests to private/internal addresses are not allowed';       // 127.0.0.0/8
    if (a === 10) return 'Blocked: requests to private/internal addresses are not allowed';        // 10.0.0.0/8
    if (a === 192 && b === 168) return 'Blocked: requests to private/internal addresses are not allowed'; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return 'Blocked: requests to private/internal addresses are not allowed'; // 172.16.0.0/12
    if (a === 169 && b === 254) return 'Blocked: requests to private/internal addresses are not allowed'; // 169.254.0.0/16
  }

  return null;
}

export async function httpRequest(req: HttpRequest): Promise<string> {
  const method = (req.method || 'GET').toUpperCase();
  const url = req.url;
  const timeout = req.timeout || 30000;

  if (!url) return 'Error: URL is required.';

  // F13: SSRF check
  const blocked = isBlockedUrl(url);
  if (blocked) return blocked;

  // Build headers
  const headers: Record<string, string> = { ...req.headers };
  if (req.auth) {
    const resolved = resolveAuth(req.auth);
    if (resolved.startsWith('ERROR:')) return resolved;
    headers['Authorization'] = resolved;
  }
  if (req.json && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (!headers['User-Agent']) headers['User-Agent'] = 'TappiBrowser/0.1.0';

  // Build body
  let body: string | undefined;
  if (req.json) body = JSON.stringify(req.json);
  else if (req.body) body = req.body;

  const start = Date.now();

  try {
    const response = await new Promise<HttpResponse>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout after ${timeout}ms`)), timeout);

      // Use Node's built-in fetch (available in Electron's main process)
      const fetchOpts: RequestInit = {
        method,
        headers,
        body: body || undefined,
      };

      fetch(url, fetchOpts)
        .then(async (res) => {
          clearTimeout(timer);
          const duration = Date.now() - start;

          const respHeaders: Record<string, string> = {};
          res.headers.forEach((v, k) => { respHeaders[k] = v; });

          const contentType = res.headers.get('content-type') || '';

          // Binary response → save to file
          if (req.saveToFile) {
            const buffer = Buffer.from(await res.arrayBuffer());
            const filePath = path.resolve(req.saveToFile);
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filePath, buffer);
            resolve({
              status: res.status,
              statusText: res.statusText,
              headers: respHeaders,
              body: `File saved: ${filePath} (${buffer.length} bytes)`,
              size: buffer.length,
              duration,
            });
            return;
          }

          // Text/JSON response
          const text = await res.text();
          let json: any;
          if (contentType.includes('json')) {
            try { json = JSON.parse(text); } catch {}
          }

          resolve({
            status: res.status,
            statusText: res.statusText,
            headers: respHeaders,
            body: text.slice(0, 10000), // Cap at 10KB for agent context
            size: text.length,
            duration,
            json,
          });
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });

    // Save response to file, return metadata + preview
    const RESPONSE_DIR = path.join(CONFIG_DIR, 'api-responses');
    if (!fs.existsSync(RESPONSE_DIR)) fs.mkdirSync(RESPONSE_DIR, { recursive: true });

    // Clean up old response files (>1 hour)
    try {
      const now = Date.now();
      for (const f of fs.readdirSync(RESPONSE_DIR)) {
        const fp = path.join(RESPONSE_DIR, f);
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > 3600000) fs.unlinkSync(fp);
      }
    } catch {}

    const ts = Date.now();
    const isJson = !!response.json;
    const ext = isJson ? 'json' : 'txt';
    const responseFile = path.join(RESPONSE_DIR, `resp-${ts}.${ext}`);

    const content = isJson
      ? JSON.stringify(response.json, null, 2)
      : response.body;
    fs.writeFileSync(responseFile, content);

    // Build compact metadata response (~100-200 tokens)
    const lines: string[] = [];
    lines.push(`${response.status} ${response.statusText} (${response.duration}ms, ${formatBytes(response.size)})`);
    lines.push(`Response saved: ${responseFile}`);
    lines.push(`Type: ${isJson ? 'JSON' : 'text'} | Size: ${formatBytes(content.length)}`);

    // Include a small preview (first 500 chars) so the agent can often skip reading the file
    const preview = content.slice(0, 500);
    if (content.length <= 500) {
      lines.push(`Content:\n${preview}`);
    } else {
      lines.push(`Preview (first 500 chars):\n${preview}`);
      lines.push(`... use file_read("${responseFile}") or file_read("${responseFile}", { grep: "keyword" }) for full content`);
    }

    // For JSON, also show top-level keys as a structural hint
    if (isJson && typeof response.json === 'object' && response.json !== null) {
      const keys = Object.keys(response.json);
      if (keys.length > 0) {
        lines.push(`Top-level keys: ${keys.slice(0, 20).join(', ')}${keys.length > 20 ? ` ... (${keys.length} total)` : ''}`);
      }
      // If it's an array, show count
      if (Array.isArray(response.json)) {
        lines.push(`Array length: ${response.json.length}`);
      }
    }

    return lines.join('\n');

  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

// ─── API Key Management ───

export function storeApiKey(service: string, key: string): string {
  if (!service || !key) return 'Usage: api-key store <service> <key>';
  const vault = loadVault();
  vault[service] = encryptKey(key);
  saveVault(vault);
  return `API key stored for "${service}" (encrypted)`;
}

export function getApiKey(service: string): string {
  const vault = loadVault();
  const encrypted = vault[service];
  if (!encrypted) return '';
  return decryptKey(encrypted);
}

export function listApiKeys(): string {
  const vault = loadVault();
  const services = Object.keys(vault);
  if (services.length === 0) return 'No API keys stored.';
  return 'Stored API keys:\n' + services.map(s => `  • ${s}`).join('\n');
}

export function deleteApiKey(service: string): string {
  if (!service) return 'Usage: api-key delete <service>';
  const vault = loadVault();
  if (!vault[service]) return `No key found for "${service}"`;
  delete vault[service];
  saveVault(vault);
  return `API key deleted for "${service}"`;
}

// ─── Helpers ───

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
