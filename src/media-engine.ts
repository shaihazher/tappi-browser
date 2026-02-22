/**
 * media-engine.ts — Phase 8.5 Media Engine with mpv Overlay Integration.
 *
 * Architecture:
 * - Detects <video> elements in BrowserViews via content-preload.js
 * - Extracts stream URLs via yt-dlp (stream-extractor.ts)
 * - Spawns mpv as a borderless floating window positioned over the video element
 * - Syncs geometry on resize/scroll/fullscreen/theater mode changes
 * - Provides transport control via mpv JSON IPC (mpv-ipc.ts)
 * - Gracefully degrades if mpv is not installed
 */

import { BrowserWindow, BrowserView, ipcMain, screen } from 'electron';
import { spawn, execFile, ChildProcess } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { MpvIPC } from './mpv-ipc';
import { extractStreamUrl, isSupportedSite, isDrmSite, type QualityPreference } from './stream-extractor';

// ─── Config ───

const MPV_PATHS = [
  '/opt/homebrew/bin/mpv',
  '/usr/local/bin/mpv',
  '/usr/bin/mpv',
  'mpv',
];

// ─── Types ───

export interface VideoRect {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

export interface VideoInfo {
  rect: VideoRect;
  url: string;
  site: string;
  hostname: string;
  hasVideo: boolean;
  isPlaying: boolean;
}

export interface MpvSession {
  tabId: string;
  process: ChildProcess;
  ipc: MpvIPC;
  socketPath: string;
  streamInfo: { videoUrl: string; audioUrl?: string; quality: string; title: string };
  lastRect: VideoRect;
  isActive: boolean;
  isPaused: boolean;
  position: number;
  duration: number;
}

interface TabMediaState {
  tabId: string;
  overlayEnabled: boolean;
  videoDetected: boolean;
  videoInfo: VideoInfo | null;
  session: MpvSession | null;
  quality: QualityPreference;
}

// ─── Global State ───

let mpvPath: string | null = null;
let mpvAvailable = false;
let mainWindow: BrowserWindow | null = null;
let getTabView: ((tabId: string) => BrowserView | null) | null = null;
let getActiveTabId: (() => string | null) | null = null;

const tabStates = new Map<string, TabMediaState>();
let globalMediaEnabled = true;

// ─── mpv Detection ───

async function detectMpv(): Promise<string | null> {
  for (const p of MPV_PATHS) {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(p, ['--version'], { timeout: 3000 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      console.log('[media-engine] mpv found at:', p);
      return p;
    } catch {}
  }
  return null;
}

// ─── Initialization ───

export async function initMediaEngine(
  window: BrowserWindow,
  tabViewGetter: (tabId: string) => BrowserView | null,
  activeTabIdGetter: () => string | null,
) {
  mainWindow = window;
  getTabView = tabViewGetter;
  getActiveTabId = activeTabIdGetter;

  // Check mpv availability
  mpvPath = await detectMpv();
  mpvAvailable = !!mpvPath;

  if (!mpvAvailable) {
    console.warn('[media-engine] mpv not found — enhanced media playback disabled');
    console.warn('[media-engine] Install mpv: brew install mpv');
  } else {
    console.log('[media-engine] initialized with mpv at:', mpvPath);
  }

  // Geometry sync on window resize
  window.on('resize', () => {
    const activeId = getActiveTabId?.();
    if (activeId) syncGeometry(activeId);
  });

  window.on('move', () => {
    const activeId = getActiveTabId?.();
    if (activeId) syncGeometry(activeId);
  });

  // Register IPC handlers
  setupIPC();
}

// ─── Tab Media State Management ───

export function initTabMedia(tabId: string) {
  if (!tabStates.has(tabId)) {
    tabStates.set(tabId, {
      tabId,
      overlayEnabled: false,
      videoDetected: false,
      videoInfo: null,
      session: null,
      quality: 'best',
    });
  }
}

export function destroyTabMedia(tabId: string) {
  const state = tabStates.get(tabId);
  if (state) {
    killMpvSession(state);
    tabStates.delete(tabId);
  }
}

export function onTabHidden(tabId: string) {
  const state = tabStates.get(tabId);
  if (state?.session) {
    hideMpvWindow(state.session);
  }
}

export function onTabShown(tabId: string) {
  const state = tabStates.get(tabId);
  if (state?.session && state.session.lastRect.visible) {
    showMpvWindow(state.session);
  }
}

export function onTabNavigated(tabId: string) {
  const state = tabStates.get(tabId);
  if (state) {
    // Kill mpv when navigating away
    killMpvSession(state);
    state.videoDetected = false;
    state.videoInfo = null;
    state.overlayEnabled = false;
    notifyStatusBar();
  }
}

// ─── Video Detection (called from IPC events from content-preload.js) ───

export function handleVideoDetected(tabId: string, videoInfo: VideoInfo) {
  const state = tabStates.get(tabId);
  if (!state) return;

  state.videoDetected = true;
  state.videoInfo = videoInfo;

  console.log(`[media-engine] Video detected in tab ${tabId}: ${videoInfo.url} (${videoInfo.site})`);

  // Notify status bar that media is available
  notifyStatusBar();

  // Auto-activate if global media enabled and site is supported
  if (globalMediaEnabled && mpvAvailable && isSupportedSite(videoInfo.hostname) && !isDrmSite(videoInfo.hostname)) {
    if (!state.session && state.overlayEnabled) {
      activateOverlay(tabId).catch(e => console.error('[media-engine] auto-activate failed:', e));
    }
  }
}

export function handleVideoGeometryChanged(tabId: string, rect: VideoRect) {
  const state = tabStates.get(tabId);
  if (!state?.session) return;

  state.session.lastRect = rect;
  repositionMpv(state.session, tabId, rect);
}

export function handleVideoPlayPause(tabId: string, playing: boolean) {
  const state = tabStates.get(tabId);
  if (!state?.session) return;

  if (playing) {
    state.session.ipc.play().catch(() => {});
  } else {
    state.session.ipc.pause().catch(() => {});
  }
  state.session.isPaused = !playing;
}

export function handleVideoSeeked(tabId: string, position: number) {
  const state = tabStates.get(tabId);
  if (!state?.session) return;

  state.session.ipc.seek(position, 'absolute').catch(() => {});
}

// ─── Overlay Activation/Deactivation ───

export async function activateOverlay(tabId: string): Promise<{ success: boolean; error?: string }> {
  if (!mpvAvailable) {
    return { success: false, error: 'mpv is not installed. Run: brew install mpv' };
  }

  const state = tabStates.get(tabId);
  if (!state) return { success: false, error: 'Tab not found' };

  if (!state.videoInfo) {
    return { success: false, error: 'No video detected on this page' };
  }

  const { hostname, url: pageUrl } = state.videoInfo;

  if (isDrmSite(hostname)) {
    return { success: false, error: 'DRM-protected content — mpv overlay not supported' };
  }

  if (!isSupportedSite(hostname)) {
    return { success: false, error: `Site not supported: ${hostname}` };
  }

  // Kill existing session if any
  if (state.session) {
    killMpvSession(state);
  }

  state.overlayEnabled = true;

  try {
    // Extract stream URL
    console.log('[media-engine] extracting stream for:', pageUrl);
    const streamInfo = await extractStreamUrl(pageUrl, state.quality);
    console.log('[media-engine] stream extracted:', streamInfo.quality);

    // Hide browser's <video> element
    const view = getTabView?.(tabId);
    if (view) {
      view.webContents.executeJavaScript('window.__tappi_hideVideo && window.__tappi_hideVideo()').catch(() => {});
    }

    // Spawn mpv
    const session = await spawnMpv(tabId, streamInfo, state.videoInfo.rect);
    if (!session) {
      return { success: false, error: 'Failed to spawn mpv' };
    }

    state.session = session;
    notifyStatusBar();

    return { success: true };

  } catch (e: any) {
    console.error('[media-engine] activate overlay failed:', e);
    state.overlayEnabled = false;

    // Restore browser video on failure
    const view = getTabView?.(tabId);
    if (view) {
      view.webContents.executeJavaScript('window.__tappi_showVideo && window.__tappi_showVideo()').catch(() => {});
    }

    return { success: false, error: e.message || 'Unknown error' };
  }
}

export function deactivateOverlay(tabId: string) {
  const state = tabStates.get(tabId);
  if (!state) return;

  state.overlayEnabled = false;
  killMpvSession(state);

  // Restore browser's <video>
  const view = getTabView?.(tabId);
  if (view) {
    view.webContents.executeJavaScript('window.__tappi_showVideo && window.__tappi_showVideo()').catch(() => {});
  }

  notifyStatusBar();
}

export function toggleOverlay(tabId: string): Promise<{ success: boolean; active: boolean; error?: string }> {
  const state = tabStates.get(tabId);
  if (!state) return Promise.resolve({ success: false, active: false, error: 'Tab not found' });

  if (state.session) {
    deactivateOverlay(tabId);
    return Promise.resolve({ success: true, active: false });
  } else {
    return activateOverlay(tabId).then(result => ({
      ...result,
      active: result.success,
    }));
  }
}

// ─── mpv Process Management ───

function getMpvSocketPath(tabId: string): string {
  const safe = tabId.replace(/[^a-z0-9]/gi, '_').slice(0, 20);
  return path.join(os.tmpdir(), `tappi-mpv-${safe}.sock`);
}

async function spawnMpv(
  tabId: string,
  streamInfo: { videoUrl: string; audioUrl?: string; quality: string; title: string },
  initialRect: VideoRect,
): Promise<MpvSession | null> {
  if (!mpvPath) return null;

  const socketPath = getMpvSocketPath(tabId);

  // Clean up old socket if exists
  try { fs.unlinkSync(socketPath); } catch {}

  // Compute initial geometry
  const geo = computeMpvGeometry(tabId, initialRect);

  const args: string[] = [
    // IPC
    `--input-ipc-server=${socketPath}`,

    // Video output — reference quality
    '--vo=gpu-next',
    '--gpu-api=auto',
    '--hwdec=auto-safe',
    '--scale=ewa_lanczossharp',
    '--dscale=mitchell',
    '--cscale=ewa_lanczossharp',
    '--interpolation=yes',
    '--tscale=oversample',

    // Audio — SoX resampler + normalization
    '--af=lavfi=[aresample=48000:resampler=soxr]',

    // Window — borderless, on top
    '--no-border',
    '--ontop',
    '--keepaspect=yes',

    // Geometry
    `--geometry=${geo}`,

    // No OSD, no controls (mpv overlay is transparent to user interaction)
    '--osc=no',
    '--osd-level=0',
    '--no-input-default-bindings',
    '--cursor-autohide=always',

    // Playback
    '--loop=no',
    '--pause=no',

    // Audio
    '--volume=100',

    // Stream
    streamInfo.videoUrl,
  ];

  // DASH: add separate audio file
  if (streamInfo.audioUrl) {
    args.push(`--audio-file=${streamInfo.audioUrl}`);
  }

  console.log('[media-engine] spawning mpv...');
  const proc = spawn(mpvPath, args, {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (proc.stdout) {
    proc.stdout.on('data', (d: Buffer) => console.log('[mpv stdout]', d.toString().trim()));
  }
  if (proc.stderr) {
    proc.stderr.on('data', (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) console.log('[mpv stderr]', msg);
    });
  }

  proc.on('exit', (code, signal) => {
    console.log(`[media-engine] mpv exited (code=${code}, signal=${signal}) for tab ${tabId}`);
    const state = tabStates.get(tabId);
    if (state?.session?.process === proc) {
      state.session = null;
      state.overlayEnabled = false;
      notifyStatusBar();

      // Restore browser video
      const view = getTabView?.(tabId);
      if (view) {
        view.webContents.executeJavaScript('window.__tappi_showVideo && window.__tappi_showVideo()').catch(() => {});
      }
    }
  });

  // Wait for mpv to create the socket
  const ipc = new MpvIPC(socketPath);
  const connected = await waitForSocket(ipc, socketPath, 10000);

  if (!connected) {
    console.error('[media-engine] mpv IPC connect timeout');
    proc.kill('SIGTERM');
    return null;
  }

  // Observe playback events
  try {
    await ipc.observeProperty(1, 'pause');
    await ipc.observeProperty(2, 'time-pos');
    await ipc.observeProperty(3, 'duration');
  } catch (e) {
    console.warn('[media-engine] observe failed:', e);
  }

  const session: MpvSession = {
    tabId,
    process: proc,
    ipc,
    socketPath,
    streamInfo,
    lastRect: initialRect,
    isActive: true,
    isPaused: false,
    position: 0,
    duration: 0,
  };

  // Handle property change events
  ipc.on('event', (msg: any) => {
    if (msg.event === 'property-change') {
      if (msg.name === 'pause') session.isPaused = !!msg.data;
      if (msg.name === 'time-pos' && typeof msg.data === 'number') session.position = msg.data;
      if (msg.name === 'duration' && typeof msg.data === 'number') session.duration = msg.data;
    }
    if (msg.event === 'end-file') {
      console.log('[media-engine] mpv end-file:', msg.reason);
    }
  });

  return session;
}

async function waitForSocket(ipc: MpvIPC, socketPath: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Wait for socket file to appear
    if (fs.existsSync(socketPath)) {
      try {
        await ipc.connect();
        return true;
      } catch (e) {
        // Not ready yet
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

function killMpvSession(state: TabMediaState) {
  if (!state.session) return;

  const session = state.session;
  state.session = null;

  try {
    session.ipc.quit().catch(() => {});
    session.ipc.destroy();
  } catch {}

  try {
    if (!session.process.killed) {
      session.process.kill('SIGTERM');
      setTimeout(() => {
        try {
          if (!session.process.killed) session.process.kill('SIGKILL');
        } catch {}
      }, 2000);
    }
  } catch {}

  // Clean up socket file
  try { fs.unlinkSync(session.socketPath); } catch {}
}

// ─── Geometry Sync ───

function computeMpvGeometry(tabId: string, rect: VideoRect): string {
  if (!mainWindow || !getTabView) {
    return `${rect.width}x${rect.height}+0+0`;
  }

  const view = getTabView(tabId);
  const viewBounds = view ? view.getBounds() : { x: 0, y: 0 };
  const contentBounds = mainWindow.getContentBounds();

  // Absolute screen coordinates
  const screenX = contentBounds.x + viewBounds.x + Math.round(rect.x);
  const screenY = contentBounds.y + viewBounds.y + Math.round(rect.y);
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));

  return `${w}x${h}+${screenX}+${screenY}`;
}

function repositionMpv(session: MpvSession, tabId: string, rect: VideoRect) {
  if (!session.ipc.isConnected()) return;

  if (!rect.visible || rect.width < 10 || rect.height < 10) {
    hideMpvWindow(session);
    return;
  }

  showMpvWindow(session);

  const geo = computeMpvGeometry(tabId, rect);

  // Use mpv's set_property for geometry (requires mpv 0.34+ with libmpv)
  // Fallback: use window-pos and window-size properties
  try {
    if (!mainWindow || !getTabView) return;
    const view = getTabView(tabId);
    const viewBounds = view ? view.getBounds() : { x: 0, y: 0 };
    const contentBounds = mainWindow.getContentBounds();

    const screenX = contentBounds.x + viewBounds.x + Math.round(rect.x);
    const screenY = contentBounds.y + viewBounds.y + Math.round(rect.y);
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));

    // Set position and size via IPC
    session.ipc.setProperty('window-pos', `${screenX}:${screenY}`).catch(() => {});
    session.ipc.command('set_property', 'dwidth', w).catch(() => {});
    session.ipc.command('set_property', 'dheight', h).catch(() => {});
  } catch (e) {
    console.warn('[media-engine] reposition failed:', e);
  }
}

function syncGeometry(tabId: string) {
  const state = tabStates.get(tabId);
  if (!state?.session || !state.videoInfo) return;

  // Re-fetch video rect from page
  const view = getTabView?.(tabId);
  if (!view) return;

  view.webContents.executeJavaScript('window.__tappi_detectVideo && window.__tappi_detectVideo()')
    .then((result: any) => {
      if (!result) return;
      let info: VideoInfo;
      try { info = typeof result === 'string' ? JSON.parse(result) : result; }
      catch { return; }

      if (!info.hasVideo || !info.rect) return;
      const state2 = tabStates.get(tabId);
      if (!state2?.session) return;

      state2.session.lastRect = info.rect;
      repositionMpv(state2.session, tabId, info.rect);
    }).catch(() => {});
}

function hideMpvWindow(session: MpvSession) {
  if (!session.ipc.isConnected()) return;
  session.ipc.setProperty('window-minimized', true).catch(() => {});
}

function showMpvWindow(session: MpvSession) {
  if (!session.ipc.isConnected()) return;
  session.ipc.setProperty('window-minimized', false).catch(() => {});
}

// ─── Status Bar ───

function notifyStatusBar() {
  if (!mainWindow) return;

  const activeId = getActiveTabId?.();
  if (!activeId) return;

  const state = tabStates.get(activeId);
  const hasVideo = state?.videoDetected ?? false;
  const overlayActive = !!(state?.session);

  try {
    mainWindow.webContents.send('media:status', {
      hasVideo,
      overlayActive,
      mpvAvailable,
      quality: state?.quality || 'best',
    });
  } catch {}
}

// ─── Transport Controls ───

export async function mediaPlay(tabId: string): Promise<string> {
  const state = tabStates.get(tabId);
  if (!state?.session) return 'No mpv session active';
  await state.session.ipc.play();
  return 'Playing';
}

export async function mediaPause(tabId: string): Promise<string> {
  const state = tabStates.get(tabId);
  if (!state?.session) return 'No mpv session active';
  await state.session.ipc.pause();
  return 'Paused';
}

export async function mediaSeek(tabId: string, position: number): Promise<string> {
  const state = tabStates.get(tabId);
  if (!state?.session) return 'No mpv session active';
  const mode = position >= 0 && position <= 1 && position !== 0 ? 'absolute-percent' : 'absolute';
  if (mode === 'absolute-percent') {
    await state.session.ipc.command('seek', position * 100, 'absolute-percent');
  } else {
    await state.session.ipc.seek(position, 'absolute');
  }
  return `Seeked to ${position}`;
}

export async function mediaVolume(tabId: string, vol: number): Promise<string> {
  const state = tabStates.get(tabId);
  if (!state?.session) return 'No mpv session active';
  await state.session.ipc.setVolume(vol);
  return `Volume: ${vol}`;
}

export async function mediaStatus(tabId: string): Promise<object> {
  const state = tabStates.get(tabId);
  if (!state) return { error: 'Tab not found' };

  const session = state.session;
  let position = session?.position ?? 0;
  let duration = session?.duration ?? 0;

  // Try fresh values from IPC
  if (session?.ipc.isConnected()) {
    try {
      position = await session.ipc.getProperty('time-pos') ?? position;
      duration = await session.ipc.getProperty('duration') ?? duration;
    } catch {}
  }

  return {
    mpvAvailable,
    overlayActive: !!session,
    videoDetected: state.videoDetected,
    playing: session ? !session.isPaused : false,
    position,
    duration,
    quality: session?.streamInfo.quality ?? state.quality,
    title: session?.streamInfo.title ?? '',
    site: state.videoInfo?.site ?? '',
  };
}

export function setQuality(tabId: string, quality: QualityPreference) {
  const state = tabStates.get(tabId);
  if (!state) return;
  state.quality = quality;
}

export function setGlobalMediaEnabled(enabled: boolean) {
  globalMediaEnabled = enabled;
  if (!enabled) {
    // Kill all active sessions
    for (const [tabId, state] of tabStates) {
      if (state.session) {
        deactivateOverlay(tabId);
      }
    }
  }
}

export function isMediaEngineAvailable(): boolean {
  return mpvAvailable;
}

// ─── IPC Setup ───

function setupIPC() {
  // Video detected from content-preload
  ipcMain.on('media:video-detected', (_e, data: { tabId: string; videoInfo: VideoInfo }) => {
    handleVideoDetected(data.tabId, data.videoInfo);
  });

  // Geometry change from ResizeObserver/MutationObserver
  ipcMain.on('media:geometry-changed', (_e, data: { tabId: string; rect: VideoRect }) => {
    handleVideoGeometryChanged(data.tabId, data.rect);
  });

  // Play/pause from YouTube player interception
  ipcMain.on('media:play-pause', (_e, data: { tabId: string; playing: boolean }) => {
    handleVideoPlayPause(data.tabId, data.playing);
  });

  // Seek event from YouTube player
  ipcMain.on('media:seeked', (_e, data: { tabId: string; position: number }) => {
    handleVideoSeeked(data.tabId, data.position);
  });

  // Toggle overlay (from status bar click or settings)
  ipcMain.handle('media:toggle', async (_e, tabId: string) => {
    return toggleOverlay(tabId);
  });

  // Get status
  ipcMain.handle('media:status', async (_e, tabId: string) => {
    return mediaStatus(tabId);
  });

  // Set quality
  ipcMain.on('media:set-quality', (_e, tabId: string, quality: QualityPreference) => {
    setQuality(tabId, quality);
  });

  // Global enable/disable
  ipcMain.on('media:set-enabled', (_e, enabled: boolean) => {
    setGlobalMediaEnabled(enabled);
  });

  // Transport controls
  ipcMain.handle('media:play', async (_e, tabId: string) => mediaPlay(tabId));
  ipcMain.handle('media:pause', async (_e, tabId: string) => mediaPause(tabId));
  ipcMain.handle('media:seek', async (_e, tabId: string, pos: number) => mediaSeek(tabId, pos));
  ipcMain.handle('media:volume', async (_e, tabId: string, vol: number) => mediaVolume(tabId, vol));
}
