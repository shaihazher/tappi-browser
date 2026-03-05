/**
 * capture-tools.ts — Phase 8.6 Self-Capture
 *
 * Provides two agent tools:
 *   browser_screenshot — capture tab, window, or full scrollable page
 *   browser_record     — record browser activity as video (capturePage polling → ffmpeg)
 *
 * No new npm deps — uses Electron NativeImage, Node.js fs/child_process, and ffmpeg.
 */

import { BrowserWindow, WebContents, nativeImage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { getWorkspacePath } from './workspace-resolver';

// ─── Paths & Config ───

const FFMPEG_PATH = '/opt/homebrew/bin/ffmpeg';

function getScreenhotsDir(): string { return path.join(getWorkspacePath(), 'screenshots'); }
function getRecordingsDir(): string { return path.join(getWorkspacePath(), 'recordings'); }

function ffmpegAvailable(): boolean {
  try { return fs.existsSync(FFMPEG_PATH); } catch { return false; }
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

const DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads');

function resolvePath(saveTo: string | undefined, defaultDir: string, defaultName: string): string {
  const workspaceDir = getWorkspacePath();
  if (saveTo) {
    const expanded = saveTo.startsWith('~/') ? path.join(os.homedir(), saveTo.slice(2)) : saveTo;
    const resolved = path.resolve(expanded);
    if (!resolved.startsWith(workspaceDir) && !resolved.startsWith(DOWNLOADS_DIR)) {
      throw new Error('Path must be within workspace or downloads directory');
    }
    ensureDir(path.dirname(resolved));
    return resolved;
  }
  ensureDir(defaultDir);
  return path.join(defaultDir, defaultName);
}

// ══════════════════════════════════════════════════════════════
//  8.6.1 — Screenshot Tool
// ══════════════════════════════════════════════════════════════

export interface ScreenshotParams {
  target?: 'window' | 'tab' | 'fullpage';
  saveTo?: string;
  format?: 'png' | 'jpeg';
  quality?: number;
  maxDimension?: number;
}

export interface ScreenshotResult {
  path: string;
  width: number;
  height: number;
  size: number;
}

/**
 * Capture a screenshot of the browser tab, window, or full scrollable page.
 */
export async function captureScreenshot(
  mainWindow: BrowserWindow,
  activeWebContents: WebContents | null,
  params: ScreenshotParams,
): Promise<ScreenshotResult> {
  const target  = params.target  || 'tab';
  const format  = params.format  || 'jpeg';
  const quality = Math.min(100, Math.max(1, params.quality ?? 80));
  const maxDim  = params.maxDimension ?? 1024;
  const ts      = Date.now();

  const defaultName = `capture-${ts}.${format}`;
  const savePath = resolvePath(params.saveTo, getScreenhotsDir(), defaultName);

  if (target === 'fullpage') {
    if (!activeWebContents) throw new Error('No active tab to capture full page of.');
    return captureFullPage(activeWebContents, savePath, format, quality);
  }

  if (!activeWebContents && target === 'tab') throw new Error('No active tab to capture.');

  const MAX_ATTEMPTS = 6;
  const BACKOFF = [100, 300, 600, 1000, 2000, 3000];

  let image: Electron.NativeImage | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      if (target === 'window') {
        image = await mainWindow.capturePage();
      } else {
        image = await activeWebContents!.capturePage();
      }
      const { width, height } = image.getSize();
      if (width > 0 && height > 0) break;
      // 0×0 — page not painted yet, retry
      image = undefined;
      await sleep(BACKOFF[attempt]);
    } catch {
      await sleep(BACKOFF[attempt]);
    }
  }

  // Final attempt if all retries yielded 0×0
  if (!image || image.getSize().width === 0) {
    await sleep(5000);
    image = target === 'window'
      ? await mainWindow.capturePage()
      : await activeWebContents!.capturePage();
  }

  // Downscale if needed
  let { width, height } = image.getSize();
  if (width > maxDim || height > maxDim) {
    image = width >= height
      ? image.resize({ width: maxDim })
      : image.resize({ height: maxDim });
    ({ width, height } = image.getSize());
  }
  const buf = format === 'jpeg' ? image.toJPEG(quality) : image.toPNG();
  fs.writeFileSync(savePath, buf);

  const size = fs.statSync(savePath).size;
  return { path: savePath, width, height, size };
}

/** Scroll-and-stitch fullpage capture. Cap: 20 stitches. */
async function captureFullPage(
  wc: WebContents,
  savePath: string,
  format: string,
  quality: number,
): Promise<ScreenshotResult> {
  const MAX_STITCHES = 20;

  const pageInfo: string = await wc.executeJavaScript(`
    JSON.stringify({
      scrollHeight:    document.documentElement.scrollHeight,
      viewportHeight:  window.innerHeight,
      viewportWidth:   window.innerWidth,
      currentScrollY:  window.scrollY
    })
  `);
  const { scrollHeight, viewportHeight, viewportWidth, currentScrollY } =
    JSON.parse(pageInfo) as { scrollHeight: number; viewportHeight: number; viewportWidth: number; currentScrollY: number };

  const stitchCount = Math.min(MAX_STITCHES, Math.ceil(scrollHeight / viewportHeight));

  // Single viewport — no stitching needed
  if (stitchCount <= 1) {
    const img  = await wc.capturePage();
    const buf  = format === 'jpeg' ? img.toJPEG(quality) : img.toPNG();
    fs.writeFileSync(savePath, buf);
    const { width, height } = img.getSize();
    return { path: savePath, width, height, size: buf.byteLength };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tappi-fp-'));
  const framePaths: string[] = [];

  try {
    for (let i = 0; i < stitchCount; i++) {
      await wc.executeJavaScript(`window.scrollTo(0, ${i * viewportHeight})`);
      await sleep(150);
      const frame     = await wc.capturePage();
      const framePath = path.join(tempDir, `frame_${String(i).padStart(3, '0')}.png`);
      fs.writeFileSync(framePath, frame.toPNG());
      framePaths.push(framePath);
    }
  } finally {
    // Always restore scroll position
    await wc.executeJavaScript(`window.scrollTo(0, ${currentScrollY})`).catch(() => {});
  }

  if (ffmpegAvailable()) {
    const totalHeight = viewportHeight * stitchCount;
    await ffmpegVstack(framePaths, savePath, viewportWidth, totalHeight).catch(async (e) => {
      console.error('[capture] ffmpeg vstack failed, falling back to first frame:', e.message);
      fs.copyFileSync(framePaths[0], savePath);
    });
  } else {
    // Fallback: save frames to a sub-directory and copy first frame as the "output"
    const framesDir = savePath.replace(/\.[^.]+$/, '-frames');
    fs.mkdirSync(framesDir, { recursive: true });
    framePaths.forEach((f, idx) =>
      fs.copyFileSync(f, path.join(framesDir, `frame_${String(idx + 1).padStart(3, '0')}.png`)),
    );
    fs.copyFileSync(framePaths[0], savePath);
    console.log(`[capture] ffmpeg not found — fullpage frames saved in ${framesDir}`);
  }

  // Cleanup temp frames
  framePaths.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  try { fs.rmdirSync(tempDir); } catch {}

  const size = fs.statSync(savePath).size;
  const img  = nativeImage.createFromPath(savePath);
  const { width, height } = img.getSize();
  // Estimate true stitched height if ffmpeg wasn't available
  const realHeight = ffmpegAvailable() ? height : viewportHeight * stitchCount;
  return { path: savePath, width: width || viewportWidth, height: realHeight, size };
}

function ffmpegVstack(frames: string[], outputPath: string, width: number, height: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const inputs: string[] = [];
    frames.forEach(f => inputs.push('-i', f));

    const filterComplex = `${frames.map((_, i) => `[${i}:v]`).join('')}vstack=inputs=${frames.length}[out]`;

    const args = [
      ...inputs,
      '-filter_complex', filterComplex,
      '-map', '[out]',
      '-y',
      outputPath,
    ];

    execFile(FFMPEG_PATH, args, { timeout: 60000 }, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

// ══════════════════════════════════════════════════════════════
//  8.6.2 — Video Recording Tool
// ══════════════════════════════════════════════════════════════

export interface RecordParams {
  action: 'start' | 'stop' | 'status';
  target?: 'window' | 'tab';
  saveTo?: string;
  maxDuration?: number;
  fps?: number;
}

export interface RecordingStatus {
  active: boolean;
  elapsedSeconds?: number;
  fps?: number;
  maxDuration?: number;
  target?: string;
  savePath?: string;
  frameCount?: number;
}

/** Callback fired whenever recording state changes (for UI indicator updates). */
export type RecordingUpdateFn = (status: RecordingStatus) => void;

interface RecordingState {
  active: boolean;
  startTime: number;
  target: 'window' | 'tab';
  savePath: string;
  fps: number;
  maxDuration: number;
  frameCount: number;
  intervalId: ReturnType<typeof setInterval> | null;
  autoStopId: ReturnType<typeof setTimeout> | null;
  tempDir: string;
}

let _recording: RecordingState | null = null;

export function getRecordingStatus(): RecordingStatus {
  if (!_recording) return { active: false };
  return {
    active: true,
    elapsedSeconds: Math.floor((Date.now() - _recording.startTime) / 1000),
    fps: _recording.fps,
    maxDuration: _recording.maxDuration,
    target: _recording.target,
    savePath: _recording.savePath,
    frameCount: _recording.frameCount,
  };
}

/**
 * Handle browser_record tool calls (start / stop / status).
 */
export async function handleRecord(
  mainWindow: BrowserWindow,
  getActiveWC: () => WebContents | null,
  params: RecordParams,
  onUpdate?: RecordingUpdateFn,
): Promise<string> {
  // ── status ─────────────────────────────────────────────────
  if (params.action === 'status') {
    const s = getRecordingStatus();
    if (!s.active) return '📹 No recording in progress.';
    return `🔴 Recording: ${s.elapsedSeconds}s elapsed | ${s.frameCount} frames | fps=${s.fps} | target=${s.target} | save to: ${s.savePath}`;
  }

  // ── start ──────────────────────────────────────────────────
  if (params.action === 'start') {
    if (_recording?.active) {
      const elapsed = Math.floor((Date.now() - _recording.startTime) / 1000);
      return `❌ Recording already in progress (${elapsed}s). Stop it first with action="stop".`;
    }

    const fps         = Math.min(30, Math.max(1, params.fps ?? 15));
    const maxDuration = Math.min(600, Math.max(1, params.maxDuration ?? 300));
    const target      = params.target || 'tab';
    const ts          = Date.now();
    const ext         = ffmpegAvailable() ? 'mp4' : 'mp4'; // always .mp4 extension
    const defaultName = `recording-${ts}.${ext}`;
    const savePath    = resolvePath(params.saveTo, getRecordingsDir(), defaultName);
    const tempDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'tappi-rec-'));

    _recording = {
      active: true,
      startTime: Date.now(),
      target,
      savePath,
      fps,
      maxDuration,
      frameCount: 0,
      intervalId: null,
      autoStopId: null,
      tempDir,
    };

    let frameIndex = 0;

    const captureFrame = async () => {
      if (!_recording?.active) return;
      try {
        let img;
        if (target === 'window') {
          img = await mainWindow.capturePage();
        } else {
          const wc = getActiveWC();
          if (!wc) return;
          img = await wc.capturePage();
        }
        const framePath = path.join(tempDir, `frame_${String(frameIndex).padStart(6, '0')}.png`);
        fs.writeFileSync(framePath, img.toPNG());
        frameIndex++;
        if (_recording) {
          _recording.frameCount = frameIndex;
          // Send UI update once per second
          if (onUpdate && frameIndex % Math.max(1, fps) === 0) {
            onUpdate(getRecordingStatus());
          }
        }
      } catch (e) {
        // Silently skip frame errors (tab might be navigating)
      }
    };

    _recording.intervalId = setInterval(captureFrame, Math.floor(1000 / fps));

    // Auto-stop on maxDuration
    _recording.autoStopId = setTimeout(async () => {
      if (_recording?.active) {
        console.log(`[capture] Max duration ${maxDuration}s reached — auto-stopping.`);
        await stopRecording(onUpdate);
      }
    }, maxDuration * 1000);

    onUpdate?.({ active: true, elapsedSeconds: 0, fps, maxDuration, target, savePath });

    return `🔴 Recording started — target=${target}, fps=${fps}, maxDuration=${maxDuration}s\nFrames → ${tempDir}\nFinal video → ${savePath}`;
  }

  // ── stop ───────────────────────────────────────────────────
  if (params.action === 'stop') {
    if (!_recording?.active) return '📹 No recording in progress.';
    return stopRecording(onUpdate);
  }

  return `❌ Unknown action: ${params.action}`;
}

async function stopRecording(onUpdate?: RecordingUpdateFn): Promise<string> {
  if (!_recording) return '📹 No recording in progress.';

  const state  = _recording;
  _recording   = null;

  if (state.intervalId)  clearInterval(state.intervalId);
  if (state.autoStopId)  clearTimeout(state.autoStopId);

  onUpdate?.({ active: false });

  const elapsed   = Math.floor((Date.now() - state.startTime) / 1000);
  const tempDir   = state.tempDir;
  const savePath  = state.savePath;

  const frameFiles = fs.existsSync(tempDir)
    ? fs.readdirSync(tempDir).filter(f => f.endsWith('.png')).sort().map(f => path.join(tempDir, f))
    : [];

  if (frameFiles.length === 0) {
    return `⚠️ Recording stopped (${elapsed}s) but no frames were captured.`;
  }

  if (ffmpegAvailable()) {
    try {
      await encodeFramesToVideo(frameFiles, savePath, state.fps);
      const size   = fs.statSync(savePath).size;
      const sizeMB = (size / (1024 * 1024)).toFixed(1);
      // Cleanup temp frames
      frameFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
      try { fs.rmdirSync(tempDir); } catch {}
      return `✅ Recording saved: ${savePath}\n   Duration: ${elapsed}s | Frames: ${frameFiles.length} | Size: ${sizeMB} MB`;
    } catch (e: any) {
      return `⚠️ ffmpeg encoding failed: ${e.message}\nFrames preserved in: ${tempDir}`;
    }
  } else {
    // No ffmpeg — move frames to named dir
    const framesDir = savePath.replace(/\.[^.]+$/, '-frames');
    fs.mkdirSync(framesDir, { recursive: true });
    frameFiles.forEach((f, idx) => {
      fs.copyFileSync(f, path.join(framesDir, `frame_${String(idx + 1).padStart(6, '0')}.png`));
      try { fs.unlinkSync(f); } catch {}
    });
    try { fs.rmdirSync(tempDir); } catch {}
    return `✅ Recording stopped (${elapsed}s, ${frameFiles.length} frames)\nFrames saved in: ${framesDir}\n⚠️ ffmpeg not found — install it at /opt/homebrew/bin/ffmpeg to get video output.`;
  }
}

function encodeFramesToVideo(frameFiles: string[], outputPath: string, fps: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // Write a ffmpeg concat file
    const concatPath = path.join(path.dirname(frameFiles[0]), '_concat.txt');
    const duration   = 1 / fps;
    const lines      = frameFiles.map(f => `file '${f}'\nduration ${duration}`).join('\n');
    fs.writeFileSync(concatPath, lines);

    const args = [
      '-f',          'concat',
      '-safe',       '0',
      '-i',          concatPath,
      '-c:v',        'libx264',
      '-pix_fmt',    'yuv420p',
      '-crf',        '23',
      '-preset',     'fast',
      '-y',
      outputPath,
    ];

    execFile(FFMPEG_PATH, args, { timeout: 180_000 }, (err) => {
      try { fs.unlinkSync(concatPath); } catch {}
      if (err) reject(err); else resolve();
    });
  });
}

// ─── Cleanup on app quit ───────────────────────────────────────

export function captureCleanupOnQuit(): void {
  if (_recording) {
    if (_recording.intervalId) clearInterval(_recording.intervalId);
    if (_recording.autoStopId) clearTimeout(_recording.autoStopId);
    const tempDir = _recording.tempDir;
    _recording = null;
    if (tempDir && fs.existsSync(tempDir)) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  }
}

// ─── Utils ──────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
