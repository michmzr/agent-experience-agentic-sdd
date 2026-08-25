import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { RuntimeService, RuntimeServiceError } from '../src/application/runtime-service.js';
import { runCli } from '../src/cli.js';
import type { RuntimeRule } from '../src/runtime/contracts.js';
import { compileRuntimeSnapshot } from '../src/runtime/snapshot.js';
import { RuntimeSnapshotStore } from '../src/storage/runtime-snapshot-store.js';

const action = {
  repositoryId: 'repo-a', operationClass: 'protected',
  signature: { kind: 'action', tool: 'git', action: 'push', arguments: ['--force'] }
} as const;

function blockingSnapshot(repositoryId = 'repo-a') {
  const rule: RuntimeRule = {
    id: `block-${repositoryId}`, state: 'verified', authoritative: true, effect: 'conflict', signature: action.signature,
    applicability: { scope: 'repository', repositoryId }, reference: { knowledgeId: `knowledge-${repositoryId}`, evidenceIds: [] }
  };
  return compileRuntimeSnapshot({ repositoryId, generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule] });
}

test('reports degraded status without creating a missing snapshot', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-runtime-status-'));
  try {
    const result = runCli(['runtime', 'status', '--json', '--data-dir', dataDir]);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      health: 'degraded', profileId: 'normal', hardBlocking: true,
      retrievalMode: 'degraded', fallbackSource: 'degraded-policy', circuitState: 'closed'
    });
    assert.equal(runCli(['runtime', 'status', '--data-dir', dataDir]).stdout, 'Runtime degraded; profile normal; fallback degraded-policy; circuit closed.\n');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
test('reports a healthy current snapshot after evaluation initialized it', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-runtime-status-'));
  const input = join(dataDir, 'action.json');
  try {
    writeFileSync(input, JSON.stringify({ operationClass: 'normal', signature: { kind: 'intent', verb: 'read', target: 'status' } }));
    assert.equal(runCli(['runtime', 'evaluate', '--input', input, '--data-dir', dataDir]).exitCode, 0);

    const status = JSON.parse(runCli(['runtime', 'status', '--json', '--data-dir', dataDir]).stdout);
    assert.deepEqual(status, {
      health: 'healthy', profileId: 'normal', hardBlocking: true,
      retrievalMode: 'deterministic', fallbackSource: 'snapshot', circuitState: 'closed'
    });
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('retains a healthy in-memory runtime after the persisted manifest becomes corrupt', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-runtime-status-'));
  const input = join(dataDir, 'action.json');
  try {
    writeFileSync(input, JSON.stringify(action));
    new RuntimeSnapshotStore(join(dataDir, 'runtime'), { clock: Date.now }).publish(blockingSnapshot());
    const service = new RuntimeService({ dataDir });
    assert.equal(service.evaluate({ inputPath: input }).status.fallbackSource, 'snapshot');
    writeFileSync(join(dataDir, 'runtime', 'manifest.json'), '{"corrupt":true}', { mode: 0o600 });

    const decision = service.evaluate({ inputPath: input });
    assert.equal(decision.outcome, 'BLOCK');
    assert.equal(decision.status.fallbackSource, 'memory');
    assert.equal(service.status().fallbackSource, 'memory');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('retains circuit state per profile and opens after repeated unavailable loads', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-runtime-status-'));
  const input = join(dataDir, 'action.json');
  try {
    mkdirSync(join(dataDir, 'runtime'));
    writeFileSync(join(dataDir, 'runtime', 'manifest.json'), '{"corrupt":true}', { mode: 0o600 });
    writeFileSync(input, JSON.stringify(action));
    const service = new RuntimeService({ dataDir });

    service.evaluate({ inputPath: input, profileId: 'normal' });
    service.evaluate({ inputPath: input, profileId: 'normal' });
    assert.equal(service.evaluate({ inputPath: input, profileId: 'normal' }).status.circuitState, 'open');
    assert.equal(service.status().circuitState, 'open');
    assert.equal(service.evaluate({ inputPath: input, profileId: 'learning' }).status.circuitState, 'closed');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('keeps the prior cached runtime when explicit refresh fails', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-runtime-status-'));
  const input = join(dataDir, 'action.json');
  try {
    writeFileSync(input, JSON.stringify(action));
    new RuntimeSnapshotStore(join(dataDir, 'runtime'), { clock: Date.now }).publish(blockingSnapshot());
    let failRefresh = false;
    const service = new RuntimeService({ dataDir, refreshSnapshot: (_input, current) => {
      if (failRefresh) throw new TypeError('refresh implementation failed');
      return current ?? blockingSnapshot();
    } });
    assert.equal(service.evaluate({ inputPath: input }).outcome, 'BLOCK');
    failRefresh = true;

    assert.throws(() => service.evaluate({ inputPath: input, refresh: true }), (error) => error instanceof RuntimeServiceError && error.code === 'RUNTIME_UNAVAILABLE');
    assert.equal(service.evaluate({ inputPath: input }).status.fallbackSource, 'memory');
    assert.equal(service.evaluate({ inputPath: input }).outcome, 'BLOCK');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('replaces every profile cache for a target only after successful explicit refresh', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-runtime-status-'));
  const input = join(dataDir, 'action.json');
  try {
    writeFileSync(input, JSON.stringify(action));
    new RuntimeSnapshotStore(join(dataDir, 'runtime'), { clock: Date.now }).publish(blockingSnapshot());
    let empty = false;
    const service = new RuntimeService({ dataDir, refreshSnapshot: (runtimeInput, current) => empty
      ? compileRuntimeSnapshot({ repositoryId: runtimeInput.repositoryId!, generatedAt: '2026-08-25T00:00:01.000Z' })
      : current ?? blockingSnapshot() });
    assert.equal(service.evaluate({ inputPath: input, profileId: 'normal' }).outcome, 'BLOCK');
    assert.equal(service.evaluate({ inputPath: input, profileId: 'learning' }).outcome, 'WARN');
    empty = true;

    const refreshed = service.evaluate({ inputPath: input, profileId: 'normal', refresh: true });
    assert.equal(refreshed.outcome, 'ALLOW');
    assert.equal(refreshed.status.fallbackSource, 'memory');
    assert.equal(service.evaluate({ inputPath: input, profileId: 'learning' }).outcome, 'ALLOW');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
