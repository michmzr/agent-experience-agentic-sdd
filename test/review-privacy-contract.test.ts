import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { runCliAsync } from '../src/cli.js';
import { runManualReview } from '../src/review/review-service.js';

function codexRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ael-review-privacy-'));
  writeFileSync(join(root, 'private-session.jsonl'), `${JSON.stringify({ kind: 'message', occurredAt: '2026-08-24T10:00:00.000Z' })}\n`);
  return root;
}

test('manual review returns only the sanitized selected session identifier', async () => {
  const root = codexRoot();
  const review = await runManualReview({ source: 'codex', root, session: 'private-session.jsonl', allowExpensiveChecks: false });
  const serialized = JSON.stringify(review);

  assert.match(review.selectedSession, /^\[REDACTED:opaque-id:[a-f0-9]{64}\]$/);
  assert.equal(serialized.includes('private-session.jsonl'), false);
  assert.equal(serialized.includes(root), false);
});

test('public JSON session discovery omits internal artifact locations', async () => {
  const root = codexRoot();
  const result = await runCliAsync(['review', 'sessions', '--source', 'codex', '--root', root, '--json']);
  const sessions = JSON.parse(result.stdout) as readonly Record<string, unknown>[];

  assert.equal(result.exitCode, 0);
  assert.equal(sessions.length, 1);
  assert.deepEqual(
    { source: sessions[0]?.source, id: sessions[0]?.id, repositoryHint: sessions[0]?.repositoryHint, repositoryHintVerified: sessions[0]?.repositoryHintVerified },
    { source: 'codex', id: 'private-session.jsonl', repositoryHint: basename(root), repositoryHintVerified: true }
  );
  assert.equal(Number.isFinite(Date.parse(String(sessions[0]?.updatedAt))), true);
  assert.equal(result.stdout.includes(root), false);
  assert.equal(result.stdout.includes('location'), false);
});
