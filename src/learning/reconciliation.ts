import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { loadProjectSettings } from '../config/project-settings.js';
import { DETECTOR_SET_VERSION, OperationalLearningRepository } from './repository.js';

const MAX_SESSIONS = 100;
const PAGE_SIZE = 1024;

export interface ReconciliationOptions {
  readonly apply?: boolean;
  readonly afterSession?: string;
}

interface Selection {
  readonly sessionId: string;
  readonly highWater: number;
  readonly physicalCount: number;
  readonly status: 'missing' | 'current' | 'unavailable' | 'opted-out';
}

export function reconcileAnalysis(databasePath: string, repositoryId: string, options: ReconciliationOptions = {}) {
  if (typeof repositoryId !== 'string' || repositoryId.length === 0) throw new TypeError('Repository identity is required.');
  if (options.afterSession !== undefined && (typeof options.afterSession !== 'string' || options.afterSession.length === 0)) {
    throw new TypeError('Reconciliation cursor is invalid.');
  }
  if (!existsSync(databasePath)) throw new TypeError('Analysis database does not exist.');
  const db = new DatabaseSync(databasePath, { readOnly: true });
  let root: string;
  let rows: Array<{ id: string }>;
  let hasMore: boolean;
  let hasStreams: boolean;
  let hasAnnotations: boolean;
  let optedOut = false;
  const selections: Selection[] = [];
  try {
    const registration = db.prepare('SELECT repository_root FROM repositories WHERE repository_id = ?').get(repositoryId) as { repository_root: string } | undefined;
    if (!registration) throw new TypeError('Repository is not registered.');
    root = registration.repository_root;
    rows = db.prepare('SELECT id FROM sessions WHERE repository_id = ? AND id > ? ORDER BY id LIMIT ?')
      .all(repositoryId, options.afterSession ?? '', MAX_SESSIONS + 1) as Array<{ id: string }>;
    hasMore = rows.length > MAX_SESSIONS;
    rows = rows.slice(0, MAX_SESSIONS);
    hasStreams = (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'operational_analysis_streams'").get() as unknown) !== undefined;
    hasAnnotations = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'logical_annotation_evidence'").get() !== undefined;
    optedOut = loadProjectSettings(root).automaticOperationalLearning === false;
    for (const { id } of rows) {
      const physical = db.prepare(`SELECT
        (SELECT COUNT(*) FROM capture_events ce JOIN events e ON e.id = ce.event_id WHERE e.session_id = ?) +
        (SELECT COUNT(*) FROM capture_run_events WHERE conversation_id = ?) AS count`).get(id, id) as { count: number };
      const indexed = db.prepare('SELECT COUNT(*) AS count, MAX(ordinal) AS high_water FROM logical_evidence WHERE session_id = ?')
        .get(id) as { count: number; high_water: number | null };
      const aliases = db.prepare('SELECT COUNT(*) AS count FROM logical_evidence_conflicts WHERE session_id = ?').get(id) as { count: number };
      const unindexed = physical.count - indexed.count - aliases.count;
      const annotation = hasAnnotations ? db.prepare('SELECT COUNT(*) AS count, MAX(ordinal) AS high_water FROM logical_annotation_evidence WHERE session_id = ?')
        .get(id) as { count: number; high_water: number | null } : { count: 0, high_water: null };
      const highWater = Math.max(indexed.high_water ?? 0, annotation.high_water ?? 0);
      if (unindexed !== 0) {
        selections.push({ sessionId: id, highWater, physicalCount: physical.count, status: 'unavailable' });
        continue;
      }
      // Traverse the fixed logical range in bounded pages before declaring the input eligible.
      let cursor = 0;
      let traversed = 0;
      while (cursor < highWater) {
        const page = hasAnnotations ? db.prepare(`SELECT ordinal FROM (
          SELECT ordinal FROM logical_evidence WHERE session_id = ? AND ordinal > ? AND ordinal <= ?
          UNION ALL SELECT ordinal FROM logical_annotation_evidence WHERE session_id = ? AND ordinal > ? AND ordinal <= ?
        ) ORDER BY ordinal LIMIT ?`).all(id, cursor, highWater, id, cursor, highWater, PAGE_SIZE) as Array<{ ordinal: number }>
          : db.prepare('SELECT ordinal FROM logical_evidence WHERE session_id = ? AND ordinal > ? AND ordinal <= ? ORDER BY ordinal LIMIT ?')
            .all(id, cursor, highWater, PAGE_SIZE) as Array<{ ordinal: number }>;
        if (page.length === 0) break;
        traversed += page.length;
        cursor = page.at(-1)!.ordinal;
      }
      if (cursor !== highWater || traversed !== indexed.count + annotation.count) {
        selections.push({ sessionId: id, highWater, physicalCount: physical.count, status: 'unavailable' });
        continue;
      }
      const stream = hasStreams ? db.prepare(`SELECT committed_high_water, processed_high_water FROM operational_analysis_streams
        WHERE repository_id = ? AND session_id = ? AND detector_set_version = ?`).get(repositoryId, id, DETECTOR_SET_VERSION) as {
          committed_high_water: number; processed_high_water: number;
        } | undefined : undefined;
      if (stream && stream.committed_high_water >= highWater && stream.processed_high_water < highWater) {
        const active = db.prepare(`SELECT 1 FROM operational_analysis_jobs WHERE repository_id = ? AND session_id = ?
          AND detector_set_version = ? AND state IN ('pending', 'retryable-failure', 'running')`).get(repositoryId, id, DETECTOR_SET_VERSION);
        if (!active) {
          selections.push({ sessionId: id, highWater, physicalCount: physical.count, status: 'unavailable' });
          continue;
        }
      }
      const missing = highWater > 0 && (stream === undefined || stream.committed_high_water < highWater);
      selections.push({ sessionId: id, highWater, physicalCount: physical.count,
        status: missing ? optedOut && !options.apply ? 'opted-out' : 'missing' : 'current' });
    }
  } finally { db.close(); }

  let added = 0;
  let stale = 0;
  const overriddenSessionIds: string[] = [];
  if (options.apply && selections.some(({ status }) => status === 'missing')) {
    const repository = new OperationalLearningRepository(databasePath);
    try {
      for (const selected of selections.filter(({ status }) => status === 'missing')) {
        const current = new DatabaseSync(databasePath, { readOnly: true });
        let unchanged: boolean;
        try {
          const row = current.prepare(`SELECT
            (SELECT COUNT(*) FROM capture_events ce JOIN events e ON e.id = ce.event_id WHERE e.session_id = ?) +
            (SELECT COUNT(*) FROM capture_run_events WHERE conversation_id = ?) AS physical,
            (SELECT MAX(ordinal) FROM logical_evidence WHERE session_id = ?) AS high_water`)
            .get(selected.sessionId, selected.sessionId, selected.sessionId) as { physical: number; high_water: number | null };
          const annotationHighWater = hasAnnotations ? (current.prepare('SELECT MAX(ordinal) AS high_water FROM logical_annotation_evidence WHERE session_id = ?')
            .get(selected.sessionId) as { high_water: number | null }).high_water ?? 0 : 0;
          unchanged = row.physical === selected.physicalCount && Math.max(row.high_water ?? 0, annotationHighWater) === selected.highWater;
        } finally { current.close(); }
        if (!unchanged) { stale++; continue; }
        if (optedOut) {
          const audit = new DatabaseSync(databasePath);
          try {
            audit.exec(`CREATE TABLE IF NOT EXISTS analysis_reconciliation_overrides (
              repository_id TEXT NOT NULL, session_id TEXT NOT NULL, detector_set_version TEXT NOT NULL,
              input_high_water INTEGER NOT NULL, applied_at TEXT NOT NULL,
              PRIMARY KEY(repository_id, session_id, detector_set_version, input_high_water)
            ) STRICT`);
            audit.prepare(`INSERT OR IGNORE INTO analysis_reconciliation_overrides
              (repository_id, session_id, detector_set_version, input_high_water, applied_at) VALUES (?, ?, ?, ?, ?)`)
              .run(repositoryId, selected.sessionId, DETECTOR_SET_VERSION, selected.highWater, new Date().toISOString());
          } finally { audit.close(); }
        }
        if (repository.enqueueWithOutcome({ repositoryId, sessionId: selected.sessionId,
          detectorSetVersion: DETECTOR_SET_VERSION, inputHighWater: selected.highWater }).workAdded) {
          added++;
          if (optedOut) overriddenSessionIds.push(selected.sessionId);
        }
      }
    } finally { repository.close(); }
  }
  return Object.freeze({ version: 1 as const, repositoryId, detectorSetVersion: DETECTOR_SET_VERSION,
    preview: !options.apply, scanned: selections.length, missing: selections.filter(({ status }) => status === 'missing').length,
    unavailable: selections.filter(({ status }) => status === 'unavailable').length,
    optedOut: selections.filter(({ status }) => status === 'opted-out').length, added, stale,
    ...(overriddenSessionIds.length === 0 ? {} : { overrideScope: Object.freeze({ repositoryId,
      detectorSetVersion: DETECTOR_SET_VERSION, sessionIds: Object.freeze(overriddenSessionIds) }) }),
    ...(hasMore ? { nextCursor: rows.at(-1)!.id } : {}),
    sessions: Object.freeze(selections.map(({ sessionId, highWater, status }) => Object.freeze({ sessionId, highWater, status }))) });
}
