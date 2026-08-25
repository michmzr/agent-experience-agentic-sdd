import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { RuntimeRule } from '../src/runtime/contracts.js';
import { createRuleIndex } from '../src/runtime/rule-index.js';
import { compileRuntimeSnapshot, parseRuntimeSnapshot, serializeRuntimeSnapshot } from '../src/runtime/snapshot.js';
import { RuntimeSnapshotStore } from '../src/storage/runtime-snapshot-store.js';

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
    globalRules: [rule('global', 'global'), { ...rule('unapproved', 'global'), authoritative: false }],
    repositoryRules: [rule('other', 'repository', 'repo-b'), rule('active'), { ...rule('expired'), state: 'expired' }]
  });
  assert.deepEqual(snapshot.rules.map(({ id }) => id), ['active', 'global']);
  assert.equal(serializeRuntimeSnapshot(snapshot), serializeRuntimeSnapshot(snapshot));
  assert.deepEqual(parseRuntimeSnapshot(JSON.parse(serializeRuntimeSnapshot(snapshot))), snapshot);
});

test('includes non-authoritative and disputed context only when explicitly supplied', () => {
  const contextual = { ...rule('context'), state: 'disputed' as const, authoritative: false };
  const observed = { ...rule('observed'), state: 'observed' as const };
  const snapshot = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [observed], contextRules: [contextual] });
  assert.deepEqual(snapshot.rules.map(({ id }) => id), ['context', 'observed']);
  assert.equal(snapshot.rules.every(({ effect }) => effect === 'context'), true);
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
  const store = new RuntimeSnapshotStore(root);
  const first = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const second = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:01:00.000Z', repositoryRules: [rule('second')] });
  store.publish(first);
  store.publish(second);
  assert.equal(store.loadCurrent().rules[0]?.id, 'second');
  assert.equal(store.loadLastKnownGood().rules[0]?.id, 'first');
  writeFileSync(store.paths.current, '{broken', 'utf8');
  assert.throws(() => store.loadCurrent());
  assert.equal(store.loadLastKnownGood().rules[0]?.id, 'first');
});

test('failed candidate validation and symlink state paths preserve current', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const store = new RuntimeSnapshotStore(root);
  const first = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  store.publish(first);
  assert.throws(() => store.publishSerialized(serializeRuntimeSnapshot(first).replace(first.checksum, '0'.repeat(64))));
  assert.equal(store.loadCurrent().rules[0]?.id, 'first');

  const unsafeRoot = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  symlinkSync('/dev/null', join(unsafeRoot, 'current.json'));
  assert.throws(() => new RuntimeSnapshotStore(unsafeRoot).publish(first));
});

test('a failed rebuild preserves both validated generations', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const store = new RuntimeSnapshotStore(root);
  const first = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  const second = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:01:00.000Z', repositoryRules: [rule('second')] });
  store.publish(first); store.publish(second);
  assert.throws(() => store.rebuild(() => { throw new Error('compiler failed'); }));
  assert.equal(store.loadCurrent().rules[0]?.id, 'second');
  assert.equal(store.loadLastKnownGood().rules[0]?.id, 'first');
});

test('rejects a state directory reached through a symlinked ancestor', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-runtime-'));
  const target = join(root, 'target');
  mkdirSync(target, { mode: 0o700 });
  const linked = join(root, 'linked');
  symlinkSync(target, linked);
  const snapshot = compileRuntimeSnapshot({ repositoryId: 'repo-a', generatedAt: '2026-08-25T00:00:00.000Z', repositoryRules: [rule('first')] });
  assert.throws(() => new RuntimeSnapshotStore(join(linked, 'state')).publish(snapshot));
});
