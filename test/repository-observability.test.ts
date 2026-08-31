import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveRepository } from '../src/repository/local-repository.js';
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

    assert.deepEqual(resolveRepository(nested), {
      id: realpathSync(root),
      root: realpathSync(root)
    });
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
