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
  readonly cursor?: OverrideEvidenceCursor;
  readonly limit?: number;
}

export interface OverrideEvidenceCursor {
  readonly afterRuleId: string;
  readonly highWaterSequence: number;
  readonly overrideId?: string;
}

export interface OverrideEvidencePage {
  readonly entries: readonly OverrideLearningEvidence[];
  readonly nextCursor?: OverrideEvidenceCursor;
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

const overrideEvidenceMigration = `
  CREATE UNIQUE INDEX IF NOT EXISTS runtime_override_audit_sequence_use
    ON runtime_override_audit(sequence, override_id, use_id);

  CREATE TABLE runtime_override_rule_reference (
    audit_sequence INTEGER NOT NULL,
    rule_id TEXT NOT NULL,
    CONSTRAINT runtime_override_reference_rule_id_canonical CHECK (
      length(rule_id) BETWEEN 1 AND 512
      AND substr(rule_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND rule_id NOT GLOB '*[^A-Za-z0-9._:@-]*'
    ),
    PRIMARY KEY (audit_sequence, rule_id),
    FOREIGN KEY (audit_sequence) REFERENCES runtime_override_audit(sequence) ON DELETE RESTRICT
  ) WITHOUT ROWID;
  CREATE INDEX runtime_override_reference_by_rule_sequence
    ON runtime_override_rule_reference(rule_id, audit_sequence);

  CREATE TABLE runtime_override_rule_success (
    rule_id TEXT NOT NULL,
    override_id TEXT NOT NULL,
    use_id TEXT NOT NULL,
    completion_sequence INTEGER NOT NULL,
    CONSTRAINT runtime_override_success_override_id_canonical CHECK (
      length(override_id) BETWEEN 1 AND 512
      AND substr(override_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND override_id NOT GLOB '*[^A-Za-z0-9._:@-]*'
    ),
    CONSTRAINT runtime_override_success_use_id_canonical CHECK (
      length(use_id) BETWEEN 1 AND 512
      AND substr(use_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND use_id NOT GLOB '*[^A-Za-z0-9._:@-]*'
    ),
    PRIMARY KEY (rule_id, override_id, use_id),
    UNIQUE (completion_sequence, rule_id),
    FOREIGN KEY (completion_sequence, rule_id)
      REFERENCES runtime_override_rule_reference(audit_sequence, rule_id) ON DELETE RESTRICT,
    FOREIGN KEY (completion_sequence, override_id, use_id)
      REFERENCES runtime_override_audit(sequence, override_id, use_id) ON DELETE RESTRICT
  ) WITHOUT ROWID;
  CREATE INDEX runtime_override_success_by_rule_sequence
    ON runtime_override_rule_success(rule_id, completion_sequence, override_id, use_id);
  CREATE INDEX runtime_override_success_by_override_rule_sequence
    ON runtime_override_rule_success(override_id, rule_id, completion_sequence, use_id);

  CREATE TABLE runtime_override_rule_qualification (
    scope_key TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    qualified_at_sequence INTEGER NOT NULL,
    CONSTRAINT runtime_override_qualification_scope_canonical CHECK (
      scope_key = '*' OR (
        length(scope_key) BETWEEN 1 AND 512
        AND substr(scope_key, 1, 1) GLOB '[A-Za-z0-9]'
        AND scope_key NOT GLOB '*[^A-Za-z0-9._:@-]*'
      )
    ),
    PRIMARY KEY (scope_key, rule_id),
    FOREIGN KEY (qualified_at_sequence, rule_id)
      REFERENCES runtime_override_rule_success(completion_sequence, rule_id) ON DELETE RESTRICT
  ) WITHOUT ROWID;
  CREATE INDEX runtime_override_qualification_page
    ON runtime_override_rule_qualification(scope_key, rule_id, qualified_at_sequence);
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
}

interface SuccessfulUseRow {
  override_id: string;
  use_id: string;
}

const GLOBAL_QUALIFICATION_SCOPE = '*';
const CANONICAL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,511}$/;

export class OverrideStore {
  readonly #database: DatabaseSync;

  constructor(databasePath?: string) {
    this.#database = openExperienceDatabase(databasePath);
    migrateOverrideAudit(this.#database);
  }

  append(input: OverrideAuditEntry): void {
    const entry = validateOverrideAuditEntry(input);
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      if (entry.phase === 'completed') {
        const authorized = this.#database.prepare(`
          SELECT * FROM runtime_override_audit
          WHERE override_id = ? AND use_id = ? AND phase = 'authorized'
        `).get(entry.override.id, entry.useId) as unknown as OverrideAuditRow | undefined;
        if (authorized === undefined) throw new TypeError('Completion audit requires a prior authorization row.');
        if (!sameAuthorization(authorized, entry)) throw new TypeError('Completion audit must match its authorization decision.');
        if (entry.recordedAt < authorized.recorded_at) throw new TypeError('Completion audit cannot precede its authorization.');
      }
      const sequence = this.#insert(entry);
      insertNormalizedReferences(this.#database, sequence, entry);
      if (entry.phase === 'completed' && entry.postActionOutcome === 'succeeded') {
        insertSuccessfulRuleEvidence(this.#database, sequence, entry);
      }
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  #insert(entry: OverrideAuditEntry): number {
    const result = this.#database.prepare(`
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
    const sequence = Number(result.lastInsertRowid);
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new TypeError('Override audit sequence is invalid.');
    return sequence;
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
    if (request.overrideId !== undefined && !CANONICAL_IDENTIFIER.test(request.overrideId)) {
      throw new RangeError('Override evidence filter is invalid.');
    }
    const currentHighWater = auditHighWater(this.#database);
    const cursor = request.cursor === undefined
      ? { afterRuleId: '', highWaterSequence: currentHighWater, ...(request.overrideId === undefined ? {} : { overrideId: request.overrideId }) }
      : checkedEvidenceCursor(request.cursor, request.overrideId, currentHighWater);
    const groups = qualifyingRuleGroups(
      this.#database,
      request.overrideId ?? GLOBAL_QUALIFICATION_SCOPE,
      cursor.afterRuleId,
      cursor.highWaterSequence,
      limit + 1
    );
    const visible = groups.slice(0, limit);
    const entries = Object.freeze(visible.map(({ rule_id: ruleId }) => {
      const successfulUseCount = countSuccessfulUses(this.#database, ruleId, request.overrideId, cursor.highWaterSequence);
      const supports = supportingSuccessfulUses(this.#database, ruleId, request.overrideId, cursor.highWaterSequence);
      return Object.freeze({
        ruleId,
        polarity: 'contradicts' as const,
        successfulOverrideIds: Object.freeze(supports.map(({ override_id: overrideId }) => overrideId)),
        successfulUseIds: Object.freeze(supports.map(({ use_id: useId }) => useId)),
        successfulUseCount,
        revalidationRequired: true as const
      });
    }));
    const nextCursor = groups.length > limit
      ? Object.freeze({
          afterRuleId: visible.at(-1)!.rule_id,
          highWaterSequence: cursor.highWaterSequence,
          ...(request.overrideId === undefined ? {} : { overrideId: request.overrideId })
        })
      : undefined;
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

function insertNormalizedReferences(database: DatabaseSync, sequence: number, entry: OverrideAuditEntry): void {
  const insert = database.prepare(`INSERT INTO runtime_override_rule_reference (audit_sequence, rule_id) VALUES (?, ?)`);
  for (const { ruleId } of entry.decisionReferences) insert.run(sequence, ruleId);
}

function relevantRuleIds(entry: OverrideAuditEntry): readonly string[] {
  const scope = entry.override.scope;
  return scope.kind === 'rule'
    ? entry.decisionReferences.filter(({ ruleId }) => ruleId === scope.ruleId).map(({ ruleId }) => ruleId)
    : entry.decisionReferences.map(({ ruleId }) => ruleId);
}

function insertSuccessfulRuleEvidence(database: DatabaseSync, sequence: number, entry: OverrideAuditEntry): void {
  const insertSuccess = database.prepare(`INSERT INTO runtime_override_rule_success
    (rule_id, override_id, use_id, completion_sequence) VALUES (?, ?, ?, ?)`);
  for (const ruleId of relevantRuleIds(entry)) {
    insertSuccess.run(ruleId, entry.override.id, entry.useId, sequence);
    qualifyRule(database, ruleId, GLOBAL_QUALIFICATION_SCOPE);
    qualifyRule(database, ruleId, entry.override.id);
  }
}

function qualifyRule(database: DatabaseSync, ruleId: string, scopeKey: string): void {
  const scoped = scopeKey !== GLOBAL_QUALIFICATION_SCOPE;
  const second = (scoped
    ? database.prepare(`SELECT completion_sequence FROM runtime_override_rule_success
        WHERE override_id = ? AND rule_id = ? ORDER BY completion_sequence LIMIT 1 OFFSET 1`).get(scopeKey, ruleId)
    : database.prepare(`SELECT completion_sequence FROM runtime_override_rule_success
        WHERE rule_id = ? ORDER BY completion_sequence LIMIT 1 OFFSET 1`).get(ruleId)) as { completion_sequence: number } | undefined;
  if (second === undefined) return;
  database.prepare(`INSERT INTO runtime_override_rule_qualification (scope_key, rule_id, qualified_at_sequence)
    VALUES (?, ?, ?) ON CONFLICT (scope_key, rule_id) DO NOTHING`).run(scopeKey, ruleId, second.completion_sequence);
}

function auditHighWater(database: DatabaseSync): number {
  const row = database.prepare('SELECT COALESCE(MAX(sequence), 0) AS high_water FROM runtime_override_audit').get() as { high_water: number };
  if (!Number.isSafeInteger(row.high_water) || row.high_water < 0) throw new TypeError('Stored override audit high-water is invalid.');
  return row.high_water;
}

function checkedEvidenceCursor(
  value: OverrideEvidenceCursor,
  overrideId: string | undefined,
  currentHighWater: number
): OverrideEvidenceCursor {
  if (typeof value !== 'object' || value === null
    || !CANONICAL_IDENTIFIER.test(value.afterRuleId)
    || !Number.isSafeInteger(value.highWaterSequence) || value.highWaterSequence < 0
    || value.highWaterSequence > currentHighWater
    || value.overrideId !== overrideId) {
    throw new RangeError('Override evidence cursor is invalid.');
  }
  return value;
}

function qualifyingRuleGroups(
  database: DatabaseSync,
  scopeKey: string,
  afterRuleId: string,
  highWaterSequence: number,
  limit: number
): QualifyingRuleRow[] {
  const rows = database.prepare(`SELECT rule_id FROM runtime_override_rule_qualification
    INDEXED BY runtime_override_qualification_page
    WHERE scope_key = ? AND rule_id > ? AND qualified_at_sequence <= ?
    ORDER BY rule_id LIMIT ?`).all(scopeKey, afterRuleId, highWaterSequence, limit) as unknown as QualifyingRuleRow[];
  for (const row of rows) {
    if (!CANONICAL_IDENTIFIER.test(row.rule_id)) throw new TypeError('Stored override evidence grouping is invalid.');
  }
  return rows;
}

function countSuccessfulUses(database: DatabaseSync, ruleId: string, overrideId: string | undefined, highWaterSequence: number): number {
  const row = (overrideId === undefined
    ? database.prepare(`SELECT COUNT(*) AS count FROM runtime_override_rule_success
        INDEXED BY runtime_override_success_by_rule_sequence
        WHERE rule_id = ? AND completion_sequence <= ?`).get(ruleId, highWaterSequence)
    : database.prepare(`SELECT COUNT(*) AS count FROM runtime_override_rule_success
        INDEXED BY runtime_override_success_by_override_rule_sequence
        WHERE override_id = ? AND rule_id = ? AND completion_sequence <= ?`).get(overrideId, ruleId, highWaterSequence)) as { count: number };
  if (!Number.isSafeInteger(row.count) || row.count < 2) throw new TypeError('Qualifying override evidence has an invalid successful-use count.');
  return row.count;
}

function supportingSuccessfulUses(
  database: DatabaseSync,
  ruleId: string,
  overrideId: string | undefined,
  highWaterSequence: number
): SuccessfulUseRow[] {
  const rows = (overrideId === undefined
    ? database.prepare(`SELECT override_id, use_id FROM runtime_override_rule_success
        INDEXED BY runtime_override_success_by_rule_sequence
        WHERE rule_id = ? AND completion_sequence <= ? ORDER BY completion_sequence LIMIT 2`).all(ruleId, highWaterSequence)
    : database.prepare(`SELECT override_id, use_id FROM runtime_override_rule_success
        INDEXED BY runtime_override_success_by_override_rule_sequence
        WHERE override_id = ? AND rule_id = ? AND completion_sequence <= ? ORDER BY completion_sequence LIMIT 2`).all(overrideId, ruleId, highWaterSequence)) as unknown as SuccessfulUseRow[];
  if (rows.length !== 2) throw new TypeError('Qualifying override evidence is missing supporting uses.');
  return rows;
}

function migrateOverrideAudit(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(overrideAuditMigration);
    ensureOverrideAuditUseMigration(database);
    ensureOverrideEvidenceMigration(database);
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

export function ensureOverrideEvidenceMigration(database: DatabaseSync): void {
  const tableNames = new Set((database.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'runtime_override_rule_reference',
      'runtime_override_rule_success',
      'runtime_override_rule_qualification'
    )`).all() as Array<{ name: string }>).map(({ name }) => name));
  if (tableNames.size === 3) return;
  if (tableNames.size !== 0) throw new TypeError('Override evidence migration schema is incomplete.');

  validateLegacyRows(database, true);
  database.exec(overrideEvidenceMigration);
  let afterSequence = 0;
  while (true) {
    const rows = database.prepare('SELECT * FROM runtime_override_audit WHERE sequence > ? ORDER BY sequence LIMIT ?')
      .all(afterSequence, OVERRIDE_AUDIT_MIGRATION_BATCH_SIZE) as unknown as OverrideAuditRow[];
    if (rows.length === 0) return;
    for (const row of rows) {
      const entry = auditEntryFromRow(row, checkedUseId(row.use_id));
      insertNormalizedReferences(database, row.sequence, entry);
      if (entry.phase === 'completed' && entry.postActionOutcome === 'succeeded') {
        insertSuccessfulRuleEvidence(database, row.sequence, entry);
      }
    }
    afterSequence = rows.at(-1)!.sequence;
  }
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
