/**
 * page-tools.ts — Page-level tool implementations.
 *
 * Each function takes the active tab's webContents and executes DOM operations
 * via the content-preload functions exposed on window.__tappi.
 *
 * These are thin wrappers: preload does the heavy lifting (shadow DOM piercing,
 * semantic labels), this file handles Electron-native input dispatch and
 * result formatting.
 */

import { clipboard, NativeImage } from 'electron';
import type { WebContents } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

// ─── Helpers ───

async function callPreload(wc: WebContents, fn: string, ...args: any[]): Promise<any> {
  const argsStr = args.map(a => JSON.stringify(a)).join(', ');
  const result = await wc.executeJavaScript(`window.__tappi.${fn}(${argsStr})`);
  // Preload returns JSON strings for complex objects, plain strings for text
  try {
    return JSON.parse(result);
  } catch {
    return result; // Already a string (e.g. extractText)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Page Tools ───

/**
 * Format indexed elements into a compact string.
 * Hard cap: 50 elements (enforced by preload). Use grep to narrow on busy pages.
 * @param grep If set, search ALL elements (including offscreen) for matches.
 */
export async function pageElements(wc: WebContents, filter?: string, _unused = false, grep?: string): Promise<string> {
  const result = await callPreload(wc, 'indexElements', filter || null, grep || null);
  if (result.error) return result.error;

  // Format: { elements: [{label, desc}, ...], meta: {offscreen?, dialog?} }
  const elements = result.elements || result;
  const meta = result.meta || {};

  if (!Array.isArray(elements) || elements.length === 0) {
    if (grep) return `No elements matching "${grep}".${meta.offscreen > 0 ? ` (searched ${meta.offscreen + elements.length} total)` : ''}`;
    if (meta.offscreen > 0) return `No elements in viewport. ${meta.offscreen} offscreen — scroll or use grep to search.`;
    return [
      '0 elements found in viewport.',
      'Possible causes:',
      '• Page still loading → wait(1000) then elements() again',
      '• Content below fold → scroll("down") then elements()',
      '• Canvas-rendered page → use keys for interaction, screenshot for visual state',
      '• Modal/overlay blocking → elements({ grep: "close" }) to find dismiss button',
    ].join('\n');
  }

  const lines = elements.map((e: any, i: number) => `[${i}] (${e.label}) ${e.desc}`);

  // Hints
  if (meta.dialog) lines.unshift('[Dialog active]');
  if (grep) {
    lines.unshift(`[grep: "${grep}" — ${elements.length} matches]`);
  } else {
    const hints: string[] = [];
    if (meta.offscreen > 0) hints.push(`${meta.offscreen} offscreen`);
    if (hints.length > 0) lines.push(`(${hints.join(', ')} — use elements({ grep: "..." }) to search)`);
  }

  return lines.join('\n');
}

export async function pageClick(wc: WebContents, index: number): Promise<string> {
  // Capture pre-click state for enrichment
  const urlBefore = wc.getURL();
  const titleBefore = wc.getTitle();

  // Use JS click via preload (more reliable for SPAs than sendInputEvent)
  const result = await callPreload(wc, 'clickElement', index);
  if (result.error) return result.error;

  // Slightly longer pause to catch navigations
  await sleep(500);

  const label = result.label || result.desc || String(index);

  // Enrichment 1 + 6: Check if a full navigation happened
  let urlAfter = '';
  try { urlAfter = wc.getURL(); } catch {}
  if (urlAfter && urlAfter !== urlBefore && !urlAfter.startsWith('about:')) {
    return `✓ Clicked [${index}] '${label}'. Navigated to ${urlAfter}.\n⚠️ Elements stale — re-index with elements().`;
  }

  // Check post-click state (toggle, dialog, SPA title change)
  let status = '';
  try {
    const post = await callPreload(wc, 'getPageState');
    if (result.toggle !== null) {
      status = ` — now ${result.toggle}`;
    } else if (post.dialogs > 0) {
      status = ' — dialog opened';
    }
  } catch {
    // callPreload threw — page likely navigated away
    return `✓ Clicked [${index}] '${label}'. Navigated away.\n⚠️ Elements stale — re-index with elements().`;
  }

  // SPA detection: title change with same URL = content updated
  let titleAfter = '';
  try { titleAfter = wc.getTitle(); } catch {}
  if (titleAfter && titleAfter !== titleBefore) {
    return `✓ Clicked [${index}] '${label}'. Page content updated.${status}`;
  }

  return `✓ Clicked [${index}] '${label}'.${status}`;
}

export async function pageType(wc: WebContents, index: number, text: string): Promise<string> {
  // Phase 9.096e: Use setValueWithEvents for React/Angular/Vue compatibility.
  // This uses the native HTMLInputElement.prototype.value setter to bypass
  // React's internal value tracker, then dispatches InputEvent + change Event.
  const setResult = await callPreload(wc, 'setValueWithEvents', index, text);
  if (setResult.error) {
    // Fallback to legacy char-by-char for non-standard elements
    return await pageTypeLegacy(wc, index, text);
  }

  const newValue = setResult.value || '';
  if (newValue.includes(text.slice(0, 20))) {
    return `Typed "${text}" into [${index}]`;
  } else {
    // setValueWithEvents set it but verify shows different — React might have reformatted (e.g. credit card auto-format)
    return `Typed "${text}" into [${index}] — value is now: "${newValue}"`;
  }
}

/** Legacy char-by-char typing via Chromium input events. Fallback for contentEditable/non-standard. */
async function pageTypeLegacy(wc: WebContents, index: number, text: string): Promise<string> {
  const focusResult = await callPreload(wc, 'focusElement', index);
  if (focusResult.error) return focusResult.error;

  // Clear existing content
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'a', modifiers: ['meta'] } as any);
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'a', modifiers: ['meta'] } as any);
  await sleep(30);
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' } as any);
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' } as any);
  await sleep(30);

  for (const char of text) {
    wc.sendInputEvent({ type: 'char', keyCode: char } as any);
    await sleep(5);
  }

  await sleep(50);
  // Dual dispatch: fire InputEvent + change so React picks up the final value
  // even if Chromium's char events didn't trigger React's synthetic listener.
  await callPreload(wc, 'fireInputEvents', index);

  const check = await callPreload(wc, 'checkElement', index);
  if (check.error) return check.error;

  const typed = check.value || '';
  if (typed.includes(text.slice(0, 20))) {
    return `Typed "${text}" into [${index}]`;
  } else {
    return `Typed "${text}" into [${index}] — value is now: "${typed}"`;
  }
}

export async function pagePaste(wc: WebContents, index: number, content: string): Promise<string> {
  // 1. Focus
  const focusResult = await callPreload(wc, 'focusElement', index);
  if (focusResult.error) return focusResult.error;

  // 2. Write to clipboard and paste
  clipboard.writeText(content);
  wc.paste();

  // 3. Fire DOM input/change events so React/Angular/Vue pick up the pasted value
  await sleep(100);
  await callPreload(wc, 'fireInputEvents', index);

  // 4. Verify
  const check = await callPreload(wc, 'checkElement', index);
  if (check.error) return check.error;

  const pasted = check.value || '';
  const snippet = content.length > 30 ? content.slice(0, 27) + '...' : content;
  if (pasted.length > 0) {
    return `Pasted ${content.length} chars into [${index}]`;
  } else {
    return `Pasted "${snippet}" into [${index}] — verify value landed`;
  }
}

export async function pageFocus(wc: WebContents, index: number): Promise<string> {
  const result = await callPreload(wc, 'focusElement', index);
  if (result.error) return result.error;
  return `Focused [${index}] (${result.tag})`;
}

export async function pageCheck(wc: WebContents, index: number): Promise<string> {
  const result = await callPreload(wc, 'checkElement', index);
  if (result.error) return result.error;

  const parts: string[] = [`[${index}]`];
  if (result.value !== undefined) parts.push(`value="${result.value}"`);
  if (result.checked !== undefined) parts.push(result.checked ? '✓ checked' : '○ unchecked');
  if (result.disabled) parts.push('(disabled)');
  if (result.focused) parts.push('(focused)');
  return parts.join(' ');
}

export async function pageText(wc: WebContents, selector?: string, grep?: string): Promise<string> {
  const text = await callPreload(wc, 'extractText', selector || null, grep || null);
  if (typeof text === 'object' && text.error) return text.error;
  const result: string = text || '(empty page)';

  // Enrichment 5: Guide agent when very little text was found (and no grep was used)
  if (!grep && result.length < 100 && result !== '(empty page)') {
    return result + '\n\n💡 Very little text extracted. The page may use dynamic rendering. Try: elements() for interactive elements, scroll("down") + text() for lazy-loaded content, or screenshot for visual content.';
  }

  return result;
}

export async function pageScroll(wc: WebContents, direction: string, amount?: number): Promise<string> {
  const px = amount || 500;
  switch (direction) {
    case 'up':
      await wc.executeJavaScript(`window.scrollBy(0, -${px})`);
      return `Scrolled up ${px}px`;
    case 'down':
      await wc.executeJavaScript(`window.scrollBy(0, ${px})`);
      return `Scrolled down ${px}px`;
    case 'top':
      await wc.executeJavaScript('window.scrollTo(0, 0)');
      return 'Scrolled to top';
    case 'bottom':
      await wc.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)');
      return 'Scrolled to bottom';
    default:
      return `Unknown direction: ${direction}. Use up/down/top/bottom.`;
  }
}

/**
 * Send keyboard input — supports chaining text and special keys.
 *
 * For canvas apps (Google Sheets, Docs, Figma) where DOM input fields don't exist.
 * Uses sendInputEvent for real OS-level keyboard events.
 *
 * Sequence format: an array of actions, each is either:
 *   - A plain string → type each character
 *   - A key name → press that key (enter, tab, escape, backspace, delete, up, down, left, right, etc.)
 *   - A combo → key combination (ctrl+c, cmd+b, shift+tab, ctrl+shift+end, etc.)
 *
 * Examples:
 *   keys ["hello", "tab", "world", "enter"]     → type hello, Tab, type world, Enter
 *   keys ["ctrl+a", "backspace"]                 → select all, delete
 *   keys ["cmd+b"]                               → bold in Docs
 *   keys ["100", "tab", "200", "tab", "300"]     → fill 3 Sheets cells
 */
export async function pageKeys(wc: WebContents, sequence: string | string[]): Promise<string> {
  // Accept either a single combo string or an array of actions
  const actions: string[] = Array.isArray(sequence) ? sequence : [sequence];
  if (actions.length === 0) return 'Usage: keys <combo> or keys [action1, action2, ...]';

  const keyMap: Record<string, string> = {
    enter: 'Return', return: 'Return',
    tab: 'Tab', escape: 'Escape', esc: 'Escape',
    backspace: 'Backspace', delete: 'Delete',
    up: 'Up', down: 'Down', left: 'Left', right: 'Right',
    space: ' ', home: 'Home', end: 'End',
    pageup: 'PageUp', pagedown: 'PageDown',
    f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', f5: 'F5', f6: 'F6',
    f7: 'F7', f8: 'F8', f9: 'F9', f10: 'F10', f11: 'F11', f12: 'F12',
  };

  // Dual dispatch: map Electron keyCode names → DOM KeyboardEvent key/code values
  // (DOM spec uses different names from Electron/Chromium internal names)
  const domKeyMap: Record<string, { key: string; code: string }> = {
    Return:   { key: 'Enter',      code: 'Enter' },
    Tab:      { key: 'Tab',        code: 'Tab' },
    Escape:   { key: 'Escape',     code: 'Escape' },
    Backspace:{ key: 'Backspace',  code: 'Backspace' },
    Delete:   { key: 'Delete',     code: 'Delete' },
    Up:       { key: 'ArrowUp',    code: 'ArrowUp' },
    Down:     { key: 'ArrowDown',  code: 'ArrowDown' },
    Left:     { key: 'ArrowLeft',  code: 'ArrowLeft' },
    Right:    { key: 'ArrowRight', code: 'ArrowRight' },
    Home:     { key: 'Home',       code: 'Home' },
    End:      { key: 'End',        code: 'End' },
    PageUp:   { key: 'PageUp',     code: 'PageUp' },
    PageDown: { key: 'PageDown',   code: 'PageDown' },
    ' ':      { key: ' ',          code: 'Space' },
    F1: { key: 'F1', code: 'F1' }, F2: { key: 'F2', code: 'F2' },
    F3: { key: 'F3', code: 'F3' }, F4: { key: 'F4', code: 'F4' },
    F5: { key: 'F5', code: 'F5' }, F6: { key: 'F6', code: 'F6' },
    F7: { key: 'F7', code: 'F7' }, F8: { key: 'F8', code: 'F8' },
    F9: { key: 'F9', code: 'F9' }, F10: { key: 'F10', code: 'F10' },
    F11: { key: 'F11', code: 'F11' }, F12: { key: 'F12', code: 'F12' },
  };

  const modMap: Record<string, string> = {
    ctrl: 'control', control: 'control',
    cmd: 'meta', meta: 'meta', command: 'meta',
    shift: 'shift', alt: 'alt', option: 'alt',
  };

  let typed = 0;
  let pressed = 0;

  for (const action of actions) {
    const lower = action.toLowerCase().trim();

    // Check if it's a special key name (enter, tab, etc.)
    if (keyMap[lower]) {
      const electronKey = keyMap[lower];
      wc.sendInputEvent({ type: 'keyDown', keyCode: electronKey } as any);
      wc.sendInputEvent({ type: 'keyUp', keyCode: electronKey } as any);
      pressed++;
      await sleep(20);
      // Dual dispatch: also fire DOM KeyboardEvent for React/Angular/Vue
      const domKey = domKeyMap[electronKey] || { key: electronKey, code: electronKey };
      await callPreload(wc, 'dispatchKeyEvent', 'keydown', domKey.key, domKey.code, []);
      await callPreload(wc, 'dispatchKeyEvent', 'keyup', domKey.key, domKey.code, []);
      continue;
    }

    // Check if it's a combo (contains +)
    if (lower.includes('+')) {
      const parts = lower.split('+');
      const modifiers: string[] = [];
      let key = '';

      for (const part of parts) {
        const p = part.trim();
        if (modMap[p]) {
          modifiers.push(modMap[p]);
        } else {
          key = keyMap[p] || p;
        }
      }

      if (key) {
        wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers } as any);
        wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers } as any);
        pressed++;
        await sleep(20);
        // Dual dispatch: also fire DOM KeyboardEvent with modifier flags
        const domComboKey = domKeyMap[key] || { key: key, code: key };
        await callPreload(wc, 'dispatchKeyEvent', 'keydown', domComboKey.key, domComboKey.code, modifiers);
        await callPreload(wc, 'dispatchKeyEvent', 'keyup', domComboKey.key, domComboKey.code, modifiers);
      }
      continue;
    }

    // Plain text — type each character
    for (const char of action) {
      wc.sendInputEvent({ type: 'char', keyCode: char } as any);
      await sleep(8);
    }
    typed += action.length;
  }

  const parts: string[] = [];
  if (typed > 0) parts.push(`typed ${typed} chars`);
  if (pressed > 0) parts.push(`pressed ${pressed} key(s)`);
  return `Keys: ${parts.join(', ')} [${actions.length} action(s)]`;
}

export async function pageEval(wc: WebContents, js: string): Promise<string> {
  try {
    const result = await wc.executeJavaScript(js);
    if (result === undefined) return '(undefined)';
    if (result === null) return '(null)';
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

// Cull tappi screenshots older than 1 hour from temp dir (runs on each new screenshot)
function cullOldScreenshots() {
  try {
    const tmpDir = require('os').tmpdir();
    const cutoff = Date.now() - 60 * 60 * 1000;
    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('tappi-screenshot-') && f.endsWith('.png'));
    let deleted = 0;
    for (const f of files) {
      const ts = parseInt(f.replace('tappi-screenshot-', '').replace('.png', ''), 10);
      if (ts && ts < cutoff) {
        try { fs.unlinkSync(path.join(tmpDir, f)); deleted++; } catch {}
      }
    }
    if (deleted > 0) console.log(`[screenshot] Culled ${deleted} old screenshot(s)`);
  } catch {}
}

export async function pageScreenshot(wc: WebContents, filePath?: string): Promise<string> {
  const image = await wc.capturePage();
  // Always save to file — never return inline base64 (it would be 1M+ tokens in conversation history)
  const resolved = filePath
    ? path.resolve(filePath)
    : path.join(require('os').tmpdir(), `tappi-screenshot-${Date.now()}.png`);
  fs.writeFileSync(resolved, image.toPNG());
  const sizeKB = Math.round(fs.statSync(resolved).size / 1024);

  // Clean up old temp screenshots (>1 hour) — only for auto-generated paths
  if (!filePath) cullOldScreenshots();

  return `Screenshot saved: ${resolved} (${sizeKB}KB)`;
}

export async function pageClickXY(wc: WebContents, x: number, y: number): Promise<string> {
  // Chromium-native: works for canvas apps, games, native Chromium widgets
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 } as any);
  await sleep(30);
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 } as any);
  // DOM-native: works for React, Angular, Vue, vanilla JS event listeners
  await callPreload(wc, 'clickAtPoint', x, y);
  return `Clicked at (${x}, ${y})`;
}

export async function pageHoverXY(wc: WebContents, x: number, y: number): Promise<string> {
  // Chromium-native: moves the OS-level cursor, triggers Chromium hover states
  wc.sendInputEvent({ type: 'mouseMove', x, y } as any);
  // DOM-native: fires mouseover/mouseenter/mousemove for JS framework listeners
  await callPreload(wc, 'hoverAtPoint', x, y);
  return `Hovered at (${x}, ${y})`;
}

export async function pageWait(ms: number): Promise<string> {
  await sleep(ms);
  return `Waited ${ms}ms`;
}
