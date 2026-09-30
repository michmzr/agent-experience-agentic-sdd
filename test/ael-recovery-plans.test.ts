import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { CaptureSpool } from '../src/capture/spool.js';
import { applyRecoveryPlan, createRecoveryPlan } from '../src/capture/recovery.js';

const at = '2026-09-30T09:00:00.000Z';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'arc-a2-'));
  const spoolPath = join(root, 'capture-spool.sqlite');
  const experiencePath = join(root, 'experience.sqlite');
  const spool = new CaptureSpool(spoolPath);
  const add = (id: string, repositoryId = 'repo-one') => spool.admit({ kind: 'session-start', session: { id: id as never, source: 'codex', startedAt: at, repositoryId: repositoryId as never } }, at).deliveryId;
  return { root, spoolPath, experiencePath, spool, add };
}

function hold(path: string, deliveryId: string): void {
  const database = new DatabaseSync(path);
  try {
    database.prepare("UPDATE records SET attempts = 4 WHERE delivery_id = ?").run(deliveryId);
    database.prepare("UPDATE capture_recovery_state SET state = 'held', reason = 'storage-unavailable', attempts = 4 WHERE delivery_id = ?").run(deliveryId);
  } finally { database.close(); }
}

test('ARC-A2 bounds scoped plans and rejects a changed selected row before replay', () => {
  const fixture = setup();
  try {
    const selected = fixture.add('selected'); hold(fixture.spoolPath, selected);
    const foreign = fixture.add('foreign', 'repo-two'); hold(fixture.spoolPath, foreign);
    assert.throws(() => createRecoveryPlan({ spoolPath: fixture.spoolPath, experiencePath: fixture.experiencePath, repositoryId: 'repo-one', now: at, limit: 101 }), /limit/i);
    const plan = createRecoveryPlan({ spoolPath: fixture.spoolPath, experiencePath: fixture.experiencePath, repositoryId: 'repo-one', now: at });
    assert.deepEqual(plan.selections.map(row => row.deliveryId), [selected]);
    assert.equal(JSON.stringify(plan).includes('repo-two'), false);
    const database = new DatabaseSync(fixture.spoolPath);
    try { database.prepare("UPDATE records SET payload = ? WHERE delivery_id = ?").run('{"changed":true}', selected); }
    finally { database.close(); }
    assert.throws(() => applyRecoveryPlan({ spoolPath: fixture.spoolPath, experiencePath: fixture.experiencePath, plan, now: at }), /stale/i);
    const check = new DatabaseSync(fixture.spoolPath, { readOnly: true });
    try {
      assert.equal((check.prepare('SELECT state FROM capture_recovery_state WHERE delivery_id = ?').get(selected) as { state: string }).state, 'held');
      assert.equal((check.prepare('SELECT generation FROM capture_recovery_state WHERE delivery_id = ?').get(selected) as { generation: number }).generation, 1);
    } finally { check.close(); }
  } finally { fixture.spool.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test('ARC-A2 resumes interrupted apply exactly once and preserves quarantine evidence', () => {
  const fixture = setup();
  try {
    const first = fixture.add('first'); hold(fixture.spoolPath, first);
    const second = fixture.add('second'); fixture.spool.quarantine(second, 'CORRUPT', at, 'conflicting-identity');
    const plan = createRecoveryPlan({ spoolPath: fixture.spoolPath, experiencePath: fixture.experiencePath, repositoryId: 'repo-one', now: at });
    assert.equal(plan.selections.length, 2);
    assert.throws(() => applyRecoveryPlan({ spoolPath: fixture.spoolPath, experiencePath: fixture.experiencePath, plan, now: at, onApplied: count => { if (count === 1) throw new Error('interrupted'); } }), /interrupted/);
    fixture.spool.close();
    const resumed = applyRecoveryPlan({ spoolPath: fixture.spoolPath, experiencePath: fixture.experiencePath, plan, now: at });
    assert.deepEqual(resumed, { applied: 1, alreadyApplied: 1 });
    assert.deepEqual(applyRecoveryPlan({ spoolPath: fixture.spoolPath, experiencePath: fixture.experiencePath, plan, now: at }), { applied: 0, alreadyApplied: 2 });
    const database = new DatabaseSync(fixture.spoolPath, { readOnly: true });
    try {
      for (const id of [first, second]) {
        assert.equal((database.prepare('SELECT COUNT(*) AS count FROM records WHERE delivery_id = ?').get(id) as { count: number }).count, 1);
        assert.equal((database.prepare('SELECT generation FROM capture_recovery_state WHERE delivery_id = ?').get(id) as { generation: number }).generation, 2);
      }
      assert.equal((database.prepare('SELECT code FROM quarantined_records WHERE delivery_id = ?').get(second) as { code: string }).code, 'CORRUPT');
    } finally { database.close(); }
  } finally { try { fixture.spool.close(); } catch {} rmSync(fixture.root, { recursive: true, force: true }); }
});

test('ARC-A2 rejects one stale selection before changing any selected row', () => {
  const fixture = setup();
  try {
    const first = fixture.add('atomic-first'); hold(fixture.spoolPath, first);
    const second = fixture.add('atomic-second'); hold(fixture.spoolPath, second);
    const plan = createRecoveryPlan({ spoolPath: fixture.spoolPath, experiencePath: fixture.experiencePath, repositoryId: 'repo-one', now: at });
    const database = new DatabaseSync(fixture.spoolPath);
    try { database.prepare("UPDATE capture_recovery_state SET reason = 'unknown-legacy' WHERE delivery_id = ?").run(plan.selections[1]!.deliveryId); }
    finally { database.close(); }
    assert.throws(() => applyRecoveryPlan({ spoolPath: fixture.spoolPath, experiencePath: fixture.experiencePath, plan, now: at }), /stale/i);
    const check = new DatabaseSync(fixture.spoolPath, { readOnly: true });
    try {
      for (const id of [first, second]) {
        const row = check.prepare('SELECT state, generation FROM capture_recovery_state WHERE delivery_id = ?').get(id) as { state: string; generation: number };
        assert.deepEqual({ ...row }, { state: 'held', generation: 1 });
      }
    } finally { check.close(); }
  } finally { fixture.spool.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test('ARC-A2 rejects a changed plan hash or incompatible writer floor before mutation', () => {
  const fixture = setup();
  try {
    const id = fixture.add('capability'); hold(fixture.spoolPath, id);
    const plan = createRecoveryPlan({ spoolPath: fixture.spoolPath, experiencePath: fixture.experiencePath, repositoryId: 'repo-one', now: at });
    assert.throws(() => applyRecoveryPlan({ spoolPath: fixture.spoolPath, experiencePath: fixture.experiencePath, plan: { ...plan, repositoryId: 'repo-two' }, now: at }), /hash/i);
    const database = new DatabaseSync(fixture.spoolPath);
    try { database.prepare('UPDATE ael_writer_contract SET minimum_writer = 3 WHERE id = 1').run(); }
    finally { database.close(); }
    assert.throws(() => applyRecoveryPlan({ spoolPath: fixture.spoolPath, experiencePath: fixture.experiencePath, plan, now: at }), /INCOMPATIBLE_WRITER/);
    const check = new DatabaseSync(fixture.spoolPath, { readOnly: true });
    try { assert.equal((check.prepare('SELECT state FROM capture_recovery_state WHERE delivery_id = ?').get(id) as { state: string }).state, 'held'); }
    finally { check.close(); }
  } finally { fixture.spool.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test('ARC-A2 does not select a payload that conflicts with existing repository scope', () => {
  const fixture = setup();
  try {
    const id = fixture.add('scope-conflict'); hold(fixture.spoolPath, id);
    const experience = new DatabaseSync(fixture.experiencePath);
    try {
      experience.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, repository_id TEXT)');
      experience.prepare('INSERT INTO sessions (id, source, repository_id) VALUES (?, ?, ?)').run('scope-conflict', 'codex', 'repo-two');
    } finally { experience.close(); }
    const plan = createRecoveryPlan({ spoolPath: fixture.spoolPath, experiencePath: fixture.experiencePath, repositoryId: 'repo-one', now: at });
    assert.equal(plan.selections.length, 0);
    assert.equal(JSON.stringify(plan).includes(id), false);
  } finally { fixture.spool.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});
