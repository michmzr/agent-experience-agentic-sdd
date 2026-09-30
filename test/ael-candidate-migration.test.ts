import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { CandidateRepository } from '../src/knowledge/candidate-repository.js';
import { CandidateService } from '../src/knowledge/candidate-service.js';

test('ACL-A7 previewed backfill rolls back on interrupted row and retries without duplicate origin or shared file', () => {
  const root = mkdtempSync(join(tmpdir(), 'acl-migration-'));
  try {
    const path = join(root, 'experience.sqlite');
    const original = new DatabaseSync(path);
    original.exec(`CREATE TABLE operational_episodes (id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, session_id TEXT NOT NULL);
      CREATE TABLE operational_candidates (id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, kind TEXT NOT NULL,
        state TEXT NOT NULL, statement TEXT NOT NULL, conditions_json TEXT NOT NULL, procedure_json TEXT NOT NULL,
        invalidation_json TEXT NOT NULL);`);
    original.prepare('INSERT INTO operational_episodes VALUES (?, ?, ?)').run('episode-1', 'repo-1', 'session-1');
    original.prepare('INSERT INTO operational_episodes VALUES (?, ?, ?)').run('episode-2', 'repo-1', 'x'.repeat(513));
    for (const [id, episode] of [['legacy-1', 'episode-1'], ['legacy-2', 'episode-2']]) {
      original.prepare('INSERT INTO operational_candidates VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, episode, 'convention', 'candidate', 'Use pnpm', '[]', '[]', '[]');
    }
    original.close();
    const repository = new CandidateRepository(path);
    const service = new CandidateService(repository);
    assert.deepEqual(service.previewOperationalBackfill('repo-1'), { pendingCount: 2, nextCursor: 'legacy-1' });
    assert.throws(() => service.backfillOperational('repo-1'), /identifier/i);
    assert.equal(service.list('repo-1').length, 0);
    repository.close();
    const repaired = new DatabaseSync(path);
    repaired.prepare('UPDATE operational_episodes SET session_id = ? WHERE id = ?').run('session-2', 'episode-2');
    repaired.close();
    const retried = new CandidateRepository(path);
    const resumed = new CandidateService(retried);
    assert.equal(resumed.backfillOperational('repo-1'), 2);
    assert.equal(resumed.backfillOperational('repo-1'), 0);
    assert.equal(resumed.list('repo-1').length, 2);
    assert.equal(resumed.list('repo-1').every((candidate) => candidate.state === 'candidate'), true);
    assert.equal(existsSync(join(root, 'AGENTS.md')), false);
    assert.equal(existsSync(join(root, 'CLAUDE.md')), false);
    retried.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
