import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { RuntimeRule } from '../src/runtime/contracts.js';
import { createRuleIndex } from '../src/runtime/rule-index.js';
import { compileRuntimeSnapshot, parseRuntimeSnapshot, serializeRuntimeSnapshot } from '../src/runtime/snapshot.js';
import {
  RuntimeSnapshotCleanupError, RuntimeSnapshotConflictError, RuntimeSnapshotStore,
  type RuntimeSnapshotStoreOptions, type RuntimeSnapshotStoreStep
} from '../src/storage/runtime-snapshot-store.js';

const clock = (): number => 0;
function store(root: string, options: Omit<RuntimeSnapshotStoreOptions, 'clock'> = {}): RuntimeSnapshotStore {
  return new RuntimeSnapshotStore(root, { clock, ...options });
}

function fakeFilesystemError(message: string, code: 'ENOENT' | 'EEXIST' = 'ENOENT'): Error {
  let source: NodeJS.ErrnoException;
  try {
    if (code === 'EEXIST') mkdirSync(mkdtempSync(join(tmpdir(), 'ael-existing-')));
    else readFileSync(join(tmpdir(), `ael-missing-${process.pid}-${Math.random()}`));
  }
  catch (error) { source = error as NodeJS.ErrnoException; }
  return Object.assign(new Error(message), { code: source!.code, errno: source!.errno, syscall: source!.syscall });
}

function rule(id: string, scope: 'global' | 'repository' = 'repository', repositoryId = 'repo-a'): RuntimeRule {
  return {
    id, state: 'verified', authoritative: true, effect: 'conflict',
    signature: { kind: 'action', tool: 'git', action: 'push', path: '/repo/a' },
    applicability: scope === 'global' ? { scope } : { scope, repositoryId },
    reference: { knowledgeId: `knowledge-${id}`, evidenceIds: [`evidence-${id}`] }
  };
}

test('compiles stable isolated snapshots and excludes inactive rules', () => {
  const snapshot = compileRuntimeSnapshot({
    repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z',
    globalRules: [rule('global', 'global')],
    repositoryRules: [rule('other', 'repository', 'repo-b'), rule('active'), { ...rule('expired'), state: 'expired' }]
  });
  assert.deepEqual(snapshot.rules.map(({ id }) => id), ['active', 'global']);
  assert.equal(serializeRuntimeSnapshot(snapshot), serializeRuntimeSnapshot(snapshot));
  assert.deepEqual(parseRuntimeSnapshot(JSON.parse(serializeRuntimeSnapshot(snapshot))), snapshot);
});

test('includes non-authoritative and disputed context only when explicitly supplied', () => {
  const contextual = { ...rule('context'), state: 'disputed' as const, authoritative: false };
  const observed = { ...rule('observed'), state: 'observed' as const };
  assert.throws(() => compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [observed] }));
  assert.throws(() => compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', globalRules: [{ ...rule('unapproved', 'global'), authoritative: false }] }));
  const snapshot = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', contextRules: [contextual, observed] });
  assert.deepEqual(snapshot.rules.map(({ id }) => id), ['context', 'observed']);
  assert.equal(snapshot.rules.every(({ effect }) => effect === 'context'), true);
});

test('uses only an explicit timestamp or injected clock when compiling a snapshot', () => {
  const snapshot = compileRuntimeSnapshot({ repositoryId: 'repo-a', now: () => new Date('2026-08-25T01:02:03.000Z'), repositoryRules: [rule('active')] });
  assert.equal(snapshot.generatedAt, '2026-08-25T01:02:03.000Z');
  assert.throws(() => compileRuntimeSnapshot({ repositoryId: 'repo-a', repositoryRules: [rule('active')] } as never));
});

test('enforces compiler input counts, nested strings, and total serialized bytes before returning', () => {
  const base = rule('base');
  assert.throws(() => compileRuntimeSnapshot({
    repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z',
    repositoryRules: Array.from({ length: 10_001 }, () => base)
  }), /rule-count limit/);
  assert.throws(() => compileRuntimeSnapshot({
    repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z',
    repositoryRules: [{ ...base, reference: { ...base.reference, source: 'x'.repeat(4_097) } }]
  }), /string-length limit/);
  const byteHeavy = Array.from({ length: 1_100 }, (_, index) => ({
    ...rule(`byte-${String(index).padStart(4, '0')}`),
    reference: { knowledgeId: `knowledge-${index}`, evidenceIds: [`evidence-${index}`], source: 'x'.repeat(4_000) }
  }));
  assert.throws(() => compileRuntimeSnapshot({
    repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: byteHeavy
  }), /size limit/);
});

test('rejects incompatible, corrupt, and unsafe path snapshots', () => {
  const snapshot = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('active')] });
  assert.throws(() => parseRuntimeSnapshot({ ...snapshot, version: 2 }));
  assert.throws(() => parseRuntimeSnapshot({ ...snapshot, checksum: '0'.repeat(64) }));
  assert.throws(() => compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [{ ...rule('bad'), signature: { kind: 'action', tool: 'git', action: 'push', path: 'C:relative' } }] }));
});

test('loads deeply immutable indexes and matches without repository leakage', () => {
  const snapshot = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', globalRules: [rule('global', 'global')], repositoryRules: [rule('active')] });
  const index = createRuleIndex(snapshot);
  const matches = index.match({ repositoryId: 'repo-a', operationClass: 'normal', signature: { kind: 'action', tool: 'git', action: 'push', path: '/repo/a' } });
  assert.equal(matches.length, 2);
  assert.equal(Object.isFrozen(index.rules), true);
  assert.equal(Object.isFrozen(index.rules[0]?.reference.evidenceIds), true);
  assert.deepEqual(index.match({ repositoryId: 'repo-b', operationClass: 'normal', signature: { kind: 'action', tool: 'git', action: 'push', path: '/repo/a' } }).map(({ rule }) => rule.id), ['global']);
});

test('revalidates path identities at the rule-index boundary', () => {
  const snapshot = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('active')] });
  const forged = { ...snapshot, rules: [{ ...snapshot.rules[0]!, signature: { kind: 'action' as const, tool: 'git', action: 'push', path: 'C:relative' } }] };
  assert.throws(() => createRuleIndex(forged));
});

test('atomically rotates current into exactly one validated last-known-good snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const snapshotStore = store(root);
  const first = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const second = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:01:00.000Z', repositoryRules: [rule('second')] });
  snapshotStore.publish(first);
  snapshotStore.publish(second);
  assert.equal(snapshotStore.loadCurrent().rules[0]?.id, 'second');
  assert.equal(snapshotStore.loadLastKnownGood().rules[0]?.id, 'first');
  const manifest = JSON.parse(readFileSync(snapshotStore.paths.manifest, 'utf8')) as { version: number; current: { checksum: string; file: string }; lastKnownGood: { checksum: string; file: string } };
  assert.equal(manifest.version, 1);
  assert.equal(manifest.current.checksum, second.checksum);
  assert.equal(manifest.lastKnownGood.checksum, first.checksum);
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith('generation-')).sort(), [manifest.current.file, manifest.lastKnownGood.file].sort());
  writeFileSync(snapshotStore.generationPath(second.checksum), '{broken', 'utf8');
  assert.throws(() => snapshotStore.loadCurrent());
  assert.equal(snapshotStore.loadLastKnownGood().rules[0]?.id, 'first');
  const priorManifest = readFileSync(snapshotStore.paths.manifest, 'utf8');
  const third = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:02:00.000Z', repositoryRules: [rule('third')] });
  assert.throws(() => snapshotStore.publish(third));
  assert.equal(readFileSync(snapshotStore.paths.manifest, 'utf8'), priorManifest);
  assert.equal(snapshotStore.loadLastKnownGood().rules[0]?.id, 'first');
});

test('recovery atomically replaces a corrupt single generation without weakening normal publish', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const snapshotStore = store(root);
  const first = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const second = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:01:00.000Z', repositoryRules: [rule('second')] });
  snapshotStore.publish(first);
  writeFileSync(snapshotStore.generationPath(first.checksum), '{broken', { mode: 0o600 });

  assert.throws(() => snapshotStore.publish(second));
  assert.throws(() => snapshotStore.recover(compileRuntimeSnapshot({
    repositoryId: 'repo-b', generatedAt: '2026-08-25T00:01:00.000Z'
  }), 'repo-a'));
  assert.equal(snapshotStore.recover(second, 'repo-a').rules[0]?.id, 'second');
  assert.equal(snapshotStore.loadCurrent().rules[0]?.id, 'second');
  assert.throws(() => snapshotStore.loadLastKnownGood());
});

test('recovery failure restores corrupt logical state and rejects unsafe manifest metadata', () => {
  const first = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const second = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:01:00.000Z', repositoryRules: [rule('second')] });
  const steps: readonly RuntimeSnapshotStoreStep[] = [
    'after-generation-write', 'after-generation-reopen', 'before-generation-rename', 'before-generation-directory-sync',
    'after-manifest-write', 'after-manifest-reopen', 'before-manifest-rename', 'before-commit-directory-sync'
  ];
  for (const failureStep of steps) {
    const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
    store(root).publish(first);
    writeFileSync(store(root).generationPath(first.checksum), '{broken', { mode: 0o600 });
    const priorManifest = readFileSync(store(root).paths.manifest, 'utf8');
    const failing = store(root, { injectFailure: (step) => {
      if (step === failureStep) throw new Error(`injected ${failureStep}`);
    } });

    assert.throws(() => failing.recover(second, 'repo-a'), new RegExp(failureStep));
    assert.equal(readFileSync(failing.paths.manifest, 'utf8'), priorManifest, failureStep);
    assert.throws(() => store(root).loadCurrent(), failureStep);
  }

  const unsafeRoot = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  store(unsafeRoot).publish(first);
  writeFileSync(store(unsafeRoot).generationPath(first.checksum), '{broken', { mode: 0o600 });
  const priorManifest = readFileSync(store(unsafeRoot).paths.manifest, 'utf8');
  chmodSync(store(unsafeRoot).paths.manifest, 0o644);
  assert.throws(() => store(unsafeRoot).recover(second, 'repo-a'));
  assert.equal(readFileSync(store(unsafeRoot).paths.manifest, 'utf8'), priorManifest);
});

test('recovery retains a validated rollback and uses it as last-known-good', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const first = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const second = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:01:00.000Z', repositoryRules: [rule('second')] });
  const third = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:02:00.000Z', repositoryRules: [rule('third')] });
  const snapshotStore = store(root);
  snapshotStore.publish(first);
  snapshotStore.publish(second);
  const rollback = readFileSync(snapshotStore.paths.rollbackManifest, 'utf8');
  writeFileSync(snapshotStore.generationPath(second.checksum), '{broken', { mode: 0o600 });

  snapshotStore.recover(third, 'repo-a');
  assert.equal(snapshotStore.loadCurrent().rules[0]?.id, 'third');
  assert.equal(snapshotStore.loadLastKnownGood().rules[0]?.id, 'first');
  assert.equal(readFileSync(snapshotStore.paths.rollbackManifest, 'utf8'), rollback);
});

test('repeated corrupt recovery cycles retain only referenced generations', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const snapshotStore = store(root);
  let current = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('cycle-0')] });
  snapshotStore.publish(current);
  for (let index = 1; index <= 12; index += 1) {
    writeFileSync(snapshotStore.generationPath(current.checksum), '{broken', { mode: 0o600 });
    current = compileRuntimeSnapshot({
      repositoryId: 'repo-a', generatedAt: `2026-08-25T00:${String(index).padStart(2, '0')}:00.000Z`, repositoryRules: [rule(`cycle-${index}`)]
    });
    snapshotStore.recover(current, 'repo-a');
  }
  const manifest = JSON.parse(readFileSync(snapshotStore.paths.manifest, 'utf8')) as { current: { file: string }; lastKnownGood?: { file: string } };
  const retained = new Set([manifest.current.file, manifest.lastKnownGood?.file].filter(Boolean));
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith('generation-')).sort(), [...retained].sort());
});

test('recovery cleanup is best effort for expected failures and propagates programming errors postcommit', () => {
  const first = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const second = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:01:00.000Z', repositoryRules: [rule('second')] });
  for (const cleanupError of [new RuntimeSnapshotCleanupError('expected cleanup failure'), new TypeError('cleanup bug')]) {
    const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
    store(root).publish(first);
    writeFileSync(store(root).generationPath(first.checksum), '{broken', { mode: 0o600 });
    const recovering = store(root, { injectFailure: (step) => { if (step === 'cleanup') throw cleanupError; } });
    if (cleanupError instanceof TypeError) assert.throws(() => recovering.recover(second, 'repo-a'), cleanupError);
    else assert.doesNotThrow(() => recovering.recover(second, 'repo-a'));
    assert.equal(store(root).loadCurrent().rules[0]?.id, 'second');
  }
});

test('the state-entry boundary cannot permanently prevent later recovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const first = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const second = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:01:00.000Z', repositoryRules: [rule('second')] });
  const third = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:02:00.000Z', repositoryRules: [rule('third')] });
  const snapshotStore = store(root);
  snapshotStore.publish(first);
  writeFileSync(snapshotStore.generationPath(first.checksum), '{broken', { mode: 0o600 });
  for (let index = 0; index < 254; index += 1) writeFileSync(join(root, `bounded-${String(index).padStart(3, '0')}`), 'x');

  snapshotStore.recover(second, 'repo-a');
  writeFileSync(snapshotStore.generationPath(second.checksum), '{broken', { mode: 0o600 });
  assert.doesNotThrow(() => snapshotStore.recover(third, 'repo-a'));
  assert.equal(snapshotStore.loadCurrent().rules[0]?.id, 'third');
});

test('failed candidate validation and symlink state paths preserve current', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const snapshotStore = store(root);
  const first = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  snapshotStore.publish(first);
  assert.throws(() => snapshotStore.publishSerialized(serializeRuntimeSnapshot(first).replace(first.checksum, '0'.repeat(64))));
  assert.equal(snapshotStore.loadCurrent().rules[0]?.id, 'first');

  const unsafeRoot = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  symlinkSync('/dev/null', join(unsafeRoot, 'manifest.json'));
  assert.throws(() => store(unsafeRoot).publish(first));
});

test('a failed rebuild preserves both validated generations', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const snapshotStore = store(root);
  const first = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const second = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:01:00.000Z', repositoryRules: [rule('second')] });
  snapshotStore.publish(first); snapshotStore.publish(second);
  assert.throws(() => snapshotStore.rebuild(() => { throw new Error('compiler failed'); }));
  assert.equal(snapshotStore.loadCurrent().rules[0]?.id, 'second');
  assert.equal(snapshotStore.loadLastKnownGood().rules[0]?.id, 'first');
});

test('rejects a state directory reached through a symlinked ancestor', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const target = join(root, 'target');
  mkdirSync(target, { mode: 0o700 });
  mkdirSync(join(target, 'state'), { mode: 0o700 });
  const linked = join(root, 'linked');
  symlinkSync(target, linked);
  const snapshot = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  assert.throws(() => store(join(linked, 'state')).publish(snapshot));
});

test('manifest commit failures preserve the prior logical current and LKG generations', () => {
  const steps: readonly RuntimeSnapshotStoreStep[] = [
    'after-generation-write', 'after-generation-reopen', 'before-generation-rename', 'before-generation-directory-sync',
    'after-manifest-write', 'after-manifest-reopen', 'before-manifest-rename', 'before-commit-directory-sync'
  ];
  for (const step of steps) {
    const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
    const first = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
    const second = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:01:00.000Z', repositoryRules: [rule('second')] });
    const third = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:02:00.000Z', repositoryRules: [rule('third')] });
    store(root).publish(first);
    store(root).publish(second);
    const priorManifest = readFileSync(store(root).paths.manifest, 'utf8');
    const failing = store(root, { injectFailure: (at) => { if (at === step) throw new Error(`injected ${step}`); } });
    assert.throws(() => failing.publish(third));
    assert.equal(readFileSync(failing.paths.manifest, 'utf8'), priorManifest, step);
    assert.equal(store(root).loadCurrent().rules[0]?.id, 'second', step);
    assert.equal(store(root).loadLastKnownGood().rules[0]?.id, 'first', step);
  }
});

test('cleanup failure after a committed manifest cannot change logical correctness', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const first = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const second = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:01:00.000Z', repositoryRules: [rule('second')] });
  store(root).publish(first);
  const cleanupError = new RuntimeSnapshotCleanupError('cleanup failed');
  const snapshotStore = store(root, { injectFailure: (step) => { if (step === 'cleanup') throw cleanupError; } });
  snapshotStore.publish(second);
  assert.equal(snapshotStore.loadCurrent().rules[0]?.id, 'second');
  assert.equal(snapshotStore.loadLastKnownGood().rules[0]?.id, 'first');
});

test('propagates cleanup TypeError and filesystem-shaped programming errors after commit', () => {
  for (const programmingError of [new TypeError('cleanup type bug'), fakeFilesystemError('cleanup shaped bug')]) {
    const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
    const first = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
    const second = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:01:00.000Z', repositoryRules: [rule('second')] });
    store(root).publish(first);
    const snapshotStore = store(root, { injectFailure: (step) => { if (step === 'cleanup') throw programmingError; } });
    assert.throws(() => snapshotStore.publish(second), programmingError);
    assert.equal(store(root).loadCurrent().rules[0]?.id, 'second');
    assert.equal(store(root).loadLastKnownGood().rules[0]?.id, 'first');
  }
});

test('detects a manifest CAS conflict under the writer lock without deleting generations', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const first = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const second = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:01:00.000Z', repositoryRules: [rule('second')] });
  store(root).publish(first);
  const conflicting = store(root, { injectFailure: (step) => { if (step === 'before-manifest-cas') appendFileSync(store(root).paths.manifest, ' '); } });
  assert.throws(() => conflicting.publish(second), RuntimeSnapshotConflictError);
  assert.equal(store(root).loadCurrent().rules[0]?.id, 'first');
  assert.equal(readdirSync(root).filter((name) => name.startsWith('generation-')).length, 2);
});

test('serializes cross-process publishers and never deletes a referenced generation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const first = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const second = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:01:00.000Z', repositoryRules: [rule('second')] });
  const third = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:02:00.000Z', repositoryRules: [rule('third')] });
  store(root).publish(first);
  const script = join(root, 'publisher.mjs');
  writeFileSync(script, `import { existsSync, writeFileSync } from 'node:fs';\nconst [moduleUrl, root, encoded, role, ready, release, waiting] = process.argv.slice(2);\nconst { RuntimeSnapshotStore } = await import(moduleUrl);\nconst wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);\nnew RuntimeSnapshotStore(root, { clock: Date.now, wait, lockTimeoutMs: 5000, afterLockAcquired: () => { if (role === 'first') { writeFileSync(ready, 'ready'); while (!existsSync(release)) wait(5); } }, onLockWait: () => { if (role === 'second' && !existsSync(waiting)) writeFileSync(waiting, 'waiting'); } }).publishSerialized(Buffer.from(encoded, 'base64').toString('utf8'));\n`, { mode: 0o600 });
  const moduleUrl = new URL('../src/storage/runtime-snapshot-store.js', import.meta.url).href;
  const ready = join(root, 'ready'); const release = join(root, 'release'); const waiting = join(root, 'waiting');
  const launch = (snapshot: ReturnType<typeof compileRuntimeSnapshot>, role: string) => spawn(process.execPath, [script, moduleUrl, root, Buffer.from(serializeRuntimeSnapshot(snapshot)).toString('base64'), role, ready, release, waiting], { stdio: ['ignore', 'pipe', 'pipe'] });
  const firstPublisher = launch(second, 'first');
  await waitForFile(ready);
  const secondPublisher = launch(third, 'second');
  await waitForFile(waiting);
  writeFileSync(release, 'release');
  assert.equal(await childExit(firstPublisher), 0);
  assert.equal(await childExit(secondPublisher), 0);
  assert.equal(store(root).loadCurrent().rules[0]?.id, 'third');
  assert.equal(store(root).loadLastKnownGood().rules[0]?.id, 'second');
});

test('recovers a stale dead writer lock but preserves a live owner lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const snapshot = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const snapshotStore = store(root);
  const lock = join(snapshotStore.paths.root, '.writer-lock');
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 999_999_999, timestamp: 0, token: 'dead' }), { mode: 0o600 });
  new RuntimeSnapshotStore(root, { clock: () => 100_000, staleLockMs: 10 }).publish(snapshot);
  assert.equal(existsSync(lock), false);

  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, timestamp: 0, token: 'live' }), { mode: 0o600 });
  let now = 100_000;
  const blocked = new RuntimeSnapshotStore(root, { clock: () => now, staleLockMs: 10, lockTimeoutMs: 20, wait: (milliseconds) => { now += milliseconds; } });
  assert.throws(() => blocked.publish(snapshot), /Timed out/);
  assert.equal(existsSync(lock), true);
});

test('propagates a filesystem-shaped clock error from writer acquisition', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const snapshot = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const expected = fakeFilesystemError('clock bug', 'EEXIST');
  let calls = 0;
  const snapshotStore = new RuntimeSnapshotStore(root, {
    clock: () => {
      calls += 1;
      if (calls === 3) throw expected;
      return calls;
    }
  });
  assert.throws(() => snapshotStore.publish(snapshot), expected);
});

test('streams at most one entry beyond the reclaim claim limit including unrelated entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const snapshot = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const claims = join(store(root).paths.root, '.writer-lock-reclaim');
  mkdirSync(claims, { mode: 0o700 });
  for (let index = 0; index < 140; index += 1) writeFileSync(join(claims, `unrelated-${String(index).padStart(3, '0')}`), 'x');
  let entriesRead = 0;
  const bounded = new RuntimeSnapshotStore(root, { clock, onDirectoryEntryRead: (directory) => { if (directory === 'reclaim') entriesRead += 1; } });
  assert.throws(() => bounded.publish(snapshot), /claim limit exceeded/);
  assert.equal(entriesRead, 129);
});

test('propagates a filesystem-shaped reclaim scan hook error from writer acquisition', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const snapshot = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const claims = join(store(root).paths.root, '.writer-lock-reclaim');
  mkdirSync(claims, { mode: 0o700 });
  writeFileSync(join(claims, 'unrelated'), 'x');
  const expected = fakeFilesystemError('reclaim scan hook bug', 'EEXIST');
  const snapshotStore = new RuntimeSnapshotStore(root, {
    clock, onDirectoryEntryRead: (directory) => { if (directory === 'reclaim') throw expected; }
  });
  assert.throws(() => snapshotStore.publish(snapshot), expected);
});

test('rolls back an owned writer lock when post-rename identity or directory sync fails', () => {
  const steps: readonly RuntimeSnapshotStoreStep[] = ['after-writer-lock-rename', 'before-writer-lock-directory-sync'];
  for (const step of steps) {
    const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
    const snapshot = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule(step)] });
    const failing = store(root, { injectFailure: (at) => { if (at === step) throw new TypeError(`injected ${step}`); } });
    assert.throws(() => failing.publish(snapshot), TypeError);
    assert.equal(existsSync(join(failing.paths.root, '.writer-lock')), false);
    store(root).publish(snapshot);
    assert.equal(store(root).loadCurrent().rules[0]?.id, step);
  }
});

test('bounds state-directory scans for abandoned candidates and committed generation cleanup', () => {
  const crowdedRoot = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  for (let index = 0; index < 270; index += 1) writeFileSync(join(crowdedRoot, `unrelated-${String(index).padStart(3, '0')}`), 'x');
  let acquisitionReads = 0;
  const snapshot = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  assert.throws(() => new RuntimeSnapshotStore(crowdedRoot, {
    clock, onDirectoryEntryRead: (directory) => { if (directory === 'state') acquisitionReads += 1; }
  }).publish(snapshot), /state directory entry limit exceeded/);
  assert.equal(acquisitionReads, 257);

  const cleanupRoot = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  store(cleanupRoot).publish(snapshot);
  let cleanupReads = 0;
  const second = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:01:00.000Z', repositoryRules: [rule('second')] });
  const cleanupStore = store(cleanupRoot, {
    afterLockAcquired: () => {
      for (let index = 0; index < 270; index += 1) writeFileSync(join(cleanupRoot, `late-${String(index).padStart(3, '0')}`), 'x');
      cleanupReads = 0;
    },
    onDirectoryEntryRead: (directory) => { if (directory === 'state') cleanupReads += 1; }
  });
  cleanupStore.publish(second);
  assert.equal(cleanupReads, 257);
  assert.equal(store(cleanupRoot).loadCurrent().rules[0]?.id, 'second');
});

test('releases an exclusively owned lock when a reentrant acquisition hook throws', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const snapshot = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const failing = new RuntimeSnapshotStore(root, { clock, afterLockAcquired: () => { throw new TypeError('hook bug'); } });
  assert.throws(() => failing.publish(snapshot), TypeError);
  assert.equal(existsSync(join(failing.paths.root, '.writer-lock')), false);
  store(root).publish(snapshot);
});

test('identity-safe stale reclaim never removes a replacement live lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const snapshot = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const base = store(root);
  const lock = join(base.paths.root, '.writer-lock');
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 999_999_999, timestamp: 0, token: 'stale-owner' }), { mode: 0o600 });
  let now = 100_000;
  let replaced = false;
  const publisher = new RuntimeSnapshotStore(root, {
    clock: () => now, staleLockMs: 10, lockTimeoutMs: 20, wait: (milliseconds) => { now += milliseconds; },
    beforeStaleLockRename: () => {
      if (replaced) return;
      replaced = true;
      renameSync(lock, `${lock}.old`);
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, timestamp: now, token: 'replacement-live' }), { mode: 0o600 });
    }
  });
  assert.throws(() => publisher.publish(snapshot), /Timed out/);
  assert.equal((JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')) as { token: string }).token, 'replacement-live');
  assert.equal(existsSync(base.paths.manifest), false);
  rmSync(lock, { recursive: true });
  rmSync(`${lock}.old`, { recursive: true });
});

test('recovers a durable orphaned reclaim claim after its owner crashes', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const snapshot = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const base = store(root);
  const lock = join(base.paths.root, '.writer-lock');
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 999_999_999, timestamp: 0, token: 'stale-lock' }), { mode: 0o600 });
  const claims = join(base.paths.root, '.writer-lock-reclaim');
  const orphan = join(claims, 'claim-000000000001-deadbeef');
  mkdirSync(orphan, { recursive: true, mode: 0o700 });
  writeFileSync(join(orphan, 'owner.json'), JSON.stringify({ pid: 999_999_999, timestamp: 0, token: 'orphan' }), { mode: 0o600 });

  new RuntimeSnapshotStore(root, { clock: () => 100_000, staleLockMs: 10 }).publish(snapshot);
  assert.equal(existsSync(orphan), false);
  assert.equal(base.loadCurrent().rules[0]?.id, 'first');
});

test('orphan reclaim cleanup preserves an interleaved replacement live claim', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const snapshot = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const base = store(root);
  const lock = join(base.paths.root, '.writer-lock');
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 999_999_999, timestamp: 0, token: 'stale-lock' }), { mode: 0o600 });
  const claims = join(base.paths.root, '.writer-lock-reclaim');
  const orphan = join(claims, 'claim-000000000001-deadbeef');
  mkdirSync(orphan, { recursive: true, mode: 0o700 });
  writeFileSync(join(orphan, 'owner.json'), JSON.stringify({ pid: 999_999_999, timestamp: 0, token: 'orphan' }), { mode: 0o600 });
  let now = 100_000;
  let replaced = false;
  const publisher = new RuntimeSnapshotStore(root, {
    clock: () => now, staleLockMs: 10, lockTimeoutMs: 20, wait: (milliseconds) => { now += milliseconds; },
    beforeStaleReclaimClaimRemoval: (claim) => {
      if (claim !== orphan || replaced) return;
      replaced = true;
      renameSync(orphan, `${orphan}.old`);
      mkdirSync(orphan, { mode: 0o700 });
      writeFileSync(join(orphan, 'owner.json'), JSON.stringify({ pid: process.pid, timestamp: now, token: 'replacement-live' }), { mode: 0o600 });
    }
  });
  assert.throws(() => publisher.publish(snapshot), /Timed out/);
  const liveClaims = readdirSync(claims).flatMap((entry) => {
    try { return [JSON.parse(readFileSync(join(claims, entry, 'owner.json'), 'utf8')) as { token: string }]; }
    catch { return []; }
  });
  assert.equal(liveClaims.some(({ token }) => token === 'replacement-live'), true);
  assert.equal(existsSync(base.paths.manifest), false);
  rmSync(claims, { recursive: true });
  rmSync(`${orphan}.old`, { recursive: true, force: true });
  rmSync(lock, { recursive: true });
});

test('suppresses real expected filesystem failures at cleanup and reclaim boundaries', () => {
  const cleanupRoot = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const first = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const second = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:01:00.000Z', repositoryRules: [rule('second')] });
  store(cleanupRoot).publish(first);
  mkdirSync(join(cleanupRoot, `generation-${'0'.repeat(64)}.json`), { mode: 0o700 });
  store(cleanupRoot).publish(second);
  assert.equal(store(cleanupRoot).loadCurrent().rules[0]?.id, 'second');

  const reclaimRoot = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const reclaimStore = store(reclaimRoot);
  const lock = join(reclaimStore.paths.root, '.writer-lock');
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 999_999_999, timestamp: 0, token: 'stale' }), { mode: 0o600 });
  let now = 100_000;
  new RuntimeSnapshotStore(reclaimRoot, {
    clock: () => now, staleLockMs: 10, lockTimeoutMs: 20, wait: (milliseconds) => { now += milliseconds; },
    beforeStaleLockRename: () => { rmSync(lock, { recursive: true }); }
  }).publish(first);
  assert.equal(reclaimStore.loadCurrent().rules[0]?.id, 'first');
});

test('lock release suppresses expected filesystem errors but propagates programming errors', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const first = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const lock = join(store(root).paths.root, '.writer-lock');
  new RuntimeSnapshotStore(root, { clock, beforeLockRelease: () => { rmSync(lock, { recursive: true }); } }).publish(first);
  assert.equal(existsSync(join(store(root).paths.root, '.writer-lock')), false);

  const second = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:01:00.000Z', repositoryRules: [rule('second')] });
  assert.throws(() => new RuntimeSnapshotStore(root, {
    clock, beforeLockRelease: () => { throw fakeFilesystemError('release bug'); }
  }).publish(second), /release bug/);
  assert.equal(existsSync(join(store(root).paths.root, '.writer-lock')), false);

  const third = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:02:00.000Z', repositoryRules: [rule('third')] });
  assert.throws(() => new RuntimeSnapshotStore(root, {
    clock, beforeLockRelease: () => { throw new TypeError('release type bug'); }
  }).publish(third), TypeError);
  assert.equal(existsSync(join(store(root).paths.root, '.writer-lock')), false);
});

test('stale reclaim and abandoned-candidate housekeeping propagate only programming errors', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const snapshot = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const base = store(root);
  const lock = join(base.paths.root, '.writer-lock');
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 999_999_999, timestamp: 0, token: 'stale' }), { mode: 0o600 });
  assert.throws(() => new RuntimeSnapshotStore(root, { clock: () => 100_000, staleLockMs: 10, beforeStaleLockRename: () => { throw new TypeError('reclaim bug'); } }).publish(snapshot), TypeError);
  const expectedReclaim = fakeFilesystemError('reclaim busy');
  assert.throws(() => new RuntimeSnapshotStore(root, {
    clock: () => 100_000, staleLockMs: 10,
    beforeStaleLockRename: () => { throw expectedReclaim; }
  }).publish(snapshot), /reclaim busy/);
  assert.equal((JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')) as { token: string }).token, 'stale');
  rmSync(lock, { recursive: true });

  const abandoned = join(base.paths.root, '.writer-lock-candidate-abandoned');
  mkdirSync(abandoned, { mode: 0o700 });
  utimesSync(abandoned, 0, 0);
  assert.throws(() => new RuntimeSnapshotStore(root, { clock: () => 100_000, staleLockMs: 10, beforeStaleCandidateRemoval: () => { throw new TypeError('candidate bug'); } }).publish(snapshot), TypeError);
  const expected = fakeFilesystemError('candidate bug');
  assert.throws(() => new RuntimeSnapshotStore(root, { clock: () => 100_000, staleLockMs: 10, beforeStaleCandidateRemoval: () => { throw expected; } }).publish(snapshot), /candidate bug/);
});

test('stale reclaim claim release suppresses filesystem errors and propagates programming errors after cleanup', () => {
  const snapshot = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const expectedRoot = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const expectedBase = store(expectedRoot);
  const expectedLock = join(expectedBase.paths.root, '.writer-lock');
  mkdirSync(expectedLock, { mode: 0o700 });
  writeFileSync(join(expectedLock, 'owner.json'), JSON.stringify({ pid: 999_999_999, timestamp: 0, token: 'stale' }), { mode: 0o600 });
  new RuntimeSnapshotStore(expectedRoot, {
    clock: () => 100_000, staleLockMs: 10, beforeReclaimClaimRelease: (claim) => { rmSync(claim, { recursive: true }); }
  }).publish(snapshot);

  const programmingRoot = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const programmingBase = store(programmingRoot);
  const programmingLock = join(programmingBase.paths.root, '.writer-lock');
  mkdirSync(programmingLock, { mode: 0o700 });
  writeFileSync(join(programmingLock, 'owner.json'), JSON.stringify({ pid: 999_999_999, timestamp: 0, token: 'stale' }), { mode: 0o600 });
  assert.throws(() => new RuntimeSnapshotStore(programmingRoot, {
    clock: () => 100_000, staleLockMs: 10, beforeReclaimClaimRelease: () => { throw fakeFilesystemError('claim release bug'); }
  }).publish(snapshot), /claim release bug/);

  const typeRoot = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const typeBase = store(typeRoot);
  const typeLock = join(typeBase.paths.root, '.writer-lock');
  mkdirSync(typeLock, { mode: 0o700 });
  writeFileSync(join(typeLock, 'owner.json'), JSON.stringify({ pid: 999_999_999, timestamp: 0, token: 'stale' }), { mode: 0o600 });
  assert.throws(() => new RuntimeSnapshotStore(typeRoot, {
    clock: () => 100_000, staleLockMs: 10, beforeReclaimClaimRelease: () => { throw new TypeError('claim release type bug'); }
  }).publish(snapshot), TypeError);
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function childExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
}
