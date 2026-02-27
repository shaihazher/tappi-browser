/**
 * llm-client.ts — Multi-provider LLM client using Vercel AI SDK.
 *
 * Supports 9 providers:
 * - Anthropic (API key or OAuth token)
 * - OpenAI Codex (ChatGPT OAuth token or API key)
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
import { z } from 'zod';

export interface RequestErrorDetails {
  message: string;
  statusCode?: number;
  responseBody?: string;
  requestBodyValues?: string;
}

function compactErrorField(value: any, maxLen = 2000): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (!text) return undefined;
  return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
}

/**
 * Normalize AI SDK/provider errors so every call site can log the same fields.
 * Includes statusCode + responseBody + requestBodyValues for codex contract debugging.
 */
export function extractRequestErrorDetails(err: any, maxLen = 2000): RequestErrorDetails {
  const nested = err?.cause || {};
  const statusCode = err?.statusCode ?? err?.status ?? nested?.statusCode ?? nested?.status;
  const responseBody = compactErrorField(
    err?.responseBody ?? err?.data ?? nested?.responseBody ?? nested?.data,
    maxLen,
  );
  const requestBodyValues = compactErrorField(
    err?.requestBodyValues ?? nested?.requestBodyValues,
    maxLen,
  );

  return {
    message: err?.message || nested?.message || String(err),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(responseBody ? { responseBody } : {}),
    ...(requestBodyValues ? { requestBodyValues } : {}),
  };
}

/**
 * Standardized structured error logging for LLM calls.
 */
export function logProviderRequestError(scope: string, err: any): void {
  console.error(`[${scope}] LLM request failed:`, extractRequestErrorDetails(err));
}

/**
 * Attach codex-specific provider options for the Codex OpenAI-compatible path.
 *
 * Direct Codex backend requires `instructions` on each request.
 */
export function withCodexProviderOptions(
  provider: string,
  providerOptions: Record<string, any>,
  instructions: string,
  fallbackInstructions = 'You are Aria, a helpful AI assistant.',
): Record<string, any> {
  if (provider !== 'openai-codex') return providerOptions;

  const resolvedInstructions = (instructions || '').trim() || fallbackInstructions;

  return {
    ...providerOptions,
    openai: {
      ...(providerOptions.openai || {}),
      // Codex should run at medium/high reasoning effort by default.
      reasoningEffort: (providerOptions.openai && providerOptions.openai.reasoningEffort) || 'medium',
      // Required by direct ChatGPT Codex backend.
      instructions: resolvedInstructions,
    },
  };
}

export interface LLMConfig {
  provider: string;
  model: string;
  apiKey: string; // decrypted — may be empty for Bedrock/Vertex/Ollama
  thinking?: boolean;      // true = adaptive/deep thinking (high effort where supported), false = no thinking
  thinkingEffort?: 'low' | 'medium' | 'high';  // reasoning effort level (default: medium)
  // Cloud provider fields
  region?: string;         // Bedrock: AWS region
  projectId?: string;      // Vertex: GCP project ID
  location?: string;       // Vertex: GCP location (e.g. us-central1)
  endpoint?: string;       // Azure: resource endpoint URL
  baseUrl?: string;        // Ollama/OpenRouter: custom base URL
  // Secondary model fields (Phase 8.85) — for background tasks
  secondaryProvider?: string;  // deprecated (Phase 9.14): ignored, always primary
  secondaryModel?: string;     // deprecated (Phase 9.14): ignored, always primary
  secondaryApiKey?: string;    // deprecated (Phase 9.14): ignored, always primary
  // Timeout fields (Phase 8.40) — configurable execution timeouts
  agentTimeoutMs?: number;      // main agent timeout (default: 1800000 = 30 min)
  teammateTimeoutMs?: number;   // per-teammate timeout (default: 1800000 = 30 min)
  subtaskTimeoutMs?: number;    // per subtask timeout (default: 300000 = 5 min)
}

/**
 * Get LLM config for a given purpose ('primary' | 'secondary').
 * If no secondary model is configured, always returns primary config.
 * This is the central routing function for model selection (Phase 8.85).
 */
export function getModelConfig(
  _purpose: 'primary' | 'secondary',
  config: LLMConfig,
): LLMConfig {
  // Phase 9.14: Secondary model routing removed.
  // All calls (primary + secondary tasks) use the same provider/model/api key.
  return config;
}

/**
 * Build provider-specific options for thinking/reasoning.
 * Returns an object suitable for `providerOptions` in streamText/generateText.
 */
export function buildProviderOptions(config: LLMConfig): Record<string, any> {
  const thinkingEnabled = config.thinking !== false; // default ON
  const thinkingEffort = config.thinkingEffort || 'medium'; // default medium
  const provider = config.provider;
  const model = config.model || '';
  // Phase 9.12: Medium thinking budget — balances quality vs cost
  const thinkingBudget = 8192;

  switch (provider) {
    case 'anthropic':
    case 'bedrock': {
      // Adaptive thinking (Opus 4.6 / Sonnet 4.6): model decides when/how much to think.
      // No effort constraint — let the model reason as much as it needs.
      // maxOutputTokens (set by caller, ~16K) gives headroom for thinking + response.
      if (thinkingEnabled) {
        return {
          anthropic: {
            thinking: { type: 'adaptive' },
          },
        };
      }
      return {};
    }

    case 'openai-codex': {
      // OpenAI Codex (gpt-5.x-codex) supports reasoningEffort: low/medium/high
      if (thinkingEnabled) {
        return {
          openai: {
            reasoningEffort: thinkingEffort,
          },
        };
      }
      return {
        openai: {
          reasoningEffort: 'low',
        },
      };
    }

    case 'openai':
    case 'azure': {
      // Phase 9.12: Default to medium reasoning effort
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
      // Gemini 2.5+ supports thinkingConfig. Use a larger budget for deeper reasoning.
      const supportsThinking = /gemini-(2\.5|3)/.test(model);
      if (thinkingEnabled && supportsThinking) {
        return {
          google: {
            thinkingConfig: { thinkingBudget: thinkingBudget },
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
              thinking: { type: 'adaptive' },
            },
          };
        }
        return {};
      }
      if (model.startsWith('openai/') && /^openai\/(o1|o3|o4|gpt-5)/.test(model)) {
        // OpenAI reasoning models via OpenRouter
        if (thinkingEnabled) {
          return { openai: { reasoningEffort: thinkingEffort } };
        }
        return { openai: { reasoningEffort: 'low' } };
      }
      if (model.startsWith('x-ai/') && /^x-ai\/grok/.test(model)) {
        // xAI Grok models via OpenRouter support reasoning parameter
        // https://openrouter.ai/provider/xai
        if (thinkingEnabled) {
          return {
            reasoning: {
              enabled: true,
              effort: thinkingEffort,
            },
          };
        }
        return {
          reasoning: {
            enabled: false,
          },
        };
      }
      if (model.startsWith('google/') && /google\/gemini-(2\.5|3)/.test(model)) {
        if (thinkingEnabled) {
          return { google: { thinkingConfig: { thinkingBudget: thinkingBudget } } };
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
  'openai-codex': 'gpt-5.3-codex',
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

function parseOpenAIAuthClaims(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2 || !parts[1]) return null;
    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson) as Record<string, any>;
    const namespaced = payload?.['https://api.openai.com/auth'];
    if (namespaced && typeof namespaced === 'object') return namespaced;
    return payload;
  } catch {
    return null;
  }
}

const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

function isLikelyCodexBaseUrl(raw: string): boolean {
  if (!raw) return false;
  const lowered = raw.toLowerCase();
  if (lowered.includes('openrouter.ai') || lowered.includes('api.openai.com')) return false;
  return lowered.includes('codex');
}

function getCodexBaseUrl(config: LLMConfig): string {
  const envRaw = (process.env.OPENAI_CODEX_BASE_URL || '').trim();
  const configRaw = (config.baseUrl || '').trim();

  const chosen = envRaw
    || (isLikelyCodexBaseUrl(configRaw) ? configRaw : '')
    || DEFAULT_CODEX_BASE_URL;

  return chosen.replace(/\/+$/, '');
}

function buildCodexAuthHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'OpenAI-Beta': 'responses=experimental',
    originator: 'codex_cli_rs',
  };
  const claims = parseOpenAIAuthClaims(apiKey);
  const chatgptAccountId = claims?.chatgpt_account_id;
  if (chatgptAccountId) {
    headers['chatgpt-account-id'] = String(chatgptAccountId);
  }
  return headers;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableCodexNetworkError(err: any): boolean {
  const msg = String(err?.message || '').toLowerCase();
  const causeCode = String(err?.cause?.code || '').toLowerCase();

  if (msg.includes('aborted') || msg.includes('aborterror')) return false;

  return (
    msg.includes('fetch failed')
    || msg.includes('network')
    || msg.includes('socket hang up')
    || msg.includes('econnreset')
    || msg.includes('econnrefused')
    || msg.includes('etimedout')
    || msg.includes('eai_again')
    || causeCode === 'econnreset'
    || causeCode === 'econnrefused'
    || causeCode === 'etimedout'
    || causeCode === 'eai_again'
  );
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

    case 'openai-codex': {
      if (!apiKey) throw new Error('OpenAI Codex token required. Open Settings (⌘,) and sign in with ChatGPT.');

      // Codex runs against the dedicated Codex backend base URL (not OpenAI v1).
      // Reuse the existing decrypted OAuth/API key exactly as stored.
      const codexBaseUrl = getCodexBaseUrl(config);
      const codex = createOpenAI({
        apiKey,
        baseURL: codexBaseUrl,
        headers: buildCodexAuthHeaders(apiKey),
      });
      const normalizedModel = model || DEFAULT_MODELS['openai-codex'];
      return codex(normalizedModel as any);
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

      // OpenRouter behaves more reliably with OpenAI Chat Completions than
      // OpenAI Responses API for large tool sets.
      // Also normalize common dotted Claude aliases to canonical dashed IDs.
      const normalizedModel = model
        .replace('anthropic/claude-sonnet-4.6', 'anthropic/claude-sonnet-4-6')
        .replace('anthropic/claude-opus-4.6', 'anthropic/claude-opus-4-6');

      const openrouter = createOpenAI({
        apiKey,
        baseURL: baseUrl,
        headers: {
          'HTTP-Referer': 'https://tappi.synthworx.com',
          'X-Title': 'Tappi Browser',
        },
      });

      return openrouter.chat(normalizedModel as any);
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
      throw new Error(`Unknown provider: ${provider}. Supported: anthropic, openai-codex, openai, google, openrouter, ollama, bedrock, vertex, azure.`);
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
  return ['anthropic', 'openai-codex', 'openai', 'google', 'openrouter'].includes(provider);
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
    'openai-codex': { name: 'OpenAI Codex', description: 'Codex GPT models', fields: ['apiKey'] },
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

type LiteLLMRole = 'system' | 'user' | 'assistant' | 'tool';

interface LiteLLMMessage {
  role: LiteLLMRole;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

interface LiteLLMToolSpec {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, any>;
  };
}

interface LiteLLMToolDeltaState {
  index: number;
  id: string;
  name: string;
  argumentsText: string;
}

interface LiteLLMUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface LiteLLMStepRawResult {
  text: string;
  reasoningText: string;
  finishReason: string;
  toolIntent: boolean;
  toolCalls: LiteLLMToolCall[];
  usage: LiteLLMUsage;
}

export interface LiteLLMToolCall {
  id: string;
  index: number;
  name: string;
  argumentsText: string;
  args: Record<string, any>;
  parseError?: string;
}

export interface LiteLLMToolResult {
  toolName: string;
  toolCallId: string;
  args: Record<string, any>;
  output: any;
  outputText: string;
  success: boolean;
  error?: string;
}

export interface LiteLLMStepEvent {
  stepNumber: number;
  finishReason: string;
  text: string;
  reasoningText: string;
  toolIntent: boolean;
  retryNonStream: boolean;
  toolCalls: LiteLLMToolCall[];
  toolResults: LiteLLMToolResult[];
}

export interface LiteLLMMetrics {
  steps: number;
  toolCalls: number;
  toolCallSuccesses: number;
  toolCallFailures: number;
  emptyToolIntentRetries: number;
  unresolvedEmptyToolIntentSteps: number;
}

export interface LiteLLMRunOptions {
  config: LLMConfig;
  system?: string;
  messages: Array<{ role: string; content: any }>;
  tools?: Record<string, any>;
  maxSteps?: number;
  providerOptions?: Record<string, any>;
  abortSignal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onToolCall?: (toolCall: LiteLLMToolCall) => void;
  onToolResult?: (toolResult: LiteLLMToolResult) => void;
  onStepFinish?: (event: LiteLLMStepEvent) => Promise<void> | void;
  /**
   * Optional parity hook with AI SDK prepareStep.
   * Can inject transient messages for the next step request only.
   */
  prepareStep?: (ctx: {
    stepNumber: number;
    messages: Array<{ role: string; content?: any; tool_call_id?: string; tool_calls?: any[] }>;
  }) => Promise<{ messages?: Array<{ role: string; content?: any; tool_call_id?: string; tool_calls?: any[] }> } | void>
    | ({ messages?: Array<{ role: string; content?: any; tool_call_id?: string; tool_calls?: any[] }> } | void);
  logPrefix?: string;
}

export interface LiteLLMRunResult {
  text: string;
  reasoningText: string;
  steps: LiteLLMStepEvent[];
  usage: LiteLLMUsage;
  metrics: LiteLLMMetrics;
  /**
   * AI SDK-style structured messages (assistant/tool turns) synthesized from
   * LiteLLM step events for conversation-memory parity.
   */
  responseMessages: Array<{ role: string; content: any }>;
}

function safeJsonStringify(value: any): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
}

function flattenStructuredContent(content: any): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return safeJsonStringify(content);

  const parts: string[] = [];
  for (const rawPart of content) {
    if (!rawPart || typeof rawPart !== 'object') continue;
    const part = rawPart as Record<string, any>;

    if (typeof part.text === 'string' && part.text.length > 0) {
      parts.push(part.text);
      continue;
    }

    if (part.type === 'tool-call') {
      const name = typeof part.toolName === 'string' ? part.toolName : 'unknown';
      const args = safeJsonStringify(part.args ?? {});
      parts.push(`[tool-call:${name} ${args}]`);
      continue;
    }

    if (part.type === 'tool-result') {
      const name = typeof part.toolName === 'string' ? part.toolName : 'unknown';
      const result = safeJsonStringify(part.result ?? part.output ?? '');
      parts.push(`[tool-result:${name} ${result}]`);
      continue;
    }

    if (part.type === 'reasoning') {
      if (typeof part.text === 'string' && part.text.length > 0) {
        parts.push(`[reasoning:${part.text}]`);
      }
      continue;
    }

    if (typeof part.content === 'string' && part.content.length > 0) {
      parts.push(part.content);
    }
  }

  return parts.join('\n');
}

function extractAssistantToolCalls(content: any): Array<{ id: string; name: string; args: Record<string, any> }> {
  if (!Array.isArray(content)) return [];

  const calls: Array<{ id: string; name: string; args: Record<string, any> }> = [];
  for (const rawPart of content) {
    if (!rawPart || typeof rawPart !== 'object') continue;
    const part = rawPart as Record<string, any>;
    if (part.type !== 'tool-call') continue;

    const id = String(part.toolCallId ?? part.tool_call_id ?? '').trim();
    const name = String(part.toolName ?? part.tool_name ?? '').trim();
    const argsRaw = part.args ?? part.arguments ?? {};
    const args = argsRaw && typeof argsRaw === 'object' ? argsRaw as Record<string, any> : { value: argsRaw };

    if (!id || !name) continue;
    calls.push({ id, name, args });
  }

  return calls;
}

function extractToolResults(content: any): Array<{ toolCallId: string; outputText: string }> {
  const parts = Array.isArray(content) ? content : [content];
  const results: Array<{ toolCallId: string; outputText: string }> = [];

  for (const rawPart of parts) {
    if (!rawPart || typeof rawPart !== 'object') continue;
    const part = rawPart as Record<string, any>;
    const type = String(part.type ?? '').trim();
    if (type && type !== 'tool-result') continue;

    const toolCallId = String(part.toolCallId ?? part.tool_call_id ?? '').trim();
    if (!toolCallId) continue;

    const outputRaw = part.result ?? part.output ?? part.content ?? '';
    const outputText = typeof outputRaw === 'string' ? outputRaw : safeJsonStringify(outputRaw);
    results.push({ toolCallId, outputText });
  }

  return results;
}

export function toLiteLLMMessages(messages: Array<{ role: string; content: any }>): LiteLLMMessage[] {
  const mapped: LiteLLMMessage[] = [];

  for (const msg of messages) {
    const role = msg?.role;

    if (role === 'system' || role === 'user') {
      mapped.push({ role, content: flattenStructuredContent(msg?.content) });
      continue;
    }

    if (role === 'assistant') {
      const textContent = flattenStructuredContent(msg?.content);
      const calls = extractAssistantToolCalls(msg?.content);
      if (calls.length > 0) {
        mapped.push({
          role: 'assistant',
          content: textContent || null,
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: {
              name: call.name,
              arguments: safeJsonStringify(call.args),
            },
          })),
        });
      } else {
        mapped.push({ role: 'assistant', content: textContent });
      }
      continue;
    }

    if (role === 'tool') {
      const results = extractToolResults(msg?.content);
      if (results.length > 0) {
        for (const result of results) {
          mapped.push({
            role: 'tool',
            tool_call_id: result.toolCallId,
            content: result.outputText,
          });
        }
      } else {
        // Fallback for legacy/non-structured tool history.
        const content = flattenStructuredContent(msg?.content);
        mapped.push({ role: 'assistant', content: content ? `[tool-history] ${content}` : '[tool-history]' });
      }
      continue;
    }

    // Unknown role: degrade safely to user text.
    mapped.push({ role: 'user', content: flattenStructuredContent(msg?.content) });
  }

  return mapped;
}

function buildLiteLLMToolSpecs(tools: Record<string, any>): LiteLLMToolSpec[] {
  const specs: LiteLLMToolSpec[] = [];

  for (const [name, rawTool] of Object.entries(tools || {})) {
    const tool = rawTool as {
      description?: string;
      inputSchema?: any;
      execute?: (...args: any[]) => any;
    };

    if (!tool || typeof tool.execute !== 'function') continue;

    let parameters: Record<string, any> = {
      type: 'object',
      properties: {},
      additionalProperties: true,
    };

    if (tool.inputSchema) {
      try {
        parameters = z.toJSONSchema(tool.inputSchema as any) as Record<string, any>;
      } catch (schemaErr: any) {
        console.warn(`[litellm-codex] Failed to serialize schema for tool "${name}":`, schemaErr?.message || schemaErr);
      }
    }

    specs.push({
      type: 'function',
      function: {
        name,
        description: tool.description || '',
        parameters,
      },
    });
  }

  return specs;
}

function parseToolArgsLenient(rawArgs: unknown): { args: Record<string, any>; argumentsText: string; parseError?: string } {
  if (rawArgs === undefined || rawArgs === null) {
    return { args: {}, argumentsText: '{}' };
  }

  if (typeof rawArgs === 'object') {
    return {
      args: rawArgs as Record<string, any>,
      argumentsText: safeJsonStringify(rawArgs),
    };
  }

  const original = String(rawArgs);
  const trimmed = original.trim();

  const candidates = new Set<string>();
  candidates.add(original);
  candidates.add(trimmed);
  candidates.add(trimmed.replace(/,\s*([}\]])/g, '$1'));

  // Brace balancing repair for fragmented stream arguments.
  const balanced = (() => {
    let repaired = trimmed;
    const openCurly = (repaired.match(/\{/g) || []).length;
    const closeCurly = (repaired.match(/\}/g) || []).length;
    if (openCurly > closeCurly) repaired += '}'.repeat(openCurly - closeCurly);
    const openSquare = (repaired.match(/\[/g) || []).length;
    const closeSquare = (repaired.match(/\]/g) || []).length;
    if (openSquare > closeSquare) repaired += ']'.repeat(openSquare - closeSquare);
    return repaired;
  })();
  candidates.add(balanced);
  candidates.add(balanced.replace(/,\s*([}\]])/g, '$1'));

  let lastErr = '';
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') {
        return { args: parsed as Record<string, any>, argumentsText: candidate };
      }
      return { args: { value: parsed }, argumentsText: candidate };
    } catch (err: any) {
      lastErr = err?.message || String(err);
    }
  }

  return {
    args: {},
    argumentsText: trimmed || original,
    parseError: lastErr || 'Failed to parse tool arguments',
  };
}

function resolveReasoningEffort(providerOptions?: Record<string, any>): 'low' | 'medium' | 'high' {
  const raw = providerOptions?.openai?.reasoningEffort;
  if (raw === 'low' || raw === 'medium' || raw === 'high') return raw;
  return 'high';
}

function extractTextFromDelta(delta: any): string {
  if (!delta) return '';

  if (typeof delta.content === 'string') return delta.content;

  if (Array.isArray(delta.content)) {
    const bits: string[] = [];
    for (const part of delta.content) {
      if (typeof part === 'string') {
        bits.push(part);
      } else if (part && typeof part === 'object') {
        if (typeof part.text === 'string') bits.push(part.text);
        else if (typeof part.content === 'string') bits.push(part.content);
      }
    }
    return bits.join('');
  }

  if (typeof delta.text === 'string') return delta.text;
  if (typeof delta.output_text === 'string') return delta.output_text;
  return '';
}

function extractReasoningFromDelta(delta: any): string {
  if (!delta) return '';

  if (typeof delta.reasoning === 'string') return delta.reasoning;
  if (typeof delta.reasoning_content === 'string') return delta.reasoning_content;

  if (Array.isArray(delta.reasoning)) {
    const bits: string[] = [];
    for (const part of delta.reasoning) {
      if (typeof part === 'string') bits.push(part);
      else if (part && typeof part === 'object') {
        if (typeof part.text === 'string') bits.push(part.text);
        else if (typeof part.content === 'string') bits.push(part.content);
      }
    }
    return bits.join('');
  }

  return '';
}

function buildToolCallsFromAccumulator(acc: Map<number, LiteLLMToolDeltaState>, stepNumber: number): LiteLLMToolCall[] {
  const ordered = [...acc.values()].sort((a, b) => a.index - b.index);
  return ordered
    .map((item) => {
      const parsed = parseToolArgsLenient(item.argumentsText);
      const name = (item.name || '').trim();
      if (!name) return null;
      return {
        id: item.id || `call_step_${stepNumber}_${item.index}`,
        index: item.index,
        name,
        argumentsText: parsed.argumentsText,
        args: parsed.args,
        ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
      } as LiteLLMToolCall;
    })
    .filter((item): item is LiteLLMToolCall => Boolean(item));
}

async function runLiteLLMStreamStep(params: {
  config: LLMConfig;
  body: Record<string, any>;
  stepNumber: number;
  abortSignal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
}): Promise<LiteLLMStepRawResult> {
  const url = `${getCodexBaseUrl(params.config)}/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.config.apiKey}`,
      ...buildCodexAuthHeaders(params.config.apiKey),
    },
    body: JSON.stringify({ ...params.body, stream: true, stream_options: { include_usage: true } }),
    signal: params.abortSignal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Codex stream error (${response.status}): ${body.slice(0, 2000)}`);
  }

  if (!response.body) {
    throw new Error('Codex stream error: empty response body');
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';
  let eventLines: string[] = [];
  let done = false;

  let text = '';
  let reasoningText = '';
  let finishReason = '';
  let toolIntent = false;
  const usage: LiteLLMUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const toolAcc = new Map<number, LiteLLMToolDeltaState>();

  const processEvent = (payloadText: string): void => {
    const payloadTrimmed = payloadText.trim();
    if (!payloadTrimmed) return;
    if (payloadTrimmed === '[DONE]') {
      done = true;
      return;
    }

    let payload: any;
    try {
      payload = JSON.parse(payloadTrimmed);
    } catch {
      return;
    }

    if (payload?.usage && typeof payload.usage === 'object') {
      usage.inputTokens += Number(payload.usage.prompt_tokens || 0);
      usage.outputTokens += Number(payload.usage.completion_tokens || 0);
      usage.totalTokens += Number(payload.usage.total_tokens || 0);
    }

    const choices = Array.isArray(payload?.choices) ? payload.choices : [];
    for (const choice of choices) {
      const delta = choice?.delta || {};

      const textDelta = extractTextFromDelta(delta);
      if (textDelta) {
        text += textDelta;
        params.onTextDelta?.(textDelta);
      }

      const reasoningDelta = extractReasoningFromDelta(delta);
      if (reasoningDelta) {
        reasoningText += reasoningDelta;
        params.onReasoningDelta?.(reasoningDelta);
      }

      const deltaToolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
      if (deltaToolCalls.length > 0) toolIntent = true;

      for (const rawTc of deltaToolCalls) {
        const tc = rawTc as Record<string, any>;
        const idxRaw = tc.index;
        const index = typeof idxRaw === 'number' ? idxRaw : Number(idxRaw ?? 0) || 0;

        const existing = toolAcc.get(index) || {
          index,
          id: '',
          name: '',
          argumentsText: '',
        };

        if (typeof tc.id === 'string' && tc.id.length > 0) {
          existing.id = tc.id;
        }

        const fn = (tc.function && typeof tc.function === 'object') ? tc.function as Record<string, any> : {};

        if (typeof fn.name === 'string' && fn.name.length > 0) {
          existing.name += fn.name;
        }

        if (typeof fn.arguments === 'string' && fn.arguments.length > 0) {
          existing.argumentsText += fn.arguments;
        }

        toolAcc.set(index, existing);
      }

      if (typeof choice?.finish_reason === 'string' && choice.finish_reason.length > 0) {
        finishReason = choice.finish_reason;
        if (finishReason === 'tool_calls') toolIntent = true;
      }
    }
  };

  const flushEvent = (): void => {
    if (eventLines.length === 0) return;
    const payload = eventLines.join('\n');
    eventLines = [];
    processEvent(payload);
  };

  while (!done) {
    const { value, done: readerDone } = await reader.read();
    if (readerDone) break;

    buffer += decoder.decode(value, { stream: true });

    let lineBreakIndex = buffer.indexOf('\n');
    while (lineBreakIndex >= 0) {
      const rawLine = buffer.slice(0, lineBreakIndex);
      buffer = buffer.slice(lineBreakIndex + 1);
      const line = rawLine.replace(/\r$/, '');

      if (line.length === 0) {
        flushEvent();
      } else if (line.startsWith('data:')) {
        eventLines.push(line.slice(5).trimStart());
      }

      lineBreakIndex = buffer.indexOf('\n');
    }
  }

  if (buffer.trim().length > 0) {
    const trailingLines = buffer.split('\n').map((line) => line.replace(/\r$/, ''));
    for (const line of trailingLines) {
      if (!line) {
        flushEvent();
      } else if (line.startsWith('data:')) {
        eventLines.push(line.slice(5).trimStart());
      }
    }
  }

  flushEvent();

  return {
    text,
    reasoningText,
    finishReason: finishReason || 'stop',
    toolIntent,
    toolCalls: buildToolCallsFromAccumulator(toolAcc, params.stepNumber),
    usage,
  };
}

async function runLiteLLMNonStreamStep(params: {
  config: LLMConfig;
  body: Record<string, any>;
  stepNumber: number;
  abortSignal?: AbortSignal;
}): Promise<LiteLLMStepRawResult> {
  const url = `${getCodexBaseUrl(params.config)}/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.config.apiKey}`,
      ...buildCodexAuthHeaders(params.config.apiKey),
    },
    body: JSON.stringify({ ...params.body, stream: false }),
    signal: params.abortSignal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Codex non-stream error (${response.status}): ${body.slice(0, 2000)}`);
  }

  const payload = await response.json() as any;
  const usage: LiteLLMUsage = {
    inputTokens: Number(payload?.usage?.prompt_tokens || 0),
    outputTokens: Number(payload?.usage?.completion_tokens || 0),
    totalTokens: Number(payload?.usage?.total_tokens || 0),
  };

  const choice = Array.isArray(payload?.choices) && payload.choices.length > 0
    ? payload.choices[0]
    : null;

  const message = (choice?.message && typeof choice.message === 'object')
    ? choice.message as Record<string, any>
    : {};

  const content = (() => {
    const rawContent = message?.content;
    if (typeof rawContent === 'string') return rawContent;
    if (Array.isArray(rawContent)) {
      return rawContent.map((part: any) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
        }
        return '';
      }).join('');
    }
    return '';
  })();

  const rawToolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const toolCalls: LiteLLMToolCall[] = rawToolCalls.map((raw: any, idx: number) => {
    const id = typeof raw?.id === 'string' && raw.id.length > 0 ? raw.id : `call_step_${params.stepNumber}_${idx}`;
    const fn = raw?.function && typeof raw.function === 'object' ? raw.function : {};
    const name = typeof fn?.name === 'string' ? fn.name : '';
    const parsed = parseToolArgsLenient(fn?.arguments);
    return {
      id,
      index: typeof raw?.index === 'number' ? raw.index : idx,
      name,
      argumentsText: parsed.argumentsText,
      args: parsed.args,
      ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
    };
  }).filter((call) => call.name.length > 0);

  const finishReason = typeof choice?.finish_reason === 'string' && choice.finish_reason.length > 0
    ? choice.finish_reason
    : 'stop';
  const toolIntent = finishReason === 'tool_calls' || toolCalls.length > 0;

  return {
    text: content,
    reasoningText: '',
    finishReason,
    toolIntent,
    toolCalls,
    usage,
  };
}

async function executeLiteLLMToolCall(
  tools: Record<string, any>,
  toolCall: LiteLLMToolCall,
): Promise<LiteLLMToolResult> {
  const tool = tools[toolCall.name] as {
    inputSchema?: any;
    execute?: (args: any, opts?: { toolCallId?: string; messages?: any[] }) => Promise<any> | any;
  } | undefined;

  if (!tool || typeof tool.execute !== 'function') {
    const outputText = `❌ Tool "${toolCall.name}" is not available.`;
    return {
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      args: toolCall.args,
      output: outputText,
      outputText,
      success: false,
      error: outputText,
    };
  }

  let parsedArgs: Record<string, any> = toolCall.args;

  if (tool.inputSchema && typeof tool.inputSchema.parse === 'function') {
    try {
      parsedArgs = tool.inputSchema.parse(parsedArgs) as Record<string, any>;
    } catch (schemaErr: any) {
      const errMsg = `❌ Invalid arguments for tool "${toolCall.name}": ${schemaErr?.message || String(schemaErr)}`;
      return {
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        args: toolCall.args,
        output: errMsg,
        outputText: errMsg,
        success: false,
        error: errMsg,
      };
    }
  }

  try {
    const output = await tool.execute(parsedArgs, { toolCallId: toolCall.id, messages: [] });
    const outputText = typeof output === 'string' ? output : safeJsonStringify(output);
    return {
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      args: parsedArgs,
      output,
      outputText,
      success: true,
    };
  } catch (execErr: any) {
    const errMsg = execErr?.message || String(execErr);
    const outputText = `❌ Tool "${toolCall.name}" failed: ${errMsg}`;
    return {
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      args: parsedArgs,
      output: outputText,
      outputText,
      success: false,
      error: outputText,
    };
  }
}

export function buildStructuredResponseMessages(steps: LiteLLMStepEvent[]): Array<{ role: string; content: any }> {
  const messages: Array<{ role: string; content: any }> = [];

  for (const step of steps) {
    const assistantParts: any[] = [];

    if (step.text && step.text.length > 0) {
      assistantParts.push({ type: 'text', text: step.text });
    }

    for (const call of step.toolCalls) {
      assistantParts.push({
        type: 'tool-call',
        toolCallId: call.id,
        toolName: call.name,
        args: call.args,
      });
    }

    if (assistantParts.length > 0) {
      messages.push({ role: 'assistant', content: assistantParts });
    }

    if (step.toolResults.length > 0) {
      messages.push({
        role: 'tool',
        content: step.toolResults.map((result) => ({
          type: 'tool-result',
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          result: result.output,
        })),
      });
    }
  }

  return messages;
}

/**
 * Codex-only LiteLLM runtime loop.
 *
 * - Streams text/tool call deltas from LiteLLM chat completions
 * - Reassembles fragmented tool-call JSON arguments by tool index
 * - Retries one step in non-stream mode if tool intent is signaled but parsed calls are empty
 * - Executes every parsed tool call sequentially and appends deterministic tool results
 */
export async function runLiteLLMCodexToolLoop(opts: LiteLLMRunOptions): Promise<LiteLLMRunResult> {
  const { config } = opts;
  if (config.provider !== 'openai-codex') {
    throw new Error('runLiteLLMCodexToolLoop is only valid for provider=openai-codex');
  }

  const logPrefix = opts.logPrefix || 'codex-backend';
  const maxSteps = Math.max(1, opts.maxSteps ?? 200);
  const tools = opts.tools || {};
  const toolSpecs = buildLiteLLMToolSpecs(tools);
  const reasoningEffort = resolveReasoningEffort(opts.providerOptions);

  const transcript: LiteLLMMessage[] = [];
  if (opts.system && opts.system.trim().length > 0) {
    transcript.push({ role: 'system', content: opts.system });
  }
  transcript.push(...toLiteLLMMessages(opts.messages));

  const usage: LiteLLMUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const steps: LiteLLMStepEvent[] = [];
  const metrics: LiteLLMMetrics = {
    steps: 0,
    toolCalls: 0,
    toolCallSuccesses: 0,
    toolCallFailures: 0,
    emptyToolIntentRetries: 0,
    unresolvedEmptyToolIntentSteps: 0,
  };

  let fullText = '';
  let fullReasoning = '';

  for (let stepNumber = 0; stepNumber < maxSteps; stepNumber++) {
    let stepMessages: LiteLLMMessage[] = transcript;
    if (opts.prepareStep) {
      const prepared = await opts.prepareStep({
        stepNumber,
        messages: transcript.map((m) => ({ ...m })),
      });
      if (prepared?.messages && Array.isArray(prepared.messages) && prepared.messages.length > 0) {
        stepMessages = prepared.messages as LiteLLMMessage[];
      }
    }

    const body: Record<string, any> = {
      model: config.model || DEFAULT_MODELS['openai-codex'],
      messages: stepMessages,
      reasoning_effort: reasoningEffort,
      max_tokens: 32768,
      ...(toolSpecs.length > 0
        ? {
          tools: toolSpecs,
          tool_choice: 'auto',
          parallel_tool_calls: false,
        }
        : {}),
    };

    let stepStream: LiteLLMStepRawResult | null = null;
    const streamRetries = 2;
    for (let attempt = 0; attempt <= streamRetries; attempt++) {
      try {
        stepStream = await runLiteLLMStreamStep({
          config,
          body,
          stepNumber,
          abortSignal: opts.abortSignal,
          onTextDelta: (delta) => {
            fullText += delta;
            opts.onTextDelta?.(delta);
          },
          onReasoningDelta: (delta) => {
            fullReasoning += delta;
            opts.onReasoningDelta?.(delta);
          },
        });
        break;
      } catch (err: any) {
        if (opts.abortSignal?.aborted) throw err;
        const retryable = isRetryableCodexNetworkError(err);
        if (!retryable || attempt >= streamRetries) throw err;
        const waitMs = 250 * (attempt + 1);
        console.warn(
          `[${logPrefix}] STEP ${stepNumber + 1} stream failed (${err?.message || err}); ` +
          `retrying in ${waitMs}ms (${attempt + 1}/${streamRetries})`,
        );
        await sleep(waitMs);
      }
    }

    if (!stepStream) {
      throw new Error(`Codex step ${stepNumber + 1} failed: no stream response`);
    }

    usage.inputTokens += stepStream.usage.inputTokens;
    usage.outputTokens += stepStream.usage.outputTokens;
    usage.totalTokens += stepStream.usage.totalTokens;

    let step = stepStream;
    let retryNonStream = false;

    if (step.toolIntent && step.toolCalls.length === 0) {
      metrics.emptyToolIntentRetries += 1;
      retryNonStream = true;
      let nonStream: LiteLLMStepRawResult | null = null;
      const nonStreamRetries = 1;
      for (let attempt = 0; attempt <= nonStreamRetries; attempt++) {
        try {
          nonStream = await runLiteLLMNonStreamStep({
            config,
            body,
            stepNumber,
            abortSignal: opts.abortSignal,
          });
          break;
        } catch (err: any) {
          if (opts.abortSignal?.aborted) throw err;
          const retryable = isRetryableCodexNetworkError(err);
          if (!retryable || attempt >= nonStreamRetries) throw err;
          const waitMs = 250 * (attempt + 1);
          console.warn(
            `[${logPrefix}] STEP ${stepNumber + 1} non-stream failed (${err?.message || err}); ` +
            `retrying in ${waitMs}ms (${attempt + 1}/${nonStreamRetries})`,
          );
          await sleep(waitMs);
        }
      }

      if (!nonStream) {
        throw new Error(`Codex step ${stepNumber + 1} failed: no non-stream response`);
      }

      usage.inputTokens += nonStream.usage.inputTokens;
      usage.outputTokens += nonStream.usage.outputTokens;
      usage.totalTokens += nonStream.usage.totalTokens;

      // Keep streamed text if non-stream returned none; otherwise prefer non-stream payload.
      step = {
        text: nonStream.text || step.text,
        reasoningText: nonStream.reasoningText || step.reasoningText,
        finishReason: nonStream.finishReason || step.finishReason,
        toolIntent: nonStream.toolIntent || step.toolIntent,
        toolCalls: nonStream.toolCalls,
        usage: {
          inputTokens: step.usage.inputTokens + nonStream.usage.inputTokens,
          outputTokens: step.usage.outputTokens + nonStream.usage.outputTokens,
          totalTokens: step.usage.totalTokens + nonStream.usage.totalTokens,
        },
      };
    }

    if (step.toolIntent && step.toolCalls.length === 0) {
      metrics.unresolvedEmptyToolIntentSteps += 1;
    }

    const assistantToolCalls = step.toolCalls.map((call) => ({
      id: call.id,
      type: 'function' as const,
      function: {
        name: call.name,
        arguments: call.argumentsText || safeJsonStringify(call.args),
      },
    }));

    // Always append assistant turn so the next step has complete context.
    transcript.push(
      assistantToolCalls.length > 0
        ? {
          role: 'assistant',
          content: step.text || null,
          tool_calls: assistantToolCalls,
        }
        : {
          role: 'assistant',
          content: step.text || '',
        },
    );

    const stepEvent: LiteLLMStepEvent = {
      stepNumber,
      finishReason: step.finishReason || 'stop',
      text: step.text,
      reasoningText: step.reasoningText,
      toolIntent: step.toolIntent,
      retryNonStream,
      toolCalls: step.toolCalls,
      toolResults: [],
    };

    for (const call of step.toolCalls.sort((a, b) => a.index - b.index)) {
      opts.onToolCall?.(call);

      const toolResult = await executeLiteLLMToolCall(tools, call);
      stepEvent.toolResults.push(toolResult);
      opts.onToolResult?.(toolResult);

      metrics.toolCalls += 1;
      if (toolResult.success) metrics.toolCallSuccesses += 1;
      else metrics.toolCallFailures += 1;

      transcript.push({
        role: 'tool',
        tool_call_id: call.id,
        content: toolResult.outputText,
      });
    }

    metrics.steps = stepNumber + 1;

    console.log(
      `[${logPrefix}] STEP ${stepNumber + 1} ` +
      `finish=${stepEvent.finishReason} ` +
      `intent=${stepEvent.toolIntent} ` +
      `parsed_calls=${stepEvent.toolCalls.length} ` +
      `executed=${stepEvent.toolResults.length} ` +
      `retry_non_stream=${retryNonStream}`,
    );

    await opts.onStepFinish?.(stepEvent);
    steps.push(stepEvent);

    if (step.toolCalls.length === 0) {
      // No more tool calls in this step — final answer reached.
      break;
    }
  }

  console.log(
    `[${logPrefix}] SUMMARY ` +
    `steps=${metrics.steps} ` +
    `tool_calls=${metrics.toolCalls} ` +
    `tool_success=${metrics.toolCallSuccesses} ` +
    `tool_failures=${metrics.toolCallFailures} ` +
    `empty_intent_retries=${metrics.emptyToolIntentRetries} ` +
    `unresolved_empty_intent=${metrics.unresolvedEmptyToolIntentSteps}`,
  );

  return {
    text: fullText,
    reasoningText: fullReasoning,
    steps,
    usage,
    metrics,
    responseMessages: buildStructuredResponseMessages(steps),
  };
}
