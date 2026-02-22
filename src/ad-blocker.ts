/**
 * ad-blocker.ts — EasyList-based ad blocker using session.webRequest.
 *
 * Downloads EasyList on first run, caches locally, refreshes every 24h.
 * Parses filter rules into a fast lookup structure.
 * Zero tokens — pure Electron API, never hits the LLM.
 */

import { session } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'tldts';

const CACHE_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.tappi-browser', 'cache');
const EASYLIST_PATH = path.join(CACHE_DIR, 'easylist.txt');
const EASYLIST_URL = 'https://easylist.to/easylist/easylist.txt';
const REFRESH_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── Filter structures ───

interface BlockRule {
  pattern: string;
  regex?: RegExp;
  domains?: Set<string>;   // only match on these domains
  excludeDomains?: Set<string>; // don't match on these
}

let blockPatterns: string[] = [];
let blockRegexes: RegExp[] = [];
let domainBlocks: Set<string> = new Set();  // exact domain blocks
let enabled = false;
let blockedCount = 0;
let siteExceptions: Set<string> = new Set();
let requestHandler: ((details: any, callback: any) => void) | null = null;

// Common ad/tracking domains for fast-path blocking
const KNOWN_AD_DOMAINS = new Set([
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'google-analytics.com', 'googletagmanager.com', 'googletagservices.com',
  'facebook.net', 'fbcdn.net', 'connect.facebook.net',
  'amazon-adsystem.com', 'aax.amazon-adsystem.com',
  'ads.yahoo.com', 'adtech.de', 'adnxs.com', 'adsrvr.org',
  'rubiconproject.com', 'pubmatic.com', 'openx.net', 'casalemedia.com',
  'criteo.com', 'criteo.net', 'outbrain.com', 'taboola.com',
  'scorecardresearch.com', 'quantserve.com', 'bluekai.com',
  'moatads.com', 'serving-sys.com', 'advertising.com',
  'adform.net', 'bidswitch.net', 'sharethrough.com',
  'mathtag.com', 'rlcdn.com', 'demdex.net', 'krxd.net',
  'turn.com', 'nexac.com', 'exelator.com',
  'popads.net', 'popcash.net', 'propellerads.com',
  'revcontent.com', 'mgid.com', 'zergnet.com',
]);

// Common tracking URL patterns
const TRACKING_PATTERNS = [
  /\/ads?\//i,
  /\/ad[sv]ert/i,
  /\/tracker\//i,
  /\/tracking\//i,
  /\/pixel\//i,
  /\/beacon\//i,
  /\/analytics\//i,
  /[?&]utm_/i,
  /\/pagead\//i,
  /\/adserver/i,
  /\/doubleclick/i,
  /\/sponsor/i,
  /\/banner[s]?\//i,
  /\/popunder/i,
  /\/popup[s]?\//i,
];

// ─── Core blocker ───

function shouldBlock(url: string, pageUrl?: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    // Site exceptions
    if (pageUrl) {
      try {
        const pageDomain = new URL(pageUrl).hostname;
        if (siteExceptions.has(pageDomain)) return false;
      } catch {}
    }

    // Fast path: known ad domains
    if (KNOWN_AD_DOMAINS.has(hostname)) return true;

    // Check parent domains against known ad list
    const parts = hostname.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      const parent = parts.slice(i).join('.');
      if (KNOWN_AD_DOMAINS.has(parent)) return true;
    }

    // Domain block list from EasyList
    if (domainBlocks.has(hostname)) return true;

    // URL pattern matching
    const fullUrl = url.toLowerCase();
    for (const pattern of TRACKING_PATTERNS) {
      if (pattern.test(fullUrl)) return true;
    }

    // EasyList regex patterns (heavier, checked last)
    for (const regex of blockRegexes) {
      if (regex.test(fullUrl)) return true;
    }

    return false;
  } catch {
    return false;
  }
}

// ─── EasyList parser ───

function parseEasyList(content: string): void {
  const lines = content.split('\n');
  const patterns: string[] = [];
  const domains: string[] = [];
  const regexes: RegExp[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    // Skip comments, empty lines, element hiding rules
    if (!line || line.startsWith('!') || line.startsWith('[') || line.includes('##') || line.includes('#@#') || line.includes('#?#')) continue;

    // Exception rules (@@) — skip for simplicity in v1
    if (line.startsWith('@@')) continue;

    // Domain-only blocks: ||domain.com^
    const domainMatch = line.match(/^\|\|([a-z0-9.-]+)\^$/);
    if (domainMatch) {
      domains.push(domainMatch[1]);
      continue;
    }

    // Simple string patterns (most common)
    if (/^[a-z0-9/._-]+$/i.test(line) && line.length > 4) {
      patterns.push(line.toLowerCase());
      continue;
    }

    // Convert filter syntax to regex (simplified)
    try {
      let regStr = line
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // Escape regex chars
        .replace(/\\\*/g, '.*')                   // * → .*
        .replace(/\\\^/g, '[^a-zA-Z0-9_.%-]')    // ^ → separator
        .replace(/^\\\|\\\|/, '^https?://([a-z0-9.-]*\\.)?') // || → domain anchor
        .replace(/^\\\|/, '^')                    // | at start → start anchor
        .replace(/\\\|$/, '$');                   // | at end → end anchor

      if (regStr.length > 4 && regStr.length < 200) {
        regexes.push(new RegExp(regStr, 'i'));
      }
    } catch {
      // Invalid regex — skip
    }
  }

  blockPatterns = patterns;
  blockRegexes = regexes.slice(0, 5000); // Cap regex count for performance
  domainBlocks = new Set([...KNOWN_AD_DOMAINS, ...domains]);

  console.log(`[ad-blocker] Loaded: ${domainBlocks.size} domain blocks, ${blockPatterns.length} patterns, ${blockRegexes.length} regexes`);
}

// ─── Filter list management ───

async function downloadEasyList(): Promise<string | null> {
  try {
    const response = await fetch(EASYLIST_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(EASYLIST_PATH, text);
    console.log(`[ad-blocker] Downloaded EasyList: ${(text.length / 1024).toFixed(0)} KB`);
    return text;
  } catch (e) {
    console.error('[ad-blocker] Download failed:', e);
    return null;
  }
}

async function loadFilterList(): Promise<void> {
  let content: string | null = null;

  // Try cached file first
  if (fs.existsSync(EASYLIST_PATH)) {
    const stat = fs.statSync(EASYLIST_PATH);
    const age = Date.now() - stat.mtimeMs;
    content = fs.readFileSync(EASYLIST_PATH, 'utf-8');

    // Refresh in background if stale
    if (age > REFRESH_MS) {
      downloadEasyList().then(text => {
        if (text) parseEasyList(text);
      });
    }
  }

  if (!content) {
    content = await downloadEasyList();
  }

  if (content) {
    parseEasyList(content);
  } else {
    // Fallback: just use known ad domains
    console.log('[ad-blocker] Using built-in ad domain list only');
    domainBlocks = new Set(KNOWN_AD_DOMAINS);
  }
}

// ─── Public API ───

export async function startAdBlocker(): Promise<void> {
  if (enabled) return;

  await loadFilterList();

  const ses = session.defaultSession;

  requestHandler = (details: any, callback: any) => {
    // Don't block main frame navigations
    if (details.resourceType === 'mainFrame') {
      callback({ cancel: false });
      return;
    }

    if (shouldBlock(details.url, details.referrer || details.url)) {
      blockedCount++;
      callback({ cancel: true });
    } else {
      callback({ cancel: false });
    }
  };

  ses.webRequest.onBeforeRequest(requestHandler);
  enabled = true;
  console.log(`[ad-blocker] Started (${domainBlocks.size} domains, ${blockRegexes.length} regexes)`);
}

export function stopAdBlocker(): void {
  if (!enabled) return;

  const ses = session.defaultSession;
  // Remove the handler by setting it to null
  ses.webRequest.onBeforeRequest(null as any);
  requestHandler = null;
  enabled = false;
  console.log('[ad-blocker] Stopped');
}

export function isAdBlockerEnabled(): boolean {
  return enabled;
}

export function getBlockedCount(): number {
  return blockedCount;
}

export function resetBlockedCount(): void {
  blockedCount = 0;
}

export function addSiteException(domain: string): void {
  siteExceptions.add(domain);
}

export function removeSiteException(domain: string): void {
  siteExceptions.delete(domain);
}

export function isSiteException(domain: string): boolean {
  return siteExceptions.has(domain);
}

export function getSiteExceptions(): string[] {
  return [...siteExceptions];
}

export function toggleAdBlocker(enable: boolean): void {
  if (enable && !enabled) {
    startAdBlocker();
  } else if (!enable && enabled) {
    stopAdBlocker();
  }
}
