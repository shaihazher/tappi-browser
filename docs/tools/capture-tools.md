# Capture Tools

Tools for taking screenshots and recording browser activity as video. Screenshots are saved to `~/tappi-workspace/screenshots/` and recordings to `~/tappi-workspace/recordings/` by default.

> **Note:** `browser_record_start` / `browser_record_stop` are exposed via the unified `browser_record` tool (action: `start` | `stop` | `status`). Both are documented here for clarity.

---

## `browser_screenshot`

Capture a screenshot of the current browser tab, the full Electron window, or a full scrollable page (stitched from multiple viewport captures).

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `target` | `string` | ❌ | What to capture: `"tab"` (default) — the active web tab; `"window"` — the entire Electron window including the UI chrome; `"fullpage"` — scrolls and stitches the full page height. |
| `saveTo` | `string` | ❌ | Custom file path to save the image. Supports `~/`. Default: `~/tappi-workspace/screenshots/capture-{timestamp}.png`. |
| `format` | `string` | ❌ | Image format: `"png"` (default) or `"jpeg"`. |
| `quality` | `number` | ❌ | JPEG quality from 1 to 100 (default: 90). Only applies when `format` is `"jpeg"`. |

### Returns

A confirmation string with the saved path, dimensions, and file size.

```
✅ Screenshot saved: /Users/you/tappi-workspace/screenshots/capture-1705000000.png (1440×900, 312.4 KB)
```

On failure (e.g. a system dialog is blocking rendering):

```
❌ Screenshot failed: Cannot capture screenshot — a dialog may be blocking the page (captured 0×0 image)
```

### Full-page stitching

When `target` is `"fullpage"`, Tappi scrolls through the page in viewport-sized increments (max 20), capturing each viewport and stitching them into a single tall image using `ffmpeg`. If ffmpeg is not available at `/opt/homebrew/bin/ffmpeg`, individual frame PNGs are saved to a `-frames/` subfolder instead.

### Example — full-page screenshot

```json
{
  "target": "fullpage",
  "saveTo": "~/tappi-workspace/page-export.png"
}
```

### Example — JPEG tab screenshot

```json
{
  "target": "tab",
  "format": "jpeg",
  "quality": 85
}
```

---

## `browser_record_start`

> **Tool name:** `browser_record` with `action: "start"`

Start recording the browser as an MP4 video. Tappi polls `capturePage` at the specified FPS, accumulates PNG frames, and encodes them to H.264 MP4 via ffmpeg when stopped. Only one recording can run at a time.

A `🔴 REC` indicator with elapsed time is shown in the status bar while recording.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | `"start"` | ✅ | Must be `"start"`. |
| `target` | `string` | ❌ | What to record: `"tab"` (default) or `"window"`. |
| `saveTo` | `string` | ❌ | Output file path (default: `~/tappi-workspace/recordings/recording-{timestamp}.mp4`). |
| `maxDuration` | `number` | ❌ | Maximum recording duration in seconds before auto-stop (default: 300, max: 600). |
| `fps` | `number` | ❌ | Frame rate from 1 to 30 (default: 15). |

### Returns

```
🔴 Recording started — target=tab, fps=15, maxDuration=300s
Frames → /tmp/tappi-rec-abc123
Final video → /Users/you/tappi-workspace/recordings/recording-1705000000.mp4
```

### Example

```json
{
  "action": "start",
  "target": "tab",
  "fps": 24,
  "maxDuration": 60,
  "saveTo": "~/tappi-workspace/demo.mp4"
}
```

---

## `browser_record_stop`

> **Tool name:** `browser_record` with `action: "stop"`

Stop an active recording. Tappi encodes all buffered frames into an MP4 via ffmpeg. If ffmpeg is not available, the raw PNG frames are preserved in a subfolder.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | `"stop"` | ✅ | Must be `"stop"`. |

### Returns

```
✅ Recording saved: /Users/you/tappi-workspace/recordings/recording-1705000000.mp4
   Duration: 58s | Frames: 870 | Size: 12.3 MB
```

If ffmpeg is missing:

```
✅ Recording stopped (58s, 870 frames)
Frames saved in: /Users/you/tappi-workspace/recordings/recording-1705000000-frames
⚠️ ffmpeg not found — install it at /opt/homebrew/bin/ffmpeg to get video output.
```

### Example

```json
{
  "action": "stop"
}
```

---

## `browser_record` — status

Check the current recording state without starting or stopping.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | `"status"` | ✅ | Must be `"status"`. |

### Returns

```
🔴 Recording: 42s elapsed | 630 frames | fps=15 | target=tab | save to: /Users/you/tappi-workspace/recordings/recording-1705000000.mp4
```

Or `📹 No recording in progress.`

---

## See Also

- [`file_read`](./file-tools.md#file_read) — read or search files in the screenshots/recordings directory
- [`media_play`](./media-tools.md#media_play) — control video playback before capturing
- [`exec`](./shell-tools.md#exec) — post-process recordings with ffmpeg via the shell
