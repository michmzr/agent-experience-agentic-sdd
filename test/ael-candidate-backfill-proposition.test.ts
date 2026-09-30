import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { normalizeMappedCapture } from '../src/capture/normalization.js';
import { CandidateRepository } from '../src/knowledge/candidate-repository.js';
import { SqliteCandidateEvidenceResolver } from '../src/knowledge/evidence-resolver.js';
import { ExperienceStore } from '../src/storage/experience-store.js';

test('ACL-A7 backfill binds convention only to matching persisted instruction evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'acl-backfill-proposition-'));
  const path = join(root, 'experience.sqlite');
  const repositoryId = 'repo-a' as never; const sessionId = 'session-a' as never;
  try {
    const store = new ExperienceStore(path);
    store.registerRepository({ id: repositoryId, root, observedAt: '2026-09-30T10:00:00.000Z' });
    store.appendIncremental({ session: { id: sessionId, source: 'codex', repositoryId, startedAt: '2026-09-30T10:00:00.000Z' } });
    const request = normalizeMappedCapture({ source: 'codex', sourceEventId: 'operation-a', sessionId,
      phase: 'pre-action', occurredAt: '2026-09-30T10:00:01.000Z', tool: 'shell', action: 'install', summary: 'Install.' });
    store.appendIncremental({ event: request });
    store.preserveOperationInstructionContext(request, { instructions: [{ location: 'AGENTS.md', scope: 'repository',
      found: true, delivered: 'unknown', explicitlyRead: 'unknown', digest: 'a'.repeat(64), evidenceId: 'instruction-context:AGENTS.md' }],
    conventions: [{ tool: 'pnpm', replaces: 'npm', source: 'AGENTS.md:1', digest: 'a'.repeat(64) }],
    scopedConventions: [], unresolvedScopes: [] });
    store.close();
    const db = new DatabaseSync(path);
    try {
      db.exec(`CREATE TABLE operational_episodes (id TEXT PRIMARY KEY, repository_id TEXT, session_id TEXT, detector TEXT, state TEXT, evidence_json TEXT, payload_json TEXT);
        CREATE TABLE operational_candidates (id TEXT PRIMARY KEY, episode_id TEXT, kind TEXT, state TEXT, statement TEXT, conditions_json TEXT, procedure_json TEXT, invalidation_json TEXT);
        CREATE TABLE operational_candidate_evidence (candidate_id TEXT, event_id TEXT, polarity TEXT);`);
      db.prepare("INSERT INTO operational_episodes VALUES ('episode-a', ?, ?, 'conventions-v1', 'solution-supported', '[]', '{}')")
        .run(repositoryId, sessionId);
      for (const [id, statement] of [['matching', 'Use pnpm instead of npm in this repository.'],
        ['unmatched', 'Use uv instead of pip in this repository.'],
        ['contradicted', 'Use pnpm instead of npm in this repository.']]) {
        db.prepare("INSERT INTO operational_candidates VALUES (?, 'episode-a', 'convention', 'candidate', ?, '[]', '[]', '[]')")
          .run(id, statement);
        db.prepare('INSERT INTO operational_candidate_evidence VALUES (?, ?, ?)')
          .run(id, 'instruction:AGENTS.md:1', id === 'contradicted' ? 'contradicts' : 'confirms');
      }
    } finally { db.close(); }
    const candidates = new CandidateRepository(path);
    assert.equal(candidates.backfillOperational(repositoryId), 3);
    const match = candidates.list(repositoryId).find(candidate => candidate.origins.some(origin => origin.originId === 'matching'))!;
    const mismatch = candidates.list(repositoryId).find(candidate => candidate.statement.startsWith('Use uv'))!;
    const contradicted = candidates.list(repositoryId).find(candidate => candidate.origins.some(origin => origin.originId === 'contradicted'))!;
    assert.notEqual(contradicted.id, match.id);
    const resolver = new SqliteCandidateEvidenceResolver(path, sessionId);
    const evidenceId = resolver.listInstructionContextEvidence(repositoryId)[0]!.id;
    const witness = resolver.resolve(repositoryId, evidenceId)!;
    assert.equal(candidates.review({ repositoryId, candidateId: match.id, target: 'observed', actorId: 'reviewer',
      evidenceId: request.id, reviewedAt: '2026-09-30T10:00:02.000Z' }, resolver.resolve(repositoryId, request.id)!).state, 'observed');
    assert.throws(() => candidates.review({ repositoryId, candidateId: mismatch.id, target: 'verified', actorId: 'reviewer',
      evidenceId, reviewedAt: '2026-09-30T10:00:03.000Z' }, witness));
    assert.throws(() => candidates.review({ repositoryId, candidateId: contradicted.id, target: 'verified', actorId: 'reviewer',
      evidenceId, reviewedAt: '2026-09-30T10:00:03.000Z' }, witness));
    assert.equal(candidates.review({ repositoryId, candidateId: match.id, target: 'confirmed', actorId: 'reviewer',
      evidenceId: 'second-event', reviewedAt: '2026-09-30T10:00:03.000Z' }, {
        id: 'second-event', repositoryId, originId: 'session-b', kind: 'observation' }).state, 'confirmed');
    assert.equal(candidates.review({ repositoryId, candidateId: match.id, target: 'verified', actorId: 'reviewer',
      evidenceId, reviewedAt: '2026-09-30T10:00:04.000Z' }, witness).state, 'verified');
    resolver.close(); candidates.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
