/**
 * aria.js — Full Aria tab UI controller (Phase 8.35).
 *
 * Uses window.aria (from aria-preload.ts) for all IPC communication.
 * Uses marked.js (vendor/marked.min.js) for markdown rendering.
 */

// @ts-check
'use strict';

// ═══════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════

let currentConversationId = null;
let isStreaming = false;
let messages = [];           // in-memory messages for current conversation
let conversations = [];      // sidebar conversation list
let streamBuffer = '';       // accumulates streaming chunks
let searchDebounce = null;
let _streamRenderTimer = null;

const TOKEN_CONTEXT_LIMIT = 200000;

// ═══════════════════════════════════════════
//  DOM REFERENCES
// ═══════════════════════════════════════════

const convList       = document.getElementById('conversation-list');
const sidebarSearch  = document.getElementById('sidebar-search');
const newChatBtn     = document.getElementById('new-chat-btn');
const ariaMessages   = document.getElementById('aria-messages');
const ariaInput      = document.getElementById('aria-input');
const ariaSendBtn    = document.getElementById('aria-send-btn');
const ariaStopBtn    = document.getElementById('aria-stop-btn');
const tokenFill      = document.getElementById('aria-token-fill');
const tokenLabel     = document.getElementById('aria-token-label');

// Fix 4: Coding mode + team status elements
const ariaCodingBtn   = document.getElementById('aria-coding-btn');
const ariaTeamCard    = document.getElementById('aria-team-card');
const ariaTeamTitle   = document.getElementById('aria-team-title');
const ariaTeamTask    = document.getElementById('aria-team-task');
const ariaTeamMembers = document.getElementById('aria-team-members');
const ariaTeamProgress= document.getElementById('aria-team-progress');
const ariaTeamCollapse= document.getElementById('aria-team-collapse');

// Fix 4: Local state for dev mode + coding mode
let devModeActive    = false;
let codingModeActive = false;
let teamCardCollapsed = false;

// ═══════════════════════════════════════════
//  MARKDOWN RENDERER
// ═══════════════════════════════════════════

if (typeof marked !== 'undefined') {
  marked.setOptions({ breaks: true, gfm: true });

  const renderer = new marked.Renderer();
  const origLink = renderer.link.bind(renderer);
  renderer.link = function(token) {
    const html = origLink(token);
    return html.replace('<a ', '<a target="_blank" rel="noopener noreferrer" ');
  };
  marked.use({ renderer });
}

function renderMarkdown(text) {
  if (!text) return '';
  if (typeof marked === 'undefined') {
    return '<pre style="white-space:pre-wrap;margin:0;font-family:inherit;">' + escHtml(text) + '</pre>';
  }
  try {
    let html = marked.parse(text);
    html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    return html;
  } catch (e) {
    return '<pre style="white-space:pre-wrap;margin:0;font-family:inherit;">' + escHtml(text) + '</pre>';
  }
}

// ═══════════════════════════════════════════
//  TOKEN BAR
// ═══════════════════════════════════════════

function updateTokenBar(inputTokens, outputTokens) {
  if (!tokenFill || !tokenLabel) return;
  const pct = Math.min((inputTokens / TOKEN_CONTEXT_LIMIT) * 100, 100);
  tokenFill.style.width = pct + '%';

  const fmtK = n => n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n);
  const limitStr = (TOKEN_CONTEXT_LIMIT / 1000) + 'K';
  if (inputTokens === 0 && (!outputTokens || outputTokens === 0)) {
    tokenLabel.textContent = '0 / ' + limitStr + ' tokens';
  } else {
    tokenLabel.textContent = fmtK(inputTokens) + ' / ' + limitStr + ' ctx'
      + (outputTokens ? ' · ' + fmtK(outputTokens) + ' out' : '');
  }

  tokenFill.classList.remove('warning', 'danger');
  if (pct >= 80) tokenFill.classList.add('danger');
  else if (pct >= 60) tokenFill.classList.add('warning');
}

// ═══════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const now = new Date();
  const diff = now - d;

  if (diff < 60 * 1000) return 'Just now';
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + 'h ago';
  if (diff < 7 * 24 * 60 * 60 * 1000) {
    return d.toLocaleDateString(undefined, { weekday: 'short' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function scrollToBottom(smooth = true) {
  if (ariaMessages) {
    ariaMessages.scrollTo({ top: ariaMessages.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
  }
}

// ═══════════════════════════════════════════
//  WELCOME SCREEN
// ═══════════════════════════════════════════

function showWelcome() {
  // The welcome div is already in aria.html; we just need to make it visible
  // and hide any messages. We keep the DOM as-is and clear messages.
  messages = [];
  ariaMessages.innerHTML = ariaMessages.querySelector('.aria-welcome')?.outerHTML || `
    <div class="aria-welcome">
      <div class="welcome-icon">🪷</div>
      <div class="welcome-title">Hello, I'm Aria</div>
      <div class="welcome-subtitle">Your AI assistant built into the browser.<br>Ask me anything — I can browse the web, run code, and more.</div>
      <div class="welcome-suggestions">
        <button class="suggestion-chip" data-prompt="What's the weather like today?">🌤 Weather today</button>
        <button class="suggestion-chip" data-prompt="Search for the latest news on AI">📰 AI news</button>
        <button class="suggestion-chip" data-prompt="Help me write a quick email">✉️ Write email</button>
        <button class="suggestion-chip" data-prompt="Find me a good recipe for dinner">🍳 Dinner recipe</button>
      </div>
    </div>
  `;
  bindSuggestionChips();
}

function bindSuggestionChips() {
  ariaMessages.querySelectorAll('.suggestion-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const prompt = chip.dataset.prompt;
      if (prompt) sendMessage(prompt);
    });
  });
}

function hideWelcome() {
  const welcome = ariaMessages.querySelector('.aria-welcome');
  if (welcome) welcome.remove();
}

// ═══════════════════════════════════════════
//  SIDEBAR — CONVERSATIONS
// ═══════════════════════════════════════════

async function loadConversations() {
  try {
    const list = await window.aria.listConversations();
    conversations = list || [];
    renderConversationList(conversations);
  } catch (e) {
    console.error('[aria] listConversations error:', e);
    convList.innerHTML = '<div class="conv-empty">Could not load conversations.</div>';
  }
}

function renderConversationList(list) {
  convList.innerHTML = '';
  if (!list || list.length === 0) {
    convList.innerHTML = '<div class="conv-empty">No conversations yet.<br>Start a new chat below.</div>';
    return;
  }

  list.forEach(conv => {
    const el = document.createElement('div');
    el.className = 'conv-item' + (conv.id === currentConversationId ? ' active' : '');
    el.dataset.id = conv.id;

    const title = conv.title || '(New chat)';
    const dateStr = formatDate(conv.updated_at);
    const preview = conv.preview ? escHtml(conv.preview.slice(0, 40)) : '';

    el.innerHTML = `
      <div class="conv-item-title">${escHtml(title)}</div>
      <div class="conv-item-meta">
        <span class="conv-item-date">${dateStr}</span>
        ${preview ? `<span class="conv-item-preview">— ${preview}</span>` : ''}
      </div>
    `;

    el.addEventListener('click', () => switchToConversation(conv.id));
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      showConvContextMenu(e.clientX, e.clientY, conv);
    });

    convList.appendChild(el);
  });
}

function setActiveConvInSidebar(convId) {
  convList.querySelectorAll('.conv-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === convId);
  });
}

// ─── Search ───────────────────────────────

sidebarSearch.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = sidebarSearch.value.trim();
  if (!q) {
    renderConversationList(conversations);
    return;
  }
  searchDebounce = setTimeout(async () => {
    try {
      const results = await window.aria.searchConversations(q);
      // searchConversations returns SearchResult[] not Conversation[] — dedupe by conversation
      if (Array.isArray(results) && results.length > 0 && results[0].conversation_id) {
        // SearchResult format — build a conversation-like list
        const seen = new Set();
        const filtered = [];
        results.forEach(r => {
          if (!seen.has(r.conversation_id)) {
            seen.add(r.conversation_id);
            const conv = conversations.find(c => c.id === r.conversation_id);
            if (conv) filtered.push(conv);
          }
        });
        renderConversationList(filtered.length > 0 ? filtered : []);
      } else if (Array.isArray(results)) {
        // Maybe it returned Conversation[] directly
        renderConversationList(results);
      } else {
        renderConversationList([]);
      }
    } catch (e) {
      // Fallback: local filter
      const filtered = conversations.filter(c =>
        (c.title || '').toLowerCase().includes(q.toLowerCase()) ||
        (c.preview || '').toLowerCase().includes(q.toLowerCase())
      );
      renderConversationList(filtered);
    }
  }, 200);
});

// ─── New chat ────────────────────────────

newChatBtn.addEventListener('click', async () => {
  if (isStreaming) return;
  try {
    const conv = await window.aria.newChat();
    if (conv) {
      currentConversationId = conv.id;
      conversations.unshift(conv);
      renderConversationList(conversations);
      setActiveConvInSidebar(currentConversationId);
      showWelcome();
      updateTokenBar(0, 0);
      ariaInput.focus();
    }
  } catch (e) {
    console.error('[aria] newChat error:', e);
  }
});

// ─── Switch conversation ────────────────

async function switchToConversation(convId) {
  if (convId === currentConversationId && !isStreaming) return;
  if (isStreaming) {
    // Block switching while generating
    return;
  }

  try {
    await window.aria.switchConversation(convId);
    currentConversationId = convId;
    setActiveConvInSidebar(convId);
    await loadMessagesForConversation(convId);
  } catch (e) {
    console.error('[aria] switchConversation error:', e);
  }
}

async function loadMessagesForConversation(convId) {
  ariaMessages.innerHTML = '';
  messages = [];

  try {
    const fetched = await window.aria.getConversationMessages(convId, 0, 100);
    if (!fetched || fetched.length === 0) {
      showWelcome();
      return;
    }
    fetched.forEach(m => messages.push(m));
    renderAllMessages();
    scrollToBottom(false);
  } catch (e) {
    console.error('[aria] getConversationMessages error:', e);
    showWelcome();
  }
}

// ─── Context menu ─────────────────────────

let _ctxMenu = null;

function showConvContextMenu(x, y, conv) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'conv-context-menu';
  menu.innerHTML = `
    <div class="conv-ctx-item" data-action="rename">✏️ Rename</div>
    <div class="conv-ctx-item danger" data-action="delete">🗑 Delete</div>
  `;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);
  _ctxMenu = menu;

  // Adjust position if overflowing
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth)  menu.style.left = (x - rect.width) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + 'px';
  });

  menu.addEventListener('click', async e => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    closeContextMenu();
    if (action === 'rename') await renameConversation(conv);
    if (action === 'delete') await deleteConversation(conv);
  });

  setTimeout(() => document.addEventListener('click', closeContextMenu, { once: true }), 0);
}

function closeContextMenu() {
  if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; }
}

async function renameConversation(conv) {
  // Find the title element in the sidebar
  const item = convList.querySelector(`.conv-item[data-id="${conv.id}"]`);
  if (!item) return;

  const titleEl = item.querySelector('.conv-item-title');
  const currentTitle = conv.title || '';

  const input = document.createElement('input');
  input.className = 'conv-rename-input';
  input.value = currentTitle;
  input.maxLength = 80;

  titleEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const newTitle = input.value.trim();
    if (newTitle && newTitle !== currentTitle) {
      try {
        await window.aria.renameConversation(conv.id, newTitle);
        conv.title = newTitle;
      } catch (e) {
        console.error('[aria] renameConversation error:', e);
      }
    }
    renderConversationList(conversations);
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = currentTitle; input.blur(); }
  });
}

async function deleteConversation(conv) {
  if (!confirm(`Delete conversation "${conv.title || '(untitled)'}"? This cannot be undone.`)) return;
  try {
    await window.aria.deleteConversation(conv.id);
    conversations = conversations.filter(c => c.id !== conv.id);

    if (conv.id === currentConversationId) {
      // Switch to most recent remaining conversation or create new
      if (conversations.length > 0) {
        await switchToConversation(conversations[0].id);
      } else {
        const newConv = await window.aria.newChat();
        if (newConv) {
          currentConversationId = newConv.id;
          conversations = [newConv];
          showWelcome();
        }
      }
    }
    renderConversationList(conversations);
  } catch (e) {
    console.error('[aria] deleteConversation error:', e);
  }
}

// ═══════════════════════════════════════════
//  CHAT RENDERING
// ═══════════════════════════════════════════

function renderAllMessages() {
  ariaMessages.innerHTML = '';
  messages.forEach(m => appendMessageEl(m));
}

function appendMessageEl(msg) {
  if (!msg || !msg.role) return;

  // Skip tool messages that are too noisy — show briefly as system
  const role = msg.role; // 'user' | 'assistant' | 'tool' | 'system'

  const wrapper = document.createElement('div');
  wrapper.className = `aria-msg ${role}`;
  if (msg._msgId) wrapper.dataset.msgId = msg._msgId;

  const bubble = document.createElement('div');
  bubble.className = 'aria-bubble';

  if (msg._raw) {
    // Raw HTML (deep mode plan cards)
    bubble.innerHTML = msg.content || '';
    wrapper.style.maxWidth = '640px';
    wrapper.style.alignSelf = 'flex-start';
  } else if (role === 'assistant') {
    const mdDiv = document.createElement('div');
    mdDiv.className = 'md-content';
    mdDiv.innerHTML = renderMarkdown(msg.content || '');
    bubble.appendChild(mdDiv);
  } else if (role === 'tool') {
    bubble.textContent = msg.content || '';
  } else {
    // user, system
    bubble.textContent = msg.content || '';
  }

  wrapper.appendChild(bubble);
  ariaMessages.appendChild(wrapper);
  return wrapper;
}

function appendMessage(role, content, opts = {}) {
  const msg = { role, content, timestamp: Date.now(), ...opts };
  messages.push(msg);
  const el = appendMessageEl(msg);
  scrollToBottom();
  return el;
}

// ═══════════════════════════════════════════
//  SENDING MESSAGES
// ═══════════════════════════════════════════

async function sendMessage(text) {
  if (isStreaming) return;
  if (!text || !text.trim()) return;

  const trimmed = text.trim();

  // Hide welcome screen if visible
  hideWelcome();

  // Show user message immediately
  appendMessage('user', trimmed);
  ariaInput.value = '';
  ariaInput.style.height = 'auto';

  // Ensure we have a conversation
  if (!currentConversationId) {
    try {
      const conv = await window.aria.newChat();
      if (conv) {
        currentConversationId = conv.id;
        conversations.unshift(conv);
        renderConversationList(conversations);
        setActiveConvInSidebar(currentConversationId);
      }
    } catch (e) {
      console.error('[aria] Failed to create conversation:', e);
      appendMessage('system', 'Error: Could not start conversation.');
      return;
    }
  }

  setStreamingState(true);

  // Send to main process
  try {
    window.aria.sendMessage(trimmed, currentConversationId);
  } catch (e) {
    console.error('[aria] sendMessage error:', e);
    setStreamingState(false);
    appendMessage('system', 'Error sending message: ' + (e.message || e));
  }
}

// ─── Input event handlers ─────────────────

ariaSendBtn.addEventListener('click', () => {
  if (isStreaming) {
    // Stop generation
    window.aria.stopAgent();
    setStreamingState(false);
    return;
  }
  sendMessage(ariaInput.value);
});

ariaStopBtn.addEventListener('click', () => {
  if (isStreaming) {
    window.aria.stopAgent();
    setStreamingState(false);
  }
});

ariaInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (isStreaming) return;
    sendMessage(ariaInput.value);
  }
  if (e.key === 'Escape' && isStreaming) {
    window.aria.stopAgent();
    setStreamingState(false);
  }
});

// Auto-grow textarea
ariaInput.addEventListener('input', () => {
  ariaInput.style.height = 'auto';
  ariaInput.style.height = Math.min(ariaInput.scrollHeight, 140) + 'px';
});

// ─── Streaming state ──────────────────────

function setStreamingState(streaming) {
  isStreaming = streaming;

  if (streaming) {
    ariaSendBtn.classList.add('hidden');
    ariaStopBtn.classList.remove('hidden');
    ariaInput.disabled = true;
  } else {
    ariaStopBtn.classList.add('hidden');
    ariaSendBtn.classList.remove('hidden');
    ariaInput.disabled = false;
    streamBuffer = '';
    clearTimeout(_streamRenderTimer);
    ariaInput.focus();
  }
}

// ═══════════════════════════════════════════
//  IPC LISTENERS — Streaming
// ═══════════════════════════════════════════

window.aria.onStreamStart(() => {
  // Prepare an empty assistant bubble for streaming
  streamBuffer = '';
  _prepareStreamBubble();
});

let _streamBubbleEl = null;
let _streamMdDiv = null;

function _prepareStreamBubble() {
  const wrapper = document.createElement('div');
  wrapper.className = 'aria-msg assistant';
  wrapper.id = 'aria-stream-bubble';

  const bubble = document.createElement('div');
  bubble.className = 'aria-bubble';

  // Typing indicator while waiting for first chunk
  const typing = document.createElement('div');
  typing.className = 'typing-dots';
  typing.innerHTML = '<span></span><span></span><span></span>';
  bubble.appendChild(typing);

  wrapper.appendChild(bubble);
  ariaMessages.appendChild(wrapper);
  _streamBubbleEl = bubble;
  _streamMdDiv = null;
  scrollToBottom();
}

window.aria.onStreamChunk(chunk => {
  if (!chunk) return;

  streamBuffer += (chunk.text || '');

  if (chunk.done) {
    // Final render
    clearTimeout(_streamRenderTimer);
    _finalizeStreamBubble();
    setStreamingState(false);

    // Auto-update conversation title and refresh sidebar
    setTimeout(() => loadConversations(), 500);
  } else {
    // Incremental render (debounced ~12fps)
    clearTimeout(_streamRenderTimer);
    _streamRenderTimer = setTimeout(() => {
      _updateStreamBubble(streamBuffer, false);
    }, 80);

    // Immediate first-chunk display
    if (!_streamMdDiv && streamBuffer.length > 0) {
      _updateStreamBubble(streamBuffer, false);
    }
  }
});

function _updateStreamBubble(text, done) {
  if (!_streamBubbleEl) return;

  if (!_streamMdDiv) {
    // Replace typing indicator with md-content
    _streamBubbleEl.innerHTML = '';
    _streamMdDiv = document.createElement('div');
    _streamMdDiv.className = 'md-content';
    _streamBubbleEl.appendChild(_streamMdDiv);
  }

  _streamMdDiv.innerHTML = renderMarkdown(text) + (!done ? '<span class="streaming-cursor"></span>' : '');
  scrollToBottom(false);
}

function _finalizeStreamBubble() {
  if (_streamBubbleEl) {
    _updateStreamBubble(streamBuffer, true);
    // Remove streaming cursor
    const cursor = _streamBubbleEl.querySelector('.streaming-cursor');
    if (cursor) cursor.remove();
    // Remove stream bubble ID
    const wrapper = document.getElementById('aria-stream-bubble');
    if (wrapper) wrapper.removeAttribute('id');
  }

  // Add to in-memory messages
  if (streamBuffer) {
    messages.push({ role: 'assistant', content: streamBuffer, timestamp: Date.now() });
  }

  _streamBubbleEl = null;
  _streamMdDiv = null;
  streamBuffer = '';
}

// ─── Tool results ─────────────────────────

window.aria.onToolResult(result => {
  if (!result) return;
  const display = result.display || `[${result.toolName}]`;
  appendMessage('tool', display);
});

// ─── Token usage ──────────────────────────

window.aria.onTokenUsage(data => {
  if (!data) return;
  updateTokenBar(data.inputTokens || 0, data.outputTokens || 0);
});

// ═══════════════════════════════════════════
//  IPC LISTENERS — Conversation events
// ═══════════════════════════════════════════

window.aria.onConversationUpdated(async data => {
  if (!data) return;
  // Refresh sidebar to pick up title changes
  await loadConversations();
  if (data.conversationId === currentConversationId) {
    setActiveConvInSidebar(currentConversationId);
  }
});

window.aria.onConversationSwitched(async data => {
  if (!data || !data.conversationId) return;
  if (data.conversationId !== currentConversationId) {
    currentConversationId = data.conversationId;
    setActiveConvInSidebar(currentConversationId);
    await loadMessagesForConversation(currentConversationId);
  }
});

// ═══════════════════════════════════════════
//  DEEP MODE SUPPORT
// ═══════════════════════════════════════════

let _deepSubtaskText = {};

window.aria.onDeepPlan(data => {
  const { mode, subtasks } = data || {};
  if (!subtasks) return;
  _deepSubtaskText = {};

  let html = '<div class="deep-plan">';
  html += `<div class="deep-plan-header">📋 ${subtasks.length} steps <span class="deep-plan-mode ${escHtml(mode)}">${escHtml(mode)}</span></div>`;

  subtasks.forEach((s, i) => {
    const taskStr = (s.task || '').slice(0, 80);
    const truncated = (s.task || '').length > 80 ? '…' : '';
    html += `<div class="deep-step" id="aria-deep-step-${i}">`;
    html += `  <div class="deep-step-header" onclick="window._ariaToggleDeepStep(${i})">`;
    html += `    <span class="deep-chevron" id="aria-deep-chevron-${i}">▶</span>`;
    html += `    <span class="deep-step-status" id="aria-deep-status-${i}">⏳</span>`;
    html += `    <span class="deep-step-title"><b>${i + 1}.</b> ${escHtml(taskStr)}${truncated}</span>`;
    html += `    <span class="deep-step-duration" id="aria-deep-dur-${i}"></span>`;
    html += `  </div>`;
    html += `  <div class="deep-step-stream" id="aria-deep-stream-${i}"></div>`;
    html += `  <div class="deep-step-tools"  id="aria-deep-tools-${i}"></div>`;
    html += `</div>`;
  });
  html += '</div>';

  messages.push({ role: 'assistant', content: html, _raw: true, timestamp: Date.now() });
  const el = appendMessageEl({ role: 'assistant', content: html, _raw: true });
  if (el) {
    el.style.maxWidth = '640px';
    el.style.alignSelf = 'flex-start';
  }
  scrollToBottom();
});

window._ariaToggleDeepStep = function(idx) {
  const stream = document.getElementById('aria-deep-stream-' + idx);
  const chev   = document.getElementById('aria-deep-chevron-' + idx);
  if (!stream) return;
  const visible = stream.classList.contains('visible');
  stream.classList.toggle('visible', !visible);
  if (chev) chev.classList.toggle('open', !visible);
};

window.aria.onDeepSubtaskStart(data => {
  const { index } = data || {};
  if (index == null) return;
  const el     = document.getElementById('aria-deep-step-' + index);
  const status = document.getElementById('aria-deep-status-' + index);
  const stream = document.getElementById('aria-deep-stream-' + index);
  const chev   = document.getElementById('aria-deep-chevron-' + index);

  if (el)     el.classList.add('active');
  if (status) status.textContent = '🔄';
  if (stream) {
    stream.innerHTML = '<em style="color:var(--text-dim)">Working…</em>';
    stream.classList.add('visible', 'streaming');
  }
  if (chev) chev.classList.add('open');
  _deepSubtaskText[index] = '';

  // Collapse other streams
  document.querySelectorAll('.deep-step-stream.visible').forEach(s => {
    const id = parseInt(s.id.replace('aria-deep-stream-', ''));
    if (!isNaN(id) && id !== index) {
      s.classList.remove('visible', 'streaming');
      const c = document.getElementById('aria-deep-chevron-' + id);
      if (c) c.classList.remove('open');
    }
  });

  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

window.aria.onDeepSubtaskDone(data => {
  const { index, status, duration, error } = data || {};
  if (index == null) return;
  const el       = document.getElementById('aria-deep-step-' + index);
  const statusEl = document.getElementById('aria-deep-status-' + index);
  const durEl    = document.getElementById('aria-deep-dur-' + index);
  const stream   = document.getElementById('aria-deep-stream-' + index);

  if (el) {
    el.classList.remove('active');
    el.classList.add(status === 'done' ? 'done' : 'failed');
  }
  if (statusEl) statusEl.textContent = status === 'done' ? '✅' : '❌';
  if (durEl && duration != null) durEl.textContent = Number(duration).toFixed(1) + 's';
  if (stream) stream.classList.remove('streaming');

  if (error && stream) {
    stream.innerHTML = `<span style="color:#ef4444">❌ ${escHtml(error)}</span>`;
    stream.classList.add('visible');
  }
});

let _deepStreamTimers = {};
window.aria.onDeepStreamChunk(data => {
  const { index, chunk } = data || {};
  if (index == null) return;
  const stream = document.getElementById('aria-deep-stream-' + index);
  if (!stream) return;

  _deepSubtaskText[index] = (_deepSubtaskText[index] || '') + (chunk || '');
  stream.classList.add('visible', 'streaming');

  clearTimeout(_deepStreamTimers[index]);
  _deepStreamTimers[index] = setTimeout(() => {
    const mdDiv = document.createElement('div');
    mdDiv.className = 'md-content';
    mdDiv.innerHTML = renderMarkdown(_deepSubtaskText[index]);
    stream.innerHTML = '';
    stream.appendChild(mdDiv);
    stream.scrollTop = stream.scrollHeight;
  }, 80);
});

window.aria.onDeepComplete(data => {
  const { mode, durationSeconds, aborted, completedSteps, totalSteps } = data || {};
  const statusStr = aborted ? '⚠️ Aborted' : '✅ Complete';
  const html = `<div class="deep-complete">${statusStr} — ${escHtml(mode)} mode, ${completedSteps}/${totalSteps} steps in ${Number(durationSeconds).toFixed(1)}s</div>`;
  messages.push({ role: 'assistant', content: html, _raw: true, timestamp: Date.now() });
  appendMessageEl({ role: 'assistant', content: html, _raw: true });
  setStreamingState(false);
  scrollToBottom();
  setTimeout(() => loadConversations(), 500);
});

// ═══════════════════════════════════════════
//  FIX 4: CODING MODE TOGGLE (PRIMARY in Aria tab)
// ═══════════════════════════════════════════

/**
 * Update the </> button's visual state.
 * Button is only visible when dev mode is ON.
 * Button glows when coding mode is active.
 */
function updateCodingBtn() {
  if (!ariaCodingBtn) return;
  // Only show when developer mode is enabled
  ariaCodingBtn.classList.toggle('hidden', !devModeActive);
  // Glow/highlight when active
  ariaCodingBtn.classList.toggle('on', codingModeActive);
  ariaCodingBtn.title = codingModeActive
    ? 'Coding Mode: ON — click to disable agent team orchestration'
    : 'Coding Mode: OFF — click to enable agent team orchestration';
}

// Wire coding mode button click
if (ariaCodingBtn) {
  ariaCodingBtn.addEventListener('click', async () => {
    if (!devModeActive) return; // safety — button should be hidden anyway
    const newVal = !codingModeActive;
    codingModeActive = newVal;
    updateCodingBtn();
    try {
      await window.aria.setCodingMode(newVal);
    } catch (e) {
      console.error('[aria] setCodingMode error:', e);
      // Revert on error
      codingModeActive = !newVal;
      updateCodingBtn();
    }
  });
}

// Listen for coding mode changes (from any source: agent header toggle, settings, etc.)
if (window.aria.onCodingModeChanged) {
  window.aria.onCodingModeChanged((enabled) => {
    codingModeActive = enabled;
    updateCodingBtn();
  });
}

// Listen for dev mode changes — show/hide the button
if (window.aria.onDevModeChanged) {
  window.aria.onDevModeChanged((enabled) => {
    devModeActive = enabled;
    if (!enabled) codingModeActive = false; // coding mode requires dev mode
    updateCodingBtn();
  });
}

// ═══════════════════════════════════════════
//  FIX 4: TEAM STATUS CARD (shown in Aria tab when team is active)
// ═══════════════════════════════════════════

function updateTeamCard(data) {
  if (!ariaTeamCard) return;

  if (!data || data.status === 'done' || !data.teammates || data.teammates.length === 0) {
    ariaTeamCard.classList.add('hidden');
    return;
  }

  ariaTeamCard.classList.remove('hidden');
  if (teamCardCollapsed) ariaTeamCard.classList.add('collapsed');

  // Title
  if (ariaTeamTitle) {
    ariaTeamTitle.textContent = `👥 Team (${data.doneCount || 0}/${data.taskCount || 0} tasks)`;
  }

  // Task description
  if (ariaTeamTask) {
    ariaTeamTask.textContent = data.taskDescription || '';
  }

  // Teammates
  if (ariaTeamMembers && data.teammates) {
    const statusEmoji = { idle: '⏳', working: '🔄', blocked: '🚫', done: '✅', failed: '❌' };
    ariaTeamMembers.innerHTML = data.teammates.map(tm => {
      const emoji = statusEmoji[tm.status] || '❓';
      const taskText = tm.currentTask ? ` — ${escHtml(tm.currentTask.slice(0, 40))}` : '';
      return `<div class="aria-team-mate">
        <span>${emoji}</span>
        <span class="aria-team-name">${escHtml(tm.name)}</span>
        <span class="aria-team-role">${escHtml(tm.role.slice(0, 20))}${taskText}</span>
      </div>`;
    }).join('');
  }

  // Progress
  if (ariaTeamProgress && data.taskCount > 0) {
    const pct = Math.round(((data.doneCount || 0) / data.taskCount) * 100);
    ariaTeamProgress.textContent = `Progress: ${pct}% (${data.doneCount}/${data.taskCount})`;
  }
}

// Team card collapse toggle
if (ariaTeamCollapse) {
  ariaTeamCollapse.addEventListener('click', () => {
    teamCardCollapsed = !teamCardCollapsed;
    if (ariaTeamCard) ariaTeamCard.classList.toggle('collapsed', teamCardCollapsed);
    ariaTeamCollapse.textContent = teamCardCollapsed ? '▼' : '▲';
  });
}

// Listen for team updates from main process
if (window.aria.onTeamUpdated) {
  window.aria.onTeamUpdated((data) => {
    updateTeamCard(data);
  });
}

// ═══════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════

async function init() {
  // Focus input on load
  ariaInput.focus();

  // Bind suggestion chips from the static HTML
  bindSuggestionChips();

  // Fix 4: Initialize dev mode + coding mode state for the </> button
  try {
    const [devMode, codingStatus] = await Promise.all([
      window.aria.getDevMode().catch(() => false),
      window.aria.getCodingMode().catch(() => ({ enabled: false })),
    ]);
    devModeActive = !!devMode;
    codingModeActive = !!(codingStatus && codingStatus.enabled);
    updateCodingBtn();
  } catch (e) {
    console.error('[aria] init: could not load dev/coding mode:', e);
  }

  // Fix 4: Load initial team status
  try {
    const teamStatus = await window.aria.getTeamStatus().catch(() => null);
    if (teamStatus) updateTeamCard(teamStatus);
  } catch (e) {
    // ignore — team may not be initialized yet
  }

  // Load conversations sidebar
  await loadConversations();

  // Get active conversation from main process
  try {
    const activeId = await window.aria.getActiveConversationId();
    if (activeId) {
      currentConversationId = activeId;
      setActiveConvInSidebar(activeId);
      await loadMessagesForConversation(activeId);
    } else if (conversations.length > 0) {
      // Switch to most recent
      currentConversationId = conversations[0].id;
      setActiveConvInSidebar(currentConversationId);
      await loadMessagesForConversation(currentConversationId);
    } else {
      // No conversations yet — show welcome, create one lazily on first message
      showWelcome();
    }
  } catch (e) {
    console.error('[aria] init error:', e);
    showWelcome();
  }
}

// Wait for DOM + preload to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
