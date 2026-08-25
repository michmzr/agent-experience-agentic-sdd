import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { RuntimeRule } from '../src/runtime/contracts.js';
import { createRuleIndex } from '../src/runtime/rule-index.js';
import { compileRuntimeSnapshot, parseRuntimeSnapshot, serializeRuntimeSnapshot } from '../src/runtime/snapshot.js';
import {
  RuntimeSnapshotConflictError, RuntimeSnapshotStore,
  type RuntimeSnapshotStoreOptions, type RuntimeSnapshotStoreStep
} from '../src/storage/runtime-snapshot-store.js';

const clock = (): number => 0;
function store(root: string, options: Omit<RuntimeSnapshotStoreOptions, 'clock'> = {}): RuntimeSnapshotStore {
  return new RuntimeSnapshotStore(root, { clock, ...options });
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
  const cleanupError = Object.assign(new Error('cleanup failed'), { code: 'EACCES' });
  const snapshotStore = store(root, { injectFailure: (step) => { if (step === 'cleanup') throw cleanupError; } });
  snapshotStore.publish(second);
  assert.equal(snapshotStore.loadCurrent().rules[0]?.id, 'second');
  assert.equal(snapshotStore.loadLastKnownGood().rules[0]?.id, 'first');
});

test('propagates cleanup programming errors after leaving the committed manifest valid', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const first = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const second = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:01:00.000Z', repositoryRules: [rule('second')] });
  store(root).publish(first);
  const snapshotStore = store(root, { injectFailure: (step) => { if (step === 'cleanup') throw new TypeError('cleanup bug'); } });
  assert.throws(() => snapshotStore.publish(second), TypeError);
  assert.equal(store(root).loadCurrent().rules[0]?.id, 'second');
  assert.equal(store(root).loadLastKnownGood().rules[0]?.id, 'first');
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

test('releases an exclusively owned lock when a reentrant acquisition hook throws', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const snapshot = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const failing = new RuntimeSnapshotStore(root, { clock, afterLockAcquired: () => { throw new TypeError('hook bug'); } });
  assert.throws(() => failing.publish(snapshot), TypeError);
  assert.equal(existsSync(join(failing.paths.root, '.writer-lock')), false);
  store(root).publish(snapshot);
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
