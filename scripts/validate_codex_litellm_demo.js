#!/usr/bin/env node

/**
 * Validation harness for codex LiteLLM runtime.
 *
 * Uses a deterministic fetch mock to simulate LiteLLM chat-completions stream +
 * non-stream fallback behavior, including fragmented tool-call deltas.
 */

const { runLiteLLMCodexToolLoop } = require('../dist/llm-client.js');
const { z } = require('zod');

const scenarioPlans = {
  normal: [
    { type: 'tool', name: 'tool_navigate', args: { query: 'houston hvac' } },
    { type: 'tool', name: 'tool_extract', args: { selector: '#results' } },
    { type: 'tool', name: 'tool_transform', args: { format: 'json' } },
    { type: 'tool', name: 'tool_finalize', args: { note: 'normal-finished' } },
    { type: 'stop', text: 'Normal mode complete.' },
  ],
  research: [
    { type: 'tool', name: 'search_sources', args: { query: 'market trends' } },
    { type: 'empty-tool-intent' }, // Forces non-stream retry once.
    { type: 'tool', name: 'read_source', args: { url: 'https://example.com/report' } },
    { type: 'tool', name: 'compile_report', args: { path: 'report.md' } },
    { type: 'tool', name: 'present_download', args: { path: 'report.md' } },
    { type: 'stop', text: 'Research mode complete.' },
  ],
  coding: [
    { type: 'tool', name: 'list_files', args: { path: '.' } },
    { type: 'tool', name: 'edit_file', args: { path: 'src/app.ts', patch: 'add lite runtime' } },
    { type: 'tool', name: 'run_tests', args: { command: 'npm test' } },
    { type: 'tool', name: 'file_write', args: { path: 'changes.md', content: 'done' } },
    { type: 'tool', name: 'present_download', args: { path: 'changes.md' } },
    { type: 'stop', text: 'Coding mode complete.' },
  ],
};

const scenarioState = {
  normal: { streamStep: 0, pendingRetryStep: 0 },
  research: { streamStep: 0, pendingRetryStep: 0 },
  coding: { streamStep: 0, pendingRetryStep: 0 },
};

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(events) {
  const encoder = new TextEncoder();
  const chunks = events.map((event) => {
    const data = typeof event === 'string' ? event : JSON.stringify(event);
    return encoder.encode(`data: ${data}\n\n`);
  });

  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function detectScenario(messages) {
  if (!Array.isArray(messages)) return null;
  for (const msg of messages) {
    const content = typeof msg?.content === 'string' ? msg.content : '';
    const match = content.match(/\[SCENARIO:(normal|research|coding)\]/);
    if (match) return match[1];
  }
  return null;
}

function buildToolCallEvents(callId, name, args) {
  const argsJson = JSON.stringify(args);
  const argSplit = Math.max(1, Math.floor(argsJson.length / 2));
  const nameSplit = Math.max(1, Math.floor(name.length / 2));

  return [
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: 'function',
                function: {
                  name: name.slice(0, nameSplit),
                  arguments: argsJson.slice(0, argSplit),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  name: name.slice(nameSplit),
                  arguments: argsJson.slice(argSplit),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    },
    '[DONE]',
  ];
}

function buildStopEvents(text) {
  return [
    {
      choices: [
        {
          index: 0,
          delta: { content: text },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 },
    },
    '[DONE]',
  ];
}

function buildEmptyToolIntentEvents() {
  return [
    {
      choices: [
        {
          index: 0,
          delta: { content: '' },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    },
    '[DONE]',
  ];
}

global.fetch = async (_url, init = {}) => {
  const body = JSON.parse(init.body || '{}');
  const scenario = detectScenario(body.messages);
  if (!scenario) {
    throw new Error('Mock fetch could not detect scenario marker in request messages.');
  }

  const state = scenarioState[scenario];
  const plan = scenarioPlans[scenario];

  if (body.stream) {
    state.streamStep += 1;
    const stepIndex = state.streamStep - 1;
    const step = plan[stepIndex];

    if (!step) {
      return sseResponse(buildStopEvents(`${scenario} fallback stop.`));
    }

    if (step.type === 'tool') {
      return sseResponse(buildToolCallEvents(`${scenario}_call_${state.streamStep}`, step.name, step.args));
    }

    if (step.type === 'empty-tool-intent') {
      state.pendingRetryStep = state.streamStep;
      return sseResponse(buildEmptyToolIntentEvents());
    }

    return sseResponse(buildStopEvents(step.text));
  }

  // Non-stream fallback for empty tool-intent recovery.
  if (scenario === 'research' && state.pendingRetryStep > 0) {
    state.pendingRetryStep = 0;
    return jsonResponse({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'research_retry_call',
                type: 'function',
                function: {
                  name: 'open_source',
                  arguments: JSON.stringify({ url: 'https://example.com/retry-source' }),
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
    });
  }

  return jsonResponse({
    choices: [
      {
        finish_reason: 'stop',
        message: { role: 'assistant', content: `${scenario} non-stream fallback stop` },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
};

function buildTools() {
  const names = new Set();
  for (const plan of Object.values(scenarioPlans)) {
    for (const step of plan) {
      if (step.type === 'tool') names.add(step.name);
    }
  }
  names.add('open_source'); // used in research non-stream recovery

  const tools = {};
  for (const name of names) {
    tools[name] = {
      description: `Mock tool ${name}`,
      inputSchema: z.object({}).passthrough(),
      execute: async (args) => `OK:${name}:${JSON.stringify(args)}`,
    };
  }
  return tools;
}

async function runScenario(name, tools) {
  scenarioState[name].streamStep = 0;
  scenarioState[name].pendingRetryStep = 0;

  const result = await runLiteLLMCodexToolLoop({
    config: {
      provider: 'openai-codex',
      model: 'gpt-5.3-codex',
      apiKey: 'mock-oauth-token',
      thinking: true,
    },
    system: 'You are a reliable codex runtime.',
    messages: [{ role: 'user', content: `[SCENARIO:${name}] execute multi-step task` }],
    tools,
    maxSteps: 20,
    providerOptions: { openai: { reasoningEffort: 'high' } },
    logPrefix: `validation.${name}`,
  });

  const checks = {
    minToolCalls: result.metrics.toolCalls >= 4,
    zeroToolFailures: result.metrics.toolCallFailures === 0,
    zeroUnresolvedEmptyIntent: result.metrics.unresolvedEmptyToolIntentSteps === 0,
  };

  for (const [checkName, ok] of Object.entries(checks)) {
    if (!ok) {
      throw new Error(`${name} failed check ${checkName}: ${JSON.stringify(result.metrics)}`);
    }
  }

  return {
    scenario: name,
    steps: result.metrics.steps,
    toolCalls: result.metrics.toolCalls,
    retries: result.metrics.emptyToolIntentRetries,
    unresolved: result.metrics.unresolvedEmptyToolIntentSteps,
    failures: result.metrics.toolCallFailures,
    textLen: result.text.length,
  };
}

async function main() {
  const tools = buildTools();

  const runs = [];
  runs.push(await runScenario('normal', tools));
  runs.push(await runScenario('research', tools));
  runs.push(await runScenario('coding', tools));

  console.log('\nValidation summary:');
  for (const run of runs) {
    console.log(
      `- ${run.scenario}: steps=${run.steps}, toolCalls=${run.toolCalls}, retries=${run.retries}, unresolved=${run.unresolved}, failures=${run.failures}, textLen=${run.textLen}`,
    );
  }

  const totalFailures = runs.reduce((sum, r) => sum + r.failures + r.unresolved, 0);
  console.log(`\nTotal unresolved tool-call failures: ${totalFailures}`);

  if (totalFailures !== 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Validation failed:', err?.stack || err?.message || err);
  process.exit(1);
});
