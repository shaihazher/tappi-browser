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

// Attachment state
let pendingAttachments = []; // { id, file, name, size, mimeType, dataUrl?, error? }
let attachIdCounter = 0;
let dragCounter = 0;

/** Allowed file types with max sizes in bytes */
const ALLOWED_FILE_TYPES = {
  'image/jpeg':        { exts: ['.jpg', '.jpeg'], maxSize: 20 * 1024 * 1024, category: 'image' },
  'image/png':         { exts: ['.png'],          maxSize: 20 * 1024 * 1024, category: 'image' },
  'image/gif':         { exts: ['.gif'],          maxSize: 20 * 1024 * 1024, category: 'image' },
  'image/webp':        { exts: ['.webp'],         maxSize: 20 * 1024 * 1024, category: 'image' },
  'application/pdf':   { exts: ['.pdf'],          maxSize: 32 * 1024 * 1024, category: 'document' },
  'text/plain':        { exts: ['.txt'],          maxSize: 10 * 1024 * 1024, category: 'text' },
  'text/markdown':     { exts: ['.md'],           maxSize: 10 * 1024 * 1024, category: 'text' },
  'text/csv':          { exts: ['.csv'],          maxSize: 10 * 1024 * 1024, category: 'text' },
  'text/html':         { exts: ['.html'],         maxSize: 10 * 1024 * 1024, category: 'text' },
  'application/json':  { exts: ['.json'],         maxSize: 10 * 1024 * 1024, category: 'text' },
};
const MAX_FILES = 5;
const MAX_TOTAL_SIZE = 50 * 1024 * 1024;

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
const ariaAttachBtn  = document.getElementById('aria-attach-btn');
const ariaFileInput  = document.getElementById('aria-file-input');
const ariaAttachPreview = document.getElementById('aria-attach-preview');
const ariaInputWrapper  = document.getElementById('aria-input-wrapper');
const ariaDropOverlay   = document.getElementById('aria-drop-overlay');
const ariaSendBtn    = document.getElementById('aria-send-btn');
const ariaStopBtn    = document.getElementById('aria-stop-btn');
const tokenFill      = document.getElementById('aria-token-fill');
const tokenLabel     = document.getElementById('aria-token-label');

// Phase 9.098: Enhance prompt elements
const ariaEnhanceBtn = document.getElementById('aria-enhance-btn');
const ariaEnhanceDropdown = document.getElementById('aria-enhance-dropdown');
const ariaEnhanceStatus = document.getElementById('aria-enhance-status');

// Phase 9.13: Model picker elements
const ariaModelBtn = document.getElementById('aria-model-btn');
const ariaThinkingBtn = document.getElementById('aria-thinking-btn');
const ariaModelDropdown = document.getElementById('aria-model-dropdown');
const ariaProviderSelect = document.getElementById('aria-provider-select');
const ariaModelSearch = document.getElementById('aria-model-search');
const ariaModelList = document.getElementById('aria-model-list');
const ariaCustomModelBtn = document.getElementById('aria-model-custom-btn');
const ariaCustomModelModal = document.getElementById('aria-custom-model-modal');
const ariaCustomModelInput = document.getElementById('aria-custom-model-input');
const ariaCustomModelSave = document.getElementById('aria-custom-model-save');

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

// Phase 9.098: Enhance prompt state
let originalPromptText = null;
let isEnhancing = false;
let enhanceMode = 'quick';
let enhanceDropdownOpen = false;

// Phase 10: Scriptify state
let scriptsData = [];
let selectedScriptId = null;
let scriptInputMode = 'single';
let scriptBulkRows = [];
let isScriptifying = false;
let _scriptifyModal = null;

// Phase 9.13: Model picker state
let currentModelConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  thinking: true,
  secondaryModel: '',
  secondaryProvider: '',
  claudeCodeMode: 'full',
  claudeCodeAuth: 'oauth',
  claudeCodeBedrockRegion: '',
  claudeCodeBedrockProfile: '',
  claudeCodeBedrockModelId: '',
  claudeCodeBedrockSmallModelId: '',
  claudeCodeAwsAuthRefresh: '',
  claudeCodeAgentTeams: false,
};
let availableModels = [];
let modelDropdownOpen = false;
let providerChangedInPicker = false;

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
    // Post-process: style tool-call blockquotes
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    tmp.querySelectorAll('blockquote').forEach(bq => {
      if (bq.innerHTML.includes('🔧')) {
        bq.classList.add('tool-block');
      }
    });
    return tmp.innerHTML;
  } catch (e) {
    const segments = text.split(/\n\n+/);
    const rendered = segments.map(seg => {
      try { return marked.parse(seg); } catch { return '<p>' + escHtml(seg) + '</p>'; }
    }).join('');
    const sanitized = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(rendered) : rendered;
    return sanitized || '<pre style="white-space:pre-wrap;margin:0;font-family:inherit;">' + escHtml(text) + '</pre>';
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
//  MODEL PICKER (Phase 9.13)
// ═══════════════════════════════════════════

async function loadModelConfig() {
  try {
    const config = await window.aria.getConfig();
    if (config && config.llm) {
      currentModelConfig.provider = config.llm.provider || 'anthropic';
      currentModelConfig.model = config.llm.model || 'claude-sonnet-4-6';
      currentModelConfig.thinking = config.llm.thinking !== false;
      currentModelConfig.secondaryModel = config.llm.secondaryModel || '';
      currentModelConfig.secondaryProvider = config.llm.secondaryProvider || '';
      currentModelConfig.claudeCodeMode = config.llm.claudeCodeMode || 'full';
      currentModelConfig.claudeCodeAuth = config.llm.claudeCodeAuth || 'oauth';
      currentModelConfig.claudeCodeBedrockRegion = config.llm.claudeCodeBedrockRegion || '';
      currentModelConfig.claudeCodeBedrockProfile = config.llm.claudeCodeBedrockProfile || '';
      currentModelConfig.claudeCodeBedrockModelId = config.llm.claudeCodeBedrockModelId || '';
      currentModelConfig.claudeCodeBedrockSmallModelId = config.llm.claudeCodeBedrockSmallModelId || '';
      currentModelConfig.claudeCodeAwsAuthRefresh = config.llm.claudeCodeAwsAuthRefresh || '';
      currentModelConfig.claudeCodeAgentTeams = !!config.llm.claudeCodeAgentTeams;
    }
    updateModelButton();
    updateThinkingButton();
    updateEnhanceButton();
  } catch (e) {
    console.error('[aria] Failed to load model config:', e);
  }
}

function updateModelButton() {
  if (!ariaModelBtn) return;
  const modelName = ariaModelBtn.querySelector('.model-name');
  const providerIcon = ariaModelBtn.querySelector('.model-provider-icon');

  if (modelName) {
    if (currentModelConfig.provider === 'claude-code') {
      const m = currentModelConfig.model === 'claude-code' ? 'claude-sonnet-4-6' : currentModelConfig.model;
      modelName.textContent = m;
    } else {
      modelName.textContent = currentModelConfig.model;
    }
  }
  if (providerIcon) providerIcon.dataset.provider = currentModelConfig.provider;
}

function updateThinkingButton() {
  if (!ariaThinkingBtn) return;
  const isCC = currentModelConfig.provider === 'claude-code';
  ariaThinkingBtn.classList.toggle('on', !isCC && currentModelConfig.thinking);
  ariaThinkingBtn.classList.toggle('cc-disabled', isCC);
  ariaThinkingBtn.title = isCC
    ? 'Thinking is managed internally by Claude Code'
    : `Thinking: ${currentModelConfig.thinking ? 'ON' : 'OFF'}`;
}

function updateEnhanceButton() {
  if (!ariaEnhanceBtn) return;
  const isCC = currentModelConfig.provider === 'claude-code';
  ariaEnhanceBtn.disabled = isCC;
  ariaEnhanceBtn.title = isCC
    ? 'Prompt enhancement is not available with Claude Code'
    : 'Enhance prompt with AI';
  ariaEnhanceBtn.classList.toggle('cc-disabled', isCC);
}

async function fetchModelsForProvider(provider) {
  console.log('[aria] Fetching models for provider:', provider);
  try {
    const result = await window.aria.listModels(provider);
    console.log('[aria] listModels result:', result);
    if (result.success && result.models && result.models.length > 0) {
      availableModels = result.models;
      renderModelList();
    } else {
      console.log('[aria] No models, showing custom input');
      availableModels = [];
      // Show custom input when no models available
      showCustomModelInput(result.error || 'Enter model ID manually');
      return;
    }
  } catch (e) {
    console.error('[aria] Failed to fetch models:', e);
    availableModels = [];
    showCustomModelInput('Failed to fetch models. Enter model ID manually.');
    return;
  }
}

function renderModelList() {
  if (!ariaModelList) return;
  
  const searchTerm = (ariaModelSearch?.value || '').toLowerCase();
  const filtered = availableModels.filter(m => 
    (m.name || '').toLowerCase().includes(searchTerm) || 
    (m.id || '').toLowerCase().includes(searchTerm)
  );
  
  if (filtered.length === 0) {
    ariaModelList.innerHTML = `
      <div class="model-list-empty">
        <p>${availableModels.length === 0 ? 'No models available for this provider.' : 'No models match your search.'}</p>
        <button id="show-custom-model-btn">Enter model manually</button>
      </div>
    `;
    document.getElementById('show-custom-model-btn')?.addEventListener('click', () => {
      showCustomModelInput();
    });
    return;
  }
  
  ariaModelList.innerHTML = filtered.map(m => `
    <div class="model-item ${m.id === currentModelConfig.model ? 'selected' : ''}" 
         data-id="${escAttr(m.id)}">
      <span class="model-item-name">${escHtml(m.name || m.id)}</span>
      <span class="model-item-id">${escHtml(m.id)}</span>
      ${m.supportsThinking ? '<span class="model-item-thinking">🧠</span>' : ''}
    </div>
  `).join('');
  
  // Bind click handlers
  ariaModelList.querySelectorAll('.model-item').forEach(item => {
    item.addEventListener('click', () => selectModel(item.dataset.id));
  });
}

function escAttr(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function selectModel(modelId) {
  currentModelConfig.model = modelId;
  await saveModelConfig({ includeProvider: providerChangedInPicker });
  updateModelButton();
  closeModelDropdown();
}

async function saveModelConfig(options = {}) {
  const includeProvider = !!options.includeProvider;
  try {
    const llmUpdate = {
      model: currentModelConfig.model,
      thinking: currentModelConfig.thinking,
    };

    if (includeProvider) {
      llmUpdate.provider = currentModelConfig.provider;
    }

    // Always include Claude Code settings so they persist
    llmUpdate.claudeCodeMode = currentModelConfig.claudeCodeMode || 'full';
    llmUpdate.claudeCodeAuth = currentModelConfig.claudeCodeAuth || 'oauth';
    llmUpdate.claudeCodeBedrockRegion = currentModelConfig.claudeCodeBedrockRegion || '';
    llmUpdate.claudeCodeBedrockProfile = currentModelConfig.claudeCodeBedrockProfile || '';
    llmUpdate.claudeCodeBedrockModelId = currentModelConfig.claudeCodeBedrockModelId || '';
    llmUpdate.claudeCodeBedrockSmallModelId = currentModelConfig.claudeCodeBedrockSmallModelId || '';
    llmUpdate.claudeCodeAwsAuthRefresh = currentModelConfig.claudeCodeAwsAuthRefresh || '';
    llmUpdate.claudeCodeAgentTeams = !!currentModelConfig.claudeCodeAgentTeams;

    await window.aria.saveConfig({ llm: llmUpdate });
  } catch (e) {
    console.error('[aria] Failed to save model config:', e);
  }
}

function showCustomModelInput(hint) {
  console.log('[aria] Showing custom model input, hint:', hint);
  if (ariaCustomModelModal) {
    ariaCustomModelModal.classList.remove('hidden');
    console.log('[aria] Custom modal visible');
  }
  if (ariaModelList) {
    ariaModelList.innerHTML = `
      <div class="model-list-empty">
        <p>${escHtml(hint || 'Enter model ID manually.')}</p>
      </div>
    `;
  }
  if (ariaCustomModelInput) {
    ariaCustomModelInput.focus();
    ariaCustomModelInput.value = currentModelConfig.model;
  }
}

function hideCustomModelInput() {
  if (ariaCustomModelModal) {
    ariaCustomModelModal.classList.add('hidden');
  }
  if (ariaCustomModelInput) {
    ariaCustomModelInput.value = '';
  }
}

async function useCustomModel() {
  const modelId = (ariaCustomModelInput?.value || '').trim();
  if (!modelId) return;
  
  currentModelConfig.model = modelId;
  await saveModelConfig({ includeProvider: providerChangedInPicker });
  updateModelButton();
  hideCustomModelInput();
  closeModelDropdown();
}

async function openModelDropdown() {
  console.log('[aria] Opening model dropdown');
  await loadModelConfig(); // sync in case Settings changed provider/model in another tab
  providerChangedInPicker = false;
  modelDropdownOpen = true;
  if (ariaModelDropdown) {
    ariaModelDropdown.classList.remove('hidden');
  } else {
    console.error('[aria] ariaModelDropdown element not found!');
  }
  if (ariaProviderSelect) ariaProviderSelect.value = currentModelConfig.provider;

  const isCC = currentModelConfig.provider === 'claude-code';

  // Sync Claude Code dropdowns from saved config
  const ccModeSelect = document.getElementById('aria-cc-mode-select');
  if (ccModeSelect) ccModeSelect.value = currentModelConfig.claudeCodeMode || 'full';
  const ccAuthSelect = document.getElementById('aria-cc-auth-select');
  if (ccAuthSelect) ccAuthSelect.value = currentModelConfig.claudeCodeAuth || 'oauth';
  const bedrockRegionInput = document.getElementById('aria-cc-bedrock-region');
  if (bedrockRegionInput) bedrockRegionInput.value = currentModelConfig.claudeCodeBedrockRegion || '';
  const bedrockProfileInput = document.getElementById('aria-cc-bedrock-profile');
  if (bedrockProfileInput) bedrockProfileInput.value = currentModelConfig.claudeCodeBedrockProfile || '';
  const bedrockModelInput = document.getElementById('aria-cc-bedrock-model');
  if (bedrockModelInput) bedrockModelInput.value = currentModelConfig.claudeCodeBedrockModelId || '';
  const bedrockSmallModelInput = document.getElementById('aria-cc-bedrock-small-model');
  if (bedrockSmallModelInput) bedrockSmallModelInput.value = currentModelConfig.claudeCodeBedrockSmallModelId || '';
  const bedrockAuthRefreshInput = document.getElementById('aria-cc-bedrock-auth-refresh');
  if (bedrockAuthRefreshInput) bedrockAuthRefreshInput.value = currentModelConfig.claudeCodeAwsAuthRefresh || '';
  const agentTeamsCheckbox = document.getElementById('aria-cc-agent-teams');
  if (agentTeamsCheckbox) agentTeamsCheckbox.checked = !!currentModelConfig.claudeCodeAgentTeams;

  // Fetch and render models FIRST — before applying cc-active CSS constraints
  // so the model list DOM is populated before layout is constrained
  await fetchModelsForProvider(currentModelConfig.provider);
  console.log('[aria] Models rendered, availableModels:', availableModels.length);

  // THEN show/hide Claude Code settings and apply layout constraints
  const ccWrap = document.getElementById('aria-cc-mode-wrap');
  if (ccWrap) ccWrap.classList.toggle('hidden', !isCC);
  if (ariaModelDropdown) ariaModelDropdown.classList.toggle('cc-active', isCC);

  if (isCC) await updateClaudeCodeStatus();

  if (ariaModelSearch) ariaModelSearch.focus();
}

function closeModelDropdown() {
  modelDropdownOpen = false;
  providerChangedInPicker = false;
  if (ariaModelDropdown) {
    ariaModelDropdown.classList.add('hidden');
    ariaModelDropdown.classList.remove('cc-active');
  }
  hideCustomModelInput();
}

async function toggleModelDropdown() {
  if (modelDropdownOpen) closeModelDropdown();
  else await openModelDropdown();
}

/**
 * Update the Claude Code install + auth status UI.
 * Both paths auto-install to dedicated Tappi-managed directories:
 * - OAuth:   CLI at ~/.tappi-browser/claude-code-cli/
 * - API Key: SDK at ~/.tappi-browser/claude-code/
 * - Bedrock: CLI at ~/.tappi-browser/claude-code-cli/ (same binary, AWS credential chain)
 */
async function updateClaudeCodeStatus() {
  const authSelect = document.getElementById('aria-cc-auth-select');
  const installBtn = document.getElementById('aria-cc-install-btn');
  const loginBtn = document.getElementById('aria-cc-login-btn');
  const ccStatus = document.getElementById('aria-cc-status');
  const bedrockWrap = document.getElementById('aria-cc-bedrock-wrap');
  const authMethod = authSelect?.value || 'oauth';
  const label = 'Claude Code CLI';

  // Hide login button for non-OAuth auth (no OAuth needed for API key or Bedrock)
  if (loginBtn) loginBtn.classList.toggle('hidden', authMethod !== 'oauth');

  // Show/hide Bedrock settings panel
  if (bedrockWrap) bedrockWrap.classList.toggle('hidden', authMethod !== 'bedrock');

  if (!window.aria.checkClaudeCodeInstalled) return;

  try {
    const installed = await window.aria.checkClaudeCodeInstalled(authMethod);
    if (installBtn) installBtn.classList.toggle('hidden', installed);
    if (installBtn) installBtn.textContent = `Install ${label}`;

    if (!installed) {
      if (ccStatus) {
        ccStatus.textContent = `${label} will auto-install on first use`;
        ccStatus.classList.remove('hidden', 'error');
      }
      if (loginBtn) loginBtn.classList.add('hidden'); // Can't login until installed
      return;
    }

    // Fetch version info and show update button if available
    if (window.aria.getClaudeCodeVersion) {
      try {
        const ver = await window.aria.getClaudeCodeVersion();
        const versionEl = document.getElementById('aria-cc-version');
        const updateBtn = document.getElementById('aria-cc-update-btn');
        if (versionEl && ver.current) {
          versionEl.textContent = `v${ver.current}`;
          versionEl.classList.remove('hidden');
        }
        if (updateBtn) {
          updateBtn.classList.toggle('hidden', !ver.updateAvailable);
          if (ver.updateAvailable && ver.latest) {
            updateBtn.textContent = `Update to v${ver.latest}`;
          }
        }
      } catch {}
    }

    // Installed — check auth status based on method
    if (authMethod === 'oauth' && window.aria.checkClaudeAuth) {
      try {
        const auth = await window.aria.checkClaudeAuth('oauth');
        if (ccStatus) {
          if (auth.loggedIn) {
            ccStatus.textContent = auth.email
              ? `✓ Signed in as ${auth.email}`
              : '✓ Signed in';
            ccStatus.classList.remove('hidden', 'error');
            if (loginBtn) loginBtn.classList.add('hidden');
          } else {
            ccStatus.textContent = '✓ CLI installed — will sign in on first use';
            ccStatus.classList.remove('hidden', 'error');
            if (loginBtn) loginBtn.classList.remove('hidden');
          }
        }
      } catch {
        if (ccStatus) {
          ccStatus.textContent = `✓ ${label} installed`;
          ccStatus.classList.remove('hidden', 'error');
        }
      }
    } else if (authMethod === 'bedrock' && window.aria.checkBedrockCredentials) {
      try {
        const bedrockStatus = await window.aria.checkBedrockCredentials();
        const bedrockStatusEl = document.getElementById('aria-cc-bedrock-status');
        if (bedrockStatus.found) {
          if (ccStatus) {
            ccStatus.textContent = `✓ ${label} installed · AWS credentials via ${bedrockStatus.source}`;
            ccStatus.classList.remove('hidden', 'error');
          }
          if (bedrockStatusEl) {
            bedrockStatusEl.textContent = `✓ ${bedrockStatus.source}`;
            bedrockStatusEl.className = 'cc-bedrock-status success';
          }
        } else {
          if (ccStatus) {
            ccStatus.textContent = `✓ ${label} installed · No AWS credentials found`;
            ccStatus.classList.remove('hidden');
            ccStatus.classList.add('error');
          }
          if (bedrockStatusEl) {
            bedrockStatusEl.textContent = 'No AWS credentials found — set env vars, ~/.aws/credentials, or run aws sso login';
            bedrockStatusEl.className = 'cc-bedrock-status error';
          }
        }
      } catch {
        if (ccStatus) {
          ccStatus.textContent = `✓ ${label} installed`;
          ccStatus.classList.remove('hidden', 'error');
        }
      }
    } else {
      if (ccStatus) {
        ccStatus.textContent = `✓ ${label} installed`;
        ccStatus.classList.remove('hidden', 'error');
      }
    }
  } catch {}
}

function bindModelPickerEvents() {
  // Model button click
  ariaModelBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    await toggleModelDropdown();
  });
  
  // Thinking toggle (disabled for Claude Code — it handles thinking internally)
  ariaThinkingBtn?.addEventListener('click', async () => {
    if (currentModelConfig.provider === 'claude-code') return;
    currentModelConfig.thinking = !currentModelConfig.thinking;
    await saveModelConfig({ includeProvider: false });
    updateThinkingButton();
  });
  
  // Provider select change
  ariaProviderSelect?.addEventListener('change', () => {
    currentModelConfig.provider = ariaProviderSelect.value;
    providerChangedInPicker = true;
    updateEnhanceButton();
    updateThinkingButton();

    // Show/hide Claude Code mode selector and toggle cc-active class
    const isCC = ariaProviderSelect.value === 'claude-code';
    const ccWrap = document.getElementById('aria-cc-mode-wrap');
    if (ccWrap) ccWrap.classList.toggle('hidden', !isCC);
    if (ariaModelDropdown) ariaModelDropdown.classList.toggle('cc-active', isCC);

    if (isCC) {
      // Default to sonnet if current model isn't a Claude model
      if (!currentModelConfig.model || currentModelConfig.model === 'claude-code') {
        currentModelConfig.model = 'claude-sonnet-4-6';
      }
      fetchModelsForProvider('claude-code');
      updateClaudeCodeStatus();
    } else {
      fetchModelsForProvider(ariaProviderSelect.value);
    }
  });

  // Claude Code install button — installs the right component for the selected auth method
  document.getElementById('aria-cc-install-btn')?.addEventListener('click', async () => {
    const authSelect = document.getElementById('aria-cc-auth-select');
    const installBtn = document.getElementById('aria-cc-install-btn');
    const ccStatus = document.getElementById('aria-cc-status');
    const authMethod = authSelect?.value || 'oauth';
    const label = 'Claude Code CLI';

    if (installBtn) installBtn.disabled = true;
    if (ccStatus) {
      ccStatus.textContent = `Installing ${label}...`;
      ccStatus.classList.remove('hidden', 'error');
    }
    try {
      await window.aria.installClaudeCode(authMethod);
      if (installBtn) installBtn.classList.add('hidden');
      if (ccStatus) ccStatus.textContent = `✓ ${label} installed successfully!`;
      // Refresh full status (will check auth for OAuth)
      updateClaudeCodeStatus();
    } catch (err) {
      if (ccStatus) {
        ccStatus.textContent = 'Install failed: ' + (err.message || err);
        ccStatus.classList.add('error');
      }
    } finally {
      if (installBtn) installBtn.disabled = false;
    }
  });

  // Claude Code sign-in button — triggers OAuth login flow
  document.getElementById('aria-cc-login-btn')?.addEventListener('click', async () => {
    const loginBtn = document.getElementById('aria-cc-login-btn');
    const ccStatus = document.getElementById('aria-cc-status');

    if (loginBtn) loginBtn.disabled = true;
    if (ccStatus) {
      ccStatus.textContent = 'Opening sign-in...';
      ccStatus.classList.remove('hidden', 'error');
    }
    try {
      const result = await window.aria.loginClaudeCode();
      if (result.success) {
        if (ccStatus) ccStatus.textContent = '✓ Signed in successfully!';
        if (loginBtn) loginBtn.classList.add('hidden');
      } else {
        if (ccStatus) {
          ccStatus.textContent = 'Sign-in failed: ' + (result.error || 'Unknown error');
          ccStatus.classList.add('error');
        }
      }
    } catch (err) {
      if (ccStatus) {
        ccStatus.textContent = 'Sign-in failed: ' + (err.message || err);
        ccStatus.classList.add('error');
      }
    } finally {
      if (loginBtn) loginBtn.disabled = false;
    }
  });

  // Claude Code update button
  document.getElementById('aria-cc-update-btn')?.addEventListener('click', async () => {
    const updateBtn = document.getElementById('aria-cc-update-btn');
    const ccStatus = document.getElementById('aria-cc-status');
    if (updateBtn) updateBtn.disabled = true;
    if (ccStatus) { ccStatus.textContent = 'Updating Claude Code CLI...'; ccStatus.classList.remove('hidden', 'error'); }
    try {
      const result = await window.aria.updateClaudeCode();
      if (result.success) {
        if (updateBtn) updateBtn.classList.add('hidden');
        updateClaudeCodeStatus(); // Refresh to show new version
      } else {
        if (ccStatus) { ccStatus.textContent = 'Update failed: ' + result.error; ccStatus.classList.add('error'); }
      }
    } catch (err) {
      if (ccStatus) { ccStatus.textContent = 'Update failed: ' + (err.message || err); ccStatus.classList.add('error'); }
    } finally {
      if (updateBtn) updateBtn.disabled = false;
    }
  });

  // Claude Code mode select change
  document.getElementById('aria-cc-mode-select')?.addEventListener('change', (e) => {
    const mode = e.target.value;
    currentModelConfig.claudeCodeMode = mode;
    saveModelConfig({ includeProvider: true });
    // Reset plan state and session when switching modes — prevents stale plan
    // buttons from appearing when changing from plan to full permission mode
    if (window.aria.resetCCPlan) window.aria.resetCCPlan();
    _removePlanActionBar();
  });

  // Claude Code auth select change — also refresh install status
  document.getElementById('aria-cc-auth-select')?.addEventListener('change', (e) => {
    const auth = e.target.value;
    currentModelConfig.claudeCodeAuth = auth;
    saveModelConfig({ includeProvider: true });
    updateClaudeCodeStatus();
  });

  // Bedrock region input change
  document.getElementById('aria-cc-bedrock-region')?.addEventListener('change', (e) => {
    currentModelConfig.claudeCodeBedrockRegion = e.target.value.trim();
    saveModelConfig({ includeProvider: true });
  });

  // Bedrock profile input change
  document.getElementById('aria-cc-bedrock-profile')?.addEventListener('change', (e) => {
    currentModelConfig.claudeCodeBedrockProfile = e.target.value.trim();
    saveModelConfig({ includeProvider: true });
  });

  // Bedrock model ID input change
  document.getElementById('aria-cc-bedrock-model')?.addEventListener('change', (e) => {
    currentModelConfig.claudeCodeBedrockModelId = e.target.value.trim();
    saveModelConfig({ includeProvider: true });
  });

  // Bedrock small/fast model ID input change
  document.getElementById('aria-cc-bedrock-small-model')?.addEventListener('change', (e) => {
    currentModelConfig.claudeCodeBedrockSmallModelId = e.target.value.trim();
    saveModelConfig({ includeProvider: true });
  });

  // Bedrock credential refresh command input change
  document.getElementById('aria-cc-bedrock-auth-refresh')?.addEventListener('change', (e) => {
    currentModelConfig.claudeCodeAwsAuthRefresh = e.target.value.trim();
    saveModelConfig({ includeProvider: true });
  });

  // Agent teams toggle
  document.getElementById('aria-cc-agent-teams')?.addEventListener('change', (e) => {
    currentModelConfig.claudeCodeAgentTeams = e.target.checked;
    saveModelConfig({ includeProvider: true });
  });

  // Model search
  ariaModelSearch?.addEventListener('input', renderModelList);
  
  // Custom model button
  ariaCustomModelBtn?.addEventListener('click', showCustomModelInput);
  
  // Custom model save
  ariaCustomModelSave?.addEventListener('click', useCustomModel);
  
  // Custom model input enter
  ariaCustomModelInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') useCustomModel();
    if (e.key === 'Escape') hideCustomModelInput();
  });
  
  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    if (modelDropdownOpen && 
        ariaModelDropdown && 
        !ariaModelDropdown.contains(e.target) && 
        ariaModelBtn && 
        !ariaModelBtn.contains(e.target)) {
      closeModelDropdown();
    }
  });
  
  // Close dropdown on escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modelDropdownOpen) {
      closeModelDropdown();
    }
  });
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

// ─── Scriptify instructions modal ─────────────────────────────────────────────

function showScriptifyModal() {
  return new Promise((resolve) => {
    if (_scriptifyModal) { _scriptifyModal.remove(); _scriptifyModal = null; }

    const overlay = document.createElement('div');
    overlay.className = 'scriptify-modal-overlay';

    const card = document.createElement('div');
    card.className = 'scriptify-modal-card';

    const title = document.createElement('div');
    title.className = 'scriptify-modal-title';
    title.textContent = 'Create Script';

    const subtitle = document.createElement('div');
    subtitle.className = 'scriptify-modal-subtitle';
    subtitle.textContent = 'Optionally guide the script generation:';

    const textarea = document.createElement('textarea');
    textarea.className = 'scriptify-modal-textarea';
    textarea.placeholder = 'e.g. "Focus only on the scraping part" or "Use Selenium instead of Playwright"';
    textarea.rows = 3;

    const actions = document.createElement('div');
    actions.className = 'scriptify-modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'scriptify-modal-btn-cancel';
    cancelBtn.textContent = 'Cancel';

    const createBtn = document.createElement('button');
    createBtn.className = 'scriptify-modal-btn-create';
    createBtn.textContent = 'Create Script';

    actions.appendChild(cancelBtn);
    actions.appendChild(createBtn);
    card.appendChild(title);
    card.appendChild(subtitle);
    card.appendChild(textarea);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    _scriptifyModal = overlay;

    textarea.focus();

    const closeModal = (result) => {
      if (_scriptifyModal) { _scriptifyModal.remove(); _scriptifyModal = null; }
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') { closeModal(null); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { closeModal(textarea.value); }
    };
    document.addEventListener('keydown', onKey);

    cancelBtn.addEventListener('click', () => closeModal(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(null); });
    createBtn.addEventListener('click', () => closeModal(textarea.value));
  });
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
    updateScriptifyBtnState();
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
    <div class="conv-ctx-item" data-action="export-pdf">📄 Export as PDF</div>
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
    if (action === 'export-pdf') await exportConversationPdf(conv);
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

async function exportConversationPdf(conv) {
  const statusEl = appendMessage('system', '📄 Exporting conversation as PDF...');
  try {
    const result = await window.aria.exportConversationPdf(conv.id);
    if (result.success) {
      statusEl.querySelector('.bubble').textContent = `✅ PDF saved to ${result.path}`;
    } else {
      statusEl.querySelector('.bubble').textContent = `❌ Export failed: ${result.error}`;
    }
  } catch (e) {
    statusEl.querySelector('.bubble').textContent = `❌ Export failed: ${e.message || e}`;
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
    // Raw HTML — sanitize for safety
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
  } else if (role === 'cc-tool-card') {
    // Persisted Claude Code tool card — render collapsed with full data
    try {
      const data = JSON.parse(msg.content || '{}');
      wrapper.className = 'aria-msg assistant cc-tool-card-wrapper';
      const card = _buildToolCard(data.toolId || '', data.toolName || 'Tool', {
        state: data.isError ? 'error' : 'done',
        summary: _getToolSummary(data.toolName, data.input),
        collapsed: true,
      });
      if (data.input) _renderToolInput(card, data.toolName, data.input);
      if (data.result) _renderToolResult(card, data.toolName, data.result, data.isError);
      bubble.innerHTML = '';
      bubble.appendChild(card);
    } catch {
      bubble.textContent = msg.content || '';
    }
  } else if (role === 'tool') {
    // Render tool results with markdown for multi-line outputs (team_status etc.)
    const content = msg.content || '';
    // Check for download card HTML marker
    if (content.includes('class="tappi-download-card"')) {
      // Parse the download card and attach click handlers
      const parser = new DOMParser();
      const doc = parser.parseFromString(content, 'text/html');
      const dlCard = doc.querySelector('.tappi-download-card');
      if (dlCard) {
        const cardEl = document.createElement('div');
        cardEl.className = 'file-download-card';
        // Copy content
        cardEl.innerHTML = dlCard.innerHTML;
        // Add click handlers for download buttons
        cardEl.querySelectorAll('.dl-fmt').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            e.preventDefault();
            const fmt = btn.dataset.fmt;
            const path = dlCard.dataset.path;
            const name = dlCard.dataset.name;
            btn.disabled = true;
            btn.textContent = '⏳';
            try {
              const result = await window.aria.downloadFile(path, fmt, name);
              if (result && result.success) {
                btn.textContent = '✓';
                btn.style.color = '#22c55e';
              } else {
                btn.textContent = '❌';
                btn.disabled = false;
              }
            } catch (err) {
              btn.textContent = '❌';
              btn.disabled = false;
            }
          });
        });
        bubble.appendChild(cardEl);
      }
    } else if (content.includes('\n') || content.includes('**')) {
      const mdDiv = document.createElement('div');
      mdDiv.className = 'md-content tool-content';
      mdDiv.innerHTML = renderMarkdown(content);
      bubble.appendChild(mdDiv);
    } else {
      bubble.textContent = content;
    }
  } else if (role === 'team-event') {
    try {
      const data = JSON.parse(msg.content || '{}');
      wrapper.className = 'aria-msg team-event';
      const card = document.createElement('div');
      card.className = 'team-event-card';
      if (data.type === 'teammate-start') {
        card.innerHTML = `<span class="te-icon">\u{1F464}</span> <b>${escHtml(data.name)}</b> (${escHtml(data.role || '')}) started: ${escHtml((data.task || '').slice(0, 120))}`;
      } else if (data.type === 'teammate-turn') {
        card.innerHTML = `<span class="te-icon">\u{1F504}</span> <b>${escHtml(data.name)}</b> turn ${data.turn}: ${(data.tools || []).length} tools` +
          (data.files && data.files.length ? `, files: ${data.files.map(f => escHtml(f)).join(', ')}` : '') +
          (data.response ? `<div class="te-response">${escHtml(data.response.slice(0, 200))}</div>` : '');
      } else if (data.type === 'teammate-done') {
        const icon = data.status === 'done' ? '\u2705' : data.status === 'failed' ? '\u274C' : '\u23F9';
        card.innerHTML = `<span class="te-icon">${icon}</span> <b>${escHtml(data.name)}</b> ${escHtml(data.status)}: ${escHtml((data.summary || '').slice(0, 200))}`;
      } else if (data.type === 'team-dissolved') {
        card.innerHTML = `<span class="te-icon">\u{1F3C1}</span> <b>Team dissolved</b> (${data.duration || '?'}min)` +
          `<div class="te-teammates">${(data.teammates || []).map(t => `${escHtml(t.name)}: ${escHtml(t.status)}`).join(' | ')}</div>`;
      } else {
        card.textContent = msg.content || '';
      }
      bubble.appendChild(card);
    } catch {
      bubble.textContent = msg.content || '';
    }
  } else {
    // user, system
    // Check for attachments (from current session or rehydrated from history)
    let displayText = msg.content || '';
    let attachments = msg.attachments || [];

    // Rehydrate from persisted JSON content
    if (!attachments.length && displayText) {
      const parsed = parseUserContent(displayText);
      if (parsed.attachments.length > 0) {
        displayText = parsed.text;
        attachments = parsed.attachments;
      }
    }

    // Render attachment indicators
    if (attachments.length > 0) {
      const attDiv = document.createElement('div');
      attDiv.className = 'msg-attachments';
      for (const att of attachments) {
        if (att.dataUrl && att.mimeType && att.mimeType.startsWith('image/')) {
          const img = document.createElement('img');
          img.className = 'msg-attach-thumb';
          img.src = att.dataUrl;
          img.alt = att.name || 'image';
          img.title = att.name || 'image';
          attDiv.appendChild(img);
        } else {
          const chip = document.createElement('span');
          chip.className = 'msg-attach-file';
          chip.textContent = `📎 ${att.name || 'file'}`;
          if (att.size) chip.textContent += ` (${formatFileSize(att.size)})`;
          attDiv.appendChild(chip);
        }
      }
      bubble.appendChild(attDiv);
    }

    if (displayText) {
      const textNode = document.createTextNode(displayText);
      bubble.appendChild(textNode);
    }
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
//  FILE ATTACHMENTS
// ═══════════════════════════════════════════

/** Guess MIME from file extension as fallback */
function guessMime(name) {
  const ext = (name || '').toLowerCase().split('.').pop();
  const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html', json: 'application/json' };
  return map[ext] || '';
}

/** Format file size for display */
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/** Validate a file against allowed types and sizes */
function validateFile(file) {
  const mime = file.type || guessMime(file.name);
  const typeInfo = ALLOWED_FILE_TYPES[mime];
  if (!typeInfo) return { valid: false, error: `Unsupported file type: ${file.name}` };
  if (file.size > typeInfo.maxSize) return { valid: false, error: `${file.name} exceeds ${formatFileSize(typeInfo.maxSize)} limit` };
  if (pendingAttachments.filter(a => !a.error).length >= MAX_FILES) return { valid: false, error: `Max ${MAX_FILES} files per message` };
  const totalSize = pendingAttachments.reduce((sum, a) => sum + (a.error ? 0 : a.size), 0) + file.size;
  if (totalSize > MAX_TOTAL_SIZE) return { valid: false, error: 'Total attachment size exceeds 50 MB' };
  return { valid: true, mime };
}

/** Add a file to pendingAttachments and update preview */
function addAttachment(file) {
  const validation = validateFile(file);
  const id = ++attachIdCounter;
  const mime = validation.mime || file.type || guessMime(file.name);

  const att = { id, file, name: file.name, size: file.size, mimeType: mime, dataUrl: null, error: validation.valid ? null : validation.error };
  pendingAttachments.push(att);

  // Generate thumbnail for images
  if (validation.valid && mime.startsWith('image/')) {
    const reader = new FileReader();
    reader.onload = () => {
      att.dataUrl = reader.result;
      renderAttachPreview();
    };
    reader.readAsDataURL(file);
  } else {
    renderAttachPreview();
  }
}

/** Remove an attachment by id */
function removeAttachment(id) {
  pendingAttachments = pendingAttachments.filter(a => a.id !== id);
  renderAttachPreview();
}

/** Clear all attachments */
function clearAttachments() {
  pendingAttachments = [];
  renderAttachPreview();
}

/** Render the attachment preview strip */
function renderAttachPreview() {
  if (!ariaAttachPreview) return;
  if (pendingAttachments.length === 0) {
    ariaAttachPreview.classList.add('hidden');
    ariaAttachPreview.innerHTML = '';
    return;
  }
  ariaAttachPreview.classList.remove('hidden');
  ariaAttachPreview.innerHTML = '';

  const fileIcons = { 'application/pdf': '📄', 'text/plain': '📝', 'text/markdown': '📝', 'text/csv': '📊', 'text/html': '🌐', 'application/json': '📋' };

  for (const att of pendingAttachments) {
    const chip = document.createElement('div');
    chip.className = 'attach-chip' + (att.error ? ' error' : '');

    if (att.dataUrl) {
      const thumb = document.createElement('img');
      thumb.className = 'attach-chip-thumb';
      thumb.src = att.dataUrl;
      thumb.alt = att.name;
      chip.appendChild(thumb);
    } else {
      const icon = document.createElement('span');
      icon.className = 'attach-chip-icon';
      icon.textContent = att.error ? '⚠️' : (fileIcons[att.mimeType] || '📎');
      chip.appendChild(icon);
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'attach-chip-name';
    nameSpan.textContent = att.error || att.name;
    nameSpan.title = att.error || att.name;
    chip.appendChild(nameSpan);

    if (!att.error) {
      const sizeSpan = document.createElement('span');
      sizeSpan.className = 'attach-chip-size';
      sizeSpan.textContent = formatFileSize(att.size);
      chip.appendChild(sizeSpan);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'attach-chip-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => removeAttachment(att.id));
    chip.appendChild(removeBtn);

    ariaAttachPreview.appendChild(chip);
  }
}

/** Parse JSON user content for attachment metadata (history rehydration) */
function parseUserContent(content) {
  if (!content || typeof content !== 'string') return { text: content || '', attachments: [] };
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && ('text' in parsed || 'attachments' in parsed)) {
      return { text: parsed.text || '', attachments: parsed.attachments || [] };
    }
  } catch { /* not JSON */ }
  return { text: content, attachments: [] };
}

// ═══════════════════════════════════════════
//  SENDING MESSAGES
// ═══════════════════════════════════════════

async function sendMessage(text) {
  if (isStreaming) return;
  const trimmed = (text || '').trim();
  const validAttachments = pendingAttachments.filter(a => !a.error);
  if (!trimmed && validAttachments.length === 0) return;

  // Remove plan action bar if present (user is sending a new message)
  _removePlanActionBar();
  _planProvider = null;

  // Hide welcome screen if visible
  hideWelcome();

  // Capture attachment metadata for display before clearing
  const attachmentMeta = validAttachments.map(a => ({
    name: a.name, size: a.size, mimeType: a.mimeType, dataUrl: a.dataUrl || null,
  }));

  // Show user message immediately (with attachment metadata)
  appendMessage('user', trimmed, { attachments: attachmentMeta.length > 0 ? attachmentMeta : undefined });
  ariaInput.value = '';
  ariaInput.style.height = 'auto';

  // Phase 9.098: Clear enhanced state
  ariaInput.classList.remove('enhanced');
  originalPromptText = null;
  ariaEnhanceStatus?.classList.add('hidden');

  // Read attachment data as ArrayBuffer for IPC
  let attachmentData = null;
  if (validAttachments.length > 0) {
    try {
      attachmentData = await Promise.all(validAttachments.map(async (a) => ({
        name: a.name,
        mimeType: a.mimeType,
        size: a.size,
        data: await a.file.arrayBuffer(),
      })));
    } catch (e) {
      console.error('[aria] Failed to read attachment data:', e);
    }
  }

  // Clear attachments after capturing data
  clearAttachments();

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

  // Send to main process (with attachments if any)
  try {
    window.aria.sendMessage(trimmed, currentConversationId, codingModeActive, attachmentData);
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

// ─── Attachment event handlers ───────────────────────────

// Click attach button → open file dialog
if (ariaAttachBtn && ariaFileInput) {
  ariaAttachBtn.addEventListener('click', () => {
    ariaFileInput.value = '';
    ariaFileInput.click();
  });

  ariaFileInput.addEventListener('change', () => {
    if (ariaFileInput.files) {
      for (const file of ariaFileInput.files) {
        addAttachment(file);
      }
    }
  });
}

// Drag and drop on input wrapper
if (ariaInputWrapper && ariaDropOverlay) {
  ariaInputWrapper.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    ariaDropOverlay.classList.remove('hidden');
  });

  ariaInputWrapper.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  ariaInputWrapper.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      ariaDropOverlay.classList.add('hidden');
    }
  });

  ariaInputWrapper.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    ariaDropOverlay.classList.add('hidden');
    if (e.dataTransfer && e.dataTransfer.files) {
      for (const file of e.dataTransfer.files) {
        addAttachment(file);
      }
    }
  });
}

// Paste files from clipboard
ariaInput.addEventListener('paste', (e) => {
  if (e.clipboardData && e.clipboardData.items) {
    for (const item of e.clipboardData.items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          addAttachment(file);
        }
      }
    }
  }
});

// Cmd+U keyboard shortcut to open file dialog
ariaInput.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'u') {
    e.preventDefault();
    if (ariaFileInput) {
      ariaFileInput.value = '';
      ariaFileInput.click();
    }
  }
});

// ─── Enhance Prompt (Phase 9.098) ──────────────────────

function toggleEnhanceDropdown() {
  enhanceDropdownOpen = !enhanceDropdownOpen;
  if (ariaEnhanceDropdown) {
    ariaEnhanceDropdown.classList.toggle('hidden', !enhanceDropdownOpen);
  }
}

function closeEnhanceDropdown() {
  enhanceDropdownOpen = false;
  if (ariaEnhanceDropdown) {
    ariaEnhanceDropdown.classList.add('hidden');
  }
}

async function enhancePrompt(mode) {
  const text = ariaInput.value.trim();
  if (!text || isEnhancing) return;

  enhanceMode = mode;
  closeEnhanceDropdown();

  // Update selected state in UI
  document.querySelectorAll('.enhance-option').forEach(opt => {
    opt.classList.toggle('selected', opt.dataset.mode === mode);
  });

  isEnhancing = true;
  ariaEnhanceBtn.classList.add('loading');
  ariaEnhanceBtn.disabled = true;
  ariaEnhanceStatus.textContent = mode === 'deep' ? 'Analyzing deeply...' : 'Enhancing...';
  ariaEnhanceStatus.classList.remove('hidden', 'error');

  originalPromptText = text;

  try {
    const result = await window.aria.enhancePrompt(text, false, mode, currentConversationId);

    if (result.error) {
      throw new Error(result.error);
    }

    if (result.enhanced) {
      ariaInput.value = result.enhanced;
      ariaInput.classList.add('enhanced');
      ariaInput.style.height = 'auto';
      ariaInput.style.height = Math.min(ariaInput.scrollHeight, 140) + 'px';
      const modeLabel = mode === 'deep' ? '🔮 Deep analysis complete!' : '✨ Enhanced!';
      ariaEnhanceStatus.textContent = `${modeLabel} Review and send, or edit further.`;
    }
  } catch (err) {
    console.error('[aria] enhance error:', err);
    ariaEnhanceStatus.textContent = '❌ ' + (err.message || 'Enhancement failed');
    ariaEnhanceStatus.classList.add('error');
  } finally {
    isEnhancing = false;
    ariaEnhanceBtn.classList.remove('loading');
    // Re-enable unless Claude Code provider (which keeps it disabled)
    if (currentModelConfig.provider !== 'claude-code') {
      ariaEnhanceBtn.disabled = false;
    }
  }
}

// Enhance button click: toggle dropdown
if (ariaEnhanceBtn) {
  ariaEnhanceBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleEnhanceDropdown();
  });
}

// Handle dropdown option clicks (delegated)
if (ariaEnhanceDropdown) {
  ariaEnhanceDropdown.addEventListener('click', (e) => {
    const opt = e.target.closest('.enhance-option');
    if (opt && opt.dataset.mode) {
      e.stopPropagation();
      enhancePrompt(opt.dataset.mode);
    }
  });
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  const wrap = document.getElementById('aria-enhance-wrap');
  if (enhanceDropdownOpen && wrap && !wrap.contains(e.target)) {
    closeEnhanceDropdown();
  }
});

// Revert to original prompt on Escape when enhanced
ariaInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (enhanceDropdownOpen) {
      closeEnhanceDropdown();
    } else if (originalPromptText !== null) {
      ariaInput.value = originalPromptText;
      ariaInput.classList.remove('enhanced');
      originalPromptText = null;
      ariaEnhanceStatus.classList.add('hidden');
      ariaInput.style.height = 'auto';
      ariaInput.style.height = Math.min(ariaInput.scrollHeight, 140) + 'px';
    }
  }
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
  updateScriptifyBtnState();
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

// ─── Plan Action Bar (shared by CC and Vercel SDK plan modes) ─────────────────
let _planProvider = null; // 'cc' | 'agent'

/** Remove any existing plan action bar from the chat. */
function _removePlanActionBar() {
  const existing = document.getElementById('aria-cc-plan-actions');
  if (existing) existing.remove();
  const existingFeedback = document.getElementById('aria-cc-plan-feedback');
  if (existingFeedback) existingFeedback.remove();
}

/** Inject the plan action bar (Approve & Edit) below the last assistant message. */
function _showPlanActionBar() {
  _removePlanActionBar();

  const bar = document.createElement('div');
  bar.id = 'aria-cc-plan-actions';
  bar.className = 'cc-plan-actions';
  bar.innerHTML = `
    <button class="cc-plan-edit-btn" id="aria-cc-plan-edit">✏️ Edit Plan</button>
    <button class="cc-plan-approve-btn" id="aria-cc-plan-approve">✅ Approve & Execute</button>
  `;

  const messagesEl = document.getElementById('aria-messages');
  if (messagesEl) {
    messagesEl.appendChild(bar);
    scrollToBottom();
  }
}

/** Replace action bar with inline feedback textarea. */
function _showPlanFeedbackArea() {
  _removePlanActionBar();

  const area = document.createElement('div');
  area.id = 'aria-cc-plan-feedback';
  area.className = 'cc-plan-feedback';
  area.innerHTML = `
    <textarea id="aria-cc-plan-feedback-input" placeholder="Describe what to change..." rows="3"></textarea>
    <div class="cc-plan-feedback-btns">
      <button id="aria-cc-plan-feedback-cancel" class="cc-plan-feedback-cancel">Cancel</button>
      <button id="aria-cc-plan-feedback-send" class="cc-plan-feedback-send">Send Feedback</button>
    </div>
  `;

  const messagesEl = document.getElementById('aria-messages');
  if (messagesEl) {
    messagesEl.appendChild(area);
    // Focus the textarea
    setTimeout(() => {
      const ta = document.getElementById('aria-cc-plan-feedback-input');
      if (ta) ta.focus();
    }, 50);
    scrollToBottom();
  }
}

// Event delegation for plan action bar clicks
document.getElementById('aria-messages')?.addEventListener('click', (e) => {
  const target = e.target;

  // Approve & Execute
  if (target.id === 'aria-cc-plan-approve' || target.closest('#aria-cc-plan-approve')) {
    const btn = document.getElementById('aria-cc-plan-approve');
    if (btn) {
      btn.textContent = '⏳ Executing...';
      btn.disabled = true;
      btn.classList.add('executing');
    }
    // Disable edit button too
    const editBtn = document.getElementById('aria-cc-plan-edit');
    if (editBtn) editBtn.disabled = true;

    setStreamingState(true);
    if (_planProvider === 'agent') {
      window.aria.approveAgentPlan();
    } else {
      window.aria.approvePlan();
    }
    return;
  }

  // Edit Plan
  if (target.id === 'aria-cc-plan-edit' || target.closest('#aria-cc-plan-edit')) {
    _showPlanFeedbackArea();
    return;
  }

  // Cancel feedback
  if (target.id === 'aria-cc-plan-feedback-cancel' || target.closest('#aria-cc-plan-feedback-cancel')) {
    _showPlanActionBar();
    return;
  }

  // Send feedback
  if (target.id === 'aria-cc-plan-feedback-send' || target.closest('#aria-cc-plan-feedback-send')) {
    const ta = document.getElementById('aria-cc-plan-feedback-input');
    const feedback = ta ? ta.value.trim() : '';
    if (!feedback) return;

    _removePlanActionBar();
    // Show the user's feedback as a message bubble
    appendMessage('user', feedback);
    setStreamingState(true);
    if (_planProvider === 'agent') {
      window.aria.editAgentPlan(feedback);
    } else {
      window.aria.editPlan(feedback);
    }
    return;
  }
});

// Listen for plan-complete from main process (after initial send or after edit feedback)
window.aria?.onPlanComplete?.(() => {
  _planProvider = 'cc';
  _showPlanActionBar();
});

// Sync CC mode dropdown when conversational plan switching occurs
window.aria?.onCCModeSwitched?.((data) => {
  const sel = document.getElementById('aria-cc-mode-select');
  if (sel) sel.value = data.mode;
  currentModelConfig.claudeCodeMode = data.mode;
});

// Vercel SDK plan-complete listener
window.aria?.onAgentPlanComplete?.(() => {
  _planProvider = 'agent';
  _showPlanActionBar();
});

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

// ─── Sub-agent progress chip ──────────────────────────────────────────────────
const _ariaSubAgentChips = new Map(); // agentId → { el, lines }
if (window.aria.onSubAgentProgress) {
  window.aria.onSubAgentProgress((data) => {
    const chatMessages = document.getElementById('aria-messages');
    if (!chatMessages) return;

    const { agentId, taskType, step, tools, url, status, elapsed, done } = data;

    if (!_ariaSubAgentChips.has(agentId)) {
      const chip = document.createElement('div');
      chip.className = 'aria-subagent-chip';
      chip.innerHTML = `
        <div class="subagent-chip-header">
          <span class="subagent-chip-icon">⚡</span>
          <span class="subagent-chip-label">${agentId} [${taskType}]</span>
          <span class="subagent-chip-timer"></span>
        </div>
        <div class="subagent-chip-body"></div>`;
      chatMessages.appendChild(chip);
      _ariaSubAgentChips.set(agentId, { el: chip, lines: [] });
      chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });
    }

    const state = _ariaSubAgentChips.get(agentId);
    const chip = state.el;
    const timerEl = chip.querySelector('.subagent-chip-timer');
    const bodyEl = chip.querySelector('.subagent-chip-body');

    // Update timer
    const secs = Math.round(elapsed / 1000);
    if (timerEl) timerEl.textContent = `${secs}s`;

    // Build step line
    if (tools.length > 0 || url) {
      const toolStr = tools.join(', ') || '';
      const urlStr = url ? ` → ${url.length > 60 ? url.slice(0, 57) + '…' : url}` : '';
      const line = `Step ${step}: ${toolStr}${urlStr}`;
      state.lines.push(line);
      // Rolling: keep last 4 lines
      if (state.lines.length > 4) state.lines = state.lines.slice(-4);
      if (bodyEl) bodyEl.textContent = state.lines.join('\n');
    }

    chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });

    if (done) {
      const labelEl = chip.querySelector('.subagent-chip-label');
      const icon = chip.querySelector('.subagent-chip-icon');
      if (status === 'completed') {
        if (icon) icon.textContent = '✅';
        if (labelEl) labelEl.textContent = `${agentId} [${taskType}] — done in ${secs}s`;
      } else {
        if (icon) icon.textContent = '❌';
        if (labelEl) labelEl.textContent = `${agentId} [${taskType}] — failed (${secs}s)`;
        chip.classList.add('failed');
      }
      chip.classList.add('done');
      // Collapse body after a delay
      setTimeout(() => { chip.classList.add('collapsed'); }, 3000);
      _ariaSubAgentChips.delete(agentId);
    }
  });
}

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

// ─── Claude Code Tool Cards ───────────────

const _activeToolCards = new Map(); // toolId -> { cardEl, state, toolName, input }

const _ccToolIcons = {
  Bash: '>_', Read: '\u{1F4D6}', Write: '\u{270F}\u{FE0F}', Edit: '\u{1F4DD}',
  Grep: '\u{1F50D}', Glob: '\u{1F4C2}', WebFetch: '\u{1F310}', TodoWrite: '\u{2705}',
};

function _getToolIcon(name) {
  return _ccToolIcons[name] || '\u{1F527}';
}

function _getToolSummary(name, input) {
  if (!input) return '';
  switch (name) {
    case 'Bash': return (input.command || '').slice(0, 80);
    case 'Read': case 'Write': case 'Edit': return input.file_path || '';
    case 'Grep': return (input.pattern || '') + (input.path ? ' in ' + input.path : '');
    case 'Glob': return input.pattern || '';
    case 'WebFetch': return input.url || '';
    case 'TodoWrite': return 'Updating task list';
    default: {
      const keys = Object.keys(input).slice(0, 1);
      return keys.length ? `${keys[0]}: ${String(input[keys[0]] ?? '').slice(0, 80)}` : '';
    }
  }
}

function _buildToolCard(toolId, toolName, opts = {}) {
  const card = document.createElement('div');
  card.className = 'cc-tool-card';
  card.dataset.toolId = toolId;
  card.dataset.state = opts.state || 'running';

  const icon = _getToolIcon(toolName);
  const summary = opts.summary || '';

  card.innerHTML = `
    <div class="cc-tool-card-header">
      <span class="cc-tool-icon">${icon}</span>
      <span class="cc-tool-name">${toolName}</span>
      <span class="cc-tool-summary">${summary}</span>
      <span class="cc-tool-status">${opts.state === 'done' || opts.state === 'error' ? '' : '<span class="cc-tool-spinner"></span>'}</span>
      <span class="cc-tool-toggle">${opts.collapsed ? '\u{25B8}' : '\u{25BE}'}</span>
    </div>
    <div class="cc-tool-card-body${opts.collapsed ? '' : ' expanded'}">
      <div class="cc-tool-input"></div>
      <div class="cc-tool-result"></div>
    </div>`;

  return card;
}

function _renderToolInput(card, toolName, input) {
  const inputEl = card.querySelector('.cc-tool-input');
  if (!inputEl || !input) return;
  let html = '';
  switch (toolName) {
    case 'Bash':
      html = `<pre>${_escHtml((input.command || '').slice(0, 500))}</pre>`;
      break;
    case 'Read': case 'Write': case 'Edit':
      html = `<code>${_escHtml(input.file_path || '')}</code>`;
      break;
    case 'Grep':
      html = `<code>${_escHtml(input.pattern || '')}</code>${input.path ? ` in <code>${_escHtml(input.path)}</code>` : ''}`;
      break;
    case 'Glob':
      html = `<code>${_escHtml(input.pattern || '')}</code>`;
      break;
    case 'WebFetch':
      html = `<code>${_escHtml(input.url || '')}</code>`;
      break;
    default: {
      const keys = Object.keys(input).slice(0, 3);
      const pairs = keys.map(k => `<b>${_escHtml(k)}:</b> ${_escHtml(String(input[k] ?? '').slice(0, 200))}`);
      html = pairs.join('<br>');
    }
  }
  inputEl.innerHTML = html;
}

function _renderToolResult(card, toolName, content, isError) {
  const resultEl = card.querySelector('.cc-tool-result');
  if (!resultEl) return;
  const truncated = content.length > 2000;
  const display = truncated ? content.slice(0, 2000) : content;

  if (toolName === 'Bash') {
    resultEl.innerHTML = `<pre>${_escHtml(display)}</pre>`;
  } else if (['Read', 'Write', 'Edit'].includes(toolName)) {
    resultEl.innerHTML = `<pre>${_escHtml(display)}</pre>`;
  } else if (['Grep', 'Glob'].includes(toolName)) {
    const lines = display.split('\n');
    const count = lines.length;
    resultEl.innerHTML = `<div class="cc-tool-result-count">${count} result${count !== 1 ? 's' : ''}</div><pre>${_escHtml(display)}</pre>`;
  } else {
    resultEl.innerHTML = `<pre>${_escHtml(display)}</pre>`;
  }

  if (truncated) {
    const expandBtn = document.createElement('div');
    expandBtn.className = 'cc-tool-result-expand';
    expandBtn.textContent = 'Show more...';
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      resultEl.querySelector('pre').textContent = content;
      expandBtn.remove();
    });
    resultEl.appendChild(expandBtn);
  }
}

function _escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function _interruptStreamForToolCard() {
  // Same pattern as onToolResult: finalize active stream bubble so tool card inserts below
  if (_streamBubbleEl && streamBuffer.trim()) {
    _updateStreamBubble(streamBuffer, true);
    const cursor = _streamBubbleEl.querySelector('.streaming-cursor');
    if (cursor) cursor.remove();
    const wrapper = document.getElementById('aria-stream-bubble');
    if (wrapper) wrapper.removeAttribute('id');
    messages.push({ role: 'assistant', content: streamBuffer, timestamp: Date.now() });
    _streamTextSavedUpTo = streamBuffer.length;
    _streamBubbleEl = null;
    _streamMdDiv = null;
  }
}

if (window.aria.onCCToolStart) {
  window.aria.onCCToolStart(data => {
    if (!data || !data.toolId) return;
    _interruptStreamForToolCard();

    const card = _buildToolCard(data.toolId, data.toolName);
    const wrapper = document.createElement('div');
    wrapper.className = 'aria-msg assistant cc-tool-card-wrapper';
    wrapper.appendChild(card);
    ariaMessages.appendChild(wrapper);

    _activeToolCards.set(data.toolId, { cardEl: card, state: 'started', toolName: data.toolName, input: null });
    scrollToBottom();
  });
}

if (window.aria.onCCToolComplete) {
  window.aria.onCCToolComplete(data => {
    if (!data || !data.toolId) return;
    const entry = _activeToolCards.get(data.toolId);
    if (!entry) return;

    entry.input = data.input;
    entry.state = 'running';
    const card = entry.cardEl;

    // Update summary
    const summaryEl = card.querySelector('.cc-tool-summary');
    if (summaryEl) summaryEl.textContent = _getToolSummary(data.toolName, data.input);

    // Render input details
    _renderToolInput(card, data.toolName, data.input);
    scrollToBottom();
  });
}

if (window.aria.onCCToolResult) {
  window.aria.onCCToolResult(data => {
    if (!data) return;
    // Find card — try by toolId, fall back to last active
    let entry = data.toolId ? _activeToolCards.get(data.toolId) : null;
    if (!entry && _activeToolCards.size > 0) {
      const lastKey = [..._activeToolCards.keys()].pop();
      entry = _activeToolCards.get(lastKey);
      if (entry) data.toolId = lastKey;
    }
    if (!entry) return;

    const card = entry.cardEl;
    const isError = data.isError || false;

    // Render result
    _renderToolResult(card, entry.toolName, data.content || '', isError);

    // Update state
    card.dataset.state = isError ? 'error' : 'done';

    // Remove spinner, state pseudo-element handles checkmark/X
    const statusEl = card.querySelector('.cc-tool-status');
    if (statusEl) statusEl.innerHTML = '';

    // Auto-collapse
    const body = card.querySelector('.cc-tool-card-body');
    if (body) body.classList.remove('expanded');
    const toggle = card.querySelector('.cc-tool-toggle');
    if (toggle) toggle.textContent = '\u{25B8}';

    // Persist as cc-tool-card message
    const persistData = {
      toolId: data.toolId,
      toolName: entry.toolName,
      input: entry.input,
      result: data.content,
      isError: isError,
    };
    messages.push({ role: 'cc-tool-card', content: JSON.stringify(persistData), timestamp: Date.now() });

    _activeToolCards.delete(data.toolId);
    scrollToBottom();
  });
}

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
    updateScriptifyBtnState();
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

window.aria?.onDeepPlan(data => {
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

window.aria?.onDeepSubtaskStart(data => {
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

window.aria?.onDeepSubtaskDone(data => {
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
window.aria?.onDeepStreamChunk(data => {
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
if (window.aria?.onDeepReasoningChunk) {
  window.aria?.onDeepReasoningChunk(({ index, text, done }) => {
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
if (window.aria?.onDeepToolResult) {
  window.aria?.onDeepToolResult(data => {
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

window.aria?.onDeepComplete(data => {
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
    const result = await window.aria?.saveDeepReport(_deepOutputDir, fmt);
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
  // CC Tool card header toggle
  const toolCardHeader = e.target.closest('.cc-tool-card-header');
  if (toolCardHeader) {
    const card = toolCardHeader.closest('.cc-tool-card');
    if (card) {
      const body = card.querySelector('.cc-tool-card-body');
      if (body) body.classList.toggle('expanded');
      const toggle = card.querySelector('.cc-tool-toggle');
      if (toggle) toggle.textContent = body && body.classList.contains('expanded') ? '\u{25BE}' : '\u{25B8}';
    }
    return;
  }

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

  // Phase 9.13: Bind model picker events
  bindModelPickerEvents();
  
  // Phase 9.13: Load model config
  await loadModelConfig();

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
      updateScriptifyBtnState();
    } else if (conversations.length > 0) {
      // Switch to most recent
      currentConversationId = conversations[0].id;
      setActiveConvInSidebar(currentConversationId);
      _detectCurrentProject();
      await loadMessagesForConversation(currentConversationId);
      updateScriptifyBtnState();
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

  // Persist in the messages array so the card survives re-renders
  messages.push({ role: 'download', content: JSON.stringify(data), timestamp: Date.now() });

  scrollToBottom();
}

// Listen for download card events from the agent (with dedup — multiple IPC paths can fire)
let _lastDownloadCardPath = null;
let _lastDownloadCardTime = 0;
if (window.aria && window.aria.onPresentDownload) {
  window.aria.onPresentDownload((data) => {
    console.log('[aria.js] onPresentDownload callback triggered:', data);
    // Dedup: ignore duplicate events for the same file within 2 seconds
    const now = Date.now();
    if (data && data.path === _lastDownloadCardPath && now - _lastDownloadCardTime < 2000) {
      console.log('[aria.js] Skipping duplicate download card for:', data.path);
      return;
    }
    _lastDownloadCardPath = data?.path || null;
    _lastDownloadCardTime = now;
    hideWelcome();
    renderDownloadCard(data);
  });
} else {
  console.log('[aria.js] onPresentDownload not available on window.aria');
}

// ═══════════════════════════════════════════
//  SCRIPTIFY (Phase 10)
// ═══════════════════════════════════════════

const ariaScriptifyBtn = document.getElementById('aria-scriptify-btn');
const ariaScriptifyBtnIcon = ariaScriptifyBtn?.querySelector('.btn-icon');
const ariaScriptifyBtnLabel = ariaScriptifyBtn?.querySelector('.btn-label');
const ariaScriptsBtn = document.getElementById('aria-scripts-btn');
const scriptsModalOverlay = document.getElementById('scripts-modal-overlay');
const scriptsModalClose = document.getElementById('scripts-modal-close');
const scriptsSearch = document.getElementById('scripts-search');
const scriptsList = document.getElementById('scripts-list');
const scriptsDetailEmpty = document.getElementById('scripts-detail-empty');
const scriptsDetailContent = document.getElementById('scripts-detail-content');
const scriptsDetailName = document.getElementById('scripts-detail-name');
const scriptsDetailType = document.getElementById('scripts-detail-type');
const scriptsDetailDesc = document.getElementById('scripts-detail-desc');
const scriptsDeleteBtn = document.getElementById('scripts-delete-btn');
const scriptsModeSingle = document.getElementById('scripts-mode-single');
const scriptsModeBulk = document.getElementById('scripts-mode-bulk');
const scriptsSingleForm = document.getElementById('scripts-single-form');
const scriptsBulkForm = document.getElementById('scripts-bulk-form');
const scriptsBulkFile = document.getElementById('scripts-bulk-file');
const scriptsBulkStatus = document.getElementById('scripts-bulk-status');
const scriptsExecuteBtn = document.getElementById('scripts-execute-btn');
const scriptsAuthSection = document.getElementById('scripts-auth-section');
const scriptsAuthList = document.getElementById('scripts-auth-list');
const scriptsUpdateInstructions = document.getElementById('scripts-update-instructions');
const scriptsUpdateBtn = document.getElementById('scripts-update-btn');
const scriptsSpecialInstructions = document.getElementById('scripts-special-instructions');

/** Enable/disable Scriptify button based on current state */
function updateScriptifyBtnState() {
  if (!ariaScriptifyBtn) return;
  const canScriptify = currentConversationId && messages.length > 0 && !isStreaming && !isScriptifying;
  ariaScriptifyBtn.disabled = !canScriptify;
}

/** Render the scripts list in the modal sidebar */
function renderScriptsList(filter) {
  if (!scriptsList) return;
  const q = (filter || '').toLowerCase().trim();
  const filtered = q
    ? scriptsData.filter(s => s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q))
    : scriptsData;

  if (filtered.length === 0) {
    scriptsList.innerHTML = `<div class="scripts-detail-empty" style="padding:20px;text-align:center;font-size:12px;color:var(--text-dim);">${q ? 'No matching scripts' : 'No scripts yet'}</div>`;
    return;
  }

  scriptsList.innerHTML = filtered.map(s => {
    const active = s.id === selectedScriptId ? ' active' : '';
    const meta = s.runCount > 0 ? `${s.runCount} run${s.runCount > 1 ? 's' : ''}` : 'Never run';
    return `<div class="scripts-list-item${active}" data-id="${escAttr(s.id)}">
      <span class="scripts-item-name">${escHtml(s.name)}</span>
      <span class="scripts-item-meta">${escHtml(s.scriptType)} · ${escHtml(meta)}</span>
    </div>`;
  }).join('');

  // Click handlers for list items
  scriptsList.querySelectorAll('.scripts-list-item').forEach(item => {
    item.addEventListener('click', () => {
      const id = item.getAttribute('data-id');
      selectScript(id);
    });
  });
}

/** Select a script and show its details */
function selectScript(id) {
  selectedScriptId = id;
  const script = scriptsData.find(s => s.id === id);
  if (!script) return;

  // Update list active state
  scriptsList.querySelectorAll('.scripts-list-item').forEach(item => {
    item.classList.toggle('active', item.getAttribute('data-id') === id);
  });

  // Show detail panel
  if (scriptsDetailEmpty) scriptsDetailEmpty.classList.add('hidden');
  if (scriptsDetailContent) scriptsDetailContent.classList.remove('hidden');

  scriptsDetailName.textContent = script.name;
  scriptsDetailType.textContent = script.scriptType;
  scriptsDetailType.setAttribute('data-type', script.scriptType);
  scriptsDetailDesc.textContent = script.description || 'No description.';

  // Render auth requirements
  if (scriptsAuthSection && scriptsAuthList) {
    if (script.authRequirements && script.authRequirements.length > 0) {
      scriptsAuthSection.classList.remove('hidden');
      scriptsAuthList.innerHTML = script.authRequirements.map(req => {
        const typeLabel = req.authType === 'credentials' ? 'credentials' : req.authType === 'session' ? 'session' : 'either';
        return `<div class="scripts-auth-item">
          <span class="scripts-auth-icon">⏳</span>
          <span class="scripts-auth-domain">${escHtml(req.domain)}</span>
          <span class="scripts-auth-desc">${escHtml(req.description || '')}</span>
          <span class="scripts-auth-type">${escHtml(typeLabel)}</span>
        </div>`;
      }).join('');

      // Async check auth status
      const domains = script.authRequirements.map(r => r.domain);
      if (window.aria.checkAuthStatus) {
        window.aria.checkAuthStatus(domains).then(statuses => {
          if (!statuses) return;
          const items = scriptsAuthList.querySelectorAll('.scripts-auth-item');
          items.forEach((item, i) => {
            const iconEl = item.querySelector('.scripts-auth-icon');
            if (!iconEl || !statuses[i]) return;
            const req = script.authRequirements[i];
            if (statuses[i].hasCredentials) {
              iconEl.textContent = '✅';
            } else if (req.authType === 'session') {
              iconEl.textContent = '⚠️';
            } else {
              iconEl.textContent = '⚠️';
            }
          });
        }).catch(() => {});
      }
    } else {
      scriptsAuthSection.classList.add('hidden');
      scriptsAuthList.innerHTML = '';
    }
  }

  // Reset input mode
  scriptInputMode = 'single';
  scriptBulkRows = [];
  if (scriptsModeSingle) scriptsModeSingle.classList.add('active');
  if (scriptsModeBulk) scriptsModeBulk.classList.remove('active');
  if (scriptsSingleForm) scriptsSingleForm.classList.remove('hidden');
  if (scriptsBulkForm) scriptsBulkForm.classList.add('hidden');
  if (scriptsBulkStatus) scriptsBulkStatus.classList.add('hidden');

  // Generate input form
  generateInputForm(script.inputSchema ? script.inputSchema.fields : []);
}

/** Generate form fields from input schema */
function generateInputForm(fields) {
  if (!scriptsSingleForm) return;
  if (!fields || fields.length === 0) {
    scriptsSingleForm.innerHTML = '<p style="color:var(--text-dim);font-size:12px;">This script has no configurable inputs.</p>';
    return;
  }

  scriptsSingleForm.innerHTML = fields.map(field => {
    const reqMark = field.required ? ' <span style="color:var(--accent);">*</span>' : '';
    const desc = field.description ? `<small style="color:var(--text-dim);font-size:11px;">${escHtml(field.description)}</small>` : '';
    let input = '';

    switch (field.type) {
      case 'select':
        input = `<select id="script-field-${escAttr(field.name)}" class="script-field-input">
          ${(field.options || []).map(o => `<option value="${escAttr(o)}"${field.default === o ? ' selected' : ''}>${escHtml(o)}</option>`).join('')}
        </select>`;
        break;
      case 'boolean':
        input = `<label style="display:flex;align-items:center;gap:6px;font-size:13px;">
          <input type="checkbox" id="script-field-${escAttr(field.name)}" class="script-field-input"${field.default ? ' checked' : ''}>
          ${escHtml(field.name)}
        </label>`;
        break;
      case 'number':
        input = `<input type="number" id="script-field-${escAttr(field.name)}" class="script-field-input"
          placeholder="${escAttr(field.placeholder || '')}"${field.default !== undefined ? ` value="${escAttr(String(field.default))}"` : ''}>`;
        break;
      default:
        input = `<input type="text" id="script-field-${escAttr(field.name)}" class="script-field-input"
          placeholder="${escAttr(field.placeholder || '')}"${field.default !== undefined ? ` value="${escAttr(String(field.default))}"` : ''}>`;
    }

    return `<div class="scripts-field-group">
      <label>${escHtml(field.name)}${reqMark}</label>
      ${desc}
      ${input}
    </div>`;
  }).join('');
}

/** Gather inputs from the single form */
function gatherFormInputs() {
  const script = scriptsData.find(s => s.id === selectedScriptId);
  if (!script || !script.inputSchema || !script.inputSchema.fields) return {};
  const inputs = {};
  for (const field of script.inputSchema.fields) {
    const el = document.getElementById(`script-field-${field.name}`);
    if (!el) continue;
    if (field.type === 'boolean') {
      inputs[field.name] = el.checked;
    } else if (field.type === 'number') {
      inputs[field.name] = el.value ? Number(el.value) : undefined;
    } else {
      inputs[field.name] = el.value || undefined;
    }
  }
  return inputs;
}

// ─── Scriptify button handler ───
if (ariaScriptifyBtn) {
  ariaScriptifyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!currentConversationId || isStreaming || isScriptifying) return;

    const instructions = await showScriptifyModal();
    if (instructions === null) return;

    isScriptifying = true;
    ariaScriptifyBtn.disabled = true;
    if (ariaScriptifyBtnIcon) ariaScriptifyBtnIcon.textContent = '⏳';
    if (ariaScriptifyBtnLabel) ariaScriptifyBtnLabel.textContent = 'Generating...';

    try {
      const result = await window.aria.scriptifyConversation(currentConversationId, instructions || undefined);
      if (result && result.success) {
        // Show success notification in chat
        appendMessage('assistant', `📜 **Script created:** "${escHtml(result.script.name)}"\n\n${escHtml(result.script.description)}\n\nOpen the **Scripts** panel (📂) to view, configure, and run it.`);
      } else {
        appendMessage('assistant', `❌ Script generation failed: ${escHtml(result?.error || 'Unknown error')}`);
      }
    } catch (err) {
      console.error('[aria.js] scriptify error:', err);
      appendMessage('assistant', `❌ Script generation failed: ${escHtml(err.message || 'Unknown error')}`);
    } finally {
      isScriptifying = false;
      if (ariaScriptifyBtnIcon) ariaScriptifyBtnIcon.textContent = '📜';
      if (ariaScriptifyBtnLabel) ariaScriptifyBtnLabel.textContent = 'Scriptify';
      updateScriptifyBtnState();
    }
  });
}

// ─── Scripts button handler ───
if (ariaScriptsBtn) {
  ariaScriptsBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!scriptsModalOverlay) return;

    // Load scripts
    try {
      scriptsData = await window.aria.listScripts() || [];
    } catch (err) {
      console.error('[aria.js] listScripts error:', err);
      scriptsData = [];
    }

    // Reset state
    selectedScriptId = null;
    scriptInputMode = 'single';
    scriptBulkRows = [];
    if (scriptsSearch) scriptsSearch.value = '';
    if (scriptsDetailEmpty) scriptsDetailEmpty.classList.remove('hidden');
    if (scriptsDetailContent) scriptsDetailContent.classList.add('hidden');
    // Reset schedule section
    if (scriptsScheduleSection) scriptsScheduleSection.classList.add('hidden');
    if (scriptsScheduleForm) scriptsScheduleForm.classList.add('hidden');
    if (scriptsScheduleActive) scriptsScheduleActive.classList.add('hidden');
    if (scriptsScheduleChevron) scriptsScheduleChevron.classList.remove('open');

    renderScriptsList();
    scriptsModalOverlay.classList.remove('hidden');
  });
}

// ─── Modal close ───
if (scriptsModalClose) {
  scriptsModalClose.addEventListener('click', () => {
    if (scriptsModalOverlay) scriptsModalOverlay.classList.add('hidden');
  });
}
if (scriptsModalOverlay) {
  scriptsModalOverlay.addEventListener('click', (e) => {
    if (e.target === scriptsModalOverlay) {
      scriptsModalOverlay.classList.add('hidden');
    }
  });
}

// ─── Search scripts ───
if (scriptsSearch) {
  scriptsSearch.addEventListener('input', () => {
    renderScriptsList(scriptsSearch.value);
  });
}

// ─── Mode toggle ───
if (scriptsModeSingle) {
  scriptsModeSingle.addEventListener('click', () => {
    scriptInputMode = 'single';
    scriptsModeSingle.classList.add('active');
    if (scriptsModeBulk) scriptsModeBulk.classList.remove('active');
    if (scriptsSingleForm) scriptsSingleForm.classList.remove('hidden');
    if (scriptsBulkForm) scriptsBulkForm.classList.add('hidden');
    // Show schedule section in single mode
    if (scriptsScheduleSection && selectedScriptId) scriptsScheduleSection.classList.remove('hidden');
  });
}
if (scriptsModeBulk) {
  scriptsModeBulk.addEventListener('click', () => {
    scriptInputMode = 'bulk';
    scriptsModeBulk.classList.add('active');
    if (scriptsModeSingle) scriptsModeSingle.classList.remove('active');
    if (scriptsSingleForm) scriptsSingleForm.classList.add('hidden');
    if (scriptsBulkForm) scriptsBulkForm.classList.remove('hidden');
    // Hide schedule section in bulk mode (scheduling only supports single inputs)
    if (scriptsScheduleSection) scriptsScheduleSection.classList.add('hidden');
  });
}

// ─── Bulk file upload ───
if (scriptsBulkFile) {
  scriptsBulkFile.addEventListener('change', async () => {
    const file = scriptsBulkFile.files[0];
    if (!file || !selectedScriptId) return;

    if (scriptsBulkStatus) {
      scriptsBulkStatus.classList.remove('hidden');
      scriptsBulkStatus.textContent = 'Parsing file...';
    }

    try {
      const arrayBuf = await file.arrayBuffer();
      const result = await window.aria.parseBulkInput(selectedScriptId, arrayBuf, file.name);

      if (result && result.success) {
        scriptBulkRows = result.rows || [];
        let statusHtml = `✓ ${result.validCount} of ${result.totalRows} rows valid`;
        if (result.errors && result.errors.length > 0) {
          statusHtml += `<br><span style="color:var(--accent);">${result.errors.slice(0, 3).map(e => escHtml(e)).join('<br>')}</span>`;
          if (result.errors.length > 3) statusHtml += `<br>...and ${result.errors.length - 3} more errors`;
        }
        if (scriptsBulkStatus) scriptsBulkStatus.innerHTML = statusHtml;
      } else {
        scriptBulkRows = [];
        const errMsg = (result?.errors || ['Unknown error']).map(e => escHtml(e)).join('<br>');
        if (scriptsBulkStatus) scriptsBulkStatus.innerHTML = `<span style="color:var(--accent);">❌ ${errMsg}</span>`;
      }
    } catch (err) {
      console.error('[aria.js] bulk parse error:', err);
      scriptBulkRows = [];
      if (scriptsBulkStatus) scriptsBulkStatus.innerHTML = `<span style="color:var(--accent);">❌ ${escHtml(err.message || 'Parse failed')}</span>`;
    }
  });
}

// ─── Execute script ───
if (scriptsExecuteBtn) {
  scriptsExecuteBtn.addEventListener('click', () => {
    if (!selectedScriptId) return;

    let inputs;
    if (scriptInputMode === 'bulk') {
      if (scriptBulkRows.length === 0) return;
      inputs = scriptBulkRows;
    } else {
      inputs = gatherFormInputs();
    }

    // Close modal
    if (scriptsModalOverlay) scriptsModalOverlay.classList.add('hidden');

    // Hide welcome
    hideWelcome();

    // Show execution message in chat
    const script = scriptsData.find(s => s.id === selectedScriptId);
    const name = script ? script.name : 'Script';
    const rowInfo = Array.isArray(inputs) ? ` (${inputs.length} rows)` : '';
    appendMessage('user', `▶ Execute script: ${name}${rowInfo}`);

    // Gather special instructions
    const specialInstructions = scriptsSpecialInstructions ? scriptsSpecialInstructions.value.trim() : '';

    // Trigger execution via IPC (skipAuthCheck = false for normal flow)
    window.aria.executeScript(selectedScriptId, inputs, currentConversationId, false, specialInstructions || undefined);

    // Clear special instructions after execution
    if (scriptsSpecialInstructions) scriptsSpecialInstructions.value = '';
  });
}

// ─── Delete script ───
if (scriptsDeleteBtn) {
  scriptsDeleteBtn.addEventListener('click', async () => {
    if (!selectedScriptId) return;
    const script = scriptsData.find(s => s.id === selectedScriptId);
    if (!script) return;

    // Simple confirmation
    if (!confirm(`Delete script "${script.name}"?`)) return;

    try {
      await window.aria.deleteScript(selectedScriptId);
      scriptsData = scriptsData.filter(s => s.id !== selectedScriptId);
      selectedScriptId = null;
      if (scriptsDetailEmpty) scriptsDetailEmpty.classList.remove('hidden');
      if (scriptsDetailContent) scriptsDetailContent.classList.add('hidden');
      renderScriptsList(scriptsSearch ? scriptsSearch.value : '');
    } catch (err) {
      console.error('[aria.js] delete script error:', err);
    }
  });
}

// ─── Update script ───
if (scriptsUpdateBtn) {
  scriptsUpdateBtn.addEventListener('click', async () => {
    if (!selectedScriptId) return;
    const instructions = scriptsUpdateInstructions ? scriptsUpdateInstructions.value.trim() : '';
    if (!instructions) return;

    // Set loading state
    scriptsUpdateBtn.disabled = true;
    scriptsUpdateBtn.textContent = 'Updating…';

    try {
      const result = await window.aria.updateScript(selectedScriptId, instructions);
      if (result && result.success) {
        // Clear textarea
        if (scriptsUpdateInstructions) scriptsUpdateInstructions.value = '';
        // Refresh script list and re-select
        const updated = await window.aria.listScripts();
        if (updated) {
          scriptsData = updated;
          renderScriptsList(scriptsSearch ? scriptsSearch.value : '');
          selectScript(selectedScriptId);
        }
      } else {
        const errMsg = (result && result.error) || 'Update failed';
        if (scriptsUpdateInstructions) {
          scriptsUpdateInstructions.style.borderColor = 'var(--accent)';
          setTimeout(() => { scriptsUpdateInstructions.style.borderColor = ''; }, 3000);
        }
        console.error('[aria.js] script update error:', errMsg);
      }
    } catch (err) {
      console.error('[aria.js] script update error:', err);
    }

    // Restore button state
    scriptsUpdateBtn.disabled = false;
    scriptsUpdateBtn.textContent = 'Update Script';
  });
}

// ─── Handle script execution routing ───
// When main process sends the execution prompt back, route it through sendMessage
if (window.aria && window.aria.onScriptExecuteReady) {
  window.aria.onScriptExecuteReady((data) => {
    if (data && data.message) {
      // Send the execution prompt as a user message through the normal pipeline
      window.aria.sendMessage(data.message, data.conversationId || currentConversationId);
    }
  });
}

// ─── Handle script execution errors ───
if (window.aria && window.aria.onScriptExecuteError) {
  window.aria.onScriptExecuteError((data) => {
    if (data && data.error) {
      appendMessage('system', `Script execution failed: ${escHtml(data.error)}`);
    }
  });
}

// ─── Handle auth-required for scripts ───
if (window.aria && window.aria.onScriptAuthRequired) {
  window.aria.onScriptAuthRequired((data) => {
    if (!data || !data.missing) return;
    const lines = data.missing.map(m => {
      const icon = m.hasStoredCredentials ? '✅' : '⚠️';
      return `${icon} **${escHtml(m.domain)}** — ${escHtml(m.description)} _(${escHtml(m.authType)})_`;
    });
    const msg = `🔐 **Authentication required before running this script:**\n\n${lines.join('\n')}\n\n` +
      `Please log in to the required sites first, or <a href="#" class="run-anyway-link" ` +
      `data-script-id="${escAttr(data.scriptId)}" ` +
      `data-inputs='${escAttr(JSON.stringify(data.inputs))}' ` +
      `data-conversation-id="${escAttr(data.conversationId || '')}">Run Anyway</a>.`;
    appendMessage('system', msg);

    // Attach click handler for "Run Anyway" links
    setTimeout(() => {
      document.querySelectorAll('.run-anyway-link').forEach(link => {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          const sid = link.getAttribute('data-script-id');
          let inp;
          try { inp = JSON.parse(link.getAttribute('data-inputs') || '{}'); } catch { inp = {}; }
          const cid = link.getAttribute('data-conversation-id') || currentConversationId;
          const si = scriptsSpecialInstructions ? scriptsSpecialInstructions.value.trim() : '';
          window.aria.executeScript(sid, inp, cid, true, si || undefined);
          link.textContent = 'Running...';
          link.style.pointerEvents = 'none';
          link.style.opacity = '0.5';
        });
      });
    }, 100);
  });
}

// ─── Script Scheduling ─────────────────────────────────────────────────

const scriptsScheduleSection = document.getElementById('scripts-schedule-section');
const scriptsScheduleHeader = document.getElementById('scripts-schedule-header');
const scriptsScheduleChevron = document.getElementById('scripts-schedule-chevron');
const scriptsScheduleActive = document.getElementById('scripts-schedule-active');
const scriptsScheduleActiveText = document.getElementById('scripts-schedule-active-text');
const scriptsScheduleCancelBtn = document.getElementById('scripts-schedule-cancel-btn');
const scriptsScheduleForm = document.getElementById('scripts-schedule-form');
const scriptsSchedTypeOnce = document.getElementById('scripts-sched-type-once');
const scriptsSchedTypeRecurring = document.getElementById('scripts-sched-type-recurring');
const scriptsSchedOnceFields = document.getElementById('scripts-sched-once-fields');
const scriptsSchedRecurringFields = document.getElementById('scripts-sched-recurring-fields');
const scriptsSchedDatetime = document.getElementById('scripts-sched-datetime');
const scriptsSchedKind = document.getElementById('scripts-sched-kind');
const scriptsSchedIntervalFields = document.getElementById('scripts-sched-interval-fields');
const scriptsSchedDailyFields = document.getElementById('scripts-sched-daily-fields');
const scriptsSchedCronFields = document.getElementById('scripts-sched-cron-fields');
const scriptsSchedIntervalMin = document.getElementById('scripts-sched-interval-min');
const scriptsSchedDailyTime = document.getElementById('scripts-sched-daily-time');
const scriptsSchedCronExpr = document.getElementById('scripts-sched-cron-expr');
const scriptsScheduleBtn = document.getElementById('scripts-schedule-btn');

let scriptScheduleType = 'once';
let scriptActiveSchedules = [];

// Toggle collapse
if (scriptsScheduleHeader) {
  scriptsScheduleHeader.addEventListener('click', () => {
    const isOpen = scriptsScheduleForm && !scriptsScheduleForm.classList.contains('hidden');
    if (scriptsScheduleForm) scriptsScheduleForm.classList.toggle('hidden', isOpen);
    if (scriptsScheduleChevron) scriptsScheduleChevron.classList.toggle('open', !isOpen);
  });
}

// Schedule type toggle (Once / Recurring)
if (scriptsSchedTypeOnce) {
  scriptsSchedTypeOnce.addEventListener('click', () => {
    scriptScheduleType = 'once';
    scriptsSchedTypeOnce.classList.add('active');
    if (scriptsSchedTypeRecurring) scriptsSchedTypeRecurring.classList.remove('active');
    if (scriptsSchedOnceFields) scriptsSchedOnceFields.classList.remove('hidden');
    if (scriptsSchedRecurringFields) scriptsSchedRecurringFields.classList.add('hidden');
  });
}
if (scriptsSchedTypeRecurring) {
  scriptsSchedTypeRecurring.addEventListener('click', () => {
    scriptScheduleType = 'recurring';
    scriptsSchedTypeRecurring.classList.add('active');
    if (scriptsSchedTypeOnce) scriptsSchedTypeOnce.classList.remove('active');
    if (scriptsSchedOnceFields) scriptsSchedOnceFields.classList.add('hidden');
    if (scriptsSchedRecurringFields) scriptsSchedRecurringFields.classList.remove('hidden');
  });
}

// Recurring kind change — show/hide sub-fields
if (scriptsSchedKind) {
  scriptsSchedKind.addEventListener('change', () => {
    const kind = scriptsSchedKind.value;
    if (scriptsSchedIntervalFields) scriptsSchedIntervalFields.classList.toggle('hidden', kind !== 'interval');
    if (scriptsSchedDailyFields) scriptsSchedDailyFields.classList.toggle('hidden', kind !== 'daily');
    if (scriptsSchedCronFields) scriptsSchedCronFields.classList.toggle('hidden', kind !== 'cron');
  });
}

/** Build schedule object from form state */
function buildScheduleFromForm() {
  if (scriptScheduleType === 'once') {
    const dt = scriptsSchedDatetime ? scriptsSchedDatetime.value : '';
    if (!dt) return null;
    return { kind: 'once', runAt: new Date(dt).toISOString() };
  }
  // Recurring
  const kind = scriptsSchedKind ? scriptsSchedKind.value : 'interval';
  switch (kind) {
    case 'interval': {
      const mins = parseInt(scriptsSchedIntervalMin ? scriptsSchedIntervalMin.value : '30', 10);
      if (!mins || mins < 1) return null;
      return { kind: 'interval', intervalMs: mins * 60000 };
    }
    case 'daily': {
      const time = scriptsSchedDailyTime ? scriptsSchedDailyTime.value : '09:00';
      return { kind: 'daily', timeOfDay: time };
    }
    case 'cron': {
      const expr = scriptsSchedCronExpr ? scriptsSchedCronExpr.value.trim() : '';
      if (!expr) return null;
      return { kind: 'cron', cronExpr: expr };
    }
    default:
      return null;
  }
}

/** Load and render active schedules for selected script */
async function loadScriptSchedules(scriptId) {
  scriptActiveSchedules = [];
  if (!scriptId || !window.aria.getScriptSchedules) {
    if (scriptsScheduleActive) scriptsScheduleActive.classList.add('hidden');
    return;
  }
  try {
    scriptActiveSchedules = await window.aria.getScriptSchedules(scriptId) || [];
  } catch { scriptActiveSchedules = []; }

  renderScheduleBadge();
}

function renderScheduleBadge() {
  const activeJob = scriptActiveSchedules.find(j => j.enabled);
  if (activeJob && scriptsScheduleActive && scriptsScheduleActiveText) {
    let desc = '';
    const s = activeJob.schedule;
    switch (s.kind) {
      case 'once': desc = s.runAt ? `Once at ${new Date(s.runAt).toLocaleString()}` : 'Once (no time)'; break;
      case 'interval': {
        const ms = s.intervalMs || 60000;
        desc = ms >= 3600000 ? `Every ${(ms / 3600000).toFixed(ms % 3600000 ? 1 : 0)}h` : `Every ${Math.round(ms / 60000)}min`;
        break;
      }
      case 'daily': desc = `Daily at ${s.timeOfDay || '09:00'}`; break;
      case 'cron': desc = `Cron: ${s.cronExpr || ''}`; break;
      default: desc = 'Scheduled';
    }
    if (activeJob.nextRun) desc += ` — next: ${new Date(activeJob.nextRun).toLocaleString()}`;
    scriptsScheduleActiveText.textContent = desc;
    scriptsScheduleActive.classList.remove('hidden');
    scriptsScheduleActive.setAttribute('data-job-id', activeJob.id);
  } else {
    if (scriptsScheduleActive) scriptsScheduleActive.classList.add('hidden');
  }
}

// Cancel schedule button
if (scriptsScheduleCancelBtn) {
  scriptsScheduleCancelBtn.addEventListener('click', async () => {
    const jobId = scriptsScheduleActive ? scriptsScheduleActive.getAttribute('data-job-id') : null;
    if (!jobId) return;
    scriptsScheduleCancelBtn.disabled = true;
    scriptsScheduleCancelBtn.textContent = 'Canceling…';
    try {
      await window.aria.cancelScriptSchedule(jobId);
      if (selectedScriptId) await loadScriptSchedules(selectedScriptId);
    } catch (err) {
      console.error('[aria.js] cancel schedule error:', err);
    }
    scriptsScheduleCancelBtn.disabled = false;
    scriptsScheduleCancelBtn.textContent = 'Cancel Schedule';
  });
}

// Schedule button
if (scriptsScheduleBtn) {
  scriptsScheduleBtn.addEventListener('click', async () => {
    if (!selectedScriptId) return;
    const schedule = buildScheduleFromForm();
    if (!schedule) return;

    const inputs = gatherFormInputs();

    scriptsScheduleBtn.disabled = true;
    scriptsScheduleBtn.textContent = 'Scheduling…';
    try {
      const result = await window.aria.scheduleScript({
        scriptId: selectedScriptId,
        inputs,
        schedule,
      });
      if (result && result.success) {
        // Collapse form, reload badge
        if (scriptsScheduleForm) scriptsScheduleForm.classList.add('hidden');
        if (scriptsScheduleChevron) scriptsScheduleChevron.classList.remove('open');
        await loadScriptSchedules(selectedScriptId);
      } else {
        console.error('[aria.js] schedule error:', result?.error);
        scriptsScheduleBtn.textContent = result?.error || 'Failed';
        setTimeout(() => { scriptsScheduleBtn.textContent = 'Schedule Script'; }, 2000);
        scriptsScheduleBtn.disabled = false;
        return;
      }
    } catch (err) {
      console.error('[aria.js] schedule error:', err);
    }
    scriptsScheduleBtn.disabled = false;
    scriptsScheduleBtn.textContent = 'Schedule Script';
  });
}

// Live updates — refresh badge when cron jobs change
if (window.aria && window.aria.onCronJobsUpdated) {
  window.aria.onCronJobsUpdated((jobs) => {
    if (!selectedScriptId) return;
    scriptActiveSchedules = (jobs || []).filter(j => j.scriptId === selectedScriptId);
    renderScheduleBadge();
  });
}

// Hook into selectScript — show schedule section and load schedules
const _origSelectScript = typeof selectScript === 'function' ? selectScript : null;
{
  // Patch selectScript to also handle schedule section
  const origBody = selectScript;
  // We can't easily override, so we'll use a MutationObserver-like approach.
  // Instead, add a post-hook by wrapping the function.
  const origFn = selectScript;
  window.__selectScriptOrig = origFn;
}
// We need to hook after selectScript runs. Use event delegation on script list clicks
// since selectScript is called in those handlers. Instead, let's patch it properly.
// The simplest approach: redefine selectScript.
{
  const _origSelect = selectScript;
  selectScript = function(id) {
    _origSelect(id);
    // Show/hide schedule section
    if (scriptsScheduleSection) {
      if (id && scriptInputMode !== 'bulk') {
        scriptsScheduleSection.classList.remove('hidden');
      } else {
        scriptsScheduleSection.classList.add('hidden');
      }
    }
    // Reset schedule form state
    if (scriptsScheduleForm) scriptsScheduleForm.classList.add('hidden');
    if (scriptsScheduleChevron) scriptsScheduleChevron.classList.remove('open');
    // Load schedules
    if (id) loadScriptSchedules(id);
  };
}

// Wait for DOM + preload to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
