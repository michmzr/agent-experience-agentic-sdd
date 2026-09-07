import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { CaptureSpool } from '../src/capture/spool.js';
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
      failedAdmission: 0
    });
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
      failedAdmission: 0
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
  } finally {
    spool.close();
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
