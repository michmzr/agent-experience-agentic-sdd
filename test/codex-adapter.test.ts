import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CodexSessionAdapter } from '../src/review/adapters/codex.js';

async function fixtureRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ael-codex-adapter-'));
}

test('discovers only regular observed JSONL artifacts below an injected root', async () => {
  const root = await fixtureRoot();
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'session.jsonl'), '{"kind":"metadata","occurredAt":"2026-08-24T10:00:00.000Z"}\n');
  await writeFile(join(root, 'nested', 'second.jsonl'), '{"kind":"message","occurredAt":"2026-08-24T10:01:00.000Z"}\n');
  await writeFile(join(root, 'notes.txt'), 'not a session');

  const artifacts = await new CodexSessionAdapter(root).discover();

  assert.deepEqual(artifacts.map((artifact) => ({ id: artifact.id, format: artifact.format })), [
    { id: 'nested/second.jsonl', format: 'observed-jsonl' },
    { id: 'session.jsonl', format: 'observed-jsonl' }
  ]);
});

test('normalizes known records while excluding raw payloads', async () => {
  const root = await fixtureRoot();
  await writeFile(
    join(root, 'session.jsonl'),
    '{"kind":"metadata","occurredAt":"2026-08-24T10:00:00.000Z","payload":"private-token"}\n{"kind":"tool","occurredAt":"2026-08-24T10:01:00.000Z","tool":"pnpm","exitStatus":0,"payload":{"arguments":"secret"}}\n'
  );

  const session = await new CodexSessionAdapter(root).read('session.jsonl');

  assert.equal(session.source, 'codex');
  assert.equal(session.sessionId, 'session.jsonl');
  assert.deepEqual(session.events, [
    { id: 'session.jsonl:0', kind: 'metadata', occurredAt: '2026-08-24T10:00:00.000Z', outcome: 'unknown' },
    { id: 'session.jsonl:1', kind: 'tool', occurredAt: '2026-08-24T10:01:00.000Z', tool: 'pnpm', exitStatus: 0, outcome: 'passed' }
  ]);
  assert.equal(JSON.stringify(session).includes('private-token'), false);
  assert.equal(JSON.stringify(session).includes('secret'), false);
});

test('normalizes allowlisted observed Codex transcript and tool evidence while excluding unrelated payload fields', async () => {
  const root = await fixtureRoot();
  const observedFixture = await readFile(
    join(process.cwd(), 'test/fixtures/session-review/observed-codex-session.jsonl'),
    'utf8'
  );
  await writeFile(join(root, 'session.jsonl'), observedFixture);

  const session = await new CodexSessionAdapter(root).read('session.jsonl');

  assert.deepEqual(session.events, [
    { id: 'session.jsonl:0', kind: 'metadata', occurredAt: '2026-08-24T10:00:00.000Z', outcome: 'unknown' },
    { id: 'session.jsonl:1', kind: 'metadata', occurredAt: '2026-08-24T10:00:01.000Z', outcome: 'unknown' },
    { id: 'session.jsonl:2', kind: 'message', occurredAt: '2026-08-24T10:00:02.000Z', text: 'private transcript', outcome: 'unknown' },
    { id: 'session.jsonl:3', kind: 'tool', occurredAt: '2026-08-24T10:00:03.000Z', tool: 'shell', text: 'private arguments', outcome: 'unknown' },
    { id: 'session.jsonl:4', kind: 'tool', occurredAt: '2026-08-24T10:00:04.000Z', text: 'private tool output', outcome: 'unknown' },
    { id: 'session.jsonl:5', kind: 'metadata', occurredAt: '2026-08-24T10:00:05.000Z', outcome: 'unknown' },
    { id: 'session.jsonl:6', kind: 'metadata', occurredAt: '2026-08-24T10:00:06.000Z', outcome: 'unknown' },
    { id: 'session.jsonl:7', kind: 'metadata', occurredAt: '2026-08-24T10:00:07.000Z', outcome: 'unknown' }
  ]);
  const serialized = JSON.stringify(session);
  for (const rawValue of ['private instructions', 'private compacted history', 'private agent', 'private world state']) {
    assert.equal(serialized.includes(rawValue), false);
  }
});

test('rejects a symlink or selection that escapes the injected root', async () => {
  const root = await fixtureRoot();
  const outside = await fixtureRoot();
  await writeFile(join(outside, 'outside.jsonl'), '{"kind":"metadata","occurredAt":"2026-08-24T10:00:00.000Z"}\n');
  await symlink(join(outside, 'outside.jsonl'), join(root, 'linked.jsonl'));
  await writeFile(join(root, 'inside.jsonl'), '{"kind":"metadata","occurredAt":"2026-08-24T10:00:00.000Z"}\n');
  const adapter = new CodexSessionAdapter(root);

  assert.deepEqual((await adapter.discover()).map((artifact) => artifact.id), ['inside.jsonl']);
  await assert.rejects(() => adapter.read('linked.jsonl'), /outside|symlink|selected session artifact/i);
  await assert.rejects(() => adapter.read('../outside.jsonl'), /outside|selected session artifact/i);
});

test('rejects unknown JSONL record kinds without including raw input in the error', async () => {
  const root = await fixtureRoot();
  await writeFile(join(root, 'session.jsonl'), '{"kind":"unrecognized","occurredAt":"2026-08-24T10:00:00.000Z","payload":"do-not-leak"}\n');

  await assert.rejects(
    () => new CodexSessionAdapter(root).read('session.jsonl'),
    (error: unknown) => error instanceof Error && /unsupported session record/i.test(error.message) && !error.message.includes('do-not-leak')
  );
});

test('rejects an unknown observed Codex envelope type without including its payload in the error', async () => {
  const root = await fixtureRoot();
  await writeFile(
    join(root, 'session.jsonl'),
    '{"timestamp":"2026-08-24T10:00:00.000Z","type":"unknown_observed_type","payload":{"message":"do-not-leak-observed"}}\n'
  );

  await assert.rejects(
    () => new CodexSessionAdapter(root).read('session.jsonl'),
    (error: unknown) => error instanceof Error
      && /unsupported session record/i.test(error.message)
      && !error.message.includes('do-not-leak-observed')
  );
});

test('retains the latest observed records with source ordinals while preserving full session bounds', async () => {
  const root = await fixtureRoot();
  const records = Array.from({ length: 1026 }, (_, index) => JSON.stringify({
    timestamp: timestampAt(index), type: 'session_meta', payload: {}
  }));
  await writeFile(join(root, 'session.jsonl'), records.join('\n'));

  const session = await new CodexSessionAdapter(root).read('session.jsonl');

  assert.equal(session.events.length, 1024);
  assert.equal(session.events[0]?.id, 'session.jsonl:2');
  assert.equal(session.events.at(-1)?.id, 'session.jsonl:1025');
  assert.equal(session.startedAt, timestampAt(0));
  assert.equal(session.endedAt, timestampAt(1025));
});

test('fails closed on an unsupported early observed record without leaking its payload', async () => {
  const root = await fixtureRoot();
  const marker = 'codex-unsupported-early-secret';
  const records = [
    JSON.stringify({ timestamp: timestampAt(0), type: 'unsupported', payload: { marker } }),
    ...Array.from({ length: 1025 }, (_, index) => JSON.stringify({ timestamp: timestampAt(index + 1), type: 'session_meta', payload: {} }))
  ];
  await writeFile(join(root, 'session.jsonl'), records.join('\n'));

  await assert.rejects(
    () => new CodexSessionAdapter(root).read('session.jsonl'),
    (error: unknown) => error instanceof Error && /unsupported session record/i.test(error.message) && !error.message.includes(marker)
  );
});

test('rejects an evicted noncanonical observed timestamp', async () => {
  const root = await fixtureRoot();
  const records = [
    JSON.stringify({ timestamp: '2026-08-24T10:00:00Z', type: 'session_meta', payload: {} }),
    ...Array.from({ length: 1025 }, (_, index) => JSON.stringify({ timestamp: timestampAt(index + 1), type: 'session_meta', payload: {} }))
  ];
  await writeFile(join(root, 'session.jsonl'), records.join('\n'));

  await assert.rejects(() => new CodexSessionAdapter(root).read('session.jsonl'), /timestamp is invalid/i);
});

function timestampAt(index: number): string {
  return new Date(Date.parse('2026-08-24T10:00:00.000Z') + index * 1_000).toISOString();
}
