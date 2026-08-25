import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUILT_IN_RUNTIME_PROFILES,
  defineRuntimeProfiles,
  LEARNING_PROFILE,
  NORMAL_PROFILE,
  OBSERVE_ONLY_PROFILE
} from '../src/config/runtime-profile.js';
import type { RuleMatch } from '../src/runtime/contracts.js';
import { evaluateRule } from '../src/runtime/policy.js';

test('built-in profiles expose the normal, learning, and observe-only policies', () => {
  assert.deepEqual(NORMAL_PROFILE, {
    id: 'normal',
    hardBlocking: true,
    warningsEnabled: true,
    captureEnabled: true,
    retrievalEnabled: true,
    degradedOutcomes: { normal: 'ALLOW', caution: 'WARN', protected: 'BLOCK' }
  });
  assert.equal(LEARNING_PROFILE.hardBlocking, false);
  assert.equal(LEARNING_PROFILE.warningsEnabled, true);
  assert.equal(LEARNING_PROFILE.captureEnabled, true);
  assert.equal(LEARNING_PROFILE.retrievalEnabled, true);
  assert.equal(OBSERVE_ONLY_PROFILE.hardBlocking, false);
  assert.equal(OBSERVE_ONLY_PROFILE.warningsEnabled, false);
  assert.equal(OBSERVE_ONLY_PROFILE.captureEnabled, true);
  assert.equal(OBSERVE_ONLY_PROFILE.retrievalEnabled, true);
});

test('built-in profiles and degraded outcomes are deeply immutable', () => {
  assert.equal(Object.isFrozen(BUILT_IN_RUNTIME_PROFILES), true);
  for (const profile of Object.values(BUILT_IN_RUNTIME_PROFILES)) {
    assert.equal(Object.isFrozen(profile), true);
    assert.equal(Object.isFrozen(profile.degradedOutcomes), true);
  }
});

test('observe-only preserves capture, retrieval, and explanations while disabling enforcement', () => {
  const match: RuleMatch = {
    strength: 'exact',
    operationClass: 'protected',
    rule: {
      id: 'verified-conflict',
      state: 'verified',
      authoritative: true,
      effect: 'conflict',
      signature: { kind: 'action', tool: 'git', action: 'push' },
      applicability: { scope: 'global' },
      reference: { knowledgeId: 'knowledge-1', evidenceIds: ['evidence-1'] }
    }
  };

  const decision = evaluateRule(match, OBSERVE_ONLY_PROFILE);

  assert.equal(decision.outcome, 'ALLOW');
  assert.equal(decision.captureEnabled, true);
  assert.equal(decision.retrievalEnabled, true);
  assert.equal(decision.explanation.code, 'WARNINGS_DISABLED');
});

test('custom profiles inherit transitively and override declared runtime fields', () => {
  const profiles = defineRuntimeProfiles([
    { id: 'team-learning', extends: 'learning', warningsEnabled: false },
    {
      id: 'team-protected',
      extends: 'team-learning',
      degradedOutcomes: { normal: 'ALLOW', caution: 'WARN', protected: 'WARN' }
    }
  ]);

  assert.deepEqual(profiles['team-protected'], {
    id: 'team-protected',
    hardBlocking: false,
    warningsEnabled: false,
    captureEnabled: true,
    retrievalEnabled: true,
    degradedOutcomes: { normal: 'ALLOW', caution: 'WARN', protected: 'WARN' }
  });
  assert.equal(Object.isFrozen(profiles), true);
  assert.equal(Object.isFrozen(profiles['team-protected']), true);
  assert.equal(Object.isFrozen(profiles['team-protected']?.degradedOutcomes), true);
});

test('custom profile validation rejects invalid configuration', () => {
  const invalidDefinitions: readonly unknown[][] = [
    [{ id: 'missing', extends: 'unknown' }],
    [{ id: 'normal', extends: 'learning' }],
    [{ id: 'duplicate', extends: 'normal' }, { id: 'duplicate', extends: 'learning' }],
    [{ id: 'a', extends: 'b' }, { id: 'b', extends: 'a' }],
    [{ id: 'extra', extends: 'normal', invented: true }],
    [{ id: 'bad-boolean', extends: 'normal', captureEnabled: 'yes' }],
    [{ id: 'bad-outcome', extends: 'normal', degradedOutcomes: { normal: 'ALLOW', caution: 'WARN', protected: 'DENY' } }],
    [{ id: 'incomplete-outcomes', extends: 'normal', degradedOutcomes: { normal: 'ALLOW' } }],
    [{ id: 'no-capture-learning', extends: 'learning', captureEnabled: false }],
    [{ id: 'effective-learning', extends: 'normal', hardBlocking: false, captureEnabled: false }],
    [
      { id: 'learning-base', extends: 'learning' },
      { id: 'no-capture-descendant', extends: 'learning-base', captureEnabled: false }
    ]
  ];

  for (const definitions of invalidDefinitions) {
    assert.throws(() => defineRuntimeProfiles(definitions), Error);
  }
});
