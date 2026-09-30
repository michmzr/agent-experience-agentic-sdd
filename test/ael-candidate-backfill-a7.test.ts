import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { CandidateRepository } from '../src/knowledge/candidate-repository.js';
import { CandidateService } from '../src/knowledge/candidate-service.js';

test('ACL-A7 preview, interrupted apply and restart preserve candidate state and Git files', () => {
  const root = mkdtempSync(join(tmpdir(), 'acl-a7-'));
  try {
    const gitRoot = join(root, 'project'); mkdirSync(gitRoot);
    execFileSync('git', ['init', '-q', gitRoot]);
    writeFileSync(join(gitRoot, 'AGENTS.md'), 'Use pnpm instead of npm.\n');
    execFileSync('git', ['-C', gitRoot, 'add', 'AGENTS.md']);
    execFileSync('git', ['-C', gitRoot, '-c', 'user.name=AEL Test', '-c', 'user.email=ael@example.invalid',
      'commit', '-q', '-m', 'baseline']);
    const baseline = gitStatus(gitRoot);
    const databasePath = join(root, 'experience.sqlite');
    const database = new DatabaseSync(databasePath);
    database.exec(`CREATE TABLE operational_episodes (
      id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, session_id TEXT NOT NULL);
      CREATE TABLE operational_candidates (
      id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, kind TEXT NOT NULL,
      state TEXT NOT NULL, statement TEXT NOT NULL, conditions_json TEXT NOT NULL,
      procedure_json TEXT NOT NULL, invalidation_json TEXT NOT NULL);`);
    for (const [id, repositoryId] of [['one', 'repo-1'], ['two', 'repo-1'], ['foreign', 'repo-2']]) {
      database.prepare('INSERT INTO operational_episodes VALUES (?, ?, ?)').run(`episode-${id}`, repositoryId, `session-${id}`);
      database.prepare('INSERT INTO operational_candidates VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(`legacy-${id}`, `episode-${id}`, 'convention', 'candidate', `Use pnpm ${id}`,
          '[]', '[]', '[]');
    }
    database.close();

    let repository = new CandidateRepository(databasePath);
    let service = new CandidateService(repository);
    assert.deepEqual(service.previewOperationalBackfill('repo-1'), { pendingCount: 2, nextCursor: 'legacy-one' });
    assert.deepEqual(repository.list('repo-1'), []);
    assert.equal(gitStatus(gitRoot), baseline);

    const injector = new DatabaseSync(databasePath);
    injector.exec(`CREATE TRIGGER interrupt_acl_backfill BEFORE INSERT ON acl_candidate_origins
      WHEN NEW.origin_id = 'legacy-two' BEGIN SELECT RAISE(ABORT, 'simulated interruption'); END;`);
    injector.close();
    assert.throws(() => service.backfillOperational('repo-1'), /simulated interruption/);
    assert.deepEqual(service.previewOperationalBackfill('repo-1'), { pendingCount: 2, nextCursor: 'legacy-one' });
    assert.deepEqual(repository.list('repo-1'), []);
    repository.close();

    const recovery = new DatabaseSync(databasePath);
    recovery.exec('DROP TRIGGER interrupt_acl_backfill');
    recovery.close();
    repository = new CandidateRepository(databasePath); service = new CandidateService(repository);
    assert.equal(service.backfillOperational('repo-1'), 2);
    assert.equal(service.backfillOperational('repo-1'), 0);
    assert.deepEqual(service.previewOperationalBackfill('repo-1'), { pendingCount: 0, nextCursor: null });
    assert.deepEqual(service.previewOperationalBackfill('repo-2'), { pendingCount: 1, nextCursor: 'legacy-foreign' });
    assert.deepEqual(repository.list('repo-1').map((candidate) => candidate.state), ['candidate', 'candidate']);
    repository.close();

    repository = new CandidateRepository(databasePath);
    assert.equal(repository.list('repo-1').length, 2);
    assert.equal(repository.list('repo-2').length, 0);
    assert.equal(gitStatus(gitRoot), baseline);
    repository.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ACL-A7 applies bounded batches and is idempotent across a restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'acl-a7-pages-'));
  try {
    const databasePath = join(root, 'experience.sqlite');
    const database = new DatabaseSync(databasePath);
    database.exec(`CREATE TABLE operational_episodes (
      id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, session_id TEXT NOT NULL);
      CREATE TABLE operational_candidates (
      id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, kind TEXT NOT NULL,
      state TEXT NOT NULL, statement TEXT NOT NULL, conditions_json TEXT NOT NULL,
      procedure_json TEXT NOT NULL, invalidation_json TEXT NOT NULL);
      INSERT INTO operational_episodes VALUES ('episode-1','repo-1','session-1');
      BEGIN IMMEDIATE;`);
    const insert = database.prepare('INSERT INTO operational_candidates VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (let index = 0; index < 1_025; index++) insert.run(`legacy-${String(index).padStart(4, '0')}`,
      'episode-1', 'successful-workflow', 'candidate', 'Use pnpm', '[]', '[]', '[]');
    database.exec('COMMIT'); database.close();
    let repository = new CandidateRepository(databasePath);
    assert.equal(repository.previewOperationalBackfill('repo-1').pendingCount, 1_025);
    assert.equal(repository.backfillOperational('repo-1'), 1_024);
    repository.close();
    repository = new CandidateRepository(databasePath);
    const service = new CandidateService(repository);
    assert.deepEqual(service.previewOperationalBackfill('repo-1'), { pendingCount: 1, nextCursor: 'legacy-1024' });
    assert.equal(service.backfillOperational('repo-1'), 1);
    assert.equal(service.backfillOperational('repo-1'), 0);
    assert.equal(repository.list('repo-1').length, 1_025);
    assert.equal(repository.list('repo-1').every((candidate) => candidate.state === 'candidate'), true);
    repository.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function gitStatus(root: string): string {
  return execFileSync('git', ['-C', root, 'status', '--porcelain=v1'], { encoding: 'utf8' });
}
