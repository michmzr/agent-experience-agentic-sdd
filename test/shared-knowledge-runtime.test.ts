import assert from 'node:assert/strict';
import test from 'node:test';

import type { ActivatedKnowledgeEntry } from '../src/shared-knowledge/git-activation.js';
import { compileActivatedRuntimeRules } from '../src/shared-knowledge/runtime-compiler.js';
import type { SharedKnowledgeDocument } from '../src/shared-knowledge/repository.js';

const commit = 'a'.repeat(40);

function document(identity: string, overrides: Partial<SharedKnowledgeDocument> = {}): SharedKnowledgeDocument {
  return {
    identity, repositoryScope: 'repository:repo-one', kind: 'failure', state: 'verified',
    applicability: { paths: [], tags: ['destructive'], tools: ['git'] },
    instructionOrigin: 'code-tool-confirmed', supersedes: [], title: identity, context: 'Repository command.',
    lesson: 'A structured command conflict.', recommendedBehavior: 'Do not repeat the command.',
    evidenceSummary: 'Verified by repository tests.',
    runtimeDirective: { effect: 'conflict', signature: { kind: 'action', tool: 'git', action: 'reset', arguments: ['--hard'] } },
    ...overrides
  };
}

function activated(documentValue: SharedKnowledgeDocument, overrides: Partial<ActivatedKnowledgeEntry> = {}): ActivatedKnowledgeEntry {
  return {
    document: documentValue,
    authoritative: true,
    provenance: { source: 'trusted-ref', commit },
    ...overrides
  };
}

test('compiles trusted enforcement and non-authoritative local context for the exact repository', () => {
  const entries: ActivatedKnowledgeEntry[] = [
    activated(document('verified-conflict')),
    activated(document('confirmed-context', {
      state: 'confirmed', runtimeDirective: { effect: 'context', signature: { kind: 'intent', verb: 'prepare', target: 'release', tool: 'pnpm' } },
      applicability: { paths: [], tags: [], tools: ['pnpm'] }
    })),
    activated(document('disputed-conflict', { state: 'disputed' })),
    activated(document('terminal', { state: 'superseded' })),
    activated(document('no-directive', { runtimeDirective: undefined })),
    activated(document('wrong-repository', { repositoryScope: 'repository:repo-two' })),
    activated(document('local-context'), { authoritative: false, provenance: { source: 'working-tree' } }),
    activated(document('local-disputed', { state: 'disputed' }), { authoritative: false, provenance: { source: 'working-tree' } }),
    activated(document('local-terminal', { state: 'superseded' }), { authoritative: false, provenance: { source: 'working-tree' } }),
    activated(document('verified-conflict', { repositoryScope: 'repository:repo-two' }), { authoritative: false, provenance: { source: 'working-tree' } })
  ];

  const rules = compileActivatedRuntimeRules({ repositoryId: 'repo-one', trustedCommit: commit, entries });

  assert.deepEqual(rules.map(({ id, state, effect }) => [id, state, effect]), [
    ['shared:confirmed-context', 'confirmed', 'context'],
    ['shared:disputed-conflict', 'disputed', 'context'],
    ['shared:local-context', 'verified', 'context'],
    ['shared:local-disputed', 'disputed', 'context'],
    ['shared:verified-conflict', 'verified', 'conflict']
  ]);
  assert.deepEqual(rules[2], {
    id: 'shared:local-context', state: 'verified', authoritative: false, effect: 'context',
    signature: { kind: 'action', tool: 'git', action: 'reset', arguments: ['--hard'] },
    applicability: { scope: 'repository', repositoryId: 'repo-one', tool: 'git', tags: ['destructive'] },
    reference: { knowledgeId: 'local-context', evidenceIds: [], source: 'working-tree' }
  });
  assert.deepEqual(rules[4], {
    id: 'shared:verified-conflict', state: 'verified', authoritative: true, effect: 'conflict',
    signature: { kind: 'action', tool: 'git', action: 'reset', arguments: ['--hard'] },
    applicability: { scope: 'repository', repositoryId: 'repo-one', tool: 'git', tags: ['destructive'] },
    reference: { knowledgeId: 'verified-conflict', evidenceIds: [], source: `trusted-ref:${commit}` }
  });
  assert.equal(Object.isFrozen(rules), true);
  assert.equal(Object.isFrozen(rules[4]?.signature), true);
  assert.equal(Object.isFrozen(rules[4]?.applicability.tags), true);
});

test('is deterministic and rejects forged commit, scope, applicability, and private directives', () => {
  const valid = activated(document('stable'));
  const first = compileActivatedRuntimeRules({ repositoryId: 'repo-one', trustedCommit: commit, entries: [valid] });
  const second = compileActivatedRuntimeRules({ repositoryId: 'repo-one', trustedCommit: commit, entries: [valid] });
  assert.deepEqual(second, first);

  assert.throws(() => compileActivatedRuntimeRules({ repositoryId: 'repo-one', trustedCommit: 'not-a-commit', entries: [valid] }), /commit/i);
  assert.throws(() => compileActivatedRuntimeRules({
    repositoryId: 'repo-one', trustedCommit: commit,
    entries: [activated(document('wrong-tool', { applicability: { paths: [], tags: [], tools: ['pnpm'] } }))]
  }), /applicability|tool/i);
  assert.throws(() => compileActivatedRuntimeRules({
    repositoryId: 'repo-one', trustedCommit: commit,
    entries: [activated(document('private', {
      runtimeDirective: { effect: 'conflict', signature: { kind: 'action', tool: 'git', action: 'push', arguments: ['--token=private-value'] } }
    }))]
  }), /private|credential|sanitized/i);
});
