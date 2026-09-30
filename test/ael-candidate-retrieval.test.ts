import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CandidateRepository } from '../src/knowledge/candidate-repository.js';
import { CandidateService } from '../src/knowledge/candidate-service.js';

test('ACL-A4 accepted local entry keeps canonical ID and state, with scope and terminal filtering', () => {
  const root = mkdtempSync(join(tmpdir(), 'acl-retrieve-'));
  try {
    const repository = new CandidateRepository(join(root, 'experience.sqlite'));
    const candidate = repository.register({ repositoryId: 'repo-1', kind: 'convention',
      applicability: { scope: 'subproject', path: 'packages/mobile', conditions: ['pnpm'] },
      propositionKey: 'package-manager-pnpm', originId: 'episode-1', source: 'operational', statement: 'Use pnpm' });
    const evidence = { id: 'observation-1', repositoryId: 'repo-1', originId: 'session-2', kind: 'observation' as const };
    const service = new CandidateService(repository, { resolve: () => evidence });
    const context = { scope: 'subproject' as const, path: 'packages/mobile', conditions: ['pnpm', 'node'] };
    assert.deepEqual(service.listAcceptedLocalEntries('repo-1', context), []);
    service.review({ repositoryId: 'repo-1', candidateId: candidate.id, target: 'observed',
      actorId: 'reviewer-1', evidenceId: evidence.id, reviewedAt: '2026-09-30T10:00:00.000Z' });
    assert.equal(service.listAcceptedLocalEntries('repo-1', context)[0]?.id, candidate.id);
    assert.equal(service.listAcceptedLocalEntries('repo-1', context)[0]?.state, 'observed');
    assert.deepEqual(service.listAcceptedLocalEntries('repo-1', { ...context, path: 'packages/backend' }), []);
    assert.deepEqual(service.listAcceptedLocalEntries('repo-1', { ...context, conditions: ['node'] }), []);
    assert.deepEqual(service.listAcceptedLocalEntries('other-repo', context), []);
    repository.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
