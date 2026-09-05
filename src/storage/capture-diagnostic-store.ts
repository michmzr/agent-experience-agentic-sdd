import type { DatabaseSync } from 'node:sqlite';

import type { CursorCaptureDiagnosticCategory } from '../capture/hook-diagnostics.js';
import { cursorCaptureDiagnosticCategories } from '../capture/hook-diagnostics.js';
import type { DiagnosticScope } from '../capture/diagnostic-scope.js';
import { isResolvedDiagnosticScope } from '../capture/diagnostic-scope.js';
import { openExperienceDatabase } from './database.js';

export interface CursorDiagnosticCounts {
  readonly 'invalid-working-directory': number;
  readonly 'persistence-failure': number;
  readonly 'unsafe-command-shape': number;
  readonly 'unsupported-tool': number;
}

type CursorDiagnosticScope = { readonly source: 'cursor'; readonly scope: DiagnosticScope };

interface DiagnosticRow {
  source: unknown;
  scope_kind: unknown;
  scope_id: unknown;
  category: unknown;
  count: unknown;
}

interface CheckedScope {
  readonly kind: DiagnosticScope['kind'];
  readonly id: string;
}

interface CheckedDiagnosticRow {
  readonly category: CursorCaptureDiagnosticCategory;
  readonly count: number;
}

const MAX_COUNT = Number.MAX_SAFE_INTEGER;
const CANONICAL_REPOSITORY_ID = /^[a-f0-9]{64}$/;
const WORKSPACE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const categorySet = new Set<string>(cursorCaptureDiagnosticCategories);

const aggregateSchema = `
  CREATE TABLE capture_diagnostic_counts (
    source TEXT NOT NULL CHECK (source = 'cursor'),
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('repository', 'workspace', 'global')),
    scope_id TEXT NOT NULL CHECK (
      (scope_kind = 'global' AND scope_id = 'global') OR
      (scope_kind = 'repository' AND length(scope_id) = 64 AND scope_id NOT GLOB '*[^a-f0-9]*') OR
      (scope_kind = 'workspace' AND length(scope_id) BETWEEN 1 AND 64
        AND scope_id NOT GLOB '*[^a-z0-9-]*' AND scope_id NOT GLOB '-*'
        AND scope_id NOT GLOB '*-' AND scope_id NOT GLOB '*--*')
    ),
    category TEXT NOT NULL CHECK (category IN (
      'invalid-working-directory',
      'persistence-failure',
      'unsafe-command-shape',
      'unsupported-tool'
    )),
    count INTEGER NOT NULL CHECK (count BETWEEN 1 AND 9007199254740991),
    PRIMARY KEY (source, scope_kind, scope_id, category)
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
    const checkedScopeValue = checkedScope(scope);
    checkedCategory(category);
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const beforeRow = this.#database.prepare(`
        SELECT source, scope_kind, scope_id, category, count FROM capture_diagnostic_counts
        WHERE source = 'cursor' AND scope_kind = ? AND scope_id = ? AND category = ?
      `).get(checkedScopeValue.kind, checkedScopeValue.id, category) as DiagnosticRow | undefined;
      const before = beforeRow === undefined ? 0 : checkedRow(beforeRow, checkedScopeValue, category).count;
      if (!Number.isSafeInteger(before) || before < 0 || before >= MAX_COUNT) {
        throw new RangeError('Capture diagnostic count cannot be incremented safely.');
      }

      const result = this.#database.prepare(`
        INSERT INTO capture_diagnostic_counts (source, scope_kind, scope_id, category, count)
        VALUES ('cursor', ?, ?, ?, 1)
        ON CONFLICT (source, scope_kind, scope_id, category) DO UPDATE SET count = count + 1
        WHERE count < 9007199254740991
      `).run(checkedScopeValue.kind, checkedScopeValue.id, category);
      if (result.changes !== 1) throw new RangeError('Capture diagnostic count cannot be incremented safely.');

      const afterRow = this.#database.prepare(`
        SELECT source, scope_kind, scope_id, category, count FROM capture_diagnostic_counts
        WHERE source = 'cursor' AND scope_kind = ? AND scope_id = ? AND category = ?
      `).get(checkedScopeValue.kind, checkedScopeValue.id, category) as DiagnosticRow | undefined;
      const after = afterRow === undefined ? undefined : checkedRow(afterRow, checkedScopeValue, category).count;
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
    const checkedScopeValue = checkedScope(scope);
    const rows = this.#database.prepare(`
      SELECT source, scope_kind, scope_id, category, count FROM capture_diagnostic_counts
      WHERE source = 'cursor' AND scope_kind = ? AND scope_id = ?
      ORDER BY category
    `).all(checkedScopeValue.kind, checkedScopeValue.id) as unknown as DiagnosticRow[];
    const counts: Record<CursorCaptureDiagnosticCategory, number> = {
      'invalid-working-directory': 0,
      'persistence-failure': 0,
      'unsafe-command-shape': 0,
      'unsupported-tool': 0
    };
    for (const row of rows) {
      const checked = checkedRow(row, checkedScopeValue);
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
      SELECT source, scope_kind, scope_id, category, count FROM capture_diagnostic_counts
      ORDER BY source, scope_kind, scope_id, category
    `).all() as unknown as DiagnosticRow[];
    for (const row of rows) checkedRow(row);
  }
}

function checkedScope(scope: CursorDiagnosticScope): CheckedScope {
  if (!scope || scope.source !== 'cursor' || !isResolvedDiagnosticScope(scope.scope)) {
    throw new TypeError('Capture diagnostic scope is invalid.');
  }
  if (scope.scope.kind === 'global' && scope.scope.id === 'global') return scope.scope;
  if (scope.scope.kind === 'repository' && typeof scope.scope.id === 'string' && CANONICAL_REPOSITORY_ID.test(scope.scope.id)) return scope.scope;
  if (scope.scope.kind === 'workspace' && typeof scope.scope.id === 'string' && isWorkspaceId(scope.scope.id)) return scope.scope;
  throw new TypeError('Capture diagnostic scope is invalid.');
}

function checkedCategory(category: unknown): asserts category is CursorCaptureDiagnosticCategory {
  if (typeof category !== 'string' || !categorySet.has(category)) throw new TypeError('Capture diagnostic category is invalid.');
}

function checkedRow(row: DiagnosticRow, expectedScope?: CheckedScope, expectedCategory?: CursorCaptureDiagnosticCategory): CheckedDiagnosticRow {
  if (row.source !== 'cursor' || typeof row.scope_kind !== 'string' || typeof row.scope_id !== 'string'
    || (row.scope_kind === 'global' && row.scope_id !== 'global')
    || (row.scope_kind === 'repository' && !CANONICAL_REPOSITORY_ID.test(row.scope_id))
    || (row.scope_kind === 'workspace' && !isWorkspaceId(row.scope_id))
    || (row.scope_kind !== 'repository' && row.scope_kind !== 'workspace' && row.scope_kind !== 'global')) {
    throw new TypeError('Capture diagnostic row is invalid.');
  }
  checkedCategory(row.category);
  if (typeof row.count !== 'number' || !Number.isSafeInteger(row.count) || row.count < 1 || row.count > MAX_COUNT) {
    throw new RangeError('Capture diagnostic count is invalid.');
  }
  if (expectedScope !== undefined && (row.scope_kind !== expectedScope.kind || row.scope_id !== expectedScope.id)) {
    throw new TypeError('Capture diagnostic row scope is invalid.');
  }
  if (expectedCategory !== undefined && row.category !== expectedCategory) throw new TypeError('Capture diagnostic row category is invalid.');
  return { category: row.category, count: row.count };
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/;$/, '').toLowerCase();
}

function isWorkspaceId(value: string): boolean {
  return value.length <= 64 && WORKSPACE_ID.test(value);
}
