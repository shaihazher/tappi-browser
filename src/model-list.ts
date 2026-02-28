/**
 * model-list.ts — Fetch available models for each LLM provider.
 *
 * Used by Aria Chat UI to populate the model picker dropdown.
 * Falls back to manual entry when API unavailable or for providers without listing.
 */

export interface ModelInfo {
  id: string;           // Exact string to use in config.llm.model
  name: string;         // Display name
  contextWindow?: number;
  supportsThinking?: boolean;
}

export interface ModelListResult {
  success: boolean;
  models: ModelInfo[];
  error?: string;
  fallback?: boolean;   // True if we couldn't fetch (manual entry required)
}

/**
 * Anthropic: No public models API.
 * User must enter model ID manually.
 */
export async function listAnthropicModels(): Promise<ModelListResult> {
  return {
    success: false,
    models: [],
    fallback: true,
    error: 'Anthropic does not provide a models API. Enter model ID manually (e.g., claude-sonnet-4-6).',
  };
}

/**
 * OpenAI: Fetch models from /v1/models endpoint.
 * Filter to chat-capable models.
 */
export async function listOpenAIModels(apiKey: string): Promise<ModelListResult> {
  if (!apiKey) {
    return { success: false, models: [], fallback: true, error: 'API key required' };
  }

  try {
    const resp = await fetch('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({})) as any;
      return { success: false, models: [], fallback: true, error: err?.error?.message || `HTTP ${resp.status}` };
    }

    const data = await resp.json() as { data?: Array<{ id: string; owned_by?: string }> };
    const models: ModelInfo[] = (data.data || [])
      .filter(m => {
        // Filter to chat models
        const id = m.id.toLowerCase();
        return id.includes('gpt') || id.includes('o1') || id.includes('o3') || id.includes('chat');
      })
      .map(m => {
        const id = m.id;
        const isReasoning = /^o[13]/.test(id);
        return {
          id,
          name: id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          supportsThinking: isReasoning,
        };
      })
      .sort((a, b) => {
        // Sort: reasoning models first, then alphabetically
        if (a.supportsThinking && !b.supportsThinking) return -1;
        if (!a.supportsThinking && b.supportsThinking) return 1;
        return a.id.localeCompare(b.id);
      });

    return { success: true, models };
  } catch (e: any) {
    return { success: false, models: [], fallback: true, error: e.message || 'Connection failed' };
  }
}

/**
 * OpenAI Codex: model IDs are best entered manually for OAuth-based Codex backend.
 */
export async function listCodexModels(_token: string): Promise<ModelListResult> {
  // Codex models change frequently; user should enter manually
  // Common models: gpt-5.x-codex, o3-codex
  return {
    success: false,
    models: [],
    fallback: true,
    error: 'Codex models change frequently. Enter model ID manually (e.g., gpt-5.3-codex).',
  };
}

/**
 * OpenRouter: Fetch models from /api/v1/models.
 * Returns full list with provider prefixes.
 */
export async function listOpenRouterModels(apiKey: string, baseUrl?: string): Promise<ModelListResult> {
  if (!apiKey) {
    return { success: false, models: [], fallback: true, error: 'API key required' };
  }

  const url = baseUrl || 'https://openrouter.ai/api/v1';

  try {
    const resp = await fetch(`${url}/models`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://tappi.synthworx.com',
        'X-Title': 'Tappi Browser',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({})) as any;
      return { success: false, models: [], fallback: true, error: err?.error?.message || `HTTP ${resp.status}` };
    }

    const data = await resp.json() as { data?: Array<{
      id: string;
      name?: string;
      context_length?: number;
      pricing?: { prompt?: string; completion?: string };
    }> };

    const models: ModelInfo[] = (data.data || [])
      .map(m => {
        const id = m.id;
        // Detect thinking support based on provider/model
        const supportsThinking = id.includes('claude') || /^openai\/(o[13]|gpt-5)/.test(id) || id.includes('gemini-2.5') || id.includes('gemini-3');
        return {
          id,
          name: m.name || id.split('/').pop() || id,
          contextWindow: m.context_length,
          supportsThinking,
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    return { success: true, models };
  } catch (e: any) {
    return { success: false, models: [], fallback: true, error: e.message || 'Connection failed' };
  }
}

/**
 * Google Gemini: Fetch models from generativelanguage API.
 */
export async function listGoogleModels(apiKey: string): Promise<ModelListResult> {
  if (!apiKey) {
    return { success: false, models: [], fallback: true, error: 'API key required' };
  }

  try {
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({})) as any;
      return { success: false, models: [], fallback: true, error: err?.error?.message || `HTTP ${resp.status}` };
    }

    const data = await resp.json() as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };

    const models: ModelInfo[] = (data.models || [])
      .filter(m => {
        // Filter to models that support generateContent
        const methods = m.supportedGenerationMethods || [];
        return methods.includes('generateContent') || methods.includes('generateContentStream');
      })
      .map(m => {
        // Name format: models/gemini-2.0-flash -> gemini-2.0-flash
        const id = m.name.replace(/^models\//, '');
        const supportsThinking = /gemini-(2\.5|3)/.test(id);
        return {
          id,
          name: id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          supportsThinking,
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    return { success: true, models };
  } catch (e: any) {
    return { success: false, models: [], fallback: true, error: e.message || 'Connection failed' };
  }
}

/**
 * Ollama: Fetch local models from /api/tags.
 */
export async function listOllamaModels(baseUrl?: string): Promise<ModelListResult> {
  const url = baseUrl || 'http://localhost:11434';

  try {
    const resp = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) {
      return { success: false, models: [], fallback: true, error: `Ollama responded with ${resp.status}` };
    }

    const data = await resp.json() as { models?: Array<{ name: string; size?: number; modified_at?: string }> };

    const models: ModelInfo[] = (data.models || [])
      .map(m => ({
        id: m.name,
        name: m.name,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    if (models.length === 0) {
      return { success: true, models: [], fallback: true, error: 'No models installed. Run `ollama pull <model>` to install one.' };
    }

    return { success: true, models };
  } catch (e: any) {
    if (e.name === 'TimeoutError' || e.code === 'ECONNREFUSED' || e.cause?.code === 'ECONNREFUSED') {
      return {
        success: false,
        models: [],
        fallback: true,
        error: `Ollama not running at ${url}. Start it with \`ollama serve\`.`,
      };
    }
    return { success: false, models: [], fallback: true, error: e.message || 'Connection failed' };
  }
}

/**
 * AWS Bedrock: Use boto3 to list foundation models.
 * Requires AWS credentials in environment.
 */
export async function listBedrockModels(region?: string): Promise<ModelListResult> {
  // Bedrock requires AWS SDK; for now, user enters manually
  // Common models: anthropic.claude-3-sonnet-20240229-v1:0
  return {
    success: false,
    models: [],
    fallback: true,
    error: 'Bedrock requires AWS SDK. Enter model ID manually (e.g., anthropic.claude-sonnet-4-6-v2:0).',
  };
}

/**
 * Google Vertex AI: Use googleapis to list models.
 * Requires Google ADC.
 */
export async function listVertexModels(_projectId?: string, _location?: string): Promise<ModelListResult> {
  // Vertex requires googleapis SDK; for now, user enters manually
  return {
    success: false,
    models: [],
    fallback: true,
    error: 'Vertex AI requires googleapis. Enter model ID manually (e.g., gemini-2.0-flash).',
  };
}

/**
 * Azure OpenAI: Fetch deployments from the Azure endpoint.
 */
export async function listAzureModels(endpoint: string, apiKey: string): Promise<ModelListResult> {
  if (!endpoint || !apiKey) {
    return { success: false, models: [], fallback: true, error: 'Endpoint and API key required' };
  }

  try {
    const cleanEndpoint = endpoint.replace(/\/$/, '');
    const resp = await fetch(`${cleanEndpoint}/openai/deployments?api-version=2024-06-01`, {
      headers: { 'api-key': apiKey },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      return { success: false, models: [], fallback: true, error: `Azure responded with ${resp.status}` };
    }

    const data = await resp.json() as { data?: Array<{ id: string; model?: string }> };

    const models: ModelInfo[] = (data.data || [])
      .map(m => ({
        id: m.id, // Deployment name is the model ID for Azure
        name: m.id,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    if (models.length === 0) {
      return { success: true, models: [], fallback: true, error: 'No deployments found. Create a deployment in Azure Portal.' };
    }

    return { success: true, models };
  } catch (e: any) {
    return { success: false, models: [], fallback: true, error: e.message || 'Connection failed' };
  }
}

/**
 * Main entry point: list models for a given provider.
 */
export async function listModelsForProvider(
  provider: string,
  config: {
    apiKey?: string;
    baseUrl?: string;
    endpoint?: string;
    region?: string;
    projectId?: string;
    location?: string;
  } = {},
): Promise<ModelListResult> {
  switch (provider) {
    case 'anthropic':
      return listAnthropicModels();

    case 'openai':
      return listOpenAIModels(config.apiKey || '');

    case 'openai-codex':
      return listCodexModels(config.apiKey || '');

    case 'openrouter':
      return listOpenRouterModels(config.apiKey || '', config.baseUrl);

    case 'google':
      return listGoogleModels(config.apiKey || '');

    case 'ollama':
      return listOllamaModels(config.baseUrl);

    case 'bedrock':
      return listBedrockModels(config.region);

    case 'vertex':
      return listVertexModels(config.projectId, config.location);

    case 'azure':
      return listAzureModels(config.endpoint || '', config.apiKey || '');

    case 'claude-code':
      return {
        success: true,
        models: [
          { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', supportsThinking: true },
          { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', supportsThinking: true },
          { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', supportsThinking: true },
          { id: 'claude-sonnet-4-5-20250514', name: 'Claude Sonnet 4.5', supportsThinking: true },
        ],
        fallback: false,
      };

    default:
      return {
        success: false,
        models: [],
        fallback: true,
        error: `Unknown provider: ${provider}`,
      };
  }
}
