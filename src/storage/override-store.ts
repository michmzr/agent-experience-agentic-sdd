import type { DatabaseSync } from 'node:sqlite';

import type { DecisionReference } from '../runtime/contracts.js';
import {
  parseRuntimeOverride,
  validateOverrideAuditEntry,
  type OverrideAuditEntry,
  type PostActionOutcome
} from '../runtime/override.js';
import { openExperienceDatabase } from './database.js';

export const MAX_OVERRIDE_AUDIT_PAGE_SIZE = 100;
export const OVERRIDE_AUDIT_MIGRATION_BATCH_SIZE = 64;

export interface OverrideAuditPageRequest {
  readonly overrideId?: string;
  readonly afterSequence?: number;
  readonly limit?: number;
}

export interface OverrideAuditPage {
  readonly entries: readonly OverrideAuditEntry[];
  readonly nextCursor?: number;
}

export const overrideAuditMigration = `
  CREATE TABLE IF NOT EXISTS runtime_override_audit (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    override_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('authorized', 'completed')),
    scope_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    recorded_at TEXT NOT NULL,
    decision_references_json TEXT NOT NULL,
    post_action_outcome TEXT CHECK (post_action_outcome IN ('succeeded', 'failed', 'unknown')),
    CHECK ((phase = 'authorized' AND post_action_outcome IS NULL) OR (phase = 'completed' AND post_action_outcome IS NOT NULL))
  );
`;

const strictOverrideAuditMigration = `
  CREATE TABLE runtime_override_audit_v6 (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    override_id TEXT NOT NULL,
    use_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('authorized', 'completed')),
    scope_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    recorded_at TEXT NOT NULL,
    decision_references_json TEXT NOT NULL,
    post_action_outcome TEXT CHECK (post_action_outcome IN ('succeeded', 'failed', 'unknown')),
    CONSTRAINT runtime_override_audit_use_id_canonical CHECK (
      length(use_id) BETWEEN 1 AND 512
      AND substr(use_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND use_id NOT GLOB '*[^A-Za-z0-9._:@-]*'
    ),
    CONSTRAINT runtime_override_audit_one_phase_per_use UNIQUE (override_id, use_id, phase),
    CHECK ((phase = 'authorized' AND post_action_outcome IS NULL) OR (phase = 'completed' AND post_action_outcome IS NOT NULL))
  );
`;

interface OverrideAuditRow {
  sequence: number;
  id: string;
  use_id?: string | null;
  override_id: string;
  phase: OverrideAuditEntry['phase'];
  scope_json: string;
  reason: string;
  created_at: string;
  expires_at: string | null;
  recorded_at: string;
  decision_references_json: string;
  post_action_outcome: PostActionOutcome | null;
}

export class OverrideStore {
  readonly #database: DatabaseSync;

  constructor(databasePath?: string) {
    this.#database = openExperienceDatabase(databasePath);
    migrateOverrideAudit(this.#database);
  }

  append(input: OverrideAuditEntry): void {
    const entry = validateOverrideAuditEntry(input);
    if (entry.phase === 'completed') this.#appendCompletion(entry);
    else this.#insert(entry);
  }

  #appendCompletion(entry: OverrideAuditEntry): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const authorized = this.#database.prepare(`
        SELECT * FROM runtime_override_audit
        WHERE override_id = ? AND use_id = ? AND phase = 'authorized'
      `).get(entry.override.id, entry.useId) as unknown as OverrideAuditRow | undefined;
      if (authorized === undefined) throw new TypeError('Completion audit requires a prior authorization row.');
      if (!sameAuthorization(authorized, entry)) throw new TypeError('Completion audit must match its authorization decision.');
      if (entry.recordedAt < authorized.recorded_at) throw new TypeError('Completion audit cannot precede its authorization.');
      this.#insert(entry);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  #insert(entry: OverrideAuditEntry): void {
    this.#database.prepare(`
      INSERT INTO runtime_override_audit (
        id, override_id, use_id, phase, scope_json, reason, created_at, expires_at,
        recorded_at, decision_references_json, post_action_outcome
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.override.id,
      entry.useId,
      entry.phase,
      JSON.stringify(entry.override.scope),
      entry.override.reason,
      entry.override.createdAt,
      entry.override.expiresAt ?? null,
      entry.recordedAt,
      JSON.stringify(entry.decisionReferences),
      entry.postActionOutcome ?? null
    );
  }

  listPage(request: OverrideAuditPageRequest = {}): OverrideAuditPage {
    const limit = request.limit ?? MAX_OVERRIDE_AUDIT_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OVERRIDE_AUDIT_PAGE_SIZE) {
      throw new RangeError(`Override audit page size must be between 1 and ${MAX_OVERRIDE_AUDIT_PAGE_SIZE}.`);
    }
    const afterSequence = request.afterSequence ?? 0;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new RangeError('Override audit cursor is invalid.');
    const rows = (request.overrideId === undefined
      ? this.#database.prepare('SELECT * FROM runtime_override_audit WHERE sequence > ? ORDER BY sequence LIMIT ?').all(afterSequence, limit + 1)
      : this.#database.prepare('SELECT * FROM runtime_override_audit WHERE sequence > ? AND override_id = ? ORDER BY sequence LIMIT ?').all(afterSequence, request.overrideId, limit + 1)) as unknown as OverrideAuditRow[];
    const visible = rows.slice(0, limit);
    const entries = Object.freeze(visible.map((row) => auditEntryFromRow(row, checkedUseId(row.use_id))));
    const nextCursor = rows.length > limit ? visible.at(-1)!.sequence : undefined;
    return Object.freeze({ entries, ...(nextCursor === undefined ? {} : { nextCursor }) });
  }

  close(): void {
    this.#database.close();
  }
}

function sameAuthorization(row: OverrideAuditRow, completion: OverrideAuditEntry): boolean {
  return row.scope_json === JSON.stringify(completion.override.scope)
    && row.reason === completion.override.reason
    && row.created_at === completion.override.createdAt
    && row.expires_at === (completion.override.expiresAt ?? null)
    && row.decision_references_json === JSON.stringify(completion.decisionReferences);
}

function migrateOverrideAudit(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(overrideAuditMigration);
    ensureOverrideAuditUseMigration(database);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function ensureOverrideAuditUseMigration(database: DatabaseSync): void {
  const table = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runtime_override_audit'").get() as { sql: string } | undefined;
  if (table === undefined) throw new TypeError('Override audit schema is missing.');
  if (table.sql.includes('runtime_override_audit_use_id_canonical')) return;

  const columns = database.prepare("SELECT name FROM pragma_table_info('runtime_override_audit')").all() as Array<{ name: string }>;
  const hasUseId = columns.some(({ name }) => name === 'use_id');
  validateLegacyRows(database, hasUseId);
  if (database.prepare("SELECT name FROM sqlite_master WHERE name = 'runtime_override_audit_v6'").get() !== undefined) {
    throw new TypeError('Override audit migration staging schema already exists.');
  }

  database.exec(strictOverrideAuditMigration);
  database.exec(hasUseId ? `
    INSERT INTO runtime_override_audit_v6
      (sequence, id, override_id, use_id, phase, scope_json, reason, created_at, expires_at, recorded_at, decision_references_json, post_action_outcome)
    SELECT sequence, id, override_id, use_id, phase, scope_json, reason, created_at, expires_at, recorded_at, decision_references_json, post_action_outcome
    FROM runtime_override_audit ORDER BY sequence
  ` : `
    INSERT INTO runtime_override_audit_v6
      (sequence, id, override_id, use_id, phase, scope_json, reason, created_at, expires_at, recorded_at, decision_references_json, post_action_outcome)
    SELECT sequence, id, override_id, 'legacy', phase, scope_json, reason, created_at, expires_at, recorded_at, decision_references_json, post_action_outcome
    FROM runtime_override_audit ORDER BY sequence
  `);
  database.exec('DROP TABLE runtime_override_audit');
  database.exec('ALTER TABLE runtime_override_audit_v6 RENAME TO runtime_override_audit');
}

function checkedUseId(value: string | null | undefined): string {
  if (value === null || value === undefined) throw new TypeError('Stored override audit use identity is missing.');
  return value;
}

function auditEntryFromRow(row: OverrideAuditRow, useId: string): OverrideAuditEntry {
  return validateOverrideAuditEntry({
    id: row.id,
    useId,
    override: parseRuntimeOverride({
      id: row.override_id,
      scope: parseJson(row.scope_json, 'override scope'),
      reason: row.reason,
      createdAt: row.created_at,
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at })
    }),
    phase: row.phase,
    recordedAt: row.recorded_at,
    decisionReferences: parseJson(row.decision_references_json, 'decision references') as readonly DecisionReference[],
    ...(row.post_action_outcome === null ? {} : { postActionOutcome: row.post_action_outcome })
  });
}

function validateLegacyRows(database: DatabaseSync, hasUseId: boolean): void {
  let afterSequence = 0;
  while (true) {
    const rows = database.prepare('SELECT * FROM runtime_override_audit WHERE sequence > ? ORDER BY sequence LIMIT ?')
      .all(afterSequence, OVERRIDE_AUDIT_MIGRATION_BATCH_SIZE) as unknown as OverrideAuditRow[];
    if (rows.length === 0) return;
    for (const row of rows) validateLegacyRow(database, row, hasUseId);
    afterSequence = rows.at(-1)!.sequence;
  }
}

function validateLegacyRow(database: DatabaseSync, row: OverrideAuditRow, hasUseId: boolean): void {
  const useId = hasUseId ? checkedUseId(row.use_id) : 'legacy';
  const entry = auditEntryFromRow(row, useId);
  if (entry.phase === 'authorized') return;
  const authorizationRows = (hasUseId
    ? database.prepare(`SELECT * FROM runtime_override_audit
        WHERE sequence < ? AND override_id = ? AND use_id = ? AND phase = 'authorized'
        ORDER BY sequence DESC LIMIT 2`).all(row.sequence, entry.override.id, useId)
    : database.prepare(`SELECT * FROM runtime_override_audit
        WHERE sequence < ? AND override_id = ? AND phase = 'authorized'
        ORDER BY sequence DESC LIMIT 2`).all(row.sequence, entry.override.id)) as unknown as OverrideAuditRow[];
  if (authorizationRows.length !== 1) throw new TypeError('Legacy completion audit requires exactly one prior authorization row.');
  const authorization = auditEntryFromRow(authorizationRows[0]!, useId);
  if (!sameAuditBinding(authorization, entry)) throw new TypeError('Legacy completion audit must match its authorization decision.');
  if (entry.recordedAt < authorization.recordedAt) throw new TypeError('Legacy completion audit cannot precede its authorization.');
}

function sameAuditBinding(authorization: OverrideAuditEntry, completion: OverrideAuditEntry): boolean {
  return JSON.stringify(authorization.override) === JSON.stringify(completion.override)
    && JSON.stringify(authorization.decisionReferences) === JSON.stringify(completion.decisionReferences);
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new TypeError(`Stored ${field} is not valid JSON.`, { cause: error });
  }
}
