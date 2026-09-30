import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { CandidateRepository } from '../src/knowledge/candidate-repository.js';
import { CandidateService } from '../src/knowledge/candidate-service.js';

test('ACL-A2 persists one scoped candidate with two origins and separates changed scope or procedure after restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'acl-inbox-'));
  try {
    const path = join(root, 'experience.sqlite');
    let repository = new CandidateRepository(path);
    const base = {
      repositoryId: 'repo-1', kind: 'failure' as const, statement: 'Use pnpm for dependency installation',
      applicability: { scope: 'subproject' as const, path: 'packages/mobile', conditions: ['pnpm'] },
      propositionKey: 'package-manager-pnpm', procedureKey: 'pnpm-install', source: 'manual-review' as const
    };
    const first = repository.register({ ...base, originId: 'session-a:finding-1', sessionId: 'session-a' });
    const second = repository.register({ ...base, originId: 'session-b:finding-2', sessionId: 'session-b' });
    repository.register({ ...base, originId: 'session-c:finding-3', applicability: { ...base.applicability, path: 'packages/backend' } });
    repository.register({ ...base, originId: 'session-d:finding-4', procedureKey: 'pnpm-install-frozen' });
    assert.equal(first.id, second.id);
    repository.close();
    repository = new CandidateRepository(path);
    assert.equal(repository.list('repo-1').length, 3);
    assert.deepEqual(repository.inspect('repo-1', first.id)?.origins.map((origin) => origin.originId),
      ['session-a:finding-1', 'session-b:finding-2']);
    assert.equal(repository.inspect('other-repo', first.id), undefined);
    assert.equal(repository.inspect('repo-1', first.id)?.state, 'candidate');
    assert.deepEqual(repository.listVerifiedLocalEntries('repo-1'), []);
    repository.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ACL-A1 keeps unkeyed origins from different producers separate and writes manual output atomically', () => {
  const root = mkdtempSync(join(tmpdir(), 'acl-manual-'));
  try {
    const repository = new CandidateRepository(join(root, 'experience.sqlite'));
    const base = { repositoryId: 'repo-1', kind: 'failure' as const, statement: 'Observed failure',
      applicability: { scope: 'repository' as const }, originId: 'same-origin' };
    const operational = repository.register({ ...base, source: 'operational' });
    const manual = repository.register({ ...base, source: 'manual-review' });
    assert.notEqual(operational.id, manual.id);
    const service = new CandidateService(repository);
    assert.throws(() => service.registerManualReview('repo-1', { scope: 'repository' }, {
      selectedSession: 'review-session',
      candidates: [{ id: 'manual-2', sessionId: 'review-session', findingId: 'finding-2', state: 'candidate',
        kind: 'failure', statement: 'Safe candidate' }],
      reviewRequired: [{ state: 'review-required', rootCauseId: 'bad-root', findingIds: [], recommendation: 'Inspect' }]
    }), /Review-required finding IDs/);
    assert.equal(repository.list('repo-1').length, 2);
    repository.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AAP read contract excludes unreviewed, unverified and contradicted rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'acl-verified-'));
  try {
    const path = join(root, 'experience.sqlite');
    const repository = new CandidateRepository(path);
    const candidate = repository.register({ repositoryId: 'repo-1', kind: 'project-fact',
      applicability: { scope: 'subproject', path: 'packages/mobile' },
      propositionKey: 'uses-pnpm', originId: 'session:finding', source: 'manual-review', statement: 'Uses pnpm' });
    assert.deepEqual(repository.listVerifiedLocalEntries('repo-1'), []);
    repository.close();
    const database = new DatabaseSync(path);
    database.prepare("UPDATE acl_candidates SET state = 'verified', verified_at = ? WHERE id = ?")
      .run('2026-09-30T00:00:00.000Z', candidate.id);
    database.prepare(`INSERT INTO acl_candidate_reviews
      (id, candidate_id, revision, from_state, to_state, actor_id, evidence_id, evidence_origin_id,
       evidence_kind, verification_evidence_id, context_revision, operation_signature, reviewed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('review-1', candidate.id, 1,
        'confirmed', 'verified', 'reviewer-1', 'evidence-1', 'session-1', 'deterministic-fact',
        null, 'agents-sha256:abc', null, '2026-09-30T00:00:00.000Z');
    database.close();
    let reopened = new CandidateRepository(path);
    assert.deepEqual(reopened.listVerifiedLocalEntries('repo-1'), []);
    reopened.close();
    const qualified = new DatabaseSync(path);
    qualified.prepare('UPDATE acl_candidate_reviews SET verification_evidence_id = ? WHERE id = ?').run('evidence-1', 'review-1');
    qualified.close();
    reopened = new CandidateRepository(path);
    assert.equal(reopened.listVerifiedLocalEntries('repo-1')[0]?.candidateId, candidate.id);
    reopened.close();
    const contradicted = new DatabaseSync(path);
    contradicted.prepare("UPDATE acl_candidates SET contradiction_state = 'disputed' WHERE id = ?").run(candidate.id);
    contradicted.close();
    reopened = new CandidateRepository(path);
    assert.deepEqual(reopened.listVerifiedLocalEntries('repo-1'), []);
    reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ACL-A1 keeps ambiguous review-required output outside candidates and backfills operational rows idempotently', () => {
  const root = mkdtempSync(join(tmpdir(), 'acl-backfill-'));
  try {
    const path = join(root, 'experience.sqlite');
    const database = new DatabaseSync(path);
    database.exec(`CREATE TABLE operational_episodes (id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, session_id TEXT NOT NULL);
      CREATE TABLE operational_candidates (id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, kind TEXT NOT NULL,
        state TEXT NOT NULL, statement TEXT NOT NULL, conditions_json TEXT NOT NULL, procedure_json TEXT NOT NULL,
        invalidation_json TEXT NOT NULL);`);
    database.prepare('INSERT INTO operational_episodes VALUES (?, ?, ?)').run('episode-1', 'repo-1', 'session-1');
    database.prepare('INSERT INTO operational_candidates VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('legacy-candidate-1', 'episode-1', 'convention', 'candidate', 'Use pnpm', '["pnpm"]', '["pnpm install"]', '[]');
    database.close();
    let repository = new CandidateRepository(path);
    const service = new CandidateService(repository);
    assert.equal(service.backfillOperational('repo-1'), 1);
    assert.equal(service.backfillOperational('repo-1'), 0);
    service.registerManualReview('repo-1', { scope: 'repository' }, {
      selectedSession: 'review-session', candidates: [],
      reviewRequired: [{ state: 'review-required', rootCauseId: 'unknown-root', findingIds: ['legacy-1'], recommendation: 'Inspect source' }]
    });
    repository.close();
    repository = new CandidateRepository(path);
    assert.equal(repository.list('repo-1').length, 1);
    assert.equal(repository.list('repo-1')[0]?.state, 'candidate');
    assert.deepEqual(repository.listReviewRequired('repo-1').map((finding) => finding.rootCauseId), ['unknown-root']);
    assert.equal(repository.listReviewRequired('other-repo').length, 0);
    repository.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
