import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { CaptureSpool } from '../src/capture/spool.js';
import { drainCaptureSpool } from '../src/capture/spool-drain.js';
import type { PassiveCaptureRecord } from '../src/capture/passive-service.js';

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
    spool.admit({ kind: 'session-start', session: { ...sessionStart().session, repositoryId: 'repo-1' as never } }, '2026-09-07T08:00:00.000Z');
    assert.equal(drainCaptureSpool({ databasePath, now: () => '2026-09-07T08:00:01.000Z', learningAdmission: { enqueueCommittedSession(repositoryId, sessionId) { received.push({ repositoryId, sessionId }); } } }).committed, 1);
    assert.deepEqual(received, [{ repositoryId: 'repo-1', sessionId: 'session-1' }]);

    spool.admit({ kind: 'session-start', session: { ...sessionStart().session, id: 'session-2' as never, repositoryId: 'repo-1' as never } }, '2026-09-07T08:00:01.000Z');
    assert.equal(drainCaptureSpool({ databasePath, now: () => '2026-09-07T08:00:02.000Z', learningAdmission: { enqueueCommittedSession() { throw new Error('analysis unavailable'); } } }).committed, 2);
  } finally {
    spool.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
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
    spool.admit({ kind: 'session-start', session: { ...sessionStart().session, repositoryId: 'repo-1' as never } }, '2026-09-07T08:00:00.000Z');
    assert.equal(drainCaptureSpool({ databasePath, projectRoot: root, now: () => '2026-09-07T08:00:01.000Z', learningAdmission: { enqueueCommittedSession() { admitted = true; } } }).committed, 1);
    assert.equal(admitted, false);
  } finally {
    spool.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
