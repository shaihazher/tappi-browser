#!/usr/bin/env node
/*
 * Parity regression checks for Codex/LiteLLM orchestration.
 *
 * Runs against built artifacts in dist/.
 */

const assert = require('node:assert/strict');
const path = require('node:path');

const llm = require(path.join(__dirname, '..', 'dist', 'llm-client.js'));

function testToLiteLLMMessagesPreservesStructuredToolHistory() {
  const messages = [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will inspect Gmail.' },
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'text',
          args: { grep: 'Morgan Stanley' },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'text',
          result: 'Morgan Stanley at Work eDelivery Notification',
        },
      ],
    },
  ];

  const mapped = llm.toLiteLLMMessages(messages);

  assert.equal(mapped.length, 2, 'should produce assistant + tool messages');
  assert.equal(mapped[0].role, 'assistant');
  assert.equal(mapped[0].tool_calls?.length, 1, 'assistant should include tool_calls');
  assert.equal(mapped[0].tool_calls?.[0]?.id, 'call_1');
  assert.equal(mapped[0].tool_calls?.[0]?.function?.name, 'text');
  assert.equal(mapped[1].role, 'tool', 'tool role should be preserved');
  assert.equal(mapped[1].tool_call_id, 'call_1');
  assert.ok(String(mapped[1].content).includes('Morgan Stanley'));
}

function testBuildStructuredResponseMessagesProducesAssistantAndToolEvents() {
  const steps = [
    {
      stepNumber: 0,
      finishReason: 'tool_calls',
      text: 'Opening email thread now.',
      reasoningText: '',
      toolIntent: true,
      retryNonStream: false,
      toolCalls: [
        {
          id: 'call_9',
          index: 0,
          name: 'click',
          argumentsText: '{"index":0}',
          args: { index: 0 },
        },
      ],
      toolResults: [
        {
          toolName: 'click',
          toolCallId: 'call_9',
          args: { index: 0 },
          output: 'Clicked inbox row',
          outputText: 'Clicked inbox row',
          success: true,
        },
      ],
    },
  ];

  const responseMessages = llm.buildStructuredResponseMessages(steps);
  assert.equal(responseMessages.length, 2, 'should synthesize assistant + tool message');

  const assistant = responseMessages[0];
  const tool = responseMessages[1];

  assert.equal(assistant.role, 'assistant');
  assert.ok(Array.isArray(assistant.content), 'assistant content should be structured array');
  assert.ok(assistant.content.some((p) => p.type === 'tool-call' && p.toolCallId === 'call_9'));

  assert.equal(tool.role, 'tool');
  assert.ok(Array.isArray(tool.content), 'tool content should be structured array');
  assert.ok(tool.content.some((p) => p.type === 'tool-result' && p.toolCallId === 'call_9'));
}

function main() {
  testToLiteLLMMessagesPreservesStructuredToolHistory();
  testBuildStructuredResponseMessagesProducesAssistantAndToolEvents();
  console.log('✅ parity-regression: all checks passed');
}

main();
