import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runManualReview } from '../src/review/review-service.js';
import { ReviewRuntime } from '../src/review/runtime.js';

test('uses an injected exact-version review runtime instead of constructing a profile in the service', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-review-injected-profile-'));
  writeFileSync(join(root, 'session.jsonl'), `${JSON.stringify({ kind: 'message', occurredAt: '2026-08-24T10:00:00.000Z' })}\n`);
  const runtime = new ReviewRuntime({
    profiles: [{ id: 'injected', version: '7', reviewerIds: ['injected-reviewer'] }],
    reviewers: [{ id: 'injected-reviewer', expensive: false, async review() { return []; } }]
  });

  const review = await runManualReview(
    { source: 'codex', root, session: 'session.jsonl', profile: { id: 'injected', version: '7' }, allowExpensiveChecks: false },
    { runtime }
  );

  assert.deepEqual(review.profile, { id: 'injected', version: '7' });
});
