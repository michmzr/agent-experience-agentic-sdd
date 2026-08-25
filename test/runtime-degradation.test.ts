import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeProfile, RuntimeRule } from '../src/runtime/contracts.js';
import { createRuleIndex } from '../src/runtime/rule-index.js';
import { ResilientRuntime } from '../src/runtime/resilience.js';
import { compileRuntimeSnapshot } from '../src/runtime/snapshot.js';

const profile: RuntimeProfile = { id: 'normal', hardBlocking: true, warningsEnabled: true, captureEnabled: true, retrievalEnabled: true, degradedOutcomes: { normal: 'ALLOW', caution: 'WARN', protected: 'BLOCK' } };
const rule: RuntimeRule = { id: 'rule', state: 'verified', authoritative: true, effect: 'conflict', signature: { kind: 'action', tool: 'git', action: 'push' }, applicability: { scope: 'global' }, reference: { knowledgeId: 'knowledge', evidenceIds: ['evidence'] } };
const snapshot = compileRuntimeSnapshot({ repositoryId: 'repo', generatedAt: '2026-08-25T00:00:00.000Z', globalRules: [rule] });

test('uses in-memory, current, LKG, then exact profile degraded outcomes', () => {
  const inMemory = new ResilientRuntime({ profile, currentIndex: createRuleIndex(snapshot), loadCurrent: () => { throw new Error('unused'); }, loadLastKnownGood: () => { throw new Error('unused'); } });
  assert.equal(inMemory.resolve('normal').source, 'memory');

  const current = new ResilientRuntime({ profile, loadCurrent: () => snapshot, loadLastKnownGood: () => { throw new Error('unused'); } });
  assert.equal(current.resolve('normal').source, 'snapshot');

  const lkg = new ResilientRuntime({ profile, loadCurrent: () => { throw new Error('broken'); }, loadLastKnownGood: () => snapshot });
  assert.equal(lkg.resolve('normal').source, 'last-known-good');

  const degraded = new ResilientRuntime({ profile, loadCurrent: () => { throw new Error('broken'); }, loadLastKnownGood: () => { throw new Error('broken'); } });
  assert.equal(degraded.resolve('normal').outcome, 'ALLOW');
  assert.equal(degraded.resolve('caution').outcome, 'WARN');
  assert.equal(degraded.resolve('protected').outcome, 'BLOCK');
});

test('emits one degraded diagnostic and resets suppression after recovery', () => {
  let healthy = false;
  const diagnostics: string[] = [];
  const runtime = new ResilientRuntime({ profile, circuit: { failureThreshold: 1, resetAfterMs: 0 }, loadCurrent: () => { if (!healthy) throw new Error('broken'); return snapshot; }, loadLastKnownGood: () => { throw new Error('broken'); }, onDiagnostic: (message) => diagnostics.push(message) });
  runtime.resolve('normal');
  runtime.resolve('normal');
  assert.equal(diagnostics.length, 1);
  healthy = true;
  assert.equal(runtime.resolve('normal').source, 'snapshot');
  healthy = false;
  runtime.clearCurrent();
  runtime.resolve('normal');
  assert.equal(diagnostics.length, 2);
});

test('reports health, profile, hard blocking, retrieval, source, and circuit state', () => {
  const runtime = new ResilientRuntime({ profile, loadCurrent: () => snapshot, loadLastKnownGood: () => { throw new Error('unused'); } });
  const result = runtime.resolve('normal');
  assert.deepEqual(result.status, { health: 'healthy', profileId: 'normal', hardBlocking: true, retrievalMode: 'deterministic', fallbackSource: 'snapshot', circuitState: 'closed' });
});

test('does not convert programming errors after retrieval into storage degradation', () => {
  const runtime = new ResilientRuntime({ profile, currentIndex: createRuleIndex(snapshot), loadCurrent: () => snapshot, loadLastKnownGood: () => snapshot });
  const result = runtime.resolve('normal');
  assert.throws(() => result.index?.match({ operationClass: 'normal', signature: { kind: 'action', tool: 'git', action: 'push', path: 'C:relative' } }));
});

test('always fails open for ordinary degraded operations even if a custom profile is misconfigured to block them', () => {
  const strictNormal: RuntimeProfile = { ...profile, degradedOutcomes: { ...profile.degradedOutcomes, normal: 'BLOCK' } };
  const runtime = new ResilientRuntime({ profile: strictNormal, loadCurrent: () => { throw new Error('broken'); }, loadLastKnownGood: () => { throw new Error('broken'); } });
  assert.equal(runtime.resolve('normal').outcome, 'ALLOW');
});
