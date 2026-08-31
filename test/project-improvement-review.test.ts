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
    profiles: [{ id: 'project', version: '1', reviewerIds: ['architecture', 'invalid', 'malformed', 'broken'] }],
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
      {
        id: 'malformed',
        expensive: false,
        async review() {
          return [{
            code: 'project-improvement', findingId: 'malformed', rootCauseId: 'module-boundary', recommendation: 'Separate the affected module boundary',
            category: 'architecture', severity: 'critical', evidenceEventIds: ['unknown-event']
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
  assert.deepEqual(review.projectReviewDiagnostics, []);
  assert.deepEqual(review.serviceDiagnostics, [
    { code: 'PROJECT_REVIEWER_INVALID', reviewerId: 'invalid' },
    { code: 'PROJECT_REVIEWER_INVALID', reviewerId: 'malformed' }
  ]);
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
    evidenceEventIds: review.projectImprovements[0]?.evidenceEventIds,
    findingIds: review.projectImprovements[0]?.findingIds
  }]);
  assert.equal(JSON.stringify(review).includes('reviewer secret'), false);
});

test('rejects every project contribution from a poisoned reviewer while retaining independent corroboration', async () => {
  const root = codexRoot([
    { kind: 'tool', occurredAt: '2026-08-24T10:00:00.000Z', text: 'architecture boundary 1', exitStatus: 1 },
    { kind: 'tool', occurredAt: '2026-08-24T10:01:00.000Z', text: 'architecture boundary 2', exitStatus: 1 },
    { kind: 'tool', occurredAt: '2026-08-24T10:02:00.000Z', text: 'architecture boundary 3', exitStatus: 1 },
    { kind: 'tool', occurredAt: '2026-08-24T10:03:00.000Z', text: 'architecture boundary 4', exitStatus: 1 }
  ]);
  const runtime = new ReviewRuntime({
    profiles: [{ id: 'project', version: '1', reviewerIds: ['malformed', 'unknown', 'duplicate', 'healthy'] }],
    reviewers: [
      {
        id: 'malformed', expensive: false, async review(artifact) {
          return [
            ...artifact.session.events.slice(0, 2).map((event) => projectFinding('malformed', event.id)),
            { ...projectFinding('malformed', artifact.session.events[0]?.id ?? ''), findingId: 'malformed:bad', severity: 'critical' }
          ];
        }
      },
      {
        id: 'unknown', expensive: false, async review(artifact) {
          return [
            ...artifact.session.events.slice(0, 2).map((event) => projectFinding('unknown', event.id)),
            { ...projectFinding('unknown', 'unknown-event'), findingId: 'unknown:bad' }
          ];
        }
      },
      {
        id: 'duplicate', expensive: false, async review(artifact) {
          const [first, second, third] = artifact.session.events;
          return [
            projectFinding('duplicate', first?.id ?? ''),
            projectFinding('duplicate', second?.id ?? ''),
            { ...projectFinding('duplicate', third?.id ?? ''), findingId: `duplicate:${first?.id}` }
          ];
        }
      },
      {
        id: 'healthy', expensive: false, async review(artifact) {
          return artifact.session.events.slice(2).map((event) => projectFinding('healthy', event.id));
        }
      }
    ]
  });

  const review = await runManualReview(
    { source: 'codex', root, session: 'session.jsonl', profile: { id: 'project', version: '1' }, allowExpensiveChecks: false },
    { runtime }
  );

  assert.deepEqual(review.serviceDiagnostics, [
    { code: 'DUPLICATE_REVIEWER_FINDING_ID', reviewerId: 'duplicate' },
    { code: 'PROJECT_REVIEWER_INVALID', reviewerId: 'malformed' },
    { code: 'PROJECT_REVIEWER_INVALID', reviewerId: 'unknown' }
  ]);
  assert.equal(review.projectImprovements.length, 1);
  assert.equal(review.projectImprovements[0]?.findingIds.length, 2);
  assert.equal(review.projectImprovements[0]?.findingIds.every((findingId) => findingId.startsWith('healthy:')), true);
  assert.deepEqual(review.proposals[0]?.findingIds, review.projectImprovements[0]?.findingIds);
});

test('rejects incomplete legacy reviewer findings at the service boundary while retaining valid reviewers', async () => {
  const root = codexRoot([{ kind: 'tool', occurredAt: '2026-08-24T10:00:00.000Z', text: 'review evidence', exitStatus: 0 }]);
  const runtime = new ReviewRuntime({
    profiles: [{ id: 'project', version: '1', reviewerIds: ['minimal', 'valid'] }],
    reviewers: [
      { id: 'minimal', expensive: false, async review() { return [{ code: 'legacy' }]; } },
      {
        id: 'valid', expensive: false, async review() {
          return [{ code: 'legacy', findingId: 'valid:1', rootCauseId: 'valid-root', recommendation: 'Keep the valid workflow' }];
        }
      }
    ]
  });

  const review = await runManualReview(
    { source: 'codex', root, session: 'session.jsonl', profile: { id: 'project', version: '1' }, allowExpensiveChecks: false },
    { runtime }
  );

  assert.deepEqual(review.serviceDiagnostics, [{ code: 'REVIEWER_RESULT_INVALID', reviewerId: 'minimal' }]);
  assert.deepEqual(review.findings.map((finding) => finding.rootCauseId), ['valid-root']);
});

test('rejects every cross-reviewer duplicate finding result before project consolidation', async () => {
  const root = codexRoot([
    { kind: 'tool', occurredAt: '2026-08-24T10:00:00.000Z', text: 'architecture boundary 1', exitStatus: 1 },
    { kind: 'tool', occurredAt: '2026-08-24T10:01:00.000Z', text: 'architecture boundary 2', exitStatus: 1 },
    { kind: 'tool', occurredAt: '2026-08-24T10:02:00.000Z', text: 'architecture boundary 3', exitStatus: 1 },
    { kind: 'tool', occurredAt: '2026-08-24T10:03:00.000Z', text: 'architecture boundary 4', exitStatus: 1 },
    { kind: 'tool', occurredAt: '2026-08-24T10:04:00.000Z', text: 'architecture boundary 5', exitStatus: 1 }
  ]);
  const runtime = new ReviewRuntime({
    profiles: [{ id: 'project', version: '1', reviewerIds: ['first', 'second', 'healthy'] }],
    reviewers: [
      {
        id: 'first', expensive: false, async review(artifact) {
          const [first, second] = artifact.session.events;
          return [
            { ...projectFinding('first', first?.id ?? ''), findingId: 'shared' },
            projectFinding('first', second?.id ?? '')
          ];
        }
      },
      {
        id: 'second', expensive: false, async review(artifact) {
          return [{ ...projectFinding('second', artifact.session.events[2]?.id ?? ''), findingId: 'shared' }];
        }
      },
      {
        id: 'healthy', expensive: false, async review(artifact) {
          return artifact.session.events.slice(3).map((event) => projectFinding('healthy', event.id));
        }
      }
    ]
  });

  const review = await runManualReview(
    { source: 'codex', root, session: 'session.jsonl', profile: { id: 'project', version: '1' }, allowExpensiveChecks: false },
    { runtime }
  );

  assert.deepEqual(review.serviceDiagnostics, [
    { code: 'DUPLICATE_REVIEWER_FINDING_ID', reviewerId: 'first' },
    { code: 'DUPLICATE_REVIEWER_FINDING_ID', reviewerId: 'second' }
  ]);
  assert.equal(review.projectImprovements.length, 1);
  assert.deepEqual(review.projectImprovements[0]?.findingIds, review.projectImprovements[0]?.findingIds.filter((id) => id.startsWith('healthy:')));
  assert.equal(review.projectImprovements[0]?.findingIds.length, 2);
});

test('rejects the complete reviewer result when a malformed legacy entry accompanies valid project findings', async () => {
  const root = codexRoot([
    { kind: 'tool', occurredAt: '2026-08-24T10:00:00.000Z', text: 'architecture boundary 1', exitStatus: 1 },
    { kind: 'tool', occurredAt: '2026-08-24T10:01:00.000Z', text: 'architecture boundary 2', exitStatus: 1 },
    { kind: 'tool', occurredAt: '2026-08-24T10:02:00.000Z', text: 'architecture boundary 3', exitStatus: 1 },
    { kind: 'tool', occurredAt: '2026-08-24T10:03:00.000Z', text: 'architecture boundary 4', exitStatus: 1 }
  ]);
  const runtime = new ReviewRuntime({
    profiles: [{ id: 'project', version: '1', reviewerIds: ['mixed', 'healthy'] }],
    reviewers: [
      {
        id: 'mixed', expensive: false, async review(artifact) {
          return [...artifact.session.events.slice(0, 2).map((event) => projectFinding('mixed', event.id)), { code: 'legacy' }];
        }
      },
      {
        id: 'healthy', expensive: false, async review(artifact) {
          return artifact.session.events.slice(2).map((event) => projectFinding('healthy', event.id));
        }
      }
    ]
  });

  const review = await runManualReview(
    { source: 'codex', root, session: 'session.jsonl', profile: { id: 'project', version: '1' }, allowExpensiveChecks: false },
    { runtime }
  );

  assert.deepEqual(review.serviceDiagnostics, [{ code: 'REVIEWER_RESULT_INVALID', reviewerId: 'mixed' }]);
  assert.equal(review.projectImprovements.length, 1);
  assert.equal(review.projectImprovements[0]?.findingIds.every((id) => id.startsWith('healthy:')), true);
});

test('rejects the complete reviewer result when a malformed project entry accompanies valid legacy findings', async () => {
  const root = codexRoot([{ kind: 'tool', occurredAt: '2026-08-24T10:00:00.000Z', text: 'review evidence', exitStatus: 0 }]);
  const runtime = new ReviewRuntime({
    profiles: [{ id: 'project', version: '1', reviewerIds: ['mixed', 'healthy'] }],
    reviewers: [
      {
        id: 'mixed', expensive: false, async review(artifact) {
          return [
            { code: 'legacy', findingId: 'mixed:legacy', rootCauseId: 'mixed-root', recommendation: 'Discard this result' },
            { ...projectFinding('mixed', artifact.session.events[0]?.id ?? ''), severity: 'critical' }
          ];
        }
      },
      {
        id: 'healthy', expensive: false, async review() {
          return [{ code: 'legacy', findingId: 'healthy:legacy', rootCauseId: 'healthy-root', recommendation: 'Keep this result' }];
        }
      }
    ]
  });

  const review = await runManualReview(
    { source: 'codex', root, session: 'session.jsonl', profile: { id: 'project', version: '1' }, allowExpensiveChecks: false },
    { runtime }
  );

  assert.deepEqual(review.serviceDiagnostics, [{ code: 'PROJECT_REVIEWER_INVALID', reviewerId: 'mixed' }]);
  assert.deepEqual(review.findings.map((finding) => finding.rootCauseId), ['healthy-root']);
});

test('rejects a complete reviewer result with a duplicate ID shared by project and legacy findings', async () => {
  const root = codexRoot([
    { kind: 'tool', occurredAt: '2026-08-24T10:00:00.000Z', text: 'architecture boundary 1', exitStatus: 1 },
    { kind: 'tool', occurredAt: '2026-08-24T10:01:00.000Z', text: 'architecture boundary 2', exitStatus: 1 },
    { kind: 'tool', occurredAt: '2026-08-24T10:02:00.000Z', text: 'architecture boundary 3', exitStatus: 1 }
  ]);
  const runtime = new ReviewRuntime({
    profiles: [{ id: 'project', version: '1', reviewerIds: ['mixed', 'healthy'] }],
    reviewers: [
      {
        id: 'mixed', expensive: false, async review(artifact) {
          return [
            { ...projectFinding('mixed', artifact.session.events[0]?.id ?? ''), findingId: 'shared' },
            { code: 'legacy', findingId: 'shared', rootCauseId: 'mixed-root', recommendation: 'Discard this result' }
          ];
        }
      },
      {
        id: 'healthy', expensive: false, async review(artifact) {
          return [
            ...artifact.session.events.slice(1).map((event) => projectFinding('healthy', event.id)),
            { code: 'legacy', findingId: 'healthy:legacy', rootCauseId: 'healthy-root', recommendation: 'Keep this result' }
          ];
        }
      }
    ]
  });

  const review = await runManualReview(
    { source: 'codex', root, session: 'session.jsonl', profile: { id: 'project', version: '1' }, allowExpensiveChecks: false },
    { runtime }
  );

  assert.deepEqual(review.serviceDiagnostics, [{ code: 'DUPLICATE_REVIEWER_FINDING_ID', reviewerId: 'mixed' }]);
  assert.equal(review.projectImprovements[0]?.findingIds.every((id) => id.startsWith('healthy:')), true);
  assert.deepEqual(review.findings.map((finding) => finding.rootCauseId), ['healthy-root']);
});

test('rejects a complete reviewer result with duplicate legacy finding IDs', async () => {
  const root = codexRoot([{ kind: 'tool', occurredAt: '2026-08-24T10:00:00.000Z', text: 'review evidence', exitStatus: 0 }]);
  const runtime = new ReviewRuntime({
    profiles: [{ id: 'project', version: '1', reviewerIds: ['duplicate', 'healthy'] }],
    reviewers: [
      {
        id: 'duplicate', expensive: false, async review() {
          return [
            { code: 'legacy', findingId: 'shared', rootCauseId: 'duplicate-one', recommendation: 'Discard this result' },
            { code: 'legacy', findingId: 'shared', rootCauseId: 'duplicate-two', recommendation: 'Discard this result' }
          ];
        }
      },
      {
        id: 'healthy', expensive: false, async review() {
          return [{ code: 'legacy', findingId: 'healthy:legacy', rootCauseId: 'healthy-root', recommendation: 'Keep this result' }];
        }
      }
    ]
  });

  const review = await runManualReview(
    { source: 'codex', root, session: 'session.jsonl', profile: { id: 'project', version: '1' }, allowExpensiveChecks: false },
    { runtime }
  );

  assert.deepEqual(review.serviceDiagnostics, [{ code: 'DUPLICATE_REVIEWER_FINDING_ID', reviewerId: 'duplicate' }]);
  assert.deepEqual(review.findings.map((finding) => finding.rootCauseId), ['healthy-root']);
});

function projectFinding(reviewerId: string, eventId: string) {
  return {
    code: 'project-improvement' as const,
    findingId: `${reviewerId}:${eventId}`,
    rootCauseId: 'module-boundary',
    recommendation: 'Separate the affected module boundary',
    category: 'architecture' as const,
    severity: 'high' as const,
    evidenceEventIds: [eventId]
  };
}

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

test('withholds a colliding project proposal while retaining the legacy proposal', async () => {
  const root = codexRoot([
    { kind: 'tool', occurredAt: '2026-08-24T10:00:00.000Z', text: 'architecture boundary', exitStatus: 1 },
    { kind: 'tool', occurredAt: '2026-08-24T10:01:00.000Z', text: 'architecture boundary', exitStatus: 1 }
  ]);
  const runtime = new ReviewRuntime({
    profiles: [{ id: 'project', version: '1', reviewerIds: ['legacy', 'architecture'] }],
    reviewers: [
      {
        id: 'legacy',
        expensive: false,
        async review() {
          return [{
            code: 'legacy',
            findingId: 'legacy:collision',
            rootCauseId: 'project-improvement:architecture:module-boundary',
            recommendation: 'Keep the established workflow'
          }];
        }
      },
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
      }
    ]
  });

  const review = await runManualReview(
    { source: 'codex', root, session: 'session.jsonl', profile: { id: 'project', version: '1' }, allowExpensiveChecks: false },
    { runtime }
  );

  assert.equal(review.projectImprovements.length, 1);
  assert.deepEqual(review.projectReviewDiagnostics, []);
  assert.deepEqual(review.serviceDiagnostics, [{
    code: 'PROPOSAL_ID_COLLISION',
    findingId: 'project-improvement:architecture:module-boundary'
  }]);
  assert.deepEqual(review.candidates.map((candidate) => candidate.findingId), ['project-improvement:architecture:module-boundary']);
  assert.deepEqual(review.proposals.map((proposal) => proposal.findingId), ['project-improvement:architecture:module-boundary']);
  assert.equal(review.proposals[0]?.title, 'Keep the established workflow');
  assert.equal(new Set(review.candidates.map((candidate) => candidate.id)).size, review.candidates.length);
  assert.equal(new Set(review.proposals.map((proposal) => proposal.id)).size, review.proposals.length);
});
