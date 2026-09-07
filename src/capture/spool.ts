import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { PassiveCaptureRecord } from './passive-service.js';

const SPOOL_VERSION = 1;
const MAX_ACTIVE_RECORDS = 50_000;
const MAX_ACTIVE_BYTES = 32 * 1024 * 1024;

export interface SpoolAdmission {
  readonly status: 'admitted' | 'duplicate';
  readonly deliveryId: string;
}

export interface CaptureSpoolOptions {
  readonly maxActiveRecords?: number;
  readonly maxActiveBytes?: number;
}

export interface CaptureSpoolStatus {
  readonly version: 1;
  readonly admitted: number;
  readonly pending: number;
  readonly claimed: number;
  readonly committed: number;
  readonly quarantined: number;
  readonly failedAdmission: number;
}

export interface ClaimedSpoolRecord {
  readonly deliveryId: string;
  readonly record: PassiveCaptureRecord;
  readonly attempts: number;
}

export type SpoolQuarantineCode = 'CORRUPT' | 'UNSUPPORTED';

export class CaptureSpool {
  readonly #database: DatabaseSync;
  readonly #maxActiveRecords: number;
  readonly #maxActiveBytes: number;

  constructor(path: string, options: CaptureSpoolOptions = {}) {
    this.#maxActiveRecords = boundedPositiveInteger(options.maxActiveRecords, MAX_ACTIVE_RECORDS, 'Maximum active record count');
    this.#maxActiveBytes = boundedPositiveInteger(options.maxActiveBytes, MAX_ACTIVE_BYTES, 'Maximum active byte count');
    ensurePrivatePath(path);
    this.#database = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 250 });
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
        lease_until TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS counters (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        admitted INTEGER NOT NULL,
        committed INTEGER NOT NULL,
        quarantined INTEGER NOT NULL,
        failed_admission INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS quarantined_records (
        delivery_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        code TEXT NOT NULL CHECK (code IN ('CORRUPT', 'UNSUPPORTED')),
        quarantined_at TEXT NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO counters (id, admitted, committed, quarantined, failed_admission) VALUES (1, 0, 0, 0, 0);
    `);
  }

  admit(record: PassiveCaptureRecord, admittedAt = new Date().toISOString()): SpoolAdmission {
    const payload = canonicalJson(record);
    const deliveryId = createHash('sha256').update(`ael:capture-spool:v${SPOOL_VERSION}\0`).update(payload).digest('hex');
    const payloadBytes = Buffer.byteLength(payload, 'utf8');
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.#database.prepare('SELECT delivery_id FROM records WHERE delivery_id = ?').get(deliveryId) as { delivery_id?: string } | undefined;
      if (existing !== undefined) {
        this.#database.exec('COMMIT');
        return Object.freeze({ status: 'duplicate', deliveryId });
      }
      const usage = this.#database.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(payload_bytes), 0) AS bytes FROM records').get() as { count: number; bytes: number };
      if (usage.count >= this.#maxActiveRecords || usage.bytes + payloadBytes > this.#maxActiveBytes) throw new CaptureSpoolCapacityError();
      this.#database.prepare(`
        INSERT INTO records (delivery_id, version, payload, payload_bytes, state, admitted_at, next_retry_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)
      `).run(deliveryId, SPOOL_VERSION, payload, payloadBytes, admittedAt, admittedAt);
      this.#database.prepare('UPDATE counters SET admitted = admitted + 1 WHERE id = 1').run();
      this.#database.exec('COMMIT');
      return Object.freeze({ status: 'admitted', deliveryId });
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  status(): CaptureSpoolStatus {
    const counters = this.#database.prepare('SELECT admitted, committed, quarantined, failed_admission FROM counters WHERE id = 1').get() as {
      admitted: number; committed: number; quarantined: number; failed_admission: number;
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
      failedAdmission: counters.failed_admission
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
        SELECT delivery_id, version, payload, attempts
        FROM records WHERE state = 'pending' AND next_retry_at <= ?
        ORDER BY admitted_at, delivery_id LIMIT ?
      `).all(now, limit) as Array<{ delivery_id: string; version: number; payload: string; attempts: number }>;
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
        claimed.push(Object.freeze({ deliveryId: row.delivery_id, record, attempts: row.attempts + 1 }));
      }
      this.#database.exec('COMMIT');
      return Object.freeze(claimed);
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  acknowledge(deliveryId: string): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.#database.prepare("DELETE FROM records WHERE delivery_id = ? AND state = 'claimed'").run(deliveryId);
      if (result.changes === 1) this.#database.prepare('UPDATE counters SET committed = committed + 1 WHERE id = 1').run();
      this.#database.exec('COMMIT');
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  retry(deliveryId: string, now: string): void {
    const row = this.#database.prepare('SELECT attempts FROM records WHERE delivery_id = ? AND state = \'claimed\'').get(deliveryId) as { attempts?: number } | undefined;
    if (row?.attempts === undefined) return;
    const delay = Math.min(30_000, 100 * 2 ** Math.max(0, row.attempts - 1));
    const nextRetryAt = new Date(Date.parse(now) + delay).toISOString();
    this.#database.prepare(`
      UPDATE records SET state = 'pending', lease_until = NULL, next_retry_at = ?
      WHERE delivery_id = ? AND state = 'claimed'
    `).run(nextRetryAt, deliveryId);
  }

  quarantine(deliveryId: string, code: SpoolQuarantineCode, now = new Date().toISOString()): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#database.prepare('SELECT payload FROM records WHERE delivery_id = ?').get(deliveryId) as { payload?: string } | undefined;
      if (row?.payload !== undefined) quarantineRow(this.#database, deliveryId, row.payload, code, now);
      this.#database.exec('COMMIT');
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  throw new TypeError('Capture spool records must be JSON values.');
}
