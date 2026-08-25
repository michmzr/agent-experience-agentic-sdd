import type { DatabaseSync } from 'node:sqlite';

import type { DecisionReference } from '../runtime/contracts.js';
import {
  parseRuntimeOverride,
  validateOverrideAuditEntry,
  type OverrideAuditEntry,
  type PostActionOutcome
} from '../runtime/override.js';
import { openExperienceDatabase } from './database.js';

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

export const overrideAuditUseMigration = `
  ALTER TABLE runtime_override_audit ADD COLUMN use_id TEXT;
  UPDATE runtime_override_audit SET use_id = 'legacy' WHERE use_id IS NULL;
  DROP INDEX IF EXISTS runtime_override_audit_once_per_phase;
  CREATE UNIQUE INDEX IF NOT EXISTS runtime_override_audit_once_per_use_phase
    ON runtime_override_audit (override_id, use_id, phase);
`;

interface OverrideAuditRow {
  id: string;
  use_id: string | null;
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

  list(overrideId?: string): readonly OverrideAuditEntry[] {
    const rows = (overrideId === undefined
      ? this.#database.prepare('SELECT * FROM runtime_override_audit ORDER BY sequence').all()
      : this.#database.prepare('SELECT * FROM runtime_override_audit WHERE override_id = ? ORDER BY sequence').all(overrideId)) as unknown as OverrideAuditRow[];
    return Object.freeze(rows.map((row) => validateOverrideAuditEntry({
      id: row.id,
      useId: checkedUseId(row.use_id),
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
    })));
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
  const columns = database.prepare("SELECT name FROM pragma_table_info('runtime_override_audit')").all() as Array<{ name: string }>;
  if (!columns.some(({ name }) => name === 'use_id')) database.exec(overrideAuditUseMigration);
  else {
    database.exec('DROP INDEX IF EXISTS runtime_override_audit_once_per_phase');
    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS runtime_override_audit_once_per_use_phase
      ON runtime_override_audit (override_id, use_id, phase)`);
  }
}

function checkedUseId(value: string | null): string {
  if (value === null) throw new TypeError('Stored override audit use identity is missing.');
  return value;
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new TypeError(`Stored ${field} is not valid JSON.`, { cause: error });
  }
}
