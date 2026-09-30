import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CandidateRepository, type CandidateReviewWitness } from '../src/knowledge/candidate-repository.js';
import { CandidateService } from '../src/knowledge/candidate-service.js';

test('ACL-A3 rejects direct verification, duplicate confirmation and unverified repair, then preserves staged verification', () => {
  const root = mkdtempSync(join(tmpdir(), 'acl-review-'));
  try {
    const path = join(root, 'experience.sqlite');
    let repository = new CandidateRepository(path);
    const candidate = repository.register({ repositoryId: 'repo-1', kind: 'successful-workflow',
      applicability: { scope: 'subproject', path: 'packages/mobile', conditions: ['pnpm'] },
      propositionKey: 'install-dependencies', procedureKey: 'pnpm-install',
      originId: 'episode-1', source: 'operational', statement: 'Install with pnpm' });
    const witnesses = new Map<string, CandidateReviewWitness>([
      ['observe-a', { id: 'observe-a', repositoryId: 'repo-1', originId: 'session-a', kind: 'observation' }],
      ['confirm-a', { id: 'confirm-a', repositoryId: 'repo-1', originId: 'session-a', kind: 'observation' }],
      ['confirm-b', { id: 'confirm-b', repositoryId: 'repo-1', originId: 'session-b', kind: 'observation' }],
      ['unverified-repair', { id: 'unverified-repair', repositoryId: 'repo-1', originId: 'session-c', kind: 'observation' }],
      ['verified-repair', { id: 'verified-repair', repositoryId: 'repo-1', originId: 'session-c', kind: 'task-verification',
        taskId: 'task-1', procedureKey: 'pnpm-install', contextRevision: 'agents-sha256:abc',
        operationSignature: 'operation:v1:pnpm-install:mobile' }]
    ]);
    const service = new CandidateService(repository, { resolve: (_repo, id) => witnesses.get(id) });
    const request = { repositoryId: 'repo-1', candidateId: candidate.id, actorId: 'reviewer-1', reviewedAt: '2026-09-30T10:00:00.000Z' };
    assert.throws(() => service.review({ ...request, target: 'verified', evidenceId: 'verified-repair' }), /transition/i);
    assert.throws(() => service.review({ ...request, target: 'observed', evidenceId: 'unknown' }), /evidence/i);
    assert.equal(service.review({ ...request, target: 'observed', evidenceId: 'observe-a' }).state, 'observed');
    assert.throws(() => service.review({ ...request, target: 'confirmed', evidenceId: 'confirm-a' }), /independent/i);
    assert.equal(service.review({ ...request, target: 'confirmed', evidenceId: 'confirm-b' }).state, 'confirmed');
    assert.throws(() => service.review({ ...request, target: 'verified', evidenceId: 'unverified-repair' }), /verification/i);
    assert.equal(service.review({ ...request, target: 'verified', evidenceId: 'verified-repair' }).state, 'verified');
    repository.close();
    repository = new CandidateRepository(path);
    const verified = repository.listVerifiedLocalEntries('repo-1');
    assert.equal(verified.length, 1);
    assert.equal(verified[0]?.contextRevision, 'agents-sha256:abc');
    assert.equal(verified[0]?.verificationEvidenceId, 'verified-repair');
    assert.equal(verified[0]?.operationSignature, 'operation:v1:pnpm-install:mobile');
    assert.deepEqual(verified[0]?.applicability, { scope: 'subproject', path: 'packages/mobile', conditions: ['pnpm'] });
    repository.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ACL-A3 requires a witnessed project fact rather than a known event label', () => {
  const root = mkdtempSync(join(tmpdir(), 'acl-fact-'));
  try {
    const repository = new CandidateRepository(join(root, 'experience.sqlite'));
    const candidate = repository.register({ repositoryId: 'repo-1', kind: 'project-fact',
      applicability: { scope: 'repository' }, propositionKey: 'uses-pnpm',
      originId: 'review-finding', source: 'manual-review', statement: 'Project uses pnpm' });
    const witnesses = new Map<string, CandidateReviewWitness>([
      ['observe', { id: 'observe', repositoryId: 'repo-1', originId: 'session-a', kind: 'observation' }],
      ['confirm', { id: 'confirm', repositoryId: 'repo-1', originId: 'session-b', kind: 'observation' }],
      ['wrong-fact', { id: 'wrong-fact', repositoryId: 'repo-1', originId: 'session-c', kind: 'deterministic-fact',
        factKey: 'uses-npm', contextRevision: 'agents-sha256:abc' }],
      ['fact', { id: 'fact', repositoryId: 'repo-1', originId: 'session-c', kind: 'user-confirmed-fact',
        factKey: 'uses-pnpm', contextRevision: 'agents-sha256:abc' }]
    ]);
    const service = new CandidateService(repository, { resolve: (_repo, id) => witnesses.get(id) });
    const request = { repositoryId: 'repo-1', candidateId: candidate.id, actorId: 'reviewer-1', reviewedAt: '2026-09-30T10:00:00.000Z' };
    service.review({ ...request, target: 'observed', evidenceId: 'observe' });
    service.review({ ...request, target: 'confirmed', evidenceId: 'confirm' });
    assert.throws(() => service.review({ ...request, target: 'verified', evidenceId: 'wrong-fact' }), /fact witness/i);
    assert.equal(service.review({ ...request, target: 'verified', evidenceId: 'fact' }).state, 'verified');
    repository.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
