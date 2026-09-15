import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  runtimeTargetSnapshotDirectory, RuntimeActiveTargetPointerError, RuntimeService, RuntimeServiceError
} from '../src/application/runtime-service.js';
import { runCli } from '../src/cli.js';
import type { RuntimeRule } from '../src/runtime/contracts.js';
import { compileRuntimeSnapshot, RuntimeSnapshotValidationError } from '../src/runtime/snapshot.js';
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
    assert.equal(runCli(['runtime', 'status', '--data-dir', dataDir]).stdout, [
      'Runtime status  [degraded]',
      '',
      'Profile   normal',
      'Fallback  degraded-policy',
      'Circuit   closed',
      ''
    ].join('\n'));
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

test('cached evaluation and status reach memory without an orchestration storage pre-read', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-runtime-status-'));
  const input = join(dataDir, 'action.json');
  try {
    writeFileSync(input, JSON.stringify(action));
    const backing = new RuntimeSnapshotStore(join(dataDir, 'runtime'), { clock: Date.now });
    backing.publish(blockingSnapshot());
    let currentLoads = 0;
    let lastKnownGoodLoads = 0;
    const store = {
      paths: backing.paths,
      publish: (snapshot: Parameters<RuntimeSnapshotStore['publish']>[0]) => backing.publish(snapshot),
      loadCurrent: () => { currentLoads += 1; return backing.loadCurrent(); },
      loadLastKnownGood: () => { lastKnownGoodLoads += 1; return backing.loadLastKnownGood(); }
    };
    const service = new RuntimeService({ dataDir, snapshotStore: store });
    assert.equal(service.evaluate({ inputPath: input }).status.fallbackSource, 'snapshot');
    const before = { currentLoads, lastKnownGoodLoads };
    writeFileSync(backing.paths.manifest, '{"corrupt":true}', { mode: 0o600 });

    assert.equal(service.evaluate({ inputPath: input }).status.fallbackSource, 'memory');
    assert.equal(service.status().fallbackSource, 'memory');
    assert.deepEqual({ currentLoads, lastKnownGoodLoads }, before);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('retains circuit state per profile and opens after repeated unavailable loads', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-runtime-status-'));
  const input = join(dataDir, 'action.json');
  try {
    const runtimeDirectory = runtimeTargetSnapshotDirectory(dataDir, 'repo-a');
    mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(runtimeDirectory, 'manifest.json'), '{"corrupt":true}', { mode: 0o600 });
    writeFileSync(input, JSON.stringify(action));
    const service = new RuntimeService({ dataDir });

    service.evaluate({ inputPath: input, profileId: 'normal' });
    service.evaluate({ inputPath: input, profileId: 'normal' });
    assert.equal(service.evaluate({ inputPath: input, profileId: 'normal' }).status.circuitState, 'open');
    assert.equal(service.status().circuitState, 'open');
    assert.equal(service.evaluate({ inputPath: input, profileId: 'learning' }).status.circuitState, 'closed');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('an open cached circuit suppresses loaders and orchestration pre-reads', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-runtime-status-'));
  const input = join(dataDir, 'action.json');
  try {
    mkdirSync(join(dataDir, 'runtime'));
    writeFileSync(join(dataDir, 'runtime', 'manifest.json'), '{"corrupt":true}', { mode: 0o600 });
    writeFileSync(input, JSON.stringify(action));
    const backing = new RuntimeSnapshotStore(join(dataDir, 'runtime'), { clock: Date.now });
    let currentLoads = 0;
    let lastKnownGoodLoads = 0;
    const store = {
      paths: backing.paths,
      publish: (snapshot: Parameters<RuntimeSnapshotStore['publish']>[0]) => backing.publish(snapshot),
      loadCurrent: () => { currentLoads += 1; return backing.loadCurrent(); },
      loadLastKnownGood: () => { lastKnownGoodLoads += 1; return backing.loadLastKnownGood(); }
    };
    const service = new RuntimeService({ dataDir, snapshotStore: store });
    service.evaluate({ inputPath: input });
    service.evaluate({ inputPath: input });
    assert.equal(service.evaluate({ inputPath: input }).status.circuitState, 'open');
    const before = { currentLoads, lastKnownGoodLoads };

    assert.equal(service.evaluate({ inputPath: input }).status.circuitState, 'open');
    assert.equal(service.status().circuitState, 'open');
    assert.deepEqual({ currentLoads, lastKnownGoodLoads }, before);
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

test('validates the target cache capacity bounds', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-runtime-status-'));
  try {
    for (const runtimeTargetCapacity of [0, -1, 1.5, 257, Number.NaN]) {
      assert.throws(() => new RuntimeService({ dataDir, runtimeTargetCapacity }), /capacity/i);
    }
    assert.doesNotThrow(() => new RuntimeService({ dataDir, runtimeTargetCapacity: 1 }));
    assert.doesNotThrow(() => new RuntimeService({ dataDir, runtimeTargetCapacity: 256 }));
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('evicts targets in deterministic LRU order and reloads evicted snapshots durably', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-runtime-status-'));
  const inputs = ['repo-a', 'repo-b', 'repo-c'].map((repositoryId) => {
    const path = join(dataDir, `${repositoryId}.json`);
    writeFileSync(path, JSON.stringify({ ...action, repositoryId }));
    return { repositoryId, path };
  });
  try {
    const service = new RuntimeService({ dataDir, runtimeTargetCapacity: 2, refreshSnapshot: (input, current) => current ?? blockingSnapshot(input.repositoryId) });
    assert.equal(service.evaluate({ inputPath: inputs[0]!.path }).status.fallbackSource, 'memory');
    assert.equal(service.evaluate({ inputPath: inputs[1]!.path }).status.fallbackSource, 'memory');
    assert.equal(service.evaluate({ inputPath: inputs[0]!.path }).status.fallbackSource, 'memory');
    assert.equal(service.evaluate({ inputPath: inputs[2]!.path }).status.fallbackSource, 'memory');

    assert.equal(service.evaluate({ inputPath: inputs[0]!.path }).status.fallbackSource, 'memory');
    const reloaded = service.evaluate({ inputPath: inputs[1]!.path });
    assert.equal(reloaded.outcome, 'BLOCK');
    assert.equal(reloaded.status.fallbackSource, 'snapshot');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('counts all profiles for one repository as one LRU target', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-runtime-status-'));
  const inputA = join(dataDir, 'repo-a.json');
  const inputB = join(dataDir, 'repo-b.json');
  try {
    writeFileSync(inputA, JSON.stringify(action));
    writeFileSync(inputB, JSON.stringify({ ...action, repositoryId: 'repo-b' }));
    const service = new RuntimeService({ dataDir, runtimeTargetCapacity: 2, refreshSnapshot: (input, current) => current ?? blockingSnapshot(input.repositoryId) });
    service.evaluate({ inputPath: inputA, profileId: 'normal' });
    service.evaluate({ inputPath: inputB, profileId: 'normal' });
    service.evaluate({ inputPath: inputA, profileId: 'learning' });

    assert.equal(service.evaluate({ inputPath: inputB, profileId: 'normal' }).status.fallbackSource, 'memory');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('restart defers corrupt current recovery to last-known-good for status and evaluation', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-runtime-status-'));
  const input = join(dataDir, 'action.json');
  try {
    writeFileSync(input, JSON.stringify(action));
    let empty = false;
    const emptySnapshot = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:01.000Z' });
    const service = new RuntimeService({ dataDir, refreshSnapshot: (runtimeInput) => empty
      ? emptySnapshot
      : blockingSnapshot(runtimeInput.repositoryId) });
    assert.equal(service.evaluate({ inputPath: input }).outcome, 'BLOCK');
    empty = true;
    const current = service.evaluate({ inputPath: input, refresh: true });
    assert.equal(current.outcome, 'ALLOW');
    const store = new RuntimeSnapshotStore(runtimeTargetSnapshotDirectory(dataDir, 'repo-a'), { clock: Date.now });
    writeFileSync(store.generationPath(emptySnapshot.checksum), '{"corrupt":true}', { mode: 0o600 });

    const restarted = new RuntimeService({ dataDir });
    assert.equal(restarted.status().fallbackSource, 'last-known-good');
    const recovered = new RuntimeService({ dataDir }).evaluate({ inputPath: input });
    assert.equal(recovered.outcome, 'BLOCK');
    assert.equal(recovered.status.fallbackSource, 'last-known-good');

    const refreshed = new RuntimeService({ dataDir, clock: () => new Date('2026-08-25T00:00:02.000Z') })
      .evaluate({ inputPath: input, refresh: true });
    assert.equal(refreshed.outcome, 'BLOCK');
    assert.equal(refreshed.status.health, 'healthy');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('explicit refresh recovers an initial corrupt generation only from a same-target candidate', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-runtime-status-'));
  const input = join(dataDir, 'action.json');
  try {
    writeFileSync(input, JSON.stringify(action));
    const targetStore = new RuntimeSnapshotStore(runtimeTargetSnapshotDirectory(dataDir, 'repo-a'), { clock: Date.now });
    const first = blockingSnapshot();
    targetStore.publish(first);
    writeFileSync(targetStore.generationPath(first.checksum), '{broken', { mode: 0o600 });

    const wrongTarget = new RuntimeService({ dataDir, refreshSnapshot: () => compileRuntimeSnapshot({
      repositoryId: 'repo-b', generatedAt: '2026-08-25T00:00:01.000Z'
    }) });
    assert.throws(() => wrongTarget.evaluate({ inputPath: input, refresh: true }), RuntimeServiceError);
    assert.throws(() => targetStore.loadCurrent());

    const refreshed = new RuntimeService({ dataDir, refreshSnapshot: () => compileRuntimeSnapshot({
      repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:02.000Z'
    }) }).evaluate({ inputPath: input, refresh: true });
    assert.equal(refreshed.outcome, 'ALLOW');
    assert.equal(refreshed.status.health, 'healthy');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('explicit refresh proceeds when orchestration cannot validate current', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-runtime-status-'));
  const input = join(dataDir, 'action.json');
  try {
    writeFileSync(input, JSON.stringify(action));
    const snapshot = blockingSnapshot();
    let published = false;
    const store = {
      paths: { root: join(dataDir, 'runtime'), manifest: join(dataDir, 'runtime', 'manifest.json'), rollbackManifest: join(dataDir, 'runtime', 'rollback-manifest.json') },
      loadCurrent: () => { throw new RuntimeSnapshotValidationError('corrupt current'); },
      loadLastKnownGood: () => snapshot,
      publish: (candidate: typeof snapshot) => { published = true; return candidate; }
    };
    mkdirSync(store.paths.root);
    writeFileSync(store.paths.manifest, '{}', { mode: 0o600 });
    const service = new RuntimeService({ dataDir, snapshotStore: store, refreshSnapshot: (runtimeInput, current) => {
      assert.equal(current?.checksum, snapshot.checksum);
      return compileRuntimeSnapshot({ repositoryId: runtimeInput.repositoryId!, generatedAt: '2026-08-25T00:00:02.000Z' });
    } });

    assert.equal(service.evaluate({ inputPath: input, refresh: true }).outcome, 'ALLOW');
    assert.equal(published, true);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('active-target pointer corruption and unsafe metadata cannot alter runtime decisions', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-runtime-status-'));
  const input = join(dataDir, 'action.json');
  const pointer = join(dataDir, 'runtime', 'active-target.json');
  try {
    writeFileSync(input, JSON.stringify(action));
    assert.equal(new RuntimeService({ dataDir, refreshSnapshot: () => blockingSnapshot() }).evaluate({ inputPath: input }).outcome, 'BLOCK');
    for (const mutate of [
      () => writeFileSync(pointer, '{bad json', { mode: 0o600 }),
      () => writeFileSync(pointer, 'x'.repeat(2_000), { mode: 0o600 }),
      () => { writeFileSync(pointer, '{}', { mode: 0o644 }); chmodSync(pointer, 0o644); },
      () => symlinkSync(input, pointer)
    ]) {
      try { unlinkSync(pointer); } catch {}
      mutate();
      assert.equal(new RuntimeService({ dataDir }).status().health, 'degraded');
      assert.equal(new RuntimeService({ dataDir }).evaluate({ inputPath: input }).outcome, 'BLOCK');
    }
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('pointer failures are classified narrowly and never block evaluation or refresh', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-runtime-status-'));
  const input = join(dataDir, 'action.json');
  try {
    writeFileSync(input, JSON.stringify(action));
    const snapshot = blockingSnapshot();
    const store = {
      paths: { root: dataDir, manifest: join(dataDir, 'manifest.json'), rollbackManifest: join(dataDir, 'rollback-manifest.json') },
      loadCurrent: () => snapshot,
      loadLastKnownGood: () => snapshot,
      publish: (candidate: typeof snapshot) => candidate
    };
    writeFileSync(store.paths.manifest, '{}', { mode: 0o600 });
    const classified = new RuntimeService({ dataDir, snapshotStore: store, activeTargetPointer: {
      read: () => { throw new RuntimeActiveTargetPointerError('unavailable'); },
      write: () => { throw new RuntimeActiveTargetPointerError('unavailable'); }
    }, refreshSnapshot: () => snapshot });
    assert.equal(classified.evaluate({ inputPath: input, refresh: true }).outcome, 'BLOCK');

    const programming = new RuntimeService({ dataDir, snapshotStore: store, activeTargetPointer: {
      read: () => { throw new TypeError('programming failure'); }, write: () => undefined
    } });
    assert.throws(() => programming.status(), TypeError);
    const shaped = new RuntimeService({ dataDir, snapshotStore: store, activeTargetPointer: {
      read: () => { throw Object.assign(new Error('not a system error'), { code: 'EIO' }); }, write: () => undefined
    } });
    assert.throws(() => shaped.status(), /not a system error/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
