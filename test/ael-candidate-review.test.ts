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
    assert.deepEqual(verified[0]?.supportingEvidenceIds, ['observe-a', 'confirm-b']);
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
    assert.equal(service.listVerifiedLocalEntries('repo-1')[0]?.operationSignature, null);
    repository.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ACL-A5 dispute suppresses advice until witnessed revalidation and keeps review history', () => {
  const root = mkdtempSync(join(tmpdir(), 'acl-dispute-'));
  try {
    const repository = new CandidateRepository(join(root, 'experience.sqlite'));
    const candidate = repository.register({ repositoryId: 'repo-1', kind: 'successful-workflow',
      applicability: { scope: 'repository' }, propositionKey: 'install', procedureKey: 'pnpm-install',
      originId: 'episode-1', source: 'operational', statement: 'Install with pnpm' });
    const witnesses = new Map<string, CandidateReviewWitness>([
      ['observe', { id: 'observe', repositoryId: 'repo-1', originId: 'session-a', kind: 'observation' }],
      ['confirm', { id: 'confirm', repositoryId: 'repo-1', originId: 'session-b', kind: 'observation' }],
      ['verify', { id: 'verify', repositoryId: 'repo-1', originId: 'session-c', kind: 'task-verification',
        taskId: 'task-1', procedureKey: 'pnpm-install', contextRevision: 'agents-sha256:a' }],
      ['contradict', { id: 'contradict', repositoryId: 'repo-1', originId: 'session-d', kind: 'contradiction' }],
      ['unlinked', { id: 'unlinked', repositoryId: 'repo-1', originId: 'session-e', kind: 'task-verification',
        taskId: 'task-2', procedureKey: 'pnpm-install', contextRevision: 'agents-sha256:b' }],
      ['revalidate', { id: 'revalidate', repositoryId: 'repo-1', originId: 'session-e', kind: 'task-verification',
        taskId: 'task-2', procedureKey: 'pnpm-install', contextRevision: 'agents-sha256:b',
        revalidatesCandidateId: candidate.id }]
    ]);
    const service = new CandidateService(repository, { resolve: (_repo, id) => witnesses.get(id) });
    const request = { repositoryId: 'repo-1', candidateId: candidate.id, actorId: 'reviewer-1', reviewedAt: '2026-09-30T10:00:00.000Z' };
    service.review({ ...request, target: 'observed', evidenceId: 'observe' });
    service.review({ ...request, target: 'confirmed', evidenceId: 'confirm' });
    service.review({ ...request, target: 'verified', evidenceId: 'verify' });
    assert.equal(service.listVerifiedLocalEntries('repo-1').length, 1);
    assert.equal(service.review({ ...request, target: 'disputed', evidenceId: 'contradict' }).state, 'disputed');
    assert.deepEqual(service.listVerifiedLocalEntries('repo-1'), []);
    assert.throws(() => service.review({ ...request, target: 'verified', evidenceId: 'unlinked' }), /revalidation/i);
    assert.equal(service.review({ ...request, target: 'verified', evidenceId: 'revalidate' }).state, 'verified');
    assert.equal(service.listVerifiedLocalEntries('repo-1')[0]?.contextRevision, 'agents-sha256:b');
    assert.deepEqual(service.history('repo-1', candidate.id).map((entry) => entry.to),
      ['observed', 'confirmed', 'verified', 'disputed', 'verified']);
    repository.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ACL-A5 changed procedure creates an explicit successor revision without rewriting the prior candidate', () => {
  const root = mkdtempSync(join(tmpdir(), 'acl-revision-'));
  try {
    const repository = new CandidateRepository(join(root, 'experience.sqlite'));
    const base = { repositoryId: 'repo-1', kind: 'successful-workflow' as const,
      applicability: { scope: 'subproject' as const, path: 'packages/mobile' },
      propositionKey: 'install', procedureKey: 'pnpm-install', originId: 'episode-1',
      source: 'operational' as const, statement: 'Install with pnpm' };
    const prior = repository.register(base);
    const witness: CandidateReviewWitness = { id: 'change-1', repositoryId: 'repo-1', originId: 'session-b', kind: 'observation' };
    const service = new CandidateService(repository, { resolve: () => witness });
    const successor = service.supersede({ repositoryId: 'repo-1', priorCandidateId: prior.id,
      replacement: { ...base, procedureKey: 'pnpm-install-frozen', originId: 'episode-2' },
      actorId: 'reviewer-1', evidenceId: 'change-1', reviewedAt: '2026-09-30T10:00:00.000Z' });
    assert.notEqual(successor.id, prior.id);
    assert.equal(successor.revision, 2);
    assert.equal(successor.supersedesId, prior.id);
    assert.equal(repository.inspect('repo-1', prior.id)?.state, 'superseded');
    assert.equal(repository.inspect('repo-1', prior.id)?.supersededById, successor.id);
    assert.deepEqual(repository.inspect('repo-1', prior.id)?.origins.map((origin) => origin.originId), ['episode-1']);
    assert.deepEqual(service.listAcceptedLocalEntries('repo-1', base.applicability), []);
    repository.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
