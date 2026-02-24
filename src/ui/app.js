// @ts-check
const tabsContainer = document.getElementById('tabs-container');
const newTabBtn = document.getElementById('new-tab-btn');
const urlInput = document.getElementById('url-input');
const btnBack = document.getElementById('btn-back');
const btnForward = document.getElementById('btn-forward');
const btnReload = document.getElementById('btn-reload');
const bookmarkBtn = document.getElementById('bookmark-btn');
const btnOverflow = document.getElementById('btn-overflow');

/** Reusable Aria sparkle icon SVG. */
function ariaIcon(size = 16) {
  return `<svg class="aria-icon${size >= 32 ? '-lg' : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"><path d="M12 2C12.3 7.5 16.5 11.7 22 12 16.5 12.3 12.3 16.5 12 22 11.7 16.5 7.5 12.3 2 12 7.5 11.7 11.7 7.5 12 2Z" fill="currentColor" opacity="0.85"/></svg>`;
}

// Agent elements
const agentStrip = document.getElementById('agent-strip');
const agentPanel = document.getElementById('agent-panel');
const agentClose = document.getElementById('agent-close');
const agentMessages = document.getElementById('agent-messages');
const agentInput = document.getElementById('agent-input');
const agentSend = document.getElementById('agent-send');
const agentRedirect = document.getElementById('agent-redirect'); // Phase 9.096d
// Phase 8.40: run status (elapsed timer + tool call counter)
const agentRunStatus = document.getElementById('agent-run-status');

// Status bar elements
const statusDarkmode = document.getElementById('status-darkmode');

// Settings elements
const settingsOverlay = document.getElementById('settings-overlay');
const settingsClose = document.getElementById('settings-close');
const settingsSave = document.getElementById('settings-save');
const settingProvider = document.getElementById('setting-provider');
const settingModel = document.getElementById('setting-model');
const settingApikey = document.getElementById('setting-apikey');
const toggleApikey = document.getElementById('toggle-apikey');
const apikeyStatus = document.getElementById('apikey-status');
const settingSearch = document.getElementById('setting-search');

// Secondary model elements (Phase 8.85)
const secondaryModelFields = document.getElementById('secondary-model-fields');
const settingSecondaryProvider = document.getElementById('setting-secondary-provider');
const settingSecondaryModel = document.getElementById('setting-secondary-model');
const settingSecondaryApikey = document.getElementById('setting-secondary-apikey');
const toggleSecondaryApikey = document.getElementById('toggle-secondary-apikey');

let currentTabs = [];
let activeTabId = null;
let isAgentOpen = false;
let chatMessages = []; // persists across tab switches

// ═══════════════════════════════════════════
//  MARKDOWN RENDERER (marked.js)
// ═══════════════════════════════════════════

// Configure marked with safe defaults
if (typeof marked !== 'undefined') {
  marked.setOptions({
    breaks: true,       // GFM line breaks
    gfm: true,          // GitHub Flavored Markdown
  });

  // Custom renderer: open links in new tabs (external)
  const renderer = new marked.Renderer();
  const origLink = renderer.link.bind(renderer);
  renderer.link = function(token) {
    const html = origLink(token);
    return html.replace('<a ', '<a target="_blank" rel="noopener noreferrer" ');
  };
  marked.use({ renderer });
}

/**
 * Render markdown content safely. Returns HTML string.
 * Falls back to escaped plaintext if marked is not loaded.
 */
function renderMarkdown(text) {
  if (!text) return '';
  if (typeof marked === 'undefined') {
    // Fallback: escaped plaintext
    return '<pre style="white-space:pre-wrap;margin:0;font-family:inherit;font-size:inherit">' + escapeHtml(text) + '</pre>';
  }
  try {
    let html = marked.parse(text);
    // Sanitize with DOMPurify (defense-in-depth alongside CSP)
    html = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(html) : html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    return html;
  } catch (e) {
    return '<pre style="white-space:pre-wrap;margin:0;font-family:inherit;font-size:inherit">' + escapeHtml(text) + '</pre>';
  }
}

// ═══════════════════════════════════════════
//  TOKEN PROGRESS BAR
// ═══════════════════════════════════════════

const TOKEN_CONTEXT_LIMIT = 200000;
let lastTokenTotal = 0;

/**
 * Update the token progress bar with the tokens from the last LLM call.
 * This is NOT cumulative — it's replaced each turn with the latest value.
 * The bar shows inputTokens (context window size — what matters for the 200K limit).
 * The label shows both input and output.
 */
function updateTokenBar(inputTokens, outputTokens) {
  lastTokenTotal = inputTokens;
  const fill = document.getElementById('token-bar-fill');
  const label = document.getElementById('token-bar-label');
  if (!fill || !label) return;

  const pct = Math.min((inputTokens / TOKEN_CONTEXT_LIMIT) * 100, 100);
  fill.style.width = pct + '%';

  // Format: "42.1K / 200K ctx · 1.2K out"
  const fmtK = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'K' : n.toString();
  const limitStr = (TOKEN_CONTEXT_LIMIT / 1000) + 'K';
  if (inputTokens === 0 && (!outputTokens || outputTokens === 0)) {
    label.textContent = '0 / ' + limitStr + ' tokens';
  } else {
    label.textContent = fmtK(inputTokens) + ' / ' + limitStr + ' ctx' + (outputTokens ? ' · ' + fmtK(outputTokens) + ' out' : '');
  }

  // Color coding
  fill.classList.remove('warning', 'danger');
  if (pct >= 80) {
    fill.classList.add('danger');
  } else if (pct >= 60) {
    fill.classList.add('warning');
  }
}

// ═══════════════════════════════════════════
//  TABS
// ═══════════════════════════════════════════

function renderTabs(tabs) {
  currentTabs = tabs;
  tabsContainer.innerHTML = '';

  tabs.forEach((tab, index) => {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.isActive ? ' active' : '') + (tab.isPinned ? ' pinned' : '') + (tab.isAria ? ' aria-tab' : '');
    el.dataset.id = tab.id;
    el.dataset.index = index.toString();

    if (tab.isLoading) {
      const loader = document.createElement('div');
      loader.className = 'tab-loading';
      el.appendChild(loader);
    } else if (tab.favicon && !tab.isAria) {
      const img = document.createElement('img');
      img.className = 'tab-favicon';
      img.src = tab.favicon;
      img.onerror = () => { img.style.display = 'none'; };
      el.appendChild(img);
    }

    if (!tab.isPinned) {
      const title = document.createElement('span');
      title.className = 'tab-title';
      title.textContent = tab.title || 'New Tab';
      el.appendChild(title);
    }

    if (tab.isMuted) {
      const muted = document.createElement('span');
      muted.className = 'tab-muted';
      muted.textContent = '🔇';
      muted.title = 'Muted';
      el.appendChild(muted);
    }

    // Phase 8.35: Aria tab has no close button; other unpinned tabs do
    if (!tab.isPinned && !tab.isAria) {
      const close = document.createElement('button');
      close.className = 'tab-close';
      close.textContent = '×';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        window.tappi.closeTab(tab.id);
      });
      el.appendChild(close);
    }

    el.addEventListener('click', () => window.tappi.switchTab(tab.id));
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) { e.preventDefault(); if (!tab.isAria) window.tappi.closeTab(tab.id); }
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!tab.isAria) window.tappi.showContextMenu(tab.id);
    });

    // Drag to reorder (Aria tab is not draggable)
    el.draggable = !tab.isAria;
    if (!tab.isAria) {
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', tab.id);
        requestAnimationFrame(() => el.classList.add('dragging'));
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        document.querySelectorAll('.tab.drag-over').forEach(t => t.classList.remove('drag-over'));
      });
    }
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!tab.isAria) el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const sourceId = e.dataTransfer.getData('text/plain');
      if (sourceId && sourceId !== tab.id) window.tappi.reorderTab(sourceId, index);
    });

    tabsContainer.appendChild(el);

    if (tab.isActive) {
      activeTabId = tab.id;
      updateAddressBar(tab);
    }
  });

  const activeEl = tabsContainer.querySelector('.tab.active');
  if (activeEl) activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
}

// ═══════════════════════════════════════════
//  ADDRESS BAR
// ═══════════════════════════════════════════

function updateAddressBar(tab) {
  if (!tab) return;
  const ssl = document.getElementById('ssl-icon');

  // Phase 8.35: Aria tab shows special non-editable indicator
  if (tab.isAria) {
    urlInput.value = 'Aria — AI Assistant';
    urlInput.readOnly = true;
    urlInput.style.color = 'var(--lotus, #e8a0bf)';
    urlInput.style.cursor = 'default';
    if (ssl) { ssl.innerHTML = ariaIcon(14); ssl.style.opacity = '1'; }
    if (bookmarkBtn) bookmarkBtn.style.display = 'none';
    return;
  }

  urlInput.readOnly = false;
  urlInput.style.color = '';
  urlInput.style.cursor = '';

  if (document.activeElement !== urlInput) {
    if (tab.url && tab.url.startsWith('file://') && tab.url.includes('newtab.html')) {
      urlInput.value = '';
    } else {
      urlInput.value = tab.url || '';
    }
  }

  if (tab.url && tab.url.startsWith('https://')) {
    ssl.textContent = '🔒';
    ssl.style.opacity = '1';
  } else if (tab.url && tab.url.startsWith('http://')) {
    ssl.textContent = '⚠️';
    ssl.style.opacity = '1';
  } else {
    ssl.textContent = '';
    ssl.style.opacity = '0';
  }

  if (bookmarkBtn) {
    bookmarkBtn.textContent = tab.isBookmarked ? '★' : '☆';
    bookmarkBtn.classList.toggle('active', !!tab.isBookmarked);
    const isNewTab = !tab.url || tab.url === 'about:blank' || (tab.url.startsWith('file://') && tab.url.includes('newtab.html'));
    bookmarkBtn.style.display = isNewTab ? 'none' : '';
  }
}

// ═══════════════════════════════════════════
//  AUTOCOMPLETE
// ═══════════════════════════════════════════

const autocompleteDropdown = document.getElementById('autocomplete-dropdown');
let autocompleteItems = [];
let autocompleteSelectedIndex = -1;
let autocompleteDebounce = null;

function showAutocomplete(items) {
  autocompleteItems = items;
  autocompleteSelectedIndex = -1;

  if (items.length === 0) {
    hideAutocomplete();
    return;
  }

  // Push tab view down to make room for dropdown (no page blanking)
  const dropdownHeight = Math.min(items.length * 44, 360);
  window.tappi.setAutocompleteHeight(dropdownHeight);

  autocompleteDropdown.innerHTML = '';
  items.forEach((item, i) => {
    const el = document.createElement('div');
    el.className = 'autocomplete-item';
    const icon = item.type === 'bookmark' ? '★' : item.type === 'history' ? '🕐' : '🔍';
    const showUrl = item.type !== 'suggestion';
    el.innerHTML = `
      <span class="autocomplete-icon">${icon}</span>
      <div class="autocomplete-info">
        <div class="autocomplete-title">${escHtml(item.title || item.url)}</div>
        ${showUrl ? `<div class="autocomplete-url">${escHtml(item.url)}</div>` : ''}
      </div>
      ${item.type === 'bookmark' ? '<span class="autocomplete-badge">Bookmark</span>' : ''}
      ${item.type === 'suggestion' ? '<span class="autocomplete-badge" style="background:var(--border);color:var(--text-secondary)">Search</span>' : ''}
    `;
    el.addEventListener('click', () => selectAutocomplete(i));
    el.addEventListener('mouseenter', () => {
      autocompleteSelectedIndex = i;
      highlightAutocomplete();
    });
    autocompleteDropdown.appendChild(el);
  });

  autocompleteDropdown.classList.remove('hidden');
}

function hideAutocomplete() {
  const wasVisible = !autocompleteDropdown.classList.contains('hidden');
  autocompleteDropdown.classList.add('hidden');
  autocompleteItems = [];
  autocompleteSelectedIndex = -1;
  // Restore tab position
  if (wasVisible) window.tappi.setAutocompleteHeight(0);
}

function highlightAutocomplete() {
  const children = autocompleteDropdown.children;
  for (let i = 0; i < children.length; i++) {
    children[i].classList.toggle('selected', i === autocompleteSelectedIndex);
  }
}

function selectAutocomplete(index) {
  const item = autocompleteItems[index];
  if (!item) return;
  urlInput.value = item.url;
  hideAutocomplete();
  if (activeTabId) {
    window.tappi.navigate(activeTabId, item.url);
    urlInput.blur();
  }
}

async function updateAutocomplete(query) {
  if (!query || query.length < 2) {
    hideAutocomplete();
    return;
  }

  // Check if input looks like a URL (has a dot, no spaces)
  const isUrl = /^[^\s]+\.[^\s]+$/.test(query);

  try {
    // Fetch history + Google suggestions in parallel
    const [historyResults, suggestions] = await Promise.all([
      window.tappi.searchHistory(query, 5).catch(() => []),
      isUrl ? Promise.resolve([]) : fetchGoogleSuggestions(query).catch(() => []),
    ]);

    const items = [];

    // History results first
    for (const r of historyResults) {
      items.push({
        url: r.url,
        title: r.title || r.domain,
        type: 'history',
      });
    }

    // Google suggestions (dedupe against history)
    const historyUrls = new Set(items.map(i => i.title.toLowerCase()));
    for (const s of suggestions.slice(0, 5)) {
      if (!historyUrls.has(s.toLowerCase())) {
        items.push({
          url: `https://www.google.com/search?q=${encodeURIComponent(s)}`,
          title: s,
          type: 'suggestion',
        });
      }
    }

    showAutocomplete(items);
  } catch {
    hideAutocomplete();
  }
}

async function fetchGoogleSuggestions(query) {
  try {
    return await window.tappi.getSearchSuggestions(query);
  } catch {
    return [];
  }
}

urlInput.addEventListener('input', () => {
  clearTimeout(autocompleteDebounce);
  autocompleteDebounce = setTimeout(() => {
    updateAutocomplete(urlInput.value.trim());
  }, 150);
});

urlInput.addEventListener('keydown', (e) => {
  // Autocomplete navigation
  if (!autocompleteDropdown.classList.contains('hidden') && autocompleteItems.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      autocompleteSelectedIndex = Math.min(autocompleteSelectedIndex + 1, autocompleteItems.length - 1);
      highlightAutocomplete();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      autocompleteSelectedIndex = Math.max(autocompleteSelectedIndex - 1, -1);
      highlightAutocomplete();
      return;
    }
    if (e.key === 'Enter' && autocompleteSelectedIndex >= 0) {
      e.preventDefault();
      selectAutocomplete(autocompleteSelectedIndex);
      return;
    }
  }

  if (e.key === 'Enter' && activeTabId) {
    hideAutocomplete();
    const value = urlInput.value.trim();
    if (value) {
      window.tappi.navigate(activeTabId, value);
      urlInput.blur();
    }
  }

  if (e.key === 'Escape') {
    hideAutocomplete();
  }
});

urlInput.addEventListener('focus', () => {
  setTimeout(() => urlInput.select(), 0);
  // Show recent history on empty focus
  if (!urlInput.value.trim()) {
    window.tappi.getRecentHistory(6).then(results => {
      if (results && results.length > 0 && document.activeElement === urlInput) {
        showAutocomplete(results.map(r => ({
          url: r.url,
          title: r.title || r.domain,
          type: 'history',
        })));
      }
    });
  }
});

// Prevent blur from hiding autocomplete when clicking inside the dropdown
autocompleteDropdown.addEventListener('mousedown', (e) => {
  e.preventDefault(); // Prevents urlInput blur
});

urlInput.addEventListener('blur', () => {
  // Small delay as safety net
  setTimeout(hideAutocomplete, 150);
});

if (bookmarkBtn) {
  bookmarkBtn.addEventListener('click', () => {
    const active = currentTabs.find(t => t.isActive);
    if (active && active.url) window.tappi.toggleBookmark(active.url);
  });
}

btnBack.addEventListener('click', () => window.tappi.goBack());
btnForward.addEventListener('click', () => window.tappi.goForward());
btnReload.addEventListener('click', () => window.tappi.reload());
newTabBtn.addEventListener('click', () => window.tappi.createTab());

tabsContainer.addEventListener('wheel', (e) => {
  e.preventDefault();
  tabsContainer.scrollLeft += e.deltaY;
}, { passive: false });

// ═══════════════════════════════════════════
//  OVERFLOW MENU
// ═══════════════════════════════════════════

// Overflow menu — native popup via main process (renders above BrowserViews)
btnOverflow.addEventListener('click', () => {
  window.tappi.showOverflowMenu();
});

// ═══════════════════════════════════════════
//  FIND BAR
// ═══════════════════════════════════════════

const findBar = document.getElementById('find-bar');
const findInput = document.getElementById('find-input');
const findCount = document.getElementById('find-count');
let findQuery = '';

function openFindBar() {
  findBar.classList.remove('hidden');
  findInput.value = '';
  findCount.textContent = '';
  window.tappi.setFindBarOpen(true);
  findInput.focus();
}

function closeFindBar() {
  findBar.classList.add('hidden');
  findQuery = '';
  findCount.textContent = '';
  window.tappi.stopFind();
  window.tappi.setFindBarOpen(false);
}

findInput.addEventListener('input', () => {
  const text = findInput.value;
  findQuery = text;
  if (text) {
    window.tappi.findOnPage(text);
  } else {
    findCount.textContent = '';
    window.tappi.stopFind();
  }
});

findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) {
      window.tappi.findOnPage(findQuery, { forward: false });
    } else {
      window.tappi.findOnPage(findQuery, { forward: true });
    }
  }
  if (e.key === 'Escape') {
    closeFindBar();
  }
});

document.getElementById('find-next').addEventListener('click', () => {
  if (findQuery) window.tappi.findOnPage(findQuery, { forward: true });
});
document.getElementById('find-prev').addEventListener('click', () => {
  if (findQuery) window.tappi.findOnPage(findQuery, { forward: false });
});
document.getElementById('find-close').addEventListener('click', closeFindBar);

window.tappi.onFindResult((result) => {
  if (result.matches > 0) {
    findCount.textContent = `${result.activeMatchOrdinal}/${result.matches}`;
    findCount.style.color = '';
  } else {
    findCount.textContent = 'No matches';
    findCount.style.color = 'var(--accent)';
  }
});

// ═══════════════════════════════════════════
//  HISTORY PANEL
// ═══════════════════════════════════════════

const historyOverlay = document.getElementById('history-overlay');
const historyList = document.getElementById('history-list');
const historySearch = document.getElementById('history-search');

function openHistoryPanel() {
  window.tappi.showOverlay();
  historyOverlay.classList.remove('hidden');
  historySearch.value = '';
  loadHistory();
  historySearch.focus();
}

function closeHistoryPanel() {
  historyOverlay.classList.add('hidden');
  window.tappi.hideOverlay();
}

async function loadHistory(query) {
  let items;
  if (query && query.length >= 2) {
    items = await window.tappi.searchHistory(query, 50);
  } else {
    items = await window.tappi.getRecentHistory(50);
  }
  renderHistoryList(items);
}

function renderHistoryList(items) {
  if (!items || items.length === 0) {
    historyList.innerHTML = '<div class="panel-list-empty">No history found</div>';
    return;
  }
  historyList.innerHTML = items.map(item => {
    const time = new Date(item.visit_time).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    const favicon = `https://www.google.com/s2/favicons?domain=${item.domain}&sz=32`;
    return `
      <div class="panel-list-item" data-url="${escapeAttr(item.url)}">
        <img class="panel-item-favicon" src="${favicon}" onerror="this.style.display='none'">
        <div class="panel-item-info">
          <div class="panel-item-title">${escapeHtml(item.title || item.url)}</div>
          <div class="panel-item-url">${escapeHtml(item.url)}</div>
        </div>
        <span class="panel-item-meta">${time}</span>
      </div>`;
  }).join('');

  historyList.querySelectorAll('.panel-list-item').forEach(el => {
    el.addEventListener('click', () => {
      const url = el.dataset.url;
      window.tappi.openUrl(url);
      closeHistoryPanel();
    });
  });
}

let historySearchTimer;
historySearch.addEventListener('input', () => {
  clearTimeout(historySearchTimer);
  historySearchTimer = setTimeout(() => loadHistory(historySearch.value), 200);
});

document.getElementById('history-clear-btn').addEventListener('click', async () => {
  if (confirm('Clear all browsing history?')) {
    await window.tappi.clearHistory('all');
    loadHistory();
  }
});

historyOverlay.addEventListener('click', (e) => {
  if (e.target === historyOverlay) closeHistoryPanel();
});

// ═══════════════════════════════════════════
//  BOOKMARKS PANEL
// ═══════════════════════════════════════════

const bookmarksOverlay = document.getElementById('bookmarks-overlay');
const bookmarksList = document.getElementById('bookmarks-list');
const bookmarksSearch = document.getElementById('bookmarks-search');

function openBookmarksPanel() {
  window.tappi.showOverlay();
  bookmarksOverlay.classList.remove('hidden');
  bookmarksSearch.value = '';
  loadBookmarks();
  bookmarksSearch.focus();
}

function closeBookmarksPanel() {
  bookmarksOverlay.classList.add('hidden');
  window.tappi.hideOverlay();
}

async function loadBookmarks(query) {
  let items;
  if (query && query.length >= 2) {
    items = await window.tappi.searchBookmarks(query);
  } else {
    items = await window.tappi.getAllBookmarks();
  }
  renderBookmarksList(items);
}

function renderBookmarksList(items) {
  if (!items || items.length === 0) {
    bookmarksList.innerHTML = '<div class="panel-list-empty">No bookmarks</div>';
    return;
  }
  bookmarksList.innerHTML = items.map(item => {
    const domain = new URL(item.url).hostname;
    const favicon = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
    return `
      <div class="panel-list-item" data-url="${escapeAttr(item.url)}">
        <img class="panel-item-favicon" src="${favicon}" onerror="this.style.display='none'">
        <div class="panel-item-info">
          <div class="panel-item-title">${escapeHtml(item.title || item.url)}</div>
          <div class="panel-item-url">${escapeHtml(item.url)}</div>
        </div>
        <div class="panel-item-actions">
          <button class="panel-item-btn danger" data-remove-url="${escapeAttr(item.url)}" title="Remove">✕</button>
        </div>
      </div>`;
  }).join('');

  bookmarksList.querySelectorAll('.panel-list-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-remove-url]')) return;
      const url = el.dataset.url;
      window.tappi.openUrl(url);
      closeBookmarksPanel();
    });
  });

  bookmarksList.querySelectorAll('[data-remove-url]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const url = btn.dataset.removeUrl;
      await window.tappi.removeBookmark(url);
      loadBookmarks(bookmarksSearch.value);
    });
  });
}

let bookmarksSearchTimer;
bookmarksSearch.addEventListener('input', () => {
  clearTimeout(bookmarksSearchTimer);
  bookmarksSearchTimer = setTimeout(() => loadBookmarks(bookmarksSearch.value), 200);
});

bookmarksOverlay.addEventListener('click', (e) => {
  if (e.target === bookmarksOverlay) closeBookmarksPanel();
});

// ═══════════════════════════════════════════
//  DOWNLOADS PANEL
// ═══════════════════════════════════════════

const downloadsOverlay = document.getElementById('downloads-overlay');
const downloadsList = document.getElementById('downloads-list');

function openDownloadsPanel() {
  window.tappi.showOverlay();
  downloadsOverlay.classList.remove('hidden');
  loadDownloads();
}

function closeDownloadsPanel() {
  downloadsOverlay.classList.add('hidden');
  window.tappi.hideOverlay();
}

async function loadDownloads() {
  const items = await window.tappi.getDownloads();
  renderDownloadsList(items);
}

function renderDownloadsList(items) {
  if (!items || items.length === 0) {
    downloadsList.innerHTML = '<div class="panel-list-empty">No downloads</div>';
    return;
  }
  downloadsList.innerHTML = items.map(item => {
    const sizeStr = item.totalBytes > 0 ? formatBytes(item.totalBytes) : '';
    const progress = item.totalBytes > 0 ? Math.round((item.receivedBytes / item.totalBytes) * 100) : 0;
    const stateClass = item.state === 'completed' ? 'completed' : item.state === 'cancelled' ? 'cancelled' : '';
    const stateLabel = item.state === 'progressing' ? `${progress}% · ${formatBytes(item.receivedBytes)} / ${sizeStr}` :
                       item.state === 'completed' ? '✓ Complete' :
                       item.state === 'cancelled' ? '✕ Cancelled' : item.state;
    return `
      <div class="panel-list-item">
        <div class="panel-item-info">
          <div class="panel-item-title">${escapeHtml(item.filename)}</div>
          <div class="download-state ${stateClass}">${stateLabel}</div>
          ${item.state === 'progressing' ? `<div class="download-progress"><div class="download-progress-bar" style="width:${progress}%"></div></div>` : ''}
        </div>
        ${item.state === 'progressing' ? `<div class="panel-item-actions"><button class="panel-item-btn danger" data-cancel-id="${item.id}" title="Cancel">✕</button></div>` : ''}
      </div>`;
  }).join('');

  downloadsList.querySelectorAll('[data-cancel-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await window.tappi.cancelDownload(btn.dataset.cancelId);
      loadDownloads();
    });
  });
}

document.getElementById('downloads-clear-btn').addEventListener('click', async () => {
  await window.tappi.clearDownloads();
  loadDownloads();
});

downloadsOverlay.addEventListener('click', (e) => {
  if (e.target === downloadsOverlay) closeDownloadsPanel();
});

// Auto-refresh downloads panel when open
window.tappi.onDownloadsUpdated(() => {
  if (!downloadsOverlay.classList.contains('hidden')) {
    loadDownloads();
  }
});

// Close panel buttons
document.querySelectorAll('.panel-close-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const panel = btn.dataset.panel;
    switch (panel) {
      case 'history': closeHistoryPanel(); break;
      case 'bookmarks': closeBookmarksPanel(); break;
      case 'downloads': closeDownloadsPanel(); break;
    }
  });
});

// Status bar downloads click → opens downloads panel
document.getElementById('status-downloads').addEventListener('click', openDownloadsPanel);

// Keyboard shortcuts from Electron menu
window.tappi.onFindOpen(() => openFindBar());
window.tappi.onPanelOpen((panel) => {
  switch (panel) {
    case 'history': openHistoryPanel(); break;
    case 'bookmarks': openBookmarksPanel(); break;
    case 'downloads': openDownloadsPanel(); break;
  }
});

// Helper functions
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ═══════════════════════════════════════════
//  AGENT PANEL
// ═══════════════════════════════════════════

let isStreaming = false;

function setAgentOpen(open) {
  isAgentOpen = open;
  if (open) {
    agentStrip.classList.add('hidden');
    agentPanel.classList.remove('hidden');
    // Show welcome if no messages
    if (chatMessages.length === 0) renderWelcome();
    agentInput.focus();
  } else {
    agentPanel.classList.add('hidden');
    agentStrip.classList.remove('hidden');
  }
}

agentStrip.addEventListener('click', () => window.tappi.toggleAgent());
agentClose.addEventListener('click', () => window.tappi.toggleAgent());

function renderWelcome() {
  agentMessages.innerHTML = `
    <div class="agent-welcome">
      <div class="lotus-big">${ariaIcon(48)}</div>
      <h3>Hi, I'm Aria</h3>
      <p>Your AI browser companion.<br>
      Ask me to navigate, summarize, fill forms, compare products — anything you see on the web.</p>
      <p style="margin-top: 12px"><kbd>⌘J</kbd> to toggle this panel</p>
    </div>
  `;
}

function renderMessages() {
  if (chatMessages.length === 0) {
    renderWelcome();
    return;
  }
  agentMessages.innerHTML = '';
  chatMessages.forEach(msg => {
    const el = document.createElement('div');
    el.className = `agent-msg ${msg.role}`;

    if (msg._raw) {
      // Raw HTML content (deep mode plan cards, etc.) — sanitize for safety
      el.innerHTML = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(msg.content) : msg.content;
    } else if (msg.role === 'tool') {
      // Tool result — compact, dimmed
      el.className = 'agent-msg tool';
      el.textContent = msg.content;
    } else if (msg.role === 'assistant') {
      // Render assistant messages as markdown
      const mdDiv = document.createElement('div');
      mdDiv.className = 'md-content';
      mdDiv.innerHTML = renderMarkdown(msg.content);
      el.style.whiteSpace = 'normal'; // Override pre-wrap for markdown
      el.appendChild(mdDiv);
    } else {
      el.textContent = msg.content;
    }
    agentMessages.appendChild(el);
  });
  // Scroll to bottom
  agentMessages.scrollTop = agentMessages.scrollHeight;
}

function addMessage(role, content) {
  chatMessages.push({ role, content, timestamp: Date.now() });
  renderMessages();
}

// Phase 9.096d: Redirect mode state
let _redirectMode = false;

function sendAgentMessage() {
  if (isStreaming) {
    // If in redirect mode, send interrupt with new instruction
    if (_redirectMode) {
      const msg = agentInput.value.trim();
      if (!msg) return;
      exitRedirectMode();
      // Show redirect notice in chat
      const noticeEl = document.createElement('div');
      noticeEl.className = 'agent-msg redirect-notice';
      noticeEl.textContent = '↪ Redirected: ' + msg;
      agentMessages.appendChild(noticeEl);
      agentMessages.scrollTop = agentMessages.scrollHeight;
      // Send interrupt IPC
      if (window.tappi && window.tappi.interruptAgent) {
        window.tappi.interruptAgent('main', null, msg)
          .then(res => console.log('[app] Interrupt result:', res))
          .catch(err => console.error('[app] Interrupt error:', err));
      }
      return;
    }
    // Normal stop
    window.tappi.stopAgent();
    setStreamingState(false);
    return;
  }
  const text = agentInput.value.trim();
  if (!text) return;
  addMessage('user', text);
  agentInput.value = '';
  agentInput.style.height = 'auto';
  setStreamingState(true);
  window.tappi.sendAgentMessage(text);
}

function enterRedirectMode() {
  _redirectMode = true;
  agentInput.disabled = false;
  agentInput.value = '';
  agentInput.placeholder = 'Enter redirect instructions…';
  agentInput.focus();
  // Show redirect hint above input
  let hint = document.getElementById('agent-redirect-hint');
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'agent-redirect-hint';
    hint.className = 'agent-input-redirect-hint';
    hint.textContent = '✋ Redirect mode — type new instructions and press Enter';
    const inputArea = document.getElementById('agent-input-area');
    if (inputArea && inputArea.parentNode) {
      inputArea.parentNode.insertBefore(hint, inputArea);
    }
  }
  agentSend.textContent = '↪';
  agentSend.title = 'Send redirect instruction';
  if (agentRedirect) agentRedirect.title = 'Cancel redirect';
}

function exitRedirectMode() {
  _redirectMode = false;
  agentInput.placeholder = 'Ask Aria anything...';
  agentInput.value = '';
  agentInput.disabled = true;
  const hint = document.getElementById('agent-redirect-hint');
  if (hint) hint.remove();
}

function setStreamingState(streaming) {
  isStreaming = streaming;
  if (!streaming) {
    // Exit redirect mode if active
    if (_redirectMode) exitRedirectMode();
    agentSend.textContent = '↑';
    agentSend.title = 'Send';
    agentInput.disabled = false;
    agentInput.placeholder = 'Ask Aria anything...';
    if (agentRedirect) agentRedirect.style.display = 'none';
    agentInput.focus();
  } else {
    agentSend.textContent = '⏹';
    agentSend.title = 'Stop';
    agentInput.disabled = true;
    if (agentRedirect) agentRedirect.style.display = '';
  }
}

agentSend.addEventListener('click', sendAgentMessage);

// Phase 9.096d: Redirect button click — enter redirect mode (or cancel it)
if (agentRedirect) {
  agentRedirect.addEventListener('click', () => {
    if (!isStreaming) return;
    if (_redirectMode) {
      // Cancel redirect mode
      exitRedirectMode();
      agentSend.textContent = '⏹';
      agentSend.title = 'Stop';
      agentInput.disabled = true;
    } else {
      enterRedirectMode();
    }
  });
}
agentInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendAgentMessage();
  }
});

// Auto-resize textarea
agentInput.addEventListener('input', () => {
  agentInput.style.height = 'auto';
  agentInput.style.height = Math.min(agentInput.scrollHeight, 120) + 'px';
});

// Listen for agent toggle from main process (Cmd+J)
window.tappi.onAgentToggled((open) => setAgentOpen(open));

// Fix 2: Hide/show agent strip+panel based on active tab.
// When the Aria tab is active, the agent sidebar is hidden entirely (redundant with aria.html).
// When a regular tab is active, restore normal agent strip/panel state.
if (window.tappi.onAgentVisible) {
  window.tappi.onAgentVisible((visible) => {
    if (!visible) {
      // Aria tab active — hide both strip and panel regardless of isAgentOpen
      if (agentStrip) agentStrip.classList.add('hidden');
      if (agentPanel) agentPanel.classList.add('hidden');
    } else {
      // Regular tab — restore appropriate state based on isAgentOpen
      setAgentOpen(isAgentOpen);
    }
  });
}

// Listen for agent responses
window.tappi.onAgentResponse((msg) => {
  addMessage(msg.role, msg.content);
});

// Stream start — prepare for new assistant message
window.tappi.onAgentStreamStart(() => {
  // Will be filled by stream chunks
});

// Stream chunks — uses fast incremental rendering during stream, full markdown on done
let _streamRenderTimer = null;
window.tappi.onAgentStreamChunk((chunk) => {
  // Find last assistant message or create one
  const last = chatMessages.length > 0 ? chatMessages[chatMessages.length - 1] : null;
  if (last && last.role === 'assistant' && !last._done) {
    last.content += chunk.text;
    if (chunk.done) last._done = true;
  } else {
    chatMessages.push({ role: 'assistant', content: chunk.text, timestamp: Date.now(), _done: chunk.done });
  }

  if (chunk.done) {
    // Final render with full markdown
    clearTimeout(_streamRenderTimer);
    renderMessages();
    setStreamingState(false);
  } else {
    // During streaming: fast incremental update of just the last message
    // Debounce markdown parsing to avoid janky re-renders on every token
    clearTimeout(_streamRenderTimer);
    _streamRenderTimer = setTimeout(() => {
      const msgEl = agentMessages.lastElementChild;
      const lastMsg = chatMessages[chatMessages.length - 1];
      if (msgEl && lastMsg && lastMsg.role === 'assistant' && !lastMsg._done) {
        const mdDiv = msgEl.querySelector('.md-content');
        if (mdDiv) {
          mdDiv.innerHTML = renderMarkdown(lastMsg.content);
        } else {
          // First chunk — create the md-content div
          msgEl.innerHTML = '';
          msgEl.style.whiteSpace = 'normal';
          const newMd = document.createElement('div');
          newMd.className = 'md-content';
          newMd.innerHTML = renderMarkdown(lastMsg.content);
          msgEl.appendChild(newMd);
        }
        agentMessages.scrollTop = agentMessages.scrollHeight;
      }
    }, 80); // re-render markdown at most ~12fps during streaming

    // But also do immediate append for responsiveness if no md-content yet
    const msgEl = agentMessages.lastElementChild;
    if (!msgEl || msgEl.className !== 'agent-msg assistant') {
      // Need to create the message element
      renderMessages();
    }
  }
});

// Tool results — show inline
window.tappi.onAgentToolResult((result) => {
  addMessage('tool', result.display);
});

// ─── Reasoning / thinking chip (sidebar agent panel) ───
let _sidebarThinkingChip = null;
window.tappi.onAgentReasoningChunk(({ text, done }) => {
  const container = document.getElementById('agent-messages');
  if (!container) return;

  if (!_sidebarThinkingChip) {
    _sidebarThinkingChip = document.createElement('div');
    _sidebarThinkingChip.className = 'agent-thinking-chip';
    _sidebarThinkingChip.innerHTML = `
      <div class="thinking-chip-header">
        <span class="thinking-chip-icon">🧠</span>
        <span class="thinking-chip-label">Thinking…</span>
        <span class="thinking-chip-toggle">▾</span>
      </div>
      <div class="thinking-chip-body"></div>`;
    const header = _sidebarThinkingChip.querySelector('.thinking-chip-header');
    if (header) header.addEventListener('click', () => _sidebarThinkingChip?.classList.toggle('expanded'));
    container.appendChild(_sidebarThinkingChip);
    _sidebarThinkingChip.classList.add('expanded');
    container.scrollTop = container.scrollHeight;
  }

  const body = _sidebarThinkingChip.querySelector('.thinking-chip-body');
  if (body) body.textContent = text;
  container.scrollTop = container.scrollHeight;

  if (done) {
    const label = _sidebarThinkingChip.querySelector('.thinking-chip-label');
    if (label) label.textContent = `Thought (${text.length} chars) — click to expand`;
    _sidebarThinkingChip.classList.remove('expanded');
    _sidebarThinkingChip = null;
  }
});

// Token usage update (Phase 8.25) — total tokens from last LLM call
// inputTokens = context window size (what matters for the 200K limit)
// totalTokens = input + output
window.tappi.onAgentTokenUsage((data) => {
  updateTokenBar(data.inputTokens, data.outputTokens);
});

// Agent cleared
window.tappi.onAgentCleared(() => {
  chatMessages = [];
  renderWelcome();
  updateTokenBar(0, 0); // Reset token bar on new chat
});

// Handle non-streamed responses (fallback/text-command mode)
// Override to also stop streaming state
const origOnResponse = window.tappi.onAgentResponse;
window.tappi.onAgentResponse((msg) => {
  addMessage(msg.role, msg.content);
  setStreamingState(false);
});

// ═══════════════════════════════════════════
//  DEEP MODE
// ═══════════════════════════════════════════

// Toggle button in agent header
const toggleDeepBtn = document.getElementById('toggle-deep');
if (toggleDeepBtn) {
  toggleDeepBtn.addEventListener('click', async () => {
    const isOn = toggleDeepBtn.classList.contains('on');
    const newVal = !isOn;
    toggleDeepBtn.classList.toggle('on', newVal);
    toggleDeepBtn.textContent = newVal ? '🧠 Deep' : '🧠 Off';
    // Also sync with settings toggle
    const settingsToggle = document.getElementById('toggle-deep-settings');
    if (settingsToggle) updateToggle('toggle-deep-settings', newVal);
    // Save to config
    await window.tappi.saveConfig({ llm: { deepMode: newVal } });
  });
}

// Track deep mode subtask text for rendering
let deepSubtaskText = {};
let _deepToolDataApp = {};
let _deepTotalStepsApp = 0;
let _deepDoneStepsApp = 0;
let _deepOutputDirApp = null;
let _deepParallelMode = false;

// Deep mode plan — show subtask cards with progress bar
window.tappi.onDeepPlan((data) => {
  const { mode, subtasks, parallel } = data;
  deepSubtaskText = {};
  _deepToolDataApp = {};
  _deepTotalStepsApp = subtasks.length;
  _deepDoneStepsApp = 0;
  _deepOutputDirApp = null;
  _deepParallelMode = !!parallel;

  let html = '<div class="deep-plan">';
  html += `<div class="deep-plan-header">📋 ${subtasks.length} steps <span class="deep-plan-mode ${mode}">${mode}</span>${parallel ? ' <span class="deep-plan-mode parallel">⚡ parallel</span>' : ''}</div>`;
  html += `<div class="deep-progress-bar"><div class="deep-progress-fill" id="deep-progress"></div></div>`;

  subtasks.forEach((s, i) => {
    html += `<div class="deep-step" id="deep-step-${i}">`;
    html += `<div class="deep-step-header" data-step-index="${i}">`;
    html += `<span class="deep-chevron" id="deep-chevron-${i}">▶</span>`;
    html += `<span class="deep-step-status" id="deep-status-${i}">⏳</span>`;
    html += `<span class="deep-step-title"><b>${i + 1}.</b> ${escapeHtml(s.task.slice(0, 80))}${s.task.length > 80 ? '...' : ''}</span>`;
    html += `<span class="deep-step-duration" id="deep-dur-${i}"></span>`;
    html += '</div>';
    html += `<div class="deep-step-tools" id="deep-tools-${i}"></div>`;
    html += `<div class="deep-step-stream" id="deep-stream-${i}"></div>`;
    html += '</div>';
  });

  html += '</div>';
  chatMessages.push({ role: 'assistant', content: html, _raw: true, timestamp: Date.now(), _done: false });
  renderMessages();
});

function _updateDeepProgressApp() {
  const fill = document.getElementById('deep-progress');
  if (fill && _deepTotalStepsApp > 0) {
    fill.style.width = Math.round((_deepDoneStepsApp / _deepTotalStepsApp) * 100) + '%';
  }
}

// Toggle subtask stream visibility
window._toggleDeepStep = function(idx) {
  const stream = document.getElementById('deep-stream-' + idx);
  const chev = document.getElementById('deep-chevron-' + idx);
  if (!stream) return;
  const visible = stream.classList.contains('visible');
  stream.classList.toggle('visible', !visible);
  if (chev) chev.classList.toggle('open', !visible);
};

window._toggleToolDetailApp = function(idx, toolIdx) {
  const detail = document.getElementById(`deep-tool-detail-${idx}-${toolIdx}`);
  if (detail) detail.classList.toggle('visible');
};

// Subtask start
window.tappi.onDeepSubtaskStart((data) => {
  const { index } = data;
  const el = document.getElementById('deep-step-' + index);
  const status = document.getElementById('deep-status-' + index);
  const stream = document.getElementById('deep-stream-' + index);
  const chev = document.getElementById('deep-chevron-' + index);

  if (el) el.classList.add('active');
  if (status) status.textContent = '⟳';
  if (stream) {
    stream.innerHTML = '<em style="color:var(--text-dim)">Working...</em>';
    stream.classList.add('visible', 'streaming');
  }
  if (chev) chev.classList.add('open');
  deepSubtaskText[index] = '';
  _deepToolDataApp[index] = [];

  // In sequential mode, collapse other streams. In parallel mode, keep all visible.
  if (!_deepParallelMode) {
    document.querySelectorAll('.deep-step-stream.visible').forEach(s => {
      const id = parseInt(s.id.replace('deep-stream-', ''));
      if (id !== index && !isNaN(id)) {
        s.classList.remove('visible', 'streaming');
        const c = document.getElementById('deep-chevron-' + id);
        if (c) c.classList.remove('open');
      }
    });
  }

  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

// Subtask done
window.tappi.onDeepSubtaskDone((data) => {
  const { index, status, duration, error } = data;
  const el = document.getElementById('deep-step-' + index);
  const statusEl = document.getElementById('deep-status-' + index);
  const durEl = document.getElementById('deep-dur-' + index);
  const stream = document.getElementById('deep-stream-' + index);

  if (el) {
    el.classList.remove('active');
    el.classList.add(status === 'done' ? 'done' : 'failed');
  }
  if (statusEl) statusEl.textContent = status === 'done' ? '✅' : '❌';
  if (durEl && duration) durEl.textContent = duration.toFixed(1) + 's';
  if (stream) stream.classList.remove('streaming');

  if (error && stream) {
    stream.innerHTML = `<span style="color:#ef4444">❌ ${escapeHtml(error)}</span>`;
    stream.classList.add('visible');
  }

  // Auto-collapse done steps after a brief moment
  if (status === 'done' && stream) {
    setTimeout(() => {
      stream.classList.remove('visible');
      const chev = document.getElementById('deep-chevron-' + index);
      if (chev) chev.classList.remove('open');
    }, 800);
  }

  if (status === 'done') {
    _deepDoneStepsApp++;
    _updateDeepProgressApp();
  }
});

// Subtask stream chunk — render with markdown
let _deepStreamTimers = {};
window.tappi.onDeepStreamChunk((data) => {
  const { index, chunk } = data;
  const stream = document.getElementById('deep-stream-' + index);
  if (!stream) return;

  deepSubtaskText[index] = (deepSubtaskText[index] || '') + chunk;
  stream.classList.add('visible', 'streaming');

  clearTimeout(_deepStreamTimers[index]);
  _deepStreamTimers[index] = setTimeout(() => {
    const mdDiv = document.createElement('div');
    mdDiv.className = 'md-content';
    mdDiv.innerHTML = renderMarkdown(deepSubtaskText[index]);
    stream.innerHTML = '';
    stream.appendChild(mdDiv);
    stream.scrollTop = stream.scrollHeight;
  }, 80);
});

// Deep mode reasoning / thinking chips (per-subtask)
let _deepThinkingChipsSidebar = {};
if (window.tappi.onDeepReasoningChunk) {
  window.tappi.onDeepReasoningChunk(({ index, text, done }) => {
    if (index == null) return;
    const stream = document.getElementById('deep-stream-' + index);
    if (!stream) return;

    if (!_deepThinkingChipsSidebar[index]) {
      const chip = document.createElement('div');
      chip.className = 'agent-thinking-chip';
      chip.innerHTML = `
        <div class="thinking-chip-header">
          <span class="thinking-chip-icon">🧠</span>
          <span class="thinking-chip-label">Thinking…</span>
          <span class="thinking-chip-toggle">▾</span>
        </div>
        <div class="thinking-chip-body"></div>`;
      const header = chip.querySelector('.thinking-chip-header');
      if (header) header.addEventListener('click', () => chip.classList.toggle('expanded'));
      stream.classList.add('visible');
      stream.insertBefore(chip, stream.firstChild);
      chip.classList.add('expanded');
      _deepThinkingChipsSidebar[index] = chip;
    }

    const chip = _deepThinkingChipsSidebar[index];
    const body = chip.querySelector('.thinking-chip-body');
    if (body) body.textContent = text;
    stream.scrollTop = stream.scrollHeight;

    if (done) {
      const label = chip.querySelector('.thinking-chip-label');
      if (label) label.textContent = `Thought (${text.length} chars) — click to expand`;
      chip.classList.remove('expanded');
      _deepThinkingChipsSidebar[index] = null;
    }
  });
}

// Tool results as compact chips (Claude.ai-inspired)
window.tappi.onDeepToolResult((data) => {
  const { index, toolName, display } = data;
  const toolsDiv = document.getElementById('deep-tools-' + index);
  if (!toolsDiv) return;

  if (!_deepToolDataApp[index]) _deepToolDataApp[index] = [];
  const toolIdx = _deepToolDataApp[index].length;

  const fullText = display || toolName || 'tool';
  const shortName = (toolName || 'tool').replace(/_/g, ' ');
  let summary = '';
  const lines = fullText.split('\n');
  if (lines.length > 1) {
    summary = lines[1].slice(0, 40).trim();
    if (lines[1].length > 40) summary += '…';
  } else if (fullText.includes('→')) {
    summary = fullText.split('→').slice(1).join('→').trim().slice(0, 40);
  }

  _deepToolDataApp[index].push({ toolName, summary, detail: fullText });

  const chip = document.createElement('span');
  chip.className = 'deep-tool-chip';
  chip.onclick = () => window._toggleToolDetailApp(index, toolIdx);
  chip.innerHTML = `<span class="tool-icon">🔧</span><span class="tool-name">${escapeHtml(shortName)}</span>${summary ? `<span class="tool-summary">— ${escapeHtml(summary)}</span>` : ''}`;
  toolsDiv.appendChild(chip);

  const detail = document.createElement('div');
  detail.className = 'deep-tool-detail';
  detail.id = `deep-tool-detail-${index}-${toolIdx}`;
  detail.textContent = fullText.replace(/^🔧\s*/, '');
  toolsDiv.appendChild(detail);
});

// Deep mode complete — append summary + download button to the existing plan card
window.tappi.onDeepComplete((data) => {
  const { mode, durationSeconds, outputDir, outputDirAbsolute, aborted, completedSteps, totalSteps, finalOutput } = data;
  const statusStr = aborted ? '⚠️ Aborted' : '✅ Complete';

  // Build the completion HTML
  let completeHtml = '<div class="deep-complete">';
  completeHtml += `<div class="deep-complete-summary">${statusStr} — ${mode} mode, ${completedSteps}/${totalSteps} steps in ${durationSeconds.toFixed(1)}s</div>`;
  completeHtml += '<div class="deep-complete-actions">';
  if (mode === 'research' && !aborted && outputDirAbsolute) {
    _deepOutputDirApp = outputDirAbsolute;
    completeHtml += `<div class="deep-download-group">`;
    completeHtml += `<button class="deep-download-btn" data-format="md">📥 .md</button>`;
    completeHtml += `<button class="deep-download-btn" data-format="html">📥 .html</button>`;
    completeHtml += `<button class="deep-download-btn" data-format="pdf">📥 .pdf</button>`;
    completeHtml += `<button class="deep-download-btn" data-format="txt">📥 .txt</button>`;
    completeHtml += `</div>`;
  }
  completeHtml += '</div>';
  completeHtml += '</div>';

  // Append the completion card to the existing plan card (last _raw message)
  // instead of creating a separate message
  const planCard = document.querySelector('.deep-plan');
  if (planCard) {
    // If research mode with final output, render it as markdown inside the plan card
    // (the compile step stream may have already shown it, but re-render clean)
    if (mode === 'research' && !aborted && finalOutput) {
      // Find the compile step's stream div and render markdown there
      const compileIndex = totalSteps - 1; // compile is always last
      const compileStream = document.getElementById('deep-stream-' + compileIndex);
      if (compileStream) {
        const mdDiv = document.createElement('div');
        mdDiv.className = 'md-content';
        mdDiv.innerHTML = renderMarkdown(finalOutput);
        compileStream.innerHTML = '';
        compileStream.appendChild(mdDiv);
        compileStream.classList.add('visible');
        const chev = document.getElementById('deep-chevron-' + compileIndex);
        if (chev) chev.classList.add('open');
      }
    }

    // Append completion summary + download button at the end of the plan card
    const completeEl = document.createElement('div');
    completeEl.innerHTML = completeHtml;
    planCard.appendChild(completeEl.firstElementChild);

    // Update the _raw message content so it persists on re-render
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i]._raw && chatMessages[i].content.includes('deep-plan')) {
        chatMessages[i].content = planCard.outerHTML;
        chatMessages[i]._done = true;
        break;
      }
    }
  } else {
    // Fallback: push as separate message if plan card not found
    chatMessages.push({ role: 'assistant', content: completeHtml, _raw: true, timestamp: Date.now(), _done: true });
    renderMessages();
  }

  // Fill progress
  _deepDoneStepsApp = _deepTotalStepsApp;
  _updateDeepProgressApp();

  setStreamingState(false);
});

window._downloadReportApp = async function(format) {
  if (!_deepOutputDirApp) return;
  const fmt = format || 'md';
  try {
    const result = await window.tappi.saveDeepReport(_deepOutputDirApp, fmt);
    if (result && result.success) {
      chatMessages.push({ role: 'system', content: `📥 Report saved to ${result.path}`, timestamp: Date.now() });
      renderMessages();
    } else if (result && result.error && result.error !== 'Cancelled') {
      chatMessages.push({ role: 'system', content: `❌ Save failed: ${result.error}`, timestamp: Date.now() });
      renderMessages();
    }
  } catch (e) {
    console.error('[app] Failed to save deep report:', e);
  }
};

// ─── Deep mode event delegation (CSP-safe, no inline onclick) ───
// Handles .deep-step-header toggles and .deep-download-btn clicks
// via a single delegated listener on agentMessages.
agentMessages.addEventListener('click', (e) => {
  // Deep step header toggle
  const header = e.target.closest('.deep-step-header');
  if (header) {
    const step = header.closest('.deep-step');
    if (step && step.id) {
      const idx = parseInt(step.id.replace('deep-step-', ''), 10);
      if (!isNaN(idx)) window._toggleDeepStep(idx);
    }
    return;
  }

  // Download format button
  const dlBtn = e.target.closest('.deep-download-btn');
  if (dlBtn) {
    const fmt = dlBtn.dataset.format || 'md';
    window._downloadReportApp(fmt);
    return;
  }
});

// ═══════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════

let currentSettingsTab = 'general';
let apiEditingService = null; // null = add mode, string = editing service name

// Provider-specific field elements
const settingBaseurl = document.getElementById('setting-baseurl');
const settingEndpoint = document.getElementById('setting-endpoint');
const settingRegion = document.getElementById('setting-region');
const settingProjectid = document.getElementById('setting-projectid');
const settingLocation = document.getElementById('setting-location');
const credentialStatus = document.getElementById('credential-status');
const credIcon = document.getElementById('cred-icon');
const credLabel = document.getElementById('cred-label');
const credDetails = document.getElementById('cred-details');
const btnCredRecheck = document.getElementById('btn-cred-recheck');
const btnTestConnection = document.getElementById('btn-test-connection');
const testResult = document.getElementById('test-result');
const ollamaModels = document.getElementById('ollama-models');
const ollamaModelList = document.getElementById('ollama-model-list');

// Providers that support auto-detect credentials
const AUTO_DETECT_PROVIDERS = ['bedrock', 'vertex', 'azure', 'ollama'];
// Providers that need an API key (manual entry)
const API_KEY_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter', 'azure'];

/**
 * Show/hide provider-specific fields based on selected provider.
 */
function updateProviderFields(provider) {
  // Show/hide each field row based on data-providers attribute
  document.querySelectorAll('.provider-field').forEach(row => {
    const providers = (row.dataset.providers || '').split(' ');
    row.classList.toggle('hidden', !providers.includes(provider));
  });

  // Show credential status panel for auto-detect providers
  if (AUTO_DETECT_PROVIDERS.includes(provider)) {
    credentialStatus.classList.remove('hidden');
    runCredentialCheck(provider);
  } else {
    credentialStatus.classList.add('hidden');
  }

  // Show Ollama model list panel
  ollamaModels.classList.toggle('hidden', provider !== 'ollama');

  // Update placeholders per provider
  const placeholders = {
    anthropic: { key: 'sk-ant-...', model: 'claude-sonnet-4-6' },
    openai: { key: 'sk-...', model: 'gpt-4o' },
    google: { key: 'AI...', model: 'gemini-2.0-flash' },
    openrouter: { key: 'sk-or-...', model: 'anthropic/claude-sonnet-4-6' },
    ollama: { key: '', model: 'llama3.1', baseUrl: 'http://localhost:11434/v1' },
    bedrock: { key: '', model: 'anthropic.claude-sonnet-4-6-v2:0', region: 'us-east-1' },
    vertex: { key: '', model: 'gemini-2.0-flash', projectId: 'my-project-123', location: 'us-central1' },
    azure: { key: 'Enter API key', model: 'gpt-4o', endpoint: 'https://myresource.openai.azure.com' },
  };
  const ph = placeholders[provider] || placeholders.anthropic;
  if (settingApikey) settingApikey.placeholder = ph.key || 'Enter API key';
  if (settingModel) settingModel.placeholder = ph.model || '';
  if (settingBaseurl && ph.baseUrl) settingBaseurl.placeholder = ph.baseUrl;
  if (settingEndpoint && ph.endpoint) settingEndpoint.placeholder = ph.endpoint;
  if (settingRegion && ph.region) settingRegion.placeholder = ph.region;
  if (settingProjectid && ph.projectId) settingProjectid.placeholder = ph.projectId;
  if (settingLocation && ph.location) settingLocation.placeholder = ph.location;
}

/**
 * Run credential auto-detection for a provider.
 */
async function runCredentialCheck(provider) {
  credIcon.textContent = '⏳';
  credLabel.textContent = 'Checking credentials...';
  credLabel.parentElement.className = 'credential-header';
  credDetails.innerHTML = '';
  testResult.classList.add('hidden');

  try {
    const ollamaUrl = settingBaseurl ? settingBaseurl.value.trim().replace(/\/v1\/?$/, '') : undefined;
    const status = await window.tappi.checkCredentials(provider, { ollamaUrl: ollamaUrl || undefined });

    if (status.found) {
      credIcon.textContent = '✅';
      credLabel.textContent = `Credentials found`;
      credLabel.parentElement.className = 'credential-header found';

      // Render details
      let html = '';
      if (status.source) html += `<div class="cred-row"><span class="cred-key">Source:</span><span class="cred-val">${esc(status.source)}</span></div>`;
      for (const [key, val] of Object.entries(status.details || {})) {
        html += `<div class="cred-row"><span class="cred-key">${esc(key)}:</span><span class="cred-val">${esc(val)}</span></div>`;
      }
      credDetails.innerHTML = html;

      // Ollama: show model list
      if (provider === 'ollama' && status.models && status.models.length > 0) {
        ollamaModels.classList.remove('hidden');
        ollamaModelList.innerHTML = status.models.map(m =>
          `<span class="ollama-model-chip" data-model="${esc(m.name)}" title="${esc(m.size)}">${esc(m.name)}</span>`
        ).join('');
        // Click to select model
        ollamaModelList.querySelectorAll('.ollama-model-chip').forEach(chip => {
          chip.addEventListener('click', () => {
            settingModel.value = chip.dataset.model;
            ollamaModelList.querySelectorAll('.ollama-model-chip').forEach(c => c.classList.remove('selected'));
            chip.classList.add('selected');
          });
        });
        // Mark current model as selected
        const currentModel = settingModel.value;
        if (currentModel) {
          const match = ollamaModelList.querySelector(`[data-model="${currentModel}"]`);
          if (match) match.classList.add('selected');
        }
      }
    } else {
      credIcon.textContent = '❌';
      credLabel.textContent = 'No credentials found';
      credLabel.parentElement.className = 'credential-header not-found';
      if (status.error) {
        credDetails.innerHTML = `<div style="color: rgba(248,113,113,0.8); font-size: 11px;">${esc(status.error)}</div>`;
      }
    }
  } catch (e) {
    credIcon.textContent = '❌';
    credLabel.textContent = 'Check failed';
    credLabel.parentElement.className = 'credential-header not-found';
    credDetails.innerHTML = `<div style="color: rgba(248,113,113,0.8);">${esc(e.message || 'Unknown error')}</div>`;
  }
}

/**
 * Test connection to current provider.
 */
async function runTestConnection() {
  const provider = settingProvider.value;
  testResult.classList.remove('hidden', 'success', 'error');
  testResult.textContent = '⏳ Testing...';
  btnTestConnection.classList.add('loading');

  try {
    const config = {
      apiKey: settingApikey.value.trim() || undefined,
      model: settingModel.value.trim() || undefined,
      region: settingRegion ? settingRegion.value.trim() || undefined : undefined,
      projectId: settingProjectid ? settingProjectid.value.trim() || undefined : undefined,
      location: settingLocation ? settingLocation.value.trim() || undefined : undefined,
      endpoint: settingEndpoint ? settingEndpoint.value.trim() || undefined : undefined,
      baseUrl: settingBaseurl ? settingBaseurl.value.trim().replace(/\/v1\/?$/, '') || undefined : undefined,
    };

    const result = await window.tappi.testConnection(provider, config);
    testResult.textContent = result.success ? `✅ ${result.message}` : `❌ ${result.message}`;
    testResult.className = `credential-test-result ${result.success ? 'success' : 'error'}`;
  } catch (e) {
    testResult.textContent = `❌ ${e.message || 'Test failed'}`;
    testResult.className = 'credential-test-result error';
  } finally {
    btnTestConnection.classList.remove('loading');
  }
}

function esc(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Wire credential check buttons
if (btnCredRecheck) btnCredRecheck.addEventListener('click', () => runCredentialCheck(settingProvider.value));
if (btnTestConnection) btnTestConnection.addEventListener('click', runTestConnection);

// Provider change → update fields + auto-fill default model
settingProvider.addEventListener('change', async () => {
  const provider = settingProvider.value;
  updateProviderFields(provider);
  // Auto-fill default model for the new provider
  const defaultModel = await window.tappi.getDefaultModel(provider);
  if (defaultModel && !settingModel.value.trim()) {
    settingModel.value = defaultModel;
  }
  // Check if the new provider has a saved API key
  const { hasKey } = await window.tappi.hasProviderKey(provider);
  settingApikey.value = hasKey ? '••••••••' : '';
  settingApikey.type = 'password';
  settingApikey.placeholder = 'Enter API key';
  apikeyStatus.textContent = hasKey ? '✓ API key saved' : 'No API key set';
  apikeyStatus.className = hasKey ? 'settings-hint success' : 'settings-hint';
});

function openSettings() {
  window.tappi.showOverlay();
  settingsOverlay.classList.remove('hidden');
  switchSettingsTab('general');
  // Load current config
  window.tappi.getConfig().then(config => {
    if (config.llm) {
      settingProvider.value = config.llm.provider || 'anthropic';
      settingModel.value = config.llm.model || '';
      settingApikey.value = config.hasApiKey ? '••••••••' : '';
      settingApikey.placeholder = 'Enter API key';
      apikeyStatus.textContent = config.hasApiKey ? '✓ API key saved' : 'No API key set';
      apikeyStatus.className = config.hasApiKey ? 'settings-hint success' : 'settings-hint';
      // Cloud provider fields
      if (settingBaseurl) settingBaseurl.value = config.llm.baseUrl || '';
      if (settingEndpoint) settingEndpoint.value = config.llm.endpoint || '';
      if (settingRegion) settingRegion.value = config.llm.region || '';
      if (settingProjectid) settingProjectid.value = config.llm.projectId || '';
      if (settingLocation) settingLocation.value = config.llm.location || '';
      // Thinking toggle
      updateToggle('toggle-thinking', config.llm.thinking !== false); // default ON
      // Deep mode toggle (settings)
      updateToggle('toggle-deep-settings', config.llm.deepMode !== false); // default ON
      // Sync agent header deep toggle
      const deepBtn = document.getElementById('toggle-deep');
      if (deepBtn) {
        const deepOn = config.llm.deepMode !== false;
        deepBtn.classList.toggle('on', deepOn);
        deepBtn.textContent = deepOn ? '🧠 Deep' : '🧠 Off';
      }
      // Update provider-specific field visibility
      updateProviderFields(config.llm.provider || 'anthropic');

      // Secondary model (Phase 8.85)
      const hasSecondary = !!(config.llm.secondaryModel);
      updateToggle('toggle-secondary-model', hasSecondary);
      if (secondaryModelFields) secondaryModelFields.classList.toggle('hidden', !hasSecondary);
      if (settingSecondaryProvider) settingSecondaryProvider.value = config.llm.secondaryProvider || '';
      if (settingSecondaryModel) settingSecondaryModel.value = config.llm.secondaryModel || '';
      if (settingSecondaryApikey) {
        settingSecondaryApikey.value = '';
        settingSecondaryApikey.placeholder = config.hasSecondaryApiKey ? '••••••••' : 'Same as primary';
      }
    }
    if (config.searchEngine) settingSearch.value = config.searchEngine;
    if (config.features) {
      updateToggle('toggle-adblock', config.features.adBlocker);
      updateToggle('toggle-darkmode', config.features.darkMode);
    }
    // Privacy settings
    if (config.privacy) {
      updateToggle('toggle-agent-browsing', config.privacy.agentBrowsingDataAccess || false);
    }
    // Agent timeout (Phase 8.40)
    const timeoutSelect = document.getElementById('agent-timeout-select');
    if (timeoutSelect && config.llm?.agentTimeoutMs !== undefined) {
      timeoutSelect.value = String(config.llm.agentTimeoutMs);
    }
    // Developer mode
    updateToggle('toggle-devmode', config.developerMode || false);
    updateDevModeIndicator(config.developerMode || false);
    // Coding mode (Phase 8.38)
    if (typeof updateCodingModeSection === 'function') {
      updateCodingModeSection(config.developerMode || false);
    }
    if (config.llm && config.llm.codingMode && config.developerMode) {
      if (typeof updateCodingModeUI === 'function') updateCodingModeUI(true);
    }
  });
}

function closeSettings() {
  settingsOverlay.classList.add('hidden');
  window.tappi.hideOverlay();
  hideApiForm();
  hideCronForm();
}

function switchSettingsTab(tabName) {
  currentSettingsTab = tabName;
  document.querySelectorAll('.settings-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tabName);
  });
  document.querySelectorAll('.settings-tab-content').forEach(c => {
    c.classList.toggle('active', c.dataset.tab === tabName);
  });
  if (tabName === 'api-services') loadApiServices();
  if (tabName === 'tools') loadToolsTab();
  if (tabName === 'cron-jobs') loadCronJobs();
  if (tabName === 'profiles') { if (typeof loadProfilesTab === 'function') loadProfilesTab(); }
  if (tabName === 'my-profile') loadMyProfileTab();
}

// Tab switching
document.querySelectorAll('.settings-tab').forEach(tab => {
  tab.addEventListener('click', () => switchSettingsTab(tab.dataset.tab));
});

function updateToggle(id, isOn) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.textContent = isOn ? 'ON' : 'OFF';
  btn.classList.toggle('on', isOn);
}

settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) closeSettings();
});

// Toggle buttons
document.querySelectorAll('.toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const isOn = btn.classList.toggle('on');
    btn.textContent = isOn ? 'ON' : 'OFF';
  });
});

// Show/hide API key — reveals actual key from backend
toggleApikey.addEventListener('click', async () => {
  if (settingApikey.type === 'password') {
    // Revealing — fetch real key if the field has the mask placeholder
    if (settingApikey.value === '••••••••') {
      const result = await window.tappi.revealProviderApiKey();
      if (result && result.key) settingApikey.value = result.key;
    }
    settingApikey.type = 'text';
  } else {
    // Hiding — if the user hasn't edited the key, restore the mask
    settingApikey.type = 'password';
  }
});

// Secondary model toggle (Phase 8.85)
document.getElementById('toggle-secondary-model')?.addEventListener('click', (e) => {
  const btn = e.currentTarget;
  const isOn = btn.classList.toggle('on');
  btn.textContent = isOn ? 'ON' : 'OFF';
  if (secondaryModelFields) {
    secondaryModelFields.classList.toggle('hidden', !isOn);
  }
});

// Show/hide secondary API key
if (toggleSecondaryApikey && settingSecondaryApikey) {
  toggleSecondaryApikey.addEventListener('click', () => {
    settingSecondaryApikey.type = settingSecondaryApikey.type === 'password' ? 'text' : 'password';
  });
}

// Save settings
settingsSave.addEventListener('click', async () => {
  const provider = settingProvider.value;

  // Secondary model (Phase 8.85)
  const secondaryEnabled = document.getElementById('toggle-secondary-model')?.classList.contains('on') || false;
  const secondaryModelValue = secondaryEnabled && settingSecondaryModel ? settingSecondaryModel.value.trim() : '';
  const secondaryProviderValue = secondaryEnabled && settingSecondaryProvider ? settingSecondaryProvider.value.trim() : '';

  const updates = {
    llm: {
      provider,
      model: settingModel.value,
      thinking: document.getElementById('toggle-thinking').classList.contains('on'),
      deepMode: document.getElementById('toggle-deep-settings').classList.contains('on'),
      // Fix 4: codingMode is no longer in Settings — it's toggled via </> button in Aria tab.
      // Don't include it here so settings save doesn't accidentally overwrite it.
      // Cloud provider fields — always send so they get cleared if empty
      region: settingRegion ? settingRegion.value.trim() : undefined,
      projectId: settingProjectid ? settingProjectid.value.trim() : undefined,
      location: settingLocation ? settingLocation.value.trim() : undefined,
      endpoint: settingEndpoint ? settingEndpoint.value.trim() : undefined,
      baseUrl: settingBaseurl ? settingBaseurl.value.trim() : undefined,
      // Secondary model fields (Phase 8.85) — cleared when checkbox is off
      secondaryModel: secondaryModelValue || undefined,
      secondaryProvider: secondaryProviderValue || undefined,
      // Timeout (Phase 8.40)
      agentTimeoutMs: parseInt(document.getElementById('agent-timeout-select')?.value) || 1800000,
    },
    searchEngine: settingSearch.value,
    features: {
      adBlocker: document.getElementById('toggle-adblock').classList.contains('on'),
      darkMode: document.getElementById('toggle-darkmode').classList.contains('on'),
    },
    developerMode: document.getElementById('toggle-devmode').classList.contains('on'),
    privacy: {
      agentBrowsingDataAccess: document.getElementById('toggle-agent-browsing')?.classList.contains('on') || false,
    },
  };

  // Only send API key if user typed a new one
  const rawKey = settingApikey.value.trim();
  if (rawKey && rawKey !== '••••••••') {
    updates.rawApiKey = rawKey;
  }

  // Secondary API key (Phase 8.85) — only send if user typed one; empty clears it (reverts to primary)
  if (settingSecondaryApikey) {
    const rawSecKey = settingSecondaryApikey.value.trim();
    if (rawSecKey && rawSecKey !== '••••••••') {
      updates.rawSecondaryApiKey = rawSecKey;
    } else if (secondaryEnabled && rawSecKey === '') {
      // Explicitly clear secondary key (use primary)
      updates.rawSecondaryApiKey = '';
    }
  }

  const result = await window.tappi.saveConfig(updates);
  if (result.success) {
    apikeyStatus.textContent = '✓ Settings saved';
    apikeyStatus.className = 'settings-hint success';
    // Restore masked value if a key is saved, empty if cleared
    const hasKey = rawKey || settingApikey.value === '••••••••';
    settingApikey.value = hasKey ? '••••••••' : '';
    settingApikey.type = 'password';
    setTimeout(closeSettings, 800);
  }
});

statusDarkmode.addEventListener('click', () => {
  const isActive = statusDarkmode.classList.contains('active');
  const enable = !isActive;
  statusDarkmode.classList.toggle('active');
  document.body.classList.toggle('dark-mode', enable);
  window.tappi.toggleDarkMode(enable);
});

// ═══════════════════════════════════════════
//  API SERVICES
// ═══════════════════════════════════════════

function maskKey(key) {
  if (!key || key.length < 10) return '••••••••';
  return key.slice(0, 6) + '•'.repeat(Math.min(key.length - 10, 20)) + key.slice(-4);
}

async function loadApiServices() {
  const data = await window.tappi.getApiServices();
  renderApiServices(data);
}

function renderApiServices(data) {
  const list = document.getElementById('api-services-list');
  const services = data.services || {};
  const keys = data.keys || {};
  const orphans = data.orphans || [];
  const names = [...Object.keys(services), ...orphans];

  if (names.length === 0) {
    list.innerHTML = `
      <div class="api-empty-state">
        <span class="api-empty-icon">🔗</span>
        <p>No API services configured yet.</p>
        <p class="api-empty-hint">Ask Aria to set up an API, or add one manually above.</p>
      </div>`;
    return;
  }

  list.innerHTML = '';
  for (const name of names) {
    const svc = services[name];
    const hasKey = !!keys[name];

    const card = document.createElement('div');
    card.className = 'api-service-card';
    card.innerHTML = `
      <span class="api-service-status">${hasKey ? '🔑' : '⚠️'}</span>
      <div class="api-service-info">
        <div class="api-service-name">${escHtml(name)}</div>
        ${svc ? `<div class="api-service-url">${escHtml(svc.baseUrl)}</div>` : ''}
        ${svc?.description ? `<div class="api-service-desc">${escHtml(svc.description)}</div>` : ''}
        ${hasKey ? `<div class="api-service-key"><span class="api-key-masked" data-service="${escHtml(name)}" title="Click to reveal">••••••••</span></div>` : `<div class="api-service-key" style="color:var(--accent);font-size:11px">No API key stored</div>`}
      </div>
      <div class="api-service-actions">
        <button class="api-action-btn" title="Edit" data-action="edit" data-service="${escHtml(name)}">✏️</button>
        <button class="api-action-btn danger" title="Delete" data-action="delete" data-service="${escHtml(name)}">🗑</button>
      </div>`;
    list.appendChild(card);
  }

  // Wire up key reveal clicks
  list.querySelectorAll('.api-key-masked').forEach(el => {
    el.addEventListener('click', async () => {
      if (el.classList.contains('revealed')) {
        el.textContent = '••••••••';
        el.classList.remove('revealed');
        return;
      }
      const result = await window.tappi.revealApiKey(el.dataset.service);
      if (result.key) {
        el.textContent = result.key;
        el.classList.add('revealed');
        // Auto-hide after 5 seconds
        setTimeout(() => {
          el.textContent = '••••••••';
          el.classList.remove('revealed');
        }, 5000);
      }
    });
  });

  // Wire up edit/delete buttons
  list.querySelectorAll('.api-action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const svcName = btn.dataset.service;
      if (btn.dataset.action === 'edit') {
        const svcData = services[svcName] || { name: svcName, baseUrl: '', authHeader: 'Bearer', description: '' };
        showApiForm(svcName, svcData);
      } else if (btn.dataset.action === 'delete') {
        if (confirm(`Delete "${svcName}" and its API key?`)) {
          window.tappi.deleteApiService(svcName).then(() => loadApiServices());
        }
      }
    });
  });
}

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function showApiForm(editingName, data) {
  apiEditingService = editingName || null;
  const form = document.getElementById('api-form');
  const title = document.getElementById('api-form-title');
  title.textContent = editingName ? `Edit: ${editingName}` : 'Add API Service';

  document.getElementById('api-name').value = data?.name || '';
  document.getElementById('api-base-url').value = data?.baseUrl || '';
  document.getElementById('api-auth-header').value = data?.authHeader || 'Bearer';
  document.getElementById('api-description').value = data?.description || '';
  document.getElementById('api-key-input').value = '';
  document.getElementById('api-key-input').placeholder = editingName ? 'Leave blank to keep current key' : 'Paste API key';

  form.classList.remove('hidden');
  document.getElementById('api-name').focus();
}

function hideApiForm() {
  document.getElementById('api-form').classList.add('hidden');
  apiEditingService = null;
}

// Add button
document.getElementById('api-add-btn').addEventListener('click', () => showApiForm(null, null));

// Cancel
document.getElementById('api-form-cancel').addEventListener('click', hideApiForm);

// Save
document.getElementById('api-form-save').addEventListener('click', async () => {
  const name = document.getElementById('api-name').value.trim();
  if (!name) { document.getElementById('api-name').focus(); return; }

  const payload = {
    name,
    baseUrl: document.getElementById('api-base-url').value.trim(),
    authHeader: document.getElementById('api-auth-header').value,
    description: document.getElementById('api-description').value.trim(),
    apiKey: document.getElementById('api-key-input').value.trim() || undefined,
  };

  let result;
  if (apiEditingService) {
    result = await window.tappi.updateApiService(apiEditingService, payload);
  } else {
    result = await window.tappi.addApiService(payload);
  }

  if (result.success) {
    hideApiForm();
    loadApiServices();
  }
});

// Toggle show/hide for API form key input
document.getElementById('toggle-api-key').addEventListener('click', () => {
  const inp = document.getElementById('api-key-input');
  inp.type = inp.type === 'password' ? 'text' : 'password';
});

// Listen for live updates (from agent-side changes)
window.tappi.onApiServicesUpdated(() => {
  if (currentSettingsTab === 'api-services') loadApiServices();
});

// ═══════════════════════════════════════════
//  KEYBOARD SHORTCUTS (chrome-level)
// ═══════════════════════════════════════════

document.addEventListener('keydown', (e) => {
  // Escape — close panels
  if (e.key === 'Escape') {
    if (!settingsOverlay.classList.contains('hidden')) {
      closeSettings();
      return;
    }
    if (isAgentOpen) {
      window.tappi.toggleAgent();
      return;
    }
    if (document.activeElement === urlInput) {
      urlInput.blur();
      const active = currentTabs.find(t => t.isActive);
      if (active) {
        if (active.url && active.url.startsWith('file://') && active.url.includes('newtab.html')) {
          urlInput.value = '';
        } else {
          urlInput.value = active.url || '';
        }
      }
    }
  }
});

// ═══════════════════════════════════════════
//  IPC LISTENERS
// ═══════════════════════════════════════════

window.tappi.onTabsUpdated(renderTabs);

window.tappi.onFullscreenChanged((isFullscreen) => {
  document.body.style.display = isFullscreen ? 'none' : '';
});

window.tappi.onFocusAddressBar(() => urlInput.focus());
window.tappi.onSettingsOpen(() => openSettings());
window.tappi.onSettingsSwitchTab((tab) => {
  openSettings();
  switchSettingsTab(tab);
});

window.tappi.onConfigLoaded((config) => {
  // Apply initial feature states to status bar
  if (config.features) {
    statusDarkmode.classList.toggle('active', !!config.features.darkMode);
    document.body.classList.toggle('dark-mode', !!config.features.darkMode);
    if (config.features.adBlocker) {
      document.getElementById('status-adblock').classList.add('active');
    }
  }
  // Developer mode status bar indicator
  updateDevModeIndicator(config.developerMode || false);
});

// ═══════════════════════════════════════════
//  AD BLOCKER STATUS
// ═══════════════════════════════════════════

const statusAdblock = document.getElementById('status-adblock');

window.tappi.onAdBlockCount((count) => {
  statusAdblock.textContent = `🛡 ${count}`;
  statusAdblock.classList.toggle('active', count > 0);
});

// Click on ad blocker status to toggle
statusAdblock.addEventListener('click', async () => {
  const isActive = statusAdblock.classList.contains('active');
  const result = await window.tappi.toggleAdBlocker(!isActive);
  statusAdblock.classList.toggle('active', result.enabled);
  if (!result.enabled) statusAdblock.textContent = '🛡 0';
});

// ═══════════════════════════════════════════
//  DOWNLOAD TRACKING
// ═══════════════════════════════════════════

const statusDownloads = document.getElementById('status-downloads');

window.tappi.onDownloadsUpdated((data) => {
  const activeCount = data.totalActive || 0;
  const completedCount = data.completedCount || 0;
  const total = activeCount + completedCount;

  if (total === 0) {
    statusDownloads.style.display = 'none';
    statusDownloads.classList.remove('downloading');
  } else {
    statusDownloads.style.display = '';
    if (activeCount > 0) {
      const dl = data.active[0];
      statusDownloads.textContent = `⬇ ${activeCount} (${dl.progress}%)`;
      statusDownloads.classList.add('downloading');
    } else {
      statusDownloads.textContent = `⬇ ${completedCount} done`;
      statusDownloads.classList.remove('downloading');
    }
  }
});

// ═══════════════════════════════════════════
//  PASSWORD SAVE PROMPT
// ═══════════════════════════════════════════

const passwordPrompt = document.getElementById('password-prompt');
const passwordPromptDomain = document.getElementById('password-prompt-domain');
let pendingCredential = null;

window.tappi.onVaultSavePrompt((data) => {
  pendingCredential = data;
  passwordPromptDomain.textContent = data.domain;
  passwordPrompt.classList.remove('hidden');
  // Auto-dismiss after 15 seconds
  setTimeout(() => {
    passwordPrompt.classList.add('hidden');
    pendingCredential = null;
  }, 15000);
});

document.getElementById('password-prompt-save').addEventListener('click', async () => {
  if (pendingCredential) {
    // We only have domain + username here — the actual password save
    // happens in the main process via credential interception
    passwordPrompt.classList.add('hidden');
    pendingCredential = null;
  }
});

document.getElementById('password-prompt-dismiss').addEventListener('click', () => {
  passwordPrompt.classList.add('hidden');
  pendingCredential = null;
});

// ─── Developer Mode ───

async function updateDevModeIndicator(enabled) {
  const indicator = document.getElementById('devmode-indicator');
  const statusIcon = document.getElementById('status-devmode');
  const apiSection = document.getElementById('devmode-api-section');
  if (indicator) indicator.classList.toggle('hidden', !enabled);
  if (statusIcon) statusIcon.classList.toggle('hidden', !enabled);
  if (apiSection) {
    apiSection.classList.toggle('hidden', !enabled);
    if (enabled) {
      try {
        const token = await window.tappi.getApiToken();
        const display = document.getElementById('api-token-display');
        if (display) display.textContent = token || '—';
      } catch {}
    }
  }
}

// Copy API token button
const apiTokenCopyBtn = document.getElementById('api-token-copy');
if (apiTokenCopyBtn) {
  apiTokenCopyBtn.addEventListener('click', async () => {
    const token = document.getElementById('api-token-display')?.textContent;
    if (token && token !== '—') {
      try {
        await navigator.clipboard.writeText(token);
        apiTokenCopyBtn.textContent = '✅';
        setTimeout(() => { apiTokenCopyBtn.textContent = '📋'; }, 1500);
      } catch {}
    }
  });
}

// Dev mode toggle with confirmation
document.getElementById('toggle-devmode').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  const isCurrentlyOn = btn.classList.contains('on');

  if (!isCurrentlyOn) {
    // Turning ON — show confirmation
    const confirmed = confirm(
      'Developer Mode gives the AI agent full shell access to your system.\n\n' +
      'The agent will be able to:\n' +
      '• Run any command on your machine\n' +
      '• Install and remove packages\n' +
      '• Start and stop services\n' +
      '• Read and write any file\n' +
      '• Spawn sub-agents\n\n' +
      'Enable Developer Mode?'
    );
    if (!confirmed) {
      // Revert the toggle (the generic handler already toggled it)
      btn.classList.remove('on');
      btn.textContent = 'OFF';
      return;
    }
  }

  updateDevModeIndicator(!isCurrentlyOn);
});

// Listen for dev mode changes from main process
if (window.tappi.onDevModeChanged) {
  window.tappi.onDevModeChanged((enabled) => {
    updateToggle('toggle-devmode', enabled);
    updateDevModeIndicator(enabled);
  });
}

// ─── Tools Tab ───

async function loadToolsTab() {
  const cliList = document.getElementById('cli-tools-list');
  const apiList = document.getElementById('tools-api-list');
  if (!cliList || !apiList) return;

  // Load CLI tools
  try {
    const tools = await window.tappi.getCliTools();
    if (tools.cli && tools.cli.length > 0) {
      cliList.innerHTML = tools.cli.map(t => {
        const statusIcon = t.verified ? '✅' : '⚠️';
        const version = t.version ? `<span class="tool-version">v${t.version}</span>` : '';
        const auth = t.authStatus ? ` <span style="color:${t.authStatus === 'ok' ? '#4caf50' : '#ff9800'}">[${t.authStatus}${t.account ? ': ' + t.account : ''}]</span>` : '';
        const meta = t.installedVia ? `Installed via: ${t.installedVia}` : '';
        return `
          <div class="tool-card">
            <span class="tool-card-status">${statusIcon}</span>
            <div class="tool-card-info">
              <div class="tool-card-name">${t.name}${version}${auth}</div>
              <div class="tool-card-desc">${t.description || ''}</div>
              ${meta ? `<div class="tool-card-meta">${meta}</div>` : ''}
            </div>
          </div>
        `;
      }).join('');
    } else {
      cliList.innerHTML = `
        <div class="api-empty-state">
          <span class="api-empty-icon">🔧</span>
          <p>No CLI tools registered yet.</p>
          <p class="api-empty-hint">Enable Developer Mode and ask Aria to install tools.</p>
        </div>
      `;
    }
  } catch (e) {
    cliList.innerHTML = '<p style="color:#ff5252">Failed to load CLI tools</p>';
  }

  // Load API services (read-only view)
  try {
    const data = await window.tappi.getApiServices();
    const services = data.services || {};
    const keys = data.keys || {};
    const names = Object.keys(services);

    if (names.length > 0) {
      apiList.innerHTML = names.map(name => {
        const svc = services[name];
        const hasKey = keys[name];
        const statusIcon = hasKey ? '🔑' : '⚠️';
        return `
          <div class="tool-card">
            <span class="tool-card-status">${statusIcon}</span>
            <div class="tool-card-info">
              <div class="tool-card-name">${name}</div>
              <div class="tool-card-desc">${svc.description || svc.baseUrl || ''}</div>
            </div>
          </div>
        `;
      }).join('');
    } else {
      apiList.innerHTML = `
        <div class="api-empty-state" style="padding:8px 0">
          <p style="color:rgba(255,255,255,0.4);font-size:12px">No API services configured.</p>
        </div>
      `;
    }
  } catch (e) {
    apiList.innerHTML = '<p style="color:#ff5252">Failed to load API services</p>';
  }
}

// Verify all tools button
document.getElementById('tools-verify-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('tools-verify-btn');
  btn.textContent = '⏳ Verifying...';
  btn.disabled = true;
  try {
    const result = await window.tappi.verifyCliTools();
    await loadToolsTab();
    btn.textContent = '✓ Done';
    setTimeout(() => { btn.textContent = '🔄 Verify All'; btn.disabled = false; }, 2000);
  } catch (e) {
    btn.textContent = '❌ Failed';
    setTimeout(() => { btn.textContent = '🔄 Verify All'; btn.disabled = false; }, 2000);
  }
});

// Auto-refresh tools tab when agent registers/unregisters tools
if (window.tappi.onToolsUpdated) {
  window.tappi.onToolsUpdated(() => {
    if (currentSettingsTab === 'tools') loadToolsTab();
  });
}

// ═══ CRON JOBS TAB ═══

let cronEditingId = null;

function hideCronForm() {
  const form = document.getElementById('cron-form');
  if (form) form.classList.add('hidden');
  cronEditingId = null;
}

function showCronForm(job) {
  const form = document.getElementById('cron-form');
  const title = document.getElementById('cron-form-title');
  form.classList.remove('hidden');

  if (job) {
    cronEditingId = job.id;
    title.textContent = 'Edit Cron Job';
    document.getElementById('cron-name').value = job.name || '';
    document.getElementById('cron-task').value = job.task || '';
    const kind = job.schedule?.kind || 'interval';
    document.getElementById('cron-schedule-kind').value = kind;
    updateCronScheduleFields(kind);
    if (kind === 'interval' && job.schedule.intervalMs) {
      const ms = job.schedule.intervalMs;
      if (ms >= 3600000) {
        document.getElementById('cron-interval-value').value = Math.round(ms / 3600000);
        document.getElementById('cron-interval-unit').value = 'hours';
      } else {
        document.getElementById('cron-interval-value').value = Math.round(ms / 60000);
        document.getElementById('cron-interval-unit').value = 'minutes';
      }
    }
    if (kind === 'daily') document.getElementById('cron-daily-time').value = job.schedule.timeOfDay || '09:00';
    if (kind === 'cron') document.getElementById('cron-expr').value = job.schedule.cronExpr || '';
  } else {
    cronEditingId = null;
    title.textContent = 'Add Cron Job';
    document.getElementById('cron-name').value = '';
    document.getElementById('cron-task').value = '';
    document.getElementById('cron-schedule-kind').value = 'interval';
    document.getElementById('cron-interval-value').value = '60';
    document.getElementById('cron-interval-unit').value = 'minutes';
    document.getElementById('cron-daily-time').value = '09:00';
    document.getElementById('cron-expr').value = '';
    updateCronScheduleFields('interval');
  }
}

function updateCronScheduleFields(kind) {
  document.querySelectorAll('.cron-schedule-field').forEach(el => {
    el.classList.toggle('hidden', el.dataset.kind !== kind);
  });
}

document.getElementById('cron-schedule-kind')?.addEventListener('change', (e) => {
  updateCronScheduleFields(e.target.value);
});

document.getElementById('cron-add-btn')?.addEventListener('click', () => showCronForm(null));
document.getElementById('cron-form-cancel')?.addEventListener('click', hideCronForm);

document.getElementById('cron-form-save')?.addEventListener('click', async () => {
  const name = document.getElementById('cron-name').value.trim();
  const task = document.getElementById('cron-task').value.trim();
  if (!name || !task) return;

  const kind = document.getElementById('cron-schedule-kind').value;
  const schedule = { kind };

  if (kind === 'interval') {
    const val = parseInt(document.getElementById('cron-interval-value').value) || 60;
    const unit = document.getElementById('cron-interval-unit').value;
    schedule.intervalMs = unit === 'hours' ? val * 3600000 : val * 60000;
  } else if (kind === 'daily') {
    schedule.timeOfDay = document.getElementById('cron-daily-time').value || '09:00';
  } else if (kind === 'cron') {
    schedule.cronExpr = document.getElementById('cron-expr').value.trim();
    if (!schedule.cronExpr) return;
  }

  try {
    if (cronEditingId) {
      await window.tappi.updateCronJob(cronEditingId, { name, task, schedule });
    } else {
      await window.tappi.addCronJob({ name, task, schedule });
    }
    hideCronForm();
    loadCronJobs();
  } catch (e) {
    console.error('Failed to save cron job:', e);
  }
});

async function loadCronJobs() {
  const list = document.getElementById('cron-jobs-list');
  if (!list) return;

  try {
    const jobs = await window.tappi.getCronJobs();
    if (!jobs || jobs.length === 0) {
      list.innerHTML = `
        <div class="api-empty-state">
          <span class="api-empty-icon">⏰</span>
          <p>No cron jobs configured yet.</p>
          <p class="api-empty-hint">Ask Aria to schedule a task, or add one manually above.</p>
        </div>
      `;
      return;
    }

    list.innerHTML = jobs.map(job => {
      const statusIcon = job.enabled ? '✅' : '⏸';
      const schedStr = formatCronSchedule(job.schedule);
      const nextStr = job.nextRun && job.enabled ? formatRelativeTime(job.nextRun) : '-';
      const lastStr = job.lastRun
        ? `<span class="last-run ${job.lastStatus || ''}">${job.lastStatus === 'success' ? '✓' : '✗'} ${formatRelativeTime(job.lastRun)}</span>`
        : 'never';
      const taskPreview = job.task.length > 80 ? job.task.slice(0, 80) + '...' : job.task;
      const toggleLabel = job.enabled ? 'Disable' : 'Enable';

      return `
        <div class="cron-job-card ${job.enabled ? '' : 'disabled'}">
          <div class="cron-job-top">
            <span class="cron-job-status">${statusIcon}</span>
            <span class="cron-job-name">${escapeHtml(job.name)}</span>
            <span class="cron-job-schedule">${schedStr}</span>
          </div>
          <div class="cron-job-meta">
            <span class="next-run">Next: ${nextStr}</span> · Last: ${lastStr}
          </div>
          <div class="cron-job-task" title="${escapeHtml(job.task)}">${escapeHtml(taskPreview)}</div>
          <div class="cron-job-actions">
            <button onclick="editCronJob('${job.id}')">Edit</button>
            <button onclick="toggleCronJob('${job.id}', ${!job.enabled})">${toggleLabel}</button>
            <button onclick="runCronJobNow('${job.id}')">Run Now</button>
            <button class="danger" onclick="deleteCronJob('${job.id}')">Delete</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {
    list.innerHTML = '<p style="color:#ff5252">Failed to load cron jobs</p>';
  }
}

function formatCronSchedule(s) {
  if (!s) return '(unknown)';
  switch (s.kind) {
    case 'interval': {
      const ms = s.intervalMs || 60000;
      if (ms >= 3600000) return `every ${(ms / 3600000).toFixed(ms % 3600000 ? 1 : 0)}h`;
      if (ms >= 60000) return `every ${Math.round(ms / 60000)}min`;
      return `every ${Math.round(ms / 1000)}s`;
    }
    case 'daily': return `daily ${s.timeOfDay || '09:00'}`;
    case 'cron': return s.cronExpr || '(invalid)';
    default: return '(unknown)';
  }
}

function formatRelativeTime(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const absDiff = Math.abs(diff);
  const future = diff < 0;
  const secs = Math.floor(absDiff / 1000);
  if (secs < 60) return future ? 'in <1m' : 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return future ? `in ${mins}m` : `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return future ? `in ${days}d` : `${days}d ago`;
}

// Global handlers for cron job actions (called from inline onclick)
window.editCronJob = async function(id) {
  const jobs = await window.tappi.getCronJobs();
  const job = jobs.find(j => j.id === id);
  if (job) showCronForm(job);
};

window.toggleCronJob = async function(id, enabled) {
  await window.tappi.updateCronJob(id, { enabled });
  loadCronJobs();
  updateCronStatusBar();
};

window.runCronJobNow = async function(id) {
  await window.tappi.runCronJobNow(id);
};

window.deleteCronJob = async function(id) {
  await window.tappi.deleteCronJob(id);
  loadCronJobs();
  updateCronStatusBar();
};

// Status bar cron count
async function updateCronStatusBar() {
  const el = document.getElementById('status-cron');
  if (!el) return;
  try {
    const count = await window.tappi.getCronActiveCount();
    if (count > 0) {
      el.textContent = `⏰ ${count}`;
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  } catch (e) {
    el.classList.add('hidden');
  }
}

// Update cron status bar on startup
updateCronStatusBar();

// Live updates from cron manager
if (window.tappi.onCronJobsUpdated) {
  window.tappi.onCronJobsUpdated((jobs) => {
    if (currentSettingsTab === 'cron-jobs') loadCronJobs();
    updateCronStatusBar();
  });
}

if (window.tappi.onCronJobCompleted) {
  window.tappi.onCronJobCompleted((data) => {
    // Show toast notification
    const toast = document.createElement('div');
    toast.className = 'cron-toast';
    toast.textContent = `⏰ ${data.name} ${data.status === 'success' ? '✓' : '✗'}`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  });
}

// ═══════════════════════════════════════════
//  PHASE 8.38: CODING MODE + TEAM STATUS
// ═══════════════════════════════════════════

let codingModeActive = false;
let teamStatusData = null;
let teamCardCollapsed = false;

// ─── Coding Mode Toggle (agent header </>  button) ───

function updateCodingModeUI(enabled) {
  codingModeActive = enabled;

  // Agent header button
  const btn = document.getElementById('toggle-coding');
  if (btn) {
    btn.classList.toggle('on', enabled);
    btn.classList.toggle('hidden', false); // always show if dev mode is on
  }

  // Status bar indicator
  const statusCoding = document.getElementById('status-coding');
  if (statusCoding) statusCoding.classList.toggle('hidden', !enabled);

  // Settings toggle sync
  updateToggle('toggle-codingmode', enabled);

  // Phase 8.39: Show/hide worktree isolation section
  updateWorktreeIsolationSection(enabled);
}

const toggleCodingBtn = document.getElementById('toggle-coding');
if (toggleCodingBtn) {
  toggleCodingBtn.addEventListener('click', async () => {
    const newVal = !codingModeActive;
    codingModeActive = newVal;
    updateCodingModeUI(newVal);
    try {
      await window.tappi.setCodingMode(newVal);
    } catch (e) {
      console.error('[coding-mode] toggle failed:', e);
    }
  });
}

// Settings: Coding Mode toggle
const settingsCodingModeBtn = document.getElementById('toggle-codingmode');
if (settingsCodingModeBtn) {
  settingsCodingModeBtn.addEventListener('click', async () => {
    const newVal = !settingsCodingModeBtn.classList.contains('on');
    updateCodingModeUI(newVal);
    try {
      await window.tappi.setCodingMode(newVal);
    } catch (e) {
      console.error('[coding-mode] settings toggle failed:', e);
    }
  });
}

// Show coding mode section in settings when dev mode is ON
function updateCodingModeSection(devModeEnabled) {
  const section = document.getElementById('codingmode-section');
  const codingBtn = document.getElementById('toggle-coding');
  if (section) section.classList.toggle('hidden', !devModeEnabled);
  if (codingBtn) {
    if (!devModeEnabled) {
      codingBtn.classList.add('hidden');
    }
    // else: will be shown via updateCodingModeUI
  }
  // If dev mode turned off, also turn off coding mode
  if (!devModeEnabled && codingModeActive) {
    codingModeActive = false;
    updateCodingModeUI(false);
  }
}

// ─── Worktree Isolation (Phase 8.39) ───

let worktreeIsolationActive = true; // default ON

function updateWorktreeIsolationSection(codingModeEnabled) {
  const section = document.getElementById('worktree-isolation-section');
  if (section) section.classList.toggle('hidden', !codingModeEnabled);
}

function updateWorktreeIsolationToggle(enabled) {
  worktreeIsolationActive = enabled;
  const btn = document.getElementById('toggle-worktree-isolation');
  if (btn) {
    btn.classList.toggle('on', enabled);
    btn.textContent = enabled ? 'ON' : 'OFF';
  }
}

const worktreeIsolationBtn = document.getElementById('toggle-worktree-isolation');
if (worktreeIsolationBtn) {
  worktreeIsolationBtn.addEventListener('click', async () => {
    const newVal = !worktreeIsolationActive;
    updateWorktreeIsolationToggle(newVal);
    try {
      if (window.tappi.setWorktreeIsolation) {
        await window.tappi.setWorktreeIsolation(newVal);
      }
    } catch (e) {
      console.error('[worktree-isolation] toggle failed:', e);
    }
  });
}

// Listen for coding mode changes to show/hide worktree isolation section
// (patch into existing coding mode handler)
if (window.tappi.onWorktreeIsolationChanged) {
  window.tappi.onWorktreeIsolationChanged((enabled) => {
    updateWorktreeIsolationToggle(enabled);
  });
}

// Load initial worktree isolation state
(async () => {
  try {
    let status;
    if (window.tappi.getWorktreeIsolation) {
      status = await window.tappi.getWorktreeIsolation();
    }
    if (status) {
      updateWorktreeIsolationToggle(status.enabled !== false);
      // Show section only if coding mode is active
      if (codingModeActive) updateWorktreeIsolationSection(true);
    }
  } catch (e) {
    // ignore if IPC not ready yet
  }
})();

// Hook into the existing dev mode toggle to show/hide coding mode section
const origDevModeClick = document.getElementById('toggle-devmode');
if (origDevModeClick) {
  origDevModeClick.addEventListener('click', () => {
    // Dev mode button state was just toggled by the generic handler
    const devOn = origDevModeClick.classList.contains('on');
    updateCodingModeSection(devOn);
  });
}

// Listen for coding mode changes from main
if (window.tappi.onCodingModeChanged) {
  window.tappi.onCodingModeChanged((enabled) => {
    updateCodingModeUI(enabled);
  });
}

// ─── Team Status Card ───

function updateTeamStatusCard(data) {
  teamStatusData = data;
  const card = document.getElementById('team-status-card');
  const statusTeam = document.getElementById('status-team');

  if (!card) return;

  if (!data || data.status === 'done') {
    // No active team
    card.classList.add('hidden');
    if (statusTeam) statusTeam.classList.add('hidden');
    return;
  }

  // Show team status
  card.classList.remove('hidden');
  if (teamCardCollapsed) {
    card.classList.add('collapsed');
  }

  // Status bar: show teammate count
  if (statusTeam) {
    const activeCount = data.activeCount || 0;
    statusTeam.textContent = `👥 ${data.teammates.length}`;
    statusTeam.classList.remove('hidden');
  }

  // Title
  const titleEl = document.getElementById('team-status-title');
  if (titleEl) {
    titleEl.textContent = `👥 Team Active (${data.doneCount}/${data.taskCount} tasks done)`;
  }

  // Task description
  const taskEl = document.getElementById('team-status-task');
  if (taskEl) {
    taskEl.textContent = data.taskDescription || '';
  }

  // Teammates
  const tmContainer = document.getElementById('team-status-teammates');
  if (tmContainer && data.teammates) {
    const statusEmoji = { idle: '⏳', working: '🔄', blocked: '🚫', done: '✅', failed: '❌' };
    tmContainer.innerHTML = data.teammates.map(tm => {
      const emoji = statusEmoji[tm.status] || '❓';
      const taskText = tm.currentTask ? ` — ${tm.currentTask}` : '';
      // Phase 8.39: Show worktree branch badge if available
      const branchBadge = tm.worktreeBranch
        ? `<span class="team-mate-branch" title="Git branch: ${tm.worktreeBranch} · Worktree: ${tm.worktreePath || ''}">${tm.worktreeBranch}</span>`
        : '';
      return `<div class="team-mate-row">
        <span class="team-mate-emoji">${emoji}</span>
        <span class="team-mate-name">${tm.name}</span>${branchBadge}
        <span class="team-mate-task">${tm.role.slice(0, 30)}${taskText}</span>
      </div>`;
    }).join('');
  }

  // Progress
  const progressEl = document.getElementById('team-status-progress');
  if (progressEl && data.taskCount > 0) {
    const pct = Math.round((data.doneCount / data.taskCount) * 100);
    progressEl.textContent = `Progress: ${pct}% (${data.doneCount}/${data.taskCount} tasks)`;
  }
}

// Team card collapse toggle
const teamCardCollapse = document.getElementById('team-card-collapse');
if (teamCardCollapse) {
  teamCardCollapse.addEventListener('click', () => {
    const card = document.getElementById('team-status-card');
    if (!card) return;
    teamCardCollapsed = !teamCardCollapsed;
    card.classList.toggle('collapsed', teamCardCollapsed);
  });
}

// Team status header click to collapse
const teamCardHeader = document.getElementById('team-status-header');
if (teamCardHeader) {
  teamCardHeader.addEventListener('click', () => {
    teamCardCollapse && teamCardCollapse.click();
  });
}

// Listen for team updates from main
if (window.tappi.onTeamUpdated) {
  window.tappi.onTeamUpdated((data) => {
    updateTeamStatusCard(data);
  });
}

// Load initial team status on startup
(async () => {
  try {
    if (window.tappi.getTeamStatus) {
      const teamStatus = await window.tappi.getTeamStatus();
      if (teamStatus) updateTeamStatusCard(teamStatus);
    }
    if (window.tappi.getCodingMode) {
      const codingStatus = await window.tappi.getCodingMode();
      if (codingStatus && codingStatus.enabled) {
        updateCodingModeUI(true);
      }
    }
  } catch (e) {
    // ignore if IPC not ready yet
  }
})();

// Also sync coding mode state when config:loaded fires
// (patched into the existing handler after this code runs)
if (window.tappi.onConfigLoaded) {
  window.tappi.onConfigLoaded((config) => {
    if (config && config.llm) {
      const devOn = config.developerMode || false;
      updateCodingModeSection(devOn);
      if (devOn && config.llm.codingMode) {
        updateCodingModeUI(true);
      }
    }
  });
}

// ═══════════════════════════════════════════
//  PROFILE MANAGEMENT (Phase 8.4.4 / 8.4.5)
// ═══════════════════════════════════════════

let currentProfiles = [];
let activeProfileName = 'default';

function profileInitials(name) {
  if (!name) return '?';
  if (name.includes('@')) {
    const parts = name.split('@')[0];
    return parts.slice(0, 2).toUpperCase();
  }
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function renderProfileIndicator(profileName) {
  const btn = document.getElementById('profile-indicator');
  if (!btn) return;
  const initials = profileInitials(profileName);
  btn.title = `Profile: ${profileName} — click to switch`;
  btn.innerHTML = `<span style="font-size:10px;font-weight:700;line-height:1">${initials}</span>`;
}

function renderProfileListPopup(profiles) {
  const container = document.getElementById('profile-list-popup');
  if (!container) return;
  container.innerHTML = '';
  profiles.forEach(p => {
    const item = document.createElement('div');
    item.className = 'profile-item' + (p.isActive ? ' active' : '');
    item.innerHTML = `
      <div class="profile-avatar">${profileInitials(p.name)}</div>
      <span class="profile-name">${p.name}</span>
      ${p.isActive ? '<span class="profile-active-dot"></span>' : ''}
    `;
    if (!p.isActive) {
      item.addEventListener('click', async () => {
        closeProfilePopup();
        try {
          await window.tappi.switchProfile(p.name);
        } catch (e) {
          console.error('[profile] Switch failed:', e);
        }
      });
    }
    container.appendChild(item);
  });
}

// Profile popup — uses native OS menu (renders above tab views, no z-order issues)
function openProfilePopup() {
  window.tappi.showProfileMenu();
}

function closeProfilePopup() {
  // No-op — native menu handles its own dismissal
}

const profileIndicatorBtn = document.getElementById('profile-indicator');
if (profileIndicatorBtn) {
  profileIndicatorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openProfilePopup();
  });
}

// ── Settings: My Profile tab (Phase 9.096c) ──

let _myProfileLoaded = false;

async function loadMyProfileTab() {
  const textarea = document.getElementById('user-profile-textarea');
  const wordCountEl = document.getElementById('user-profile-word-count');
  const saveBtn = document.getElementById('user-profile-save-btn');
  const enrichHistoryChk = document.getElementById('enrich-history-checkbox');
  const enrichBookmarksChk = document.getElementById('enrich-bookmarks-checkbox');
  const enrichLastUpdated = document.getElementById('enrichment-last-updated');
  const refreshBtn = document.getElementById('enrichment-refresh-btn');

  if (!textarea) return;

  // Load profile text
  try {
    const text = await window.tappi.loadUserProfile();
    textarea.value = text || '';
    updateProfileWordCount();
  } catch (e) {
    console.error('[my-profile] Failed to load:', e);
  }

  // Load enrichment status
  try {
    const status = await window.tappi.getEnrichmentStatus();
    if (enrichHistoryChk) enrichHistoryChk.checked = status.enrichHistory;
    if (enrichBookmarksChk) enrichBookmarksChk.checked = status.enrichBookmarks;
    if (enrichLastUpdated) {
      enrichLastUpdated.textContent = status.lastEnriched
        ? 'Last enriched: ' + new Date(status.lastEnriched).toLocaleString()
        : 'Last enriched: never';
    }
  } catch (e) {
    console.error('[my-profile] Failed to load enrichment status:', e);
  }

  // Wire up events (only once)
  if (_myProfileLoaded) return;
  _myProfileLoaded = true;

  // Word count on input
  textarea.addEventListener('input', () => {
    updateProfileWordCount();
  });

  // Save button
  saveBtn.addEventListener('click', async () => {
    const text = textarea.value;
    try {
      const result = await window.tappi.saveUserProfile(text);
      if (result.success) {
        saveBtn.textContent = '✓ Saved';
        setTimeout(() => { saveBtn.textContent = 'Save'; }, 1500);
      } else {
        saveBtn.textContent = '✗ ' + (result.error || 'Failed');
        setTimeout(() => { saveBtn.textContent = 'Save'; }, 2000);
      }
    } catch (e) {
      console.error('[my-profile] Save failed:', e);
    }
  });

  // Enrichment checkboxes
  if (enrichHistoryChk) {
    enrichHistoryChk.addEventListener('change', async () => {
      try {
        await window.tappi.saveConfig({ privacy: { profileEnrichHistory: enrichHistoryChk.checked } });
      } catch (e) { console.error('[my-profile] Failed to save enrichment pref:', e); }
    });
  }
  if (enrichBookmarksChk) {
    enrichBookmarksChk.addEventListener('change', async () => {
      try {
        await window.tappi.saveConfig({ privacy: { profileEnrichBookmarks: enrichBookmarksChk.checked } });
      } catch (e) { console.error('[my-profile] Failed to save enrichment pref:', e); }
    });
  }

  // Refresh button
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.textContent = '⏳ Refreshing...';
      refreshBtn.disabled = true;
      try {
        const result = await window.tappi.refreshEnrichment();
        if (result.success) {
          enrichLastUpdated.textContent = result.lastEnriched
            ? 'Last enriched: ' + new Date(result.lastEnriched).toLocaleString()
            : 'Last enriched: just now';
          refreshBtn.textContent = '✓ Done';
        } else {
          refreshBtn.textContent = '✗ ' + (result.error || 'Failed');
        }
      } catch (e) {
        refreshBtn.textContent = '✗ Error';
      }
      setTimeout(() => {
        refreshBtn.textContent = '🔄 Refresh Now';
        refreshBtn.disabled = false;
      }, 2000);
    });
  }

  // Listen for agent-driven profile updates
  window.tappi.onUserProfileUpdated((text) => {
    if (textarea && document.querySelector('.settings-tab[data-tab="my-profile"]')?.classList.contains('active')) {
      textarea.value = text || '';
      updateProfileWordCount();
    }
  });
}

function updateProfileWordCount() {
  const textarea = document.getElementById('user-profile-textarea');
  const wordCountEl = document.getElementById('user-profile-word-count');
  if (!textarea || !wordCountEl) return;

  const text = textarea.value.trim();
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
  wordCountEl.textContent = `${words} / 750 words`;
  wordCountEl.classList.remove('warning', 'limit');
  if (words >= 750) {
    wordCountEl.classList.add('limit');
  } else if (words >= 650) {
    wordCountEl.classList.add('warning');
  }
}

// ── Settings: Profiles tab ──

function renderProfilesSettingsTab(profiles) {
  const list = document.getElementById('profiles-list');
  if (!list) return;
  list.innerHTML = '';

  // Update export dropdown
  const exportSelect = document.getElementById('export-profile-select');
  if (exportSelect) {
    exportSelect.innerHTML = '';
    profiles.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name + (p.isActive ? ' (active)' : '');
      exportSelect.appendChild(opt);
    });
  }

  if (profiles.length === 0) {
    list.innerHTML = '<p class="settings-hint">No profiles yet.</p>';
    return;
  }

  profiles.forEach(p => {
    const item = document.createElement('div');
    item.className = 'profile-settings-item';
    item.innerHTML = `
      <div class="profile-settings-avatar">${profileInitials(p.name)}</div>
      <div class="profile-settings-info">
        <div class="profile-settings-name">${p.name}</div>
        <div class="profile-settings-meta">Created ${new Date(p.createdAt).toLocaleDateString()}</div>
      </div>
      <div class="profile-settings-actions">
        ${p.isActive
          ? '<span class="profile-active-badge">Active</span>'
          : `<button class="secondary-btn small" onclick="switchToProfile('${p.name}')">Switch</button>
             <button class="ghost-btn small" onclick="deleteProfileConfirm('${p.name}')">Delete</button>`
        }
      </div>
    `;
    list.appendChild(item);
  });
}

window.switchToProfile = async function(name) {
  try {
    const result = await window.tappi.switchProfile(name);
    if (result && result.success) {
      currentProfiles = result.profiles || currentProfiles;
      activeProfileName = name;
      renderProfilesSettingsTab(currentProfiles);
      renderProfileIndicator(name);
    } else if (result && result.error) {
      alert('Could not switch profile: ' + result.error);
    }
  } catch (e) {
    alert('Switch failed: ' + e.message);
  }
};

window.deleteProfileConfirm = async function(name) {
  if (!confirm(`Delete profile "${name}"? This cannot be undone.`)) return;
  try {
    const result = await window.tappi.deleteProfile(name);
    if (result && result.success) {
      const profiles = await window.tappi.listProfiles();
      currentProfiles = profiles;
      renderProfilesSettingsTab(profiles);
    } else if (result && result.error) {
      alert('Delete failed: ' + result.error);
    }
  } catch (e) {
    alert('Delete failed: ' + e.message);
  }
};

// Create profile form
const profileCreateBtn = document.getElementById('profile-create-btn');
const profileCreateForm = document.getElementById('profile-create-form');
const profileCreateCancel = document.getElementById('profile-create-cancel');
const profileCreateSave = document.getElementById('profile-create-save');

if (profileCreateBtn) {
  profileCreateBtn.addEventListener('click', () => {
    if (profileCreateForm) profileCreateForm.classList.remove('hidden');
  });
}

if (profileCreateCancel) {
  profileCreateCancel.addEventListener('click', () => {
    if (profileCreateForm) profileCreateForm.classList.add('hidden');
    const nameInput = document.getElementById('new-profile-name');
    if (nameInput) nameInput.value = '';
  });
}

if (profileCreateSave) {
  profileCreateSave.addEventListener('click', async () => {
    const nameInput = document.getElementById('new-profile-name');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!name) { alert('Please enter a profile name'); return; }

    try {
      const result = await window.tappi.createProfile(name, name.includes('@') ? name : undefined);
      if (result && result.error) {
        alert('Error: ' + result.error);
        return;
      }
      if (nameInput) nameInput.value = '';
      if (profileCreateForm) profileCreateForm.classList.add('hidden');

      const profiles = await window.tappi.listProfiles();
      currentProfiles = profiles;
      renderProfilesSettingsTab(profiles);
    } catch (e) {
      alert('Failed to create profile: ' + e.message);
    }
  });
}

// Import profile
const profileImportBtn = document.getElementById('profile-import-btn');
if (profileImportBtn) {
  profileImportBtn.addEventListener('click', async () => {
    const password = prompt('Enter decryption password for the profile file:');
    if (password === null) return;
    try {
      const result = await window.tappi.importProfile(password);
      if (result && result.success) {
        alert(`Profile imported as "${result.profileName}". You can now switch to it.`);
        const profiles = await window.tappi.listProfiles();
        currentProfiles = profiles;
        renderProfilesSettingsTab(profiles);
      } else if (result && result.error) {
        if (result.error !== 'Cancelled') alert('Import failed: ' + result.error);
      }
    } catch (e) {
      alert('Import failed: ' + e.message);
    }
  });
}

// Export profile
const profileExportBtn = document.getElementById('profile-export-btn');
if (profileExportBtn) {
  profileExportBtn.addEventListener('click', async () => {
    const exportSelect = document.getElementById('export-profile-select');
    const exportPassword = document.getElementById('export-password');
    const exportStatus = document.getElementById('profile-export-status');

    const profileName = exportSelect ? exportSelect.value : '';
    const password = exportPassword ? exportPassword.value : '';

    if (!profileName) { alert('Please select a profile to export'); return; }
    if (!password || password.length < 4) { alert('Please enter an encryption password (at least 4 characters)'); return; }

    if (exportStatus) exportStatus.textContent = '⏳ Exporting...';
    try {
      const result = await window.tappi.exportProfile(profileName, password);
      if (result && result.success) {
        if (exportStatus) exportStatus.textContent = '✅ Profile exported successfully';
        if (exportPassword) exportPassword.value = '';
      } else if (result && result.error) {
        if (result.error === 'Cancelled') {
          if (exportStatus) exportStatus.textContent = '';
        } else {
          if (exportStatus) exportStatus.textContent = '❌ ' + result.error;
        }
      }
    } catch (e) {
      if (exportStatus) exportStatus.textContent = '❌ ' + e.message;
    }
  });
}

// Load profiles tab when switching to it
const origSwitchSettingsTab = switchSettingsTab;
// Patch switchSettingsTab to load profiles tab
if (typeof switchSettingsTab === 'function') {
  const _origSwitch = window._origSwitchSettingsTab = switchSettingsTab;
  // We can't easily replace the const, but we can hook via the profiles rendering
  // The loadProfilesTab call is added in the mutation
}

function loadProfilesTab() {
  if (currentProfiles.length === 0) {
    window.tappi.listProfiles().then(profiles => {
      currentProfiles = profiles;
      renderProfilesSettingsTab(profiles);
    }).catch(() => {});
  } else {
    renderProfilesSettingsTab(currentProfiles);
  }
}

// Listen for profile data from main process
window.tappi.onProfileLoaded((data) => {
  if (data && data.name) {
    activeProfileName = data.name;
    currentProfiles = data.profiles || [];
    renderProfileIndicator(activeProfileName);
  }
});

window.tappi.onProfileSwitched((data) => {
  if (data && data.profile) {
    activeProfileName = data.profile.name || activeProfileName;
    currentProfiles = data.profiles || currentProfiles;
    renderProfileIndicator(activeProfileName);
    renderProfileListPopup(currentProfiles);
    if (document.getElementById('settings-profiles') &&
        document.getElementById('settings-profiles').classList.contains('active')) {
      renderProfilesSettingsTab(currentProfiles);
    }
  }
});

window.tappi.onProfileUpdated((profiles) => {
  currentProfiles = profiles;
  renderProfileListPopup(profiles);
  if (document.getElementById('settings-profiles') &&
      document.getElementById('settings-profiles').classList.contains('active')) {
    renderProfilesSettingsTab(profiles);
  }
});

// Hook into settings tab switching for profiles
document.querySelectorAll('.settings-tab').forEach(tab => {
  // This is already handled in the original code, but we need to intercept 'profiles'
  // The existing querySelectorAll loop already picks up 'profiles' since it was added to the DOM
});

// Watch for profiles tab activation via mutation or override the click handler
document.querySelectorAll('.settings-tab[data-tab="profiles"]').forEach(tab => {
  tab.addEventListener('click', loadProfilesTab, true);  // capture phase
});

// Load on startup
(async () => {
  try {
    const data = await window.tappi.getActiveProfile();
    if (data && data.name) {
      activeProfileName = data.name;
      currentProfiles = data.profiles || [];
      renderProfileIndicator(activeProfileName);
    }
  } catch (e) {
    // ignore if IPC not ready
  }
})();

// ─── Phase 8.5: Media Engine UI ───

(function() {
  const mediaBtn = document.getElementById('status-media');
  const mediaEngineToggle = document.getElementById('toggle-media-engine');

  let mediaOverlayActive = false;
  let mediaVideoDetected = false;
  let mediaEnabled = false;

  // Update media indicator in status bar
  function updateMediaIndicator(status) {
    if (!mediaBtn) return;
    if (status.hasVideo) {
      mediaBtn.classList.remove('hidden');
      mediaVideoDetected = true;
    } else {
      mediaBtn.classList.add('hidden');
      mediaVideoDetected = false;
    }

    if (status.overlayActive) {
      mediaBtn.classList.add('overlay-active');
      mediaBtn.classList.remove('video-available');
      mediaBtn.title = 'mpv overlay ACTIVE — click to disable';
      mediaOverlayActive = true;
    } else if (status.hasVideo) {
      mediaBtn.classList.remove('overlay-active');
      mediaBtn.classList.add('video-available');
      mediaBtn.title = 'Video detected — click to enable mpv overlay';
      mediaOverlayActive = false;
    }
  }

  // Listen for media status updates from main process
  window.tappi.onMediaStatus((status) => {
    updateMediaIndicator(status);
    // Update settings toggle
    if (mediaEngineToggle) {
      mediaEngineToggle.textContent = status.mpvAvailable ? (mediaEnabled ? 'ON' : 'OFF') : 'N/A';
      if (!status.mpvAvailable) {
        mediaEngineToggle.disabled = true;
        const hint = document.getElementById('media-engine-hint');
        if (hint) hint.textContent = 'mpv not installed. Run: brew install mpv';
      }
    }
  });

  // Status bar media button click → toggle overlay
  if (mediaBtn) {
    mediaBtn.addEventListener('click', async () => {
      try {
        const result = await window.tappi.toggleMediaActive();
        if (result && !result.success && result.error) {
          console.warn('[media-ui] toggle failed:', result.error);
        }
      } catch (e) {
        console.error('[media-ui] toggle error:', e);
      }
    });
  }

  // Settings toggle
  if (mediaEngineToggle) {
    mediaEngineToggle.addEventListener('click', () => {
      mediaEnabled = !mediaEnabled;
      mediaEngineToggle.textContent = mediaEnabled ? 'ON' : 'OFF';
      mediaEngineToggle.classList.toggle('on', mediaEnabled);
      window.tappi.setMediaEnabled(mediaEnabled).catch(() => {});
    });
  }
})();

// ─── Phase 8.6: Recording Indicator ───

(function() {
  const recBtn     = document.getElementById('status-rec');
  const recElapsed = document.getElementById('status-rec-elapsed');

  let recActive    = false;
  let recStartedAt = 0;
  let elapsedTimer = null;

  function formatElapsed(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function startElapsedTimer(initialSeconds) {
    if (elapsedTimer) clearInterval(elapsedTimer);
    let elapsed = initialSeconds || 0;
    if (recElapsed) recElapsed.textContent = formatElapsed(elapsed);
    elapsedTimer = setInterval(() => {
      elapsed++;
      if (recElapsed) recElapsed.textContent = formatElapsed(elapsed);
    }, 1000);
  }

  function stopElapsedTimer() {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    if (recElapsed) recElapsed.textContent = '0:00';
  }

  function updateRecIndicator(status) {
    if (!recBtn) return;
    if (status && status.active) {
      recActive = true;
      recBtn.classList.remove('hidden');
      startElapsedTimer(status.elapsedSeconds || 0);
    } else {
      recActive = false;
      recBtn.classList.add('hidden');
      stopElapsedTimer();
    }
  }

  // Listen for recording state changes from main process
  if (window.tappi.onRecordingUpdate) {
    window.tappi.onRecordingUpdate((status) => updateRecIndicator(status));
  }

  // Click 🔴 REC → stop recording
  if (recBtn) {
    recBtn.addEventListener('click', async () => {
      if (!recActive) return;
      recBtn.textContent = '⏹ Stopping…';
      recBtn.disabled = true;
      try {
        const result = await window.tappi.stopRecording();
        console.log('[rec-ui] stopped:', result);
      } catch (e) {
        console.error('[rec-ui] stop error:', e);
      } finally {
        recBtn.disabled = false;
        // Restore button content (will be hidden by updateRecIndicator)
        recBtn.innerHTML = '🔴 REC <span id="status-rec-elapsed">0:00</span>';
        updateRecIndicator({ active: false });
      }
    });
  }

  // On load: check if a recording is already in progress (e.g. after window reload)
  if (window.tappi.getRecordingStatus) {
    window.tappi.getRecordingStatus().then((status) => {
      if (status && status.active) updateRecIndicator(status);
    }).catch(() => {});
  }
})();

// ─── Phase 9.07 Track 5: Agent-Initiated File Downloads ───

(function() {
  function formatFileSizeApp(bytes) {
    if (!bytes || bytes < 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function appendDownloadCard(data) {
    const agentMsgs = document.getElementById('agent-messages');
    if (!agentMsgs) return;

    const { path: filePath, name, size, formats, description } = data || {};
    if (!filePath || !formats || formats.length === 0) return;

    const ext = (name || '').split('.').pop()?.toLowerCase() || '';
    const iconMap = {
      pdf: '📕', html: '🌐', md: '📝', csv: '📊', json: '📋',
      png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🎨',
      txt: '📄', zip: '📦', mp4: '🎬', mp3: '🎵',
    };

    const card = document.createElement('div');
    card.className = 'file-download-card';

    const iconEl = document.createElement('div');
    iconEl.className = 'file-icon';
    iconEl.textContent = iconMap[ext] || '📄';

    const infoEl = document.createElement('div');
    infoEl.className = 'file-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'file-name';
    nameEl.textContent = name || 'file';

    const sizeEl = document.createElement('div');
    sizeEl.className = 'file-size';
    sizeEl.textContent = (description ? description + '  ·  ' : '') + formatFileSizeApp(size);

    infoEl.appendChild(nameEl);
    infoEl.appendChild(sizeEl);

    const actionsEl = document.createElement('div');
    actionsEl.className = 'file-actions';

    (formats || []).forEach(fmt => {
      const btn = document.createElement('button');
      btn.textContent = '↓ ' + fmt.toUpperCase();
      btn.title = 'Download as ' + fmt.toUpperCase();
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const orig = btn.textContent;
        btn.textContent = '⏳';
        try {
          const result = await window.tappi.downloadFile(filePath, fmt, name);
          if (result && result.success) {
            btn.textContent = '✓';
            btn.style.color = '#22c55e';
            btn.style.borderColor = '#22c55e';
          } else if (result && result.error === 'Cancelled') {
            btn.textContent = orig;
            btn.disabled = false;
          } else {
            btn.textContent = '❌';
            btn.title = (result && result.error) || 'Save failed';
            btn.disabled = false;
          }
        } catch (e) {
          btn.textContent = '❌';
          btn.title = String(e);
          btn.disabled = false;
        }
      });
      actionsEl.appendChild(btn);
    });

    card.appendChild(iconEl);
    card.appendChild(infoEl);
    card.appendChild(actionsEl);

    // Append as an agent message element
    const msgEl = document.createElement('div');
    msgEl.className = 'agent-msg assistant';
    msgEl.appendChild(card);
    agentMsgs.appendChild(msgEl);
    agentMsgs.scrollTop = agentMsgs.scrollHeight;
  }

  if (window.tappi && window.tappi.onPresentDownload) {
    window.tappi.onPresentDownload((data) => {
      appendDownloadCard(data);
    });
  }
})();
