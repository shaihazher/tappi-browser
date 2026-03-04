/**
 * scriptify-engine.ts — Conversation analysis, script generation, and execution orchestration.
 *
 * Three main functions:
 * A) scriptifyConversation() — analyzes a conversation via Vercel AI SDK and generates a reusable script
 * B) scriptifyConversationViaCli() — analyzes a conversation via Claude Code CLI (for OAuth/Bedrock users)
 * C) buildExecutionPrompt() — constructs an execution prompt from a script + inputs
 * D) parseBulkFile() — parses CSV/Excel files for bulk script execution
 * E) validateAuthRequirements() — checks if auth requirements are satisfied
 */

import { generateText } from 'ai';
import { createModel, buildProviderOptions, type LLMConfig } from './llm-client';
import { getDb } from './database';
import { createScript, getScript, type Script, type AuthRequirement } from './script-store';
import { scriptifyViaCli } from './claude-code-provider';
import { getPasswordsForDomain } from './password-vault';

// ─── Shared System Prompt ───

const SCRIPTIFY_SYSTEM_PROMPT = `You are a script generator. Analyze the conversation transcript below and extract a reusable, repeatable script/playbook.

Your task:
1. Identify the core repeatable workflow from the conversation
2. Classify the script type:
   - "automated": Deterministic tool-call sequences (scraping, form-filling, file operations)
   - "semi-automated": Tool calls mixed with LLM reasoning on intermediate results
   - "playbook": Creative/orchestration tasks requiring agent judgment
3. Extract variable inputs (things that would change between runs) vs constant values
4. Generate the script body appropriate to the type
5. Define an input schema for the variable parts

IMPORTANT:
- Only include SUCCESSFUL tool-call sequences (skip failed attempts and retries)
- For browser automation: use descriptive element finding (not hardcoded selectors)
- Include error handling guidance
- Make the script general-purpose, not tied to specific values from this conversation

Also identify any domains that required authentication during the conversation.
Include an "authRequirements" array in your JSON output:
[{ "domain": "github.com", "description": "GitHub login for repo access", "authType": "either" }]
Auth types: "credentials" (standard username/password), "session" (SSO/OAuth/intranet — user must log in manually), "either" (both work).
If no auth needed, use an empty array [].

Respond with ONLY a JSON object (no markdown fences, no explanation):
{
  "name": "Short descriptive name for the script",
  "description": "1-2 sentence description of what this script does",
  "scriptType": "automated" | "semi-automated" | "playbook",
  "inputSchema": {
    "fields": [
      {
        "name": "field_name",
        "type": "string" | "number" | "boolean" | "file_path" | "url" | "select",
        "required": true/false,
        "description": "What this field is for",
        "placeholder": "Example value",
        "options": ["only", "for", "select", "type"],
        "default": "optional default value"
      }
    ]
  },
  "authRequirements": [],
  "scriptBody": "The full script content as a string. For automated: step-by-step instructions referencing {{field_name}} placeholders. For semi-automated: hybrid steps mixing deterministic actions and reasoning prompts. For playbook: structured step-by-step playbook with phases."
}`;

// ─── Scriptify: Conversation → Script (Vercel AI SDK path) ───

export async function scriptifyConversation(
  conversationId: string,
  llmConfig: LLMConfig,
): Promise<{ success: boolean; script?: { id: string; name: string; description: string }; error?: string }> {
  try {
    // Load conversation messages
    const rows = getDb().prepare(
      `SELECT role, content, created_at FROM conversation_messages
       WHERE conversation_id = ? ORDER BY created_at ASC`
    ).all(conversationId) as Array<{ role: string; content: string; created_at: string }>;

    if (!rows.length) {
      return { success: false, error: 'No messages found in this conversation.' };
    }

    // Build transcript
    const transcript = rows.map(r => `### ${r.role.toUpperCase()}\n${r.content}`).join('\n\n---\n\n');

    const model = createModel(llmConfig);
    const providerOptions = buildProviderOptions(llmConfig);

    const result = await generateText({
      model,
      providerOptions,
      messages: [
        { role: 'system', content: SCRIPTIFY_SYSTEM_PROMPT },
        { role: 'user', content: `Here is the conversation transcript to analyze:\n\n${transcript}` },
      ],
      maxOutputTokens: 4096,
    });

    // Parse LLM response
    let parsed: any;
    try {
      let text = result.text.trim();
      // Strip markdown code fences if present
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      parsed = JSON.parse(text);
    } catch (parseErr) {
      return { success: false, error: 'Failed to parse script generation response. Please try again.' };
    }

    // Validate required fields
    if (!parsed.name || !parsed.scriptBody || !parsed.scriptType) {
      return { success: false, error: 'Generated script is missing required fields.' };
    }

    // Store the script
    const script = createScript({
      name: parsed.name,
      description: parsed.description || '',
      scriptType: parsed.scriptType,
      inputSchema: parsed.inputSchema || { fields: [] },
      scriptBody: parsed.scriptBody,
      sourceConversationId: conversationId,
      authRequirements: Array.isArray(parsed.authRequirements) && parsed.authRequirements.length > 0
        ? parsed.authRequirements
        : undefined,
    });

    return {
      success: true,
      script: { id: script.id, name: script.name, description: script.description },
    };
  } catch (err: any) {
    console.error('[scriptify] generation error:', err);
    return { success: false, error: err.message || 'Script generation failed.' };
  }
}

// ─── Scriptify: Conversation → Script (CLI path for OAuth/Bedrock users) ───

export async function scriptifyConversationViaCli(
  conversationId: string,
  apiKey?: string,
): Promise<{ success: boolean; script?: { id: string; name: string; description: string }; error?: string }> {
  try {
    // Load conversation messages
    const rows = getDb().prepare(
      `SELECT role, content, created_at FROM conversation_messages
       WHERE conversation_id = ? ORDER BY created_at ASC`
    ).all(conversationId) as Array<{ role: string; content: string; created_at: string }>;

    if (!rows.length) {
      return { success: false, error: 'No messages found in this conversation.' };
    }

    // Build transcript
    const transcript = rows.map(r => `### ${r.role.toUpperCase()}\n${r.content}`).join('\n\n---\n\n');

    // Call CLI
    const parsed = await scriptifyViaCli(transcript, SCRIPTIFY_SYSTEM_PROMPT, apiKey);

    if (!parsed) {
      return { success: false, error: 'Script generation via CLI failed. Check that Claude Code is installed and authenticated.' };
    }

    // Validate required fields
    if (!parsed.name || !parsed.scriptBody || !parsed.scriptType) {
      return { success: false, error: 'Generated script is missing required fields.' };
    }

    // Store the script
    const script = createScript({
      name: parsed.name,
      description: parsed.description || '',
      scriptType: parsed.scriptType,
      inputSchema: parsed.inputSchema || { fields: [] },
      scriptBody: parsed.scriptBody,
      sourceConversationId: conversationId,
      authRequirements: Array.isArray(parsed.authRequirements) && parsed.authRequirements.length > 0
        ? parsed.authRequirements
        : undefined,
    });

    return {
      success: true,
      script: { id: script.id, name: script.name, description: script.description },
    };
  } catch (err: any) {
    console.error('[scriptify] CLI generation error:', err);
    return { success: false, error: err.message || 'Script generation failed.' };
  }
}

// ─── Auth Requirement Validation ───

export function validateAuthRequirements(authRequirements?: AuthRequirement[]): {
  satisfied: boolean;
  missing: Array<{ domain: string; description: string; authType: string; hasStoredCredentials: boolean }>;
} {
  if (!authRequirements || authRequirements.length === 0) {
    return { satisfied: true, missing: [] };
  }

  const missing: Array<{ domain: string; description: string; authType: string; hasStoredCredentials: boolean }> = [];

  for (const req of authRequirements) {
    const hasCreds = getPasswordsForDomain(req.domain).length > 0;

    if (req.authType === 'credentials' && !hasCreds) {
      // Credentials required but not stored — block
      missing.push({ domain: req.domain, description: req.description, authType: req.authType, hasStoredCredentials: false });
    } else if (req.authType === 'session') {
      // Session-based auth — can't verify from main process, flag as warning
      missing.push({ domain: req.domain, description: req.description, authType: req.authType, hasStoredCredentials: hasCreds });
    } else if (req.authType === 'either' && !hasCreds) {
      // Either works — flag as warning if no stored credentials
      missing.push({ domain: req.domain, description: req.description, authType: req.authType, hasStoredCredentials: false });
    }
  }

  return {
    satisfied: missing.length === 0,
    missing,
  };
}

// ─── Build Execution Prompt ───

export function buildExecutionPrompt(script: Script, inputs: Record<string, any> | Record<string, any>[]): string {
  const isBulk = Array.isArray(inputs);

  // Substitute placeholders in script body
  function substituteInputs(body: string, values: Record<string, any>): string {
    let result = body;
    for (const [key, val] of Object.entries(values)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(val ?? ''));
    }
    return result;
  }

  // Build auth preamble if auth requirements exist
  let authPreamble = '';
  if (script.authRequirements && script.authRequirements.length > 0) {
    const authLines: string[] = ['AUTHENTICATION NOTES:'];
    for (const req of script.authRequirements) {
      if (req.authType === 'credentials') {
        authLines.push(`- ${req.domain}: Use stored credentials if you encounter a login page.`);
      } else if (req.authType === 'session') {
        authLines.push(`- ${req.domain}: The user should be logged in. If you see a login page, STOP and inform the user that they need to log in to ${req.domain} first.`);
      } else if (req.authType === 'either') {
        authLines.push(`- ${req.domain}: Try stored credentials first; if unavailable, STOP and ask the user to log in.`);
      }
    }
    authPreamble = authLines.join('\n') + '\n\n';
  }

  if (isBulk) {
    const rows = inputs as Record<string, any>[];
    const header = `You are executing the script "${script.name}" in bulk mode for ${rows.length} inputs.\n\nProcess each row sequentially and report results for each.\n\n`;

    const rowPrompts = rows.map((row, i) => {
      const resolved = substituteInputs(script.scriptBody, row);
      return `--- Row ${i + 1} of ${rows.length} ---\nInputs: ${JSON.stringify(row)}\n\n${resolved}`;
    }).join('\n\n');

    return header + authPreamble + getTypeInstructions(script.scriptType) + '\n\n' + rowPrompts;
  }

  // Single execution
  const resolvedBody = substituteInputs(script.scriptBody, inputs as Record<string, any>);
  return `You are executing the script "${script.name}".\n\n${authPreamble}${getTypeInstructions(script.scriptType)}\n\n${resolvedBody}`;
}

function getTypeInstructions(scriptType: string): string {
  switch (scriptType) {
    case 'automated':
      return 'Execute the following steps sequentially. Use the appropriate tools for each step. If a step fails, report the error and attempt to fix it before continuing.';
    case 'semi-automated':
      return 'Follow these steps. For deterministic steps, use tools directly. For analysis/reasoning steps, think through the intermediate results and decide the best course of action.';
    case 'playbook':
      return 'Follow this playbook step by step. Use your judgment for creative and orchestration decisions. Ensure quality at each phase before proceeding to the next.';
    default:
      return 'Follow the instructions below.';
  }
}

// ─── Bulk File Parsing ───

export async function parseBulkFile(
  scriptId: string,
  fileData: Buffer,
  filename: string,
): Promise<{ success: boolean; rows?: Record<string, any>[]; errors?: string[]; totalRows?: number; validCount?: number; headers?: string[] }> {
  try {
    const script = getScript(scriptId);
    if (!script) {
      return { success: false, errors: ['Script not found.'] };
    }

    const ext = filename.toLowerCase().split('.').pop();
    let csvText: string;

    if (ext === 'xlsx' || ext === 'xls') {
      // Convert Excel to CSV
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(fileData, { type: 'buffer' });
      const firstSheet = workbook.SheetNames[0];
      csvText = XLSX.utils.sheet_to_csv(workbook.Sheets[firstSheet]);
    } else if (ext === 'csv') {
      csvText = fileData.toString('utf-8');
    } else {
      return { success: false, errors: [`Unsupported file type: .${ext}. Use .csv, .xlsx, or .xls.`] };
    }

    // Parse CSV
    const Papa = await import('papaparse');
    const parseResult = Papa.default.parse(csvText, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h: string) => h.trim(),
    });

    if (parseResult.errors.length > 0) {
      const errorMessages = parseResult.errors.slice(0, 5).map(
        (e: any) => `Row ${e.row}: ${e.message}`
      );
      return { success: false, errors: errorMessages };
    }

    const headers = parseResult.meta.fields || [];
    const requiredFields = script.inputSchema.fields.filter(f => f.required).map(f => f.name);

    // Validate headers contain required fields
    const missingHeaders = requiredFields.filter(f => !headers.includes(f));
    if (missingHeaders.length > 0) {
      return {
        success: false,
        errors: [`Missing required columns: ${missingHeaders.join(', ')}`],
        headers,
      };
    }

    // Validate rows
    const errors: string[] = [];
    const validRows: Record<string, any>[] = [];

    for (let i = 0; i < parseResult.data.length; i++) {
      const row = parseResult.data[i] as Record<string, any>;
      const rowErrors: string[] = [];

      for (const field of script.inputSchema.fields) {
        if (field.required && (!row[field.name] || String(row[field.name]).trim() === '')) {
          rowErrors.push(`Missing required field "${field.name}"`);
        }
        // Type coercion
        if (row[field.name] !== undefined && row[field.name] !== '') {
          if (field.type === 'number') {
            const num = Number(row[field.name]);
            if (isNaN(num)) {
              rowErrors.push(`"${field.name}" must be a number`);
            } else {
              row[field.name] = num;
            }
          } else if (field.type === 'boolean') {
            row[field.name] = ['true', '1', 'yes'].includes(String(row[field.name]).toLowerCase());
          }
        }
      }

      if (rowErrors.length > 0) {
        errors.push(`Row ${i + 1}: ${rowErrors.join('; ')}`);
      } else {
        validRows.push(row);
      }
    }

    return {
      success: true,
      rows: validRows,
      errors: errors.length > 0 ? errors : undefined,
      totalRows: parseResult.data.length,
      validCount: validRows.length,
      headers,
    };
  } catch (err: any) {
    console.error('[scriptify] bulk parse error:', err);
    return { success: false, errors: [err.message || 'Failed to parse file.'] };
  }
}
