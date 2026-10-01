import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { containsPersistedSecret } from './compare.js';
import { digest } from './manifest.js';

const protectedTables = ['acl_candidates', 'acl_candidate_origins', 'acl_candidate_reviews',
  'acl_package_manager_facts'] as const;
const databaseNames = ['experience.sqlite', 'advice.sqlite', 'capture-spool.sqlite'] as const;
const maxDatabaseBytes = 4 * 1024 * 1024;
const maxJsonBytes = 64 * 1024;

/** Digest review authority and source facts. New unreviewed analysis candidates are permitted. */
export function protectedCandidateDigest(path: string): string {
  const state = lstatSync(path);
  if (!state.isFile() || state.isSymbolicLink() || state.size > maxDatabaseBytes) {
    throw new TypeError('Candidate store is unavailable or exceeds the safety bound.');
  }
  const database = new DatabaseSync(path, { readOnly: true, timeout: 125 });
  try {
    const snapshot = protectedTables.map(table => {
      const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (!exists) throw new TypeError('Candidate evidence table is missing.');
      const query = table === 'acl_candidates'
        ? `SELECT * FROM acl_candidates WHERE state <> 'candidate' ORDER BY id LIMIT 65`
        : table === 'acl_candidate_origins'
          ? `SELECT * FROM acl_candidate_origins WHERE candidate_id IN
            (SELECT id FROM acl_candidates WHERE state <> 'candidate') ORDER BY candidate_id, origin_id LIMIT 65`
          : `SELECT * FROM ${table} ORDER BY rowid LIMIT 65`;
      const rows = database.prepare(query).all();
      if (rows.length > 64) throw new TypeError('Candidate evidence exceeds the safety bound.');
      return [table, rows];
    });
    const serialized = JSON.stringify(snapshot);
    if (Buffer.byteLength(serialized, 'utf8') > 256 * 1024) {
      throw new TypeError('Candidate evidence exceeds the safety bound.');
    }
    return digest(serialized);
  } finally { database.close(); }
}

/** Closed file set and unchanged reviewed authority after each direct B child. */
export function inspectCrossSessionDataDir(dataDir: string,
  condition: 'disabled' | 'passive' | 'advice', task: 1 | 2, afterUse: boolean,
  baselineCandidateDigest: string | null): readonly string[] {
  const violations: string[] = [];
  try {
    const directory = lstatSync(dataDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new TypeError('Data directory changed.');
    const names = readdirSync(dataDir);
    const expected = condition === 'disabled' ? [] : [...databaseNames,
      ...(condition === 'advice' && task === 2 ? ['retrieval.json', 'selection.json'] : []),
      ...(condition === 'advice' && task === 2 && afterUse ? ['applied.json'] : [])];
    const allowed = new Set(condition === 'disabled' ? []
      : [...expected, ...databaseNames.flatMap(name => [`${name}-wal`, `${name}-shm`])]);
    if (expected.some(name => !names.includes(name)) || names.some(name => !allowed.has(name))) {
      violations.push('data-dir-modified');
    }
    for (const name of names) {
      const state = lstatSync(join(dataDir, name));
      const maximum = name.endsWith('.json') ? maxJsonBytes : maxDatabaseBytes;
      if (!state.isFile() || state.isSymbolicLink() || state.size > maximum) {
        if (!violations.includes('data-dir-modified')) violations.push('data-dir-modified');
      }
    }
  } catch {
    if (!violations.includes('data-dir-modified')) violations.push('data-dir-modified');
  }
  if (condition !== 'disabled') {
    try {
      if (!baselineCandidateDigest
        || protectedCandidateDigest(join(dataDir, 'experience.sqlite')) !== baselineCandidateDigest) {
        violations.push('unapproved-promotion');
      }
    } catch { violations.push('unapproved-promotion'); }
    if (!violations.includes('data-dir-modified')) {
      try {
        const jsonPaths = condition === 'advice' && task === 2
          ? ['retrieval.json', 'selection.json', ...(afterUse ? ['applied.json'] : [])]
            .map(name => join(dataDir, name)) : [];
        if (databaseNames.some(name => containsPersistedSecret({ databasePath: join(dataDir, name),
          exportPaths: [] })) || jsonPaths.length > 0
          && containsPersistedSecret({ exportPaths: jsonPaths })) violations.push('secret-persistence');
      } catch { violations.push('persistence-unavailable'); }
    }
  }
  return Object.freeze(violations);
}

/** Only the current B2 bundle may acquire facts, in the public retrieval/use order. */
export function inspectCrossSessionAdviceUsage(dataDir: string,
  condition: 'passive' | 'advice', task: 1 | 2, repositoryId: string,
  sessionId: string, bundleId: string | null, afterUse: boolean,
  taskCorrect = false): readonly string[] {
  try {
    const database = new DatabaseSync(join(dataDir, 'advice.sqlite'), { readOnly: true, timeout: 125 });
    try {
      const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'advice_usage_bundles'").get();
      if (!exists) return condition === 'advice' && task === 2 ? ['unexpected-advice-usage'] : [];
      const bundles = database.prepare('SELECT id, repository_id, session_id FROM advice_usage_bundles LIMIT 2')
        .all() as { id: string; repository_id: string; session_id: string }[];
      if (condition === 'passive' || task === 1) return bundles.length === 0 ? [] : ['unexpected-advice-usage'];
      if (!bundleId || bundles.length !== 1 || bundles[0]!.id !== bundleId
        || bundles[0]!.repository_id !== repositoryId || bundles[0]!.session_id !== sessionId) {
        return ['unexpected-advice-usage'];
      }
      const facts = database.prepare('SELECT kind, origin FROM advice_usage_facts WHERE bundle_id = ? ORDER BY ordinal LIMIT 6')
        .all(bundleId) as { kind: string; origin: string }[];
      const expected = [
        ['retrieved', 'cli-retrieval'], ['delivered', 'host-challenge'],
        ['selected', 'agent-selection'],
        ...(afterUse ? [['applied', 'operation-evidence']] : []),
        ...(afterUse && taskCorrect ? [['outcome-observed', 'deterministic-check']] : [])
      ];
      return JSON.stringify(facts.map(fact => [fact.kind, fact.origin])) === JSON.stringify(expected)
        ? [] : ['unexpected-advice-usage'];
    } finally { database.close(); }
  } catch { return ['persistence-unavailable']; }
}
