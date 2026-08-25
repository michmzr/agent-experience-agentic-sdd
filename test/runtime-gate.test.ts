import assert from 'node:assert/strict';
import test from 'node:test';

import { LEARNING_PROFILE, NORMAL_PROFILE } from '../src/config/runtime-profile.js';
import type { RuntimeInput, RuntimeRule } from '../src/runtime/contracts.js';
import { createRuntimeGate } from '../src/runtime/gate.js';
import { createRuleIndex } from '../src/runtime/rule-index.js';
import type { RuntimeStatus } from '../src/runtime/resilience.js';
import { compileRuntimeSnapshot } from '../src/runtime/snapshot.js';

const action: RuntimeInput = {
  repositoryId: 'repo-1',
  operationClass: 'protected',
  tags: ['deployment'],
  signature: { kind: 'action', tool: 'git', action: 'push', arguments: ['--force'], path: '/workspace/repo' }
};
const intent: RuntimeInput = {
  repositoryId: 'repo-1',
  operationClass: 'caution',
  signature: { kind: 'intent', verb: 'publish', target: 'release', tool: 'git' }
};

function rule(id: string, overrides: Partial<RuntimeRule> = {}): RuntimeRule {
  const signature = action.signature.kind === 'action'
    ? { ...action.signature, arguments: [...(action.signature.arguments ?? [])] }
    : { ...action.signature };
  return {
    id,
    state: 'verified',
    authoritative: true,
    effect: 'conflict',
    signature,
    applicability: { scope: 'repository', repositoryId: 'repo-1' },
    reference: { knowledgeId: `knowledge-${id}`, evidenceIds: [`evidence-${id}`] },
    ...overrides
  };
}

function status(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    health: 'healthy',
    profileId: 'normal',
    hardBlocking: true,
    retrievalMode: 'deterministic',
    fallbackSource: 'memory',
    circuitState: 'closed',
    ...overrides
  };
}

function index(rules: readonly RuntimeRule[]) {
  const repositoryRules = rules.filter(({ state, authoritative }) => state !== 'observed' && state !== 'disputed' && authoritative);
  const contextRules = rules.filter(({ state, authoritative }) => state === 'observed' || state === 'disputed' || !authoritative);
  return createRuleIndex(compileRuntimeSnapshot({
    repositoryId: 'repo-1', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules, contextRules
  }));
}

test('aggregates the strongest outcome and retains every explanation in stable match order', () => {
  const rules = [
    rule('z-warn', { state: 'confirmed', applicability: { scope: 'repository', repositoryId: 'repo-1', tool: 'git' }, signature: { kind: 'action', tool: 'git', action: 'fetch' } }),
    rule('b-block'),
    rule('a-block'),
    rule('context', { state: 'disputed' })
  ];
  const gate = createRuntimeGate({ index: index(rules), profile: NORMAL_PROFILE, status: status() });

  const decision = gate.evaluate(action);

  assert.equal(decision.outcome, 'BLOCK');
  assert.deepEqual(decision.explanations.map(({ ruleId, outcome }) => [ruleId, outcome]), [
    ['a-block', 'BLOCK'], ['b-block', 'BLOCK'], ['context', 'ALLOW'], ['z-warn', 'WARN']
  ]);
  assert.deepEqual(decision.references.map(({ ruleId }) => ruleId), ['a-block', 'b-block', 'context', 'z-warn']);
  assert.equal(JSON.parse(JSON.stringify(decision)).outcome, 'BLOCK');
  assert.match(decision.inputBinding, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(decision), true);
  assert.equal(Object.isFrozen(decision.explanations), true);
});

test('evaluates structured intent and returns ALLOW with no fabricated explanation when nothing matches', () => {
  const intentRule = rule('intent', { signature: intent.signature, applicability: { scope: 'repository', repositoryId: 'repo-1' } });
  const gate = createRuntimeGate({ index: index([intentRule]), profile: NORMAL_PROFILE, status: status() });

  const intentDecision = gate.evaluate(intent);
  assert.equal(intentDecision.outcome, 'BLOCK');
  assert.notEqual(intentDecision.inputBinding, gate.evaluate(action).inputBinding);
  assert.deepEqual(gate.evaluate({ ...intent, signature: { ...intent.signature, target: 'draft' } }).explanations, []);
});

test('uses only captured values after construction and performs no storage or Git access', () => {
  const immutableIndex = index([rule('rule')]);
  const gate = createRuntimeGate({ index: immutableIndex, profile: NORMAL_PROFILE, status: status() });
  const before = process.getActiveResourcesInfo().length;

  assert.equal(gate.evaluate(action).outcome, 'BLOCK');
  assert.equal(gate.evaluate(action).outcome, 'BLOCK');
  assert.equal(process.getActiveResourcesInfo().length, before);
});

test('applies learning downgrade and keeps disputed rules nonblocking', () => {
  const gate = createRuntimeGate({ index: index([rule('block'), rule('disputed', { state: 'disputed' })]), profile: LEARNING_PROFILE, status: status({ profileId: 'learning', hardBlocking: false }) });

  const decision = gate.evaluate(action);
  assert.equal(decision.outcome, 'WARN');
  assert.deepEqual(decision.explanations.map(({ outcome }) => outcome), ['WARN', 'ALLOW']);
  assert.equal(decision.captureEnabled, true);
  assert.equal(decision.retrievalEnabled, true);
});

test('applies explicit profile degradation and fails open only for ordinary operations', () => {
  const gate = createRuntimeGate({ profile: NORMAL_PROFILE, status: status({ health: 'degraded', retrievalMode: 'degraded', fallbackSource: 'degraded-policy' }) });

  assert.equal(gate.evaluate({ ...action, operationClass: 'normal' }).outcome, 'ALLOW');
  assert.equal(gate.evaluate({ ...action, operationClass: 'caution' }).outcome, 'WARN');
  const protectedDecision = gate.evaluate(action);
  assert.equal(protectedDecision.outcome, 'BLOCK');
  assert.deepEqual(protectedDecision.explanations.map(({ code }) => code), ['DEGRADED_POLICY']);
});

test('rejects inconsistent resolved status instead of silently changing enforcement', () => {
  assert.throws(
    () => createRuntimeGate({ index: index([]), profile: NORMAL_PROFILE, status: status({ profileId: 'learning' }) }),
    /profile/i
  );
  assert.throws(
    () => createRuntimeGate({ index: index([]), profile: NORMAL_PROFILE, status: status({ retrievalMode: 'degraded', fallbackSource: 'degraded-policy' }) }),
    /index/i
  );
  assert.throws(
    () => createRuntimeGate({ profile: NORMAL_PROFILE, status: status({ retrievalMode: 'degraded', fallbackSource: 'degraded-policy' }) }),
    /health/i
  );
});
