import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatSafeRecordType,
  freezeIngestionCoverage,
  validateIngestionCoverage,
  type SessionIngestionCoverage
} from '../src/review/ingestion.js';
import { normalizeSession } from '../src/review/contracts.js';
import { SanitizationError, sanitizeForReview } from '../src/review/sanitizer.js';

const coverage = {
  totalRecords: 4,
  normalizedRecords: 2,
  skippedTechnicalRecords: 1,
  unsupportedRecords: 1,
  truncatedTextFields: 0,
  omittedStructuredOutputs: 1,
  usedStreamingProjection: true
} as const;

const input = {
  source: 'codex' as const,
  artifact: { source: 'codex' as const, id: 'coverage', location: '/fixture/coverage.jsonl', format: 'observed-jsonl' as const },
  records: [{ kind: 'message', occurredAt: '2026-09-07T10:00:00.000Z', text: 'safe' }]
};

test('preserves immutable aggregate ingestion coverage through normalization and sanitization', () => {
  const normalized = normalizeSession({ ...input, ingestionCoverage: coverage });
  const artifact = sanitizeForReview(normalized);

  assert.deepEqual(normalized.ingestionCoverage, coverage);
  assert.deepEqual(artifact.session.ingestionCoverage, coverage);
  assert.notEqual(normalized.ingestionCoverage, coverage);
  assert.notEqual(artifact.session.ingestionCoverage, normalized.ingestionCoverage);
  assert.equal(Object.isFrozen(normalized.ingestionCoverage), true);
  assert.equal(Object.isFrozen(artifact.session.ingestionCoverage), true);
  assert.throws(() => {
    (artifact.session.ingestionCoverage as { totalRecords: number }).totalRecords = 99;
  }, TypeError);
});

test('derives complete coverage when normalization callers do not provide it', () => {
  const normalized = normalizeSession(input);

  assert.deepEqual(normalized.ingestionCoverage, {
    totalRecords: 1,
    normalizedRecords: 1,
    skippedTechnicalRecords: 0,
    unsupportedRecords: 0,
    truncatedTextFields: 0,
    omittedStructuredOutputs: 0,
    usedStreamingProjection: false
  });
});

test('formats only bounded display-safe record types', () => {
  assert.equal(formatSafeRecordType('future.record/v1'), 'future.record/v1');
  assert.equal(formatSafeRecordType('unsafe record type'), 'unprintable');
  assert.equal(formatSafeRecordType('x'.repeat(129)), 'unprintable');
});

test('validates and freezes only safe complete coverage counters', () => {
  const frozen = freezeIngestionCoverage(coverage);

  assert.deepEqual(validateIngestionCoverage(coverage), coverage);
  assert.notEqual(frozen, coverage);
  assert.equal(Object.isFrozen(frozen), true);
});

for (const [name, invalid] of [
  ['negative counter', { ...coverage, totalRecords: -1 }],
  ['unsafe counter', { ...coverage, totalRecords: Number.MAX_SAFE_INTEGER + 1 }],
  ['non-boolean projection state', { ...coverage, usedStreamingProjection: 'coverage-private-marker' }],
  ['invalid partition', { ...coverage, unsupportedRecords: 2 }]
] as const) {
  test(`rejects ${name} without disclosing input values`, () => {
    assert.throws(
      () => validateIngestionCoverage(invalid),
      (error: unknown) => error instanceof Error && !error.message.includes('coverage-private-marker')
    );
    assert.throws(
      () => normalizeSession({ ...input, ingestionCoverage: invalid as SessionIngestionCoverage }),
      (error: unknown) => error instanceof Error && !error.message.includes('coverage-private-marker')
    );
  });
}

test('fails closed when sanitizer receives malformed coverage without disclosing it', () => {
  const malformed = {
    ...normalizeSession(input),
    ingestionCoverage: { ...coverage, usedStreamingProjection: 'coverage-private-marker' }
  } as unknown as { readonly ingestionCoverage: SessionIngestionCoverage };

  assert.throws(
    () => sanitizeForReview(malformed as never),
    (error: unknown) => error instanceof SanitizationError && !error.message.includes('coverage-private-marker')
  );
});

test('normalizes malformed sanitizer inputs to typed errors before reading coverage', () => {
  const missingEventsMarker = 'missing-events-private-marker';
  const getterMarker = 'throwing-coverage-private-marker';
  const throwingCoverage = {
    source: 'codex',
    sessionId: 'session',
    startedAt: '2026-09-07T10:00:00.000Z',
    endedAt: '2026-09-07T10:00:00.000Z',
    events: []
  };
  Object.defineProperty(throwingCoverage, 'ingestionCoverage', {
    enumerable: true,
    get(): never { throw new Error(getterMarker); }
  });

  for (const [malformed, marker] of [
    [null, 'null-private-marker'],
    [{ source: 'codex', sessionId: missingEventsMarker }, missingEventsMarker],
    [throwingCoverage, getterMarker]
  ] as const) {
    assert.throws(
      () => sanitizeForReview(malformed as never),
      (error: unknown) => error instanceof SanitizationError && !error.message.includes(marker)
    );
  }
});
