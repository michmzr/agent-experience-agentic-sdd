import assert from 'node:assert/strict';
import test from 'node:test';

import { createDefaultReviewRuntime, defaultReviewProfile, defaultReviewProfileV1 } from '../src/review/default-reviewers.js';
import { sanitizeForReview } from '../src/review/sanitizer.js';

const artifact = sanitizeForReview({
  source: 'codex',
  sessionId: 'default-reviewer-session',
  startedAt: '2026-08-24T10:00:00.000Z',
  endedAt: '2026-08-24T10:03:00.000Z',
  events: [
    { id: 'message-1', kind: 'message', occurredAt: '2026-08-24T10:00:00.000Z', text: 'Prompt ambiguity requires a clearer acceptance criterion.', outcome: 'unknown' },
    { id: 'tool-1', kind: 'tool', occurredAt: '2026-08-24T10:01:00.000Z', tool: 'git', text: 'temporary artifact changed architecture and developer experience friction.', outcome: 'failed' },
    { id: 'metadata-1', kind: 'metadata', occurredAt: '2026-08-24T10:02:00.000Z', text: 'Project milestone ownership is blocked.', outcome: 'unknown' },
    { id: 'tool-2', kind: 'tool', occurredAt: '2026-08-24T10:03:00.000Z', tool: 'module-boundary-check', outcome: 'passed' }
  ]
});

test('default profile v2 includes project specialists with deterministic reviewer identities', async () => {
  const [, toolOneEvent, metadataEvent, toolTwoEvent] = artifact.session.events;
  const result = await createDefaultReviewRuntime().run({
    artifact,
    profile: defaultReviewProfile,
    allowExpensiveChecks: true
  });

  assert.deepEqual(result.profile, { id: 'default', version: '2' });
  assert.deepEqual(result.results.map(({ reviewerId }) => reviewerId), [
    'prompt-effectiveness',
    'workflow',
    'failures-learning',
    'temporary-artifacts',
    'code-changes',
    'architecture-project-specialist',
    'developer-experience-project-specialist',
    'project-management-project-specialist',
    'privacy',
    'diagnostics'
  ]);
  assert.deepEqual(
    result.results.map(({ reviewerId, findings }) => [reviewerId, findings.map(({ code }) => code.split(':')[0])]),
    [
      ['prompt-effectiveness', ['prompt-effectiveness']],
      ['workflow', ['workflow-failed', 'workflow-passed']],
      ['failures-learning', ['failure-learning']],
      ['temporary-artifacts', ['temporary-artifact']],
      ['code-changes', ['code-change']],
      ['architecture-project-specialist', ['project-improvement', 'project-improvement']],
      ['developer-experience-project-specialist', ['project-improvement']],
      ['project-management-project-specialist', ['project-improvement']],
      ['privacy', ['review-message', 'review-metadata']],
      ['diagnostics', ['diagnostic-failure']]
    ]
  );

  const findingsByReviewer = new Map(result.results.map(({ reviewerId, findings }) => [reviewerId, findings]));
  assert.deepEqual(
    findingsByReviewer.get('architecture-project-specialist')?.find((finding) => finding.findingId === `architecture-project-specialist:${toolOneEvent.id}`),
    {
      code: 'project-improvement',
      findingId: `architecture-project-specialist:${toolOneEvent.id}`,
      rootCauseId: 'module-boundary',
      recommendation: 'Separate the affected module boundary',
      category: 'architecture',
      severity: 'high',
      evidenceEventIds: [toolOneEvent.id]
    }
  );
  assert.deepEqual(
    findingsByReviewer.get('architecture-project-specialist')?.find((finding) => finding.findingId === `architecture-project-specialist:${toolTwoEvent.id}`),
    {
      code: 'project-improvement',
      findingId: `architecture-project-specialist:${toolTwoEvent.id}`,
      rootCauseId: 'module-boundary',
      recommendation: 'Separate the affected module boundary',
      category: 'architecture',
      severity: 'medium',
      evidenceEventIds: [toolTwoEvent.id]
    }
  );
  assert.deepEqual(
    findingsByReviewer.get('developer-experience-project-specialist'),
    [{
      code: 'project-improvement',
      findingId: `developer-experience-project-specialist:${toolOneEvent.id}`,
      rootCauseId: 'developer-workflow-friction',
      recommendation: 'Remove the recurring developer workflow friction',
      category: 'developer-experience',
      severity: 'high',
      evidenceEventIds: [toolOneEvent.id]
    }]
  );
  assert.deepEqual(
    findingsByReviewer.get('project-management-project-specialist'),
    [{
      code: 'project-improvement',
      findingId: `project-management-project-specialist:${metadataEvent.id}`,
      rootCauseId: 'milestone-ownership',
      recommendation: 'Clarify milestone ownership and delivery scope',
      category: 'project-management',
      severity: 'medium',
      evidenceEventIds: [metadataEvent.id]
    }]
  );
});

test('default profile v1 preserves the pre-specialist reviewer semantics', async () => {
  const result = await createDefaultReviewRuntime().run({
    artifact,
    profile: defaultReviewProfileV1,
    allowExpensiveChecks: true
  });

  assert.deepEqual(result.profile, { id: 'default', version: '1' });
  assert.deepEqual(result.results.map(({ reviewerId }) => reviewerId), [
    'prompt-effectiveness',
    'workflow',
    'failures-learning',
    'temporary-artifacts',
    'code-changes',
    'architecture',
    'developer-experience',
    'project-management',
    'privacy',
    'diagnostics'
  ]);
  assert.equal(result.results.flatMap(({ findings }) => findings).some((finding) => finding.code === 'project-improvement'), false);
  assert.deepEqual(result.results.find(({ reviewerId }) => reviewerId === 'architecture')?.findings.map(({ code }) => code.split(':')[0]), ['architecture', 'architecture']);
  assert.deepEqual(result.results.find(({ reviewerId }) => reviewerId === 'developer-experience')?.findings.map(({ code }) => code.split(':')[0]), ['developer-experience']);
  assert.deepEqual(result.results.find(({ reviewerId }) => reviewerId === 'project-management')?.findings.map(({ code }) => code.split(':')[0]), ['project-management']);
});
