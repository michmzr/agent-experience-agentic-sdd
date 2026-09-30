import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { normalizeMappedCapture } from '../src/capture/normalization.js';
import type { RepositoryId, SessionId } from '../src/domain/types.js';
import { conventionPropositionKey, SqliteCandidateEvidenceResolver } from '../src/knowledge/evidence-resolver.js';
import { recordPackageManagerFact } from '../src/knowledge/package-manager-fact.js';
import { CandidateRepository } from '../src/knowledge/candidate-repository.js';
import { ExperienceStore } from '../src/storage/experience-store.js';

test('persisted instruction directive qualifies only its own proposition and scope after restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'acl-instruction-'));
  try {
    const dbPath = join(root, 'experience.sqlite');
    const store = new ExperienceStore(dbPath);
    const repositoryId = 'repo-1' as RepositoryId; const sessionId = 'session-1' as SessionId;
    store.registerRepository({ id: repositoryId, root, observedAt: '2026-09-30T10:00:00.000Z' });
    store.appendIncremental({ session: { id: sessionId, source: 'codex', repositoryId, startedAt: '2026-09-30T10:00:00.000Z' } });
    const event = normalizeMappedCapture({ source: 'codex', sourceEventId: 'op-1', sessionId,
      phase: 'pre-action', occurredAt: '2026-09-30T10:00:01.000Z', tool: 'shell', action: 'install', summary: 'Install.' });
    store.appendIncremental({ event });
    const digest = 'a'.repeat(64);
    store.preserveOperationInstructionContext(event, {
      instructions: [{ location: 'AGENTS.md', scope: 'repository', found: true, delivered: 'unknown', explicitlyRead: 'unknown',
        digest, evidenceId: 'instruction-context:AGENTS.md' }],
      conventions: [], scopedConventions: [{ tool: 'pnpm', replaces: 'npm', source: 'AGENTS.md:1', digest,
        qualifier: 'mobile app', scopePath: 'mobile' }], unresolvedScopes: [] });
    store.close();
    const resolver = new SqliteCandidateEvidenceResolver(dbPath, sessionId);
    const evidence = resolver.listInstructionContextEvidence(repositoryId);
    assert.equal(evidence.length, 1);
    assert.deepEqual(evidence[0]?.applicability, { scope: 'subproject', path: 'mobile' });
    const witness = resolver.resolve(repositoryId, evidence[0]!.id);
    assert.equal(witness?.kind, 'instruction-context');
    assert.equal(witness?.propositionKey, conventionPropositionKey('pnpm', 'npm'));
    resolver.close();

    const repository = new CandidateRepository(dbPath);
    const allowed = repository.register({ repositoryId, kind: 'convention', applicability: { scope: 'subproject', path: 'mobile' },
      propositionKey: conventionPropositionKey('pnpm', 'npm'), originId: 'origin-a', source: 'manual-review', statement: 'Use pnpm' });
    const wrongScope = repository.register({ repositoryId, kind: 'convention', applicability: { scope: 'subproject', path: 'backend' },
      propositionKey: conventionPropositionKey('pnpm', 'npm'), originId: 'origin-b', source: 'manual-review', statement: 'Use pnpm' });
    const wrongDirective = repository.register({ repositoryId, kind: 'convention', applicability: { scope: 'subproject', path: 'mobile' },
      propositionKey: conventionPropositionKey('uv', 'pip'), originId: 'origin-c', source: 'manual-review', statement: 'Use uv' });
    for (const candidate of [allowed, wrongScope, wrongDirective]) {
      repository.review({ repositoryId, candidateId: candidate.id, target: 'observed', actorId: 'reviewer',
        evidenceId: event.id, reviewedAt: '2026-09-30T10:00:03.000Z' }, { id: event.id, repositoryId,
        originId: 'session-1', kind: 'observation' });
      repository.review({ repositoryId, candidateId: candidate.id, target: 'confirmed', actorId: 'reviewer',
        evidenceId: `confirm-${candidate.id}`, reviewedAt: '2026-09-30T10:00:04.000Z' }, { id: `confirm-${candidate.id}`,
        repositoryId, originId: 'session-2', kind: 'observation' });
    }
    assert.equal(repository.review({ repositoryId, candidateId: allowed.id, target: 'verified', actorId: 'reviewer',
      evidenceId: evidence[0]!.id, reviewedAt: '2026-09-30T10:00:05.000Z' }, witness!).state, 'verified');
    for (const candidate of [wrongScope, wrongDirective]) assert.throws(() => repository.review({ repositoryId,
      candidateId: candidate.id, target: 'verified', actorId: 'reviewer', evidenceId: evidence[0]!.id,
      reviewedAt: '2026-09-30T10:00:05.000Z' }, witness!), /convention witness/i);
    repository.close();
    const database = new DatabaseSync(dbPath);
    database.prepare('UPDATE capture_instruction_contexts SET payload_json = ? WHERE source_event_id = ?')
      .run(JSON.stringify({ instructions: [], conventions: [], scopedConventions: [], unresolvedScopes: [] }), 'op-1');
    database.close();
    const altered = new SqliteCandidateEvidenceResolver(dbPath, sessionId);
    assert.equal(altered.resolve(repositoryId, evidence[0]!.id), undefined);
    altered.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('packageManager fact uses a tracked bounded file and rejects changed or foreign scope', () => {
  const root = mkdtempSync(join(tmpdir(), 'acl-package-fact-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    mkdirSync(join(root, 'mobile'));
    const packagePath = join(root, 'mobile', 'package.json');
    writeFileSync(packagePath, JSON.stringify({ name: 'mobile-app', privateToken: 'secret-token-value', packageManager: 'pnpm@10.0.0' }));
    execFileSync('git', ['-C', root, 'add', 'mobile/package.json']);
    const dbPath = join(root, 'experience.sqlite');
    const store = new ExperienceStore(dbPath);
    const repositoryId = 'repo-1' as RepositoryId; const sessionId = 'session-1' as SessionId;
    store.registerRepository({ id: repositoryId, root, observedAt: '2026-09-30T10:00:00.000Z' });
    store.appendIncremental({ session: { id: sessionId, source: 'codex', repositoryId, startedAt: '2026-09-30T10:00:00.000Z' } });
    store.close();
    const fact = recordPackageManagerFact(dbPath, repositoryId, sessionId, { scope: 'subproject', path: 'mobile' });
    assert.equal(fact.factKey, 'package-manager:pnpm@10.0.0');
    const resolver = new SqliteCandidateEvidenceResolver(dbPath, sessionId);
    const witness = resolver.resolve(repositoryId, fact.evidenceId);
    assert.equal(witness?.kind, 'deterministic-fact');
    const repository = new CandidateRepository(dbPath);
    const matching = repository.register({ repositoryId, kind: 'project-fact', source: 'manual-review',
      originId: 'fact-origin-a', propositionKey: fact.factKey, applicability: fact.applicability,
      statement: 'mobile uses pnpm' });
    const wrongScope = repository.register({ repositoryId, kind: 'project-fact', source: 'manual-review',
      originId: 'fact-origin-b', propositionKey: fact.factKey, applicability: { scope: 'repository' },
      statement: 'repository uses pnpm' });
    for (const candidate of [matching, wrongScope]) {
      repository.review({ repositoryId, candidateId: candidate.id, target: 'observed', actorId: 'reviewer',
        evidenceId: `observe-${candidate.id}`, reviewedAt: '2026-09-30T10:00:01.000Z' }, {
        id: `observe-${candidate.id}`, repositoryId, originId: 'session-2', kind: 'observation' });
      repository.review({ repositoryId, candidateId: candidate.id, target: 'confirmed', actorId: 'reviewer',
        evidenceId: `confirm-${candidate.id}`, reviewedAt: '2026-09-30T10:00:02.000Z' }, {
        id: `confirm-${candidate.id}`, repositoryId, originId: 'session-3', kind: 'observation' });
    }
    assert.throws(() => repository.review({ repositoryId, candidateId: wrongScope.id, target: 'verified',
      actorId: 'reviewer', evidenceId: fact.evidenceId, reviewedAt: '2026-09-30T10:00:03.000Z' }, witness!), /scope/i);
    assert.equal(repository.review({ repositoryId, candidateId: matching.id, target: 'verified',
      actorId: 'reviewer', evidenceId: fact.evidenceId, reviewedAt: '2026-09-30T10:00:03.000Z' }, witness!).state, 'verified');
    repository.close();
    assert.equal(resolver.resolve('repo-2', fact.evidenceId), undefined);
    resolver.close();
    const wrongSession = new SqliteCandidateEvidenceResolver(dbPath, 'session-2');
    assert.equal(wrongSession.resolve(repositoryId, fact.evidenceId), undefined);
    wrongSession.close();
    writeFileSync(packagePath, JSON.stringify({ name: 'mobile-app', packageManager: 'npm@11.0.0' }));
    const changed = new SqliteCandidateEvidenceResolver(dbPath, sessionId);
    assert.equal(changed.resolve(repositoryId, fact.evidenceId), undefined);
    changed.close();
    writeFileSync(packagePath, JSON.stringify({ name: 'mobile-app', privateToken: 'secret-token-value', packageManager: 'pnpm@10.0.0' }));
    execFileSync('git', ['-C', root, 'rm', '--cached', '-q', 'mobile/package.json']);
    const untracked = new SqliteCandidateEvidenceResolver(dbPath, sessionId);
    assert.equal(untracked.resolve(repositoryId, fact.evidenceId), undefined);
    untracked.close();
    const db = new DatabaseSync(dbPath);
    const serialized = JSON.stringify(db.prepare('SELECT * FROM acl_package_manager_facts').all());
    assert.doesNotMatch(serialized, /mobile-app|secret-token-value|\/tmp\//);
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
