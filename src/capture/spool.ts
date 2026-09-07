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

export interface CaptureSpoolStatus {
  readonly version: 1;
  readonly admitted: number;
  readonly pending: number;
  readonly claimed: number;
  readonly committed: number;
  readonly quarantined: number;
  readonly failedAdmission: number;
}

export class CaptureSpool {
  readonly #database: DatabaseSync;

  constructor(path: string) {
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
      if (usage.count >= MAX_ACTIVE_RECORDS || usage.bytes + payloadBytes > MAX_ACTIVE_BYTES) throw new CaptureSpoolCapacityError();
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

function rollback(database: DatabaseSync): void {
  try { database.exec('ROLLBACK'); } catch { /* transaction was already committed */ }
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
