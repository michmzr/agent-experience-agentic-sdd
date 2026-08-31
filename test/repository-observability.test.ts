import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveRepository, resolveRepositoryRoot } from '../src/repository/local-repository.js';
import { normalizeMappedCapture } from '../src/capture/normalization.js';
import { ExperienceStore } from '../src/storage/experience-store.js';
import { initializeGitRepository } from './helpers/git-repository.js';

function temporaryDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('resolves a canonical repository root from a nested directory', () => {
  const root = temporaryDirectory('ael-repository-root-');
  const nested = join(root, 'nested', 'directory');
  try {
    initializeGitRepository(root);
    mkdirSync(nested, { recursive: true });

    assert.deepEqual(resolveRepository(nested)?.root, realpathSync(root));
    assert.match(resolveRepository(nested)?.id ?? '', /^[a-f0-9]{64}$/);
    assert.equal(resolveRepositoryRoot(nested), undefined);
    assert.deepEqual(resolveRepositoryRoot(root)?.root, realpathSync(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('returns no repository for a non-Git directory', () => {
  const directory = temporaryDirectory('ael-non-git-');
  try {
    assert.equal(resolveRepository(directory), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('upserts registered repositories with deterministic ordering', () => {
  const dataDirectory = temporaryDirectory('ael-repository-registry-');
  const alpha = join(dataDirectory, 'alpha');
  const beta = join(dataDirectory, 'beta');
  const databasePath = join(dataDirectory, 'experience.sqlite');
  const store = new ExperienceStore(databasePath);
  try {
    store.registerRepository({ id: beta, root: beta, observedAt: '2026-08-31T10:00:00.000Z' });
    store.registerRepository({ id: alpha, root: alpha, observedAt: '2026-08-31T10:00:00.000Z' });
    store.registerRepository({ id: beta, root: beta, observedAt: '2026-08-31T11:00:00.000Z' });

    assert.deepEqual(store.listRepositories(), [
      { id: alpha, root: alpha, observedAt: '2026-08-31T10:00:00.000Z' },
      { id: beta, root: beta, observedAt: '2026-08-31T11:00:00.000Z' }
    ]);
  } finally {
    store.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('lists only raw capture records and statistics for the requested repository', () => {
  const dataDirectory = temporaryDirectory('ael-repository-records-');
  const first = join(dataDirectory, 'first');
  const second = join(dataDirectory, 'second');
  const firstId = 'repo-first';
  const secondId = 'repo-second';
  const occurredAt = '2026-08-31T10:00:00.000Z';
  const store = new ExperienceStore(join(dataDirectory, 'experience.sqlite'));
  try {
    const session = { id: 'session-first' as never, source: 'codex' as const, startedAt: occurredAt, repositoryId: firstId as never };
    const pre = normalizeMappedCapture({ source: 'codex', sourceEventId: 'event-first-pre', sessionId: session.id, phase: 'pre-action', occurredAt, tool: 'shell', action: 'run', summary: 'Run command.' });
    const post = normalizeMappedCapture({ source: 'codex', sourceEventId: 'event-first-post', sessionId: session.id, phase: 'post-result', occurredAt, tool: 'shell', action: 'run', summary: 'Run command.', outcome: 'succeeded', exitStatus: 0, relatedEventId: 'event-first-pre' });
    store.appendIncremental({ session, event: pre });
    store.appendIncremental({ event: post });
    store.registerRepository({ id: secondId, root: second, observedAt: occurredAt });

    assert.equal(store.listRepositoryRecords(firstId).length, 1);
    assert.equal(store.listRepositoryRecords(firstId)[0]?.events.length, 2);
    assert.deepEqual(store.listRepositoryRecords(secondId), []);
    assert.deepEqual(store.repositoryStats(firstId), {
      sessions: 1, events: 2, knowledge: 0, firstRecordedAt: occurredAt, lastRecordedAt: occurredAt,
      sources: { codex: 1, cursor: 0, 'claude-code': 0 },
      phases: { 'pre-intent': 0, 'pre-action': 1, 'post-result': 1 }
    });
    assert.deepEqual(store.repositoryStats(secondId), {
      sessions: 0, events: 0, knowledge: 0,
      sources: { codex: 0, cursor: 0, 'claude-code': 0 },
      phases: { 'pre-intent': 0, 'pre-action': 0, 'post-result': 0 }
    });
  } finally {
    store.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
