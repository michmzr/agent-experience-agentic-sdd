import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { SessionEvidenceInput } from '../src/evidence/contracts.js';
import { SessionEvidenceRepository } from '../src/evidence/repository.js';

function databasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'ael-evidence-history-')), 'experience.sqlite');
}

const input: SessionEvidenceInput = {
  schemaVersion: 1,
  source: 'codex',
  sessionId: 'history-session',
  startedAt: '2026-09-06T08:00:00.000Z',
  observations: [
    { id: 'request-t', sourceEventId: 'request-1', kind: 'request', occurredAt: '2026-09-06T08:00:01.000Z' },
    { id: 'result-t', sourceEventId: 'result-1', kind: 'result', occurredAt: '2026-09-06T08:00:02.000Z', relatedEventId: 'request-1', outcome: 'succeeded' }
  ]
};

test('returns the same immutable reconstruction version for equivalent repeated input', () => {
  const path = databasePath();
  const repository = new SessionEvidenceRepository(path, () => '2026-09-06T09:00:00.000Z');
  const first = repository.save(input);
  const repeated = repository.save({ ...input, observations: [...input.observations].reverse() });

  assert.equal(first.version, 1);
  assert.equal(repeated.version, 1);
  assert.deepEqual(repeated, first);
  assert.equal(repository.history(input.sessionId).length, 1);
  repository.close();
});

test('appends a late correction while preserving prior identities and historical views', () => {
  const path = databasePath();
  let timestamp = '2026-09-06T09:00:00.000Z';
  const repository = new SessionEvidenceRepository(path, () => timestamp);
  const first = repository.save({ ...input, observations: [input.observations[0]!] });
  const original = JSON.stringify(first);
  timestamp = '2026-09-06T09:01:00.000Z';
  const corrected = repository.save(input);

  assert.equal(corrected.version, 2);
  assert.equal(corrected.report.operations[0]?.id, first.report.operations[0]?.id);
  assert.equal(corrected.report.operations[0]?.resultEvidenceId, 'result-t');
  assert.equal(JSON.stringify(repository.history(input.sessionId)[0]), original);
  assert.deepEqual(repository.latest(input.sessionId), corrected);
  repository.close();

  const reopened = new SessionEvidenceRepository(path);
  assert.deepEqual(reopened.history(input.sessionId), [first, corrected]);
  reopened.close();
});

test('keeps sessions isolated and returns empty history for an unknown identity', () => {
  const repository = new SessionEvidenceRepository(databasePath(), () => '2026-09-06T09:00:00.000Z');
  repository.save(input);
  repository.save({ ...input, sessionId: 'other-session' });

  assert.equal(repository.history(input.sessionId).length, 1);
  assert.equal(repository.history('missing').length, 0);
  assert.equal(repository.latest('missing'), undefined);
  repository.close();
});
