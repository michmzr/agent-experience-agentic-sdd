import assert from 'node:assert/strict';
import test from 'node:test';

import { reconstructSessionEvidence } from '../src/evidence/reconstructor.js';
import type { SessionEvidenceInput } from '../src/evidence/contracts.js';

const base: SessionEvidenceInput = {
  schemaVersion: 1,
  source: 'codex',
  sessionId: 'session-1',
  startedAt: '2026-09-06T08:00:00.000Z',
  observations: []
};

test('correlates reordered request and result records only by explicit identity', () => {
  const report = reconstructSessionEvidence({
    ...base,
    observations: [
      {
        id: 'transport-result', sourceEventId: 'result-1', kind: 'result',
        occurredAt: '2026-09-06T08:00:02.000Z', relatedEventId: 'request-1',
        outcome: 'succeeded', exitStatus: 0
      },
      {
        id: 'transport-request', sourceEventId: 'request-1', kind: 'request',
        occurredAt: '2026-09-06T08:00:01.000Z', tool: 'shell'
      }
    ]
  });

  assert.equal(report.operations.length, 1);
  assert.deepEqual(report.operations[0], {
    id: report.operations[0]?.id,
    requestEvidenceId: 'transport-request',
    requestSourceEventId: 'request-1',
    resultEvidenceId: 'transport-result',
    tool: 'shell',
    startedAt: '2026-09-06T08:00:01.000Z',
    endedAt: '2026-09-06T08:00:02.000Z',
    durationMs: 1_000,
    processOutcome: 'succeeded',
    taskOutcome: 'unknown',
    outcome: 'process-succeeded'
  });
  assert.match(report.operations[0]!.id, /^op_[a-f0-9]{24}$/);
  assert.deepEqual(report.unmatchedEvidenceIds, []);
});

test('deduplicates equal evidence while rejecting conflicting transport identities', () => {
  const request = {
    id: 'same-transport', sourceEventId: 'request-1', kind: 'request' as const,
    occurredAt: '2026-09-06T08:00:01.000Z', tool: 'shell'
  };
  const report = reconstructSessionEvidence({ ...base, observations: [request, { ...request }] });
  assert.equal(report.operations.length, 1);
  assert.equal(report.coverage.duplicateObservations, 1);

  assert.throws(
    () => reconstructSessionEvidence({ ...base, observations: [request, { ...request, sourceEventId: 'request-2' }] }),
    /conflicting duplicate evidence identity/i
  );
});

test('does not pair records by repeated timestamps or adjacency', () => {
  const occurredAt = '2026-09-06T08:00:01.000Z';
  const report = reconstructSessionEvidence({
    ...base,
    observations: [
      { id: 'request-b-t', sourceEventId: 'request-b', kind: 'request', occurredAt, tool: 'git' },
      { id: 'orphan-t', sourceEventId: 'orphan', kind: 'result', occurredAt, relatedEventId: 'missing', outcome: 'failed' },
      { id: 'request-a-t', sourceEventId: 'request-a', kind: 'request', occurredAt, tool: 'shell' },
      { id: 'result-a-t', sourceEventId: 'result-a', kind: 'result', occurredAt, relatedEventId: 'request-a', outcome: 'succeeded' }
    ]
  });

  assert.deepEqual(report.operations.map(({ requestSourceEventId, resultEvidenceId }) => [requestSourceEventId, resultEvidenceId]), [
    ['request-a', 'result-a-t'],
    ['request-b', undefined]
  ]);
  assert.deepEqual(report.unmatchedEvidenceIds, ['orphan-t']);
});

test('distinguishes open, source-ended, reconciled-complete and incomplete views', () => {
  assert.equal(reconstructSessionEvidence(base).lifecycle.state, 'open');
  assert.equal(reconstructSessionEvidence({
    ...base,
    sourceEndedAt: '2026-09-06T08:10:00.000Z',
    reconciliation: { attempted: true, expectedThrough: 4, committedThrough: 3 }
  }).lifecycle.state, 'source-ended');
  assert.equal(reconstructSessionEvidence({
    ...base,
    sourceEndedAt: '2026-09-06T08:10:00.000Z',
    reconciliation: { attempted: true, expectedThrough: 4, committedThrough: 4 }
  }).lifecycle.state, 'reconciled-complete');
  const incomplete = reconstructSessionEvidence({
    ...base,
    observedThrough: '2026-09-06T08:10:00.000Z',
    reconciliation: { attempted: true }
  });
  assert.equal(incomplete.lifecycle.state, 'incomplete');
  assert.equal(incomplete.lifecycle.sourceEndedAt, undefined);
  assert.equal(incomplete.metrics.elapsedMs, undefined);
});

test('keeps missing results unknown and rejects invalid temporal or identity references', () => {
  const report = reconstructSessionEvidence({
    ...base,
    observations: [{
      id: 'request-only', sourceEventId: 'request-only', kind: 'request',
      occurredAt: '2026-09-06T08:01:00.000Z', tool: 'shell'
    }]
  });
  assert.equal(report.operations[0]?.outcome, 'unknown');
  assert.equal(report.operations[0]?.endedAt, undefined);

  assert.throws(() => reconstructSessionEvidence({
    ...base,
    observations: [{ id: 'bad', sourceEventId: 'bad', kind: 'request', occurredAt: 'not-a-time' }]
  }), /timestamp/i);
  assert.throws(() => reconstructSessionEvidence({
    ...base,
    observations: [{
      id: 'result', sourceEventId: 'result', kind: 'result',
      occurredAt: '2026-09-06T08:00:00.000Z', relatedEventId: 'result', outcome: 'failed'
    }]
  }), /related|request/i);
});
