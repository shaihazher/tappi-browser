# Page Tools

Page tools interact with the content of the current web tab. They operate via JavaScript injected into the page through Electron's `executeJavaScript`, using the `window.__tappi` preload API for DOM access. Shadow DOM is pierced automatically.

All page tools target the **active web tab** — the Aria (agent) panel tab is never targeted.

---

## `elements`

Index interactive elements on the page.

**Description:** Returns a numbered list of interactive elements in the viewport. Use `grep` to search *all* elements (including offscreen) by text, without the viewport cap.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filter` | string | No | CSS selector to scope indexing |
| `grep` | string | No | Search all elements (incl. offscreen) for this text |

**Returns:** Newline-separated list of `[index] (type) label` entries.

**Example output:**
```
[0] (button) Sign in
[1] (input) Email address
[2] (input) Password
[3] (checkbox) Remember me
(2 offscreen — use elements({ grep: "..." }) to search)
```

**Behavior notes:**
- Hard cap: 50 elements per call (enforced by preload).
- `grep` disables the viewport cap and searches all interactive elements.
- Dialog overlays are flagged with `[Dialog active]` at the top.
- Use `filter` with a CSS selector to scope to a specific region of the page.

---

## `click`

Click an element by its index from the elements list.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `index` | number | Yes | Element index from `elements` output |

**Returns:** Confirmation string or error.

**Example:**
```
// After elements() shows [0] (button) Sign in
click({ index: 0 })
→ Clicked [0] (button) Sign in
```

**Notes:** Uses JavaScript `.click()` via preload (more reliable than `sendInputEvent` for SPAs). Waits 150ms after click for state changes.

---

## `type`

Type text into an input or textarea by index. Clears existing content first.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `index` | number | Yes | Element index |
| `text` | string | Yes | Text to type |

**Returns:** Confirmation or error.

**Notes:** Clears the field before typing. For long content (>100 chars), prefer `paste` — it's more reliable.

---

## `paste`

Paste text into an element by index. Uses the OS clipboard.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `index` | number | Yes | Element index |
| `content` | string | Yes | Text to paste |

**Returns:** Confirmation or error.

**Notes:** More reliable than `type` for long content, multi-line text, or rich text editors. Writes to the clipboard then triggers a paste event.

---

## `focus`

Focus an element by index without clicking it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `index` | number | Yes | Element index |

**Returns:** Confirmation or error.

**Notes:** Useful for revealing autocomplete dropdowns, tooltip states, or triggering focus-dependent CSS without a click.

---

## `check`

Read the current state of an element: value, checked state, disabled state, focused state.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `index` | number | Yes | Element index |

**Returns:** State object as string: `value`, `checked`, `disabled`, `focused`.

**Example:**
```
check({ index: 2 })
→ { value: "user@example.com", checked: false, disabled: false, focused: true }
```

---

## `text`

Extract text from the page.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `selector` | string | No | CSS selector to scope extraction |
| `grep` | string | No | Search page text for this string; returns matching passages |

**Returns:**
- Default (no params): ~1.5 KB of visible page text.
- With `selector`: up to 4 KB from the selected element.
- With `grep`: matching lines with surrounding context.

**Example:**
```
text({ grep: "privacy policy" })
→ Found 3 matches:
  Line 142: "See our Privacy Policy for details."
  Line 891: "Privacy Policy | Terms of Service"
  Line 1204: "By clicking Accept, you agree to our Privacy Policy."
```

---

## `scroll`

Scroll the page.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `direction` | `"up"` \| `"down"` \| `"top"` \| `"bottom"` | Yes | Scroll direction |
| `amount` | number | No | Pixels to scroll (default: 500) |

**Returns:** Confirmation string.

**Example:**
```
scroll({ direction: "down", amount: 1000 })
scroll({ direction: "top" })
```

---

## `keys`

Send keyboard input to the page.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sequence` | string \| string[] | Yes | Key combo or array of actions |

**Returns:** Confirmation or error.

**Key names:** `enter`, `tab`, `escape`, `backspace`, `up`, `down`, `left`, `right`, `space`.  
**Combos:** `ctrl+c`, `cmd+b`, `shift+enter`, `ctrl+shift+z`.

**Examples:**
```
keys({ sequence: "enter" })
keys({ sequence: "ctrl+a" })
keys({ sequence: ["tab", "tab", "enter"] })
keys({ sequence: "cmd+shift+k" })
```

**Notes:** Essential for canvas apps (Google Sheets, Figma, VS Code web) where `click`/`type` don't work. Use arrays for sequences.

---

## `eval_js`

Execute arbitrary JavaScript in the page context.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `js` | string | Yes | JavaScript code to execute |

**Returns:** The return value of the expression as a string, or an error.

**Examples:**
```
eval_js({ js: "document.title" })
→ "My Dashboard — Acme Corp"

eval_js({ js: "document.querySelectorAll('a').length" })
→ 47

eval_js({ js: "window.scrollY" })
→ 1240
```

**Notes:** Has full access to `document`, `window`, and the page's global scope. Use for inspection, state mutation, or accessing page APIs not reachable through other tools.

---

## `screenshot`

Save a screenshot of the current page to a file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | No | Path to save PNG (default: temp directory) |

**Returns:** File path where the screenshot was saved.

**Notes:** This is the lightweight page-level screenshot. For more options (window, full-page, JPEG, video recording), use [`browser_screenshot`](capture-tools.md) and [`browser_record`](capture-tools.md).

---

## `click_xy`

Click at specific pixel coordinates.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `x` | number | Yes | X coordinate (pixels from left) |
| `y` | number | Yes | Y coordinate (pixels from top) |

**Returns:** Confirmation string.

**Notes:** Use as a fallback when `elements` doesn't index the target (e.g. canvas elements, custom widgets). Coordinates are relative to the tab's viewport.

---

## `hover_xy`

Hover at specific pixel coordinates without clicking.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `x` | number | Yes | X coordinate |
| `y` | number | Yes | Y coordinate |

**Returns:** Confirmation string.

**Notes:** Triggers CSS `:hover` states, tooltips, and hover-to-reveal dropdowns. Use `click_xy` after hovering if a menu appears.

---

## `wait`

Wait for a specified number of milliseconds.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ms` | number | Yes | Milliseconds to wait |

**Returns:** Confirmation string.

**Notes:** Use sparingly. Prefer re-running `elements` or `text` to detect readiness rather than arbitrary waits. Useful after triggering animations or waiting for a rate-limited API response.

---

## See Also

- [Browser Tools](browser-tools.md) — navigate, search, tab management
- [Capture Tools](capture-tools.md) — full browser screenshots and video recording
- [Tool Overview](overview.md)
