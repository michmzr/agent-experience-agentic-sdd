import { createHash, createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { PassiveCaptureRecord } from './passive-service.js';

const SPOOL_VERSION = 1;
const ADMISSION_BUSY_TIMEOUT_MS = 100;
const MAX_ACTIVE_RECORDS = 50_000;
const MAX_ACTIVE_BYTES = 32 * 1024 * 1024;

export interface SpoolAdmission {
  readonly status: 'admitted' | 'duplicate';
  readonly deliveryId: string;
}

export interface CaptureSpoolOptions {
  readonly maxActiveRecords?: number;
  readonly maxActiveBytes?: number;
  readonly failReceiptPersistence?: boolean;
}

export type CaptureDisposition = 'accepted' | 'duplicate' | 'unsupported-tool' | 'privacy-redaction' | 'unsafe-normalization' | 'malformed-envelope' | 'admission-failure' | 'delivery-retry' | 'quarantine' | 'legacy-unknown';
export interface CaptureReceiptInput { readonly source: 'codex' | 'cursor'; readonly receivedAt: string; readonly disposition: CaptureDisposition; readonly correlationInput?: string; }
export interface CaptureReceipt { readonly correlationKey: string; readonly disposition: CaptureDisposition; readonly receivedAt: string; }
export interface CaptureReceiptReport { readonly accounting: 'available' | 'unavailable'; readonly receipts: readonly CaptureReceipt[]; readonly byDisposition: Readonly<Record<CaptureDisposition, number>>; }
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

  constructor(path: string, options: CaptureSpoolOptions = {}) {
    this.#maxActiveRecords = boundedPositiveInteger(options.maxActiveRecords, MAX_ACTIVE_RECORDS, 'Maximum active record count');
    this.#maxActiveBytes = boundedPositiveInteger(options.maxActiveBytes, MAX_ACTIVE_BYTES, 'Maximum active byte count');
    this.#failReceiptPersistence = options.failReceiptPersistence === true;
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
      CREATE TABLE IF NOT EXISTS receipt_secret (id INTEGER PRIMARY KEY CHECK (id = 1), secret BLOB NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS capture_receipts (
        sequence INTEGER PRIMARY KEY, correlation_key TEXT NOT NULL, disposition TEXT NOT NULL CHECK (disposition IN ('accepted', 'duplicate', 'unsupported-tool', 'privacy-redaction', 'unsafe-normalization', 'malformed-envelope', 'admission-failure', 'delivery-retry', 'quarantine', 'legacy-unknown')),
        received_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS receipt_accounting (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL CHECK (state IN ('available', 'unavailable'))) STRICT;
      INSERT OR IGNORE INTO counters (id, admitted, committed, quarantined, failed_admission) VALUES (1, 0, 0, 0, 0);
      INSERT OR IGNORE INTO receipt_accounting (id, state) VALUES (1, 'available');
    `);
    ensureDiagnosticColumns(this.#database);
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
    const rows = this.#database.prepare('SELECT correlation_key, disposition, received_at FROM capture_receipts ORDER BY sequence').all() as Array<{ correlation_key: string; disposition: CaptureDisposition; received_at: string }>;
    const byDisposition = Object.fromEntries(dispositions.map((value) => [value, 0])) as Record<CaptureDisposition, number>;
    for (const row of rows) byDisposition[row.disposition] += 1;
    const accounting = (this.#database.prepare('SELECT state FROM receipt_accounting WHERE id = 1').get() as { state: 'available' | 'unavailable' }).state;
    return Object.freeze({ accounting, receipts: Object.freeze(rows.map((row) => Object.freeze({ correlationKey: row.correlation_key, disposition: row.disposition, receivedAt: row.received_at }))), byDisposition: Object.freeze(byDisposition) });
  }

  markReceiptAccountingUnavailable(): void {
    this.#database.prepare("UPDATE receipt_accounting SET state = 'unavailable' WHERE id = 1").run();
  }

  admit(record: PassiveCaptureRecord, admittedAt = new Date().toISOString()): SpoolAdmission {
    return this.#admit(record, admittedAt);
  }

  admitWithReceipt(record: PassiveCaptureRecord, receipt: Omit<CaptureReceiptInput, 'disposition'>): SpoolAdmission {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const admission = this.#admit(record, receipt.receivedAt, false);
      this.#writeReceipt({ ...receipt, disposition: admission.status === 'admitted' ? 'accepted' : 'duplicate' });
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

  #writeReceipt(input: CaptureReceiptInput): CaptureReceipt {
    if (this.#failReceiptPersistence) throw new TypeError('Injected capture receipt persistence failure.');
    let row = this.#database.prepare('SELECT secret FROM receipt_secret WHERE id = 1').get() as { secret?: Uint8Array } | undefined;
    if (row === undefined) {
      this.#database.prepare('INSERT INTO receipt_secret (id, secret) VALUES (1, ?)').run(randomBytes(32));
      row = this.#database.prepare('SELECT secret FROM receipt_secret WHERE id = 1').get() as { secret: Uint8Array };
    }
    const secret = row.secret;
    if (secret === undefined) throw new TypeError('Capture receipt secret is unavailable.');
    const correlationKey = createHmac('sha256', secret).update(input.source).update('\0').update(input.correlationInput ?? '').digest('hex');
    this.#database.prepare('INSERT INTO capture_receipts (correlation_key, disposition, received_at) VALUES (?, ?, ?)').run(correlationKey, input.disposition, input.receivedAt);
    return Object.freeze({ correlationKey, disposition: input.disposition, receivedAt: input.receivedAt });
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
      const rows = this.#database.prepare(`
        SELECT delivery_id, version, payload, attempts, admitted_at
        FROM records WHERE state = 'pending' AND next_retry_at <= ?
        ORDER BY admitted_at, delivery_id LIMIT ?
      `).all(now, limit) as Array<{ delivery_id: string; version: number; payload: string; attempts: number; admitted_at: string }>;
      const claimed: ClaimedSpoolRecord[] = [];
      for (const row of rows) {
        const record = parseRecord(row);
        if (record === undefined) {
          quarantineRow(this.#database, row.delivery_id, row.payload, row.version === SPOOL_VERSION ? 'CORRUPT' : 'UNSUPPORTED', now);
          continue;
        }
        this.#database.prepare(`
          UPDATE records SET state = 'claimed', attempts = attempts + 1, lease_until = ?
          WHERE delivery_id = ? AND state = 'pending'
        `).run(leaseUntil, row.delivery_id);
        claimed.push(Object.freeze({ deliveryId: row.delivery_id, record, attempts: row.attempts + 1, admittedAt: row.admitted_at }));
      }
      this.#database.exec('COMMIT');
      return Object.freeze(claimed);
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  acknowledge(deliveryId: string, committedAt = new Date().toISOString()): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.#database.prepare("DELETE FROM records WHERE delivery_id = ? AND state = 'claimed'").run(deliveryId);
      if (result.changes === 1) {
        this.#database.prepare('UPDATE counters SET committed = committed + 1, latest_committed_at = CASE WHEN latest_delivery_id = ? THEN ? ELSE latest_committed_at END WHERE id = 1').run(deliveryId, committedAt);
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

  retry(deliveryId: string, now: string): void {
    const row = this.#database.prepare('SELECT attempts, payload FROM records WHERE delivery_id = ? AND state = \'claimed\'').get(deliveryId) as { attempts?: number; payload?: string } | undefined;
    if (row?.attempts === undefined) return;
    const delay = Math.min(30_000, 100 * 2 ** Math.max(0, row.attempts - 1));
    const nextRetryAt = new Date(Date.parse(now) + delay).toISOString();
    const result = this.#database.prepare(`
      UPDATE records SET state = 'pending', lease_until = NULL, next_retry_at = ?
      WHERE delivery_id = ? AND state = 'claimed'
    `).run(nextRetryAt, deliveryId);
    if (result.changes === 1) this.#appendReceiptOrMarkUnavailable({ source: sourceForPayload(row.payload) ?? 'codex', receivedAt: now, disposition: 'delivery-retry', correlationInput: deliveryId });
  }

  quarantine(deliveryId: string, code: SpoolQuarantineCode, now = new Date().toISOString()): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#database.prepare('SELECT payload FROM records WHERE delivery_id = ?').get(deliveryId) as { payload?: string } | undefined;
      if (row?.payload !== undefined) {
        quarantineRow(this.#database, deliveryId, row.payload, code, now);
        this.#writeReceipt({ source: sourceForPayload(row.payload) ?? 'codex', receivedAt: now, disposition: 'quarantine', correlationInput: deliveryId });
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
      this.#database.exec('COMMIT');
      return result.changes === 1;
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  releaseDrainLock(owner: string): void {
    this.#database.prepare('DELETE FROM drain_lock WHERE id = 1 AND owner = ?').run(owner);
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
