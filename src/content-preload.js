/**
 * content-preload.js — Injected into every tab's renderer process.
 *
 * Provides the element indexer (shadow DOM piercing, semantic labels, compact indexed output)
 * and helper functions for click/type/paste/focus/check operations.
 *
 * Main process calls these via webContents.executeJavaScript('window.__tappi.*()').
 * Returns serializable JSON — no DOM nodes cross the boundary.
 */

const { contextBridge, ipcRenderer } = require('electron');

// ─── Shadow DOM helpers ───

function deepClearStamps(root) {
  try {
    root.querySelectorAll('[data-tappi-idx]').forEach(el =>
      el.removeAttribute('data-tappi-idx')
    );
    root.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) deepClearStamps(el.shadowRoot);
    });
  } catch (e) {}
}

function deepQueryAll(root, selectors) {
  const results = [];
  try { results.push(...root.querySelectorAll(selectors)); } catch (e) {}
  try {
    const allEls = root.querySelectorAll('*');
    for (const el of allEls) {
      if (el.shadowRoot) {
        results.push(...deepQueryAll(el.shadowRoot, selectors));
      }
    }
  } catch (e) {}
  return results;
}

function deepQueryStamp(root, idx) {
  const found = root.querySelector('[data-tappi-idx="' + idx + '"]');
  if (found) return found;
  try {
    const allEls = root.querySelectorAll('*');
    for (const el of allEls) {
      if (el.shadowRoot) {
        const deep = deepQueryStamp(el.shadowRoot, idx);
        if (deep) return deep;
      }
    }
  } catch (e) {}
  return null;
}

// ─── Interactive element selectors ───

const INTERACTIVE_SELECTORS = [
  'a[href]', 'button', 'input', 'select', 'textarea',
  '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
  '[role="checkbox"]', '[role="radio"]', '[role="textbox"]', '[role="switch"]',
  '[role="combobox"]', '[role="option"]', '[role="spinbutton"]',
  '[onclick]', '[tabindex]:not([tabindex="-1"])',
  'details > summary', '[contenteditable="true"]',
].join(', ');

// ─── Viewport check ───

function isInViewport(el) {
  const rect = el.getBoundingClientRect();
  // Element must have size and its center must be within the viewport
  if (rect.width === 0 && rect.height === 0) return false;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  // Allow a small margin (50px) for elements partially in view
  return cx >= -50 && cx <= vw + 50 && cy >= -50 && cy <= vh + 50;
}

// ─── Canvas app detection ───

function detectCanvasApp() {
  var url = location.href;
  if (/docs\.google\.com\/spreadsheets/.test(url)) return 'sheets';
  if (/docs\.google\.com\/(document|presentation)/.test(url)) return 'docs';
  if (/figma\.com\/(file|design|board)/.test(url)) return 'figma';
  if (/excalidraw\.com/.test(url)) return 'excalidraw';
  if (/canva\.com\/design/.test(url)) return 'canva';
  if (/miro\.com\/app/.test(url)) return 'miro';
  return null;
}

// ─── Accessibility overlay harvesting ───
// Google Sheets, Docs, Slides render invisible DOM overlays for screen readers
// on top of their <canvas>. These contain structured, interactive elements
// (cells, menu items, toolbar buttons) that our normal indexer can find —
// IF we know where to look. This function finds those overlay containers
// and returns their elements so the main indexer can include them.

function harvestAccessibilityOverlay() {
  var app = detectCanvasApp();
  var results = [];

  if (app === 'sheets') {
    // Google Sheets: The accessibility grid overlay uses role="grid" with role="row" > role="gridcell"
    // The toolbar uses role="toolbar" with real buttons
    // The formula bar is an accessible input
    // Also harvest the sheet tab bar at the bottom

    // Toolbar buttons — these are real DOM elements overlaying the canvas
    var toolbarBtns = document.querySelectorAll('[role="toolbar"] [role="button"], [role="toolbar"] button, .goog-toolbar-button');
    toolbarBtns.forEach(function(el) { results.push(el); });

    // Menu bar items
    var menuItems = document.querySelectorAll('[role="menubar"] [role="menuitem"], .menu-button');
    menuItems.forEach(function(el) { results.push(el); });

    // Formula bar / Name box
    var formulaInputs = document.querySelectorAll('#formula-bar-name-box, .cell-input, [role="textbox"]');
    formulaInputs.forEach(function(el) { results.push(el); });

    // Sheet tabs at the bottom
    var sheetTabs = document.querySelectorAll('.docs-sheet-tab, [role="tab"]');
    sheetTabs.forEach(function(el) { results.push(el); });

    // Active cell editor (appears when editing)
    var cellEditors = document.querySelectorAll('.cell-input, .waffle-name-box');
    cellEditors.forEach(function(el) { results.push(el); });

  } else if (app === 'docs') {
    // Google Docs: toolbar, menu bar, and editing surface are DOM-accessible
    var docToolbar = document.querySelectorAll('[role="toolbar"] [role="button"], [role="toolbar"] button');
    docToolbar.forEach(function(el) { results.push(el); });

    var docMenus = document.querySelectorAll('[role="menubar"] [role="menuitem"]');
    docMenus.forEach(function(el) { results.push(el); });

    // The document body is usually contenteditable
    var docBody = document.querySelectorAll('[role="textbox"][contenteditable="true"], .kix-appview-editor');
    docBody.forEach(function(el) { results.push(el); });

  } else if (app === 'figma') {
    // Figma: the toolbar and panels are real DOM; only the design canvas is WebGL
    var figmaToolbar = document.querySelectorAll('[class*="toolbar"] button, [class*="toolbar"] [role="button"]');
    figmaToolbar.forEach(function(el) { results.push(el); });

    // Left panel (layers), right panel (properties)
    var figmaPanels = document.querySelectorAll('[class*="panel"] button, [class*="panel"] input, [class*="panel"] [role="treeitem"]');
    figmaPanels.forEach(function(el) { results.push(el); });

    // Top bar menus
    var figmaMenus = document.querySelectorAll('[class*="menu"] [role="menuitem"], [data-testid] button');
    figmaMenus.forEach(function(el) { results.push(el); });
  }

  return results;
}

// ─── Indexer ───

function indexElements(filter, grep) {
  // Clear old stamps (including shadow DOMs)
  deepClearStamps(document);

  const root = filter ? document.querySelector(filter) : document;
  if (!root) return JSON.stringify({ error: 'Selector not found: ' + filter });

  const interactive = deepQueryAll(root, INTERACTIVE_SELECTORS);

  // Harvest accessibility overlay elements from canvas apps
  // These are real DOM elements (toolbar buttons, menus, tabs) that sit on top of the canvas
  var canvasApp = detectCanvasApp();
  if (canvasApp) {
    var overlayElements = harvestAccessibilityOverlay();
    for (var oi = 0; oi < overlayElements.length; oi++) {
      if (interactive.indexOf(overlayElements[oi]) === -1) {
        interactive.push(overlayElements[oi]);
      }
    }
  }

  // Detect topmost modal/dialog for scoped de-duplication
  const allDialogs = [...document.querySelectorAll('[role=dialog], [role=presentation], [aria-modal=true]')]
    .filter(d => d.offsetParent !== null || getComputedStyle(d).position === 'fixed');
  const realDialogs = allDialogs.filter(d =>
    d.getAttribute('role') === 'dialog' || d.getAttribute('aria-modal') === 'true'
  );
  const topDialog = (realDialogs.length > 0
    ? realDialogs[realDialogs.length - 1]
    : allDialogs[allDialogs.length - 1]) || null;

  const seen = new Set();
  const results = [];
  let offscreen = 0;

  // Sort: elements inside topmost dialog come first
  const sorted = [...interactive].sort((a, b) => {
    const aIn = topDialog && topDialog.contains(a) ? 0 : 1;
    const bIn = topDialog && topDialog.contains(b) ? 0 : 1;
    return aIn - bIn;
  });

  for (const el of sorted) {
    // Skip invisible elements (no layout)
    if (el.offsetParent === null && el.tagName !== 'BODY' && getComputedStyle(el).position !== 'fixed') continue;

    const inDialog = topDialog && topDialog.contains(el);
    const isFixed = getComputedStyle(el).position === 'fixed' || getComputedStyle(el).position === 'sticky';

    // Viewport scoping: only index visible elements (unless grep is active — search everywhere)
    if (!grep && !inDialog && !isFixed && !isInViewport(el)) {
      offscreen++;
      continue;
    }

    const isDisabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
    const tag = el.tagName.toLowerCase();
    const type = el.type || '';
    const role = el.getAttribute('role') || '';
    const ariaLabel = el.getAttribute('aria-label') || '';
    const placeholder = el.placeholder || '';
    const name = el.name || '';

    // Terse text: prefer aria-label, then text content, capped tight
    const rawText = (el.textContent || '').trim().replace(/\s+/g, ' ');
    const text = rawText.slice(0, 40);
    const href = el.href || '';

    // Build label
    let label = '';
    if (tag === 'a') label = 'link';
    else if (tag === 'button' || role === 'button') label = 'button';
    else if (tag === 'input') label = type ? 'input:' + type : 'input';
    else if (tag === 'select') label = 'select';
    else if (tag === 'textarea') label = 'textarea';
    else if (role === 'textbox' || el.isContentEditable) label = 'textbox';
    else if (role) label = role;
    else label = tag;
    if (isDisabled) label += ':disabled';

    // Build description — terse but semantic
    let desc = ariaLabel ? ariaLabel.slice(0, 40) : text || placeholder || name || '';

    // Links: include FULL URL — truncation causes LLM to hallucinate non-existent pages
    if (tag === 'a' && href && !href.startsWith('javascript:') && !href.startsWith('#')) {
      desc = desc ? desc + ' → ' + href : href;
    }

    // Show values ONLY for input/select/textarea
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const value = (el.value || '').slice(0, 30);
      if (value && !desc.includes(value)) desc = desc ? desc + ' [' + value + ']' : value;
    }

    // Select current option
    if (tag === 'select' && el.selectedIndex >= 0 && el.options[el.selectedIndex]) {
      const selText = el.options[el.selectedIndex].text.slice(0, 25);
      if (!desc.includes(selText)) desc = desc ? desc + ' [' + selText + ']' : selText;
    }

    // Checked/selected state
    if (['checkbox', 'radio', 'switch'].includes(role) || (tag === 'input' && ['checkbox', 'radio'].includes(type))) {
      const checked = el.checked || el.getAttribute('aria-checked') === 'true';
      desc += checked ? ' ✓' : ' ○';
    }

    desc = desc.trim();

    // Skip elements with no meaningful description (e.g. empty divs, icon-only links)
    // Exception: inputs are always useful even without a description
    if (!desc && tag !== 'input' && tag !== 'textarea' && tag !== 'select') continue;

    // Grep filter: only keep elements whose label or desc match the pattern
    if (grep) {
      const grepLower = grep.toLowerCase();
      const matchText = (label + ' ' + desc).toLowerCase();
      if (!matchText.includes(grepLower)) continue;
    }

    // De-dup key (scoped by dialog context)
    const scope = inDialog ? 'modal' : 'page';
    const key = scope + '|' + label + '|' + desc;
    if (seen.has(key)) continue;
    seen.add(key);

    // Stamp element for later retrieval
    el.setAttribute('data-tappi-idx', results.length.toString());
    results.push({ label: label, desc: desc });
  }

  // Include offscreen count so LLM knows to scroll for more
  const meta = {};
  if (offscreen > 0) meta.offscreen = offscreen;
  if (topDialog) meta.dialog = true;
  if (canvasApp) meta.canvasApp = canvasApp;

  return JSON.stringify({ elements: results, meta: meta });
}

// ─── Element lookup helpers ───

function getElementPosition(idx) {
  const el = deepQueryStamp(document, idx);
  if (!el) return JSON.stringify({ error: 'Element [' + idx + '] not found. Run elements to re-index.' });

  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  const rect = el.getBoundingClientRect();
  return JSON.stringify({
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    tag: el.tagName.toLowerCase(),
  });
}

function focusElement(idx) {
  const el = deepQueryStamp(document, idx);
  if (!el) return JSON.stringify({ error: 'Element [' + idx + '] not found. Run elements to re-index.' });

  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.focus();

  // For inputs, also select existing text so typing replaces it
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    try { el.select(); } catch (e) {}
  }

  return JSON.stringify({ focused: true, tag: el.tagName.toLowerCase() });
}

/**
 * Phase 9.096e: Set value on an input/textarea AND fire proper DOM events
 * so React/Angular/Vue controlled components pick up the change.
 * Uses the native setter to bypass React's synthetic value tracking,
 * then dispatches input + change events.
 */
function setValueWithEvents(idx, text) {
  const el = deepQueryStamp(document, idx);
  if (!el) return JSON.stringify({ error: 'Element [' + idx + '] not found. Run elements to re-index.' });

  const tag = el.tagName.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea' && !el.isContentEditable) {
    return JSON.stringify({ error: 'Element [' + idx + '] is not an input/textarea/contentEditable.' });
  }

  // ContentEditable elements
  if (el.isContentEditable) {
    el.focus();
    el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return JSON.stringify({ ok: true, value: el.textContent.slice(0, 200) });
  }

  // For React: use the native setter to bypass React's internal value tracker.
  // React overrides el.value's setter — we need to call the original HTMLInputElement
  // prototype setter so React's onChange actually fires.
  var nativeSetter = tag === 'textarea'
    ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

  el.focus();
  nativeSetter.call(el, text);

  // Dispatch input event (React listens for this via its event delegation)
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  // Dispatch change event (for Angular/Vue/vanilla)
  el.dispatchEvent(new Event('change', { bubbles: true }));

  return JSON.stringify({ ok: true, value: el.value.slice(0, 200) });
}

function checkElement(idx) {
  const el = deepQueryStamp(document, idx);
  if (!el) return JSON.stringify({ error: 'Element [' + idx + '] not found' });

  const tag = el.tagName.toLowerCase();
  const type = (el.type || '').toLowerCase();
  const result = { tag: tag, exists: true };

  // Value for inputs
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    result.value = (el.value || '').slice(0, 200);
  }
  // ContentEditable
  if (el.isContentEditable) {
    result.value = (el.textContent || '').slice(0, 200);
  }
  // Checked state
  if (['checkbox', 'radio'].includes(type) || ['checkbox', 'radio', 'switch'].includes(el.getAttribute('role') || '')) {
    result.checked = el.checked || el.getAttribute('aria-checked') === 'true';
  }
  // Disabled state
  result.disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
  // Active/focused
  result.focused = document.activeElement === el;

  return JSON.stringify(result);
}

function extractText(selector, grep, offset) {
  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) return JSON.stringify({ error: 'Selector not found: ' + selector });

  const lines = [];
  const blockTags = new Set([
    'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'LI', 'TR', 'BLOCKQUOTE', 'PRE', 'ARTICLE', 'SECTION',
    'HEADER', 'FOOTER', 'NAV', 'MAIN', 'ASIDE', 'DT', 'DD',
  ]);
  const skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'TEMPLATE']);

  function walk(node) {
    if (node.nodeType === 3) { // Text node
      const text = node.textContent.trim();
      if (text) {
        if (lines.length > 0 && lines[lines.length - 1] !== '') {
          lines[lines.length - 1] += ' ' + text;
        } else {
          lines.push(text);
        }
      }
      return;
    }
    if (node.nodeType !== 1) return; // Not an element
    if (skipTags.has(node.tagName)) return;

    // Block-level element → start new line
    if (blockTags.has(node.tagName)) {
      if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    }

    // Walk children
    for (const child of node.childNodes) walk(child);

    // Walk shadow DOM
    if (node.shadowRoot) {
      for (const child of node.shadowRoot.childNodes) walk(child);
    }

    if (blockTags.has(node.tagName)) {
      if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    }
  }

  walk(root);

  // Clean up: collapse empty lines
  const allLines = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().split('\n');

  // Grep mode: return lines containing the search term + surrounding context.
  // Supports either:
  // - literal substring (default)
  // - regex patterns (e.g. "Wednesday|Thursday" or "/Wed|Thu/i")
  if (grep) {
    const raw = String(grep).trim();
    const matchLines = [];

    let regex = null;
    try {
      // /pattern/flags form
      const slashForm = raw.match(/^\/(.*)\/([a-z]*)$/i);
      if (slashForm) {
        const pattern = slashForm[1];
        const flags = (slashForm[2] || '').replace(/[gy]/g, ''); // avoid stateful/global matching
        regex = new RegExp(pattern, flags || 'i');
      } else if (/[|.^$*+?()[\]{}]/.test(raw)) {
        // Heuristic: treat regex-y strings as regex (helps weaker models)
        regex = new RegExp(raw, 'i');
      }
    } catch {
      regex = null;
    }

    const grepLower = raw.toLowerCase();
    for (let i = 0; i < allLines.length; i++) {
      const line = allLines[i] || '';
      const isMatch = regex ? regex.test(line) : line.toLowerCase().includes(grepLower);
      if (isMatch) {
        // Include 1 line before and after for context
        const start = Math.max(0, i - 1);
        const end = Math.min(allLines.length - 1, i + 1);
        for (let j = start; j <= end; j++) {
          if (!matchLines.includes(allLines[j])) matchLines.push(allLines[j]);
        }
      }
    }

    if (matchLines.length === 0) {
      return 'No text matching "' + raw + '" found on page.';
    }
    return matchLines.join('\n').slice(0, 4000);
  }

  // Default: return page text with offset-based pagination.
  // Generous limits reduce round-trips for content-heavy pages (Gmail, news articles, etc.)
  const maxLen = selector ? 8000 : 4000;
  const fullText = allLines.join('\n');
  const start = offset || 0;
  if (start > 0 && start >= fullText.length) return '(end of page content)';
  const chunk = fullText.slice(start, start + maxLen);
  const remaining = fullText.length - (start + chunk.length);
  if (remaining > 0) {
    return chunk + '\n... (' + remaining + ' chars remaining — use offset: ' + (start + chunk.length) + ' to continue)';
  }
  return chunk;
}

/**
 * indexLinks: Extract ALL links from the page with full hrefs.
 * Unlike text() which shows visual URLs (truncated by Google SERP),
 * this returns the actual href attributes — complete with paths, query params, fragments.
 * 
 * @param grep Optional filter - only return links where href or text matches
 * @returns JSON string with array of {href, text}
 */
function indexLinks(grep) {
  const links = Array.from(document.links)
    .filter(l => l.href && l.href.startsWith('http'))
    .map(l => ({
      href: l.href,
      text: (l.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100)
    }))
    // De-dup by href
    .filter((l, i, arr) => arr.findIndex(x => x.href === l.href) === i)
    .slice(0, 50);

  if (links.length === 0) {
    return JSON.stringify({ error: 'No HTTP links found on this page.' });
  }

  // Grep filter
  if (grep) {
    const grepLower = grep.toLowerCase();
    const filtered = links.filter(l => 
      l.href.toLowerCase().includes(grepLower) || 
      l.text.toLowerCase().includes(grepLower)
    );
    if (filtered.length === 0) {
      return JSON.stringify({ error: 'No links matching "' + grep + '".' });
    }
    return JSON.stringify({ links: filtered, total: links.length });
  }

  return JSON.stringify({ links: links, total: links.length });
}

function clickElement(idx) {
  const el = deepQueryStamp(document, idx);
  if (!el) return JSON.stringify({ error: 'Element [' + idx + '] not found. Run elements to re-index.' });

  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  const rect = el.getBoundingClientRect();
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const mOpts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 };
  el.dispatchEvent(new MouseEvent('mousedown', mOpts));
  el.dispatchEvent(new MouseEvent('mouseup', mOpts));
  el.click();

  const label = el.getAttribute('role') || el.tagName.toLowerCase();
  const desc = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 80);

  // Check for toggle state
  const type = (el.type || '').toLowerCase();
  let toggle = null;
  if (['checkbox', 'radio'].includes(type) || ['checkbox', 'radio', 'switch'].includes(el.getAttribute('role') || '')) {
    toggle = (el.checked || el.getAttribute('aria-checked') === 'true') ? 'checked' : 'unchecked';
  }

  return JSON.stringify({ label: label, desc: desc, toggle: toggle });
}

function getPageState() {
  const url = location.href;
  const title = document.title;
  const dialogs = document.querySelectorAll('[role=dialog],[aria-modal=true]').length;
  return JSON.stringify({ url: url, title: title, dialogs: dialogs });
}

// ─── Login form detection (Phase 8.4.3) ───
// Lightweight — only checks for input[type=password] (most reliable signal).
// Runs on DOMContentLoaded + MutationObserver for SPAs that inject forms after load.

function detectLoginForm() {
  return document.querySelector('input[type=password]') !== null;
}

function setupLoginDetection() {
  if (window.__tappi_loginDetectionActive) return;
  window.__tappi_loginDetectionActive = true;

  var reported = false;

  function checkAndReport() {
    if (reported) return;
    if (detectLoginForm()) {
      reported = true;
      ipcRenderer.send('page:login-detected', { domain: location.hostname });
    }
  }

  // Check immediately (handles pages that already have a password field)
  checkAndReport();

  // MutationObserver — catches SPAs that inject login forms after initial load
  var observer = new MutationObserver(function(mutations) {
    if (reported) {
      observer.disconnect();
      return;
    }
    // Only bother if nodes were actually added
    for (var i = 0; i < mutations.length; i++) {
      if (mutations[i].addedNodes.length > 0) {
        // Debounce: coalesce rapid DOM mutations into a single check
        clearTimeout(window.__tappi_loginCheckTimer);
        window.__tappi_loginCheckTimer = setTimeout(checkAndReport, 400);
        break;
      }
    }
  });

  var target = document.body || document.documentElement;
  if (target) {
    observer.observe(target, { childList: true, subtree: true });
  }

  // Stop observing after 60s — if a login form hasn't appeared by then it's not a login page
  setTimeout(function() { observer.disconnect(); }, 60000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupLoginDetection);
} else {
  setupLoginDetection();
}

// ─── Credential detection (form submission interception) ───

function setupCredentialDetection() {
  if (window.__tappi_credentialWatcher) return;
  window.__tappi_credentialWatcher = true;

  document.addEventListener('submit', function(e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;

    var inputs = form.querySelectorAll('input');
    var username = '', password = '';

    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i];
      var type = (input.type || '').toLowerCase();
      var name = (input.name || '').toLowerCase();
      var auto = (input.autocomplete || '').toLowerCase();
      var placeholder = (input.placeholder || '').toLowerCase();

      if (type === 'password' || auto === 'current-password') {
        password = input.value;
      } else if (
        (type === 'email' || type === 'text' || type === 'tel') &&
        (auto === 'username' || auto === 'email' ||
         name.indexOf('user') !== -1 || name.indexOf('email') !== -1 || name.indexOf('login') !== -1 ||
         placeholder.indexOf('email') !== -1 || placeholder.indexOf('username') !== -1)
      ) {
        username = input.value;
      }
    }

    if (username && password) {
      ipcRenderer.send('vault:credential-detected', {
        domain: location.hostname,
        username: username,
        password: password
      });
    }
  }, true);

  // Click-based credential detection for SPA sites that use XHR/fetch instead of form submission.
  // Detects clicks on submit-like buttons near password fields.
  document.addEventListener('click', function(e) {
    var target = e.target;
    // Walk up to find the actual clicked element (might be an icon inside a button)
    while (target && target !== document.body && target.tagName !== 'BUTTON' && target.tagName !== 'A' && target.type !== 'submit') {
      target = target.parentElement;
    }
    if (!target || target === document.body) return;

    var passwordField = document.querySelector('input[type="password"]');
    if (!passwordField || !passwordField.value) return;

    // Check if clicked element looks like a submit/login button
    var text = (target.textContent || '').toLowerCase().trim();
    var type = (target.type || '').toLowerCase();
    var ariaLabel = (target.getAttribute('aria-label') || '').toLowerCase();
    var isSubmitLike = type === 'submit' ||
      text.match(/^(sign in|log in|login|submit|continue|next)$/i) ||
      ariaLabel.match(/(sign in|log in|login|submit)/i);

    if (!isSubmitLike) return;

    // Find the username field — look in the same form or nearby
    var form = passwordField.closest('form') || passwordField.parentElement?.parentElement?.parentElement;
    var inputs = (form || document).querySelectorAll('input');
    var username = '';

    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i];
      var inputType = (input.type || '').toLowerCase();
      var inputName = (input.name || '').toLowerCase();
      var inputAuto = (input.autocomplete || '').toLowerCase();
      var inputPlaceholder = (input.placeholder || '').toLowerCase();

      if ((inputType === 'email' || inputType === 'text' || inputType === 'tel') &&
          (inputAuto === 'username' || inputAuto === 'email' ||
           inputName.indexOf('user') !== -1 || inputName.indexOf('email') !== -1 || inputName.indexOf('login') !== -1 ||
           inputPlaceholder.indexOf('email') !== -1 || inputPlaceholder.indexOf('username') !== -1)) {
        username = input.value;
        break;
      }
    }

    if (username && passwordField.value) {
      ipcRenderer.send('vault:credential-detected', {
        domain: location.hostname,
        username: username,
        password: passwordField.value
      });
    }
  }, true);
}

// Run after DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupCredentialDetection);
} else {
  setupCredentialDetection();
}

// ─── Phase 8.5: Media Engine — Video Detection ───

var __tappi_videoObservers = [];
var __tappi_videoHidden = false;
var __tappi_originalVideoStyles = null;
var __tappi_geometryTimer = null;

/**
 * Detect <video> element and return its rect + site info.
 * Returns JSON string with VideoInfo shape.
 */
function detectVideo() {
  var video = document.querySelector('video');
  if (!video) {
    return JSON.stringify({ hasVideo: false, url: location.href, site: getSite(), hostname: location.hostname });
  }

  var rect = video.getBoundingClientRect();
  var visible = rect.width > 10 && rect.height > 10 &&
    rect.top >= -10 && rect.top < window.innerHeight + 10;

  return JSON.stringify({
    hasVideo: true,
    rect: {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      visible: visible,
    },
    url: location.href,
    site: getSite(),
    hostname: location.hostname,
    isPlaying: video && !video.paused,
  });
}

function getSite() {
  var h = location.hostname;
  if (h.includes('youtube') || h.includes('youtu.be')) return 'youtube';
  if (h.includes('twitch')) return 'twitch';
  if (h.includes('vimeo')) return 'vimeo';
  return 'generic';
}

/**
 * Hide and mute the browser's <video> element (mpv takes over rendering).
 */
function hideVideo() {
  var video = document.querySelector('video');
  if (!video) return;
  if (!__tappi_originalVideoStyles) {
    __tappi_originalVideoStyles = {
      visibility: video.style.visibility || '',
      opacity: video.style.opacity || '',
      volume: video.volume,
      muted: video.muted,
    };
  }
  video.style.visibility = 'hidden';
  video.style.opacity = '0';
  video.volume = 0;
  video.muted = true;

  // Add badge overlay to indicate mpv is rendering
  var badge = document.getElementById('__tappi_mpv_badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = '__tappi_mpv_badge';
    badge.style.cssText = [
      'position: fixed',
      'bottom: 8px',
      'right: 8px',
      'background: rgba(0,0,0,0.7)',
      'color: white',
      'font-size: 11px',
      'padding: 2px 6px',
      'border-radius: 4px',
      'z-index: 999999',
      'pointer-events: none',
      'font-family: system-ui, sans-serif',
    ].join(';');
    badge.textContent = '🪷 mpv';
    document.body && document.body.appendChild(badge);
  }
  __tappi_videoHidden = true;
}

/**
 * Restore the browser's <video> element to normal.
 */
function showVideo() {
  var video = document.querySelector('video');
  if (video && __tappi_originalVideoStyles) {
    video.style.visibility = __tappi_originalVideoStyles.visibility;
    video.style.opacity = __tappi_originalVideoStyles.opacity;
    video.volume = __tappi_originalVideoStyles.volume;
    video.muted = __tappi_originalVideoStyles.muted;
    __tappi_originalVideoStyles = null;
  }

  var badge = document.getElementById('__tappi_mpv_badge');
  if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
  __tappi_videoHidden = false;
}

/**
 * Set up MutationObserver + ResizeObserver on the <video> element.
 * Sends geometry change events via IPC when the video rect changes.
 */
function setupVideoObservers() {
  // Clear any existing observers
  __tappi_videoObservers.forEach(function(obs) { try { obs.disconnect(); } catch(e) {} });
  __tappi_videoObservers = [];

  var video = document.querySelector('video');
  if (!video) return;

  var lastRect = null;

  function sendGeometryIfChanged() {
    var rect = video.getBoundingClientRect();
    var visible = rect.width > 10 && rect.height > 10 &&
      rect.top >= -10 && rect.top < window.innerHeight + 10;

    var key = Math.round(rect.left) + ',' + Math.round(rect.top) + ',' + Math.round(rect.width) + ',' + Math.round(rect.height) + ',' + visible;
    if (key === lastRect) return;
    lastRect = key;

    ipcRenderer.send('media:geometry-changed-from-page', {
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visible: visible,
      },
    });
  }

  // ResizeObserver for size changes
  if (window.ResizeObserver) {
    var resObs = new window.ResizeObserver(sendGeometryIfChanged);
    resObs.observe(video);
    __tappi_videoObservers.push(resObs);
  }

  // MutationObserver for attribute/style changes
  var mutObs = new MutationObserver(sendGeometryIfChanged);
  mutObs.observe(video, { attributes: true, attributeFilter: ['style', 'class', 'width', 'height'] });
  __tappi_videoObservers.push(mutObs);

  // Scroll listener
  var scrollHandler = function() { sendGeometryIfChanged(); };
  window.addEventListener('scroll', scrollHandler, { passive: true });

  // Polling fallback (100ms)
  if (__tappi_geometryTimer) clearInterval(__tappi_geometryTimer);
  __tappi_geometryTimer = setInterval(sendGeometryIfChanged, 250);

  // Play/pause interception
  video.addEventListener('play', function() {
    ipcRenderer.send('media:play-pause-from-page', { playing: true });
  });
  video.addEventListener('pause', function() {
    ipcRenderer.send('media:play-pause-from-page', { playing: false });
  });
  video.addEventListener('seeked', function() {
    ipcRenderer.send('media:seeked-from-page', { position: video.currentTime });
  });

  // Fullscreen detection
  document.addEventListener('fullscreenchange', function() {
    sendGeometryIfChanged();
  });

  // Initial geometry report
  sendGeometryIfChanged();
}

/**
 * Watch for <video> elements appearing (SPAs / YouTube loads them async).
 */
function setupVideoWatcher() {
  if (window.__tappi_videoWatcherActive) return;
  window.__tappi_videoWatcherActive = true;

  function checkForVideo() {
    var video = document.querySelector('video');
    if (video && !window.__tappi_lastVideoSrc) {
      var src = video.src || video.currentSrc || location.href;
      window.__tappi_lastVideoSrc = src;

      var info = detectVideo();
      ipcRenderer.send('media:video-detected-from-page', JSON.parse(info));
      setupVideoObservers();
    }
  }

  // Check immediately
  checkForVideo();

  // Watch for video elements added to DOM
  var watcher = new MutationObserver(function() { checkForVideo(); });
  watcher.observe(document.documentElement, { childList: true, subtree: true });

  // Also watch for src changes on existing video elements
  setInterval(function() {
    var video = document.querySelector('video');
    if (video) {
      var src = video.src || video.currentSrc || location.href;
      if (src && src !== window.__tappi_lastVideoSrc && src !== 'about:blank') {
        window.__tappi_lastVideoSrc = src;
        var info = detectVideo();
        ipcRenderer.send('media:video-detected-from-page', JSON.parse(info));
        setupVideoObservers();
      }
    }
  }, 2000);
}

// Start video watcher on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupVideoWatcher);
} else {
  setupVideoWatcher();
}

// Expose video functions for main process to call directly
window.__tappi_detectVideo = detectVideo;
window.__tappi_hideVideo = hideVideo;
window.__tappi_showVideo = showVideo;

// ─── Phase 9.096e: Native DOM event helpers ───

/**
 * After Electron's wc.paste() sets a value, React won't know.
 * Re-set via the native HTMLInputElement setter and dispatch input + change events.
 */
function fireInputEvents(idx) {
  var el = deepQueryStamp(document, idx);
  if (!el) return JSON.stringify({ error: 'Element not found' });

  var tag = el.tagName.toLowerCase();

  // Use native setter for the current value to trigger React's tracker
  if (tag === 'input' || tag === 'textarea') {
    var nativeSetter = tag === 'textarea'
      ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(el, el.value); // Re-set to same value via native setter
  }

  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  el.dispatchEvent(new Event('change', { bubbles: true }));

  return JSON.stringify({ ok: true, value: (el.value || el.textContent || '').slice(0, 200) });
}

/**
 * Dispatch a DOM KeyboardEvent on the currently focused element.
 * Used in dual-dispatch pattern alongside wc.sendInputEvent.
 */
function dispatchKeyEvent(type, key, code, modifiers) {
  var opts = {
    key: key,
    code: code || key,
    bubbles: true,
    cancelable: true,
    ctrlKey: (modifiers || []).includes('control'),
    metaKey: (modifiers || []).includes('meta'),
    shiftKey: (modifiers || []).includes('shift'),
    altKey: (modifiers || []).includes('alt'),
  };
  var target = document.activeElement || document.body;
  target.dispatchEvent(new KeyboardEvent(type, opts));
  return JSON.stringify({ ok: true });
}

/**
 * Dispatch DOM MouseEvents at a given point.
 * Used in dual-dispatch pattern alongside wc.sendInputEvent for click.
 */
function clickAtPoint(x, y) {
  var el = document.elementFromPoint(x, y);
  if (!el) return JSON.stringify({ error: 'No element at (' + x + ', ' + y + ')' });

  var opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));

  return JSON.stringify({ ok: true, tag: el.tagName.toLowerCase() });
}

/**
 * Dispatch DOM dblclick MouseEvent at a given point.
 * Used in dual-dispatch pattern alongside wc.sendInputEvent for double-click.
 */
function doubleClickAtPoint(x, y) {
  var el = document.elementFromPoint(x, y);
  if (!el) return JSON.stringify({ error: 'No element at (' + x + ', ' + y + ')' });

  var opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, detail: 2 };
  el.dispatchEvent(new MouseEvent('dblclick', opts));

  return JSON.stringify({ ok: true, tag: el.tagName.toLowerCase() });
}

/**
 * Dispatch DOM contextmenu MouseEvent at a given point.
 * Used in dual-dispatch pattern alongside wc.sendInputEvent for right-click.
 */
function rightClickAtPoint(x, y) {
  var el = document.elementFromPoint(x, y);
  if (!el) return JSON.stringify({ error: 'No element at (' + x + ', ' + y + ')' });

  var opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 };
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('contextmenu', opts));

  return JSON.stringify({ ok: true, tag: el.tagName.toLowerCase() });
}

/**
 * Dispatch DOM hover MouseEvents at a given point.
 * Used in dual-dispatch pattern alongside wc.sendInputEvent for hover.
 */
function hoverAtPoint(x, y) {
  var el = document.elementFromPoint(x, y);
  if (!el) return JSON.stringify({ error: 'No element at (' + x + ', ' + y + ')' });

  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
  el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: x, clientY: y }));
  el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));

  return JSON.stringify({ ok: true, tag: el.tagName.toLowerCase() });
}

// ─── Expose to main process ───

contextBridge.exposeInMainWorld('__tappi', {
  indexElements: function(filter, grep) { return indexElements(filter, grep); },
  indexLinks: function(grep) { return indexLinks(grep); },
  getElementPosition: getElementPosition,
  focusElement: focusElement,
  checkElement: checkElement,
  setValueWithEvents: setValueWithEvents,
  extractText: function(selector, grep, offset) { return extractText(selector, grep, offset); },
  clickElement: clickElement,
  getPageState: getPageState,
  // Phase 9.096e: Native DOM event helpers
  fireInputEvents: fireInputEvents,
  dispatchKeyEvent: dispatchKeyEvent,
  clickAtPoint: clickAtPoint,
  doubleClickAtPoint: doubleClickAtPoint,
  rightClickAtPoint: rightClickAtPoint,
  hoverAtPoint: hoverAtPoint,
  detectCanvasApp: detectCanvasApp,
  // Phase 8.4.3: login state for polling
  getLoginState: function() {
    return JSON.stringify({
      detected: detectLoginForm(),
      domain: location.hostname,
    });
  },
  // Phase 8.5: Media Engine
  detectVideo: detectVideo,
  hideVideo: hideVideo,
  showVideo: showVideo,
});
