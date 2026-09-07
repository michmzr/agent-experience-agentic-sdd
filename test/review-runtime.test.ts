import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedSession } from '../src/review/contracts.js';
import { sanitizeForReview, type SanitizedReviewArtifact } from '../src/review/sanitizer.js';
import { ReviewRuntime } from '../src/review/runtime.js';

const artifact = sanitizeForReview({
  source: 'codex',
  sessionId: 'opaque-session',
  startedAt: '2026-08-24T10:00:00.000Z',
  endedAt: '2026-08-24T10:01:00.000Z',
  events: []
});

function delayedReviewer(id: string, delayMs: number, expensive = false) {
  return {
    id,
    expensive,
    async review(input: typeof artifact) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return [{
        code: id,
        findingId: `finding:${id}`,
        rootCauseId: `root-cause:${id}`,
        recommendation: `Review ${id}`,
        artifactPolicy: input.policy.hash
      }];
    }
  };
}

test('runs independent reviewers concurrently but returns results in profile order', async () => {
  const runtime = new ReviewRuntime({
    profiles: [{ id: 'local', version: '1', reviewerIds: ['slow', 'fast'] }],
    reviewers: [delayedReviewer('slow', 25), delayedReviewer('fast', 1)]
  });

  const result = await runtime.run({ artifact, profile: { id: 'local', version: '1' }, allowExpensiveChecks: false });

  assert.deepEqual(result.results.map((entry) => entry.reviewerId), ['slow', 'fast']);
  assert.deepEqual(result.results.map((entry) => entry.findings[0].code), ['slow', 'fast']);
  assert.deepEqual(result.skippedReviewerIds, []);
  assert.deepEqual(result.diagnostics, []);
});

test('isolates a failed reviewer without exposing its error or suppressing successful reviewers', async () => {
  const runtime = new ReviewRuntime({
    profiles: [{ id: 'local', version: '1', reviewerIds: ['broken', 'good'] }],
    reviewers: [
      { id: 'broken', expensive: false, async review() { throw new Error('private reviewer failure'); } },
      delayedReviewer('good', 0)
    ]
  });

  const result = await runtime.run({ artifact, profile: { id: 'local', version: '1' }, allowExpensiveChecks: false });

  assert.deepEqual(result.results.map((entry) => entry.reviewerId), ['good']);
  assert.deepEqual(result.diagnostics, [{ reviewerId: 'broken', code: 'REVIEWER_FAILED' }]);
  assert.equal(JSON.stringify(result).includes('private reviewer failure'), false);
});

test('isolates malformed reviewer payloads without suppressing independent reviewers', async () => {
  const runtime = new ReviewRuntime({
    profiles: [{ id: 'local', version: '1', reviewerIds: ['null', 'non-array', 'null-entry', 'invalid', 'good'] }],
    reviewers: [
      { id: 'null', expensive: false, async review() { return null as never; } },
      { id: 'non-array', expensive: false, async review() { return { code: 'not-an-array' } as never; } },
      { id: 'null-entry', expensive: false, async review() { return [null] as never; } },
      { id: 'invalid', expensive: false, async review() { return [{ code: '   ' }] as never; } },
      delayedReviewer('good', 0)
    ]
  });

  const result = await runtime.run({ artifact, profile: { id: 'local', version: '1' }, allowExpensiveChecks: false });

  assert.deepEqual(result.results.map((entry) => entry.reviewerId), ['good']);
  assert.deepEqual(result.diagnostics, [
    { reviewerId: 'null', code: 'REVIEWER_FAILED' },
    { reviewerId: 'non-array', code: 'REVIEWER_FAILED' },
    { reviewerId: 'null-entry', code: 'REVIEWER_FAILED' },
    { reviewerId: 'invalid', code: 'REVIEWER_FAILED' }
  ]);
});

test('accepts the minimal extensible review finding contract at the runtime boundary', async () => {
  const runtime = new ReviewRuntime({
    profiles: [{ id: 'local', version: '1', reviewerIds: ['minimal'] }],
    reviewers: [{ id: 'minimal', expensive: false, async review() { return [{ code: 'legacy' }]; } }]
  });

  const result = await runtime.run({ artifact, profile: { id: 'local', version: '1' }, allowExpensiveChecks: false });

  assert.deepEqual(result.results, [{ reviewerId: 'minimal', findings: [{ code: 'legacy' }] }]);
  assert.deepEqual(result.diagnostics, []);
});

test('does not execute expensive reviewers without explicit permission', async () => {
  let expensiveCalls = 0;
  const runtime = new ReviewRuntime({
    profiles: [{ id: 'local', version: '1', reviewerIds: ['regular', 'expensive'] }],
    reviewers: [
      delayedReviewer('regular', 0),
      { id: 'expensive', expensive: true, async review() { expensiveCalls += 1; return []; } }
    ]
  });

  const blocked = await runtime.run({ artifact, profile: { id: 'local', version: '1' }, allowExpensiveChecks: false });
  assert.equal(expensiveCalls, 0);
  assert.deepEqual(blocked.results.map((entry) => entry.reviewerId), ['regular']);
  assert.deepEqual(blocked.skippedReviewerIds, ['expensive']);

  await runtime.run({ artifact, profile: { id: 'local', version: '1' }, allowExpensiveChecks: true });
  assert.equal(expensiveCalls, 1);
});

test('resolves only an exact, versioned review profile', async () => {
  const runtime = new ReviewRuntime({
    profiles: [{ id: 'local', version: '1', reviewerIds: ['regular'] }],
    reviewers: [delayedReviewer('regular', 0)]
  });

  await assert.rejects(
    runtime.run({ artifact, profile: { id: 'local', version: '2' }, allowExpensiveChecks: false }),
    /profile.*not found/i
  );
});

test('accepts sanitized artifacts only at the runtime boundary', () => {
  const raw: NormalizedSession = {
    source: 'codex', sessionId: 'raw', startedAt: '2026-08-24T10:00:00.000Z', endedAt: '2026-08-24T10:01:00.000Z', events: [],
    ingestionCoverage: {
      totalRecords: 0,
      normalizedRecords: 0,
      skippedTechnicalRecords: 0,
      unsupportedRecords: 0,
      truncatedTextFields: 0,
      omittedStructuredOutputs: 0,
      usedStreamingProjection: false
    }
  };
  const acceptsOnlySanitizedArtifact = (_artifact: SanitizedReviewArtifact): void => undefined;

  // @ts-expect-error The review runtime must never receive an unsanitized session.
  acceptsOnlySanitizedArtifact(raw);
  assert.ok(artifact);
});

test('rejects a structurally forged sanitized artifact before invoking reviewers', async () => {
  let calls = 0;
  const runtime = new ReviewRuntime({
    profiles: [{ id: 'local', version: '1', reviewerIds: ['regular'] }],
    reviewers: [{ id: 'regular', expensive: false, async review() { calls += 1; return []; } }]
  });
  const forged = structuredClone(artifact);

  await assert.rejects(
    runtime.run({ artifact: forged, profile: { id: 'local', version: '1' }, allowExpensiveChecks: false }),
    /malformed or unsupported/i
  );
  assert.equal(calls, 0);
});
