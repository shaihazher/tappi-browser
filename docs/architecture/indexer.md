# The Content Preload Indexer

`src/content-preload.js` is injected as a preload script into every regular tab renderer. Its core function, `indexElements()`, is the heart of Tappi's token efficiency.

---

## The Problem It Solves

Most AI browsers give the LLM one of:
1. **Full DOM / HTML** — megabytes of markup, most of it irrelevant; LLM hallucinates selectors
2. **Accessibility tree** — better, but still verbose (thousands of nodes), and doesn't pierce shadow DOM on modern component libraries
3. **Screenshot** — slow, no selectors, can't click programmatically

Tappi's approach: **a compact, stamped, indexed list of interactive elements** — typically 20–40 items — with just enough semantic context for the LLM to act.

---

## Shadow DOM Piercing

Modern web components (Google's Material Design, GitHub's custom elements, Reddit's rewrite, Salesforce, etc.) put their elements inside shadow roots. Standard `querySelectorAll` stops at shadow boundaries.

Tappi's `deepQueryAll(root, selectors)` recursively descends through shadow roots:

```javascript
function deepQueryAll(root, selectors) {
  const results = [];
  results.push(...root.querySelectorAll(selectors));     // current root
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) {
      results.push(...deepQueryAll(el.shadowRoot, selectors)); // pierce shadow
    }
  }
  return results;
}
```

The same recursive approach powers `deepQueryStamp` (lookup by `data-tappi-idx`) and `deepClearStamps` (cleanup before re-indexing).

---

## Interactive Selectors

The indexer targets a curated list of semantic and interactive elements:

```javascript
const INTERACTIVE_SELECTORS = [
  'a[href]', 'button', 'input', 'select', 'textarea',
  '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
  '[role="checkbox"]', '[role="radio"]', '[role="textbox"]', '[role="switch"]',
  '[role="combobox"]', '[role="option"]', '[role="spinbutton"]',
  '[onclick]', '[tabindex]:not([tabindex="-1"])',
  'details > summary', '[contenteditable="true"]',
];
```

This list covers native HTML controls and all major ARIA interactive roles. `[onclick]` and `[tabindex]` catch custom interactive elements that don't use semantic markup.

---

## Viewport Scoping

By default, only elements **visible in the current viewport** are indexed:

```javascript
function isInViewport(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  // 50px margin for partially-in-view elements
  return cx >= -50 && cx <= vw + 50 && cy >= -50 && cy <= vh + 50;
}
```

**Exceptions** that bypass viewport scoping:
- Elements inside a detected modal/dialog (`role=dialog`, `aria-modal=true`)
- Fixed/sticky positioned elements (always visible regardless of scroll)
- When `grep` is active (search mode — all elements, including offscreen)

Offscreen elements are **counted** and reported as `meta.offscreen = N` so the LLM knows they exist.

---

## Modal Prioritization

When a modal dialog is open, the indexer:
1. Detects the topmost dialog element (prefers `role="dialog"` + `aria-modal="true"` over `role="presentation"`)
2. Sorts dialog elements to the **front** of the results
3. Scopes deduplication keys by `modal|...` vs `page|...` (prevents false duplicates between page and dialog content)

---

## The Index Build Loop

```
deepClearStamps(document)        ← remove old data-tappi-idx stamps
│
deepQueryAll(root, INTERACTIVE_SELECTORS) → interactive elements
│
Sort: dialog elements first
│
For each element:
  ├─ Skip if invisible (offsetParent === null and not fixed)
  ├─ Skip if offscreen (not in viewport) ← unless grep or modal/fixed
  ├─ Extract: tag, type, role, aria-label, placeholder, name, textContent
  ├─ Build label: "button", "input:text", "link", "select", "textbox", ...
  ├─ Build desc: aria-label || text || placeholder || name || value
  ├─ Append href for links (full URL — never truncated)
  ├─ Append current value for inputs/selects/textareas
  ├─ Append checked state ✓/○ for checkboxes/radios/switches
  ├─ Append :disabled suffix if disabled
  ├─ Skip if desc is empty and not input/textarea/select
  ├─ Apply grep filter if active
  ├─ Deduplicate by scope|label|desc
  ├─ Stamp: el.setAttribute('data-tappi-idx', results.length)
  └─ Push { label, desc } to results
│
Return JSON: { elements, meta: { offscreen?, dialog? } }
```

---

## Output Format

```json
{
  "elements": [
    { "label": "button", "desc": "Sign in" },
    { "label": "input:email", "desc": "Email [user@example.com]" },
    { "label": "input:password", "desc": "Password" },
    { "label": "link", "desc": "Forgot password → https://example.com/reset" },
    { "label": "button:disabled", "desc": "Submit" }
  ],
  "meta": { "offscreen": 12 }
}
```

The `page-tools.ts` layer wraps this JSON into a human-readable string like:

```
[0] button: Sign in
[1] input:email: Email [user@example.com]
[2] input:password: Password
[3] link: Forgot password → https://example.com/reset
[4] button:disabled: Submit
(12 offscreen — use grep to search)
```

---

## Grep Mode

When `grep` is provided, viewport scoping is **lifted** and all elements (including offscreen) are searched. Only elements whose `label + desc` contains the grep string are returned.

```javascript
if (grep) {
  const grepLower = grep.toLowerCase();
  const matchText = (label + ' ' + desc).toLowerCase();
  if (!matchText.includes(grepLower)) continue;
}
```

This is equivalent to Ctrl+F on the element index. The LLM uses this when:
- It sees `(N offscreen)` and knows the target is below the fold
- It wants to find a specific element (e.g., `elements({ grep: "checkout" })`)
- It needs to verify an element exists before clicking

---

## Element Retrieval (Stamping)

When the main process calls `pageClick(wc, 0)`, the page-tools layer executes:

```javascript
window.__tappi.indexElements()  // re-stamps all elements
// then:
window.__tappi.getElementPosition(0) // returns x,y center of stamped element
// then (via CDP mouse event):
window.__tappi.clickElement(0)  // dispatches mousedown + mouseup + click
```

`data-tappi-idx` stamps are cleared and re-applied on every `indexElements()` call. This ensures indices are always fresh — navigating, clicking, or dynamically updating the page requires re-calling `elements()`.

---

## Text Extraction (`extractText`)

Separate from element indexing, `extractText` walks the DOM text nodes for content reading:

```javascript
function extractText(selector, grep) {
  // Walk document.body (or scoped selector) text nodes
  // Block tags (P, DIV, H1-H6, LI, TR...) add newlines
  // Skip: SCRIPT, STYLE, NOSCRIPT, SVG, TEMPLATE
  // Pierce shadow DOM recursively
  // Return:
  //   grep=null: up to 1500 chars (4000 with selector)
  //   grep=str: matching lines ± 1 context line, up to 4000 chars
}
```

The 1500-char limit for unscoped text is intentional — it's enough for a summary (title, first paragraphs, key facts) without burning tokens. Targeted extractions (`text({ selector: "article" })`) get 4000 chars.

---

## Login Detection

A `MutationObserver` watches for `input[type=password]` appearing in the DOM:

```javascript
function detectLoginForm() {
  return document.querySelector('input[type=password]') !== null;
}
```

When detected, `ipcRenderer.send('page:login-detected', { domain })` fires once. The main process calls `setLoginHint()` which the agent picks up in `assembleContext()`. This lets the agent proactively offer password autofill.

The observer disconnects after 60 seconds (handles SPAs that load forms async).

---

## Credential Detection

A `submit` event listener intercepts form submissions:
- Scans form inputs for `type=password` (password), `type=email` / `type=text` with username-like names/placeholders (username)
- If both found: `ipcRenderer.send('vault:credential-detected', { domain, username })`
- Main process prompts the user to save via `vault:save-prompt` IPC

---

## Video Detection (Media Engine)

`setupVideoWatcher()` uses a `MutationObserver` to detect `<video>` elements:
- On detection: fires `media:video-detected-from-page` with rect + site info
- `setupVideoObservers()` attaches `ResizeObserver` + `MutationObserver` + scroll listener + play/pause/seeked listeners
- Geometry changes → `media:geometry-changed-from-page` (debounced to changes only)
- Play/pause → `media:play-pause-from-page`
- Seek → `media:seeked-from-page`

`hideVideo()` / `showVideo()` are called by the media engine when mpv takes over rendering. `hideVideo` sets `video.style.visibility = 'hidden'` and `video.volume = 0`, then adds an "🪷 mpv" badge overlay. `showVideo` restores all original styles.

---

## Comparison to Other Approaches

| Approach | Tokens per page | Shadow DOM | Stale-free | Programmatic clicks |
|----------|----------------|-----------|-----------|-------------------|
| Full HTML dump | 5,000–50,000 | ✗ | On demand | ✗ (parse selectors) |
| Accessibility tree | 500–5,000 | Partial | On demand | Partial |
| Screenshot | ~500 (vision) | ✓ | On demand | ✗ (coordinate guessing) |
| **Tappi indexer** | **50–400** | **✓** | **Re-stamp on every call** | **✓ (stamped indices)** |

The indexed approach costs roughly:
- `elements()`: 50–400 tokens (20–40 elements × ~10 tokens each)
- `elements({ grep: "..." })`: 10–100 tokens (filtered to matches)
- `text()`: 375 tokens (1500 chars ÷ 4)
- `text({ grep: "..." })`: 50–200 tokens (matching passages)

vs. a full DOM dump at 5,000–50,000 tokens. This is why Tappi can run dozens of tool calls within a typical context window while other AI browsers exhaust their budget in 2–3 page reads.

---

## Related Docs

- [Overview](overview.md)
- [Agent System](agent-system.md)
- [Data Flow](data-flow.md)
- [Source Map](../source-map/files.md)
