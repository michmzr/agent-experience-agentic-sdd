import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

import { normalizeMappedCapture } from '../src/capture/normalization.js';
import { CaptureSpool } from '../src/capture/spool.js';
import { drainCaptureSpool } from '../src/capture/spool-drain.js';
import { persistPassiveCapture } from '../src/capture/passive-service.js';
import { ExperienceStore } from '../src/storage/experience-store.js';
import { assertWriterCompatible, minimumWriter } from '../src/installation/writer-contract.js';

interface Case { readonly sessionId: string; readonly missingRequestId: string; readonly unrelatedRequestId: string; readonly resultId: string; readonly receivedAt: string; }
const scenario = JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/ael-recovery-coverage/cases.json'), 'utf8')) as Case;

test('ARC-A1 missing request waits without accumulating attempts and only its arrival opens a new generation', () => {
  const root = mkdtempSync(join(tmpdir(), 'arc-a1-'));
  const spoolPath = join(root, 'capture-spool.sqlite');
  const databasePath = join(root, 'experience.sqlite');
  mkdirSync(join(root, '.ael'));
  writeFileSync(join(root, '.ael/settings.json'), '{"version":1,"captureDeliveryDeadlineMs":100}\n');
  const spool = new CaptureSpool(spoolPath);
  const event = (sourceEventId: string, phase: 'pre-action' | 'post-result', relatedEventId?: string) => normalizeMappedCapture({
    source: 'codex', sourceEventId, sessionId: scenario.sessionId as never, phase,
    occurredAt: '2026-09-29T08:01:00.000Z', tool: 'git', action: 'status', summary: 'Run git status.',
    ...(relatedEventId === undefined ? {} : { relatedEventId, outcome: 'succeeded' as const })
  });
  try {
    spool.admit({ kind: 'session-start', session: { id: scenario.sessionId as never, source: 'codex', startedAt: scenario.receivedAt } }, scenario.receivedAt);
    const missing = spool.admit({ kind: 'technical', event: event(scenario.resultId, 'post-result', scenario.missingRequestId) }, scenario.receivedAt);
    let drainSecond = 0;
    const drain = () => {
      const at = new Date(Date.parse('2026-09-29T08:02:00.000Z') + drainSecond++ * 1_000).toISOString();
      return drainCaptureSpool({ databasePath, projectRoot: root, now: () => at });
    };
    drain();
    for (let repeat = 0; repeat < 5; repeat += 1) drain();
    const database = new DatabaseSync(spoolPath);
    const attempts = database.prepare('SELECT attempts FROM records WHERE delivery_id = ?').get(missing.deliveryId) as { attempts: number };
    assert.equal(attempts.attempts, 1);
    const waiting = database.prepare('SELECT state, reason, generation FROM capture_recovery_state WHERE delivery_id = ?').get(missing.deliveryId) as { state: string; reason: string; generation: number };
    assert.deepEqual({ ...waiting }, { state: 'waiting-dependency', reason: 'missing-request', generation: 1 });
    spool.admit({ kind: 'technical', event: event(scenario.unrelatedRequestId, 'pre-action') }, scenario.receivedAt);
    drain();
    assert.deepEqual({ ...database.prepare('SELECT state, generation FROM capture_recovery_state WHERE delivery_id = ?').get(missing.deliveryId) }, { state: 'waiting-dependency', generation: 1 });
    spool.admit({ kind: 'technical', event: event(scenario.missingRequestId, 'pre-action') }, scenario.receivedAt);
    drain();
    const eligible = database.prepare('SELECT state, generation FROM capture_recovery_state WHERE delivery_id = ?').get(missing.deliveryId) as { state: string; generation: number };
    assert.deepEqual({ ...eligible }, { state: 'eligible', generation: 2 });
    drain();
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM records WHERE delivery_id = ?').get(missing.deliveryId)?.count, 0);
    const completed = database.prepare('SELECT state, reason, generation, dependency_key FROM capture_recovery_state WHERE delivery_id = ?').get(missing.deliveryId) as { state: string; reason: string; generation: number; dependency_key: string | null };
    assert.deepEqual({ ...completed }, { state: 'committed', reason: 'missing-request', generation: 2, dependency_key: null });
    database.close();
    assert.equal(spool.status().committed, 4);
  } finally { spool.close(); rmSync(root, { recursive: true, force: true }); }
});

test('ARC-A1 transient attempts stop at four across restart and keep the record held', () => {
  const root = mkdtempSync(join(tmpdir(), 'arc-a1-held-'));
  const path = join(root, 'capture-spool.sqlite');
  let spool = new CaptureSpool(path);
  try {
    const delivery = spool.admit({ kind: 'session-start', session: { id: 'arc-private-session' as never, source: 'codex', startedAt: scenario.receivedAt } }, scenario.receivedAt);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const at = new Date(Date.parse(scenario.receivedAt) + attempt * 1_000).toISOString();
      assert.equal(spool.claim(at, 1).length, 1);
      spool.retry(delivery.deliveryId, at, 'storage-unavailable');
    }
    spool.close();
    spool = new CaptureSpool(path);
    assert.equal(spool.claim('2026-09-29T08:10:00.000Z', 1).length, 0);
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const recovery = database.prepare('SELECT state, reason, generation, attempts, dependency_key FROM capture_recovery_state WHERE delivery_id = ?').get(delivery.deliveryId) as { state: string; reason: string; generation: number; attempts: number; dependency_key: string | null };
      assert.deepEqual({ ...recovery }, { state: 'held', reason: 'storage-unavailable', generation: 1, attempts: 4, dependency_key: null });
      assert.equal(JSON.stringify(recovery).includes('arc-private-session'), false);
      assert.equal((database.prepare('SELECT COUNT(*) AS count FROM records WHERE delivery_id = ?').get(delivery.deliveryId) as { count: number }).count, 1);
    } finally { database.close(); }
  } finally { spool.close(); rmSync(root, { recursive: true, force: true }); }
});

test('ARC-A1 expired worker leases consume the same four-attempt budget', () => {
  const root = mkdtempSync(join(tmpdir(), 'arc-a1-lease-'));
  const path = join(root, 'capture-spool.sqlite');
  let spool = new CaptureSpool(path);
  try {
    const delivery = spool.admit({ kind: 'session-start', session: { id: 'arc-lease-session' as never, source: 'codex', startedAt: scenario.receivedAt } }, scenario.receivedAt);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      assert.equal(spool.claim(new Date(Date.parse(scenario.receivedAt) + attempt * 31_000).toISOString(), 1).length, 1);
    }
    spool.close();
    spool = new CaptureSpool(path);
    assert.equal(spool.claim('2026-09-29T08:05:00.000Z', 1).length, 0);
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const recovery = database.prepare('SELECT state, attempts FROM capture_recovery_state WHERE delivery_id = ?').get(delivery.deliveryId) as { state: string; attempts: number };
      assert.deepEqual({ ...recovery }, { state: 'held', attempts: 4 });
    } finally { database.close(); }
  } finally { spool.close(); rmSync(root, { recursive: true, force: true }); }
});

test('ARC-A1 recovery-state migration raises the writer floor before an old writer can claim held work', () => {
  const root = mkdtempSync(join(tmpdir(), 'arc-a1-writer-'));
  const path = join(root, 'capture-spool.sqlite');
  const spool = new CaptureSpool(path);
  try {
    const delivery = spool.admit({ kind: 'session-start', session: { id: 'arc-writer-session' as never, source: 'codex', startedAt: scenario.receivedAt } }, scenario.receivedAt);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const at = new Date(Date.parse(scenario.receivedAt) + attempt * 1_000).toISOString();
      spool.claim(at, 1);
      spool.retry(delivery.deliveryId, at);
    }
    const waiting = spool.admit({ kind: 'session-end', source: 'codex', sessionId: 'arc-waiting-session' as never, endedAt: '2026-09-29T08:01:00.000Z' }, scenario.receivedAt);
    spool.claim('2026-09-29T08:02:00.000Z', 1);
    spool.waitForDependency(waiting.deliveryId, 'missing-session', 'codex', 'arc-waiting-session', '2026-09-29T08:02:00.000Z');
    assert.equal(minimumWriter(path), 2);
    const before = readFileSync(path);
    assert.throws(() => assertWriterCompatible([path], { capabilities: { writer: 1 } } as never), /INCOMPATIBLE_WRITER/);
    assert.deepEqual(readFileSync(path), before);
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal((database.prepare('SELECT state FROM capture_recovery_state WHERE delivery_id = ?').get(delivery.deliveryId) as { state: string }).state, 'held');
      assert.equal((database.prepare('SELECT state FROM records WHERE delivery_id = ?').get(delivery.deliveryId) as { state: string }).state, 'pending');
      assert.equal((database.prepare('SELECT state FROM capture_recovery_state WHERE delivery_id = ?').get(waiting.deliveryId) as { state: string }).state, 'waiting-dependency');
    } finally { database.close(); }
  } finally { spool.close(); rmSync(root, { recursive: true, force: true }); }
});

test('ARC-A1 resolves a post-result dependency from a resumed run', () => {
  const root = mkdtempSync(join(tmpdir(), 'arc-a1-resume-'));
  const databasePath = join(root, 'experience.sqlite');
  const spoolPath = join(root, 'capture-spool.sqlite');
  mkdirSync(join(root, '.ael'));
  writeFileSync(join(root, '.ael/settings.json'), '{"version":1,"captureDeliveryDeadlineMs":100}\n');
  const sessionId = 'arc-a1-resume' as never;
  const store = new ExperienceStore(databasePath);
  const lifecycle = (id: string, kind: 'start' | 'end', at: string, origin?: 'startup' | 'resume') => ({ sourceEventId: id, source: 'codex' as const, conversationId: sessionId, kind, receiptAt: at, ...(origin === undefined ? {} : { startOrigin: origin }) });
  try {
    persistPassiveCapture(store, { kind: 'session-start', session: { id: sessionId, source: 'codex', startedAt: '2026-09-29T08:00:00.000Z' }, lifecycle: lifecycle('arc:startup', 'start', '2026-09-29T08:00:00.000Z', 'startup') });
    persistPassiveCapture(store, { kind: 'session-end', source: 'codex', sessionId, endedAt: '2026-09-29T08:01:00.000Z', lifecycle: lifecycle('arc:end', 'end', '2026-09-29T08:01:00.000Z') });
    persistPassiveCapture(store, { kind: 'session-start', session: { id: sessionId, source: 'codex', startedAt: '2026-09-29T08:02:00.000Z' }, lifecycle: lifecycle('arc:resume', 'start', '2026-09-29T08:02:00.000Z', 'resume') });
  } finally { store.close(); }
  const spool = new CaptureSpool(spoolPath);
  try {
    const event = (phase: 'pre-action' | 'post-result') => normalizeMappedCapture({ source: 'codex', sourceEventId: `arc-resume:${phase}`, sessionId, phase, occurredAt: phase === 'pre-action' ? '2026-09-29T08:02:01.000Z' : '2026-09-29T08:02:02.000Z', tool: 'shell', action: 'test', summary: 'Run a focused test.', ...(phase === 'post-result' ? { outcome: 'succeeded' as const, relatedEventId: 'arc-resume:pre-action' } : {}) });
    spool.admit({ kind: 'technical', event: event('pre-action') }, '2026-09-29T08:02:01.000Z');
    assert.equal(drainCaptureSpool({ databasePath, projectRoot: root, now: () => '2026-09-29T08:03:00.000Z' }).committed, 1);
    spool.admit({ kind: 'technical', event: event('post-result') }, '2026-09-29T08:02:02.000Z');
    assert.equal(drainCaptureSpool({ databasePath, projectRoot: root, now: () => '2026-09-29T08:03:01.000Z' }).committed, 2);
  } finally { spool.close(); rmSync(root, { recursive: true, force: true }); }
});

test('ARC-A1 migration holds legacy records with exhausted or unknown retry history', () => {
  const root = mkdtempSync(join(tmpdir(), 'arc-a1-legacy-'));
  const path = join(root, 'capture-spool.sqlite');
  const initial = new CaptureSpool(path);
  const delivery = initial.admit({ kind: 'session-start', session: { id: 'arc-legacy-session' as never, source: 'codex', startedAt: scenario.receivedAt } }, scenario.receivedAt);
  initial.close();
  const legacy = new DatabaseSync(path);
  legacy.exec('DROP TABLE capture_recovery_state; UPDATE ael_writer_contract SET minimum_writer = 1 WHERE id = 1');
  legacy.prepare('UPDATE records SET attempts = 1411 WHERE delivery_id = ?').run(delivery.deliveryId);
  legacy.close();
  const migrated = new CaptureSpool(path);
  try {
    assert.equal(migrated.claim('2026-09-29T09:00:00.000Z', 1).length, 0);
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const state = database.prepare('SELECT state, reason, attempts FROM capture_recovery_state WHERE delivery_id = ?').get(delivery.deliveryId) as { state: string; reason: string; attempts: number };
      assert.deepEqual({ ...state }, { state: 'held', reason: 'unknown-legacy', attempts: 1411 });
      assert.equal(minimumWriter(path), 2);
    } finally { database.close(); }
  } finally { migrated.close(); rmSync(root, { recursive: true, force: true }); }
});

test('ARC-A1 classifies a concrete duplicate session conflict without parsing an exception message', () => {
  const root = mkdtempSync(join(tmpdir(), 'arc-a1-conflict-'));
  const databasePath = join(root, 'experience.sqlite');
  const path = join(root, 'capture-spool.sqlite');
  mkdirSync(join(root, '.ael'));
  writeFileSync(join(root, '.ael/settings.json'), '{"version":1,"captureDeliveryDeadlineMs":100}\n');
  const spool = new CaptureSpool(path);
  try {
    const original = { kind: 'session-start' as const, session: { id: 'arc-conflict-session' as never, source: 'codex' as const, startedAt: '2026-09-29T08:00:00.000Z' } };
    spool.admit(original, scenario.receivedAt);
    drainCaptureSpool({ databasePath, projectRoot: root, now: () => '2026-09-29T08:01:00.000Z' });
    const conflict = spool.admit({ ...original, session: { ...original.session, startedAt: '2026-09-29T08:00:01.000Z' } }, scenario.receivedAt);
    drainCaptureSpool({ databasePath, projectRoot: root, now: () => '2026-09-29T08:01:01.000Z' });
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const state = database.prepare('SELECT state, reason FROM capture_recovery_state WHERE delivery_id = ?').get(conflict.deliveryId) as { state: string; reason: string };
      assert.deepEqual({ ...state }, { state: 'quarantined', reason: 'conflicting-identity' });
    } finally { database.close(); }
  } finally { spool.close(); rmSync(root, { recursive: true, force: true }); }
});

test('ARC-A1 concurrent cold receipt migration preserves old rows and installs writer 2 atomically', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arc-a1-cold-'));
  const path = join(root, 'capture-spool.sqlite');
  const setup = new CaptureSpool(path);
  setup.close();
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP TABLE capture_receipts; CREATE TABLE capture_receipts (sequence INTEGER PRIMARY KEY, correlation_key TEXT NOT NULL, disposition TEXT NOT NULL, received_at TEXT NOT NULL) STRICT; UPDATE ael_writer_contract SET minimum_writer = 1 WHERE id = 1;");
  legacy.prepare('INSERT INTO capture_receipts (correlation_key, disposition, received_at) VALUES (?, ?, ?)').run('a'.repeat(64), 'accepted', scenario.receivedAt);
  legacy.close();
  const script = `import {CaptureSpool} from '${join(process.cwd(), 'dist/src/capture/spool.js')}'; const spool = new CaptureSpool(process.argv[1]); spool.close();`;
  try {
    const children = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', script, path], { stdio: ['ignore', 'ignore', 'pipe'] }));
    const exits = await Promise.all(children.map(async child => {
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', data => { stderr += data; });
      const [code] = await once(child, 'exit');
      return { code, stderr };
    }));
    assert.deepEqual(exits, [{ code: 0, stderr: '' }, { code: 0, stderr: '' }]);
    const migrated = new CaptureSpool(path);
    try {
      const old = migrated.receiptReport().receipts[0]!;
      assert.equal(old.buildRole, 'unknown');
      assert.equal(old.correlationKey, 'a'.repeat(64));
      assert.equal(minimumWriter(path), 2);
    } finally { migrated.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ARC-A1 recovery history prunes at 256 completed rows and keeps the newest 10000', () => {
  const root = mkdtempSync(join(tmpdir(), 'arc-a1-history-'));
  const path = join(root, 'capture-spool.sqlite');
  const spool = new CaptureSpool(path);
  try {
    const database = new DatabaseSync(path);
    database.exec('BEGIN IMMEDIATE');
    try {
      const insert = database.prepare("INSERT INTO capture_recovery_state (delivery_id, state, reason, generation, attempts, updated_at) VALUES (?, 'committed', 'unknown-legacy', 1, 0, ?)");
      for (let index = 0; index < 10255; index += 1) insert.run(`historical-${index}`, scenario.receivedAt);
      database.exec('COMMIT');
    } catch (error) { database.exec('ROLLBACK'); throw error; }
    const record = spool.admit({ kind: 'session-start', session: { id: 'arc-history-current' as never, source: 'codex', startedAt: scenario.receivedAt } }, scenario.receivedAt);
    spool.claim(scenario.receivedAt, 1);
    database.prepare('UPDATE counters SET committed = 255 WHERE id = 1').run();
    spool.acknowledge(record.deliveryId);
    const count = (database.prepare('SELECT COUNT(*) AS count FROM capture_recovery_state').get() as { count: number }).count;
    assert.equal(count, 10000);
    assert.equal(database.prepare('SELECT 1 FROM capture_recovery_state WHERE delivery_id = ?').get(record.deliveryId) !== undefined, true);
    database.close();
  } finally { spool.close(); rmSync(root, { recursive: true, force: true }); }
});
