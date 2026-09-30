import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalCandidateIdentity, groupCandidateOrigins } from '../src/knowledge/candidate-identity.js';

test('ACL-A2 joins equivalent scoped keys across origins and separates incompatible candidates', () => {
  const base = {
    repositoryId: 'repository-1', kind: 'failure' as const,
    applicability: { scope: 'subproject' as const, path: 'packages/mobile', conditions: ['pnpm'] },
    propositionKey: 'install-dependencies', procedureKey: 'pnpm-install'
  };
  const first = { ...base, originId: 'session-1:episode-1' };
  const second = { ...base, originId: 'session-2:episode-5', applicability: { ...base.applicability, conditions: ['pnpm', 'pnpm'] } };
  const differentPath = { ...base, originId: 'session-3:episode-1', applicability: { ...base.applicability, path: 'packages/backend' } };
  const differentProcedure = { ...base, originId: 'session-4:episode-1', procedureKey: 'pnpm-install-frozen' };
  assert.equal(canonicalCandidateIdentity(first), canonicalCandidateIdentity(second));
  assert.notEqual(canonicalCandidateIdentity(first), canonicalCandidateIdentity(differentPath));
  assert.notEqual(canonicalCandidateIdentity(first), canonicalCandidateIdentity(differentProcedure));
  assert.notEqual(canonicalCandidateIdentity(first), canonicalCandidateIdentity({ ...base, originId: 'other-origin', repositoryId: 'repository-2' }));
  assert.notEqual(canonicalCandidateIdentity(first), canonicalCandidateIdentity({ ...base, originId: 'other-origin', kind: 'project-fact' }));
  const grouped = groupCandidateOrigins([first, second, differentPath, differentProcedure]);
  assert.equal(grouped.length, 3);
  assert.deepEqual(grouped.find((entry) => entry.identity === canonicalCandidateIdentity(first))?.originIds,
    ['session-1:episode-1', 'session-2:episode-5']);
  const unkeyed = { ...base, propositionKey: undefined, procedureKey: undefined };
  assert.notEqual(canonicalCandidateIdentity({ ...unkeyed, originId: 'session-1:episode-1' }),
    canonicalCandidateIdentity({ ...unkeyed, originId: 'session-2:episode-5' }));
  assert.throws(() => canonicalCandidateIdentity({ ...base, originId: 'unsafe', applicability: { scope: 'subproject', path: '../mobile' } }),
    /Invalid candidate subproject path/);
});
