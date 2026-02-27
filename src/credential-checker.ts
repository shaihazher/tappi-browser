/**
 * credential-checker.ts — Auto-detect credentials for cloud LLM providers.
 *
 * Checks environment variables, config files, and local services to determine
 * if credentials are available for Bedrock, Vertex, Azure, and Ollama.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface CredentialStatus {
  found: boolean;
  source: string;
  details: Record<string, string>;
  error?: string;
}

export interface OllamaModel {
  name: string;
  size: string;
  modified: string;
}

export interface OllamaStatus extends CredentialStatus {
  models?: OllamaModel[];
}

/**
 * Check AWS credentials for Bedrock.
 * Checks: env vars → ~/.aws/credentials → ~/.aws/config (SSO).
 */
export function checkBedrock(): CredentialStatus {
  // 1. Environment variables
  const accessKey = process.env.AWS_ACCESS_KEY_ID;
  const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;

  if (accessKey && secretKey) {
    return {
      found: true,
      source: 'Environment variables',
      details: {
        accessKeyId: maskKey(accessKey, 4, 3),
        region: region || '(not set — will use config default)',
        method: 'AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY',
      },
    };
  }

  // 2. ~/.aws/credentials file
  const credPath = path.join(os.homedir(), '.aws', 'credentials');
  if (fs.existsSync(credPath)) {
    try {
      const content = fs.readFileSync(credPath, 'utf-8');
      const profile = process.env.AWS_PROFILE || 'default';
      const profileRegex = new RegExp(`\\[${profile}\\]([\\s\\S]*?)(?=\\n\\[|$)`);
      const match = content.match(profileRegex);

      if (match) {
        const section = match[1];
        const keyMatch = section.match(/aws_access_key_id\s*=\s*(\S+)/);
        const secretMatch = section.match(/aws_secret_access_key\s*=\s*(\S+)/);

        if (keyMatch && secretMatch) {
          // Also check config file for region
          let configRegion = region;
          if (!configRegion) {
            const configPath = path.join(os.homedir(), '.aws', 'config');
            if (fs.existsSync(configPath)) {
              const configContent = fs.readFileSync(configPath, 'utf-8');
              const profileKey = profile === 'default' ? 'default' : `profile ${profile}`;
              const configRegex = new RegExp(`\\[${profileKey}\\]([\\s\\S]*?)(?=\\n\\[|$)`);
              const configMatch = configContent.match(configRegex);
              if (configMatch) {
                const regionMatch = configMatch[1].match(/region\s*=\s*(\S+)/);
                if (regionMatch) configRegion = regionMatch[1];
              }
            }
          }

          return {
            found: true,
            source: `~/.aws/credentials (profile: ${profile})`,
            details: {
              accessKeyId: maskKey(keyMatch[1], 4, 3),
              profile,
              region: configRegion || '(not set)',
              method: 'AWS credentials file',
            },
          };
        }
      }

      // Check for SSO config
      const configPath = path.join(os.homedir(), '.aws', 'config');
      if (fs.existsSync(configPath)) {
        const configContent = fs.readFileSync(configPath, 'utf-8');
        if (configContent.includes('sso_start_url') || configContent.includes('sso_session')) {
          return {
            found: true,
            source: '~/.aws/config (SSO)',
            details: {
              method: 'AWS SSO',
              note: 'SSO config found. Run `aws sso login` if session expired.',
            },
          };
        }
      }
    } catch (e: any) {
      return { found: false, source: '', details: {}, error: `Failed to read AWS credentials: ${e.message}` };
    }
  }

  return {
    found: false,
    source: '',
    details: {},
    error: 'No AWS credentials found. Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY env vars, or configure ~/.aws/credentials.',
  };
}

/**
 * Check Google ADC for Vertex AI.
 * Checks: GOOGLE_APPLICATION_CREDENTIALS env → gcloud ADC file.
 */
export function checkVertex(): CredentialStatus {
  // 1. GOOGLE_APPLICATION_CREDENTIALS env var (service account JSON)
  const credEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credEnv && fs.existsSync(credEnv)) {
    try {
      const cred = JSON.parse(fs.readFileSync(credEnv, 'utf-8'));
      return {
        found: true,
        source: 'GOOGLE_APPLICATION_CREDENTIALS',
        details: {
          type: cred.type || 'unknown',
          project: cred.project_id || '(not set)',
          clientEmail: cred.client_email ? maskEmail(cred.client_email) : '(not set)',
          method: 'Service account JSON',
        },
      };
    } catch (e: any) {
      return { found: false, source: '', details: {}, error: `Invalid service account JSON at ${credEnv}: ${e.message}` };
    }
  }

  // 2. gcloud Application Default Credentials
  const adcPath = path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
  if (fs.existsSync(adcPath)) {
    try {
      const adc = JSON.parse(fs.readFileSync(adcPath, 'utf-8'));
      return {
        found: true,
        source: 'gcloud ADC',
        details: {
          type: adc.type || 'authorized_user',
          account: adc.client_id ? maskKey(adc.client_id, 8, 4) : '(default)',
          method: 'gcloud auth application-default login',
          quotaProject: adc.quota_project_id || '(not set)',
        },
      };
    } catch (e: any) {
      return { found: false, source: '', details: {}, error: `Invalid ADC file: ${e.message}` };
    }
  }

  return {
    found: false,
    source: '',
    details: {},
    error: 'No Google credentials found. Run `gcloud auth application-default login` or set GOOGLE_APPLICATION_CREDENTIALS.',
  };
}

/**
 * Check Azure OpenAI credentials.
 * Checks: env vars for endpoint + API key.
 */
export function checkAzure(): CredentialStatus {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT || process.env.AZURE_OPENAI_BASE_URL;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;

  if (endpoint && apiKey) {
    return {
      found: true,
      source: 'Environment variables',
      details: {
        endpoint: endpoint,
        apiKey: maskKey(apiKey, 5, 4),
        method: 'AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY',
      },
    };
  }

  if (endpoint && !apiKey) {
    return {
      found: false,
      source: 'Partial',
      details: { endpoint },
      error: 'AZURE_OPENAI_ENDPOINT found but AZURE_OPENAI_API_KEY is missing.',
    };
  }

  if (!endpoint && apiKey) {
    return {
      found: false,
      source: 'Partial',
      details: { apiKey: maskKey(apiKey, 5, 4) },
      error: 'AZURE_OPENAI_API_KEY found but AZURE_OPENAI_ENDPOINT is missing.',
    };
  }

  return {
    found: false,
    source: '',
    details: {},
    error: 'No Azure OpenAI credentials found. Set AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY env vars, or enter them manually.',
  };
}

/**
 * Probe Ollama at localhost.
 */
export async function checkOllama(baseUrl?: string): Promise<OllamaStatus> {
  const url = baseUrl || 'http://localhost:11434';
  try {
    const resp = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) {
      return { found: false, source: url, details: {}, error: `Ollama responded with ${resp.status}` };
    }
    const data = await resp.json() as { models?: Array<{ name: string; size: number; modified_at: string }> };
    const models: OllamaModel[] = (data.models || []).map(m => ({
      name: m.name,
      size: formatBytes(m.size),
      modified: m.modified_at ? new Date(m.modified_at).toLocaleDateString() : 'unknown',
    }));

    return {
      found: true,
      source: url,
      details: {
        modelCount: String(models.length),
        url,
      },
      models,
    };
  } catch (e: any) {
    if (e.name === 'TimeoutError' || e.code === 'ECONNREFUSED' || e.cause?.code === 'ECONNREFUSED') {
      return { found: false, source: url, details: {}, error: `Ollama not running at ${url}. Start it with \`ollama serve\`.` };
    }
    return { found: false, source: url, details: {}, error: `Cannot reach Ollama at ${url}: ${e.message}` };
  }
}

/**
 * Check credentials for any provider.
 */
export async function checkCredentials(provider: string, options?: { ollamaUrl?: string }): Promise<CredentialStatus | OllamaStatus> {
  switch (provider) {
    case 'bedrock': return checkBedrock();
    case 'vertex': return checkVertex();
    case 'azure': return checkAzure();
    case 'ollama': return await checkOllama(options?.ollamaUrl);
    default: return { found: false, source: '', details: {}, error: `No auto-detection for ${provider}. Enter API key manually.` };
  }
}

/**
 * Test connection to a provider by making a minimal API call.
 */
export async function testConnection(provider: string, config: {
  apiKey?: string;
  model?: string;
  region?: string;
  projectId?: string;
  location?: string;
  endpoint?: string;
  baseUrl?: string;
}): Promise<{ success: boolean; message: string; model?: string }> {
  try {
    switch (provider) {
      case 'anthropic': {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': config.apiKey || '',
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: config.model || 'claude-sonnet-4-6',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok || resp.status === 200) {
          return { success: true, message: 'Connected to Anthropic API', model: config.model };
        }
        const err = await resp.json().catch(() => ({})) as any;
        return { success: false, message: err?.error?.message || `HTTP ${resp.status}` };
      }

      case 'openai-codex': {
        const token = config.apiKey || '';
        const accountId = extractChatgptAccountId(token);
        if (!accountId) {
          return { success: false, message: 'Invalid ChatGPT OAuth token. Please sign in again.' };
        }

        const configured = (config.baseUrl || '').trim();
        const baseUrl = configured || 'https://chatgpt.com/backend-api/codex';
        const normalized = baseUrl.replace(/\/+$/, '');
        const modelsUrl = normalized.endsWith('/codex')
          ? `${normalized}/models`
          : normalized.endsWith('/codex/v1')
            ? `${normalized.slice(0, -3)}/models`
            : normalized.replace(/\/responses$/, '/models');

        const resp = await fetch(modelsUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'chatgpt-account-id': accountId,
            'OpenAI-Beta': 'responses=experimental',
            'originator': 'codex_cli_rs',
          },
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
          return { success: true, message: 'Connected to OpenAI Codex (ChatGPT OAuth)' };
        }
        const err = await resp.json().catch(() => ({})) as any;
        return { success: false, message: err?.error?.message || `HTTP ${resp.status}` };
      }

      case 'openai':
      case 'openrouter': {
        const baseUrl = provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1';
        const resp = await fetch(`${baseUrl}/models`, {
          headers: { 'Authorization': `Bearer ${config.apiKey || ''}` },
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
          return { success: true, message: `Connected to ${provider === 'openrouter' ? 'OpenRouter' : 'OpenAI'} API` };
        }
        const err = await resp.json().catch(() => ({})) as any;
        return { success: false, message: err?.error?.message || `HTTP ${resp.status}` };
      }

      case 'google': {
        const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${config.apiKey || ''}`, {
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) return { success: true, message: 'Connected to Google Gemini API' };
        const err = await resp.json().catch(() => ({})) as any;
        return { success: false, message: err?.error?.message || `HTTP ${resp.status}` };
      }

      case 'ollama': {
        const url = config.baseUrl || 'http://localhost:11434';
        const resp = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
          const data = await resp.json() as { models?: Array<{ name: string }> };
          const modelCount = data.models?.length || 0;
          return { success: true, message: `Ollama running — ${modelCount} model${modelCount !== 1 ? 's' : ''} available` };
        }
        return { success: false, message: `Ollama responded with ${resp.status}` };
      }

      case 'bedrock': {
        // For Bedrock we rely on credential chain — just verify creds exist
        const credStatus = checkBedrock();
        if (credStatus.found) {
          return { success: true, message: `AWS credentials found via ${credStatus.source}` };
        }
        return { success: false, message: credStatus.error || 'No AWS credentials found' };
      }

      case 'vertex': {
        const credStatus = checkVertex();
        if (credStatus.found) {
          return { success: true, message: `Google ADC found via ${credStatus.source}` };
        }
        return { success: false, message: credStatus.error || 'No Google credentials found' };
      }

      case 'azure': {
        if (!config.endpoint && !config.apiKey) {
          const credStatus = checkAzure();
          if (credStatus.found) {
            return { success: true, message: `Azure OpenAI credentials found via ${credStatus.source}` };
          }
          return { success: false, message: credStatus.error || 'No Azure credentials found' };
        }
        // If manual credentials provided, try a models list call
        const endpoint = config.endpoint || process.env.AZURE_OPENAI_ENDPOINT || '';
        const key = config.apiKey || process.env.AZURE_OPENAI_API_KEY || '';
        if (!endpoint) return { success: false, message: 'Azure endpoint required' };
        const resp = await fetch(`${endpoint.replace(/\/$/, '')}/openai/models?api-version=2024-06-01`, {
          headers: { 'api-key': key },
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) return { success: true, message: 'Connected to Azure OpenAI' };
        return { success: false, message: `Azure responded with ${resp.status}` };
      }

      default:
        return { success: false, message: `Unknown provider: ${provider}` };
    }
  } catch (e: any) {
    if (e.name === 'TimeoutError') return { success: false, message: 'Connection timed out (10s)' };
    if (e.cause?.code === 'ECONNREFUSED') return { success: false, message: 'Connection refused — service not running' };
    return { success: false, message: e.message || 'Connection failed' };
  }
}

// ─── Helpers ───

function extractChatgptAccountId(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2 || !parts[1]) return null;
    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson) as Record<string, any>;
    const auth = payload?.['https://api.openai.com/auth'];
    const accountId = auth?.chatgpt_account_id;
    return typeof accountId === 'string' && accountId.length > 0 ? accountId : null;
  } catch {
    return null;
  }
}

function maskKey(key: string, showStart: number, showEnd: number): string {
  if (key.length <= showStart + showEnd) return key;
  return key.slice(0, showStart) + '•'.repeat(Math.min(8, key.length - showStart - showEnd)) + key.slice(-showEnd);
}

function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!domain) return maskKey(email, 3, 3);
  return maskKey(user, 2, 1) + '@' + domain;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}
