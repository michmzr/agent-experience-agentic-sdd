import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runManualReview } from '../src/review/review-service.js';
import { initializeGitRepository } from './helpers/git-repository.js';

test('runs only the confirmed latest artifact from an injected verified repository-scoped discovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-review-selection-'));
  initializeGitRepository(root);
  writeFileSync(join(root, 'selected.jsonl'), `${JSON.stringify({ kind: 'message', occurredAt: '2026-08-24T10:00:00.000Z' })}\n`);
  const review = await runManualReview(
    { source: 'codex', root, session: 'latest', interactive: true, repository: root, allowExpensiveChecks: false },
    {
      discover: async () => [{ source: 'codex', id: 'selected.jsonl', location: join(root, 'selected.jsonl'), repositoryHint: 'ael-review-selection', repositoryHintVerified: true, repositoryIdentity: realpathSync(root), updatedAt: '2026-08-24T10:00:00.000Z' }],
      prompt: { async choose() { return undefined; }, async confirm() { return true; } }
    }
  );

  assert.match(review.selectedSession, /^\[REDACTED:opaque-id:/);
});
