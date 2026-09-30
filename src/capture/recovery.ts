export interface RecoverySelection {
  readonly deliveryId: string;
  readonly inputHash: string;
  readonly state: 'held' | 'quarantined';
  readonly reason: string;
  readonly generation: number;
  readonly attempts: number;
}

export interface RecoveryPlan {
  readonly schemaVersion: 1;
  readonly repositoryId: string;
  readonly buildId: string;
  readonly writer: number;
  readonly minimumWriter: number;
  readonly createdAt: string;
  readonly nextCursor?: string;
  readonly selections: readonly RecoverySelection[];
  readonly ineligible: readonly { readonly deliveryId: string; readonly reason: string }[];
  readonly planHash: string;
}

export interface RecoveryPlanInput {
  readonly spoolPath: string;
  readonly experiencePath: string;
  readonly repositoryId: string;
  readonly now: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface RecoveryApplyInput {
  readonly spoolPath: string;
  readonly experiencePath: string;
  readonly plan: RecoveryPlan;
  readonly now: string;
  readonly onApplied?: (count: number) => void;
}

interface Candidate {
  delivery_id: string;
  version: number | null;
  payload: string;
  record_state: string | null;
  state: string | null;
  reason: string | null;
  generation: number | null;
  attempts: number | null;
  original_code: string | null;
}

const candidateQuery = `SELECT candidate.delivery_id, records.version, COALESCE(records.payload, quarantine.payload) AS payload,
  records.state AS record_state, recovery.state, recovery.reason, recovery.generation, recovery.attempts,
  quarantine.code AS original_code
  FROM (SELECT delivery_id FROM records UNION SELECT delivery_id FROM quarantined_records) candidate
  LEFT JOIN records ON records.delivery_id = candidate.delivery_id
  LEFT JOIN quarantined_records quarantine ON quarantine.delivery_id = candidate.delivery_id
  LEFT JOIN capture_recovery_state recovery ON recovery.delivery_id = candidate.delivery_id`;

export function createRecoveryPlan(input: RecoveryPlanInput): RecoveryPlan {
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Recovery plan limit must be between 1 and 100.');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.repositoryId) || input.repositoryId.length > 64) throw new TypeError('Recovery repository ID is invalid.');
  if (input.cursor !== undefined && !/^[a-f0-9]{64}$/.test(input.cursor)) throw new TypeError('Recovery cursor is invalid.');
  timestamp(input.now);
  assertWriterCompatible([input.spoolPath]);
  const build = runningBuild();
  if (build === undefined) throw new Error('Recovery plan requires an attested build.');
  const writerFloor = minimumWriter(input.spoolPath);
  const database = new DatabaseSync(input.spoolPath, { readOnly: true, timeout: 125 });
  const experience = existsSync(input.experiencePath) ? new DatabaseSync(input.experiencePath, { readOnly: true, timeout: 125 }) : undefined;
  try {
    const rows = database.prepare(`${candidateQuery} WHERE candidate.delivery_id > ? ORDER BY candidate.delivery_id LIMIT ?`)
      .all(input.cursor ?? '', 201) as unknown as Candidate[];
    const selections: RecoverySelection[] = [];
    const ineligible: Array<{ deliveryId: string; reason: string }> = [];
    let lastCursor: string | undefined;
    for (const row of rows.slice(0, 200)) {
      lastCursor = row.delivery_id;
      const scope = recordScope(row.payload, experience);
      if (scope !== input.repositoryId) continue;
      const reason = ineligibility(row);
      if (reason !== undefined) ineligible.push({ deliveryId: row.delivery_id, reason });
      else selections.push(selectionFor(row));
      if (selections.length >= limit) break;
    }
    const exhausted = rows.length <= 200 && (lastCursor === undefined || lastCursor === rows.at(-1)?.delivery_id);
    const body = {
      schemaVersion: 1 as const, repositoryId: input.repositoryId, buildId: build.buildId,
      writer: build.capabilities.writer, minimumWriter: writerFloor, createdAt: input.now,
      ...(!exhausted && lastCursor !== undefined ? { nextCursor: lastCursor } : {}),
      selections, ineligible
    };
    return Object.freeze({ ...body, planHash: digest(JSON.stringify(body)) });
  } finally { experience?.close(); database.close(); }
}

export function applyRecoveryPlan(input: RecoveryApplyInput): { applied: number; alreadyApplied: number } {
  timestamp(input.now);
  validatePlan(input.plan);
  assertWriterCompatible([input.spoolPath]);
  const build = runningBuild();
  if (build === undefined) throw new Error('Recovery apply requires an attested build.');
  if (build.buildId !== input.plan.buildId || build.capabilities.writer !== input.plan.writer || minimumWriter(input.spoolPath) !== input.plan.minimumWriter) {
    throw new Error('Recovery plan capability is stale.');
  }
  const database = new DatabaseSync(input.spoolPath, { timeout: 125 });
  const experience = existsSync(input.experiencePath) ? new DatabaseSync(input.experiencePath, { readOnly: true, timeout: 125 }) : undefined;
  let applied = 0;
  let alreadyApplied = 0;
  try {
    transaction(database, () => {
      assertWriterFloor(database, input.plan.minimumWriter);
      database.exec(`CREATE TABLE IF NOT EXISTS capture_recovery_applied (
        plan_hash TEXT NOT NULL, delivery_id TEXT NOT NULL, applied_at TEXT NOT NULL,
        PRIMARY KEY (plan_hash, delivery_id)
      ) STRICT`);
      for (const selection of input.plan.selections) {
        if (wasApplied(database, input.plan.planHash, selection.deliveryId)) continue;
        assertCurrent(database, experience, input.plan.repositoryId, selection);
      }
    });
    for (const selection of input.plan.selections) {
      const changed = transaction(database, () => {
        assertWriterFloor(database, input.plan.minimumWriter);
        if (wasApplied(database, input.plan.planHash, selection.deliveryId)) return false;
        const current = assertCurrent(database, experience, input.plan.repositoryId, selection);
        if (current.state === 'quarantined') {
          database.prepare(`INSERT INTO records (delivery_id, version, payload, payload_bytes, state, admitted_at, next_retry_at)
            VALUES (?, 1, ?, ?, 'pending', ?, ?)`)
            .run(selection.deliveryId, current.payload, Buffer.byteLength(current.payload), input.now, input.now);
        } else {
          database.prepare("UPDATE records SET state = 'pending', attempts = 0, next_retry_at = ?, lease_until = NULL WHERE delivery_id = ? AND state = 'pending'")
            .run(input.now, selection.deliveryId);
        }
        const update = database.prepare(`UPDATE capture_recovery_state SET state = 'eligible', generation = generation + 1,
          attempts = 0, dependency_key = NULL, updated_at = ? WHERE delivery_id = ? AND state = ? AND generation = ?`)
          .run(input.now, selection.deliveryId, selection.state, selection.generation);
        if (update.changes !== 1) throw new Error('Recovery plan is stale.');
        database.prepare('INSERT INTO capture_recovery_applied (plan_hash, delivery_id, applied_at) VALUES (?, ?, ?)')
          .run(input.plan.planHash, selection.deliveryId, input.now);
        return true;
      });
      if (changed) { applied += 1; input.onApplied?.(applied); }
      else alreadyApplied += 1;
    }
    return { applied, alreadyApplied };
  } finally { experience?.close(); database.close(); }
}

function timestamp(value: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new TypeError('Recovery timestamp is invalid.');
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function selectionFor(row: Candidate): RecoverySelection {
  return { deliveryId: row.delivery_id, inputHash: digest(row.payload), state: row.state as 'held' | 'quarantined',
    reason: row.reason!, generation: row.generation!, attempts: row.attempts! };
}

function ineligibility(row: Candidate): string | undefined {
  if (row.state === null || row.generation === null || row.attempts === null || row.reason === null) return 'missing-recovery-metadata';
  if (row.state === 'held') return row.record_state === 'pending' && row.version === 1 ? undefined : 'invalid-held-record';
  if (row.state === 'quarantined') return row.record_state === null && row.original_code === 'CORRUPT' ? undefined : 'invalid-quarantine-record';
  return 'not-recoverable';
}

function recordScope(payload: string, experience: DatabaseSync | undefined): string | undefined {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(payload) as Record<string, unknown>; }
  catch { return undefined; }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const session = parsed.session as { id?: unknown; source?: unknown; repositoryId?: unknown } | undefined;
  const event = parsed.event as { sessionId?: unknown; source?: unknown } | undefined;
  const sessionId = parsed.kind === 'session-end' ? parsed.sessionId : parsed.kind === 'technical' ? event?.sessionId : session?.id;
  const source = parsed.kind === 'session-end' ? parsed.source : parsed.kind === 'technical' ? event?.source : session?.source;
  const declared = typeof session?.repositoryId === 'string' ? session.repositoryId : undefined;
  if (typeof sessionId !== 'string' || typeof source !== 'string' || experience === undefined) return declared;
  try {
    const row = experience.prepare('SELECT repository_id FROM sessions WHERE id = ? AND source = ?').get(sessionId, source) as { repository_id: string | null } | undefined;
    if (declared !== undefined && row?.repository_id !== undefined && row.repository_id !== null && declared !== row.repository_id) return undefined;
    return declared ?? row?.repository_id ?? undefined;
  } catch { return undefined; }
}

function assertWriterFloor(database: DatabaseSync, expected: number): void {
  const current = database.prepare('SELECT minimum_writer FROM ael_writer_contract WHERE id = 1').get() as { minimum_writer: number } | undefined;
  if (current?.minimum_writer !== expected) throw new Error('Recovery plan capability is stale.');
}

function validatePlan(plan: RecoveryPlan): void {
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.selections) || plan.selections.length > 100 || !Array.isArray(plan.ineligible)
    || !/^[a-f0-9]{64}$/.test(plan.planHash) || !/^[a-f0-9]{64}$/.test(plan.buildId)) throw new TypeError('Recovery plan is invalid.');
  timestamp(plan.createdAt);
  const ids = new Set<string>();
  for (const row of plan.selections) {
    if (!/^[a-f0-9]{64}$/.test(row.deliveryId) || !/^[a-f0-9]{64}$/.test(row.inputHash)
      || !['held', 'quarantined'].includes(row.state) || !Number.isSafeInteger(row.generation) || row.generation < 1
      || !Number.isSafeInteger(row.attempts) || row.attempts < 0 || ids.has(row.deliveryId)) throw new TypeError('Recovery plan selection is invalid.');
    ids.add(row.deliveryId);
  }
  const { planHash, ...body } = plan;
  if (digest(JSON.stringify(body)) !== planHash) throw new Error('Recovery plan hash is invalid.');
}

function wasApplied(database: DatabaseSync, planHash: string, deliveryId: string): boolean {
  return database.prepare('SELECT 1 FROM capture_recovery_applied WHERE plan_hash = ? AND delivery_id = ?').get(planHash, deliveryId) !== undefined;
}

function assertCurrent(database: DatabaseSync, experience: DatabaseSync | undefined, repositoryId: string, selection: RecoverySelection): Candidate {
  const row = database.prepare(`${candidateQuery} WHERE candidate.delivery_id = ?`).get(selection.deliveryId) as Candidate | undefined;
  if (row === undefined || recordScope(row.payload, experience) !== repositoryId || ineligibility(row) !== undefined
    || JSON.stringify(selectionFor(row)) !== JSON.stringify(selection)) throw new Error('Recovery plan is stale.');
  return row;
}

function transaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try { const result = work(); database.exec('COMMIT'); return result; }
  catch (error) { try { database.exec('ROLLBACK'); } catch {} throw error; }
}
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { runningBuild } from '../installation/build-manifest.js';
import { assertWriterCompatible, minimumWriter } from '../installation/writer-contract.js';
