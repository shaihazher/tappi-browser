/**
 * llm-client.ts — Multi-provider LLM client using Vercel AI SDK.
 *
 * Supports 8 providers:
 * - Anthropic (API key or OAuth token)
 * - OpenAI (API key)
 * - Google Gemini (API key)
 * - OpenRouter (API key → OpenAI-compatible)
 * - Ollama (local, no auth)
 * - AWS Bedrock (IAM credential chain)
 * - Vertex AI (Google ADC)
 * - Azure OpenAI (endpoint + API key)
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAzure } from '@ai-sdk/azure';
import { createVertex } from '@ai-sdk/google-vertex';
import type { LanguageModel } from 'ai';

export interface LLMConfig {
  provider: string;
  model: string;
  apiKey: string; // decrypted — may be empty for Bedrock/Vertex/Ollama
  thinking?: boolean;      // true = medium thinking, false = no thinking
  deepMode?: boolean;      // true = decompose complex tasks (default), false = always direct
  // Cloud provider fields
  region?: string;         // Bedrock: AWS region
  projectId?: string;      // Vertex: GCP project ID
  location?: string;       // Vertex: GCP location (e.g. us-central1)
  endpoint?: string;       // Azure: resource endpoint URL
  baseUrl?: string;        // Ollama/OpenRouter: custom base URL
  // Secondary model fields (Phase 8.85) — for background tasks
  secondaryProvider?: string;  // defaults to same as primary
  secondaryModel?: string;     // if unset, secondary = primary (no-op)
  secondaryApiKey?: string;    // defaults to same as primary
  // Timeout fields (Phase 8.40) — configurable execution timeouts
  agentTimeoutMs?: number;      // main agent timeout (default: 600000 = 10 min)
  teammateTimeoutMs?: number;   // per-teammate timeout (default: 600000 = 10 min)
  subtaskTimeoutMs?: number;    // per deep-mode subtask timeout (default: 300000 = 5 min)
}

/**
 * Get LLM config for a given purpose ('primary' | 'secondary').
 * If no secondary model is configured, always returns primary config.
 * This is the central routing function for model selection (Phase 8.85).
 */
export function getModelConfig(
  purpose: 'primary' | 'secondary',
  config: LLMConfig,
): LLMConfig {
  if (purpose === 'primary' || !config.secondaryModel) {
    // No secondary configured → everything uses primary
    return config;
  }
  // Return a secondary LLM config derived from primary, overriding provider/model/apiKey
  return {
    ...config,
    provider: config.secondaryProvider || config.provider,
    model: config.secondaryModel,
    apiKey: config.secondaryApiKey || config.apiKey,
    // Thinking is typically off for secondary (lightweight tasks)
    thinking: false,
  };
}

/**
 * Build provider-specific options for thinking/reasoning.
 * Returns an object suitable for `providerOptions` in streamText/generateText.
 */
export function buildProviderOptions(config: LLMConfig): Record<string, any> {
  const thinkingEnabled = config.thinking !== false; // default ON
  const provider = config.provider;
  const model = config.model || '';

  switch (provider) {
    case 'anthropic':
    case 'bedrock': {
      // Anthropic supports adaptive thinking (Claude Sonnet 4.6+, Opus 4.6+)
      // Claude decides if/when to think based on problem complexity
      if (thinkingEnabled) {
        return {
          anthropic: {
            maxTokens: 16000,
            thinking: { type: 'adaptive' },
          },
        };
      }
      return {
        anthropic: {
          maxTokens: 16000,
        },
      };
    }

    case 'openai':
    case 'azure': {
      // OpenAI o1/o3 models support reasoning_effort
      const isReasoningModel = /^(o1|o3|o4)/.test(model);
      if (thinkingEnabled && isReasoningModel) {
        return {
          openai: {
            reasoningEffort: 'medium',
          },
        };
      }
      return {};
    }

    case 'google':
    case 'vertex': {
      // Gemini 2.5+ supports thinkingConfig
      const supportsThinking = /gemini-(2\.5|3)/.test(model);
      if (thinkingEnabled && supportsThinking) {
        return {
          google: {
            thinkingConfig: { thinkingBudget: 8192 },
          },
        };
      }
      return {};
    }

    case 'openrouter': {
      // OpenRouter passes through to underlying provider
      // Check model prefix to determine which provider options to use
      if (model.startsWith('anthropic/')) {
        if (thinkingEnabled) {
          return {
            anthropic: {
              maxTokens: 16000,
              thinking: { type: 'enabled', budgetTokens: 10000 },
            },
          };
        }
        return { anthropic: { maxTokens: 16000 } };
      }
      if (model.startsWith('openai/') && /^openai\/(o1|o3|o4)/.test(model)) {
        if (thinkingEnabled) {
          return { openai: { reasoningEffort: 'medium' } };
        }
      }
      if (model.startsWith('google/') && /google\/gemini-(2\.5|3)/.test(model)) {
        if (thinkingEnabled) {
          return { google: { thinkingConfig: { thinkingBudget: 8192 } } };
        }
      }
      return {};
    }

    case 'ollama':
    default:
      // Ollama/local models generally don't support thinking
      return {};
  }
}

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  google: 'gemini-2.0-flash',
  openrouter: 'anthropic/claude-sonnet-4-6',
  ollama: 'llama3.1',
  bedrock: 'anthropic.claude-sonnet-4-6-v2:0',
  vertex: 'gemini-2.0-flash',
  azure: 'gpt-4o',
};

export function getDefaultModel(provider: string): string {
  return DEFAULT_MODELS[provider] || DEFAULT_MODELS.anthropic;
}

export function createModel(config: LLMConfig): LanguageModel {
  const { provider, apiKey } = config;
  const model = config.model || DEFAULT_MODELS[provider] || DEFAULT_MODELS.anthropic;

  switch (provider) {
    case 'anthropic': {
      if (!apiKey) throw new Error('Anthropic API key required. Open Settings (⌘,) and add your API key.');
      const isOAuth = apiKey.startsWith('sk-ant-oat');
      if (isOAuth) {
        const anthropic = createAnthropic({
          authToken: apiKey,
          headers: {
            'anthropic-beta': 'oauth-2025-04-20',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
        } as any);
        return anthropic(model);
      }
      return createAnthropic({ apiKey })(model);
    }

    case 'openai': {
      if (!apiKey) throw new Error('OpenAI API key required. Open Settings (⌘,) and add your API key.');
      return createOpenAI({ apiKey })(model);
    }

    case 'google': {
      if (!apiKey) throw new Error('Google API key required. Open Settings (⌘,) and add your API key.');
      return createGoogleGenerativeAI({ apiKey })(model);
    }

    case 'openrouter': {
      if (!apiKey) throw new Error('OpenRouter API key required. Open Settings (⌘,) and add your API key.');
      const baseUrl = config.baseUrl || 'https://openrouter.ai/api/v1';
      return createOpenAI({
        apiKey,
        baseURL: baseUrl,
        headers: {
          'HTTP-Referer': 'https://tappi.synthworx.com',
          'X-Title': 'Tappi Browser',
        },
      })(model);
    }

    case 'ollama': {
      const baseUrl = config.baseUrl || 'http://localhost:11434/v1';
      // Ollama exposes an OpenAI-compatible API
      return createOpenAI({
        apiKey: 'ollama', // Ollama ignores this but SDK requires it
        baseURL: baseUrl,
      })(model);
    }

    case 'bedrock': {
      // @ai-sdk/amazon-bedrock reads from the standard AWS credential chain:
      // env vars → ~/.aws/credentials → IAM role
      const bedrockOptions: Record<string, any> = {};
      if (config.region) bedrockOptions.region = config.region;
      // If explicit keys provided (from settings), pass them
      if (apiKey && apiKey.includes(':')) {
        const [accessKeyId, secretAccessKey] = apiKey.split(':');
        bedrockOptions.accessKeyId = accessKeyId;
        bedrockOptions.secretAccessKey = secretAccessKey;
      }
      const bedrock = createAmazonBedrock(bedrockOptions);
      return bedrock(model);
    }

    case 'vertex': {
      // Vertex AI uses Google ADC — no API key needed.
      // @ai-sdk/google-vertex handles ADC automatically.
      const vertexOptions: Record<string, any> = {};
      if (config.projectId) vertexOptions.project = config.projectId;
      if (config.location) vertexOptions.location = config.location;
      const vertex = createVertex(vertexOptions);
      return vertex(model);
    }

    case 'azure': {
      const endpoint = config.endpoint || process.env.AZURE_OPENAI_ENDPOINT;
      const key = apiKey || process.env.AZURE_OPENAI_API_KEY;
      if (!endpoint) throw new Error('Azure OpenAI endpoint required. Set it in Settings or AZURE_OPENAI_ENDPOINT env var.');
      if (!key) throw new Error('Azure OpenAI API key required. Set it in Settings or AZURE_OPENAI_API_KEY env var.');
      const azure = createAzure({
        resourceName: extractAzureResourceName(endpoint),
        apiKey: key,
      });
      return azure(model);
    }

    default:
      throw new Error(`Unknown provider: ${provider}. Supported: anthropic, openai, google, openrouter, ollama, bedrock, vertex, azure.`);
  }
}

/**
 * Extract resource name from Azure endpoint URL.
 * https://myresource.openai.azure.com → myresource
 */
function extractAzureResourceName(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const parts = url.hostname.split('.');
    return parts[0] || endpoint;
  } catch {
    return endpoint;
  }
}

/**
 * Check if a provider requires an API key (vs auto-detection).
 */
export function requiresApiKey(provider: string): boolean {
  return ['anthropic', 'openai', 'google', 'openrouter'].includes(provider);
}

/**
 * Check if a provider supports credential auto-detection.
 */
export function supportsAutoDetect(provider: string): boolean {
  return ['bedrock', 'vertex', 'azure', 'ollama'].includes(provider);
}

/**
 * Get provider display info.
 */
export function getProviderInfo(provider: string): { name: string; description: string; fields: string[] } {
  const providers: Record<string, { name: string; description: string; fields: string[] }> = {
    anthropic: { name: 'Anthropic', description: 'Claude models', fields: ['apiKey'] },
    openai: { name: 'OpenAI', description: 'GPT models', fields: ['apiKey'] },
    google: { name: 'Google', description: 'Gemini models', fields: ['apiKey'] },
    openrouter: { name: 'OpenRouter', description: 'Multi-provider gateway', fields: ['apiKey'] },
    ollama: { name: 'Ollama', description: 'Local models', fields: ['baseUrl'] },
    bedrock: { name: 'AWS Bedrock', description: 'AWS-managed models', fields: ['region'] },
    vertex: { name: 'Vertex AI', description: 'Google Cloud AI', fields: ['projectId', 'location'] },
    azure: { name: 'Azure OpenAI', description: 'Azure-managed OpenAI', fields: ['endpoint', 'apiKey'] },
  };
  return providers[provider] || { name: provider, description: '', fields: ['apiKey'] };
}
