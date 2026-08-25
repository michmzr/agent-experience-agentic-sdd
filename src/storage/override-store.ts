import type { DatabaseSync } from 'node:sqlite';

import type { DecisionReference } from '../runtime/contracts.js';
import {
  parseRuntimeOverride,
  validateOverrideAuditEntry,
  type OverrideAuditEntry,
  type OverrideLearningEvidence,
  type PostActionOutcome
} from '../runtime/override.js';
import { openExperienceDatabase } from './database.js';

export const MAX_OVERRIDE_AUDIT_PAGE_SIZE = 100;
export const MAX_OVERRIDE_EVIDENCE_PAGE_SIZE = 50;
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

export interface OverrideEvidenceRequest {
  readonly overrideId?: string;
  readonly afterRuleId?: string;
  readonly limit?: number;
}

export interface OverrideEvidencePage {
  readonly entries: readonly OverrideLearningEvidence[];
  readonly nextCursor?: string;
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

interface QualifyingRuleRow {
  rule_id: string;
  successful_use_count: number;
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

  deriveLearningEvidencePage(request: OverrideEvidenceRequest = {}): OverrideEvidencePage {
    const limit = request.limit ?? MAX_OVERRIDE_EVIDENCE_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OVERRIDE_EVIDENCE_PAGE_SIZE) {
      throw new RangeError(`Override evidence page size must be between 1 and ${MAX_OVERRIDE_EVIDENCE_PAGE_SIZE}.`);
    }
    const afterRuleId = request.afterRuleId ?? '';
    if (afterRuleId !== '' && !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,511}$/.test(afterRuleId)) {
      throw new RangeError('Override evidence cursor is invalid.');
    }
    const groups = qualifyingRuleGroups(this.#database, request.overrideId, afterRuleId, limit + 1);
    const visible = groups.slice(0, limit);
    const entries = Object.freeze(visible.map(({ rule_id: ruleId, successful_use_count: successfulUseCount }) => {
      const supports = supportingSuccessfulUses(this.#database, ruleId, request.overrideId);
      return Object.freeze({
        ruleId,
        polarity: 'contradicts' as const,
        successfulOverrideIds: Object.freeze(supports.map(({ completion }) => completion.override.id)),
        successfulUseIds: Object.freeze(supports.map(({ completion }) => completion.useId)),
        successfulUseCount,
        revalidationRequired: true as const
      });
    }));
    const nextCursor = groups.length > limit ? visible.at(-1)!.rule_id : undefined;
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

function qualifyingRuleGroups(
  database: DatabaseSync,
  overrideId: string | undefined,
  afterRuleId: string,
  limit: number
): QualifyingRuleRow[] {
  const overrideClause = overrideId === undefined ? '' : 'AND completed.override_id = ?';
  const sql = `
    WITH paired_successes AS (
      SELECT completed.*
      FROM runtime_override_audit completed
      JOIN runtime_override_audit authorized
        ON authorized.override_id = completed.override_id
        AND authorized.use_id = completed.use_id
        AND authorized.phase = 'authorized'
        AND authorized.sequence < completed.sequence
        AND authorized.scope_json = completed.scope_json
        AND authorized.reason = completed.reason
        AND authorized.created_at = completed.created_at
        AND authorized.expires_at IS completed.expires_at
        AND authorized.decision_references_json = completed.decision_references_json
      WHERE completed.phase = 'completed'
        AND completed.post_action_outcome = 'succeeded'
        ${overrideClause}
    ), distinct_rule_uses AS (
      SELECT
        json_extract(reference.value, '$.ruleId') AS rule_id,
        success.override_id,
        success.use_id
      FROM paired_successes success
      JOIN json_each(success.decision_references_json) reference
      WHERE json_type(reference.value, '$.ruleId') = 'text'
        AND (
          json_extract(success.scope_json, '$.kind') <> 'rule'
          OR json_extract(success.scope_json, '$.ruleId') = json_extract(reference.value, '$.ruleId')
        )
      GROUP BY rule_id, success.override_id, success.use_id
    )
    SELECT rule_id, COUNT(*) AS successful_use_count
    FROM distinct_rule_uses
    WHERE rule_id > ?
    GROUP BY rule_id
    HAVING COUNT(*) >= 2
    ORDER BY rule_id
    LIMIT ?
  `;
  const rows = (overrideId === undefined
    ? database.prepare(sql).all(afterRuleId, limit)
    : database.prepare(sql).all(overrideId, afterRuleId, limit)) as unknown as QualifyingRuleRow[];
  for (const row of rows) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,511}$/.test(row.rule_id)
      || !Number.isSafeInteger(row.successful_use_count) || row.successful_use_count < 2) {
      throw new TypeError('Stored override evidence grouping is invalid.');
    }
  }
  return rows;
}

function supportingSuccessfulUses(
  database: DatabaseSync,
  ruleId: string,
  overrideId: string | undefined
): Array<{ readonly authorization: OverrideAuditEntry; readonly completion: OverrideAuditEntry }> {
  const overrideClause = overrideId === undefined ? '' : 'AND completed.override_id = ?';
  const sql = `
    SELECT completed.*
    FROM runtime_override_audit completed
    JOIN runtime_override_audit authorized
      ON authorized.override_id = completed.override_id
      AND authorized.use_id = completed.use_id
      AND authorized.phase = 'authorized'
      AND authorized.sequence < completed.sequence
      AND authorized.scope_json = completed.scope_json
      AND authorized.reason = completed.reason
      AND authorized.created_at = completed.created_at
      AND authorized.expires_at IS completed.expires_at
      AND authorized.decision_references_json = completed.decision_references_json
    WHERE completed.phase = 'completed'
      AND completed.post_action_outcome = 'succeeded'
      ${overrideClause}
      AND EXISTS (
        SELECT 1 FROM json_each(completed.decision_references_json) reference
        WHERE json_extract(reference.value, '$.ruleId') = ?
      )
      AND (
        json_extract(completed.scope_json, '$.kind') <> 'rule'
        OR json_extract(completed.scope_json, '$.ruleId') = ?
      )
    ORDER BY completed.sequence
    LIMIT 2
  `;
  const completionRows = (overrideId === undefined
    ? database.prepare(sql).all(ruleId, ruleId)
    : database.prepare(sql).all(overrideId, ruleId, ruleId)) as unknown as OverrideAuditRow[];
  if (completionRows.length !== 2) throw new TypeError('Qualifying override evidence is missing supporting uses.');
  return completionRows.map((row) => {
    const completion = auditEntryFromRow(row, checkedUseId(row.use_id));
    const authorizationRows = database.prepare(`SELECT * FROM runtime_override_audit
      WHERE override_id = ? AND use_id = ? AND phase = 'authorized' AND sequence < ?
      ORDER BY sequence DESC LIMIT 2`).all(completion.override.id, completion.useId, row.sequence) as unknown as OverrideAuditRow[];
    if (authorizationRows.length !== 1) throw new TypeError('Successful completion audit requires exactly one prior authorization row.');
    const authorization = auditEntryFromRow(authorizationRows[0]!, completion.useId);
    if (!sameAuthorization(authorizationRows[0]!, completion) || completion.recordedAt < authorization.recordedAt) {
      throw new TypeError('Successful completion audit does not match its authorization.');
    }
    return Object.freeze({ authorization, completion });
  });
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
  createLegacyLookupIndex(database, hasUseId);
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

function createLegacyLookupIndex(database: DatabaseSync, hasUseId: boolean): void {
  database.exec('DROP INDEX IF EXISTS runtime_override_audit_once_per_phase');
  database.exec(`CREATE INDEX runtime_override_audit_migration_lookup ON runtime_override_audit
    (${hasUseId ? 'override_id, use_id, phase, sequence' : 'override_id, phase, sequence'})`);
  const plan = (hasUseId
    ? database.prepare(`EXPLAIN QUERY PLAN SELECT * FROM runtime_override_audit
        WHERE sequence < ? AND override_id = ? AND use_id = ? AND phase = 'authorized'
        ORDER BY sequence DESC LIMIT 2`).all(1, 'probe', 'probe')
    : database.prepare(`EXPLAIN QUERY PLAN SELECT * FROM runtime_override_audit
        WHERE sequence < ? AND override_id = ? AND phase = 'authorized'
        ORDER BY sequence DESC LIMIT 2`).all(1, 'probe')) as Array<{ detail: string }>;
  if (!plan.some(({ detail }) => detail.includes('runtime_override_audit_migration_lookup'))) {
    throw new TypeError('Override audit migration lookup is not indexed.');
  }
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
