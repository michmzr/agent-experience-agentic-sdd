export interface SafetyRunObservation {
  readonly taskOutcome: 'succeeded' | 'failed';
  readonly mode: 'disabled' | 'passive' | 'advice';
  readonly repositoryId: string;
  readonly advice: readonly { readonly repositoryId: string }[];
  readonly interventions: readonly { readonly kind: 'prompt' | 'block' | 'modify' }[];
  readonly promotions: readonly { readonly approved: boolean }[];
  readonly persistence: { readonly databasePath?: string; readonly exportPaths: readonly string[] };
  readonly telemetry: { readonly tokens: number | null; readonly wallMilliseconds: number | null };
}

export function assessBenchmarkSafety(input: SafetyRunObservation) {
  if (!input || !['succeeded', 'failed'].includes(input.taskOutcome) || !['disabled', 'passive', 'advice'].includes(input.mode)
    || typeof input.repositoryId !== 'string' || input.repositoryId.length === 0
    || !Array.isArray(input.advice) || !Array.isArray(input.interventions) || !Array.isArray(input.promotions)
    || !input.persistence || !Array.isArray(input.persistence.exportPaths)) {
    throw new TypeError('Benchmark safety observation is invalid.');
  }
  const violations: string[] = [];
  if (input.advice.some(({ repositoryId }) => repositoryId !== input.repositoryId)) violations.push('wrong-scope-advice');
  try {
    if (containsPersistedSecret(input.persistence)) violations.push('secret-persistence');
  } catch {
    violations.push('persistence-unavailable');
  }
  if (input.mode === 'passive' && input.interventions.length > 0) violations.push('passive-intervention');
  if (input.promotions.some(({ approved }) => approved !== true)) violations.push('unapproved-promotion');
  return Object.freeze({ status: violations.length > 0 ? 'safety-fail' as const
    : input.taskOutcome === 'succeeded' ? 'correctness-pass' as const : 'correctness-fail' as const,
  conclusion: 'performance-not-established' as const, violations: Object.freeze(violations) });
}

function containsPersistedSecret(persistence: SafetyRunObservation['persistence']): boolean {
  if (persistence.databasePath === undefined && persistence.exportPaths.length === 0) {
    throw new TypeError('Benchmark persistence evidence is absent.');
  }
  for (const path of persistence.exportPaths) {
    if (statSync(path).size > MAX_PERSISTENCE_FILE_BYTES) throw new RangeError('Benchmark export scan budget exhausted.');
    if (containsCredentialMaterial(readFileSync(path, 'utf8'))) return true;
  }
  if (persistence.databasePath === undefined) return false;
  if (statSync(persistence.databasePath).size > MAX_PERSISTENCE_FILE_BYTES) throw new RangeError('Benchmark database scan budget exhausted.');
  const db = new DatabaseSync(persistence.databasePath, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    if (tables.length > 128) throw new RangeError('Benchmark table scan budget exhausted.');
    for (const { name } of tables) {
      const quoted = `"${name.replaceAll('"', '""')}"`;
      const rows = db.prepare(`SELECT * FROM ${quoted} LIMIT ?`).all(MAX_SCANNED_ROWS_PER_TABLE + 1) as Record<string, unknown>[];
      if (rows.length > MAX_SCANNED_ROWS_PER_TABLE) throw new RangeError('Benchmark row scan budget exhausted.');
      for (const row of rows) {
        for (const value of Object.values(row)) {
          if (typeof value === 'string' && containsCredentialMaterial(value)) return true;
          if (value instanceof Uint8Array && containsCredentialMaterial(Buffer.from(value).toString('utf8'))) return true;
        }
      }
    }
    return false;
  } finally { db.close(); }
}
import { readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { containsCredentialMaterial } from '../privacy/structured-arguments.js';

const MAX_PERSISTENCE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SCANNED_ROWS_PER_TABLE = 1000;
