import { assertWriterCompatible } from '../installation/writer-contract.js';
import { runningBuild, type BuildManifest } from '../installation/build-manifest.js';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { PassiveCaptureRecord } from './passive-service.js';
import type { CaptureRecoveryReason } from './contracts.js';

const SPOOL_VERSION = 1;
const ADMISSION_BUSY_TIMEOUT_MS = 100;
const MAX_ACTIVE_RECORDS = 50_000;
const MAX_ACTIVE_BYTES = 32 * 1024 * 1024;
const MAX_RECEIPTS = 10_000;
const MAX_AUTOMATIC_ATTEMPTS = 4;

export interface SpoolAdmission {
  readonly status: 'admitted' | 'duplicate';
  readonly deliveryId: string;
}

export interface CaptureSpoolOptions {
  readonly maxActiveRecords?: number;
  readonly maxActiveBytes?: number;
  readonly failReceiptPersistence?: boolean;
  readonly maxReceipts?: number;
}

export type CaptureDisposition = 'accepted' | 'duplicate' | 'unsupported-tool' | 'privacy-redaction' | 'unsafe-normalization' | 'malformed-envelope' | 'admission-failure' | 'delivery-retry' | 'quarantine' | 'legacy-unknown';
export interface CaptureReceiptInput { readonly source: 'codex' | 'cursor'; readonly receivedAt: string; readonly disposition: CaptureDisposition; readonly correlationInput?: string; }
export interface CaptureReceipt {
  readonly correlationKey: string;
  readonly operationKey?: string;
  readonly disposition: CaptureDisposition;
  readonly receivedAt: string;
  readonly buildRole: 'capture' | 'writer' | 'unknown';
  readonly buildId?: string;
  readonly writer?: number;
}
export interface CaptureReceiptReport {
  readonly accounting: 'available' | 'unavailable';
  readonly receipts: readonly CaptureReceipt[];
  readonly byDisposition: Readonly<Record<CaptureDisposition, number>>;
  readonly retention?: { readonly firstSequence: number; readonly lastSequence: number; readonly capacity: number };
}
const dispositions: readonly CaptureDisposition[] = ['accepted', 'duplicate', 'unsupported-tool', 'privacy-redaction', 'unsafe-normalization', 'malformed-envelope', 'admission-failure', 'delivery-retry', 'quarantine', 'legacy-unknown'];

export interface CaptureSpoolStatus {
  readonly version: 1;
  readonly admitted: number;
  readonly pending: number;
  readonly claimed: number;
  readonly committed: number;
  readonly quarantined: number;
  readonly failedAdmission: number;
  readonly delayedDelivery: {
    readonly count: number;
    readonly latest?: { readonly admittedAt: string; readonly deadlineAt: string; readonly detectedAt: string; readonly committedAt?: string };
  };
}

export interface ClaimedSpoolRecord {
  readonly deliveryId: string;
  readonly record: PassiveCaptureRecord;
  readonly attempts: number;
  readonly admittedAt: string;
}

export type SpoolQuarantineCode = 'CORRUPT' | 'UNSUPPORTED';

export class CaptureSpool {
  readonly #database: DatabaseSync;
  readonly #maxActiveRecords: number;
  readonly #maxActiveBytes: number;
  readonly #failReceiptPersistence: boolean;
  readonly #maxReceipts: number;

  constructor(path: string, options: CaptureSpoolOptions = {}) {
    this.#maxActiveRecords = boundedPositiveInteger(options.maxActiveRecords, MAX_ACTIVE_RECORDS, 'Maximum active record count');
    this.#maxActiveBytes = boundedPositiveInteger(options.maxActiveBytes, MAX_ACTIVE_BYTES, 'Maximum active byte count');
    this.#failReceiptPersistence = options.failReceiptPersistence === true;
    this.#maxReceipts = boundedPositiveInteger(options.maxReceipts, MAX_RECEIPTS, 'Maximum receipt count');
    assertWriterCompatible([path]);
    ensurePrivatePath(path);
    this.#database = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: ADMISSION_BUSY_TIMEOUT_MS });
    chmodSync(path, 0o600);
    this.#database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS records (
        delivery_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        payload_bytes INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'claimed')),
        admitted_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT NOT NULL,
        lease_until TEXT,
        delayed_at TEXT,
        deadline_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS counters (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        admitted INTEGER NOT NULL,
        committed INTEGER NOT NULL,
        quarantined INTEGER NOT NULL,
        failed_admission INTEGER NOT NULL,
        delayed_delivery INTEGER NOT NULL DEFAULT 0,
        latest_delivery_id TEXT,
        latest_admitted_at TEXT,
        latest_deadline_at TEXT,
        latest_detected_at TEXT,
        latest_committed_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS quarantined_records (
        delivery_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        code TEXT NOT NULL CHECK (code IN ('CORRUPT', 'UNSUPPORTED')),
        quarantined_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS drain_lock (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        owner TEXT NOT NULL,
        lease_until TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS drain_completion (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending', 'complete')), owner TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS ael_writer_contract (id INTEGER PRIMARY KEY CHECK (id = 1), minimum_writer INTEGER NOT NULL CHECK (minimum_writer >= 1)) STRICT;
      INSERT OR IGNORE INTO ael_writer_contract VALUES (1, 1);
      CREATE TABLE IF NOT EXISTS receipt_secret (id INTEGER PRIMARY KEY CHECK (id = 1), secret BLOB NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS capture_receipts (
        sequence INTEGER PRIMARY KEY, correlation_key TEXT NOT NULL, disposition TEXT NOT NULL CHECK (disposition IN ('accepted', 'duplicate', 'unsupported-tool', 'privacy-redaction', 'unsafe-normalization', 'malformed-envelope', 'admission-failure', 'delivery-retry', 'quarantine', 'legacy-unknown')),
        received_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS capture_recovery_state (
        delivery_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('eligible', 'waiting-dependency', 'held', 'committed', 'quarantined')),
        reason TEXT NOT NULL CHECK (reason IN ('malformed-record', 'unsupported-schema', 'missing-session', 'missing-request', 'lifecycle-conflict', 'conflicting-identity', 'storage-unavailable', 'unknown-legacy')),
        generation INTEGER NOT NULL CHECK (generation >= 1),
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        dependency_key TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS receipt_accounting (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL CHECK (state IN ('available', 'unavailable'))) STRICT;
      INSERT OR IGNORE INTO counters (id, admitted, committed, quarantined, failed_admission) VALUES (1, 0, 0, 0, 0);
      INSERT OR IGNORE INTO receipt_accounting (id, state) VALUES (1, 'available');
      INSERT OR IGNORE INTO drain_completion (id, generation, state) VALUES (1, 0, 'pending');
    `);
    ensureDiagnosticColumns(this.#database);
    ensureReceiptColumns(this.#database);
    if (this.#database.prepare(`SELECT 1 FROM records WHERE NOT EXISTS
      (SELECT 1 FROM capture_recovery_state WHERE capture_recovery_state.delivery_id = records.delivery_id) LIMIT 1`).get() !== undefined) {
      this.#database.prepare(`INSERT OR IGNORE INTO capture_recovery_state (delivery_id, state, reason, generation, attempts, updated_at)
        SELECT delivery_id, CASE WHEN attempts > 0 THEN 'held' ELSE 'eligible' END,
          'unknown-legacy', 1, attempts, admitted_at FROM records`).run();
    }
    const writerFloor = (this.#database.prepare('SELECT minimum_writer FROM ael_writer_contract WHERE id = 1').get() as { minimum_writer: number }).minimum_writer;
    if (writerFloor < 2) this.#database.prepare('UPDATE ael_writer_contract SET minimum_writer = 2 WHERE id = 1 AND minimum_writer < 2').run();
  }

  recordReceipt(input: CaptureReceiptInput): CaptureReceipt {
    if (!['codex', 'cursor'].includes(input.source) || !dispositions.includes(input.disposition) || Number.isNaN(Date.parse(input.receivedAt)) || new Date(input.receivedAt).toISOString() !== input.receivedAt) throw new TypeError('Capture receipt is invalid.');
    if (input.correlationInput !== undefined && (typeof input.correlationInput !== 'string' || Buffer.byteLength(input.correlationInput, 'utf8') > 2 * 1024 * 1024)) throw new TypeError('Capture receipt correlation input is invalid.');
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const receipt = this.#writeReceipt(input);
      this.#database.exec('COMMIT');
      return receipt;
    } catch (error) { rollback(this.#database); throw error; }
  }

  receiptReport(): CaptureReceiptReport {
    const rows = this.#database.prepare('SELECT sequence, correlation_key, operation_key, disposition, received_at, build_role, build_id, writer FROM capture_receipts ORDER BY sequence').all() as Array<{ sequence: number; correlation_key: string; operation_key: string | null; disposition: CaptureDisposition; received_at: string; build_role: 'capture' | 'writer' | null; build_id: string | null; writer: number | null }>;
    const byDisposition = Object.fromEntries(dispositions.map((value) => [value, 0])) as Record<CaptureDisposition, number>;
    for (const row of rows) byDisposition[row.disposition] += 1;
    const accounting = (this.#database.prepare('SELECT state FROM receipt_accounting WHERE id = 1').get() as { state: 'available' | 'unavailable' }).state;
    return Object.freeze({
      accounting,
      receipts: Object.freeze(rows.map((row) => Object.freeze({
        correlationKey: row.correlation_key,
        ...(row.operation_key === null ? {} : { operationKey: row.operation_key }),
        disposition: row.disposition,
        receivedAt: row.received_at,
        buildRole: row.build_role ?? 'unknown',
        ...(row.build_id === null ? {} : { buildId: row.build_id, writer: row.writer! })
      }))),
      byDisposition: Object.freeze(byDisposition),
      ...(rows.length === 0 ? {} : { retention: Object.freeze({ firstSequence: rows[0]!.sequence, lastSequence: rows[rows.length - 1]!.sequence, capacity: this.#maxReceipts }) })
    });
  }

  markReceiptAccountingUnavailable(): void {
    this.#database.prepare("UPDATE receipt_accounting SET state = 'unavailable' WHERE id = 1").run();
  }

  admit(record: PassiveCaptureRecord, admittedAt = new Date().toISOString()): SpoolAdmission {
    return this.#admit(record, admittedAt);
  }

  admitWithReceipt(record: PassiveCaptureRecord, receipt: Omit<CaptureReceiptInput, 'disposition'>): SpoolAdmission {
    const verifiedBuild = runningBuild();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const admission = this.#admit(record, receipt.receivedAt, false);
      this.#writeReceipt({ ...receipt, disposition: admission.status === 'admitted' ? 'accepted' : 'duplicate' }, admission.deliveryId, verifiedBuild);
      this.#database.exec('COMMIT');
      return admission;
    } catch (error) {
      rollback(this.#database);
      try { this.markReceiptAccountingUnavailable(); } catch { /* A failed private store cannot claim available accounting. */ }
      throw error;
    }
  }

  #admit(record: PassiveCaptureRecord, admittedAt: string, transaction = true): SpoolAdmission {
    const payload = JSON.stringify(record);
    const deliveryId = createHash('sha256').update(`ael:capture-spool:v${SPOOL_VERSION}\0`).update(payload).digest('hex');
    const payloadBytes = Buffer.byteLength(payload, 'utf8');
    if (transaction) this.#database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.#database.prepare('SELECT delivery_id FROM records WHERE delivery_id = ?').get(deliveryId) as { delivery_id?: string } | undefined;
      if (existing !== undefined) {
        if (transaction) this.#database.exec('COMMIT');
        return Object.freeze({ status: 'duplicate', deliveryId });
      }
      const usage = this.#database.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(payload_bytes), 0) AS bytes FROM records').get() as { count: number; bytes: number };
      if (usage.count >= this.#maxActiveRecords || usage.bytes + payloadBytes > this.#maxActiveBytes) throw new CaptureSpoolCapacityError();
      this.#database.prepare(`
        INSERT INTO records (delivery_id, version, payload, payload_bytes, state, admitted_at, next_retry_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)
      `).run(deliveryId, SPOOL_VERSION, payload, payloadBytes, admittedAt, admittedAt);
      this.#database.prepare('UPDATE counters SET admitted = admitted + 1 WHERE id = 1').run();
      this.#database.prepare("INSERT INTO capture_recovery_state (delivery_id, state, reason, generation, attempts, updated_at) VALUES (?, 'eligible', 'unknown-legacy', 1, 0, ?)").run(deliveryId, admittedAt);
      if (transaction) this.#database.exec('COMMIT');
      return Object.freeze({ status: 'admitted', deliveryId });
    } catch (error) {
      if (transaction) rollback(this.#database);
      if (error instanceof CaptureSpoolCapacityError) {
        this.#database.prepare('UPDATE counters SET failed_admission = failed_admission + 1 WHERE id = 1').run();
      }
      throw error;
    }
  }

  #writeReceipt(input: CaptureReceiptInput, operationId?: string, verifiedBuild?: BuildManifest): CaptureReceipt {
    if (this.#failReceiptPersistence) throw new TypeError('Injected capture receipt persistence failure.');
    let row = this.#database.prepare('SELECT secret FROM receipt_secret WHERE id = 1').get() as { secret?: Uint8Array } | undefined;
    if (row === undefined) {
      this.#database.prepare('INSERT INTO receipt_secret (id, secret) VALUES (1, ?)').run(randomBytes(32));
      row = this.#database.prepare('SELECT secret FROM receipt_secret WHERE id = 1').get() as { secret: Uint8Array };
    }
    const secret = row.secret;
    if (secret === undefined) throw new TypeError('Capture receipt secret is unavailable.');
    const correlationKey = createHmac('sha256', secret).update(input.source).update('\0').update(input.correlationInput ?? '').digest('hex');
    const operationKey = operationId === undefined ? undefined : createHmac('sha256', secret).update('operation\0').update(operationId).digest('hex');
    const role = operationKey === undefined ? 'unknown' : input.disposition === 'accepted' ? 'capture' : input.disposition === 'delivery-retry' ? 'writer' : 'unknown';
    const build = role === 'unknown' ? undefined : verifiedBuild;
    const buildRole = build === undefined ? 'unknown' : role;
    this.#database.prepare('INSERT INTO capture_receipts (correlation_key, operation_key, disposition, received_at, build_role, build_id, writer) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(correlationKey, operationKey ?? null, input.disposition, input.receivedAt, buildRole, build?.buildId ?? null, build?.capabilities.writer ?? null);
    this.#database.prepare('DELETE FROM capture_receipts WHERE sequence NOT IN (SELECT sequence FROM capture_receipts ORDER BY sequence DESC LIMIT ?)').run(this.#maxReceipts);
    return Object.freeze({ correlationKey, ...(operationKey === undefined ? {} : { operationKey }), disposition: input.disposition, receivedAt: input.receivedAt, buildRole, ...(build === undefined ? {} : { buildId: build.buildId, writer: build.capabilities.writer }) });
  }

  #appendReceiptOrMarkUnavailable(input: CaptureReceiptInput): void {
    try { this.recordReceipt(input); }
    catch {
      try { this.markReceiptAccountingUnavailable(); } catch { /* Receipt store is unavailable. */ }
    }
  }

  status(): CaptureSpoolStatus {
    const counters = this.#database.prepare('SELECT * FROM counters WHERE id = 1').get() as {
      admitted: number; committed: number; quarantined: number; failed_admission: number; delayed_delivery: number;
      latest_admitted_at: string | null; latest_deadline_at: string | null; latest_detected_at: string | null; latest_committed_at: string | null;
    };
    const states = this.#database.prepare(`
      SELECT
        SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN state = 'claimed' THEN 1 ELSE 0 END) AS claimed
      FROM records
    `).get() as { pending: number | null; claimed: number | null };
    return Object.freeze({
      version: SPOOL_VERSION,
      admitted: counters.admitted,
      pending: states.pending ?? 0,
      claimed: states.claimed ?? 0,
      committed: counters.committed,
      quarantined: counters.quarantined,
      failedAdmission: counters.failed_admission,
      delayedDelivery: Object.freeze({
        count: counters.delayed_delivery,
        ...(counters.latest_admitted_at === null ? {} : { latest: Object.freeze({
          admittedAt: counters.latest_admitted_at,
          deadlineAt: counters.latest_deadline_at!,
          detectedAt: counters.latest_detected_at!,
          ...(counters.latest_committed_at === null ? {} : { committedAt: counters.latest_committed_at })
        }) })
      })
    });
  }

  claim(now: string, limit: number): readonly ClaimedSpoolRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Capture spool claim limit must be between 1 and 100.');
    const leaseUntil = new Date(Date.parse(now) + 30_000).toISOString();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.prepare(`
        UPDATE records SET state = 'pending', lease_until = NULL
        WHERE state = 'claimed' AND lease_until <= ?
      `).run(now);
      this.#database.prepare(`UPDATE capture_recovery_state SET state = 'held', reason = 'storage-unavailable', updated_at = ?
        WHERE state = 'eligible' AND attempts >= ? AND delivery_id IN (SELECT delivery_id FROM records WHERE state = 'pending')`)
        .run(now, MAX_AUTOMATIC_ATTEMPTS);
      const rows = this.#database.prepare(`
        SELECT delivery_id, version, payload, attempts, admitted_at
        FROM records WHERE state = 'pending' AND next_retry_at <= ?
          AND EXISTS (SELECT 1 FROM capture_recovery_state recovery WHERE recovery.delivery_id = records.delivery_id AND recovery.state = 'eligible' AND recovery.attempts < ${MAX_AUTOMATIC_ATTEMPTS})
        ORDER BY admitted_at, delivery_id LIMIT ?
      `).all(now, limit) as Array<{ delivery_id: string; version: number; payload: string; attempts: number; admitted_at: string }>;
      const claimed: ClaimedSpoolRecord[] = [];
      for (const row of rows) {
        const record = parseRecord(row);
        if (record === undefined) {
          quarantineRow(this.#database, row.delivery_id, row.payload, row.version === SPOOL_VERSION ? 'CORRUPT' : 'UNSUPPORTED', now);
          this.#database.prepare("UPDATE capture_recovery_state SET state = 'quarantined', reason = ?, updated_at = ? WHERE delivery_id = ?")
            .run(row.version === SPOOL_VERSION ? 'malformed-record' : 'unsupported-schema', now, row.delivery_id);
          this.#writeReceipt({ source: sourceForPayload(row.payload) ?? 'codex', receivedAt: now, disposition: 'quarantine', correlationInput: row.delivery_id });
          continue;
        }
        this.#database.prepare(`
          UPDATE records SET state = 'claimed', attempts = attempts + 1, lease_until = ?
          WHERE delivery_id = ? AND state = 'pending'
        `).run(leaseUntil, row.delivery_id);
        this.#database.prepare('UPDATE capture_recovery_state SET attempts = attempts + 1, updated_at = ? WHERE delivery_id = ?').run(now, row.delivery_id);
        claimed.push(Object.freeze({ deliveryId: row.delivery_id, record, attempts: row.attempts + 1, admittedAt: row.admitted_at }));
      }
      this.#database.exec('COMMIT');
      return Object.freeze(claimed);
    } catch (error) {
      rollback(this.#database);
      try { this.markReceiptAccountingUnavailable(); } catch { /* Receipt store is unavailable. */ }
      throw error;
    }
  }

  acknowledge(deliveryId: string, committedAt = new Date().toISOString()): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.#database.prepare("DELETE FROM records WHERE delivery_id = ? AND state = 'claimed'").run(deliveryId);
      if (result.changes === 1) {
        this.#database.prepare('UPDATE counters SET committed = committed + 1, latest_committed_at = CASE WHEN latest_delivery_id = ? THEN ? ELSE latest_committed_at END WHERE id = 1').run(deliveryId, committedAt);
        this.#database.prepare("UPDATE capture_recovery_state SET state = 'committed', updated_at = ? WHERE delivery_id = ?").run(committedAt, deliveryId);
        const committed = (this.#database.prepare('SELECT committed FROM counters WHERE id = 1').get() as { committed: number }).committed;
        if (committed % 256 === 0) pruneRecoveryHistory(this.#database);
      }
      this.#database.exec('COMMIT');
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  recordDelayedDelivery(deliveryId: string, deadlineAt: string, detectedAt: string): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#database.prepare('SELECT admitted_at, delayed_at FROM records WHERE delivery_id = ?').get(deliveryId) as { admitted_at: string; delayed_at: string | null } | undefined;
      if (row !== undefined && row.delayed_at === null) {
        this.#database.prepare('UPDATE records SET delayed_at = ?, deadline_at = ? WHERE delivery_id = ?').run(detectedAt, deadlineAt, deliveryId);
        this.#database.prepare(`UPDATE counters SET delayed_delivery = delayed_delivery + 1,
          latest_delivery_id = ?, latest_admitted_at = ?, latest_deadline_at = ?, latest_detected_at = ?, latest_committed_at = NULL WHERE id = 1`)
          .run(deliveryId, row.admitted_at, deadlineAt, detectedAt);
      }
      this.#database.exec('COMMIT');
    } catch (error) { rollback(this.#database); throw error; }
  }

  retry(deliveryId: string, now: string, reason: CaptureRecoveryReason = 'storage-unavailable'): void {
    const row = this.#database.prepare('SELECT attempts, payload FROM records WHERE delivery_id = ? AND state = \'claimed\'').get(deliveryId) as { attempts?: number; payload?: string } | undefined;
    if (row?.attempts === undefined) return;
    const verifiedBuild = runningBuild();
    const delay = Math.min(30_000, 100 * 2 ** Math.max(0, row.attempts - 1));
    const nextRetryAt = new Date(Date.parse(now) + delay).toISOString();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.#database.prepare(`
        UPDATE records SET state = 'pending', lease_until = NULL, next_retry_at = ?
        WHERE delivery_id = ? AND state = 'claimed'
      `).run(nextRetryAt, deliveryId);
      if (result.changes === 1) {
        this.#database.prepare(`UPDATE capture_recovery_state SET
          state = CASE WHEN attempts >= ? THEN 'held' ELSE 'eligible' END,
          reason = ?, updated_at = ? WHERE delivery_id = ?`).run(MAX_AUTOMATIC_ATTEMPTS, reason, now, deliveryId);
        this.#writeReceipt({ source: sourceForPayload(row.payload) ?? 'codex', receivedAt: now, disposition: 'delivery-retry', correlationInput: deliveryId }, deliveryId, verifiedBuild);
      }
      this.#database.exec('COMMIT');
    } catch (error) {
      rollback(this.#database);
      try { this.markReceiptAccountingUnavailable(); } catch { /* Receipt store is unavailable. */ }
      throw error;
    }
  }

  waitForDependency(deliveryId: string, reason: 'missing-session' | 'missing-request', source: 'codex' | 'cursor', dependencyId: string, now: string): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const dependencyKey = this.#dependencyKey(source, dependencyId);
      this.#database.prepare(`UPDATE capture_recovery_state SET state = 'waiting-dependency', reason = ?,
        dependency_key = ?, updated_at = ? WHERE delivery_id = ? AND state = 'eligible'`)
        .run(reason, dependencyKey, now, deliveryId);
      this.#database.prepare("UPDATE records SET state = 'pending', lease_until = NULL WHERE delivery_id = ? AND state = 'claimed'").run(deliveryId);
      this.#database.exec('COMMIT');
    } catch (error) { rollback(this.#database); throw error; }
  }

  releaseDependency(source: 'codex' | 'cursor', dependencyId: string, now: string): number {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const dependencyKey = this.#dependencyKey(source, dependencyId);
      const rows = this.#database.prepare("SELECT delivery_id FROM capture_recovery_state WHERE state = 'waiting-dependency' AND dependency_key = ?").all(dependencyKey) as Array<{ delivery_id: string }>;
      const nextRetryAt = new Date(Date.parse(now) + 100).toISOString();
      for (const row of rows) {
        this.#database.prepare("UPDATE capture_recovery_state SET state = 'eligible', generation = generation + 1, attempts = 0, dependency_key = NULL, updated_at = ? WHERE delivery_id = ?").run(now, row.delivery_id);
        this.#database.prepare("UPDATE records SET next_retry_at = ? WHERE delivery_id = ? AND state = 'pending'").run(nextRetryAt, row.delivery_id);
      }
      this.#database.exec('COMMIT');
      return rows.length;
    } catch (error) { rollback(this.#database); throw error; }
  }

  hasEligiblePending(): boolean {
    return this.#database.prepare("SELECT 1 FROM records JOIN capture_recovery_state USING (delivery_id) WHERE records.state = 'pending' AND capture_recovery_state.state = 'eligible' LIMIT 1").get() !== undefined;
  }

  #dependencyKey(source: 'codex' | 'cursor', dependencyId: string): string {
    let row = this.#database.prepare('SELECT secret FROM receipt_secret WHERE id = 1').get() as { secret?: Uint8Array } | undefined;
    if (row === undefined) {
      this.#database.prepare('INSERT INTO receipt_secret (id, secret) VALUES (1, ?)').run(randomBytes(32));
      row = this.#database.prepare('SELECT secret FROM receipt_secret WHERE id = 1').get() as { secret: Uint8Array };
    }
    if (row.secret === undefined) throw new TypeError('Recovery key is unavailable.');
    return createHmac('sha256', row.secret).update('dependency\0').update(source).update('\0').update(dependencyId).digest('hex');
  }

  quarantine(deliveryId: string, code: SpoolQuarantineCode, now = new Date().toISOString(), reason: CaptureRecoveryReason = 'malformed-record'): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#database.prepare('SELECT payload FROM records WHERE delivery_id = ?').get(deliveryId) as { payload?: string } | undefined;
      if (row?.payload !== undefined) {
        quarantineRow(this.#database, deliveryId, row.payload, code, now);
        this.#database.prepare("UPDATE capture_recovery_state SET state = 'quarantined', reason = ?, updated_at = ? WHERE delivery_id = ?").run(reason, now, deliveryId);
        this.#writeReceipt({ source: sourceForPayload(row.payload) ?? 'codex', receivedAt: now, disposition: 'quarantine', correlationInput: deliveryId });
        const quarantined = (this.#database.prepare('SELECT quarantined FROM counters WHERE id = 1').get() as { quarantined: number }).quarantined;
        if (quarantined % 256 === 0) pruneRecoveryHistory(this.#database);
      }
      this.#database.exec('COMMIT');
    } catch (error) {
      rollback(this.#database);
      try { this.markReceiptAccountingUnavailable(); } catch { /* Receipt store is unavailable. */ }
      throw error;
    }
  }

  tryAcquireDrainLock(owner: string, now: string, leaseMs: number): boolean {
    if (owner.length === 0 || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 61_000) {
      throw new TypeError('Capture drain lock input is invalid.');
    }
    const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.prepare('DELETE FROM drain_lock WHERE id = 1 AND lease_until <= ?').run(now);
      const result = this.#database.prepare('INSERT OR IGNORE INTO drain_lock (id, owner, lease_until) VALUES (1, ?, ?)').run(owner, leaseUntil);
      if (result.changes === 1) this.#database.prepare("UPDATE drain_completion SET generation = generation + 1, state = 'pending', owner = ? WHERE id = 1").run(owner);
      this.#database.exec('COMMIT');
      return result.changes === 1;
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  completeDrain(owner: string): boolean {
    this.#database.exec('BEGIN IMMEDIATE');
    try { const released = this.#database.prepare('DELETE FROM drain_lock WHERE id = 1 AND owner = ?').run(owner); if (released.changes === 1) this.#database.prepare("UPDATE drain_completion SET state = 'complete' WHERE id = 1 AND owner = ?").run(owner); this.#database.exec('COMMIT'); return released.changes === 1; } catch (error) { rollback(this.#database); throw error; }
  }

  releaseDrainLock(owner: string): void {
    this.#database.prepare('DELETE FROM drain_lock WHERE id = 1 AND owner = ?').run(owner);
  }

  isDrainComplete(): boolean {
    return (this.#database.prepare("SELECT state FROM drain_completion WHERE id = 1").get() as { state: string }).state === 'complete';
  }

  close(): void {
    this.#database.close();
  }
}

export class CaptureSpoolCapacityError extends Error {
  constructor() { super('Capture spool capacity is exhausted.'); }
}

function ensurePrivatePath(path: string): void {
  const directory = dirname(path);
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new TypeError('Capture spool directory must not be a symbolic link.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new TypeError('Capture spool path must not be a symbolic link.');
}

function boundedPositiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > fallback) throw new TypeError(`${name} must be a positive integer no greater than ${fallback}.`);
  return result;
}

function ensureDiagnosticColumns(database: DatabaseSync): void {
  const recordColumns = new Set((database.prepare("PRAGMA table_info('records')").all() as Array<{ name: string }>).map(({ name }) => name));
  if (!recordColumns.has('delayed_at')) database.exec('ALTER TABLE records ADD COLUMN delayed_at TEXT');
  if (!recordColumns.has('deadline_at')) database.exec('ALTER TABLE records ADD COLUMN deadline_at TEXT');
  const counterColumns = new Set((database.prepare("PRAGMA table_info('counters')").all() as Array<{ name: string }>).map(({ name }) => name));
  for (const [name, definition] of [
    ['delayed_delivery', 'INTEGER NOT NULL DEFAULT 0'], ['latest_delivery_id', 'TEXT'], ['latest_admitted_at', 'TEXT'],
    ['latest_deadline_at', 'TEXT'], ['latest_detected_at', 'TEXT'], ['latest_committed_at', 'TEXT']
  ] as const) if (!counterColumns.has(name)) database.exec(`ALTER TABLE counters ADD COLUMN ${name} ${definition}`);
}

function ensureReceiptColumns(database: DatabaseSync): void {
  const definitions = [
    ['operation_key', 'TEXT'], ['build_role', "TEXT CHECK (build_role IN ('capture', 'writer', 'unknown'))"],
    ['build_id', 'TEXT'], ['writer', 'INTEGER']
  ] as const;
  const existing = new Set((database.prepare("PRAGMA table_info('capture_receipts')").all() as Array<{ name: string }>).map(({ name }) => name));
  if (definitions.every(([name]) => existing.has(name))) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    const columns = new Set((database.prepare("PRAGMA table_info('capture_receipts')").all() as Array<{ name: string }>).map(({ name }) => name));
    for (const [name, definition] of definitions) if (!columns.has(name)) database.exec(`ALTER TABLE capture_receipts ADD COLUMN ${name} ${definition}`);
    database.exec('COMMIT');
  } catch (error) { rollback(database); throw error; }
}

function pruneRecoveryHistory(database: DatabaseSync): void {
  database.prepare(`DELETE FROM capture_recovery_state WHERE delivery_id NOT IN (SELECT delivery_id FROM records)
    AND rowid NOT IN (SELECT rowid FROM capture_recovery_state ORDER BY rowid DESC LIMIT 10000)`).run();
}

function rollback(database: DatabaseSync): void {
  try { database.exec('ROLLBACK'); } catch { /* transaction was already committed */ }
}

function parseRecord(row: { version: number; payload: string }): PassiveCaptureRecord | undefined {
  if (row.version !== SPOOL_VERSION) return undefined;
  try {
    const value = JSON.parse(row.payload) as unknown;
    return isPassiveCaptureRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function sourceForPayload(payload: string | undefined): 'codex' | 'cursor' | undefined {
  if (payload === undefined) return undefined;
  const record = parseRecord({ version: SPOOL_VERSION, payload });
  const source = record?.kind === 'session-start' ? record.session.source : record?.kind === 'session-end' ? record.source : record?.event.source;
  return source === 'codex' || source === 'cursor' ? source : undefined;
}

function quarantineRow(database: DatabaseSync, deliveryId: string, payload: string, code: SpoolQuarantineCode, now: string): void {
  database.prepare(`
    INSERT OR IGNORE INTO quarantined_records (delivery_id, payload, code, quarantined_at) VALUES (?, ?, ?, ?)
  `).run(deliveryId, payload, code, now);
  database.prepare('DELETE FROM quarantined_records WHERE rowid NOT IN (SELECT rowid FROM quarantined_records ORDER BY rowid DESC LIMIT 1000)').run();
  const removed = database.prepare('DELETE FROM records WHERE delivery_id = ?').run(deliveryId);
  if (removed.changes === 1) database.prepare('UPDATE counters SET quarantined = quarantined + 1 WHERE id = 1').run();
}

function isPassiveCaptureRecord(value: unknown): value is PassiveCaptureRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as { kind?: unknown; session?: unknown; source?: unknown; sessionId?: unknown; endedAt?: unknown; event?: unknown };
  if (record.kind === 'session-start') return record.session !== null && typeof record.session === 'object';
  if (record.kind === 'session-end') return typeof record.source === 'string' && typeof record.sessionId === 'string' && typeof record.endedAt === 'string';
  return record.kind === 'technical' && record.event !== null && typeof record.event === 'object';
}
