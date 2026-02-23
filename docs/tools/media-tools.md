# Media Tools

Tools for controlling the **mpv media overlay** — Tappi's enhanced video playback engine. When a supported video is detected (YouTube, Vimeo, etc.), Tappi can spawn an mpv window positioned over the browser's `<video>` element for reference-quality playback with hardware decoding.

> **Requires mpv.** Install with `brew install mpv`. If mpv is not installed, tools will return graceful errors. DRM-protected sites (Netflix, Disney+, etc.) are not supported.

All transport tools operate on the **active tab's** mpv session. Use `media_status` first to confirm a session is active.

---

## `media_play`

Resume playback on the active tab's mpv session.

### Parameters

None.

### Returns

```
Playing
```

Or `No mpv session active` if no overlay is running on the current tab.

### Example

```json
{}
```

---

## `media_status`

Get the current playback state of the active tab's mpv session, including position, duration, quality, and whether an overlay is active.

### Parameters

None.

### Returns

A JSON object with the following fields:

| Field | Type | Description |
|-------|------|-------------|
| `mpvAvailable` | `boolean` | Whether mpv is installed and usable. |
| `overlayActive` | `boolean` | Whether an mpv session is currently running. |
| `videoDetected` | `boolean` | Whether a video element was found on the page. |
| `playing` | `boolean` | Whether playback is currently active (not paused). |
| `position` | `number` | Current playback position in seconds. |
| `duration` | `number` | Total duration in seconds (0 if unknown). |
| `quality` | `string` | Active quality preference (e.g. `"best"`, `"1080p"`). |
| `title` | `string` | Video title (from yt-dlp metadata). |
| `site` | `string` | Source site (e.g. `"youtube"`, `"vimeo"`). |

### Example

```json
{}
```

---

## `media_toggle`

Toggle the mpv overlay on or off for the active tab. If no session is running, activates one (extracts stream via yt-dlp and spawns mpv). If a session is active, deactivates it and restores the browser's native `<video>` element.

### Parameters

None.

### Returns

```json
{ "success": true, "active": true }
```

Or on failure:

```json
{ "success": false, "active": false, "error": "DRM-protected content — mpv overlay not supported" }
```

### Example

```json
{}
```

---

## `media_quality`

Set the preferred stream quality for the active tab. Takes effect on the **next** overlay activation (does not restart a running session).

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `quality` | `string` | ✅ | Quality preference: `"best"`, `"1080p"`, `"720p"`, `"480p"`, `"worst"`. |

### Returns

No return value (sets state silently). Use `media_status` to confirm.

### Example

```json
{
  "quality": "1080p"
}
```

---

## `media_seek`

Seek to a specific position in the currently playing video.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `position` | `number` | ✅ | Target position. Values between 0 and 1 (exclusive, non-zero) are treated as a **percentage** of total duration. All other values are treated as an **absolute time in seconds**. |

### Returns

```
Seeked to 120
```

### Example — seek to 2 minutes

```json
{
  "position": 120
}
```

### Example — seek to 50% through

```json
{
  "position": 0.5
}
```

---

## `media_volume`

Set the playback volume of the active mpv session.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `volume` | `number` | ✅ | Volume level from `0` (mute) to `100` (full). Values above 100 enable software amplification. |

### Returns

```
Volume: 80
```

### Example

```json
{
  "volume": 60
}
```

---

## `media_stop`

Stop playback and deactivate the mpv overlay, restoring the browser's native `<video>` element. Equivalent to `media_toggle` when the overlay is active.

### Parameters

None.

### Returns

```
No mpv session active
```

Or confirmation that the session was stopped and the browser video restored.

### Example

```json
{}
```

---

## See Also

- [`browser_screenshot`](./capture-tools.md#browser_screenshot) — capture the current tab while media is playing
- [`browser_record_start`](./capture-tools.md#browser_record_start) — record media playback as video
