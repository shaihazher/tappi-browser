/**
 * aria.js — Full Aria tab UI controller (Phase 8.35).
 *
 * Uses window.aria (from aria-preload.ts) for all IPC communication.
 * Uses marked.js (vendor/marked.min.js) for markdown rendering.
 */

// @ts-check
'use strict';

/** Reusable Aria sparkle icon SVG. */
function ariaIcon(size = 16) {
  return `<svg class="aria-icon${size >= 32 ? '-lg' : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"><path d="M12 2C12.3 7.5 16.5 11.7 22 12 16.5 12.3 12.3 16.5 12 22 11.7 16.5 7.5 12.3 2 12 7.5 11.7 11.7 7.5 12 2Z" fill="currentColor" opacity="0.85"/></svg>`;
}

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

// Phase 9.07: Projects state
let projects = [];           // list of project objects
let projectConvMap = {};     // { [projectId]: conversation[] }
let expandedProjects = {};   // { [projectId]: boolean } — whether expanded in sidebar

// Phase 9.09: Sidebar section state
let projectSectionCollapsed = false;  // whether "Coding Projects" section is collapsed
let currentProjectId = null;          // project_id of the current conversation
let currentProjectName = null;        // name of the active project

const TOKEN_CONTEXT_LIMIT = 200000;

// ═══════════════════════════════════════════
//  DOM REFERENCES
// ═══════════════════════════════════════════

const convList             = document.getElementById('conversation-list');
const sidebarSearch        = document.getElementById('sidebar-search');
const newChatBtn           = document.getElementById('new-chat-btn');
// Phase 9.09: Project indicator elements
const ariaProjectIndicator = document.getElementById('aria-project-indicator');
const ariaProjectIndicatorText = document.getElementById('aria-project-indicator-text');
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
    // Sanitize with DOMPurify (defense-in-depth alongside CSP)
    html = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(html) : html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
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
      <div class="welcome-icon">${ariaIcon(48)}</div>
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
    const [list, projectList] = await Promise.all([
      window.aria.listConversations(),
      (window.aria.listProjects ? window.aria.listProjects(false) : Promise.resolve([])).catch(() => []),
    ]);
    conversations = list || [];
    projects = projectList || [];

    // Fetch conversations for each project
    projectConvMap = {};
    if (projects.length > 0 && window.aria.getProjectConversations) {
      await Promise.all(projects.map(async (p) => {
        try {
          projectConvMap[p.id] = await window.aria.getProjectConversations(p.id) || [];
        } catch {
          projectConvMap[p.id] = [];
        }
      }));
    }

    // Phase 9.09: Detect current project from active conversation
    _detectCurrentProject();

    renderConversationList(conversations);
  } catch (e) {
    console.error('[aria] listConversations error:', e);
    convList.innerHTML = '<div class="conv-empty">Could not load conversations.</div>';
  }
}

// Phase 9.09: Determine the project for the active conversation
function _detectCurrentProject() {
  currentProjectId = null;
  currentProjectName = null;
  if (!currentConversationId) {
    updateActiveProjectIndicator();
    return;
  }
  // Check projectConvMap
  for (const proj of projects) {
    const convs = projectConvMap[proj.id] || [];
    if (convs.some(c => c.id === currentConversationId)) {
      currentProjectId = proj.id;
      currentProjectName = proj.name;
      break;
    }
  }
  // Also check conversation's own project_id field if present
  if (!currentProjectId) {
    const conv = conversations.find(c => c.id === currentConversationId);
    if (conv && conv.project_id) {
      currentProjectId = conv.project_id;
      const proj = projects.find(p => p.id === conv.project_id);
      currentProjectName = proj ? proj.name : '(project)';
    }
  }
  updateActiveProjectIndicator();
}

// Phase 9.09: Show/hide the active project indicator in the sidebar header
function updateActiveProjectIndicator() {
  if (!ariaProjectIndicator || !ariaProjectIndicatorText) return;
  if (currentProjectName) {
    ariaProjectIndicatorText.textContent = '🏗 ' + currentProjectName;
    ariaProjectIndicator.classList.remove('hidden');
  } else {
    ariaProjectIndicator.classList.add('hidden');
  }
}

function renderConversationList(list) {
  convList.innerHTML = '';

  // Collect IDs of conversations that belong to a project
  const projectedConvIds = new Set();
  projects.forEach(p => {
    const projConvs = projectConvMap[p.id] || [];
    projConvs.forEach(c => projectedConvIds.add(c.id));
  });

  // ─── Coding Projects section (always shown — even when empty, for [+ New Project]) ─
  {
    // Section header row: ▾/▸ 🏗 Coding Projects  [+ New Project]
    const sectionHeader = document.createElement('div');
    sectionHeader.className = 'projects-section-header';

    const collapseSpan = document.createElement('span');
    collapseSpan.className = 'section-collapse';
    collapseSpan.textContent = projectSectionCollapsed ? '▸' : '▾';

    const iconSpan = document.createElement('span');
    iconSpan.className = 'section-icon';
    iconSpan.textContent = '🏗';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'section-title';
    titleSpan.textContent = 'Coding Projects';

    const newProjBtn = document.createElement('button');
    newProjBtn.className = 'section-new-btn';
    newProjBtn.textContent = '+ New Project';
    newProjBtn.title = 'Create a new coding project';

    sectionHeader.appendChild(collapseSpan);
    sectionHeader.appendChild(iconSpan);
    sectionHeader.appendChild(titleSpan);
    sectionHeader.appendChild(newProjBtn);

    // Collapse/expand the whole section
    const toggleSection = () => {
      projectSectionCollapsed = !projectSectionCollapsed;
      renderConversationList(conversations);
    };
    collapseSpan.addEventListener('click', (e) => { e.stopPropagation(); toggleSection(); });
    iconSpan.addEventListener('click', (e) => { e.stopPropagation(); toggleSection(); });
    titleSpan.addEventListener('click', (e) => { e.stopPropagation(); toggleSection(); });
    sectionHeader.addEventListener('click', toggleSection);

    // [+ New Project] button
    newProjBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showNewProjectInput();
    });

    convList.appendChild(sectionHeader);

    // If section is not collapsed, render each project (or empty state)
    if (!projectSectionCollapsed) {
      if (projects.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'conv-empty-indented';
        empty.textContent = 'No projects yet. Click "+ New Project" to start.';
        convList.appendChild(empty);
      }
      projects.forEach(project => {
        const projConvs = projectConvMap[project.id] || [];
        const isExpanded = expandedProjects[project.id] !== false; // default expanded

        // ── Project row ──────────────────────────────────────────────────
        const projEl = document.createElement('div');
        projEl.className = 'project-item';
        projEl.dataset.projectId = project.id;

        const expandSpan = document.createElement('span');
        expandSpan.className = 'project-expand';
        expandSpan.textContent = isExpanded ? '▾' : '▸';

        const projIconSpan = document.createElement('span');
        projIconSpan.className = 'project-icon';
        projIconSpan.textContent = '🏗';

        const projNameSpan = document.createElement('span');
        projNameSpan.className = 'project-name';
        projNameSpan.textContent = project.name;

        const projCountSpan = document.createElement('span');
        projCountSpan.className = 'project-count';
        projCountSpan.textContent = String(projConvs.length);

        // [+ Conv] button (visible on hover via CSS)
        const newConvBtn = document.createElement('button');
        newConvBtn.className = 'project-new-conv-btn';
        newConvBtn.textContent = '+ Conv';
        newConvBtn.title = 'New conversation in ' + project.name;

        // [🗑] delete button (visible on hover via CSS)
        const delProjBtn = document.createElement('button');
        delProjBtn.className = 'project-delete-btn';
        delProjBtn.textContent = '🗑';
        delProjBtn.title = 'Delete project…';

        projEl.appendChild(expandSpan);
        projEl.appendChild(projIconSpan);
        projEl.appendChild(projNameSpan);
        projEl.appendChild(projCountSpan);
        projEl.appendChild(newConvBtn);
        projEl.appendChild(delProjBtn);

        // Toggle expand/collapse project conversations
        const toggleProject = (e) => {
          e.stopPropagation();
          expandedProjects[project.id] = !isExpanded;
          renderConversationList(conversations);
        };
        expandSpan.addEventListener('click', toggleProject);
        projIconSpan.addEventListener('click', toggleProject);
        projNameSpan.addEventListener('click', toggleProject);
        projCountSpan.addEventListener('click', toggleProject);
        projEl.addEventListener('click', (e) => {
          if (e.target === projEl) toggleProject(e);
        });

        // [+ Conv] — create a new conversation inside this project
        newConvBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          createProjectConversation(project.id);
        });

        // [🗑] — show project deletion modal
        delProjBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          showProjectDeleteModal(project);
        });

        // Right-click on project row — context menu
        projEl.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          showProjectContextMenu(e.clientX, e.clientY, project);
        });

        convList.appendChild(projEl);

        // ── Project conversations (indented, when expanded) ──────────────
        if (isExpanded) {
          if (projConvs.length > 0) {
            projConvs.forEach(conv => {
              convList.appendChild(_buildConvItem(conv, true));
            });
          } else {
            const empty = document.createElement('div');
            empty.className = 'conv-empty-indented';
            empty.textContent = 'No conversations yet';
            convList.appendChild(empty);
          }
        }
      });
    }
  }

  // ─── Recent section (conversations with no project) ───────────────────────
  // De-dup: filter out any conversation that belongs to a project
  const recentConvs = (list || []).filter(c =>
    !projectedConvIds.has(c.id) && !c.project_id
  );

  {
    // Always show "Recent" header when Coding Projects section is visible
    const recentHeader = document.createElement('div');
    recentHeader.className = 'conv-section-header';
    recentHeader.textContent = 'Recent';
    convList.appendChild(recentHeader);

    if (recentConvs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'conv-empty';
      empty.innerHTML = 'No conversations yet.<br>Start a new chat above.';
      convList.appendChild(empty);
    } else {
      recentConvs.forEach(conv => {
        convList.appendChild(_buildConvItem(conv, false));
      });
    }
  }
}

// ─── Create project conversation ────────────────────────────────────────────

async function createProjectConversation(projectId) {
  try {
    const convId = await window.aria.newProjectConversation(projectId);
    if (!convId) return;
    currentConversationId = convId;
    // Expand this project so the new conv is visible
    expandedProjects[projectId] = true;
    // Reload everything — the new-conversation IPC also emits projects:updated
    await loadConversations();
    setActiveConvInSidebar(convId);
    showWelcome();
    updateTokenBar(0, 0);
    ariaInput.focus();
  } catch (e) {
    console.error('[aria] createProjectConversation error:', e);
  }
}

// ─── Project context menu (right-click) ─────────────────────────────────────

let _projCtxMenu = null;

function showProjectContextMenu(x, y, project) {
  if (_projCtxMenu) { _projCtxMenu.remove(); _projCtxMenu = null; }

  const menu = document.createElement('div');
  menu.className = 'conv-context-menu';
  menu.innerHTML = `
    <div class="conv-ctx-item" data-action="delete-project">🗑 Delete project…</div>
  `;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);
  _projCtxMenu = menu;

  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth)   menu.style.left = (x - rect.width) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top  = (y - rect.height) + 'px';
  });

  menu.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (_projCtxMenu) { _projCtxMenu.remove(); _projCtxMenu = null; }
    if (action === 'delete-project') showProjectDeleteModal(project);
  });

  setTimeout(() => document.addEventListener('click', () => {
    if (_projCtxMenu) { _projCtxMenu.remove(); _projCtxMenu = null; }
  }, { once: true }), 0);
}

// ─── Project deletion modal ───────────────────────────────────────────────────

let _projDeleteModal = null;

function showProjectDeleteModal(project) {
  // Remove any existing modal
  if (_projDeleteModal) { _projDeleteModal.remove(); _projDeleteModal = null; }

  const overlay = document.createElement('div');
  overlay.className = 'proj-delete-overlay';

  const card = document.createElement('div');
  card.className = 'proj-delete-card';

  const title = document.createElement('div');
  title.className = 'proj-delete-title';
  title.textContent = `Delete project "${project.name}"?`;

  const subtitle = document.createElement('div');
  subtitle.className = 'proj-delete-subtitle';
  subtitle.textContent = 'Choose how to delete this project:';

  // ── Option 1: Remove from sidebar ──
  const unlinkBtn = document.createElement('button');
  unlinkBtn.className = 'proj-delete-btn-unlink';
  unlinkBtn.innerHTML = `<span class="proj-delete-btn-icon">↩</span>
    <span class="proj-delete-btn-text">
      <strong>Remove from sidebar</strong>
      <small>Unlinks the project. Conversations return to Recent. Files on disk are untouched.</small>
    </span>`;

  // ── Option 2: Delete everything ──
  const deleteAllBtn = document.createElement('button');
  deleteAllBtn.className = 'proj-delete-btn-danger';
  deleteAllBtn.innerHTML = `<span class="proj-delete-btn-icon">🗑</span>
    <span class="proj-delete-btn-text">
      <strong>Delete everything</strong>
      <small>Deletes all conversations, moves the working directory to trash. Irreversible.</small>
    </span>`;

  // ── Cancel ──
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'proj-delete-btn-cancel';
  cancelBtn.textContent = 'Cancel';

  card.appendChild(title);
  card.appendChild(subtitle);
  card.appendChild(unlinkBtn);
  card.appendChild(deleteAllBtn);
  card.appendChild(cancelBtn);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  _projDeleteModal = overlay;

  const closeModal = () => {
    if (_projDeleteModal) { _projDeleteModal.remove(); _projDeleteModal = null; }
  };

  cancelBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

  unlinkBtn.addEventListener('click', async () => {
    closeModal();
    await _executeProjectDelete(project, 'unlink');
  });

  deleteAllBtn.addEventListener('click', async () => {
    closeModal();
    await _executeProjectDelete(project, 'delete-all');
  });
}

async function _executeProjectDelete(project, mode) {
  try {
    // Capture the project's conversation IDs BEFORE mutating local state
    const projConvIds = new Set((projectConvMap[project.id] || []).map(c => c.id));
    const activeConvWasInProject = projConvIds.has(currentConversationId);

    const result = await window.aria.deleteProject(project.id, mode);
    if (!result || !result.success) {
      console.error('[aria] deleteProject failed:', result?.error || result);
      // Show error to user if it's an active-team block
      if (result?.error) {
        alert(result.error);
      }
      return;
    }

    // Phase 9.096b: After delete-all DB cleanup succeeds, offer to trash the directory
    // This is a SEPARATE step with its own confirmation
    if (mode === 'delete-all' && project.working_dir) {
      const trashConfirm = confirm(
        `Project data deleted from browser.\n\n` +
        `Also move the working directory to Trash?\n` +
        `${project.working_dir}\n\n` +
        `Click OK to move to Trash, or Cancel to keep files on disk.`
      );
      if (trashConfirm) {
        const trashResult = await window.aria.trashProjectDir(project.working_dir);
        if (!trashResult?.success) {
          alert(`Could not trash directory: ${trashResult?.error || 'unknown error'}`);
        }
      }
    }

    // Remove project from local state
    projects = projects.filter(p => p.id !== project.id);
    delete projectConvMap[project.id];
    delete expandedProjects[project.id];

    // If the active conversation was deleted (delete-all mode), switch away
    if (mode === 'delete-all' && activeConvWasInProject) {
      // Remove deleted conversations from local list
      conversations = conversations.filter(c => !projConvIds.has(c.id));
      if (conversations.length > 0) {
        await switchToConversation(conversations[0].id);
      } else {
        const newConv = await window.aria.newChat();
        if (newConv) {
          currentConversationId = newConv.id;
          conversations = [newConv];
          showWelcome();
          updateTokenBar(0, 0);
        }
      }
      await loadConversations();
      return;
    }

    // Refresh sidebar
    await loadConversations();
  } catch (e) {
    console.error('[aria] _executeProjectDelete error:', e);
  }
}

// ─── Inline new project input ────────────────────────────────────────────────

function showNewProjectInput() {
  // Insert the input row at the top of the projects section (right after the header)
  // Find the section header to insert after
  const sectionHeader = convList.querySelector('.projects-section-header');

  // Remove existing input row if any
  const existing = convList.querySelector('.new-project-row');
  if (existing) { existing.remove(); return; }

  const row = document.createElement('div');
  row.className = 'new-project-row';

  const input = document.createElement('input');
  input.className = 'new-project-input';
  input.type = 'text';
  input.placeholder = 'Project name…';
  input.maxLength = 80;
  input.spellcheck = false;

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'new-project-confirm-btn';
  confirmBtn.textContent = '✓ Create';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'new-project-cancel-btn';
  cancelBtn.textContent = '✕';
  cancelBtn.title = 'Cancel';

  row.appendChild(input);
  row.appendChild(confirmBtn);
  row.appendChild(cancelBtn);

  // Insert after section header (or at top of list if no header)
  if (sectionHeader && sectionHeader.nextSibling) {
    convList.insertBefore(row, sectionHeader.nextSibling);
  } else {
    convList.appendChild(row);
  }

  input.focus();

  const doCreate = async () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    row.remove();
    try {
      const project = await window.aria.createProject(name, '', '');
      if (project && project.id) {
        // Auto-create a conversation under the new project and switch to it
        expandedProjects[project.id] = true;
        const convId = await window.aria.newProjectConversation(project.id);
        if (convId) {
          currentConversationId = convId;
          await loadConversations();
          setActiveConvInSidebar(convId);
          showWelcome();
          updateTokenBar(0, 0);
          ariaInput.focus();
          return;
        }
      }
      // Fallback: just refresh sidebar
      await loadConversations();
    } catch (e) {
      console.error('[aria] createProject error:', e);
    }
  };

  confirmBtn.addEventListener('click', doCreate);
  cancelBtn.addEventListener('click', () => row.remove());
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); doCreate(); }
    if (e.key === 'Escape') row.remove();
  });
}

function _buildConvItem(conv, indented) {
  const el = document.createElement('div');
  el.className = 'conv-item' + (conv.id === currentConversationId ? ' active' : '') + (indented ? ' indented' : '');
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

  return el;
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
      // Phase 9.09: new chat has no project
      currentProjectId = null;
      currentProjectName = null;
      updateActiveProjectIndicator();
      _resetTeamPanel();
      _refreshTeamCard();
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
    // Phase 9.09: Update active project indicator
    _detectCurrentProject();
    await loadMessagesForConversation(convId);
    // Reset team card — re-check if a team is still active for this context
    _refreshTeamCard();
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

  // "Attach to project…" option — only when projects exist and conv has no project yet
  const attachRow = conv.project_id ? '' : `<div class="conv-ctx-item" data-action="attach">🏗 Attach to project…</div>`;
  const detachRow = conv.project_id ? `<div class="conv-ctx-item" data-action="detach">↩ Remove from project</div>` : '';

  menu.innerHTML = `
    <div class="conv-ctx-item" data-action="rename">✏️ Rename</div>
    ${attachRow}
    ${detachRow}
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
    if (action === 'attach') {
      closeContextMenu();
      showAttachProjectMenu(x, y, conv);
      return;
    }
    closeContextMenu();
    if (action === 'rename') await renameConversation(conv);
    if (action === 'delete') await deleteConversation(conv);
    if (action === 'detach') await detachFromProject(conv);
  });

  setTimeout(() => document.addEventListener('click', closeContextMenu, { once: true }), 0);
}

// ─── Attach to project picker ────────────────────────────────────────────────

let _pickerMenu = null;

function showAttachProjectMenu(x, y, conv) {
  if (_pickerMenu) { _pickerMenu.remove(); _pickerMenu = null; }

  const menu = document.createElement('div');
  menu.className = 'project-picker-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);
  _pickerMenu = menu;

  const header = document.createElement('div');
  header.className = 'project-picker-header';
  header.textContent = 'Attach to project';
  menu.appendChild(header);

  const activeProjects = projects.filter(p => !p.archived);
  if (activeProjects.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'project-picker-empty';
    empty.textContent = 'No projects yet. Create one first.';
    menu.appendChild(empty);
  } else {
    activeProjects.forEach(proj => {
      const item = document.createElement('div');
      item.className = 'project-picker-item';
      item.innerHTML = `<span>🏗</span><span>${escHtml(proj.name)}</span>`;
      item.addEventListener('click', async () => {
        if (_pickerMenu) { _pickerMenu.remove(); _pickerMenu = null; }
        try {
          await window.aria.linkConversationToProject(conv.id, proj.id);
          // Update the conv object in local state
          const idx = conversations.findIndex(c => c.id === conv.id);
          if (idx !== -1) conversations[idx].project_id = proj.id;
          // Reload sidebar
          await loadConversations();
        } catch (e) {
          console.error('[aria] linkConversationToProject error:', e);
        }
      });
      menu.appendChild(item);
    });
  }

  // Adjust position if overflowing
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth)  menu.style.left = (x - rect.width) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + 'px';
  });

  setTimeout(() => document.addEventListener('click', () => {
    if (_pickerMenu) { _pickerMenu.remove(); _pickerMenu = null; }
  }, { once: true }), 0);
}

async function detachFromProject(conv) {
  if (!conv.project_id) return;
  try {
    // We "detach" by nullifying project_id. There's no unlink IPC yet,
    // so we do a DB update via a workaround: re-run listConversations to get current state.
    // For now, emit a console note — the conversation is still linked in DB.
    // Full implementation: add projects:unlink-conversation IPC.
    console.warn('[aria] detachFromProject: no unlink IPC implemented yet');
  } catch (e) {
    console.error('[aria] detachFromProject error:', e);
  }
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
    // Raw HTML (deep mode plan cards) — sanitize for safety
    bubble.innerHTML = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(msg.content || '') : (msg.content || '');
    wrapper.style.maxWidth = '640px';
    wrapper.style.alignSelf = 'flex-start';
  } else if (role === 'assistant') {
    const mdDiv = document.createElement('div');
    mdDiv.className = 'md-content';
    mdDiv.innerHTML = renderMarkdown(msg.content || '');
    bubble.appendChild(mdDiv);
  } else if (role === 'thinking') {
    // Persisted thinking/reasoning — render as collapsible chip
    const content = msg.content || '';
    wrapper.className = 'aria-msg thinking';
    const chip = document.createElement('div');
    chip.className = 'aria-thinking-chip';
    const charCount = content.length;
    chip.innerHTML = `
      <div class="thinking-chip-header">
        <span class="thinking-chip-icon">🧠</span>
        <span class="thinking-chip-label">Thought (${charCount} chars) — click to expand</span>
        <span class="thinking-chip-toggle">▸</span>
      </div>
      <div class="thinking-chip-body"></div>`;
    // Set body text content (not innerHTML) to avoid XSS
    const body = chip.querySelector('.thinking-chip-body');
    if (body) body.textContent = content;
    const header = chip.querySelector('.thinking-chip-header');
    if (header) header.addEventListener('click', () => {
      chip.classList.toggle('expanded');
      const toggle = chip.querySelector('.thinking-chip-toggle');
      if (toggle) toggle.textContent = chip.classList.contains('expanded') ? '▾' : '▸';
    });
    bubble.innerHTML = '';
    bubble.appendChild(chip);
  } else if (role === 'download') {
    // Persisted download card — reconstruct from JSON payload
    try {
      const data = JSON.parse(msg.content || '{}');
      wrapper.className = 'aria-msg assistant';
      bubble.innerHTML = '';
      // Reuse renderDownloadCard logic but return the card element
      const card = _buildDownloadCard(data);
      if (card) bubble.appendChild(card);
    } catch {
      bubble.textContent = msg.content || '';
    }
  } else if (role === 'tool') {
    // Render tool results with markdown for multi-line outputs (team_status etc.)
    const content = msg.content || '';
    if (content.includes('\n') || content.includes('**')) {
      const mdDiv = document.createElement('div');
      mdDiv.className = 'md-content tool-content';
      mdDiv.innerHTML = renderMarkdown(content);
      bubble.appendChild(mdDiv);
    } else {
      bubble.textContent = content;
    }
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
    window.aria.sendMessage(trimmed, currentConversationId, codingModeActive);
  } catch (e) {
    console.error('[aria] sendMessage error:', e);
    setStreamingState(false);
    appendMessage('system', 'Error sending message: ' + (e.message || e));
  }
}

// ─── Input event handlers ─────────────────

ariaSendBtn.addEventListener('click', () => {
  if (isStreaming) {
    // Phase 9.096e: If user typed something, interrupt with redirect; otherwise just stop
    const redirectText = ariaInput.value.trim();
    if (redirectText) {
      ariaInput.value = '';
      ariaInput.style.height = 'auto';
      if (window.aria && window.aria.interruptAgent) {
        window.aria.interruptAgent('main', null, redirectText);
      }
    } else {
      window.aria.stopAgent();
    }
    setStreamingState(false);
    return;
  }
  sendMessage(ariaInput.value);
});

ariaStopBtn.addEventListener('click', () => {
  if (isStreaming) {
    // Phase 9.096e: If user typed something, interrupt with redirect; otherwise just stop
    const redirectText = ariaInput.value.trim();
    if (redirectText) {
      ariaInput.value = '';
      ariaInput.style.height = 'auto';
      if (window.aria && window.aria.interruptAgent) {
        window.aria.interruptAgent('main', null, redirectText);
      }
    } else {
      window.aria.stopAgent();
    }
    setStreamingState(false);
  }
});

ariaInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (isStreaming) {
      // Phase 9.096e: If user typed something, interrupt with redirect; otherwise ignore
      const redirectText = ariaInput.value.trim();
      if (redirectText) {
        ariaInput.value = '';
        ariaInput.style.height = 'auto';
        if (window.aria && window.aria.interruptAgent) {
          window.aria.interruptAgent('main', null, redirectText);
        }
        setStreamingState(false);
      }
      // If no text, Enter during streaming is a no-op (Escape or stop btn to cancel)
      return;
    }
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
    // Phase 9.096e: Keep input enabled so user can type a redirect message
    ariaInput.disabled = false;
    ariaInput.placeholder = 'Type to redirect, or press Stop…';
  } else {
    ariaStopBtn.classList.add('hidden');
    ariaSendBtn.classList.remove('hidden');
    ariaInput.disabled = false;
    ariaInput.placeholder = 'Ask Aria anything…';
    streamBuffer = '';
    clearTimeout(_streamRenderTimer);
    ariaInput.focus();
  }
}

// ═══════════════════════════════════════════
//  IPC LISTENERS — Streaming
// ═══════════════════════════════════════════

window.aria.onStreamStart(() => {
  // Reset stream state — don't create bubble yet; it's created on first text chunk
  // so that thinking chips and tool results appear ABOVE the response
  streamBuffer = '';
  _streamBubbleEl = null;
  _streamMdDiv = null;
  _streamTextSavedUpTo = 0;
});

let _streamBubbleEl = null;
let _streamMdDiv = null;
let _streamTextSavedUpTo = 0; // Track how much text was already saved as messages

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
  // Phase 9 fix: If the bubble was finalized (e.g., tool result interrupted it),
  // create a new one for the continuing text.
  if (!_streamBubbleEl) {
    // Only show text that came AFTER the last save point
    const newText = text.slice(_streamTextSavedUpTo);
    if (!newText.trim()) return;
    _prepareStreamBubble();
  }

  if (!_streamMdDiv) {
    // Replace typing indicator with md-content
    _streamBubbleEl.innerHTML = '';
    _streamMdDiv = document.createElement('div');
    _streamMdDiv.className = 'md-content';
    _streamBubbleEl.appendChild(_streamMdDiv);
  }

  // Show only text after the last save point (if bubble was recreated after tool interruption)
  const displayText = _streamTextSavedUpTo > 0 ? text.slice(_streamTextSavedUpTo) : text;
  _streamMdDiv.innerHTML = renderMarkdown(displayText) + (!done ? '<span class="streaming-cursor"></span>' : '');
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

  // Add remaining unsaved text as a message
  const unsavedText = streamBuffer.slice(_streamTextSavedUpTo);
  if (unsavedText.trim()) {
    messages.push({ role: 'assistant', content: unsavedText, timestamp: Date.now() });
  }

  _streamBubbleEl = null;
  _streamMdDiv = null;
  _streamTextSavedUpTo = 0;
  streamBuffer = '';
}

// ─── Reasoning / thinking chip ────────────────────────────────────────────────

let _thinkingChipEl = null;

window.aria.onReasoningChunk(({ text, done }) => {
  if (!_thinkingChipEl) {
    // Create the thinking chip once on first reasoning event
    _thinkingChipEl = document.createElement('div');
    _thinkingChipEl.className = 'aria-thinking-chip';
    _thinkingChipEl.innerHTML = `
      <div class="thinking-chip-header">
        <span class="thinking-chip-icon">🧠</span>
        <span class="thinking-chip-label">Thinking…</span>
        <span class="thinking-chip-toggle">▾</span>
      </div>
      <div class="thinking-chip-body"></div>`;
    // Wire toggle via addEventListener (CSP blocks inline onclick)
    const header = _thinkingChipEl.querySelector('.thinking-chip-header');
    if (header) header.addEventListener('click', () => _thinkingChipEl?.classList.toggle('expanded'));
    const chatMessages = document.getElementById('aria-messages');
    if (chatMessages) chatMessages.appendChild(_thinkingChipEl);
    _thinkingChipEl.classList.add('expanded'); // expand live while streaming
    chatMessages?.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });
  }

  const body = _thinkingChipEl.querySelector('.thinking-chip-body');
  if (body) body.textContent = text;

  const chatMessages = document.getElementById('aria-messages');
  chatMessages?.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });

  if (done) {
    // Collapse the chip and update label
    const label = _thinkingChipEl.querySelector('.thinking-chip-label');
    if (label) label.textContent = `Thought (${text.length} chars) — click to expand`;
    _thinkingChipEl.classList.remove('expanded');
    _thinkingChipEl = null; // reset for next turn
  }
});

// ─── Tool results ─────────────────────────

window.aria.onToolResult(result => {
  if (!result) return;

  // Phase 9 fix: If there's an active stream bubble with text, finalize it
  // so the tool result appears BELOW the previous text, and any subsequent
  // text chunks will create a new bubble below the tool results.
  if (_streamBubbleEl && streamBuffer.trim()) {
    _updateStreamBubble(streamBuffer, true);
    const cursor = _streamBubbleEl.querySelector('.streaming-cursor');
    if (cursor) cursor.remove();
    const wrapper = document.getElementById('aria-stream-bubble');
    if (wrapper) wrapper.removeAttribute('id');
    // Save the text so far as a partial assistant message
    messages.push({ role: 'assistant', content: streamBuffer, timestamp: Date.now() });
    _streamTextSavedUpTo = streamBuffer.length;
    _streamBubbleEl = null;
    _streamMdDiv = null;
    // Don't clear streamBuffer — it keeps accumulating for the full LLM turn
  }

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

// Phase 9.09: Real-time project updates pushed from main process
// Debounce projects:updated to avoid redundant sidebar reloads
// (multiple IPC calls fire this in quick succession during project creation)
let _projectsUpdateTimer = null;
if (window.aria.onProjectsUpdated) {
  window.aria.onProjectsUpdated(() => {
    if (_projectsUpdateTimer) clearTimeout(_projectsUpdateTimer);
    _projectsUpdateTimer = setTimeout(async () => {
      _projectsUpdateTimer = null;
      await loadConversations();
      setActiveConvInSidebar(currentConversationId);
    }, 150);
  });
}

window.aria.onConversationSwitched(async data => {
  if (!data || !data.conversationId) return;
  if (data.conversationId !== currentConversationId) {
    currentConversationId = data.conversationId;
    setActiveConvInSidebar(currentConversationId);
    _resetTeamPanel();
    // Phase 9.09: Update active project indicator
    _detectCurrentProject();
    await loadMessagesForConversation(currentConversationId);
  }
});

// ═══════════════════════════════════════════
//  DEEP MODE SUPPORT
// ═══════════════════════════════════════════

let _deepSubtaskText = {};
let _deepToolData = {};  // { index: [{ toolName, summary, detail }] }
let _deepTotalSteps = 0;
let _deepDoneSteps = 0;
let _deepOutputDir = null;
let _deepParallelMode = false;

// ─── Team Live Panel state ───
let _teamPanelEl = null;
let _teammateCards = {}; // { [name]: { cardEl, outputEl, statusEl } }

function _resetTeamPanel() {
  _teamPanelEl = null;
  _teammateCards = {};
}

function ensureTeamPanel() {
  if (_teamPanelEl) return;
  _teamPanelEl = document.createElement('div');
  _teamPanelEl.className = 'team-live-panel';
  _teamPanelEl.innerHTML = `
    <div class="team-live-header">
      <span>👥 Team Orchestration</span>
      <span class="team-live-status">starting…</span>
    </div>
    <div class="team-live-body"></div>
    <div class="team-mailbox-log"></div>`;
  const msgs = document.getElementById('aria-messages');
  if (msgs) msgs.appendChild(_teamPanelEl);
  scrollToBottom();
}

function getOrCreateTeammateCard(name, role, task) {
  if (_teammateCards[name]) return _teammateCards[name];
  ensureTeamPanel();
  const body = _teamPanelEl.querySelector('.team-live-body');
  const card = document.createElement('div');
  card.className = 'team-mate-card';
  card.innerHTML = `
    <div class="team-mate-header">
      <span class="team-mate-name">${escHtml(name)}</span>
      <span class="team-mate-role">${escHtml(role || '')}</span>
      <span class="team-mate-status working">working</span>
      <button class="team-redirect-btn" title="Redirect ${escHtml(name)} with new instructions">✋</button>
    </div>
    <div class="team-mate-task">${escHtml((task || '').slice(0, 80))}</div>
    <div class="team-mate-pulse" style="display:none"></div>
    <div class="team-mate-reasoning" style="display:none"></div>
    <div class="team-mate-output"></div>`;
  body.appendChild(card);

  // Redirect button click — show inline input for redirect instruction
  const redirectBtn = card.querySelector('.team-redirect-btn');
  if (redirectBtn) {
    redirectBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Show inline redirect input
      let redirectRow = card.querySelector('.team-redirect-row');
      if (redirectRow) { redirectRow.remove(); return; } // toggle
      redirectRow = document.createElement('div');
      redirectRow.className = 'team-redirect-row';
      redirectRow.innerHTML = `
        <input class="team-redirect-input" type="text" placeholder="Enter redirect instructions…" autocomplete="off">
        <button class="team-redirect-send">↪</button>`;
      card.appendChild(redirectRow);
      const input = redirectRow.querySelector('.team-redirect-input');
      const sendBtn = redirectRow.querySelector('.team-redirect-send');
      if (input) input.focus();
      const doRedirect = () => {
        const msg = input ? input.value.trim() : '';
        if (!msg) return;
        if (window.aria && window.aria.interruptAgent) {
          window.aria.interruptAgent('teammate', name, msg)
            .then(res => console.log('[aria] Redirect result:', res))
            .catch(err => console.error('[aria] Redirect error:', err));
        }
        card.classList.add('interrupt-flash');
        setTimeout(() => card.classList.remove('interrupt-flash'), 1200);
        redirectRow.remove();
      };
      if (input) input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') doRedirect(); if (ev.key === 'Escape') redirectRow.remove(); });
      if (sendBtn) sendBtn.addEventListener('click', doRedirect);
    });
  }

  _teammateCards[name] = {
    cardEl: card,
    outputEl: card.querySelector('.team-mate-output'),
    statusEl: card.querySelector('.team-mate-status'),
    pulseEl: card.querySelector('.team-mate-pulse'),
    reasoningEl: card.querySelector('.team-mate-reasoning'),
  };
  return _teammateCards[name];
}

window.aria.onDeepPlan(data => {
  const { mode, subtasks, parallel } = data || {};
  if (!subtasks) return;
  _deepSubtaskText = {};
  _deepToolData = {};
  _deepTotalSteps = subtasks.length;
  _deepDoneSteps = 0;
  _deepOutputDir = null;
  _deepParallelMode = !!parallel;

  let html = '<div class="deep-plan">';
  html += `<div class="deep-plan-header">📋 ${subtasks.length} steps <span class="deep-plan-mode ${escHtml(mode)}">${escHtml(mode)}</span>${_deepParallelMode ? ' <span class="deep-plan-mode parallel">⚡ parallel</span>' : ''}</div>`;
  // Progress bar
  html += `<div class="deep-progress-bar"><div class="deep-progress-fill" id="aria-deep-progress"></div></div>`;

  subtasks.forEach((s, i) => {
    const taskStr = (s.task || '').slice(0, 80);
    const truncated = (s.task || '').length > 80 ? '…' : '';
    html += `<div class="deep-step" id="aria-deep-step-${i}">`;
    html += `  <div class="deep-step-header" data-step-index="${i}">`;
    html += `    <span class="deep-chevron" id="aria-deep-chevron-${i}">▶</span>`;
    html += `    <span class="deep-step-status" id="aria-deep-status-${i}">⏳</span>`;
    html += `    <span class="deep-step-title"><b>${i + 1}.</b> ${escHtml(taskStr)}${truncated}</span>`;
    html += `    <span class="deep-step-duration" id="aria-deep-dur-${i}"></span>`;
    html += `    <button class="deep-redirect-btn" id="aria-deep-redirect-${i}" data-step-index="${i}" style="display:none" title="Redirect this subtask">✋</button>`;
    html += `  </div>`;
    html += `  <div class="deep-step-tools" id="aria-deep-tools-${i}"></div>`;
    html += `  <div class="deep-step-stream" id="aria-deep-stream-${i}"></div>`;
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

function _updateDeepProgress() {
  const fill = document.getElementById('aria-deep-progress');
  if (fill && _deepTotalSteps > 0) {
    const pct = Math.round((_deepDoneSteps / _deepTotalSteps) * 100);
    fill.style.width = pct + '%';
  }
}

window._ariaToggleDeepStep = function(idx) {
  const stream = document.getElementById('aria-deep-stream-' + idx);
  const chev   = document.getElementById('aria-deep-chevron-' + idx);
  if (!stream) return;
  const visible = stream.classList.contains('visible');
  stream.classList.toggle('visible', !visible);
  if (chev) chev.classList.toggle('open', !visible);
};

// Toggle tool detail expansion
window._ariaToggleToolDetail = function(idx, toolIdx) {
  const detail = document.getElementById(`aria-deep-tool-detail-${idx}-${toolIdx}`);
  if (detail) detail.classList.toggle('visible');
};

window.aria.onDeepSubtaskStart(data => {
  const { index } = data || {};
  if (index == null) return;
  const el        = document.getElementById('aria-deep-step-' + index);
  const status    = document.getElementById('aria-deep-status-' + index);
  const stream    = document.getElementById('aria-deep-stream-' + index);
  const chev      = document.getElementById('aria-deep-chevron-' + index);
  const redirectBtn = document.getElementById('aria-deep-redirect-' + index);

  if (el)     el.classList.add('active');
  if (status) status.textContent = '⟳';
  if (stream) {
    stream.innerHTML = '<em style="color:var(--text-dim)">Working…</em>';
    stream.classList.add('visible', 'streaming');
  }
  if (chev) chev.classList.add('open');
  if (redirectBtn) redirectBtn.style.display = '';
  _deepSubtaskText[index] = '';
  _deepToolData[index] = [];

  // In sequential mode, collapse other streams.
  // In parallel mode (research OR DAG action mode), keep all visible simultaneously.
  if (!_deepParallelMode) {
    document.querySelectorAll('.deep-step-stream.visible').forEach(s => {
      const id = parseInt(s.id.replace('aria-deep-stream-', ''));
      if (!isNaN(id) && id !== index) {
        s.classList.remove('visible', 'streaming');
        const c = document.getElementById('aria-deep-chevron-' + id);
        if (c) c.classList.remove('open');
      }
    });
  }

  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

window.aria.onDeepSubtaskDone(data => {
  const { index, status, duration, error } = data || {};
  if (index == null) return;
  const el          = document.getElementById('aria-deep-step-' + index);
  const statusEl    = document.getElementById('aria-deep-status-' + index);
  const durEl       = document.getElementById('aria-deep-dur-' + index);
  const stream      = document.getElementById('aria-deep-stream-' + index);
  const redirectBtn = document.getElementById('aria-deep-redirect-' + index);
  if (redirectBtn) redirectBtn.style.display = 'none';

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

  // Auto-collapse completed step stream (keep tools as chips) after a short delay.
  // In parallel mode (research OR DAG action), wait longer so the user can read
  // results from steps that finish early while others are still running.
  if (status === 'done' && stream) {
    const collapseDelay = _deepParallelMode ? 3000 : 800;
    setTimeout(() => {
      stream.classList.remove('visible');
      const chev = document.getElementById('aria-deep-chevron-' + index);
      if (chev) chev.classList.remove('open');
    }, collapseDelay);
  }

  // Update progress
  if (status === 'done') {
    _deepDoneSteps++;
    _updateDeepProgress();
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

// Deep mode reasoning / thinking chips (per-subtask)
let _deepThinkingChips = {};
if (window.aria.onDeepReasoningChunk) {
  window.aria.onDeepReasoningChunk(({ index, text, done }) => {
    if (index == null) return;
    const stream = document.getElementById('aria-deep-stream-' + index);
    if (!stream) return;

    if (!_deepThinkingChips[index]) {
      const chip = document.createElement('div');
      chip.className = 'aria-thinking-chip';
      chip.innerHTML = `
        <div class="thinking-chip-header">
          <span class="thinking-chip-icon">🧠</span>
          <span class="thinking-chip-label">Thinking…</span>
          <span class="thinking-chip-toggle">▾</span>
        </div>
        <div class="thinking-chip-body"></div>`;
      const header = chip.querySelector('.thinking-chip-header');
      if (header) header.addEventListener('click', () => chip.classList.toggle('expanded'));
      // Insert at the beginning of the stream div (before text content)
      stream.classList.add('visible');
      stream.insertBefore(chip, stream.firstChild);
      chip.classList.add('expanded');
      _deepThinkingChips[index] = chip;
    }

    const chip = _deepThinkingChips[index];
    const body = chip.querySelector('.thinking-chip-body');
    if (body) body.textContent = text;
    stream.scrollTop = stream.scrollHeight;

    if (done) {
      const label = chip.querySelector('.thinking-chip-label');
      if (label) label.textContent = `Thought (${text.length} chars) — click to expand`;
      chip.classList.remove('expanded');
      _deepThinkingChips[index] = null;
    }
  });
}

// Tool results as compact collapsible chips (Claude.ai-inspired)
if (window.aria.onDeepToolResult) {
  window.aria.onDeepToolResult(data => {
    const { index, toolName, display } = data || {};
    if (index == null) return;
    const toolsDiv = document.getElementById('aria-deep-tools-' + index);
    if (!toolsDiv) return;

    // Track tool data
    if (!_deepToolData[index]) _deepToolData[index] = [];
    const toolIdx = _deepToolData[index].length;

    // Parse display to extract a short summary
    const fullText = display || toolName || 'tool';
    const lines = fullText.split('\n');
    // First line is like "🔧 elements → 23 items" — use tool name + short result
    const shortName = (toolName || 'tool').replace(/_/g, ' ');
    let summary = '';
    if (lines.length > 1) {
      summary = lines[1].slice(0, 40).trim();
      if (lines[1].length > 40) summary += '…';
    } else if (fullText.includes('→')) {
      summary = fullText.split('→').slice(1).join('→').trim().slice(0, 40);
    }

    _deepToolData[index].push({ toolName, summary, detail: fullText });

    // Render as compact chip
    const chip = document.createElement('span');
    chip.className = 'deep-tool-chip';
    chip.onclick = () => window._ariaToggleToolDetail(index, toolIdx);
    chip.innerHTML = `<span class="tool-icon">🔧</span><span class="tool-name">${escHtml(shortName)}</span>${summary ? `<span class="tool-summary">— ${escHtml(summary)}</span>` : ''}`;
    toolsDiv.appendChild(chip);

    // Hidden expandable detail
    const detail = document.createElement('div');
    detail.className = 'deep-tool-detail';
    detail.id = `aria-deep-tool-detail-${index}-${toolIdx}`;
    detail.textContent = fullText.replace(/^🔧\s*/, '');
    toolsDiv.appendChild(detail);
  });
}

window.aria.onDeepComplete(data => {
  const { mode, durationSeconds, aborted, completedSteps, totalSteps, outputDirAbsolute, finalOutput } = data || {};
  const statusStr = aborted ? '⚠️ Aborted' : '✅ Complete';

  let completeHtml = '<div class="deep-complete">';
  completeHtml += `<div class="deep-complete-summary">${statusStr} — ${escHtml(mode)} mode, ${completedSteps}/${totalSteps} steps in ${Number(durationSeconds).toFixed(1)}s</div>`;
  completeHtml += '<div class="deep-complete-actions">';
  if (mode === 'research' && !aborted && outputDirAbsolute) {
    _deepOutputDir = outputDirAbsolute;
    completeHtml += `<div class="deep-download-group">`;
    completeHtml += `<button class="deep-download-btn" data-format="md">📥 .md</button>`;
    completeHtml += `<button class="deep-download-btn" data-format="html">📥 .html</button>`;
    completeHtml += `<button class="deep-download-btn" data-format="pdf">📥 .pdf</button>`;
    completeHtml += `<button class="deep-download-btn" data-format="txt">📥 .txt</button>`;
    completeHtml += `</div>`;
  }
  completeHtml += '</div>';
  completeHtml += '</div>';

  // Append completion card inside the existing plan card
  const planCard = document.querySelector('.deep-plan');
  if (planCard) {
    // Render final report as markdown in the compile step's stream div
    if (mode === 'research' && !aborted && finalOutput) {
      const compileIndex = totalSteps - 1;
      const compileStream = document.getElementById('aria-deep-stream-' + compileIndex);
      if (compileStream) {
        const mdDiv = document.createElement('div');
        mdDiv.className = 'md-content';
        mdDiv.innerHTML = renderMarkdown(finalOutput);
        compileStream.innerHTML = '';
        compileStream.appendChild(mdDiv);
        compileStream.classList.add('visible');
        const chev = document.getElementById('aria-deep-chevron-' + compileIndex);
        if (chev) chev.classList.add('open');
      }
    }

    // Append summary + download button at the end of the plan card
    const completeEl = document.createElement('div');
    completeEl.innerHTML = completeHtml;
    planCard.appendChild(completeEl.firstElementChild);

    // Update the stored message content for re-render persistence
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]._raw && messages[i].content && messages[i].content.includes('deep-plan')) {
        messages[i].content = planCard.outerHTML;
        break;
      }
    }
  } else {
    // Fallback: separate message
    messages.push({ role: 'assistant', content: completeHtml, _raw: true, timestamp: Date.now() });
    appendMessageEl({ role: 'assistant', content: completeHtml, _raw: true });
  }

  // Fill progress bar to 100%
  _deepDoneSteps = _deepTotalSteps;
  _updateDeepProgress();

  setStreamingState(false);
  scrollToBottom();
  setTimeout(() => loadConversations(), 500);
});

// Download report handler (format: 'md' | 'html' | 'pdf' | 'txt')
window._ariaDownloadReport = async function(format) {
  if (!_deepOutputDir) return;
  const fmt = format || 'md';
  try {
    const result = await window.aria.saveDeepReport(_deepOutputDir, fmt);
    if (result && result.success) {
      // Brief feedback
      appendMessage('system', `📥 Report saved to ${result.path}`);
    } else if (result && result.error && result.error !== 'Cancelled') {
      appendMessage('system', `❌ Save failed: ${result.error}`);
    }
  } catch (e) {
    appendMessage('system', '❌ Failed to save report: ' + (e.message || e));
  }
};

// ═══════════════════════════════════════════
//  DEEP MODE — EVENT DELEGATION (CSP-safe, no inline onclick)
// ═══════════════════════════════════════════

// Use a single delegated click handler on the messages container.
// This handles deep-step-header toggles and download button clicks
// regardless of when the elements are inserted into the DOM.
ariaMessages.addEventListener('click', (e) => {
  // Phase 9.096d: Deep mode redirect button — must check BEFORE header toggle
  const deepRedirectBtn = e.target.closest('.deep-redirect-btn');
  if (deepRedirectBtn) {
    e.stopPropagation();
    const idx = parseInt(deepRedirectBtn.dataset.stepIndex, 10);
    // Toggle inline redirect input
    const step = document.getElementById('aria-deep-step-' + idx);
    if (!step) return;
    let redirectRow = step.querySelector('.deep-step-redirect-row');
    if (redirectRow) { redirectRow.remove(); return; }
    redirectRow = document.createElement('div');
    redirectRow.className = 'deep-step-redirect-row';
    redirectRow.innerHTML = `
      <input class="deep-redirect-input" type="text" placeholder="Enter redirect instructions…" autocomplete="off">
      <button class="deep-redirect-send">↪</button>`;
    step.appendChild(redirectRow);
    const input = redirectRow.querySelector('.deep-redirect-input');
    const sendBtn = redirectRow.querySelector('.deep-redirect-send');
    if (input) input.focus();
    const doRedirect = () => {
      const msg = input ? input.value.trim() : '';
      if (!msg) return;
      if (window.aria && window.aria.interruptAgent) {
        window.aria.interruptAgent('subtask', String(idx), msg)
          .then(res => console.log('[aria] Subtask redirect:', res))
          .catch(err => console.error('[aria] Subtask redirect error:', err));
      }
      step.classList.add('interrupt-flash');
      setTimeout(() => step.classList.remove('interrupt-flash'), 1200);
      redirectRow.remove();
    };
    if (input) input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') doRedirect(); if (ev.key === 'Escape') redirectRow.remove(); });
    if (sendBtn) sendBtn.addEventListener('click', doRedirect);
    return;
  }

  // Deep step header toggle
  const header = e.target.closest('.deep-step-header');
  if (header) {
    const step = header.closest('.deep-step');
    if (step && step.id) {
      const idx = parseInt(step.id.replace('aria-deep-step-', ''), 10);
      if (!isNaN(idx)) window._ariaToggleDeepStep(idx);
    }
    return;
  }

  // Download format button
  const dlBtn = e.target.closest('.deep-download-btn');
  if (dlBtn) {
    const fmt = dlBtn.dataset.format || 'md';
    window._ariaDownloadReport(fmt);
    return;
  }
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
  // Phase 9: Toggle Matrix theme on body
  document.body.classList.toggle('coding-mode', codingModeActive);
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

// Re-fetch team status from backend and update card (hide if no active team)
async function _refreshTeamCard() {
  try {
    const status = await window.aria.getTeamStatus().catch(() => null);
    updateTeamCard(status);
  } catch {
    // No active team — hide
    if (ariaTeamCard) ariaTeamCard.classList.add('hidden');
  }
}

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
      // Show task assignment if available, otherwise fall back to role
      const displayText = tm.currentTask
        ? escHtml(tm.currentTask.slice(0, 60))
        : escHtml(tm.role.slice(0, 40));
      // Live activity indicators (passive — no teammate cooperation needed)
      let activityHtml = '';
      if (tm.status === 'working' && tm.toolCount > 0) {
        const elapsed = tm.elapsed || 0;
        const elapsedStr = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s` : `${elapsed}s`;
        const parts = [];
        parts.push(`${tm.toolCount} tools`);
        if (tm.filesWritten > 0) parts.push(`${tm.filesWritten} files`);
        parts.push(elapsedStr);
        if (tm.lastTool) parts.push(escHtml(tm.lastTool));
        activityHtml = `<div class="aria-team-activity">${parts.join(' · ')}</div>`;
      } else if (tm.status === 'done') {
        const elapsed = tm.elapsed || 0;
        const elapsedStr = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s` : `${elapsed}s`;
        activityHtml = `<div class="aria-team-activity done">${tm.toolCount || 0} tools · ${tm.filesWritten || 0} files · ${elapsedStr}</div>`;
      }
      return `<div class="aria-team-mate">
        <div class="aria-team-mate-row">
          <span>${emoji}</span>
          <span class="aria-team-name">${escHtml(tm.name)}</span>
          <span class="aria-team-role">${displayText}</span>
        </div>
        ${activityHtml}
      </div>`;
    }).join('');
  }

  // Progress — use teammate completion as primary indicator (task list may be empty)
  if (ariaTeamProgress) {
    const teammates = data.teammates || [];
    const totalTm = teammates.length;
    const doneTm = teammates.filter(t => t.status === 'done' || t.status === 'failed').length;
    const taskTotal = data.taskCount || 0;
    const taskDone = data.doneCount || 0;
    if (totalTm > 0) {
      const pct = Math.round((doneTm / totalTm) * 100);
      const extra = taskTotal > 0 ? ` · ${taskDone}/${taskTotal} tasks` : '';
      ariaTeamProgress.textContent = `${pct}% — ${doneTm}/${totalTm} teammates done${extra}`;
    } else if (taskTotal > 0) {
      const pct = Math.round((taskDone / taskTotal) * 100);
      ariaTeamProgress.textContent = `${pct}% — ${taskDone}/${taskTotal} tasks`;
    } else {
      ariaTeamProgress.textContent = '';
    }
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

// ─── Team Live Activity listeners (coding mode) ───
console.log('[aria] Registering team live listeners...',
  'onTeammateStart:', !!window.aria.onTeammateStart,
  'onTeammateTool:', !!window.aria.onTeammateTool,
  'onTeammateChunk:', !!window.aria.onTeammateChunk,
  'onTeammateDone:', !!window.aria.onTeammateDone,
  'onTeamMailboxMessage:', !!window.aria.onTeamMailboxMessage);

if (window.aria.onTeammateStart) {
  window.aria.onTeammateStart(({ name, role, task }) => {
    console.log('[aria] team:teammate-start received:', name, role, task?.slice(0, 40));
    const entry = getOrCreateTeammateCard(name, role, task);
    entry.cardEl.classList.add('active');
    scrollToBottom();
  });
}

if (window.aria.onTeammateTool) {
  window.aria.onTeammateTool(({ name, toolName, display }) => {
    console.log('[aria] team:teammate-tool:', name, toolName);
    const card = _teammateCards[name];
    if (!card) return;
    const row = document.createElement('div');
    row.className = 'team-tool-row';
    row.innerHTML = `<b>${escHtml(toolName || '')}</b> ${escHtml((display || '').replace(/^🔧\s*\S+\s*→?\s*/, ''))}`;
    card.outputEl.appendChild(row);
    // Auto-prune: keep last 20 tool rows to avoid unbounded growth
    const rows = card.outputEl.querySelectorAll('.team-tool-row');
    if (rows.length > 20) rows[0].remove();
    scrollToBottom();
  });
}

if (window.aria.onTeammateChunk) {
  window.aria.onTeammateChunk(({ name, text, done }) => {
    const card = _teammateCards[name];
    if (!card) return;
    if (done) {
      card.statusEl.textContent = 'done';
      card.statusEl.className = 'team-mate-status done';
      // check if all teammates are done → update header status
      // Update team header with progress
      if (_teamPanelEl) {
        const statusEl = _teamPanelEl.querySelector('.team-live-status');
        const cards = Object.values(_teammateCards);
        const doneCount = cards.filter(c => c.statusEl.textContent === 'done').length;
        const failedCount = cards.filter(c => c.statusEl.textContent === 'failed').length;
        const total = cards.length;
        const allDone = (doneCount + failedCount) === total;
        if (statusEl) {
          statusEl.textContent = allDone
            ? (failedCount > 0 ? `⚠️ ${doneCount}/${total} done, ${failedCount} failed` : '✅ complete')
            : `${doneCount}/${total} done`;
        }
      }
      return;
    }
    // Streaming text — show live preview (last 200 chars)
    let textRow = card.outputEl.querySelector('.team-text-live');
    if (!textRow) {
      textRow = document.createElement('div');
      textRow.className = 'team-text-live';
      card.outputEl.appendChild(textRow);
    }
    const current = textRow.textContent || '';
    const combined = current + text;
    textRow.textContent = combined.length > 200 ? '…' + combined.slice(-200) : combined;
    scrollToBottom();
  });
}

if (window.aria.onTeammateDone) {
  window.aria.onTeammateDone(({ name, status, summary }) => {
    const card = _teammateCards[name];
    if (!card) return;
    card.statusEl.textContent = status;
    card.statusEl.className = `team-mate-status ${status}`;
    card.cardEl.classList.remove('active');
    // Freeze the live text row
    const textLive = card.outputEl.querySelector('.team-text-live');
    if (textLive) textLive.classList.remove('team-text-live');
  });
}

if (window.aria.onTeamMailboxMessage) {
  window.aria.onTeamMailboxMessage(({ from, to, text }) => {
    console.log('[aria] team:mailbox-message:', from, '→', to, text?.slice(0, 60));
    if (!_teamPanelEl) return;
    const log = _teamPanelEl.querySelector('.team-mailbox-log');
    if (!log) return;
    const row = document.createElement('div');
    row.className = 'team-mailbox-row';
    row.innerHTML = `📬 <b>${escHtml(from)}</b> → <b>${escHtml(to)}</b>: ${escHtml((text || '').slice(0, 120))}`;
    log.appendChild(row);
    scrollToBottom();
  });
}

// ─── Phase 9.096d: Teammate pulse display ───
if (window.aria && window.aria.onTeammatePulse) {
  window.aria.onTeammatePulse(({ name, text }) => {
    const card = _teammateCards[name];
    if (!card || !card.pulseEl) return;
    card.pulseEl.textContent = '🫀 ' + (text || '').slice(0, 120);
    card.pulseEl.style.display = 'block';
    scrollToBottom();
  });
}

// ─── Phase 9.096d: Teammate reasoning chips ───
if (window.aria && window.aria.onTeammateReasoning) {
  window.aria.onTeammateReasoning(({ name, text }) => {
    const card = _teammateCards[name];
    if (!card || !card.reasoningEl) return;
    // Keep only latest ~100 chars of reasoning (rolling)
    const snippet = (text || '').length > 100 ? '…' + text.slice(-100) : text;
    card.reasoningEl.textContent = snippet;
    card.reasoningEl.style.display = 'block';
    scrollToBottom();
  });
}

// ─── Phase 9.096d: Teammate interrupt feedback ───
if (window.aria && window.aria.onTeammateInterrupt) {
  window.aria.onTeammateInterrupt(({ name }) => {
    const card = _teammateCards[name];
    if (!card) return;
    card.cardEl.classList.add('interrupt-flash');
    setTimeout(() => card.cardEl.classList.remove('interrupt-flash'), 1200);
    // Hide pulse/reasoning since state is being reset
    if (card.pulseEl) { card.pulseEl.style.display = 'none'; card.pulseEl.textContent = ''; }
    if (card.reasoningEl) { card.reasoningEl.style.display = 'none'; card.reasoningEl.textContent = ''; }
  });
}

// ═══════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════

async function init() {
  // Focus input on load
  ariaInput.focus();

  // Apply dark mode from main process config
  try {
    const darkMode = await window.aria.getTheme();
    document.body.classList.toggle('dark-mode', !!darkMode);
  } catch (e) {
    // ignore — theme API may not be available
  }

  // Listen for theme changes from main process
  if (window.aria.onThemeChanged) {
    window.aria.onThemeChanged((darkMode) => {
      document.body.classList.toggle('dark-mode', !!darkMode);
    });
  }

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
      // Phase 9.09: detect and show active project
      _detectCurrentProject();
      await loadMessagesForConversation(activeId);
    } else if (conversations.length > 0) {
      // Switch to most recent
      currentConversationId = conversations[0].id;
      setActiveConvInSidebar(currentConversationId);
      _detectCurrentProject();
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

// ═══════════════════════════════════════════
//  DOWNLOAD CARD (Phase 9.07 Track 5)
// ═══════════════════════════════════════════

function formatFileSize(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function _buildDownloadCard(data) {
  const { path: filePath, name, size, formats, description } = data || {};
  if (!filePath || !formats || formats.length === 0) return null;

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
  sizeEl.textContent = (description ? description + '  ·  ' : '') + formatFileSize(size);

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
        const result = await window.aria.downloadFile(filePath, fmt, name);
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
  return card;
}

function renderDownloadCard(data) {
  const card = _buildDownloadCard(data);
  if (!card) return;

  // Wrap in a message bubble like other assistant messages
  const wrapper = document.createElement('div');
  wrapper.className = 'aria-msg assistant';
  const bubble = document.createElement('div');
  bubble.className = 'aria-bubble';
  bubble.appendChild(card);
  wrapper.appendChild(bubble);
  ariaMessages.appendChild(wrapper);
  scrollToBottom();
}

// Listen for download card events from the agent
if (window.aria && window.aria.onPresentDownload) {
  window.aria.onPresentDownload((data) => {
    hideWelcome();
    renderDownloadCard(data);
  });
}

// Wait for DOM + preload to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
