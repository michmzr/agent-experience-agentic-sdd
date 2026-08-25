import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuleMatch, RuntimeProfile, RuntimeRule } from '../src/runtime/contracts.js';
import { evaluateRule } from '../src/runtime/policy.js';

const normalProfile: RuntimeProfile = {
  id: 'normal',
  hardBlocking: true,
  warningsEnabled: true,
  captureEnabled: true,
  retrievalEnabled: true,
  degradedOutcomes: { normal: 'ALLOW', caution: 'WARN', protected: 'BLOCK' }
};

const learningProfile: RuntimeProfile = {
  ...normalProfile,
  id: 'learning',
  hardBlocking: false
};

function rule(overrides: Partial<RuntimeRule & { match: RuleMatch['strength'] }> = {}): RuleMatch {
  const strength = overrides.match ?? 'exact';
  const runtimeRule: RuntimeRule = {
    id: 'rule-1',
    state: 'verified',
    authoritative: true,
    effect: 'conflict',
    signature: {
      kind: 'action',
      tool: 'git',
      action: 'push',
      arguments: ['--force'],
      path: '/workspace/project'
    },
    applicability: {
      scope: 'repository',
      repositoryId: 'repository-1',
      tool: 'git',
      path: '/workspace/project'
    },
    reference: {
      knowledgeId: 'knowledge-1',
      evidenceIds: ['evidence-1']
    },
    ...overrides
  };
  delete (runtimeRule as RuntimeRule & { match?: RuleMatch['strength'] }).match;

  return { rule: runtimeRule, strength, operationClass: 'normal' };
}

test('verified authoritative exact conflicts block in the normal profile', () => {
  const decision = evaluateRule(rule(), normalProfile);

  assert.equal(decision.outcome, 'BLOCK');
  assert.equal(decision.explanation.code, 'VERIFIED_EXACT_CONFLICT');
  assert.equal(decision.references[0]?.ruleId, 'rule-1');
});

test('learning downgrades a verified authoritative exact conflict and keeps capture and retrieval enabled', () => {
  const decision = evaluateRule(rule(), learningProfile);

  assert.equal(decision.outcome, 'WARN');
  assert.equal(decision.captureEnabled, true);
  assert.equal(decision.retrievalEnabled, true);
  assert.equal(decision.explanation.code, 'HARD_BLOCKING_DISABLED');
});

test('verified metadata conflicts and confirmed authoritative conflicts warn', () => {
  assert.equal(evaluateRule(rule({ match: 'metadata' }), normalProfile).outcome, 'WARN');
  assert.equal(evaluateRule(rule({ state: 'confirmed' }), normalProfile).outcome, 'WARN');
});

test('verified authoritative tag-only conflicts warn with a truthful tag reason in every enforcing profile', () => {
  for (const profile of [normalProfile, learningProfile]) {
    const decision = evaluateRule(rule({ match: 'tags' }), profile);

    assert.equal(decision.outcome, 'WARN');
    assert.equal(decision.explanation.code, 'VERIFIED_TAG_CONFLICT');
  }
});

test('observed and disputed rules are contextual only', () => {
  for (const state of ['observed', 'disputed'] as const) {
    const decision = evaluateRule(rule({ state }), normalProfile);

    assert.equal(decision.outcome, 'ALLOW');
    assert.equal(decision.explanation.code, 'CONTEXT_ONLY');
  }
});

test('non-authoritative and non-conflicting rules are contextual only', () => {
  assert.equal(evaluateRule(rule({ authoritative: false }), normalProfile).outcome, 'ALLOW');
  assert.equal(evaluateRule(rule({ effect: 'context' }), normalProfile).outcome, 'ALLOW');
});

test('candidate and terminal states do not enforce', () => {
  for (const state of ['candidate', 'superseded', 'rejected', 'expired'] as const) {
    const decision = evaluateRule(rule({ state }), normalProfile);

    assert.equal(decision.outcome, 'ALLOW');
    assert.equal(decision.explanation.code, 'INACTIVE_RULE');
  }
});

test('profile warning controls can make warning-level matches observe-only', () => {
  const observeOnly: RuntimeProfile = {
    ...normalProfile,
    id: 'observe-only',
    hardBlocking: false,
    warningsEnabled: false
  };
  const decision = evaluateRule(rule({ state: 'confirmed' }), observeOnly);

  assert.equal(decision.outcome, 'ALLOW');
  assert.equal(decision.explanation.code, 'WARNINGS_DISABLED');
});

test('runtime profile represents degraded behavior for protected operations without applying it in rule policy', () => {
  assert.equal(normalProfile.degradedOutcomes.protected, 'BLOCK');
  assert.equal(evaluateRule(rule({ state: 'confirmed' }), normalProfile).outcome, 'WARN');
});
