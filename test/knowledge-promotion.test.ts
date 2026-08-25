import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { evaluatePromotion, promoteKnowledge } from '../src/shared-knowledge/promotion-policy.js';
import { readSharedKnowledge, type SharedKnowledgeDocument } from '../src/shared-knowledge/repository.js';

process.env.AEL_DATA_DIR = mkdtempSync(join(tmpdir(), 'ael-promotion-state-'));

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

test('cannot bypass approval by labeling a preference as code-tool-confirmed', () => {
  const preference = candidate({ kind: 'preference', instructionOrigin: 'code-tool-confirmed' });
  assert.equal(evaluatePromotion(preference).eligible, false);
  assert.equal(evaluatePromotion(preference).approvalRequired, true);
  const inconsistentWorkflow = candidate({ kind: 'successful-workflow', instructionOrigin: 'user-preference' });
  assert.equal(evaluatePromotion(inconsistentWorkflow).eligible, false);
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

test('serializes competing child-process promotions without lost updates', async () => {
  const repository = mkdtempSync(join(tmpdir(), 'ael-promotion-'));
  const stateRoots = [mkdtempSync(join(tmpdir(), 'ael-promotion-private-a-')), mkdtempSync(join(tmpdir(), 'ael-promotion-private-b-'))];
  const moduleUrl = new URL('../src/shared-knowledge/promotion-policy.js', import.meta.url).href;
  const script = `
    import { promoteKnowledge } from ${JSON.stringify(moduleUrl)};
    const [repository, stateRoot, identity] = process.argv.slice(1);
    promoteKnowledge(repository, {
      identity, repositoryScope: 'repository:test', kind: 'project-fact', state: 'confirmed',
      applicability: { paths: [], tags: [], tools: [] }, instructionOrigin: 'code-tool-confirmed', supersedes: [],
      title: identity, context: 'Concurrent promotion.', lesson: 'A deterministic fact.', recommendedBehavior: 'Keep both facts.',
      evidenceSummary: 'Deterministic code inspection confirmed this.',
      evidence: [{ kind: 'code-or-tool', summary: 'code', deterministic: true }]
    }, { stateRoot, beforePrimaryPublication: () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75) });
  `;
  const runWithState = (identity: string, stateRoot: string) => new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, repository, stateRoot, identity], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(stderr)));
  });

  await Promise.all([runWithState('child-one', stateRoots[0]!), runWithState('child-two', stateRoots[1]!)]);
  assert.deepEqual(readSharedKnowledge(repository, { stateRoot: stateRoots[0] }).map((entry) => entry.identity), ['child-one', 'child-two']);
});
