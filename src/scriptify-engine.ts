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
import { createScript, getScript, updateScript, type Script, type AuthRequirement } from './script-store';
import { scriptifyViaCli, type CliAuthConfig } from './claude-code-provider';
import { getPasswordsForDomain } from './password-vault';
import { waitForPlaybookUpdate, getPlaybook, isDomainExcluded } from './domain-playbook';

// ─── Shared System Prompt ───

const SCRIPTIFY_SYSTEM_PROMPT = `You are a script generator. Analyze the conversation transcript below and extract a reusable, repeatable script/playbook.

Your task:
1. Identify the core repeatable workflow from the conversation
2. Classify the script type:
   - "automated": Deterministic workflows — generate an executable Python script that the agent will write to a file and run
   - "semi-automated": Hybrid — Python scripts for deterministic actions (scraping, data processing, API calls) combined with LLM reasoning prompts for analysis/decision steps
   - "playbook": Creative/orchestration tasks requiring agent judgment — Python scripts optional, use when beneficial
3. Extract variable inputs (things that would change between runs) vs constant values
4. Generate the script body appropriate to the type
5. Define an input schema for the variable parts

IMPORTANT — DISTILL LEARNINGS:
- Carefully trace the conversation for error→fix patterns. When something failed and was later corrected, use ONLY the corrected/working version in the script. Never reproduce code that was shown to fail.
- Tool results prefixed with [ERROR] indicate failures. Read the error, then find the subsequent fix in the conversation. Incorporate the fix directly into the generated script.
- For Python scripts: if an import failed and was replaced (e.g. \`playwright\` → \`subprocess\`), use the working import. If an API endpoint returned an error and was corrected, use the corrected endpoint. If data parsing failed and the format was adjusted, use the adjusted format.
- Add try/except error handling for failure modes discovered during the conversation. For example, if the conversation hit a timeout, add timeout handling. If an element wasn't found, add a retry or fallback.
- Skip failed attempts and retries entirely — only the final working approach belongs in the script.
- For browser automation: use descriptive element finding (not hardcoded selectors). If the conversation tried multiple selectors before finding one that works, use only the working selector strategy.
- Make the script general-purpose, not tied to specific values from this conversation.
- For automated and semi-automated scripts: generate clean, well-structured Python code with proper error handling (try/except), logging, and clear variable names.
- Use standard libraries where possible; note any pip dependencies in the description.
- The Python code will be written to a temp file and executed by the agent — ensure it is self-contained and runnable.
- For data-processing workflows (scraping, APIs, file operations): design Python scripts to accept a file_path input for bulk CSV/Excel data. The script should iterate over rows internally using pandas or csv module.
- When a script naturally operates on a single item, still use single-value {{placeholders}}.
- Include a file_path field (type: "file_path") in the inputSchema when designed for native bulk processing.

If domain playbooks are provided, incorporate their learnings (URL patterns, UI navigation sequences, workarounds, anti-patterns) directly into the generated script.

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
  "scriptBody": "For automated: a complete, executable Python script with {{field_name}} placeholders for variable inputs. For semi-automated: a mix of executable Python code blocks (for deterministic steps) and natural language reasoning prompts (for analysis steps), clearly delineated. For playbook: structured step-by-step playbook with phases; include Python code blocks where they add value."
}`;

// ─── Transcript Builder ───

/**
 * Builds a filtered and annotated transcript for scriptify analysis.
 * 1. Filters out 'thinking' role messages (internal reasoning adds noise)
 * 2. Annotates tool results that contain error signals with [ERROR] prefix
 */
function buildScriptifyTranscript(
  rows: Array<{ role: string; content: string; created_at: string }>
): string {
  // Filter out thinking messages — internal reasoning adds noise, not signal
  const filtered = rows.filter(r => r.role !== 'thinking');

  // Annotate tool results that contain error signals
  const annotated = filtered.map(r => {
    if (r.role === 'tool') {
      const hasError = /error|traceback|exception|failed|ENOENT|EACCES|ModuleNotFoundError|ImportError|TypeError|KeyError|IndexError|SyntaxError|ConnectionError|timeout/i.test(r.content);
      if (hasError) {
        return { ...r, content: `[ERROR] ${r.content}` };
      }
    }
    return r;
  });

  return annotated.map(r => `### ${r.role.toUpperCase()}\n${r.content}`).join('\n\n---\n\n');
}

// ─── Domain Extraction ───

function extractDomainsFromTranscript(
  rows: Array<{ role: string; content: string }>
): string[] {
  const domains = new Set<string>();
  const urlRegex = /https?:\/\/([a-zA-Z0-9.-]+)/g;

  for (const row of rows) {
    // Extract from "Navigated to:" tool results and general URLs
    let match;
    while ((match = urlRegex.exec(row.content)) !== null) {
      const domain = match[1].toLowerCase();
      if (!isDomainExcluded(domain)) {
        domains.add(domain);
      }
    }
  }

  return [...domains];
}

const SCRIPTIFY_ANALYSIS_PREFIX = 'Analyze this conversation transcript. Pay special attention to any errors, failures, or retries — the script you generate must incorporate the fixes and corrections discovered during the conversation, not reproduce the original bugs.';

function buildScriptifyUserMessage(
  transcript: string,
  additionalInstructions?: string,
  playbooks?: Array<{ domain: string; playbook: string }>,
): string {
  const parts = [SCRIPTIFY_ANALYSIS_PREFIX];
  if (playbooks && playbooks.length > 0) {
    const playbookSection = playbooks.map(
      p => `--- ${p.domain} ---\n${p.playbook}`
    ).join('\n\n');
    parts.push(`\n\nDOMAIN KNOWLEDGE (incorporate this into the generated script):\n${playbookSection}`);
  }
  if (additionalInstructions) {
    parts.push(`\nAdditional instructions from the user:\n${additionalInstructions}`);
  }
  parts.push(`\n\nTranscript:\n\n${transcript}`);
  return parts.join('');
}

// ─── Scriptify: Conversation → Script (Vercel AI SDK path) ───

export async function scriptifyConversation(
  conversationId: string,
  llmConfig: LLMConfig,
  additionalInstructions?: string,
): Promise<{ success: boolean; script?: { id: string; name: string; description: string }; error?: string }> {
  try {
    // Wait for any in-progress playbook update to finish
    await waitForPlaybookUpdate();

    // Load conversation messages
    const rows = getDb().prepare(
      `SELECT role, content, created_at FROM conversation_messages
       WHERE conversation_id = ? ORDER BY created_at ASC`
    ).all(conversationId) as Array<{ role: string; content: string; created_at: string }>;

    if (!rows.length) {
      return { success: false, error: 'No messages found in this conversation.' };
    }

    // Build transcript (filtered + annotated)
    const transcript = buildScriptifyTranscript(rows);

    // Extract domains and fetch playbooks
    const extractedDomains = extractDomainsFromTranscript(rows);
    const playbooks: Array<{ domain: string; playbook: string }> = [];
    for (const domain of extractedDomains) {
      const pb = getPlaybook(domain);
      if (pb) playbooks.push({ domain, playbook: pb.playbook });
    }

    // Merge domains from auth requirements
    const allDomains = new Set(extractedDomains);

    const model = createModel(llmConfig);
    const providerOptions = buildProviderOptions(llmConfig);

    const result = await generateText({
      model,
      providerOptions,
      messages: [
        { role: 'system', content: SCRIPTIFY_SYSTEM_PROMPT },
        { role: 'user', content: buildScriptifyUserMessage(transcript, additionalInstructions, playbooks.length > 0 ? playbooks : undefined) },
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

    // Merge auth requirement domains into allDomains
    if (Array.isArray(parsed.authRequirements)) {
      for (const req of parsed.authRequirements) {
        if (req.domain) allDomains.add(req.domain);
      }
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
      domains: allDomains.size > 0 ? [...allDomains] : undefined,
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
  auth?: CliAuthConfig,
  additionalInstructions?: string,
): Promise<{ success: boolean; script?: { id: string; name: string; description: string }; error?: string }> {
  try {
    // Wait for any in-progress playbook update to finish
    await waitForPlaybookUpdate();

    // Load conversation messages
    const rows = getDb().prepare(
      `SELECT role, content, created_at FROM conversation_messages
       WHERE conversation_id = ? ORDER BY created_at ASC`
    ).all(conversationId) as Array<{ role: string; content: string; created_at: string }>;

    if (!rows.length) {
      return { success: false, error: 'No messages found in this conversation.' };
    }

    // Build transcript (filtered + annotated)
    const filteredRows = rows.filter(r => r.role !== 'thinking');
    let transcript = buildScriptifyTranscript(rows);

    // Extract domains and fetch playbooks
    const extractedDomains = extractDomainsFromTranscript(rows);
    const playbooks: Array<{ domain: string; playbook: string }> = [];
    for (const domain of extractedDomains) {
      const pb = getPlaybook(domain);
      if (pb) playbooks.push({ domain, playbook: pb.playbook });
    }

    const allDomains = new Set(extractedDomains);

    // Validate transcript has meaningful user/assistant content
    const hasConversation = filteredRows.some(r => r.role === 'user' || r.role === 'assistant');
    if (!hasConversation || !transcript.trim()) {
      return {
        success: false,
        error: 'Conversation has no user or assistant messages to analyze.',
      };
    }

    // Cap transcript length to avoid exceeding CLI input limits
    const MAX_TRANSCRIPT_CHARS = 50_000;
    if (transcript.length > MAX_TRANSCRIPT_CHARS) {
      // Rebuild from filtered rows, taking the last N that fit
      const parts: string[] = [];
      let totalLen = 0;
      for (let i = filteredRows.length - 1; i >= 0; i--) {
        const r = filteredRows[i];
        const hasError = r.role === 'tool' && /error|traceback|exception|failed|ENOENT|EACCES|ModuleNotFoundError|ImportError|TypeError|KeyError|IndexError|SyntaxError|ConnectionError|timeout/i.test(r.content);
        const content = hasError ? `[ERROR] ${r.content}` : r.content;
        const part = `### ${r.role.toUpperCase()}\n${content}`;
        if (totalLen + part.length + 5 > MAX_TRANSCRIPT_CHARS && parts.length > 0) break;
        parts.unshift(part);
        totalLen += part.length + 5;
      }
      transcript = parts.join('\n\n---\n\n');
    }

    // Call CLI — inject playbook knowledge into the user message via additionalInstructions
    let enrichedInstructions = additionalInstructions || '';
    if (playbooks.length > 0) {
      const playbookSection = playbooks.map(
        p => `--- ${p.domain} ---\n${p.playbook}`
      ).join('\n\n');
      enrichedInstructions = `DOMAIN KNOWLEDGE (incorporate this into the generated script):\n${playbookSection}\n\n${enrichedInstructions}`;
    }

    const result = await scriptifyViaCli(transcript, SCRIPTIFY_SYSTEM_PROMPT, auth, enrichedInstructions || undefined);

    if ('error' in result) {
      return { success: false, error: result.error };
    }
    const parsed = result.data;

    // Validate required fields
    if (!parsed.name || !parsed.scriptBody || !parsed.scriptType) {
      return { success: false, error: 'Generated script is missing required fields.' };
    }

    // Merge auth requirement domains
    if (Array.isArray(parsed.authRequirements)) {
      for (const req of parsed.authRequirements) {
        if (req.domain) allDomains.add(req.domain);
      }
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
      domains: allDomains.size > 0 ? [...allDomains] : undefined,
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

// ─── Script Update Prompt ───

const SCRIPT_UPDATE_PROMPT = `You are a script updater. You will receive an existing script definition as JSON and user instructions describing changes to make.

Your task:
1. Apply the user's requested changes to the script
2. Preserve all parts of the script that the user did NOT ask to change
3. Return the full updated script in the same JSON schema

IMPORTANT:
- Keep the same scriptType unless the user explicitly asks to change it
- Preserve existing input fields unless the user asks to modify them
- If adding new inputs, follow the existing inputSchema format
- Maintain the same level of detail and quality in the scriptBody
- For automated and semi-automated scripts: scriptBody should contain executable Python code with proper error handling, logging, and clear variable names
- Use standard libraries where possible; note any pip dependencies in the description
- Keep authRequirements unchanged unless the user specifically mentions auth changes
- If the user asks to add bulk/batch support, prefer making the script accept a file_path input and iterate over CSV rows internally (script-native bulk) rather than relying on the system to repeat execution per row

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
  "scriptBody": "For automated: a complete, executable Python script with {{field_name}} placeholders. For semi-automated: a mix of executable Python code blocks and reasoning prompts. For playbook: structured step-by-step playbook with optional Python code blocks."
}`;

// ─── Update Script Definition ───

export async function updateScriptDefinition(
  scriptId: string,
  instructions: string,
  llmConfig: LLMConfig,
  cliAuth?: CliAuthConfig,
): Promise<{ success: boolean; script?: { id: string; name: string; description: string }; error?: string }> {
  try {
    const existing = getScript(scriptId);
    if (!existing) {
      return { success: false, error: 'Script not found.' };
    }

    // Serialize current script as JSON context
    const scriptContext = JSON.stringify({
      name: existing.name,
      description: existing.description,
      scriptType: existing.scriptType,
      inputSchema: existing.inputSchema,
      scriptBody: existing.scriptBody,
      authRequirements: existing.authRequirements || [],
    }, null, 2);

    const userContent = `Existing script:\n${scriptContext}\n\nUser instructions:\n${instructions}`;

    let parsed: any;

    if (llmConfig.provider === 'claude-code') {
      // CLI path for OAuth/Bedrock
      const cliResult = await scriptifyViaCli(userContent, SCRIPT_UPDATE_PROMPT, cliAuth);
      if ('error' in cliResult) {
        return { success: false, error: cliResult.error };
      }
      parsed = cliResult.data;
    } else {
      // SDK path for all other providers
      const model = createModel(llmConfig);
      const providerOptions = buildProviderOptions(llmConfig);

      const result = await generateText({
        model,
        providerOptions,
        messages: [
          { role: 'system', content: SCRIPT_UPDATE_PROMPT },
          { role: 'user', content: userContent },
        ],
        maxOutputTokens: 4096,
      });

      let text = result.text.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      try {
        parsed = JSON.parse(text);
      } catch {
        return { success: false, error: 'Failed to parse script update response. Please try again.' };
      }
    }

    // Validate required fields
    if (!parsed.name || !parsed.scriptBody || !parsed.scriptType) {
      return { success: false, error: 'Updated script is missing required fields.' };
    }

    // Save updates
    const updated = updateScript(scriptId, {
      name: parsed.name,
      description: parsed.description || '',
      scriptType: parsed.scriptType,
      inputSchema: parsed.inputSchema || { fields: [] },
      scriptBody: parsed.scriptBody,
      authRequirements: Array.isArray(parsed.authRequirements) && parsed.authRequirements.length > 0
        ? parsed.authRequirements
        : undefined,
    });

    if (!updated) {
      return { success: false, error: 'Failed to save updated script.' };
    }

    return {
      success: true,
      script: { id: updated.id, name: updated.name, description: updated.description },
    };
  } catch (err: any) {
    console.error('[scriptify] update error:', err);
    return { success: false, error: err.message || 'Script update failed.' };
  }
}

// ─── Auto-Reconcile Script Fixes (Post-Execution) ───

const RECONCILE_PROMPT = `You are a script learning extractor. You receive:
1. The ORIGINAL script definition (the scriptBody stored in the DB)
2. The input values used for this run
3. The full execution log (tool results + agent's final summary)

IMPORTANT CONTEXT:
- The scriptBody is a set of instructions that may contain inline Python code
- During execution, the LLM extracted the Python code, wrote it to a .py file, ran it, and debugged any failures
- Fixes were applied to the .py file, NOT to the scriptBody
- Your job: incorporate those fixes back into the scriptBody's inline Python code
- For non-Python scripts (playbooks): incorporate any learnings about better approaches,
  corrected steps, or improved instructions

RULES:
- Preserve {{placeholder}} syntax for ALL input variables
- For Python fixes: update the inline Python code within the scriptBody to match the working version
- For playbook learnings: update step instructions, add warnings, correct URLs/parameters
- Do NOT change the overall structure or intent of the script
- Only incorporate genuine improvements, not run-specific details
- If nothing meaningful changed, return the original scriptBody unchanged

Respond with ONLY a JSON object (no markdown fences):
{
  "scriptBody": "the updated script body",
  "summary": "brief description of what was learned/fixed",
  "changed": true/false
}`;

/**
 * Auto-reconcile script fixes after execution.
 * Called structurally (not by agent) when errors were detected during script execution.
 * Extracts the fix from the conversation and persists the corrected scriptBody.
 */
export async function reconcileScriptFix(
  scriptId: string,
  inputs: Record<string, any>,
  conversationEvents: Array<{ role: string; content: string }>,
  agentResponse: string,
  llmConfig: LLMConfig,
  cliAuth?: CliAuthConfig,
): Promise<{ success: boolean; summary?: string; error?: string }> {
  const script = getScript(scriptId);
  if (!script) return { success: false, error: 'Script not found' };

  // Build context: original script + inputs + error/fix conversation
  const inputMapping = Object.entries(inputs)
    .map(([k, v]) => `  {{${k}}} = ${JSON.stringify(v)}`)
    .join('\n');

  // Extract tool results (where errors and fixes are visible) — cap to avoid exceeding context
  const relevantEvents = conversationEvents
    .filter(e => e.role === 'tool')
    .map(e => e.content)
    .join('\n\n')
    .slice(0, 30_000);

  const userContent = [
    'ORIGINAL SCRIPT BODY (with {{placeholders}}):',
    script.scriptBody,
    '',
    'INPUT VALUES used for this run:',
    inputMapping || '  (no inputs)',
    '',
    'EXECUTION LOG (tool results):',
    relevantEvents,
    '',
    'AGENT SUMMARY (what the agent reported):',
    agentResponse.slice(0, 5_000) || '(no summary)',
  ].join('\n');

  // Make LLM call (same dual-path as updateScriptDefinition)
  let parsed: any;
  try {
    if (llmConfig.provider === 'claude-code') {
      const cliResult = await scriptifyViaCli(userContent, RECONCILE_PROMPT, cliAuth);
      if ('error' in cliResult) return { success: false, error: cliResult.error };
      parsed = cliResult.data;
    } else {
      const model = createModel(llmConfig);
      const providerOptions = buildProviderOptions(llmConfig);
      const result = await generateText({
        model,
        providerOptions,
        messages: [
          { role: 'system', content: RECONCILE_PROMPT },
          { role: 'user', content: userContent },
        ],
        maxOutputTokens: 16_384,
      });
      let text = result.text.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      try {
        parsed = JSON.parse(text);
      } catch {
        return { success: false, error: 'Failed to parse reconciliation response' };
      }
    }
  } catch (llmErr: any) {
    return { success: false, error: `LLM call failed: ${llmErr?.message}` };
  }

  if (!parsed?.scriptBody) return { success: false, error: 'No scriptBody in reconciliation response' };

  // Trust the LLM's changed field first (handles whitespace normalization)
  if (parsed.changed === false) {
    return { success: false, error: 'No meaningful changes detected' };
  }

  // Sanity check: the reconciled body should still contain all original placeholders
  const originalPlaceholders = [...script.scriptBody.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
  const reconciledPlaceholders = [...parsed.scriptBody.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
  const missingPlaceholders = originalPlaceholders.filter(p => !reconciledPlaceholders.includes(p));
  if (missingPlaceholders.length > 0) {
    return { success: false, error: `Reconciled body lost placeholders: ${missingPlaceholders.join(', ')}` };
  }

  // Secondary check: don't update if the text is literally identical
  if (parsed.scriptBody.trim() === script.scriptBody.trim()) {
    return { success: false, error: 'No changes detected — script body unchanged' };
  }

  // Persist the fix
  const updated = updateScript(scriptId, { scriptBody: parsed.scriptBody });
  if (!updated) return { success: false, error: 'Failed to save updated script' };

  console.log(`[scriptify] Auto-reconciled script ${scriptId}: ${parsed.summary || 'fixes applied'}`);
  return { success: true, summary: parsed.summary || 'Bug fixes applied' };
}

// ─── Playbook Reconciliation ───

const PLAYBOOK_RECONCILE_PROMPT = `You are a script updater. You receive:
1. An existing scriptBody (with {{placeholder}} variables)
2. Updated domain playbook knowledge for a specific domain

Your job: update the scriptBody to incorporate the new playbook knowledge while preserving:
- ALL {{placeholder}} variables exactly as they appear
- The overall structure and intent of the script
- All existing functionality

WHAT TO UPDATE:
- URL patterns: if the playbook shows correct paths, update hardcoded URLs
- Navigation sequences: if the playbook describes better click sequences, update them
- Workarounds: if the playbook describes workarounds for known issues, add them
- Anti-patterns: if the playbook warns against certain approaches used in the script, fix them

RULES:
- Preserve ALL {{placeholder}} syntax for input variables
- Do NOT change the script's purpose or overall structure
- Only make changes directly informed by the playbook knowledge
- If the playbook knowledge doesn't apply to this script, return unchanged

Respond with ONLY a JSON object (no markdown fences):
{
  "scriptBody": "the updated script body",
  "summary": "brief description of what was updated",
  "changed": true/false
}`;

export async function reconcileScriptWithPlaybook(
  scriptId: string,
  domain: string,
  newPlaybook: string,
  llmConfig: LLMConfig,
  cliAuth?: CliAuthConfig,
): Promise<{ success: boolean; summary?: string; error?: string }> {
  const script = getScript(scriptId);
  if (!script) return { success: false, error: 'Script not found' };

  const userContent = [
    'EXISTING SCRIPT BODY (with {{placeholders}}):',
    script.scriptBody,
    '',
    `UPDATED PLAYBOOK FOR ${domain}:`,
    newPlaybook,
  ].join('\n');

  let parsed: any;
  try {
    if (llmConfig.provider === 'claude-code') {
      const cliResult = await scriptifyViaCli(userContent, PLAYBOOK_RECONCILE_PROMPT, cliAuth);
      if ('error' in cliResult) return { success: false, error: cliResult.error };
      parsed = cliResult.data;
    } else {
      const model = createModel(llmConfig);
      const providerOptions = buildProviderOptions(llmConfig);
      const result = await generateText({
        model,
        providerOptions,
        messages: [
          { role: 'system', content: PLAYBOOK_RECONCILE_PROMPT },
          { role: 'user', content: userContent },
        ],
        maxOutputTokens: 16_384,
      });
      let text = result.text.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      try {
        parsed = JSON.parse(text);
      } catch {
        return { success: false, error: 'Failed to parse playbook reconciliation response' };
      }
    }
  } catch (llmErr: any) {
    return { success: false, error: `LLM call failed: ${llmErr?.message}` };
  }

  if (!parsed?.scriptBody) return { success: false, error: 'No scriptBody in reconciliation response' };

  if (parsed.changed === false) {
    return { success: false, error: 'No meaningful changes from playbook' };
  }

  // Validate placeholders preserved
  const originalPlaceholders = [...script.scriptBody.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
  const reconciledPlaceholders = [...parsed.scriptBody.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
  const missingPlaceholders = originalPlaceholders.filter(p => !reconciledPlaceholders.includes(p));
  if (missingPlaceholders.length > 0) {
    return { success: false, error: `Reconciled body lost placeholders: ${missingPlaceholders.join(', ')}` };
  }

  if (parsed.scriptBody.trim() === script.scriptBody.trim()) {
    return { success: false, error: 'No changes detected — script body unchanged' };
  }

  const updated = updateScript(scriptId, { scriptBody: parsed.scriptBody });
  if (!updated) return { success: false, error: 'Failed to save updated script' };

  console.log(`[scriptify] Playbook-reconciled script ${scriptId} for ${domain}: ${parsed.summary || 'playbook applied'}`);
  return { success: true, summary: parsed.summary || 'Playbook knowledge applied' };
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
    }
    // session: skip — can't verify browser session from main process, let it fail at runtime
    // either without creds: skip — session might be active, can't verify from here
  }

  return {
    satisfied: missing.length === 0,
    missing,
  };
}

// ─── Build Execution Prompt ───

export function buildExecutionPrompt(script: Script, inputs: Record<string, any> | Record<string, any>[], specialInstructions?: string): string {
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

  // Persist-fix guidance for scripts with Python code
  const persistFixGuidance = (script.scriptType === 'automated' || script.scriptType === 'semi-automated')
    ? '\n\nIf any code in this script fails during execution, fix the error and re-run. If the fix is a genuine bug correction (not a one-off environment issue), use the script_persist_fix tool to save the corrected code for future runs.'
    : '';

  if (isBulk) {
    const rows = inputs as Record<string, any>[];
    const bulkHeader = `You are executing the script "${script.name}" in bulk mode for ${rows.length} inputs.\n\n` +
      `Process each row sequentially. For each row, substitute the input values into the script template below, ` +
      `write to a temp file, execute with python3, and report the result before moving to the next row.\n\n`;

    const scriptTemplate = `SCRIPT TEMPLATE:\n${script.scriptBody}\n`;

    const inputRows = rows.map((row, i) =>
      `Row ${i + 1}: ${JSON.stringify(row)}`
    ).join('\n');
    const inputSection = `\nINPUT ROWS (substitute into {{placeholders}} in the template for each row):\n${inputRows}`;

    const bulkPrompt = bulkHeader + authPreamble + getTypeInstructions(script.scriptType) + persistFixGuidance +
      '\n\n' + scriptTemplate + inputSection;
    return specialInstructions ? bulkPrompt + `\n\nADDITIONAL INSTRUCTIONS FOR THIS RUN:\n${specialInstructions}` : bulkPrompt;
  }

  // Single execution
  const singleInputs = inputs as Record<string, any>;
  const resolvedBody = substituteInputs(script.scriptBody, singleInputs);

  // If any input value looks like a CSV/Excel file path, hint the agent to process all rows
  const hasFilePathInput = Object.values(singleInputs).some(
    val => typeof val === 'string' && /\.(csv|xlsx|xls)$/i.test(val)
  );
  const filePathHint = hasFilePathInput
    ? '\n\nThis script receives a file path as input. The file may contain multiple rows of data. Process all rows in the file — do not stop after the first row.'
    : '';

  const singlePrompt = `You are executing the script "${script.name}".\n\n${authPreamble}${getTypeInstructions(script.scriptType)}${persistFixGuidance}${filePathHint}\n\n${resolvedBody}`;
  return specialInstructions ? singlePrompt + `\n\nADDITIONAL INSTRUCTIONS FOR THIS RUN:\n${specialInstructions}` : singlePrompt;
}

function getTypeInstructions(scriptType: string): string {
  switch (scriptType) {
    case 'automated':
      return 'This script contains Python code. Write it to a temporary file and execute it with `python3`. If the script fails, read the error traceback, fix the code, and re-run. Report the final output.';
    case 'semi-automated':
      return 'This script contains Python code blocks for deterministic steps and reasoning prompts for analysis steps. For Python blocks: write to a temp file and execute with `python3`. For reasoning steps: think through the results and decide the best course of action. If any code fails, fix and re-run.';
    case 'playbook':
      return 'Follow this playbook step by step. Use your judgment for creative and orchestration decisions. Execute any embedded Python code blocks as needed. Ensure quality at each phase before proceeding to the next.';
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
