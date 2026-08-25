import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeProfile, RuntimeRule } from '../src/runtime/contracts.js';
import { createRuleIndex } from '../src/runtime/rule-index.js';
import { ResilientRuntime, RuntimeSnapshotUnavailableError } from '../src/runtime/resilience.js';
import { compileRuntimeSnapshot } from '../src/runtime/snapshot.js';

const profile: RuntimeProfile = { id: 'normal', hardBlocking: true, warningsEnabled: true, captureEnabled: true, retrievalEnabled: true, degradedOutcomes: { normal: 'ALLOW', caution: 'WARN', protected: 'BLOCK' } };
const rule: RuntimeRule = { id: 'rule', state: 'verified', authoritative: true, effect: 'conflict', signature: { kind: 'action', tool: 'git', action: 'push' }, applicability: { scope: 'global' }, reference: { knowledgeId: 'knowledge', evidenceIds: ['evidence'] } };
const snapshot = compileRuntimeSnapshot({ repositoryId: 'repo', generatedAt: '2026-08-25T00:00:00.000Z', globalRules: [rule] });
const unavailable = (): never => { throw new RuntimeSnapshotUnavailableError('unavailable'); };
const clock = (): number => 0;

test('uses in-memory, current, LKG, then exact profile degraded outcomes', () => {
  const inMemory = new ResilientRuntime({ profile, clock, currentIndex: createRuleIndex(snapshot), loadCurrent: unavailable, loadLastKnownGood: unavailable });
  assert.equal(inMemory.resolve('normal').source, 'memory');

  const current = new ResilientRuntime({ profile, clock, loadCurrent: () => snapshot, loadLastKnownGood: unavailable });
  assert.equal(current.resolve('normal').source, 'snapshot');

  const lkg = new ResilientRuntime({ profile, clock, loadCurrent: unavailable, loadLastKnownGood: () => snapshot });
  assert.equal(lkg.resolve('normal').source, 'last-known-good');

  const degraded = new ResilientRuntime({ profile, clock, loadCurrent: unavailable, loadLastKnownGood: unavailable });
  assert.equal(degraded.resolve('normal').outcome, 'ALLOW');
  assert.equal(degraded.resolve('caution').outcome, 'WARN');
  assert.equal(degraded.resolve('protected').outcome, 'BLOCK');
});

test('emits one degraded diagnostic and resets suppression after recovery', () => {
  let healthy = false;
  const diagnostics: string[] = [];
  const runtime = new ResilientRuntime({ profile, clock, circuit: { failureThreshold: 1, resetAfterMs: 0 }, loadCurrent: () => { if (!healthy) return unavailable(); return snapshot; }, loadLastKnownGood: unavailable, onDiagnostic: (message) => diagnostics.push(message) });
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
  const runtime = new ResilientRuntime({ profile, clock, loadCurrent: () => snapshot, loadLastKnownGood: unavailable });
  const result = runtime.resolve('normal');
  assert.deepEqual(result.status, { health: 'healthy', profileId: 'normal', hardBlocking: true, retrievalMode: 'deterministic', fallbackSource: 'snapshot', circuitState: 'closed' });
});

test('does not convert programming errors after retrieval into storage degradation', () => {
  const runtime = new ResilientRuntime({ profile, clock, currentIndex: createRuleIndex(snapshot), loadCurrent: () => snapshot, loadLastKnownGood: () => snapshot });
  const result = runtime.resolve('normal');
  assert.throws(() => result.index?.match({ operationClass: 'normal', signature: { kind: 'action', tool: 'git', action: 'push', path: 'C:relative' } }));
});

test('always fails open for ordinary degraded operations even if a custom profile is misconfigured to block them', () => {
  const strictNormal: RuntimeProfile = { ...profile, degradedOutcomes: { ...profile.degradedOutcomes, normal: 'BLOCK' } };
  const runtime = new ResilientRuntime({ profile: strictNormal, clock, loadCurrent: unavailable, loadLastKnownGood: unavailable });
  assert.equal(runtime.resolve('normal').outcome, 'ALLOW');
});

test('propagates TypeError and arbitrary programming exceptions from both loaders', () => {
  for (const loaders of [
    { loadCurrent: (): never => { throw new TypeError('current bug'); }, loadLastKnownGood: unavailable },
    { loadCurrent: unavailable, loadLastKnownGood: (): never => { throw new TypeError('LKG bug'); } },
    { loadCurrent: (): never => { throw new Error('current programmer bug'); }, loadLastKnownGood: unavailable }
  ]) {
    const runtime = new ResilientRuntime({ profile, clock, ...loaders });
    assert.throws(() => runtime.resolve('normal'), /bug/);
  }
});
