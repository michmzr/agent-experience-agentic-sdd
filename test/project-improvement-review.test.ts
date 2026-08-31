import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runManualReview } from '../src/review/review-service.js';
import { ReviewRuntime } from '../src/review/runtime.js';

function codexRoot(records: readonly Record<string, unknown>[]): string {
  const root = mkdtempSync(join(tmpdir(), 'ael-project-improvement-review-'));
  writeFileSync(join(root, 'session.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return root;
}

test('creates one evidence-backed architecture proposal without duplicating it in legacy groups', async () => {
  const root = codexRoot([
    { kind: 'tool', occurredAt: '2026-08-24T10:00:00.000Z', text: 'architecture boundary', exitStatus: 1 },
    { kind: 'tool', occurredAt: '2026-08-24T10:01:00.000Z', text: 'architecture boundary', exitStatus: 1 }
  ]);
  const runtime = new ReviewRuntime({
    profiles: [{ id: 'project', version: '1', reviewerIds: ['architecture', 'invalid', 'broken'] }],
    reviewers: [
      {
        id: 'architecture',
        expensive: false,
        async review(artifact) {
          return artifact.session.events.map((event) => ({
            code: 'project-improvement' as const,
            findingId: `architecture:${event.id}`,
            rootCauseId: 'module-boundary',
            recommendation: 'Separate the affected module boundary',
            category: 'architecture' as const,
            severity: 'high' as const,
            evidenceEventIds: [event.id]
          }));
        }
      },
      {
        id: 'invalid',
        expensive: false,
        async review() {
          return [{
            code: 'project-improvement', findingId: 'invalid', rootCauseId: 'module-boundary', recommendation: 'Separate the affected module boundary',
            category: 'architecture', severity: 'high', evidenceEventIds: ['unknown-event']
          }];
        }
      },
      { id: 'broken', expensive: false, async review() { throw new Error('reviewer secret'); } }
    ]
  });

  const review = await runManualReview(
    { source: 'codex', root, session: 'session.jsonl', profile: { id: 'project', version: '1' }, allowExpensiveChecks: false },
    { runtime }
  );

  assert.equal(review.findings.length, 0);
  assert.equal(review.projectImprovements.length, 1);
  assert.deepEqual(review.projectReviewDiagnostics, [{ code: 'INVALID_PROJECT_FINDING', findingId: 'invalid' }]);
  assert.deepEqual(review.runtimeDiagnostics, [{ reviewerId: 'broken', code: 'REVIEWER_FAILED' }]);
  assert.deepEqual(review.proposals, [{
    id: `proposal:${review.selectedSession}:project-improvement:architecture:module-boundary`,
    sessionId: review.selectedSession,
    findingId: 'project-improvement:architecture:module-boundary',
    candidateId: `candidate:${review.selectedSession}:project-improvement:architecture:module-boundary`,
    category: 'architecture',
    title: 'Separate the affected module boundary',
    requiresSpecification: true,
    severity: 'high',
    evidenceEventIds: review.projectImprovements[0]?.evidenceEventIds
  }]);
  assert.equal(JSON.stringify(review).includes('reviewer secret'), false);
});

test('does not create a project improvement or proposal from a single observation', async () => {
  const root = codexRoot([{ kind: 'tool', occurredAt: '2026-08-24T10:00:00.000Z', text: 'architecture boundary', exitStatus: 1 }]);
  const runtime = new ReviewRuntime({
    profiles: [{ id: 'project', version: '1', reviewerIds: ['architecture'] }],
    reviewers: [{
      id: 'architecture',
      expensive: false,
      async review(artifact) {
        const [event] = artifact.session.events;
        return [{
          code: 'project-improvement' as const,
          findingId: `architecture:${event?.id}`,
          rootCauseId: 'module-boundary',
          recommendation: 'Separate the affected module boundary',
          category: 'architecture' as const,
          severity: 'high' as const,
          evidenceEventIds: [event?.id ?? '']
        }];
      }
    }]
  });

  const review = await runManualReview(
    { source: 'codex', root, session: 'session.jsonl', profile: { id: 'project', version: '1' }, allowExpensiveChecks: false },
    { runtime }
  );

  assert.deepEqual(review.projectImprovements, []);
  assert.deepEqual(review.proposals, []);
});
