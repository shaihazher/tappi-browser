/**
 * stream-extractor.ts — yt-dlp wrapper for stream URL extraction.
 *
 * Supports YouTube, Twitch, Vimeo, and generic video pages.
 * Caches extracted URLs per video ID for up to 6 hours.
 * Returns separate video + audio URLs for DASH streams (YouTube).
 */

import { execFile } from 'child_process';
import * as path from 'path';
import * as crypto from 'crypto';

const YTDLP_PATH = '/opt/homebrew/bin/yt-dlp';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export type QualityPreference = 'best' | '1080p' | '720p' | '480p';

export interface StreamInfo {
  videoUrl: string;
  audioUrl?: string;  // separate audio (DASH) — mpv uses --audio-file
  format: string;
  quality: string;
  site: string;
  videoId: string;
  title: string;
  duration?: number;
}

interface CacheEntry {
  info: StreamInfo;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Supported sites for mpv overlay */
export const SUPPORTED_SITES = [
  'youtube.com', 'youtu.be', 'www.youtube.com',
  'twitch.tv', 'www.twitch.tv',
  'vimeo.com', 'www.vimeo.com',
];

/** DRM sites — no stream extraction possible */
export const DRM_SITES = [
  'netflix.com', 'www.netflix.com',
  'primevideo.com', 'www.primevideo.com',
  'disneyplus.com', 'www.disneyplus.com',
  'hbomax.com', 'max.com',
  'hulu.com', 'www.hulu.com',
];

export function isSupportedSite(hostname: string): boolean {
  return SUPPORTED_SITES.some(s => hostname === s || hostname.endsWith('.' + s));
}

export function isDrmSite(hostname: string): boolean {
  return DRM_SITES.some(s => hostname === s || hostname.endsWith('.' + s));
}

function cacheKey(url: string): string {
  return crypto.createHash('md5').update(url).digest('hex');
}

function qualityToFormat(quality: QualityPreference): string {
  switch (quality) {
    case 'best':  return 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best';
    case '1080p': return 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]';
    case '720p':  return 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]';
    case '480p':  return 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]';
    default:      return 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best';
  }
}

function runYtdlp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(YTDLP_PATH, args, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`yt-dlp failed: ${err.message}\n${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function extractStreamUrl(
  pageUrl: string,
  quality: QualityPreference = 'best'
): Promise<StreamInfo> {
  const key = cacheKey(pageUrl + quality);

  // Check cache
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    console.log('[stream-extractor] cache hit:', pageUrl);
    return cached.info;
  }

  const format = qualityToFormat(quality);

  // First get metadata: title, id, duration
  let title = 'Unknown';
  let videoId = key.slice(0, 12);
  let duration: number | undefined;

  try {
    const metaJson = await runYtdlp([
      '--dump-json',
      '--no-download',
      '--quiet',
      pageUrl,
    ]);
    const meta = JSON.parse(metaJson);
    title = meta.title || 'Unknown';
    videoId = meta.id || videoId;
    duration = meta.duration;
  } catch (e) {
    console.warn('[stream-extractor] metadata fetch failed:', e);
  }

  // Get stream URLs with -f format
  let stdout: string;
  try {
    stdout = await runYtdlp([
      '-f', format,
      '-g',             // Print URLs only
      '--no-playlist',
      '--quiet',
      pageUrl,
    ]);
  } catch (e) {
    // Fallback: try best overall
    stdout = await runYtdlp([
      '-f', 'best',
      '-g',
      '--no-playlist',
      '--quiet',
      pageUrl,
    ]);
  }

  const urls = stdout.split('\n').map(u => u.trim()).filter(Boolean);

  let videoUrl: string;
  let audioUrl: string | undefined;

  if (urls.length >= 2) {
    // DASH: first URL is video, second is audio
    videoUrl = urls[0];
    audioUrl = urls[1];
  } else if (urls.length === 1) {
    videoUrl = urls[0];
  } else {
    throw new Error('yt-dlp returned no URLs');
  }

  // Get actual format/quality from yt-dlp
  let qualityStr: string = quality;
  try {
    const fmtOut = await runYtdlp([
      '-f', format,
      '--print', '%(height)sp%(fps)sfps',
      '--no-playlist',
      '--quiet',
      pageUrl,
    ]);
    qualityStr = fmtOut.trim() || quality;
  } catch {}

  // Determine site
  let site = 'generic';
  try {
    const hostname = new URL(pageUrl).hostname;
    if (hostname.includes('youtube') || hostname.includes('youtu.be')) site = 'youtube';
    else if (hostname.includes('twitch')) site = 'twitch';
    else if (hostname.includes('vimeo')) site = 'vimeo';
  } catch {}

  const info: StreamInfo = {
    videoUrl,
    audioUrl,
    format,
    quality: qualityStr,
    site,
    videoId,
    title,
    duration,
  };

  // Cache the result
  cache.set(key, { info, expiresAt: Date.now() + CACHE_TTL_MS });

  return info;
}

export function clearStreamCache(url?: string) {
  if (url) {
    // Clear all entries for this URL
    for (const [q] of [['best'], ['1080p'], ['720p'], ['480p']] as any) {
      cache.delete(cacheKey(url + q));
    }
  } else {
    cache.clear();
  }
}

export function getCacheSize(): number {
  return cache.size;
}
