import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { runCliAsync } from '../src/cli.js';
import { discoverReviewSessions, runManualReview, type ReviewSessionDescriptor } from '../src/review/review-service.js';
import type { RepositorySessionDescriptor } from '../src/review/selection.js';

const timestamp = '2026-08-24T12:34:56.000Z';
const sessionRecord = `${JSON.stringify({ kind: 'message', occurredAt: timestamp })}\n`;

test('all source discoveries derive verified repository scope and recency from controlled roots and artifact stats', async () => {
  const codexRoot = fixtureRoot('ael-codex-scope-'); const codexPath = join(codexRoot, 'session.jsonl');
  writeFileSync(codexPath, sessionRecord); setUpdatedAt(codexPath);

  const claudeConfig = fixtureRoot('ael-claude-scope-'); const project = 'verified-project';
  const claudeRoot = join(claudeConfig, 'projects', project); mkdirSync(claudeRoot, { recursive: true });
  const claudePath = join(claudeRoot, 'session.jsonl');
  writeFileSync(claudePath, `${JSON.stringify({ type: 'message', timestamp })}\n`); setUpdatedAt(claudePath);

  const cursorRoot = fixtureRoot('ael-cursor-scope-'); const cursorPath = join(cursorRoot, 'session.md');
  writeFileSync(cursorPath, '## User\nReview this session.\n'); setUpdatedAt(cursorPath);

  const [codex, claude, cursor] = await Promise.all([
    discoverReviewSessions({ source: 'codex', root: codexRoot }),
    discoverReviewSessions({ source: 'claude-code', root: claudeConfig, project }),
    discoverReviewSessions({ source: 'cursor', root: cursorRoot })
  ]);

  assert.deepEqual(scopeProjection(codex), [{ source: 'codex', id: 'session.jsonl', repositoryHint: basename(codexRoot), repositoryHintVerified: true, updatedAt: timestamp }]);
  assert.deepEqual(scopeProjection(claude), [{ source: 'claude-code', id: 'session', repositoryHint: project, repositoryHintVerified: true, updatedAt: timestamp }]);
  assert.deepEqual(scopeProjection(cursor), [{ source: 'cursor', id: 'session.md', repositoryHint: basename(cursorRoot), repositoryHintVerified: true, updatedAt: timestamp }]);
});

test('public discovery returns selectable metadata without internal artifact paths', async () => {
  const root = fixtureRoot('ael-public-scope-'); const artifact = join(root, 'session.jsonl');
  writeFileSync(artifact, sessionRecord); setUpdatedAt(artifact);

  const result = await runCliAsync(['review', 'sessions', '--source', 'codex', '--root', root, '--json']);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), [{
    source: 'codex', id: 'session.jsonl', repositoryHint: basename(root), repositoryHintVerified: true, updatedAt: timestamp
  }]);
  assert.equal(result.stdout.includes(root), false);
  assert.equal(result.stdout.includes('location'), false);
});

test('interactive selection receives only verified selectable metadata without locations', async () => {
  const root = fixtureRoot('ael-selector-scope-'); const artifact = join(root, 'session.jsonl');
  writeFileSync(artifact, sessionRecord); setUpdatedAt(artifact);
  const repositoryHint = basename(root);
  let received: readonly RepositorySessionDescriptor[] = [];

  await runManualReview(
    { source: 'codex', root, interactive: true, repository: repositoryHint, allowExpensiveChecks: false },
    { prompt: {
      async choose(sessions) { received = sessions; return 'session.jsonl'; },
      async confirm() { return true; }
    } }
  );

  assert.deepEqual(received, [{ id: 'session.jsonl', repositoryHint, repositoryHintVerified: true, updatedAt: timestamp }]);
  assert.equal(JSON.stringify(received).includes(root), false);
  assert.equal(JSON.stringify(received).includes('location'), false);
});

function fixtureRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function setUpdatedAt(path: string): void {
  const date = new Date(timestamp);
  utimesSync(path, date, date);
}

function scopeProjection(descriptors: readonly ReviewSessionDescriptor[]) {
  return descriptors.map(({ source, id, repositoryHint, repositoryHintVerified, updatedAt }) => ({ source, id, repositoryHint, repositoryHintVerified, updatedAt }));
}
