# Media Playback

Tappi includes an optional media engine that routes video from supported streaming sites through **mpv** — a free, open-source media player — overlaid directly on the browser window.

---

## Overview

When you visit a supported streaming site (YouTube, Twitch, Vimeo), Tappi detects the `<video>` element on the page, extracts the stream URL with **yt-dlp**, and spawns an mpv process positioned exactly over the browser's video element. The result is native-quality playback with hardware acceleration, audio upscaling, and mpv's full keyboard control set — while the surrounding page remains interactive.

**Graceful degradation:** If mpv is not installed, the media engine is disabled silently. Normal browser video playback is unaffected.

---

## Prerequisites

### mpv

Install mpv via Homebrew (macOS):

```bash
brew install mpv
```

Tappi looks for mpv at these paths (in order):
1. `/opt/homebrew/bin/mpv`
2. `/usr/local/bin/mpv`
3. `/usr/bin/mpv`
4. `mpv` (PATH fallback)

### yt-dlp

Install yt-dlp for stream URL extraction:

```bash
brew install yt-dlp
```

Tappi expects yt-dlp at `/opt/homebrew/bin/yt-dlp`.

---

## Supported Sites

| Site | Notes |
|------|-------|
| **YouTube** (`youtube.com`, `youtu.be`) | DASH streams; separate video + audio tracks |
| **Twitch** (`twitch.tv`) | Live and VOD streams |
| **Vimeo** (`vimeo.com`) | Standard video |

> **DRM sites are not supported.** Netflix, Prime Video, Disney+, Max, Hulu, and similar services use Widevine DRM which requires the browser's decryption context — mpv cannot play these streams.

---

## Enabling the Overlay

When you navigate to a supported site and a `<video>` element is detected:

1. The **status bar** at the bottom of the window shows a media indicator.
2. Click the media icon in the status bar (or use the `media:toggle-active` IPC call) to activate the mpv overlay for the current tab.

The mpv window is positioned as a floating, borderless overlay aligned precisely to the video element. It tracks the video element's position and size on scroll, resize, and theater/fullscreen mode changes.

### Tab switching

- When you **switch away** from a tab with an active overlay, the mpv window is hidden.
- When you **switch back**, the mpv window is shown again at the correct position.

### Navigation

Navigating away from a page with an active overlay automatically kills the mpv session and resets the tab's media state.

---

## Quality Selection

yt-dlp extracts streams at your preferred quality. The default is **best** (highest available). You can request specific resolutions:

| Quality | Description |
|---------|-------------|
| `best` | Highest available resolution (default) |
| `1080p` | Full HD |
| `720p` | HD |
| `480p` | SD |

Stream URLs are cached for **6 hours** per video ID to avoid redundant yt-dlp calls.

---

## Keyboard Controls

When the mpv overlay is active and the mpv window has focus, you can use mpv's standard keyboard controls:

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `←` / `→` | Seek back / forward 5 s |
| `↑` / `↓` | Volume up / down |
| `m` | Mute / unmute |
| `f` | Toggle fullscreen |
| `q` | Quit mpv overlay |
| `[` / `]` | Decrease / increase playback speed |
| `9` / `0` | Volume down / up (alternate) |

These are standard mpv keybindings — the full mpv key reference applies.

---

## Architecture Notes

- **Video detection:** The content preload script (`content-preload.js`) monitors `<video>` elements and reports their URL, position, and play state to the main process via IPC.
- **Stream extraction:** `stream-extractor.ts` wraps `yt-dlp` via `execFile`, caches results, and returns separate `videoUrl` + `audioUrl` for DASH streams.
- **IPC transport:** `mpv-ipc.ts` connects to mpv's Unix socket (`/tmp/tappi-mpv-<tabId>.sock`) using JSON-IPC — one JSON object per line.
- **Geometry sync:** On every `resize`, `move`, `scroll`, and theater-mode change, the mpv window is repositioned using mpv's `set_property window-pos` command.

---

## Global Enable / Disable

The media engine can be globally disabled (e.g. for performance or battery reasons) via `media:set-enabled` IPC, which maps to a status bar toggle. Disabling prevents new mpv sessions from starting but does not kill an already-active session.

---

## Related Guides

- [Browsing](browsing.md) — tab management and fullscreen
- [Settings](settings.md) — developer mode and feature toggles
