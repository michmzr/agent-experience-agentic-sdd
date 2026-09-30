import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { containsCredentialMaterial } from '../privacy/structured-arguments.js';
import { openExperienceDatabase } from '../storage/database.js';

export interface AdviceScope {
  readonly repositoryId: string;
  readonly lessonId: string;
  readonly lessonRevision: string;
  readonly sessionId: string;
  readonly contextRevision: string;
}

export type UsageKind = 'retrieved' | 'delivered' | 'selected' | 'applied' | 'outcome-observed' | 'rejected' | 'expired';
export type UsageOrigin = 'cli-retrieval' | 'cli-output' | 'agent-claim' | 'agent-selection' | 'operation-evidence' | 'verification-evidence';
export interface UsageFact { readonly kind: UsageKind; readonly origin: UsageOrigin; readonly witnessRef: string }
export interface AdviceBundle { readonly id: string }
export interface StoredAdviceBundle extends AdviceBundle, AdviceScope { readonly operationSignature: string; readonly retrievedAt: string | null }

const migration = `CREATE TABLE IF NOT EXISTS advice_usage_bundles (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  lesson_revision TEXT NOT NULL,
  session_id TEXT NOT NULL,
  context_revision TEXT NOT NULL,
  operation_signature TEXT NOT NULL,
  retrieved_at TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS advice_usage_facts (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  bundle_id TEXT NOT NULL REFERENCES advice_usage_bundles(id),
  kind TEXT NOT NULL,
  origin TEXT NOT NULL,
  witness_ref TEXT NOT NULL,
  recorded_at TEXT,
  UNIQUE(bundle_id, kind, origin, witness_ref)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS advice_single_retrieval ON advice_usage_facts(bundle_id) WHERE kind = 'retrieved';`;

const allowedOrigins: Record<Exclude<UsageKind, 'retrieved'>, readonly UsageOrigin[]> = {
  delivered: ['cli-output', 'agent-claim'], selected: ['agent-selection'],
  applied: ['operation-evidence'], 'outcome-observed': ['verification-evidence'],
  rejected: ['agent-selection'], expired: ['cli-retrieval']
};

export class AdvisoryUsageStore {
  constructor(readonly path: string, private readonly now: () => string = () => new Date().toISOString()) {}

  retrieved(input: AdviceScope & { readonly operationSignature: string; readonly retrievalRef: string }): AdviceBundle {
    validateScope(input);
    validKey(input.operationSignature, 'operation signature');
    validKey(input.retrievalRef, 'retrieval reference');
    const id = `advice-use:${createHash('sha256').update(JSON.stringify([
      input.repositoryId, input.lessonId, input.lessonRevision, input.sessionId, input.contextRevision, input.operationSignature
    ])).digest('hex')}`;
    const retrievedAt = this.now();
    const database = this.open();
    try {
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(`INSERT OR IGNORE INTO advice_usage_bundles
          (id, repository_id, lesson_id, lesson_revision, session_id, context_revision, operation_signature, retrieved_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.repositoryId, input.lessonId, input.lessonRevision,
          input.sessionId, input.contextRevision, input.operationSignature, retrievedAt);
        database.prepare(`INSERT OR IGNORE INTO advice_usage_facts (bundle_id, kind, origin, witness_ref, recorded_at)
          VALUES (?, 'retrieved', 'cli-retrieval', ?, ?)`).run(id, input.retrievalRef, retrievedAt);
        database.exec('COMMIT');
      } catch (error) { database.exec('ROLLBACK'); throw error; }
    } finally { database.close(); }
    return Object.freeze({ id });
  }

  record(input: AdviceScope & { readonly bundleId: string; readonly kind: Exclude<UsageKind, 'retrieved'>; readonly origin: UsageOrigin; readonly witnessRef: string }): void {
    validateScope(input);
    validKey(input.bundleId, 'bundle ID');
    validKey(input.witnessRef, 'witness reference');
    if (!Object.hasOwn(allowedOrigins, input.kind) || !allowedOrigins[input.kind].includes(input.origin)) {
      throw new TypeError('Unsupported usage fact or origin.');
    }
    const database = this.open();
    try {
      database.exec('BEGIN IMMEDIATE');
      try {
        const bundle = database.prepare(`SELECT repository_id, lesson_id, lesson_revision, session_id, context_revision
          FROM advice_usage_bundles WHERE id = ?`).get(input.bundleId) as Record<string, string> | undefined;
        if (!bundle || bundle.repository_id !== input.repositoryId || bundle.lesson_id !== input.lessonId
          || bundle.lesson_revision !== input.lessonRevision || bundle.session_id !== input.sessionId
          || bundle.context_revision !== input.contextRevision) throw new TypeError('Usage fact scope or lesson revision mismatch.');
        const priorRows = database.prepare('SELECT kind FROM advice_usage_facts WHERE bundle_id = ?').all(input.bundleId) as { kind: UsageKind }[];
        const prior = new Set(priorRows.map(row => row.kind));
        const prerequisite = input.kind === 'selected' ? 'delivered' : input.kind === 'applied' ? 'selected'
          : input.kind === 'outcome-observed' ? 'applied' : 'retrieved';
        if (!prior.has(prerequisite)) throw new TypeError(`Usage fact requires ${prerequisite} witness.`);
        database.prepare('INSERT OR IGNORE INTO advice_usage_facts (bundle_id, kind, origin, witness_ref, recorded_at) VALUES (?, ?, ?, ?, ?)')
          .run(input.bundleId, input.kind, input.origin, input.witnessRef, this.now());
        database.exec('COMMIT');
      } catch (error) { database.exec('ROLLBACK'); throw error; }
    } finally { database.close(); }
  }

  facts(bundleId: string): readonly UsageFact[] {
    validKey(bundleId, 'bundle ID');
    const database = new DatabaseSync(this.path, { readOnly: true, timeout: 125 });
    try {
      return Object.freeze((database.prepare('SELECT kind, origin, witness_ref FROM advice_usage_facts WHERE bundle_id = ? ORDER BY ordinal')
        .all(bundleId) as { kind: UsageKind; origin: UsageOrigin; witness_ref: string }[])
        .map(row => Object.freeze({ kind: row.kind, origin: row.origin, witnessRef: row.witness_ref })));
    } finally { database.close(); }
  }

  firstFactTime(bundleId: string, kind: UsageKind): string | null {
    validKey(bundleId, 'bundle ID');
    const database = new DatabaseSync(this.path, { readOnly: true, timeout: 125 });
    try {
      const columns = database.prepare('PRAGMA table_info(advice_usage_facts)').all() as Array<{ name: string }>;
      if (!columns.some(column => column.name === 'recorded_at')) return null;
      const row = database.prepare('SELECT recorded_at FROM advice_usage_facts WHERE bundle_id = ? AND kind = ? ORDER BY ordinal LIMIT 1')
        .get(bundleId, kind) as { recorded_at: string | null } | undefined;
      return row?.recorded_at ?? null;
    } finally { database.close(); }
  }

  bundle(bundleId: string): StoredAdviceBundle | undefined {
    validKey(bundleId, 'bundle ID');
    const database = new DatabaseSync(this.path, { readOnly: true, timeout: 125 });
    try {
      const columns = database.prepare('PRAGMA table_info(advice_usage_bundles)').all() as Array<{ name: string }>;
      const retrievalTime = columns.some(column => column.name === 'retrieved_at') ? 'retrieved_at' : 'NULL AS retrieved_at';
      const row = database.prepare(`SELECT id, repository_id, lesson_id, lesson_revision, session_id,
        context_revision, operation_signature, ${retrievalTime} FROM advice_usage_bundles WHERE id = ?`).get(bundleId) as {
          id: string; repository_id: string; lesson_id: string; lesson_revision: string;
          session_id: string; context_revision: string; operation_signature: string; retrieved_at: string | null
        } | undefined;
      return row === undefined ? undefined : Object.freeze({ id: row.id, repositoryId: row.repository_id,
        lessonId: row.lesson_id, lessonRevision: row.lesson_revision, sessionId: row.session_id,
        contextRevision: row.context_revision, operationSignature: row.operation_signature, retrievedAt: row.retrieved_at });
    } finally { database.close(); }
  }

  private open(): DatabaseSync {
    const database = openExperienceDatabase(this.path, { timeoutMs: 125 });
    database.exec(migration);
    const columns = database.prepare('PRAGMA table_info(advice_usage_bundles)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'retrieved_at')) database.exec('ALTER TABLE advice_usage_bundles ADD COLUMN retrieved_at TEXT');
    const factColumns = database.prepare('PRAGMA table_info(advice_usage_facts)').all() as Array<{ name: string }>;
    if (!factColumns.some(column => column.name === 'recorded_at')) database.exec('ALTER TABLE advice_usage_facts ADD COLUMN recorded_at TEXT');
    return database;
  }
}

function validateScope(scope: AdviceScope): void {
  validKey(scope.repositoryId, 'repository ID');
  validKey(scope.lessonId, 'lesson ID');
  validKey(scope.lessonRevision, 'lesson revision');
  validKey(scope.sessionId, 'session ID');
  validKey(scope.contextRevision, 'context revision');
}

function validKey(value: string, name: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:/-]{1,160}$/.test(value) || containsCredentialMaterial(value)) {
    throw new TypeError(`Invalid advice ${name}.`);
  }
}
