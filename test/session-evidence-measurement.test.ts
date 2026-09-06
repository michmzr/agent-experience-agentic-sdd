import assert from 'node:assert/strict';
import test from 'node:test';

import { sourceEvidenceCapabilities } from '../src/evidence/capabilities.js';
import { reconstructSessionEvidence } from '../src/evidence/reconstructor.js';
import type { SessionEvidenceInput } from '../src/evidence/contracts.js';

const input = (overrides: Partial<SessionEvidenceInput> = {}): SessionEvidenceInput => ({
  schemaVersion: 1,
  source: 'codex',
  sessionId: 'measure-session',
  startedAt: '2026-09-06T08:00:00.000Z',
  sourceEndedAt: '2026-09-06T08:01:00.000Z',
  observations: [],
  ...overrides
});

test('distinguishes command failure from successful process with failed task verification', () => {
  const report = reconstructSessionEvidence(input({
    observations: [
      { id: 'rq-1', sourceEventId: 'request-1', kind: 'request', occurredAt: '2026-09-06T08:00:01.000Z' },
      { id: 'rs-1', sourceEventId: 'result-1', kind: 'result', occurredAt: '2026-09-06T08:00:02.000Z', relatedEventId: 'request-1', outcome: 'failed', exitStatus: 2 },
      { id: 'rq-2', sourceEventId: 'request-2', kind: 'request', occurredAt: '2026-09-06T08:00:03.000Z' },
      { id: 'rs-2', sourceEventId: 'result-2', kind: 'result', occurredAt: '2026-09-06T08:00:05.000Z', relatedEventId: 'request-2', outcome: 'succeeded', exitStatus: 0 },
      { id: 'tv-2', sourceEventId: 'verify-2', kind: 'task-verification', occurredAt: '2026-09-06T08:00:06.000Z', relatedEventId: 'request-2', outcome: 'failed' },
      { id: 'rq-3', sourceEventId: 'request-3', kind: 'request', occurredAt: '2026-09-06T08:00:07.000Z' }
    ]
  }));

  assert.deepEqual(report.operations.map(({ outcome }) => outcome), [
    'command-failed', 'task-verification-failed', 'unknown'
  ]);
});

test('measures unioned active time and only explicitly observed human waiting', () => {
  const report = reconstructSessionEvidence(input({
    observations: [
      { id: 'rq-1', sourceEventId: 'request-1', kind: 'request', occurredAt: '2026-09-06T08:00:01.000Z' },
      { id: 'rs-1', sourceEventId: 'result-1', kind: 'result', occurredAt: '2026-09-06T08:00:05.000Z', relatedEventId: 'request-1', outcome: 'succeeded' },
      { id: 'rq-2', sourceEventId: 'request-2', kind: 'request', occurredAt: '2026-09-06T08:00:03.000Z' },
      { id: 'rs-2', sourceEventId: 'result-2', kind: 'result', occurredAt: '2026-09-06T08:00:08.000Z', relatedEventId: 'request-2', outcome: 'succeeded' },
      { id: 'wait-1', sourceEventId: 'wait-1', kind: 'human-wait', occurredAt: '2026-09-06T08:00:10.000Z', endedAt: '2026-09-06T08:00:20.000Z' },
      { id: 'wait-2', sourceEventId: 'wait-2', kind: 'human-wait', occurredAt: '2026-09-06T08:00:15.000Z', endedAt: '2026-09-06T08:00:25.000Z' }
    ]
  }));

  assert.equal(report.metrics.elapsedMs, 60_000);
  assert.equal(report.metrics.activeOperationMs, 7_000);
  assert.equal(report.metrics.observedWaitingMs, 15_000);
  assert.equal(report.metrics.attribution, 'observed-boundaries-only');
});

test('reconciles cumulative session usage without adding cache subsets or child totals', () => {
  const report = reconstructSessionEvidence(input({
    usageSnapshots: [
      { id: 'usage-parent-1', occurredAt: '2026-09-06T08:00:10.000Z', mode: 'cumulative', scope: 'session', lineageId: 'root', inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, analysisTokens: 5 },
      { id: 'usage-child', occurredAt: '2026-09-06T08:00:15.000Z', mode: 'cumulative', scope: 'subagent', lineageId: 'child', parentLineageId: 'root', inputTokens: 90, outputTokens: 10, cacheReadTokens: 30 },
      { id: 'usage-parent-2', occurredAt: '2026-09-06T08:00:20.000Z', mode: 'cumulative', scope: 'session', lineageId: 'root', inputTokens: 150, outputTokens: 35, cacheReadTokens: 60, analysisTokens: 8 }
    ]
  }));

  assert.deepEqual(report.metrics.tokenUsage, {
    inputTokens: 150,
    outputTokens: 35,
    cacheReadTokens: 60,
    analysisTokens: 8,
    source: 'source-provided'
  });
});

test('sums delta usage per independent lineage and keeps absent usage unavailable', () => {
  const measured = reconstructSessionEvidence(input({
    usageSnapshots: [
      { id: 'usage-a', occurredAt: '2026-09-06T08:00:10.000Z', mode: 'delta', scope: 'subagent', lineageId: 'child-a', inputTokens: 10, outputTokens: 3 },
      { id: 'usage-b', occurredAt: '2026-09-06T08:00:20.000Z', mode: 'delta', scope: 'subagent', lineageId: 'child-b', inputTokens: 12, outputTokens: 4, cacheReadTokens: 2 }
    ]
  }));
  assert.deepEqual(measured.metrics.tokenUsage, {
    inputTokens: 22, outputTokens: 7, cacheReadTokens: 2, source: 'source-provided'
  });
  assert.equal(reconstructSessionEvidence(input()).metrics.tokenUsage, undefined);
});

test('reports transport provenance, coverage gaps and source capabilities', () => {
  const report = reconstructSessionEvidence(input({
    transportMeasurements: [
      { id: 'transport-1', capturedAt: '2026-09-06T08:00:00.000Z', admittedAt: '2026-09-06T08:00:00.005Z', committedAt: '2026-09-06T08:00:00.025Z', hookDurationMs: 5 },
      { id: 'transport-2', capturedAt: '2026-09-06T08:00:01.000Z', admittedAt: '2026-09-06T08:00:01.006Z', committedAt: '2026-09-06T08:00:01.030Z', hookDurationMs: 6 }
    ],
    coverage: {
      supportedClasses: ['request', 'result'], skippedClasses: ['reasoning'],
      unsupportedClasses: ['private-state'], truncatedObservations: 2, synthetic: true
    }
  }));

  assert.deepEqual(report.metrics.hookDurationMs, { count: 2, total: 11, max: 6 });
  assert.deepEqual(report.metrics.spoolLagMs, { count: 2, total: 55, max: 30 });
  assert.deepEqual(report.coverage.skippedClasses, ['reasoning']);
  assert.equal(report.coverage.truncatedObservations, 2);
  assert.equal(report.coverage.synthetic, true);
  assert.equal(sourceEvidenceCapabilities.codex.correlation, 'explicit-reference');
  assert.equal(sourceEvidenceCapabilities.cursor.tokenUsage, 'unavailable');
});

test('rejects malformed usage and unrestricted secret-bearing fields without echoing values', () => {
  assert.throws(() => reconstructSessionEvidence(input({
    usageSnapshots: [{
      id: 'usage', occurredAt: '2026-09-06T08:00:01.000Z', mode: 'delta', scope: 'session',
      lineageId: 'root', inputTokens: 5, cacheReadTokens: 6
    }]
  })), /cache/i);
  assert.throws(() => reconstructSessionEvidence(input({
    usageSnapshots: [
      { id: 'usage-1', occurredAt: '2026-09-06T08:00:01.000Z', mode: 'cumulative', scope: 'session', lineageId: 'root', inputTokens: 10 },
      { id: 'usage-2', occurredAt: '2026-09-06T08:00:02.000Z', mode: 'cumulative', scope: 'session', lineageId: 'root', inputTokens: 9 }
    ]
  })), /cumulative.*decrease/i);

  const credential = 'token=must-not-appear';
  assert.throws(() => reconstructSessionEvidence(input({
    observations: [{
      id: 'request', sourceEventId: 'request', kind: 'request',
      occurredAt: '2026-09-06T08:00:01.000Z', rawOutput: credential
    } as never]
  })), (error: unknown) => error instanceof Error && /unsupported evidence observation field/i.test(error.message) && !error.message.includes(credential));
  assert.throws(() => reconstructSessionEvidence(input({
    observations: [{
      id: 'result', sourceEventId: 'result', kind: 'result', occurredAt: '2026-09-06T08:00:02.000Z',
      relatedEventId: 'request', outcome: 'succeeded', exitStatus: 1
    }]
  })), /exit status.*outcome/i);
});
