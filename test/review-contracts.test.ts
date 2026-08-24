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
    ]
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
