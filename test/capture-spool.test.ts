import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { CaptureSpool } from '../src/capture/spool.js';
import { drainCaptureSpool, waitForWorkerCompletion } from '../src/capture/spool-drain.js';
import type { PassiveCaptureRecord } from '../src/capture/passive-service.js';
import { OperationalLearningRepository } from '../src/learning/repository.js';
import { OperationalLearningService } from '../src/learning/service.js';
import { startAnalysisWorker } from '../src/learning/worker-launcher.js';
import { ExperienceStore } from '../src/storage/experience-store.js';

function dataDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'ael-capture-spool-'));
}

function sessionStart(): Extract<PassiveCaptureRecord, { readonly kind: 'session-start' }> {
  return {
    kind: 'session-start',
    session: {
      id: 'session-1' as never,
      source: 'codex',
      startedAt: '2026-09-07T08:00:00.000Z'
    }
  };
}

function differentSessionStart(): PassiveCaptureRecord {
  const record = sessionStart();
  return { ...record, session: { ...record.session, id: 'session-2' as never } };
}

function registerRepository(databasePath: string, root: string, repositoryId = 'repo-1'): void {
  const store = new ExperienceStore(databasePath);
  try { store.registerRepository({ id: repositoryId, root, observedAt: '2026-09-07T08:00:00.000Z' }); }
  finally { store.close(); }
}

test('durably admits a sanitized record once and reports pending status', () => {
  const dataDir = dataDirectory();
  const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
  try {
    assert.equal(spool.admit(sessionStart()).status, 'admitted');
    assert.equal(spool.admit(sessionStart()).status, 'duplicate');
    assert.deepEqual(spool.status(), {
      version: 1,
      admitted: 1,
      pending: 1,
      claimed: 0,
      committed: 0,
      quarantined: 0,
      failedAdmission: 0,
      delayedDelivery: { count: 0 }
    });
  } finally {
    spool.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('accounts for privacy-bounded capture receipt dispositions without retaining raw payload markers', () => {
  const dataDir = dataDirectory();
  const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
  try {
    spool.recordReceipt({ source: 'codex', receivedAt: '2026-09-12T08:00:00.000Z', disposition: 'privacy-redaction', correlationInput: 'private-marker-must-not-persist' });
    spool.recordReceipt({ source: 'codex', receivedAt: '2026-09-12T08:00:01.000Z', disposition: 'unsupported-tool' });
    const report = spool.receiptReport();
    assert.equal(report.accounting, 'available');
    assert.equal(report.byDisposition['privacy-redaction'], 1);
    assert.equal(report.byDisposition['unsupported-tool'], 1);
    assert.match(report.receipts[0]!.correlationKey, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(report).includes('private-marker-must-not-persist'), false);
    spool.markReceiptAccountingUnavailable();
    assert.equal(spool.receiptReport().accounting, 'unavailable');
  } finally {
    spool.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('keeps admission atomic with its accepted receipt and marks accounting unavailable on injected receipt failure', () => {
  const dataDir = dataDirectory();
  const path = join(dataDir, 'capture-spool.sqlite');
  const failing = new CaptureSpool(path, { failReceiptPersistence: true });
  try {
    assert.throws(() => failing.admitWithReceipt(sessionStart(), { source: 'codex', receivedAt: '2026-09-12T08:00:00.000Z' }), /receipt/i);
    assert.equal(failing.status().admitted, 0);
    assert.equal(failing.receiptReport().accounting, 'unavailable');
  } finally { failing.close(); }
  const spool = new CaptureSpool(path);
  try {
    assert.equal(spool.admitWithReceipt(sessionStart(), { source: 'codex', receivedAt: '2026-09-12T08:00:01.000Z' }).status, 'admitted');
    assert.equal(spool.receiptReport().byDisposition.accepted, 1);
  } finally { spool.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('accounts for delivery retry and quarantine dispositions', () => {
  const dataDir = dataDirectory();
  const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
  try {
    const delivery = spool.admitWithReceipt(sessionStart(), { source: 'codex', receivedAt: '2026-09-12T08:00:00.000Z' });
    spool.claim('2026-09-12T08:00:00.000Z', 1);
    spool.retry(delivery.deliveryId, '2026-09-12T08:00:01.000Z');
    spool.quarantine(delivery.deliveryId, 'CORRUPT', '2026-09-12T08:00:02.000Z');
    const receipts = spool.receiptReport().byDisposition;
    assert.equal(receipts['delivery-retry'], 1);
    assert.equal(receipts.quarantine, 1);
  } finally { spool.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('bounds retained and reported receipts deterministically', () => {
  const dataDir = dataDirectory();
  const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'), { maxReceipts: 2 });
  try {
    spool.recordReceipt({ source: 'codex', receivedAt: '2026-09-12T08:00:00.000Z', disposition: 'accepted' });
    spool.recordReceipt({ source: 'codex', receivedAt: '2026-09-12T08:00:01.000Z', disposition: 'duplicate' });
    spool.recordReceipt({ source: 'codex', receivedAt: '2026-09-12T08:00:02.000Z', disposition: 'delivery-retry' });
    const report = spool.receiptReport();
    assert.deepEqual(report.receipts.map(({ receivedAt }) => receivedAt), ['2026-09-12T08:00:01.000Z', '2026-09-12T08:00:02.000Z']);
    assert.equal(report.byDisposition.accepted, 0);
    assert.equal(report.byDisposition['delivery-retry'], 1);
  } finally { spool.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('rolls back a retry when its receipt cannot persist and marks accounting unavailable', () => {
  const dataDir = dataDirectory();
  const path = join(dataDir, 'capture-spool.sqlite');
  const admitted = new CaptureSpool(path);
  const delivery = admitted.admit(sessionStart(), '2026-09-12T08:00:00.000Z');
  admitted.close();
  const spool = new CaptureSpool(path, { failReceiptPersistence: true });
  try {
    spool.claim('2026-09-12T08:00:00.000Z', 1);
    assert.throws(() => spool.retry(delivery.deliveryId, '2026-09-12T08:00:01.000Z'), /receipt/i);
    assert.equal(spool.status().claimed, 1);
    assert.equal(spool.receiptReport().accounting, 'unavailable');
  } finally { spool.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('reclaims expired claims and acknowledges a committed delivery once', () => {
  const dataDir = dataDirectory();
  const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
  try {
    spool.admit(sessionStart(), '2026-09-07T08:00:00.000Z');
    const [firstClaim] = spool.claim('2026-09-07T08:00:00.000Z', 1);
    assert.ok(firstClaim);
    const [reclaimed] = spool.claim('2026-09-07T08:00:31.000Z', 1);
    assert.equal(reclaimed?.deliveryId, firstClaim.deliveryId);
    spool.acknowledge(reclaimed!.deliveryId);
    assert.deepEqual(spool.status(), {
      version: 1,
      admitted: 1,
      pending: 0,
      claimed: 0,
      committed: 1,
      quarantined: 0,
      failedAdmission: 0,
      delayedDelivery: { count: 0 }
    });
  } finally {
    spool.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('quarantines only normalized stored data and bounded metadata', () => {
  const dataDir = dataDirectory();
  const spoolPath = join(dataDir, 'capture-spool.sqlite');
  const spool = new CaptureSpool(spoolPath);
  try {
    spool.admit(sessionStart(), '2026-09-07T08:00:00.000Z');
    const [claimed] = spool.claim('2026-09-07T08:00:00.000Z', 1);
    spool.quarantine(claimed!.deliveryId, 'CORRUPT');
    assert.equal(readFileSync(spoolPath).includes(Buffer.from('untrusted-hook-payload-marker')), false);
    assert.equal(spool.status().quarantined, 1);
  } finally {
    spool.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('rejects admission at configured capacity without evicting pending work', () => {
  const dataDir = dataDirectory();
  const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'), { maxActiveRecords: 1 });
  try {
    assert.equal(spool.admit(sessionStart()).status, 'admitted');
    assert.throws(() => spool.admit(differentSessionStart()), /capacity/i);
    assert.equal(spool.status().pending, 1);
    assert.equal(spool.status().failedAdmission, 1);
  } finally {
    spool.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('allows only one bounded drain owner and recovers an expired owner', () => {
  const dataDir = dataDirectory();
  const path = join(dataDir, 'capture-spool.sqlite');
  const first = new CaptureSpool(path);
  const second = new CaptureSpool(path);
  try {
    assert.equal(first.tryAcquireDrainLock('worker-1', '2026-09-07T08:00:00.000Z', 2_000), true);
    assert.equal(second.tryAcquireDrainLock('worker-2', '2026-09-07T08:00:01.000Z', 2_000), false);
    assert.equal(second.tryAcquireDrainLock('worker-2', '2026-09-07T08:00:02.000Z', 2_000), true);
    second.releaseDrainLock('worker-2');
    assert.equal(first.tryAcquireDrainLock('worker-1', '2026-09-07T08:00:02.001Z', 2_000), true);
  } finally {
    first.close();
    second.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('quarantines a corrupt stored record without blocking later records', () => {
  const dataDir = dataDirectory();
  const spoolPath = join(dataDir, 'capture-spool.sqlite');
  const spool = new CaptureSpool(spoolPath);
  try {
    const corrupt = spool.admit(sessionStart(), '2026-09-07T08:00:00.000Z');
    spool.admit(differentSessionStart(), '2026-09-07T08:00:00.000Z');
    const database = new DatabaseSync(spoolPath);
    database.prepare('UPDATE records SET payload = ? WHERE delivery_id = ?').run('{', corrupt.deliveryId);
    database.close();
    const [claimed] = spool.claim('2026-09-07T08:00:01.000Z', 10);
    assert.equal(claimed?.record.kind, 'session-start');
    assert.equal(spool.status().quarantined, 1);
    assert.equal(spool.receiptReport().byDisposition.quarantine, 1);
  } finally {
    spool.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('logs bounded delayed-delivery timestamps and the eventual commit', () => {
  const dataDir = dataDirectory();
  const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
  try {
    spool.admit(sessionStart(), '2026-09-07T08:00:00.000Z');
    const [claimed] = spool.claim('2026-09-07T08:00:03.000Z', 1);
    spool.recordDelayedDelivery(claimed!.deliveryId, '2026-09-07T08:00:02.000Z', '2026-09-07T08:00:03.000Z');
    spool.acknowledge(claimed!.deliveryId, '2026-09-07T08:00:04.000Z');
    assert.deepEqual(spool.status().delayedDelivery, {
      count: 1,
      latest: {
        admittedAt: '2026-09-07T08:00:00.000Z',
        deadlineAt: '2026-09-07T08:00:02.000Z',
        detectedAt: '2026-09-07T08:00:03.000Z',
        committedAt: '2026-09-07T08:00:04.000Z'
      }
    });
  } finally {
    spool.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('admits repository-bound committed capture for analysis without making capture depend on admission', () => {
  const dataDir = dataDirectory();
  const databasePath = join(dataDir, 'experience.sqlite');
  const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
  const received: Array<{ repositoryId: string; sessionId: string }> = [];
  try {
    registerRepository(databasePath, dataDir);
    spool.admit({ kind: 'session-start', session: { ...sessionStart().session, repositoryId: 'repo-1' as never } }, '2026-09-07T08:00:00.000Z');
    assert.equal(drainCaptureSpool({ databasePath, now: () => '2026-09-07T08:00:01.000Z', learningAdmission: { enqueueCommittedSession(repositoryId, sessionId) { received.push({ repositoryId, sessionId }); return true; } }, scheduleAnalysis() {} }).committed, 1);
    assert.deepEqual(received, [{ repositoryId: 'repo-1', sessionId: 'session-1' }]);

    spool.admit({ kind: 'session-start', session: { ...sessionStart().session, id: 'session-2' as never, repositoryId: 'repo-1' as never } }, '2026-09-07T08:00:01.000Z');
    assert.equal(drainCaptureSpool({ databasePath, now: () => '2026-09-07T08:00:02.000Z', learningAdmission: { enqueueCommittedSession() { throw new Error('analysis unavailable'); } }, scheduleAnalysis() { throw new Error('must not schedule'); } }).committed, 2);
  } finally {
    spool.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('schedules analysis once per drain only after every admitted capture is persisted and acknowledged', () => {
  const dataDir = dataDirectory();
  const databasePath = join(dataDir, 'experience.sqlite');
  const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
  const admitted: string[] = [];
  let launches = 0;
  try {
    registerRepository(databasePath, dataDir);
    spool.admit({ kind: 'session-start', session: { ...sessionStart().session, repositoryId: 'repo-1' as never } }, '2026-09-07T08:00:00.000Z');
    spool.admit({ kind: 'session-start', session: { ...sessionStart().session, id: 'session-2' as never, repositoryId: 'repo-1' as never } }, '2026-09-07T08:00:00.000Z');

    const status = drainCaptureSpool({
      databasePath,
      now: () => '2026-09-07T08:00:01.000Z',
      learningAdmission: {
        enqueueCommittedSession(_repositoryId, sessionId) {
          admitted.push(sessionId);
          return true;
        }
      },
      scheduleAnalysis() {
        launches += 1;
        const observedSpool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
        const observedStore = new ExperienceStore(databasePath);
        try {
          assert.equal(observedSpool.status().committed, 2);
          assert.ok(observedStore.loadSession('session-1' as never));
          assert.ok(observedStore.loadSession('session-2' as never));
        } finally {
          observedStore.close();
          observedSpool.close();
        }
      }
    });

    assert.equal(status.committed, 2);
    assert.deepEqual(admitted.sort(), ['session-1', 'session-2']);
    assert.equal(launches, 1);
  } finally {
    spool.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('does not schedule analysis when admission reports no new work', () => {
  const dataDir = dataDirectory();
  const databasePath = join(dataDir, 'experience.sqlite');
  const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
  let launches = 0;
  try {
    registerRepository(databasePath, dataDir);
    spool.admit({ kind: 'session-start', session: { ...sessionStart().session, repositoryId: 'repo-1' as never } }, '2026-09-07T08:00:00.000Z');
    const status = drainCaptureSpool({
      databasePath,
      now: () => '2026-09-07T08:00:01.000Z',
      learningAdmission: { enqueueCommittedSession() { return false; } },
      scheduleAnalysis() { launches += 1; }
    });
    assert.equal(status.committed, 1);
    assert.equal(launches, 0);
  } finally {
    spool.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('keeps capture acknowledged and records a bounded diagnostic when scheduling throws', () => {
  const dataDir = dataDirectory();
  const databasePath = join(dataDir, 'experience.sqlite');
  const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
  try {
    registerRepository(databasePath, dataDir);
    spool.admit({ kind: 'session-start', session: { ...sessionStart().session, repositoryId: 'repo-1' as never } }, '2026-09-07T08:00:00.000Z');
    const status = drainCaptureSpool({
      databasePath,
      now: () => '2026-09-07T08:00:01.000Z',
      learningAdmission: { enqueueCommittedSession() { return true; } },
      scheduleAnalysis() { throw new Error('process unavailable'); }
    });
    assert.equal(status.committed, 1);
    const repository = new OperationalLearningRepository(databasePath);
    try { assert.equal(repository.status().diagnostics['coordinator-launch-failed'], 1); }
    finally { repository.close(); }
    const database = new DatabaseSync(databasePath);
    try {
      assert.equal(database.prepare("SELECT last_at FROM operational_analysis_diagnostics WHERE code = 'coordinator-launch-failed'").get()?.last_at,
        '2026-09-07T08:00:01.000Z');
    } finally { database.close(); }
  } finally {
    spool.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('replay schedules durable analysis work after admission committed before capture acknowledgement failed', () => {
  const dataDir = dataDirectory();
  const root = dataDirectory();
  const databasePath = join(dataDir, 'experience.sqlite');
  const spoolPath = join(dataDir, 'capture-spool.sqlite');
  const spool = new CaptureSpool(spoolPath);
  let launches = 0;
  try {
    mkdirSync(join(root, '.ael'));
    writeFileSync(join(root, '.ael', 'settings.json'), '{"version":1,"captureDeliveryDeadlineMs":100}\n');
    registerRepository(databasePath, root);
    spool.admit({ kind: 'session-start', session: { ...sessionStart().session, repositoryId: 'repo-1' as never } }, '2026-09-07T08:00:00.000Z');
    const database = new DatabaseSync(spoolPath);
    database.exec("CREATE TRIGGER fail_capture_ack BEFORE DELETE ON records BEGIN SELECT RAISE(ABORT, 'ack failed'); END;");
    database.close();

    const learning = new OperationalLearningService(databasePath);
    const first = drainCaptureSpool({ databasePath, projectRoot: root, now: () => '2026-09-07T08:00:01.000Z',
      learningAdmission: learning, scheduleAnalysis() { launches += 1; } });
    assert.equal(first.committed, 0);
    assert.equal(first.pending, 1);
    assert.equal(launches, 0);
    const admitted = new OperationalLearningRepository(databasePath);
    try { assert.equal(admitted.hasOutstandingWork(), true); }
    finally { admitted.close(); }

    const repair = new DatabaseSync(spoolPath);
    repair.exec('DROP TRIGGER fail_capture_ack');
    repair.close();
    const replay = drainCaptureSpool({ databasePath, projectRoot: root, now: () => '2026-09-07T08:00:02.000Z',
      learningAdmission: learning, scheduleAnalysis() { launches += 1; } });
    assert.equal(replay.committed, 1);
    assert.equal(replay.pending, 0);
    assert.equal(launches, 1);
  } finally {
    spool.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('one acknowledged record cannot wake a distinct analysis stream whose capture acknowledgement failed', () => {
  const dataDir = dataDirectory();
  const root = dataDirectory();
  const databasePath = join(dataDir, 'experience.sqlite');
  const spoolPath = join(dataDir, 'capture-spool.sqlite');
  const spool = new CaptureSpool(spoolPath);
  let launches = 0;
  try {
    mkdirSync(join(root, '.ael'));
    writeFileSync(join(root, '.ael', 'settings.json'), '{"version":1,"captureDeliveryDeadlineMs":100}\n');
    registerRepository(databasePath, root);
    spool.admit({ kind: 'session-start', session: { ...sessionStart().session, repositoryId: 'repo-1' as never } }, '2026-09-07T08:00:00.000Z');
    const second = spool.admit({ kind: 'session-start', session: { ...sessionStart().session, id: 'session-2' as never,
      repositoryId: 'repo-1' as never } }, '2026-09-07T08:00:00.001Z');
    const database = new DatabaseSync(spoolPath);
    database.exec(`CREATE TRIGGER fail_second_capture_ack BEFORE DELETE ON records
      WHEN OLD.delivery_id = '${second.deliveryId}' BEGIN SELECT RAISE(ABORT, 'ack failed'); END;`);
    database.close();

    const learning = new OperationalLearningService(databasePath);
    const first = drainCaptureSpool({ databasePath, projectRoot: root, now: () => '2026-09-07T08:00:01.000Z',
      learningAdmission: learning, scheduleAnalysis() { launches += 1; } });
    assert.equal(first.committed, 1);
    assert.equal(first.pending, 1);
    assert.equal(launches, 0, 'the acknowledged first stream must not wake the unacknowledged second stream');
    const repository = new OperationalLearningRepository(databasePath);
    try {
      assert.equal(repository.jobsForStream('repo-1', 'session-1').length, 1);
      assert.equal(repository.jobsForStream('repo-1', 'session-2').length, 1);
    } finally { repository.close(); }

    const repair = new DatabaseSync(spoolPath);
    repair.exec('DROP TRIGGER fail_second_capture_ack');
    repair.close();
    const replay = drainCaptureSpool({ databasePath, projectRoot: root, now: () => '2026-09-07T08:00:02.000Z',
      learningAdmission: learning, scheduleAnalysis() { launches += 1; } });
    assert.equal(replay.committed, 2);
    assert.equal(replay.pending, 0);
    assert.equal(launches, 1);
  } finally {
    spool.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('an empty drain wakes durable outstanding work but ignores completed-only analysis state', () => {
  for (const state of ['outstanding', 'completed'] as const) {
    const dataDir = dataDirectory();
    const databasePath = join(dataDir, 'experience.sqlite');
    let launches = 0;
    try {
      const repository = new OperationalLearningRepository(databasePath);
      const job = repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 0 })!;
      if (state === 'completed') {
        repository.claim();
        repository.saveResult(job.id, { episodes: [], findings: [], candidates: [] });
      }
      repository.close();
      const status = drainCaptureSpool({ databasePath, now: () => '2026-09-07T08:00:01.000Z',
        learningAdmission: { enqueueCommittedSession() { return false; } }, scheduleAnalysis() { launches += 1; } });
      assert.equal(status.committed, 0);
      assert.equal(launches, state === 'outstanding' ? 1 : 0);
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  }
});

test('reports synchronous worker launch failure through the bounded callback', () => {
  let failures = 0;
  startAnalysisWorker({ dataDirectory: '\0', onFailure() { failures += 1; } });
  assert.equal(failures, 1);
});

test('reports an asynchronous spawn error once even if cleanup also throws synchronously', async () => {
  let failures = 0;
  const child = new EventEmitter() as EventEmitter & { unref(): void };
  child.unref = () => { throw new Error('cleanup failed'); };
  startAnalysisWorker({ dataDirectory: '/tmp/ael', onFailure() { failures += 1; } }, {
    spawn() {
      queueMicrotask(() => child.emit('error', new Error('launch failed')));
      return child;
    }
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(failures, 1);
});

test('can disable automatic operational learning without disabling capture', () => {
  const dataDir = dataDirectory();
  const root = dataDirectory();
  const databasePath = join(dataDir, 'experience.sqlite');
  const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
  let admitted = false;
  try {
    mkdirSync(join(root, '.ael'));
    writeFileSync(join(root, '.ael', 'settings.json'), '{"version":1,"captureDeliveryDeadlineMs":2000,"automaticOperationalLearning":false}\n');
    registerRepository(databasePath, root);
    spool.admit({ kind: 'session-start', session: { ...sessionStart().session, repositoryId: 'repo-1' as never } }, '2026-09-07T08:00:00.000Z');
    assert.equal(drainCaptureSpool({ databasePath, projectRoot: root, now: () => '2026-09-07T08:00:01.000Z', learningAdmission: { enqueueCommittedSession() { admitted = true; return true; } }, scheduleAnalysis() { throw new Error('must not schedule'); } }).committed, 1);
    assert.equal(admitted, false);
  } finally {
    spool.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('publishes worker completion only after the drain releases its lock', () => {
  const dataDir = dataDirectory();
  const databasePath = join(dataDir, 'experience.sqlite');
  const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
  try {
    spool.admit(sessionStart(), '2026-09-12T10:00:00.000Z');
    assert.equal(waitForWorkerCompletion(dataDir), false);
    drainCaptureSpool({ databasePath, now: () => '2026-09-12T10:00:01.000Z' });
    assert.equal(waitForWorkerCompletion(dataDir), true);
    assert.equal(spool.tryAcquireDrainLock('post-completion', '2026-09-12T10:00:02.000Z', 1_000), true);
  } finally { spool.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('a concurrent drain contender cannot publish completion and a successor fences predecessor completion', () => {
  const dataDir = dataDirectory();
  const databasePath = join(dataDir, 'experience.sqlite');
  const owner = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
  try {
    assert.equal(owner.tryAcquireDrainLock('owner', new Date().toISOString(), 60_000), true);
    drainCaptureSpool({ databasePath, now: () => '2026-09-12T10:00:01.000Z' });
    assert.equal(waitForWorkerCompletion(dataDir), false);
    assert.equal(owner.completeDrain('owner'), true);
    assert.equal(owner.tryAcquireDrainLock('successor', new Date().toISOString(), 60_000), true);
    assert.equal(waitForWorkerCompletion(dataDir), false);
  } finally { owner.releaseDrainLock('owner'); owner.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('applies automatic learning settings from each registered repository in a mixed batch', () => {
  for (const scenario of [
    { invocation: 'disabled', order: ['disabled', 'enabled'] as const },
    { invocation: 'enabled', order: ['enabled', 'disabled'] as const }
  ]) {
    const dataDir = dataDirectory();
    const enabledRoot = dataDirectory();
    const disabledRoot = dataDirectory();
    const databasePath = join(dataDir, 'experience.sqlite');
    const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
    const admitted: string[] = [];
    let launches = 0;
    try {
      mkdirSync(join(enabledRoot, '.ael'));
      mkdirSync(join(disabledRoot, '.ael'));
      writeFileSync(join(enabledRoot, '.ael', 'settings.json'), '{"version":1,"captureDeliveryDeadlineMs":2000}\n');
      writeFileSync(join(disabledRoot, '.ael', 'settings.json'), '{"version":1,"captureDeliveryDeadlineMs":2000,"automaticOperationalLearning":false}\n');
      const store = new ExperienceStore(databasePath);
      store.registerRepository({ id: 'repo-enabled', root: enabledRoot, observedAt: '2026-09-07T08:00:00.000Z' });
      store.registerRepository({ id: 'repo-disabled', root: disabledRoot, observedAt: '2026-09-07T08:00:00.000Z' });
      store.close();
      for (const [index, repository] of scenario.order.entries()) {
        spool.admit({ kind: 'session-start', session: { ...sessionStart().session,
          id: `session-${repository}` as never, repositoryId: `repo-${repository}` as never } },
        `2026-09-07T08:00:00.00${index}Z`);
      }

      const status = drainCaptureSpool({
        databasePath,
        projectRoot: scenario.invocation === 'enabled' ? enabledRoot : disabledRoot,
        now: () => '2026-09-07T08:00:01.000Z',
        learningAdmission: {
          enqueueCommittedSession(_repositoryId, sessionId) {
            admitted.push(sessionId);
            return true;
          }
        },
        scheduleAnalysis() {
          launches += 1;
          assert.equal(spool.status().committed, 2, 'the full capture batch is acknowledged before analysis starts');
        }
      });

      assert.equal(status.committed, 2);
      assert.deepEqual(admitted, ['session-enabled']);
      assert.equal(launches, 1);
    } finally {
      spool.close();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(enabledRoot, { recursive: true, force: true });
      rmSync(disabledRoot, { recursive: true, force: true });
    }
  }
});

test('a disabled hook or empty drain wakes durable work admitted for another repository', () => {
  for (const mode of ['disabled-hook', 'empty'] as const) {
    const dataDir = dataDirectory();
    const disabledRoot = dataDirectory();
    const databasePath = join(dataDir, 'experience.sqlite');
    const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
    let launches = 0;
    try {
      mkdirSync(join(disabledRoot, '.ael'));
      writeFileSync(join(disabledRoot, '.ael', 'settings.json'), '{"version":1,"captureDeliveryDeadlineMs":2000,"automaticOperationalLearning":false}\n');
      registerRepository(databasePath, disabledRoot, 'repo-disabled');
      const repository = new OperationalLearningRepository(databasePath);
      repository.enqueue({ repositoryId: 'repo-enabled', sessionId: 'session-existing', inputHighWater: 0 });
      repository.close();
      if (mode === 'disabled-hook') {
        spool.admit({ kind: 'session-start', session: { ...sessionStart().session,
          id: 'session-disabled' as never, repositoryId: 'repo-disabled' as never } }, '2026-09-07T08:00:00.000Z');
      }

      const status = drainCaptureSpool({ databasePath, projectRoot: disabledRoot,
        now: () => '2026-09-07T08:00:01.000Z', learningAdmission: { enqueueCommittedSession() { throw new Error('disabled repository must not be admitted'); } },
        scheduleAnalysis() {
          launches += 1;
          assert.equal(spool.status().committed, mode === 'disabled-hook' ? 1 : 0);
        } });

      assert.equal(status.committed, mode === 'disabled-hook' ? 1 : 0);
      assert.equal(launches, 1);
    } finally {
      spool.close();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(disabledRoot, { recursive: true, force: true });
    }
  }
});
