import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { normalizeMappedCapture } from '../src/capture/normalization.js';
import { runCli } from '../src/cli.js';
import type { RepositoryId, SessionId } from '../src/domain/types.js';
import { CandidateRepository } from '../src/knowledge/candidate-repository.js';
import { conventionPropositionKey, SqliteCandidateEvidenceResolver } from '../src/knowledge/evidence-resolver.js';
import { resolveRepository } from '../src/repository/local-repository.js';
import { ExperienceStore } from '../src/storage/experience-store.js';

test('ACL-A3 public staged review resolves stored witnesses and rejects a forged verification', () => {
  const root = mkdtempSync(join(tmpdir(), 'acl-public-review-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const repositoryId = resolveRepository(root)!.id as RepositoryId;
    const path = join(root, 'experience.sqlite');
    const store = new ExperienceStore(path);
    store.registerRepository({ id: repositoryId, root, observedAt: '2026-09-30T10:00:00.000Z' });
    const events = ['session-a', 'session-b'].map((session, index) => {
      const sessionId = session as SessionId;
      store.appendIncremental({ session: { id: sessionId, source: 'codex', repositoryId,
        startedAt: `2026-09-30T10:00:0${index}.000Z` } });
      const event = normalizeMappedCapture({ source: 'codex', sourceEventId: `operation-${index}`,
        sessionId, phase: 'pre-action', occurredAt: `2026-09-30T10:00:0${index}.000Z`,
        tool: 'shell', action: 'install', summary: 'Install.' });
      store.appendIncremental({ event });
      if (index === 0) store.preserveOperationInstructionContext(event, {
        instructions: [{ location: 'AGENTS.md', scope: 'repository', found: true, delivered: 'unknown',
          explicitlyRead: 'unknown', digest: 'a'.repeat(64), evidenceId: 'instruction-context:AGENTS.md' }],
        conventions: [{ tool: 'pnpm', replaces: 'npm', source: 'AGENTS.md:1', digest: 'a'.repeat(64) }],
        scopedConventions: [], unresolvedScopes: [] });
      return event;
    });
    store.close();
    const repository = new CandidateRepository(path);
    const candidate = repository.register({ repositoryId, kind: 'convention', source: 'manual-review',
      originId: 'manual-a', propositionKey: conventionPropositionKey('pnpm', 'npm'),
      applicability: { scope: 'repository' }, statement: 'Use pnpm.' });
    repository.close();
    const resolver = new SqliteCandidateEvidenceResolver(path, 'session-a');
    const instructionId = resolver.listInstructionContextEvidence(repositoryId)[0]!.id;
    resolver.close();
    const inputPath = join(root, 'review.json');
    const review = (sessionId: string, target: string, evidenceId: string) => {
      writeFileSync(inputPath, JSON.stringify({ candidateId: candidate.id, sessionId, target,
        actorId: 'reviewer', evidenceId, reviewedAt: '2026-09-30T10:00:05.000Z' }));
      return runCli(['candidates', 'review', '--repository-id', repositoryId, '--input', inputPath,
        '--data-dir', root, '--json'], { workingDirectory: root });
    };
    assert.equal(review('session-a', 'verified', instructionId).exitCode, 1);
    assert.equal(review('session-a', 'observed', events[0]!.id).exitCode, 0);
    assert.equal(review('session-a', 'confirmed', events[0]!.id).exitCode, 1);
    assert.equal(review('session-b', 'confirmed', events[1]!.id).exitCode, 0);
    assert.equal(review('session-a', 'verified', 'forged-instruction').exitCode, 1);
    const verified = review('session-a', 'verified', instructionId);
    assert.equal(verified.exitCode, 0, verified.stdout);
    assert.equal(JSON.parse(verified.stdout).state, 'verified');
    assert.equal(review('session-a', 'verified', instructionId).exitCode, 0);
    assert.equal(runCli(['candidates', 'inspect', candidate.id, '--repository-id', repositoryId,
      '--data-dir', root, '--json']).stdout.includes('session-a'), false);
    const backfill = (mode: 'preview' | 'apply') => runCli(['candidates', 'backfill', mode,
      '--repository-id', repositoryId, '--data-dir', root, '--json'], { workingDirectory: root });
    assert.deepEqual(JSON.parse(backfill('preview').stdout), { processed: 0, pendingCount: 0, nextCursor: null });
    assert.deepEqual(JSON.parse(backfill('apply').stdout), { processed: 0, pendingCount: 0, nextCursor: null });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
