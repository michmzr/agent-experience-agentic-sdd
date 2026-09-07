import assert from 'node:assert/strict';
import test from 'node:test';

import { createCodexStreamingProjector } from '../src/review/adapters/codex-streaming-projector.js';

async function project(value: Buffer, size: number, diagnostics: unknown[] = []): Promise<unknown> {
  const projector = createCodexStreamingProjector({ sourceOrdinal: 7, diagnosticSink: (diagnostic) => { diagnostics.push(diagnostic); } });
  for (let start = 0; start < value.length; start += size) await projector.write(value.subarray(start, start + size));
  return projector.finish();
}

const timestamp = '2026-08-24T10:00:00.000Z';

test('projects observed messages consistently across chunk boundaries', async () => {
  const record = Buffer.from(`\r\n {"timestamp":"${timestamp}","type":"event_msg","payload":{"type":"user_message","message":"quoted \\"slash\\/ and \\uD83D\\uDE00 ż"}} \r\n`);
  const expected = { state: 'normalized', record: { kind: 'message', occurredAt: timestamp, text: 'quoted "slash/ and 😀 ż' }, truncatedTextFields: 0, omittedStructuredOutputs: 0 };
  for (const size of [1, 2, 7, 64 * 1024]) assert.deepEqual(await project(record, size), expected);
});

test('projects calls, string and structured output, technical records and unknown records', async () => {
  assert.deepEqual(await project(Buffer.from(JSON.stringify({ timestamp, type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: 'pnpm test' } })), 2), {
    state: 'normalized', record: { kind: 'tool', occurredAt: timestamp, tool: 'shell', text: 'pnpm test' }, truncatedTextFields: 0, omittedStructuredOutputs: 0
  });
  assert.deepEqual(await project(Buffer.from(JSON.stringify({ timestamp, type: 'response_item', payload: { type: 'function_call_output', output: ['private'] } })), 7), {
    state: 'normalized', record: { kind: 'tool', occurredAt: timestamp }, truncatedTextFields: 0, omittedStructuredOutputs: 1
  });
  assert.deepEqual(await project(Buffer.from(JSON.stringify({ timestamp, type: 'token_usage_record', payload: { secret: 'marker' } })), 1), { state: 'technical-skip' });
  const diagnostics: unknown[] = [];
  assert.deepEqual(await project(Buffer.from(JSON.stringify({ timestamp, type: 'future_record', payload: { secret: 'marker' } })), 64, diagnostics), {
    state: 'unsupported', diagnostic: { code: 'UNSUPPORTED_CODEX_RECORD', level: 'envelope', recordType: 'future_record', sourceOrdinal: 7 }
  });
  assert.deepEqual(diagnostics, [{ code: 'UNSUPPORTED_CODEX_RECORD', level: 'envelope', recordType: 'future_record', sourceOrdinal: 7 }]);
});

test('bounds retained text and never leaks discarded material', async () => {
  const marker = 'private-structured-output-marker';
  const result = await project(Buffer.from(JSON.stringify({ timestamp, type: 'response_item', payload: { type: 'function_call_output', output: { marker } } })), 1);
  assert.equal(JSON.stringify(result).includes(marker), false);
  const long = 'x'.repeat(4_097);
  assert.deepEqual(await project(Buffer.from(JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'agent_message', message: long } })), 64), {
    state: 'normalized', record: { kind: 'message', occurredAt: timestamp, text: 'x'.repeat(4_096) }, truncatedTextFields: 1, omittedStructuredOutputs: 0
  });
});

for (const [name, record] of [
  ['truncated JSON', '{"timestamp":"2026-08-24T10:00:00.000Z"'],
  ['invalid escape', '{"timestamp":"2026-08-24T10:00:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"\\q"}}'],
  ['trailing data', `${JSON.stringify({ timestamp, type: 'session_meta', payload: {} })} x`],
  ['depth 65', `${'{"timestamp":"2026-08-24T10:00:00.000Z","type":"session_meta","payload":'}${'['.repeat(64)}${']'.repeat(64)}}`],
  ['unsafe tool name', JSON.stringify({ timestamp, type: 'response_item', payload: { type: 'function_call', name: 'unsafe tool name' } })],
  ['oversized retained key', JSON.stringify({ timestamp, type: 'session_meta', payload: {}, ['x'.repeat(129)]: 1 })]
] as const) {
  test(`rejects ${name} without exposing input`, async () => {
    await assert.rejects(() => project(Buffer.from(record), 1), (error: unknown) => error instanceof Error && !error.message.includes('unsafe tool name'));
  });
}

test('rejects invalid UTF-8', async () => {
  await assert.rejects(() => project(Buffer.from([0x7b, 0xff, 0x7d]), 1));
});

test('consumes discarded large scalars and honors JSON last-member-wins semantics', async () => {
  const large = '9'.repeat(300);
  assert.deepEqual(await project(Buffer.from(`{"timestamp":"${timestamp}","type":"session_meta","discarded":${large},"payload":{}}`), 7), {
    state: 'normalized', record: { kind: 'metadata', occurredAt: timestamp }, truncatedTextFields: 0, omittedStructuredOutputs: 0
  });
  assert.deepEqual(await project(Buffer.from(`{"timestamp":"${timestamp}","type":"response_item","payload":{"type":"function_call_output","output":{},"output":"last"}}`), 2), {
    state: 'normalized', record: { kind: 'tool', occurredAt: timestamp, text: 'last' }, truncatedTextFields: 0, omittedStructuredOutputs: 0
  });
  await assert.rejects(() => project(Buffer.from(`{"timestamp":"${timestamp}","type":"session_meta","payload":{},"payload":[]}`), 1));
});

test('projects response messages and waits for unknown response diagnostics without retaining unknown text', async () => {
  assert.deepEqual(await project(Buffer.from(JSON.stringify({ timestamp, type: 'response_item', payload: { type: 'message', content: 'answer' } })), 1), {
    state: 'normalized', record: { kind: 'message', occurredAt: timestamp, text: 'answer' }, truncatedTextFields: 0, omittedStructuredOutputs: 0
  });
  let completed = false;
  const projector = createCodexStreamingProjector({ sourceOrdinal: 7, diagnosticSink: async () => { await Promise.resolve(); completed = true; } });
  await projector.write(Buffer.from(JSON.stringify({ timestamp, type: 'response_item', payload: { type: 'future', output: 'private-marker' } })));
  const result = await projector.finish();
  assert.equal(completed, true);
  assert.equal(JSON.stringify(result).includes('private-marker'), false);
  await assert.rejects(() => project(Buffer.from(`{"timestamp":"${timestamp}"\u00a0,"type":"session_meta","payload":{}}`), 1));
});

test('clears required fields when duplicate members replace a prior string', async () => {
  for (const record of [
    `{"timestamp":"${timestamp}","timestamp":null,"type":"session_meta","payload":{}}`,
    `{"timestamp":"${timestamp}","type":"session_meta","type":{},"payload":{}}`,
    `{"timestamp":"${timestamp}","type":"response_item","payload":{"type":"message","type":[],"content":"private"}}`
  ]) await assert.rejects(() => project(Buffer.from(record), 2));
});

test('consumes supported fields before a later subtype without materializing them', async () => {
  assert.deepEqual(await project(Buffer.from(`{"timestamp":"${timestamp}","type":"response_item","payload":{"content":"early answer","type":"message"}}`), 2), {
    state: 'normalized', record: { kind: 'message', occurredAt: timestamp }, truncatedTextFields: 0, omittedStructuredOutputs: 0
  });
  assert.deepEqual(await project(Buffer.from(`{"timestamp":"${timestamp}","type":"response_item","payload":{"name":"shell","arguments":"early args","type":"function_call"}}`), 2), {
    state: 'normalized', record: { kind: 'tool', occurredAt: timestamp, tool: 'shell' }, truncatedTextFields: 0, omittedStructuredOutputs: 0
  });
});

test('omits unsupported message blocks and preserves exact structured and unknown dispositions', async () => {
  assert.deepEqual(await project(Buffer.from(`{"timestamp":"${timestamp}","type":"response_item","payload":{"type":"message","content":[{"type":"image","text":"private-image"},{"type":"text","text":"kept"}]}}`), 1), {
    state: 'normalized', record: { kind: 'message', occurredAt: timestamp, text: 'kept' }, truncatedTextFields: 0, omittedStructuredOutputs: 0
  });
  assert.deepEqual(await project(Buffer.from(`{"timestamp":"${timestamp}","type":"response_item","payload":{"type":"function_call_output","output":{"marker":"private"}}}`), 7), {
    state: 'normalized', record: { kind: 'tool', occurredAt: timestamp }, truncatedTextFields: 0, omittedStructuredOutputs: 1
  });
  const diagnostics: unknown[] = [];
  assert.deepEqual(await project(Buffer.from(`{"timestamp":"${timestamp}","type":"response_item","payload":{"type":"future","output":"private"}}`), 1, diagnostics), {
    state: 'unsupported', diagnostic: { code: 'UNSUPPORTED_CODEX_RECORD', level: 'response-item', recordType: 'future', sourceOrdinal: 7 }
  });
  assert.deepEqual(diagnostics, [{ code: 'UNSUPPORTED_CODEX_RECORD', level: 'response-item', recordType: 'future', sourceOrdinal: 7 }]);
  assert.equal(JSON.stringify({ diagnostics }).includes('private'), false);
});

test('does not retain markers from an unsupported subtype or unsupported content block', async () => {
  const responseMarker = 'unknown-subtype-private-marker';
  const blockMarker = 'unsupported-block-private-marker';
  const diagnostics: unknown[] = [];
  const unknown = await project(Buffer.from(`{"timestamp":"${timestamp}","type":"response_item","payload":{"type":"future","output":"${responseMarker}"}}`), 1, diagnostics);
  const message = await project(Buffer.from(`{"timestamp":"${timestamp}","type":"response_item","payload":{"type":"message","content":[{"type":"image","text":"${blockMarker}"}]}}`), 1);
  assert.equal(JSON.stringify({ unknown, diagnostics, message }).includes(responseMarker), false);
  assert.equal(JSON.stringify({ unknown, diagnostics, message }).includes(blockMarker), false);
});

test('does not retain or truncate oversized unsupported content-block text', async () => {
  const marker = `image-block-private-marker-${'x'.repeat(4_200)}`;
  const result = await project(Buffer.from(`{"timestamp":"${timestamp}","type":"response_item","payload":{"type":"message","content":[{"type":"image","text":"${marker}"}]}}`), 1);
  assert.deepEqual(result, { state: 'normalized', record: { kind: 'message', occurredAt: timestamp }, truncatedTextFields: 0, omittedStructuredOutputs: 0 });
  assert.equal(JSON.stringify(result).includes(marker), false);
});

test('uses the final content-block type when duplicate members replace support', async () => {
  const result = await project(Buffer.from(`{"timestamp":"${timestamp}","type":"response_item","payload":{"type":"message","content":[{"type":"text","type":null,"text":"${'x'.repeat(4_097)}"}]}}`), 1);
  assert.deepEqual(result, { state: 'normalized', record: { kind: 'message', occurredAt: timestamp }, truncatedTextFields: 0, omittedStructuredOutputs: 0 });
});

test('uses the final content-block text when duplicate members replace a string', async () => {
  const result = await project(Buffer.from(`{"timestamp":"${timestamp}","type":"response_item","payload":{"type":"message","content":[{"type":"text","text":"private","text":null}]}}`), 1);
  assert.deepEqual(result, { state: 'normalized', record: { kind: 'message', occurredAt: timestamp }, truncatedTextFields: 0, omittedStructuredOutputs: 0 });
});

test('does not disclose discarded structured-output markers when later syntax is invalid', async () => {
  const marker = 'discarded-output-error-marker';
  await assert.rejects(() => project(Buffer.from(`{"timestamp":"${timestamp}","type":"response_item","payload":{"type":"function_call_output","output":{"marker":"${marker}"}} trailing`), 1), (error: unknown) => error instanceof Error && !error.message.includes(marker));
});

test('rejects trailing commas and latches parser failures', async () => {
  for (const record of [`{"timestamp":"${timestamp}","type":"session_meta","payload":{},}`, `{"timestamp":"${timestamp}","type":"session_meta","payload":[]}`.replace('[]}', '[1,]}')]) await assert.rejects(() => project(Buffer.from(record), 1));
  const projector = createCodexStreamingProjector({ sourceOrdinal: 7 });
  await assert.rejects(() => projector.write(Buffer.from('x')));
  await assert.rejects(() => projector.write(Buffer.from('}')));
  await assert.rejects(() => projector.finish());
});

test('classifies unsafe unknown type strings without retaining their values', async () => {
  for (const [type, payload] of [['unsafe type', '{}'], ['x'.repeat(129), '{}'], ['response_item', '{"type":"unsafe type"}']] as const) {
    const diagnostics: unknown[] = [];
    const result = await project(Buffer.from(`{"timestamp":"${timestamp}","type":"${type}","payload":${payload}}`), 1, diagnostics);
    assert.equal((result as { state: string }).state, 'unsupported');
    assert.equal(JSON.stringify({ result, diagnostics }).includes(type), false);
  }
});

test('clears truncation counts when a parent or discriminator replaces retained text', async () => {
  const long = 'x'.repeat(4_097);
  assert.deepEqual(await project(Buffer.from(`{"timestamp":"${timestamp}","type":"response_item","payload":{"type":"message","content":[{"type":"text","text":"${long}"}],"content":null}}`), 1), { state: 'normalized', record: { kind: 'message', occurredAt: timestamp }, truncatedTextFields: 0, omittedStructuredOutputs: 0 });
  assert.deepEqual(await project(Buffer.from(`{"timestamp":"${timestamp}","type":"event_msg","payload":{"type":"agent_message","message":"${long}","type":"future"}}`), 1), { state: 'normalized', record: { kind: 'message', occurredAt: timestamp }, truncatedTextFields: 0, omittedStructuredOutputs: 0 });
});

test('counts a final retained field after its supported discriminator changes', async () => {
  const long = 'x'.repeat(4_097);
  assert.deepEqual(await project(Buffer.from(`{"timestamp":"${timestamp}","type":"event_msg","payload":{"type":"agent_message","message":"${long}","type":"user_message"}}`), 1), { state: 'normalized', record: { kind: 'message', occurredAt: timestamp, text: 'x'.repeat(4_096) }, truncatedTextFields: 1, omittedStructuredOutputs: 0 });
});
