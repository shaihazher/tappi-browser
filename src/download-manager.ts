/**
 * download-manager.ts — Track and manage file downloads.
 *
 * Hooks into Electron's `will-download` session event.
 * Reports progress back to UI via IPC.
 * Zero tokens — pure Electron API.
 */

import { session, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { recordDownload } from './database';

export interface DownloadItem {
  id: string;
  filename: string;
  url: string;
  savePath: string;
  totalBytes: number;
  receivedBytes: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  startTime: number;
  speed: number; // bytes per second
  item?: Electron.DownloadItem; // live reference
}

const downloads: Map<string, DownloadItem> = new Map();
let downloadCounter = 0;
let mainWindow: BrowserWindow | null = null;
let downloadDir: string;

const DEFAULT_DOWNLOAD_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', 'Downloads');

export function initDownloadManager(window: BrowserWindow, customDir?: string): void {
  mainWindow = window;
  downloadDir = customDir || DEFAULT_DOWNLOAD_DIR;

  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

  session.defaultSession.on('will-download', (_event, item, _webContents) => {
    const id = `dl-${++downloadCounter}`;
    const filename = item.getFilename();
    const safeName = path.basename(filename);
    const savePath = path.join(downloadDir, safeName);

    // Set save path to avoid save dialog
    item.setSavePath(savePath);

    const dl: DownloadItem = {
      id,
      filename,
      url: item.getURL(),
      savePath,
      totalBytes: item.getTotalBytes(),
      receivedBytes: 0,
      state: 'progressing',
      startTime: Date.now(),
      speed: 0,
      item,
    };

    downloads.set(id, dl);
    notifyUI();

    let lastBytes = 0;
    let lastTime = Date.now();

    item.on('updated', (_event, state) => {
      dl.receivedBytes = item.getReceivedBytes();
      dl.totalBytes = item.getTotalBytes();
      dl.state = state === 'interrupted' ? 'interrupted' : 'progressing';

      // Calculate speed
      const now = Date.now();
      const elapsed = (now - lastTime) / 1000;
      if (elapsed > 0.5) {
        dl.speed = Math.round((dl.receivedBytes - lastBytes) / elapsed);
        lastBytes = dl.receivedBytes;
        lastTime = now;
      }

      notifyUI();
    });

    item.once('done', (_event, state) => {
      dl.state = state as 'completed' | 'cancelled' | 'interrupted';
      dl.receivedBytes = item.getReceivedBytes();
      dl.item = undefined; // Release live reference
      notifyUI();

      // Persist to SQLite for agent browse_downloads access
      try {
        recordDownload(filename, dl.url, savePath, dl.receivedBytes, state);
      } catch {}

      console.log(`[download] ${state}: ${filename} (${formatBytes(dl.receivedBytes)})`);
    });

    console.log(`[download] Started: ${filename} → ${savePath}`);
  });
}

function notifyUI(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const active = getActiveDownloads();
  const completed = getCompletedDownloads();

  mainWindow.webContents.send('downloads:updated', {
    active: active.map(d => ({
      id: d.id,
      filename: d.filename,
      totalBytes: d.totalBytes,
      receivedBytes: d.receivedBytes,
      state: d.state,
      speed: d.speed,
      progress: d.totalBytes > 0 ? Math.round((d.receivedBytes / d.totalBytes) * 100) : 0,
    })),
    completedCount: completed.length,
    totalActive: active.length,
  });
}

// ─── Public API ───

export function getActiveDownloads(): DownloadItem[] {
  return [...downloads.values()].filter(d => d.state === 'progressing');
}

export function getCompletedDownloads(): DownloadItem[] {
  return [...downloads.values()].filter(d => d.state === 'completed');
}

export function getAllDownloads(): DownloadItem[] {
  return [...downloads.values()].sort((a, b) => b.startTime - a.startTime);
}

export function cancelDownload(id: string): boolean {
  const dl = downloads.get(id);
  if (!dl || !dl.item) return false;
  dl.item.cancel();
  return true;
}

export function clearCompleted(): void {
  for (const [id, dl] of downloads) {
    if (dl.state !== 'progressing') {
      downloads.delete(id);
    }
  }
  notifyUI();
}

export function getDownloadDir(): string {
  return downloadDir;
}

export function setDownloadDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  downloadDir = dir;
}

export function getDownloadsSummary(): string {
  const active = getActiveDownloads();
  const completed = getCompletedDownloads();

  if (active.length === 0 && completed.length === 0) {
    return 'No downloads.';
  }

  const lines: string[] = [];

  if (active.length > 0) {
    lines.push(`Active downloads (${active.length}):`);
    for (const dl of active) {
      const pct = dl.totalBytes > 0 ? Math.round((dl.receivedBytes / dl.totalBytes) * 100) : 0;
      const speed = dl.speed > 0 ? ` (${formatBytes(dl.speed)}/s)` : '';
      lines.push(`  ⬇ ${dl.filename} — ${pct}%${speed}`);
    }
  }

  if (completed.length > 0) {
    lines.push(`\nCompleted (${completed.length}):`);
    for (const dl of completed.slice(0, 5)) {
      lines.push(`  ✓ ${dl.filename} (${formatBytes(dl.receivedBytes)})`);
    }
    if (completed.length > 5) lines.push(`  ... and ${completed.length - 5} more`);
  }

  lines.push(`\nDownload dir: ${downloadDir}`);
  return lines.join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
