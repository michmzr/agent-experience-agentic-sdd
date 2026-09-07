import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSession, selectSessionArtifact } from '../src/review/contracts.js';

test('normalizes a selected local artifact without retaining its raw payload', () => {
  const session = normalizeSession({
    source: 'codex',
    artifact: { source: 'codex', id: 'session-1', location: '/fixture/session.jsonl', format: 'observed-jsonl', repositoryHint: '/repo' },
    records: [
      { kind: 'tool', occurredAt: '2026-08-24T10:00:00.000Z', tool: 'pnpm', exitStatus: 0, payload: 'token=top-secret' },
      { kind: 'message', occurredAt: '2026-08-24T10:01:00.000Z', payload: 'private prompt' }
    ]
  });

  assert.deepEqual(session, {
    source: 'codex', sessionId: 'session-1', repositoryHint: '/repo', startedAt: '2026-08-24T10:00:00.000Z', endedAt: '2026-08-24T10:01:00.000Z',
    events: [
      { id: 'session-1:0', kind: 'tool', occurredAt: '2026-08-24T10:00:00.000Z', tool: 'pnpm', exitStatus: 0, outcome: 'passed' },
      { id: 'session-1:1', kind: 'message', occurredAt: '2026-08-24T10:01:00.000Z', outcome: 'unknown' }
    ],
    ingestionCoverage: {
      totalRecords: 2,
      normalizedRecords: 2,
      skippedTechnicalRecords: 0,
      unsupportedRecords: 0,
      truncatedTextFields: 0,
      omittedStructuredOutputs: 0,
      usedStreamingProjection: false
    }
  });
  assert.equal(JSON.stringify(session).includes('top-secret'), false);
  assert.equal(JSON.stringify(session).includes('private prompt'), false);
});

test('requires an explicit artifact in non-interactive mode', () => {
  assert.throws(() => selectSessionArtifact([], { interactive: false }), /explicit session artifact/i);
});

test('rejects unsupported records without leaking their raw values', () => {
  assert.throws(
    () => normalizeSession({ source: 'cursor', artifact: { source: 'cursor', id: 'session-1', location: '/fixture/session.md', format: 'markdown-export' }, records: [{ kind: 'unknown', occurredAt: '2026-08-24T10:00:00.000Z', payload: 'sensitive-value' }] }),
    (error: unknown) => error instanceof Error && error.message.includes('Unsupported session record') && !error.message.includes('sensitive-value')
  );
});

test('uses supplied session bounds and source ordinals for retained records', () => {
  const session = normalizeSession({
    source: 'codex',
    artifact: { source: 'codex', id: 'tail', location: '/fixture/session.jsonl', format: 'observed-jsonl' },
    startedAt: '2026-09-04T10:00:00.000Z',
    endedAt: '2026-09-04T10:03:00.000Z',
    records: [
      { kind: 'message', occurredAt: '2026-09-04T10:01:00.000Z', sourceOrdinal: 41 },
      { kind: 'message', occurredAt: '2026-09-04T10:02:00.000Z', sourceOrdinal: 42 }
    ]
  });

  assert.equal(session.startedAt, '2026-09-04T10:00:00.000Z');
  assert.equal(session.endedAt, '2026-09-04T10:03:00.000Z');
  assert.deepEqual(session.events.map(({ id }) => id), ['tail:41', 'tail:42']);
});

test('accepts retained records in reverse chronological order when they are within supplied bounds', () => {
  const session = normalizeSession({
    source: 'codex',
    artifact: { source: 'codex', id: 'tail', location: '/fixture/session.jsonl', format: 'observed-jsonl' },
    startedAt: '2026-09-04T10:00:00.000Z',
    endedAt: '2026-09-04T10:03:00.000Z',
    records: [
      { kind: 'message', occurredAt: '2026-09-04T10:02:00.000Z', sourceOrdinal: 42 },
      { kind: 'message', occurredAt: '2026-09-04T10:01:00.000Z', sourceOrdinal: 41 }
    ]
  });

  assert.deepEqual(session.events.map(({ id }) => id), ['tail:42', 'tail:41']);
});

test('rejects incomplete, invalid, or non-containing supplied session bounds', () => {
  const input = {
    source: 'codex' as const,
    artifact: { source: 'codex' as const, id: 'session-1', location: '/fixture/session.jsonl', format: 'observed-jsonl' as const },
    records: [{ kind: 'message', occurredAt: '2026-09-04T10:01:00.000Z' }]
  };

  assert.throws(() => normalizeSession({ ...input, startedAt: '2026-09-04T10:00:00.000Z' }), /bounds/i);
  assert.throws(() => normalizeSession({ ...input, startedAt: '2026-09-04T10:03:00.000Z', endedAt: '2026-09-04T10:00:00.000Z' }), /bounds/i);
  assert.throws(() => normalizeSession({ ...input, startedAt: '2026-09-04T10:02:00.000Z', endedAt: '2026-09-04T10:03:00.000Z' }), /bounds/i);
  assert.throws(() => normalizeSession({ ...input, records: [{ kind: 'message', occurredAt: '2026-09-04T10:01:00.000Z', sourceOrdinal: -1 }] }), /ordinal/i);
});

test('rejects duplicate caller-supplied source ordinals', () => {
  assert.throws(() => normalizeSession({
    source: 'codex',
    artifact: { source: 'codex', id: 'session-1', location: '/fixture/session.jsonl', format: 'observed-jsonl' },
    records: [
      { kind: 'message', occurredAt: '2026-09-04T10:00:00.000Z', sourceOrdinal: 4 },
      { kind: 'message', occurredAt: '2026-09-04T10:01:00.000Z', sourceOrdinal: 4 }
    ]
  }), /ordinal/i);
});

test('enforces the aggregate review text limit in UTF-8 bytes', () => {
  assert.throws(() => normalizeSession({
    source: 'codex',
    artifact: { source: 'codex', id: 'session-1', location: '/fixture/session.jsonl', format: 'observed-jsonl' },
    records: [{ kind: 'message', occurredAt: '2026-09-04T10:00:00.000Z', text: 'ż'.repeat(131_073) }]
  }), /resource limit/i);
});
