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
- **Canvas apps** (Google Sheets, Docs, Figma): Automatically detects accessibility overlays and harvests toolbar buttons, menu items, formula bar inputs, and sheet tabs. These appear as normal indexed elements. App-specific keyboard shortcut hints are appended at the bottom of the output.

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

**Notes:** Essential for canvas apps (Google Sheets, Figma, VS Code web) where `click`/`type` don't work on the canvas surface. Use arrays for sequences.

**Canvas app shortcuts (quick reference):**

| App | Navigate | Edit | Select | Common |
|-----|----------|------|--------|--------|
| **Sheets** | Arrow keys, Ctrl+G (go to), Tab | F2 (edit cell), Enter (confirm) | Shift+arrows, Ctrl+A | Ctrl+C/V/X/Z/Y |
| **Docs** | Ctrl+Home/End, Ctrl+G | Just type, Ctrl+B/I/U | Shift+arrows, Ctrl+A | Ctrl+Z/Y, Ctrl+K (link) |
| **Figma** | Click canvas, Tab/Shift+Tab (siblings) | V/R/T/P (tools), Enter (child), Esc (parent) | Shift+click, Ctrl+A | Ctrl+D (dup), Ctrl+G (group) |
| **Excalidraw** | Click canvas, Space+drag (pan) | 1-8 (tools), double-click (edit text) | Shift+click, Ctrl+A | Ctrl+D (dup), Delete |

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

**Notes:** Use for canvas elements (Sheets cells, Figma objects, Maps locations) or when `elements` doesn't index the target. Coordinates are relative to the tab's viewport. Take a `screenshot` first to determine coordinates.

---

## `double_click_xy`

Double-click at specific pixel coordinates.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `x` | number | Yes | X coordinate (pixels from left) |
| `y` | number | Yes | Y coordinate (pixels from top) |

**Returns:** Confirmation string.

**Essential for canvas apps:**
- **Google Sheets:** Double-click a cell to enter edit mode (then type content, press Enter).
- **Figma:** Double-click to enter a group or edit text content.
- **Google Maps:** Double-click to zoom in at a location.
- **Excalidraw:** Double-click a shape to edit its text.

**Example workflow (Sheets):**
```
screenshot()                    → See the spreadsheet
double_click_xy({ x: 200, y: 150 })  → Enter cell edit mode
keys({ sequence: ["ctrl+a", "delete"] }) → Clear cell
keys({ sequence: "Hello World" })        → Type new content (won't work — use next line)
// For typing text into a canvas cell, use keys() with individual characters
// or the formula bar (which IS a DOM element — use type() on it)
keys({ sequence: "enter" })              → Confirm and move to next row
```

---

## `right_click_xy`

Right-click at specific pixel coordinates to open a context menu.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `x` | number | Yes | X coordinate (pixels from left) |
| `y` | number | Yes | Y coordinate (pixels from top) |

**Returns:** Confirmation string.

**Notes:** After right-clicking, call `elements()` to see the context menu items — they appear as regular DOM elements. Useful for canvas apps (Sheets cell options, Figma object menu) and any page with custom context menus.

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

---

## Working with Canvas Apps

Canvas-based web apps (Google Sheets, Figma, Excalidraw, Maps) render their main content on `<canvas>` or WebGL — meaning the interactive surface isn't made of DOM elements. Tappi handles this with a layered approach:

### Layer 1: Accessibility Overlays (automatic)

Many canvas apps render invisible DOM overlays for screen readers. `elements()` automatically detects and harvests these:

- **Google Sheets:** Toolbar buttons, menu bar, formula bar, sheet tabs
- **Google Docs:** Toolbar, menu bar, document editing surface
- **Figma:** Toolbar, property panels, layer tree

These appear as regular indexed elements — click/type them normally.

### Layer 2: Keyboard Shortcuts (primary interaction)

For the canvas surface itself, keyboard shortcuts are the most reliable interaction method. When `elements()` detects a canvas app, it appends a shortcut reference at the bottom of its output.

**General workflow:**
1. Call `elements()` — see indexed DOM elements + shortcut hints
2. Use `keys()` for canvas interaction (navigation, editing, tool selection)
3. Use `screenshot()` when you need to see the visual state

### Layer 3: Coordinate-Based Interaction (visual fallback)

When keyboard shortcuts aren't enough:
1. `screenshot()` — see what's on the canvas
2. `click_xy()` — click a specific location
3. `double_click_xy()` — enter edit mode (Sheets cells, Figma text, etc.)
4. `right_click_xy()` — open context menus, then `elements()` to see menu items

### Example: Editing a Google Sheets Cell

```
elements()          → See toolbar, formula bar, sheet tabs + shortcut hints
screenshot()        → See the cell grid visually
click_xy(200, 150)  → Select cell at those coordinates
keys("f2")          → Enter edit mode (or double_click_xy)
keys("Hello")       → Won't work for text — use the formula bar instead:
  elements()        → Find the formula bar input
  type(N, "Hello")  → Type into the formula bar by index
  keys("enter")     → Confirm the cell value
```

### Example: Working in Figma

```
elements()                  → See toolbar buttons, panels, layers
screenshot()                → See the design canvas
keys("v")                   → Switch to Move tool
click_xy(400, 300)          → Select an object on canvas
keys("enter")               → Enter the group
double_click_xy(400, 300)   → Edit text content
keys(["ctrl+a", "delete"])  → Clear text
keys("New label text")      → Type (in active text edit mode)
keys("escape")              → Exit text edit, back to selection
```

---

## See Also

- [Browser Tools](browser-tools.md) — navigate, search, tab management
- [Capture Tools](capture-tools.md) — full browser screenshots and video recording
- [Tool Overview](overview.md)
