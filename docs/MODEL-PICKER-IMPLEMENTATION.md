# Model Picker Implementation Plan — Tappi Browser

**Target:** Move model selection + thinking toggle from Settings UI to main Aria Chat tab.  
**Goal:** Allow users to pick models per-chat with a searchable dropdown, falling back to manual entry.

---

## 1. Current Architecture

### Settings UI (`src/ui/index.html` + `app.js`)
- Provider: `<select id="setting-provider">` with hardcoded options
- Model: `<input id="setting-model">` (plain text, no dropdown)
- Thinking: `<button class="toggle-btn" id="toggle-thinking">`
- Secondary model: Separate section with provider/model/apikey fields

### Backend (`src/main.ts`)
- Config stored in `~/.tappi-browser/<profile>/config.json`
- `currentConfig.llm` holds: `{ provider, model, thinking, secondaryModel, secondaryProvider, ... }`
- IPC handlers: `config:get`, `config:save`, `config:reveal-api-key`
- Agent calls use `LLMConfig` from `llm-client.ts`

### Aria Chat UI (`src/ui/aria.html` + `aria.js`)
- Uses `window.aria` from `aria-preload.ts`
- No model picker currently — just input + controls
- Has coding mode toggle (`#aria-coding-btn`)

### Model Format (`llm-client.ts`)
```typescript
// Provider-specific model formats:
anthropic: 'claude-sonnet-4-6'           // short name
openai: 'gpt-4o'                         // short name
openrouter: 'anthropic/claude-sonnet-4-6' // provider/model format
ollama: 'llama3.1'                       // short name
google: 'gemini-2.0-flash'               // short name
```

---

## 2. Implementation Plan

### Phase 1: Backend Model Listing API

#### 2.1 Create `src/model-list.ts`
New module for fetching available models per provider.

```typescript
// src/model-list.ts
export interface ModelInfo {
  id: string;           // The exact string to use in config.llm.model
  name: string;         // Display name
  provider: string;     // Provider identifier
  contextWindow?: number;
  supportsThinking?: boolean;
}

export interface ModelListResult {
  success: boolean;
  models: ModelInfo[];
  error?: string;
  fallback?: boolean;   // True if we couldn't fetch (manual entry required)
}

// Provider-specific fetchers
export async function listAnthropicModels(): Promise<ModelListResult>
export async function listOpenAIModels(apiKey: string): Promise<ModelListResult>
export async function listOpenRouterModels(apiKey: string): Promise<ModelListResult>
export async function listOllamaModels(baseUrl: string): Promise<ModelListResult>
export async function listGoogleModels(apiKey: string): Promise<ModelListResult>
export async function listBedrockModels(): Promise<ModelListResult>
export async function listVertexModels(): Promise<ModelListResult>
export async function listAzureModels(endpoint: string, apiKey: string): Promise<ModelListResult>
export async function listCodexModels(token: string): Promise<ModelListResult>

// Main entry point
export async function listModelsForProvider(
  provider: string, 
  config: { apiKey?: string; baseUrl?: string; endpoint?: string }
): Promise<ModelListResult>
```

#### 2.2 Provider-Specific Model Fetching

| Provider | Endpoint | Notes |
|----------|----------|-------|
| **Anthropic** | No API — use hardcoded list | Claude models are well-known |
| **OpenAI** | `GET /v1/models` | Filter to chat models |
| **OpenRouter** | `GET /api/v1/models` | Returns full list with metadata |
| **Ollama** | `GET /api/tags` | Local models |
| **Google** | `GET /v1beta/models?key=...` | Gemini models |
| **Bedrock** | Use AWS SDK `list_foundation_models` | Region-aware |
| **Vertex** | Use `googleapis` SDK | Project-aware |
| **Azure** | `GET /openai/deployments?api-version=...` | Deployment names |
| **Codex** | LiteLLM or hardcoded | New models appear frequently |

#### 2.3 Hardcoded Fallback Models

```typescript
// For providers without API listing
const FALLBACK_MODELS: Record<string, ModelInfo[]> = {
  anthropic: [
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', supportsThinking: true },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', supportsThinking: true },
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', supportsThinking: true },
    { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', supportsThinking: true },
    { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet (Legacy)' },
  ],
  'openai-codex': [
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', supportsThinking: true },
    { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', supportsThinking: true },
    { id: 'o3-codex', name: 'O3 Codex', supportsThinking: true },
  ],
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    { id: 'o1', name: 'O1', supportsThinking: true },
    { id: 'o3-mini', name: 'O3 Mini', supportsThinking: true },
  ],
};
```

#### 2.4 IPC Handler in `main.ts`

```typescript
// Add to main.ts IPC handlers
ipcMain.handle('models:list', async (_e, provider: string) => {
  const config = currentConfig.llm;
  const apiKey = decryptApiKey(config.apiKey);
  return await listModelsForProvider(provider, {
    apiKey,
    baseUrl: config.baseUrl,
    endpoint: config.endpoint,
  });
});
```

#### 2.5 Expose in `aria-preload.ts`

```typescript
// Add to aria-preload.ts
listModels: (provider: string) => 
  ipcRenderer.invoke('models:list', provider),
```

---

### Phase 2: Aria Chat UI — Model Picker Component

#### 2.1 HTML Structure (`aria.html`)

Insert into `#aria-controls`:

```html
<!-- Inside #aria-controls, before other buttons -->
<div id="aria-model-picker-wrap">
  <!-- Primary Model -->
  <div class="model-picker-group">
    <button id="aria-model-btn" class="model-picker-btn" title="Select model">
      <span class="model-provider-icon" data-provider="anthropic">🤖</span>
      <span class="model-name">claude-sonnet-4-6</span>
      <span class="dropdown-arrow">▼</span>
    </button>
  </div>
  
  <!-- Thinking Toggle -->
  <button id="aria-thinking-btn" class="thinking-toggle on" title="Thinking: ON (medium effort)">
    <span class="thinking-icon">🧠</span>
  </button>
  
  <!-- Secondary Model (collapsed by default) -->
  <div id="aria-secondary-model-wrap" class="hidden">
    <button id="aria-secondary-model-btn" class="model-picker-btn secondary">
      <span class="model-name">Same as primary</span>
      <span class="dropdown-arrow">▼</span>
    </button>
  </div>
</div>

<!-- Model Dropdown Modal (appears when clicking model button) -->
<div id="aria-model-dropdown" class="model-dropdown hidden">
  <div class="model-dropdown-header">
    <select id="aria-provider-select">
      <option value="anthropic">Anthropic</option>
      <option value="openai-codex">OpenAI Codex</option>
      <option value="openai">OpenAI</option>
      <option value="google">Google</option>
      <option value="openrouter">OpenRouter</option>
      <option value="ollama">Ollama (Local)</option>
      <option value="bedrock">AWS Bedrock</option>
      <option value="vertex">Vertex AI</option>
      <option value="azure">Azure OpenAI</option>
    </select>
    <input id="aria-model-search" type="text" placeholder="Search models...">
  </div>
  <div id="aria-model-list" class="model-list">
    <!-- Populated dynamically -->
  </div>
  <div class="model-dropdown-footer">
    <button id="aria-model-custom-btn">+ Custom Model</button>
  </div>
</div>

<!-- Custom Model Input Modal -->
<div id="aria-custom-model-modal" class="custom-model-modal hidden">
  <input id="aria-custom-model-input" type="text" placeholder="Enter full model ID...">
  <button id="aria-custom-model-save">Use Model</button>
</div>
```

#### 2.2 CSS Styles (`aria.css`)

```css
/* Model picker button */
.model-picker-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}

.model-picker-btn:hover {
  background: var(--bg-hover);
  border-color: var(--accent-color);
}

.model-name {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dropdown-arrow {
  font-size: 10px;
  opacity: 0.5;
}

/* Thinking toggle */
.thinking-toggle {
  padding: 4px 8px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  opacity: 0.5;
  transition: all 0.15s;
}

.thinking-toggle.on {
  opacity: 1;
  background: var(--accent-bg);
  border-color: var(--accent-color);
}

/* Model dropdown */
.model-dropdown {
  position: absolute;
  bottom: 100%;
  left: 0;
  width: 320px;
  max-height: 400px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 -4px 20px rgba(0,0,0,0.15);
  z-index: 1000;
  overflow: hidden;
}

.model-dropdown.hidden {
  display: none;
}

.model-dropdown-header {
  display: flex;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid var(--border-color);
}

.model-dropdown-header select {
  flex: 0 0 auto;
  padding: 6px 8px;
}

.model-dropdown-header input {
  flex: 1;
  padding: 6px 10px;
}

.model-list {
  max-height: 280px;
  overflow-y: auto;
}

.model-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  cursor: pointer;
  transition: background 0.1s;
}

.model-item:hover {
  background: var(--bg-hover);
}

.model-item.selected {
  background: var(--accent-bg);
}

.model-item-name {
  font-weight: 500;
}

.model-item-id {
  font-size: 11px;
  color: var(--text-secondary);
}

.model-item-thinking {
  margin-left: auto;
  font-size: 11px;
  color: var(--accent-color);
}

.model-dropdown-footer {
  padding: 10px 12px;
  border-top: 1px solid var(--border-color);
}

/* Custom model modal */
.custom-model-modal {
  position: absolute;
  bottom: 100%;
  left: 0;
  width: 280px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  gap: 8px;
}

.custom-model-modal.hidden {
  display: none;
}

/* Secondary model indicator */
#aria-secondary-model-wrap {
  margin-left: 4px;
}

.model-picker-btn.secondary .model-name {
  font-size: 11px;
  color: var(--text-secondary);
}
```

#### 2.3 JavaScript Logic (`aria.js`)

```javascript
// === Model Picker State ===
let currentModelConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  thinking: true,
  secondaryProvider: '',
  secondaryModel: '',
};
let availableModels = [];
let modelDropdownOpen = false;

// === DOM Elements ===
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
const ariaSecondaryModelWrap = document.getElementById('aria-secondary-model-wrap');
const ariaSecondaryModelBtn = document.getElementById('aria-secondary-model-btn');

// === Load Config on Init ===
async function loadModelConfig() {
  const config = await window.aria.getConfig?.() || {};
  if (config.llm) {
    currentModelConfig = {
      provider: config.llm.provider || 'anthropic',
      model: config.llm.model || 'claude-sonnet-4-6',
      thinking: config.llm.thinking !== false,
      secondaryProvider: config.llm.secondaryProvider || '',
      secondaryModel: config.llm.secondaryModel || '',
    };
  }
  updateModelButton();
  updateThinkingButton();
}

// === UI Updates ===
function updateModelButton() {
  const modelName = ariaModelBtn.querySelector('.model-name');
  const providerIcon = ariaModelBtn.querySelector('.model-provider-icon');
  
  modelName.textContent = currentModelConfig.model;
  providerIcon.dataset.provider = currentModelConfig.provider;
  
  // Update secondary model button if visible
  if (currentModelConfig.secondaryModel) {
    ariaSecondaryModelWrap.classList.remove('hidden');
    ariaSecondaryModelBtn.querySelector('.model-name').textContent = 
      currentModelConfig.secondaryModel;
  } else {
    ariaSecondaryModelWrap.classList.add('hidden');
  }
}

function updateThinkingButton() {
  ariaThinkingBtn.classList.toggle('on', currentModelConfig.thinking);
  ariaThinkingBtn.title = `Thinking: ${currentModelConfig.thinking ? 'ON' : 'OFF'}`;
}

// === Model List Fetching ===
async function fetchModelsForProvider(provider) {
  try {
    const result = await window.aria.listModels(provider);
    if (result.success && result.models.length > 0) {
      availableModels = result.models;
    } else {
      // Fallback: show custom input
      availableModels = [];
      showCustomModelInput();
    }
  } catch (e) {
    console.error('[aria] Failed to fetch models:', e);
    availableModels = [];
    showCustomModelInput();
  }
  renderModelList();
}

// === Render Model List ===
function renderModelList() {
  const searchTerm = ariaModelSearch.value.toLowerCase();
  const filtered = availableModels.filter(m => 
    m.name.toLowerCase().includes(searchTerm) || 
    m.id.toLowerCase().includes(searchTerm)
  );
  
  if (filtered.length === 0) {
    ariaModelList.innerHTML = `
      <div class="model-list-empty">
        <p>No models found</p>
        <button id="show-custom-model">Enter model manually</button>
      </div>
    `;
    return;
  }
  
  ariaModelList.innerHTML = filtered.map(m => `
    <div class="model-item ${m.id === currentModelConfig.model ? 'selected' : ''}" 
         data-id="${m.id}" 
         data-thinking="${m.supportsThinking || false}">
      <span class="model-item-name">${escapeHtml(m.name)}</span>
      <span class="model-item-id">${escapeHtml(m.id)}</span>
      ${m.supportsThinking ? '<span class="model-item-thinking">🧠</span>' : ''}
    </div>
  `).join('');
  
  // Bind click handlers
  ariaModelList.querySelectorAll('.model-item').forEach(item => {
    item.addEventListener('click', () => selectModel(item.dataset.id));
  });
}

// === Model Selection ===
async function selectModel(modelId) {
  currentModelConfig.model = modelId;
  await saveModelConfig();
  updateModelButton();
  closeModelDropdown();
}

// === Save Model Config ===
async function saveModelConfig() {
  await window.aria.saveConfig?.({
    llm: {
      provider: currentModelConfig.provider,
      model: currentModelConfig.model,
      thinking: currentModelConfig.thinking,
      secondaryProvider: currentModelConfig.secondaryProvider || undefined,
      secondaryModel: currentModelConfig.secondaryModel || undefined,
    }
  });
}

// === Custom Model Input ===
function showCustomModelInput() {
  ariaCustomModelModal.classList.remove('hidden');
  ariaCustomModelInput.focus();
}

function hideCustomModelInput() {
  ariaCustomModelModal.classList.add('hidden');
  ariaCustomModelInput.value = '';
}

async function useCustomModel() {
  const modelId = ariaCustomModelInput.value.trim();
  if (!modelId) return;
  
  currentModelConfig.model = modelId;
  await saveModelConfig();
  updateModelButton();
  hideCustomModelInput();
  closeModelDropdown();
}

// === Dropdown Control ===
function openModelDropdown() {
  modelDropdownOpen = true;
  ariaModelDropdown.classList.remove('hidden');
  ariaProviderSelect.value = currentModelConfig.provider;
  fetchModelsForProvider(currentModelConfig.provider);
  ariaModelSearch.focus();
}

function closeModelDropdown() {
  modelDropdownOpen = false;
  ariaModelDropdown.classList.add('hidden');
  ariaCustomModelModal.classList.add('hidden');
}

function toggleModelDropdown() {
  if (modelDropdownOpen) closeModelDropdown();
  else openModelDropdown();
}

// === Event Bindings ===
ariaModelBtn.addEventListener('click', toggleModelDropdown);
ariaThinkingBtn.addEventListener('click', async () => {
  currentModelConfig.thinking = !currentModelConfig.thinking;
  await saveModelConfig();
  updateThinkingButton();
});

ariaProviderSelect.addEventListener('change', () => {
  currentModelConfig.provider = ariaProviderSelect.value;
  fetchModelsForProvider(ariaProviderSelect.value);
});

ariaModelSearch.addEventListener('input', renderModelList);

ariaCustomModelBtn.addEventListener('click', showCustomModelInput);
ariaCustomModelSave.addEventListener('click', useCustomModel);
ariaCustomModelInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') useCustomModel();
  if (e.key === 'Escape') hideCustomModelInput();
});

// Close dropdown on outside click
document.addEventListener('click', (e) => {
  if (modelDropdownOpen && 
      !ariaModelDropdown.contains(e.target) && 
      !ariaModelBtn.contains(e.target)) {
    closeModelDropdown();
  }
});

// === Init ===
document.addEventListener('DOMContentLoaded', loadModelConfig);
```

---

### Phase 3: Backend Changes

#### 3.1 Per-Conversation Model Override

Currently, `aria:send` uses global config. Add per-conversation model support:

```typescript
// main.ts — Update aria:send handler
ipcMain.on('aria:send', async (_e, message: string, conversationId?: string, codingMode?: boolean, modelOverride?: Partial<LLMConfig>) => {
  const baseConfig = { ...currentConfig.llm };
  
  // Merge with override if provided
  const effectiveConfig = modelOverride 
    ? { ...baseConfig, ...modelOverride }
    : baseConfig;
    
  // ... rest of handler
});
```

#### 3.2 Config Schema Update

The `llm` section now serves as **defaults** for new conversations. Conversations can override:

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "thinking": true,
    "secondaryModel": "claude-sonnet-4-6",
    "secondaryProvider": ""
  }
}
```

---

### Phase 4: Settings UI Cleanup

#### 4.1 Remove Model Section from Settings

Remove from `index.html`:
- Provider dropdown
- Model input
- Thinking toggle
- Secondary model section

#### 4.2 Keep Provider Credentials

Settings should still manage:
- API keys per provider
- Cloud provider configs (baseUrl, endpoint, region, projectId, location)
- OAuth buttons

#### 4.3 New Settings Layout

```
Settings
├── General
│   ├── API Credentials (per-provider)
│   │   ├── Provider: [Anthropic ▼]
│   │   ├── API Key: [••••••••]
│   │   └── [Test Connection]
│   ├── Cloud Provider Settings (conditional)
│   │   ├── Base URL (Ollama/OpenRouter)
│   │   ├── Endpoint (Azure)
│   │   ├── Region (Bedrock)
│   │   └── Project/Location (Vertex)
│   └── Search Engine
├── Privacy
├── Tools
├── Cron Jobs
├── API Services
├── Profiles
└── My Profile
```

---

## 3. Implications Summary

### Settings UI
- **Removed**: Model selection, thinking toggle, secondary model section
- **Kept**: API key management, provider credentials, cloud provider settings
- **New focus**: Credentials and infrastructure, not runtime choices

### Backend
- **New IPC**: `models:list` — fetch available models for provider
- **Modified IPC**: `aria:send` — accepts optional model override
- **Config role**: Default values for new conversations

### Aria Chat UI
- **New components**: Model picker dropdown, thinking toggle, secondary model button
- **State management**: Per-session model config, saved to backend
- **Fallback**: Manual model entry when API unavailable

### Model Format Compatibility
- Models are stored as-is (exact provider format)
- `llm-client.ts` already handles format normalization
- OpenRouter models use `provider/model` format
- Other providers use short names

---

## 4. Implementation Order

1. **Backend first** — `src/model-list.ts` + IPC handler
2. **Preload update** — Expose `listModels` to renderer
3. **Aria UI** — Add model picker + thinking toggle
4. **Settings cleanup** — Remove model section
5. **Testing** — All providers, fallback behavior, persistence

---

## 5. Edge Cases

1. **Provider change mid-conversation** — Warn user? Auto-clear context?
2. **Model unavailable** — Show error, offer fallback
3. **API key missing** — Redirect to settings
4. **Ollama not running** — Show "Start Ollama" hint
5. **OpenRouter rate limit** — Cache models locally (1hr TTL)
6. **Custom model not in list** — Allow manual entry, show warning

---

## 6. Files Changed

| File | Change |
|------|--------|
| `src/model-list.ts` | **NEW** — Model listing per provider |
| `src/main.ts` | Add `models:list` IPC handler |
| `src/aria-preload.ts` | Expose `listModels` |
| `src/ui/aria.html` | Add model picker UI |
| `src/ui/aria.css` | Style model picker |
| `src/ui/aria.js` | Model picker logic |
| `src/ui/index.html` | Remove model section |
| `src/ui/app.js` | Remove model settings logic |
| `src/ui/styles.css` | Update settings layout |
