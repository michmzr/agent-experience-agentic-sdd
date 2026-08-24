import assert from 'node:assert/strict';
import test from 'node:test';

import { createDefaultReviewRuntime, defaultReviewProfile } from '../src/review/default-reviewers.js';
import { sanitizeForReview } from '../src/review/sanitizer.js';

const artifact = sanitizeForReview({
  source: 'codex',
  sessionId: 'default-reviewer-session',
  startedAt: '2026-08-24T10:00:00.000Z',
  endedAt: '2026-08-24T10:02:00.000Z',
  events: [
    { id: 'message-1', kind: 'message', occurredAt: '2026-08-24T10:00:00.000Z', text: 'Prompt ambiguity requires a clearer acceptance criterion.', outcome: 'unknown' },
    { id: 'tool-1', kind: 'tool', occurredAt: '2026-08-24T10:01:00.000Z', tool: 'git', text: 'temporary artifact changed architecture and developer experience.', outcome: 'failed' },
    { id: 'metadata-1', kind: 'metadata', occurredAt: '2026-08-24T10:02:00.000Z', text: 'Project milestone ownership is blocked.', outcome: 'unknown' }
  ]
});

test('default profile v1 includes every required deterministic reviewer perspective in stable order', async () => {
  const result = await createDefaultReviewRuntime().run({
    artifact,
    profile: defaultReviewProfile,
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
  assert.deepEqual(
    result.results.map(({ reviewerId, findings }) => [reviewerId, findings.map(({ code }) => code.split(':')[0])]),
    [
      ['prompt-effectiveness', ['prompt-effectiveness']],
      ['workflow', ['workflow-failed']],
      ['failures-learning', ['failure-learning']],
      ['temporary-artifacts', ['temporary-artifact']],
      ['code-changes', ['code-change']],
      ['architecture', ['architecture']],
      ['developer-experience', ['developer-experience']],
      ['project-management', ['project-management']],
      ['privacy', ['review-message', 'review-metadata']],
      ['diagnostics', ['diagnostic-failure']]
    ]
  );
});
