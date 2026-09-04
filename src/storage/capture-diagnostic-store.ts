import type { DatabaseSync } from 'node:sqlite';

import type { CursorCaptureDiagnosticCategory } from '../capture/hook-diagnostics.js';
import { cursorCaptureDiagnosticCategories } from '../capture/hook-diagnostics.js';
import type { RepositoryId } from '../domain/types.js';
import { openExperienceDatabase } from './database.js';

export interface CursorDiagnosticCounts {
  readonly 'invalid-working-directory': number;
  readonly 'persistence-failure': number;
  readonly 'unsafe-command-shape': number;
  readonly 'unsupported-tool': number;
}

type CursorDiagnosticScope = { readonly source: 'cursor'; readonly repositoryId?: RepositoryId };

interface DiagnosticRow {
  source: unknown;
  scope_key: unknown;
  category: unknown;
  count: unknown;
}

interface CheckedDiagnosticRow {
  readonly category: CursorCaptureDiagnosticCategory;
  readonly count: number;
}

const GLOBAL_SCOPE_SENTINEL = '__global__';
const MAX_COUNT = Number.MAX_SAFE_INTEGER;
const CANONICAL_REPOSITORY_ID = /^[a-f0-9]{64}$/;
const categorySet = new Set<string>(cursorCaptureDiagnosticCategories);

const aggregateSchema = `
  CREATE TABLE capture_diagnostic_counts (
    source TEXT NOT NULL CHECK (source = 'cursor'),
    scope_key TEXT NOT NULL CHECK (
      scope_key = '__global__' OR (
        length(scope_key) = 64
        AND scope_key NOT GLOB '*[^a-f0-9]*'
      )
    ),
    category TEXT NOT NULL CHECK (category IN (
      'invalid-working-directory',
      'persistence-failure',
      'unsafe-command-shape',
      'unsupported-tool'
    )),
    count INTEGER NOT NULL CHECK (count BETWEEN 1 AND 9007199254740991),
    PRIMARY KEY (source, scope_key, category)
  ) WITHOUT ROWID;
`;

const normalizedAggregateSchema = normalizeSql(aggregateSchema);

export class CaptureDiagnosticStore {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    this.#database = openExperienceDatabase(databasePath);
    try {
      this.#initialize();
    } catch (error) {
      try {
        this.#database.close();
      } catch {
        // Preserve the schema failure if closing a malformed database also fails.
      }
      throw error;
    }
  }

  increment(scope: CursorDiagnosticScope, category: CursorCaptureDiagnosticCategory): void {
    const scopeKey = checkedScope(scope);
    checkedCategory(category);
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const beforeRow = this.#database.prepare(`
        SELECT source, scope_key, category, count FROM capture_diagnostic_counts
        WHERE source = 'cursor' AND scope_key = ? AND category = ?
      `).get(scopeKey, category) as DiagnosticRow | undefined;
      const before = beforeRow === undefined ? 0 : checkedRow(beforeRow, scopeKey, category).count;
      if (!Number.isSafeInteger(before) || before < 0 || before >= MAX_COUNT) {
        throw new RangeError('Capture diagnostic count cannot be incremented safely.');
      }

      const result = this.#database.prepare(`
        INSERT INTO capture_diagnostic_counts (source, scope_key, category, count)
        VALUES ('cursor', ?, ?, 1)
        ON CONFLICT (source, scope_key, category) DO UPDATE SET count = count + 1
        WHERE count < 9007199254740991
      `).run(scopeKey, category);
      if (result.changes !== 1) throw new RangeError('Capture diagnostic count cannot be incremented safely.');

      const afterRow = this.#database.prepare(`
        SELECT source, scope_key, category, count FROM capture_diagnostic_counts
        WHERE source = 'cursor' AND scope_key = ? AND category = ?
      `).get(scopeKey, category) as DiagnosticRow | undefined;
      const after = afterRow === undefined ? undefined : checkedRow(afterRow, scopeKey, category).count;
      if (after !== before + 1 || !Number.isSafeInteger(after)) {
        throw new RangeError('Capture diagnostic count cannot be incremented safely.');
      }
      this.#database.exec('COMMIT');
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        // The failed operation is more useful than a best-effort transaction cleanup error.
      }
      throw error;
    }
  }

  counts(scope: CursorDiagnosticScope): CursorDiagnosticCounts {
    const scopeKey = checkedScope(scope);
    const rows = this.#database.prepare(`
      SELECT source, scope_key, category, count FROM capture_diagnostic_counts
      WHERE source = 'cursor' AND scope_key = ?
      ORDER BY category
    `).all(scopeKey) as unknown as DiagnosticRow[];
    const counts: Record<CursorCaptureDiagnosticCategory, number> = {
      'invalid-working-directory': 0,
      'persistence-failure': 0,
      'unsafe-command-shape': 0,
      'unsupported-tool': 0
    };
    for (const row of rows) {
      const checked = checkedRow(row, scopeKey);
      counts[checked.category] = checked.count;
    }
    return Object.freeze(counts);
  }

  close(): void {
    this.#database.close();
  }

  #initialize(): void {
    const existing = this.#database.prepare(`
      SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'
    `).all() as Array<{ type: unknown; name: unknown; sql: unknown }>;
    if (existing.length === 0) {
      this.#database.exec(aggregateSchema);
    } else {
      if (existing.length !== 1 || existing[0]?.type !== 'table' || existing[0]?.name !== 'capture_diagnostic_counts'
        || typeof existing[0].sql !== 'string' || normalizeSql(existing[0].sql) !== normalizedAggregateSchema) {
        throw new TypeError('Capture diagnostic schema is malformed.');
      }
    }
    const rows = this.#database.prepare(`
      SELECT source, scope_key, category, count FROM capture_diagnostic_counts
      ORDER BY source, scope_key, category
    `).all() as unknown as DiagnosticRow[];
    for (const row of rows) checkedRow(row);
  }
}

function checkedScope(scope: CursorDiagnosticScope): string {
  if (!scope || scope.source !== 'cursor') throw new TypeError('Capture diagnostic source is invalid.');
  if (scope.repositoryId === undefined) return GLOBAL_SCOPE_SENTINEL;
  if (typeof scope.repositoryId !== 'string' || !CANONICAL_REPOSITORY_ID.test(scope.repositoryId)) {
    throw new TypeError('Capture diagnostic repository identifier is invalid.');
  }
  return scope.repositoryId;
}

function checkedCategory(category: unknown): asserts category is CursorCaptureDiagnosticCategory {
  if (typeof category !== 'string' || !categorySet.has(category)) throw new TypeError('Capture diagnostic category is invalid.');
}

function checkedRow(row: DiagnosticRow, expectedScopeKey?: string, expectedCategory?: CursorCaptureDiagnosticCategory): CheckedDiagnosticRow {
  if (row.source !== 'cursor' || typeof row.scope_key !== 'string'
    || (row.scope_key !== GLOBAL_SCOPE_SENTINEL && !CANONICAL_REPOSITORY_ID.test(row.scope_key))) {
    throw new TypeError('Capture diagnostic row is invalid.');
  }
  checkedCategory(row.category);
  if (typeof row.count !== 'number' || !Number.isSafeInteger(row.count) || row.count < 1 || row.count > MAX_COUNT) {
    throw new RangeError('Capture diagnostic count is invalid.');
  }
  if (expectedScopeKey !== undefined && row.scope_key !== expectedScopeKey) throw new TypeError('Capture diagnostic row scope is invalid.');
  if (expectedCategory !== undefined && row.category !== expectedCategory) throw new TypeError('Capture diagnostic row category is invalid.');
  return { category: row.category, count: row.count };
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/;$/, '').toLowerCase();
}
