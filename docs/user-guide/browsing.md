# Browsing

Everything you can do in Tappi as a web browser — tabs, navigation, bookmarks, search, and more.

---

## Tab Management

### Opening Tabs

| Action | How |
|--------|-----|
| New tab | `⌘T` or click **+** in the tab bar |
| New tab at a specific URL | `⌘T` → type URL in address bar → Enter |
| Open link in new tab | Right-click link → **Open in New Tab** |

> **Note:** The **🪷 Aria** tab is always at position 0 and cannot be closed. It is the dedicated full-width agent chat interface.

### Switching Tabs

| Action | How |
|--------|-----|
| Click a tab | Mouse |
| Tab 1–8 | `⌘1` … `⌘8` |
| Last tab | `⌘9` |

### Closing Tabs

| Action | How |
|--------|-----|
| Close active tab | `⌘W` |
| Reopen last closed tab | `⌘⇧T` |
| Close other tabs | Right-click tab → **Close Other Tabs** |
| Close tabs to the right | Right-click tab → **Close Tabs to the Right** |

Closed regular tabs are saved in a stack (up to 20 entries) and can be reopened with `⌘⇧T`.

### Pinning Tabs

Right-click a tab → **Pin Tab**. Pinned tabs:
- Move to the left side of the tab bar automatically.
- Cannot be accidentally closed with **Close Other Tabs**.
- Stay pinned across tab reorders.

To unpin, right-click → **Unpin Tab**.

### Muting Tabs

Right-click a tab → **Mute Tab** / **Unmute Tab**. A muted tab's audio is silenced at the `WebContents` level — the page's audio indicator updates in the tab bar.

### Duplicating Tabs

Right-click a tab → **Duplicate Tab**. Opens a new tab at the same URL.

### Reordering Tabs

Drag tabs left or right in the tab bar. Constraints:
- The Aria tab is always first and cannot be moved.
- Pinned tabs cannot be dragged past unpinned tabs, and vice versa.

### Tab Crash Recovery

If a tab's renderer process crashes, Tappi auto-reloads it after 1.5 seconds. The tab title briefly shows **⚠️ Crashed** while recovery is in progress.

---

## Navigation

### Address Bar

Press **`⌘L`** to focus the address bar. You can type:

- A full URL (`https://example.com`) → navigates directly.
- A partial URL with a dot (`example.com`) → Tappi prepends `https://`.
- Anything else → treated as a search query and sent to your configured search engine.

Navigation controls:

| Action | How |
|--------|-----|
| Back | Back button or `⌘[` (via browser history) |
| Forward | Forward button or `⌘]` |
| Reload | `⌘R` or the reload button |

### Search Engine

The default search engine is **Google**. Change it in **Settings → Search Engine**. Available options include Google, DuckDuckGo, Bing, and others. The search template is applied whenever a non-URL query is entered in the address bar.

### New Tab Page

New tabs open a local `newtab.html` page — a minimal blank slate for entering a URL or search query.

---

## Bookmarks

### Toggling a Bookmark

Press **`⌘D`** (or **View → Toggle Bookmark**) to bookmark the current page. Press again to remove it.

Bookmarks are stored in the profile's SQLite database (with JSON migration support for older installs). Each bookmark records:

- URL
- Title
- Creation date
- Visit count
- Folder (for organization)

### Viewing Bookmarks

Press **`⌘⇧B`** (or **View → Bookmarks**) to open the bookmarks panel in the chrome UI. You can search and click any bookmark to navigate.

---

## Find on Page

Press **`⌘F`** to open the find bar. As you type, matches are highlighted in the active page. Results show as `N of M matches`. Press **Enter** to advance to the next match.

---

## Downloads

Tappi includes a built-in download manager.

- Press **`⌘⇧D`** to open the downloads panel.
- Active downloads show progress; completed downloads show file path and size.
- You can cancel an active download or clear completed entries from the panel.

All downloads are logged in the profile's SQLite database.

---

## History

Press **`⌘Y`** to open the history panel. History is stored in SQLite and includes:

- URL, page title
- Visit timestamp
- Domain index for fast lookup
- Visit count per URL

---

## Ad Blocker

Tappi ships with an EasyList-based ad blocker.

### Enabling

**Settings → Features → Ad Blocker** (toggle on). The blocker starts immediately and the status bar shows a live count of blocked requests.

### How it works

1. On first enable, Tappi downloads [EasyList](https://easylist.to/easylist/easylist.txt) and caches it at `~/.tappi-browser/cache/easylist.txt`.
2. The list is refreshed automatically every 24 hours in the background.
3. Requests are matched against:
   - A built-in list of ~40 known ad/tracking domains (fast path).
   - Domain block entries from EasyList.
   - URL pattern regexes (capped at 5,000 for performance).
   - Common tracking URL patterns (`/ads/`, `/pixel/`, `?utm_`, etc.).
4. Main-frame navigations are never blocked — only sub-resources (scripts, images, XHR).

### Per-Site Exceptions

To allow ads on a specific site, open **Settings** and add the domain to the **Ad Blocker Exceptions** list. The blocker will skip all requests originating from that domain.

---

## Dark Mode

**Settings → Features → Dark Mode**, or toggle directly from the status bar icon.

Dark mode injects a CSS inversion filter into the active page. This is a global style override — it works on any website but does not use a site-specific dark theme.

---

## Zoom and Print

- **Zoom:** Use the browser's built-in zoom (`⌘+` / `⌘-` / `⌘0`) — standard Electron WebContents zoom.
- **Print:** `⌘P` prints the active page using the system print dialog.

---

## Fullscreen

Tappi supports both:
- **Window fullscreen** (`⌃⌘F` on macOS) — hides the tab bar and address bar.
- **HTML5 fullscreen** (e.g. YouTube's player) — the tab expands to fill the entire window automatically; the chrome chrome hides. Pressing `Esc` exits.

---

## Context Menus

Right-clicking on a page element opens a native context menu. Right-clicking a tab in the tab bar opens a tab context menu with Pin, Mute, Duplicate, and Close options.

---

## Related Guides

- [AI Agent (Aria)](agent.md) — let the agent do the browsing for you
- [Settings](settings.md) — configure search engine and feature toggles
- [Keyboard Shortcuts](keyboard-shortcuts.md) — full shortcut reference
