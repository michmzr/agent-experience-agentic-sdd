import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { evaluatePromotion, promoteKnowledge } from '../src/shared-knowledge/promotion-policy.js';
import { readSharedKnowledge, type SharedKnowledgeDocument } from '../src/shared-knowledge/repository.js';

function candidate(overrides: Partial<SharedKnowledgeDocument> = {}): SharedKnowledgeDocument {
  return {
    identity: 'fact', repositoryScope: 'repository:test', kind: 'project-fact', state: 'confirmed',
    applicability: { paths: [], tags: [], tools: [] }, instructionOrigin: 'code-tool-confirmed', supersedes: [],
    title: 'Package manager', context: 'Repository commands.', lesson: 'pnpm is configured.',
    recommendedBehavior: 'Use pnpm.', evidenceSummary: 'package.json packageManager was read deterministically.',
    evidence: [{ kind: 'code-or-tool', summary: 'package.json packageManager field', deterministic: true }],
    ...overrides
  };
}

test('allows code or tool confirmed facts with deterministic evidence', () => {
  assert.deepEqual(evaluatePromotion(candidate()), { eligible: true, approvalRequired: false, reasons: ['deterministic code/tool evidence'] });
});

test('requires recorded approval for preferences and skill workflow candidates', () => {
  const preference = candidate({ instructionOrigin: 'user-preference', kind: 'preference' });
  const skill = candidate({ instructionOrigin: 'skill-workflow-candidate', kind: 'successful-workflow' });
  assert.equal(evaluatePromotion(preference).eligible, false);
  assert.equal(evaluatePromotion(preference).approvalRequired, true);
  assert.equal(evaluatePromotion({ ...preference, approval: { kind: 'user', at: '2026-08-25T10:00:00.000Z' } }).eligible, true);
  assert.equal(evaluatePromotion(skill).eligible, false);
  assert.equal(evaluatePromotion({ ...skill, approval: { kind: 'user', at: '2026-08-25T10:00:00.000Z' } }).eligible, true);
});

test('rejects task constraints, disputed entries, and missing evidence', () => {
  assert.equal(evaluatePromotion(candidate({ instructionOrigin: 'task-specific-constraint' })).eligible, false);
  assert.equal(evaluatePromotion(candidate({ state: 'disputed' })).eligible, false);
  assert.equal(evaluatePromotion(candidate({ evidence: [] })).eligible, false);
});

test('promotion writes local review files and rejects asserted merge activation', () => {
  const repository = mkdtempSync(join(tmpdir(), 'ael-promotion-'));
  assert.throws(() => promoteKnowledge(repository, { ...candidate(), activation: 'merged-team-active' }), /activation/i);
  assert.throws(() => promoteKnowledge(repository, { ...candidate(), mergedProvenance: 'caller supplied' }), /provenance/i);
  const promoted = promoteKnowledge(repository, candidate());
  assert.equal(promoted.activation, 'local');
});

test('promotion upserts without removing existing branch-local review files', () => {
  const repository = mkdtempSync(join(tmpdir(), 'ael-promotion-'));
  promoteKnowledge(repository, candidate({ identity: 'first' }));
  promoteKnowledge(repository, candidate({ identity: 'second' }));
  assert.deepEqual(readSharedKnowledge(repository).map((entry) => entry.identity), ['first', 'second']);
});
