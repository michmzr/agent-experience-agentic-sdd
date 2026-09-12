import type { DatabaseSync } from 'node:sqlite';

import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import type {
  CandidateLesson,
  CandidateLessonId,
  ClusterId,
  Evidence,
  EvidenceId,
  Event,
  EventId,
  ExperienceImport,
  KnowledgeEntry,
  KnowledgeId,
  KnowledgeMetadata,
  KnowledgeState,
  ObservationId,
  Session,
  SessionId,
  TransitionHistoryEntry
} from '../domain/types.js';
import { applyTransition, reconcileImportedKnowledgeLifecycle } from '../domain/transitions.js';
import { validateImport, validateIncrementalEvidence } from '../domain/validation.js';
import type {
  CaptureEnforcementSnapshot,
  CaptureConversation,
  CaptureRun,
  CapturedEventRecord,
  IncrementalAppendResult,
  IncrementalCaptureAppend,
  LifecycleSignal,
  RecordedLifecycleSignal,
  RevalidationProposal
} from '../capture/contracts.js';
import { validateNormalizedCaptureEvent } from '../capture/normalization.js';
import { assertDurableTextSafe } from '../review/sanitizer.js';
import { openExperienceDatabase, type ExperienceDatabaseOptions } from './database.js';
import { ensureOverrideAuditUseMigration, ensureOverrideEvidenceMigration, overrideAuditMigration } from './override-store.js';

export type ExperienceStoreInitializationStage = 'open' | 'migration';

export class ExperienceStoreInitializationError extends Error {
  constructor(readonly stage: ExperienceStoreInitializationStage, cause: unknown) {
    super('Experience store initialization failed.', { cause });
    this.name = 'ExperienceStoreInitializationError';
  }
}

interface KnowledgeRow {
  id: string;
  candidate_id: string;
  state: KnowledgeEntry['state'];
  statement: string;
}

interface KnowledgeMetadataRow {
  knowledge_id: string;
  scope: KnowledgeScope;
  repository_id: string | null;
  path: string | null;
  tool: string | null;
  tags_json: string;
  created_at: string;
  approval_kind: string | null;
  approved_at: string | null;
  activation: string | null;
  merged_provenance: string | null;
}

interface SessionRow {
  id: string;
  source: Session['source'];
  started_at: string;
  ended_at: string | null;
  repository_id: string | null;
  workspace_id: string | null;
  user_id: string | null;
}

interface CaptureRow {
  sequence: number;
  event_id: string;
  source: CapturedEventRecord['source'];
  source_event_id: string;
  phase: CapturedEventRecord['phase'];
  signature_json: string;
  summary: string;
  capture_outcome: CapturedEventRecord['outcome'] | null;
  related_event_id: string | null;
  session_id: string;
  occurred_at: string;
  exit_status: number | null;
}

interface CandidateRow {
  sequence: number;
  id: string;
  cluster_id: string;
  kind: CandidateLesson['kind'];
  statement: string;
}

interface EvidenceRow {
  sequence: number;
  id: string;
  candidate_id: string;
  polarity: Evidence['polarity'];
  summary: string;
  revalidates_to: Evidence['revalidatesTo'] | null;
}

interface TransitionRow {
  sequence: number;
  from_state: KnowledgeState;
  to_state: KnowledgeState;
  evidence_id: string;
  occurred_at: string;
}

interface ProposalRow {
  sequence: number;
  id: string;
  knowledge_id: string;
  created_at: string;
  contradiction_count: number;
  status: 'proposed';
}

interface RepositoryRow {
  repository_id: string;
  repository_root: string;
  observed_at: string;
  selected_sources_json: string;
}

interface ConversationRow {
  id: string;
  source: Session['source'];
  first_receipt_at: string;
  identifier_provenance: 'hook-session-id';
}

interface CaptureRunRow {
  id: string;
  conversation_id: string;
  state: CaptureRun['state'];
  receipt_started_at: string;
  source_started_at: string | null;
  receipt_ended_at: string | null;
  source_ended_at: string | null;
}

interface LifecycleSignalRow {
  source: Session['source'];
  source_event_id: string;
  conversation_id: string;
  kind: LifecycleSignal['kind'];
  receipt_at: string;
  source_at: string | null;
  resolution: RecordedLifecycleSignal['resolution'];
  resolved_run_id: string | null;
}

export type KnowledgeScope = 'global' | 'repository';

export interface RepositoryRegistration {
  readonly id: string;
  readonly root: string;
  readonly observedAt: string;
  readonly selectedSources?: readonly ('codex' | 'cursor')[];
}

export interface RepositoryRecord { readonly session: Session; readonly events: readonly CapturedEventRecord[]; }
export interface RepositoryStatistics {
  readonly sessions: number; readonly events: number; readonly knowledge: number;
  readonly firstRecordedAt?: string; readonly lastRecordedAt?: string;
  readonly sources: Readonly<Record<Session['source'], number>>;
  readonly phases: Readonly<Record<CapturedEventRecord['phase'], number>>;
}

export interface RetrievalFilter {
  readonly scope?: KnowledgeScope;
  readonly repositoryId?: string;
  readonly path?: string;
  readonly tool?: string;
  readonly tags?: readonly string[];
  readonly state?: KnowledgeState;
}

export interface RetrievedKnowledgeEntry extends KnowledgeEntry {
  readonly authoritative: boolean;
}

export const MAX_INCREMENTAL_PAGE_SIZE = 100;

export interface IncrementalPageCursor {
  readonly afterSequence: number;
  readonly highWaterSequence: number;
}

export interface IncrementalPageRequest {
  readonly cursor?: IncrementalPageCursor;
  readonly limit?: number;
}

export interface IncrementalPage<T> {
  readonly entries: readonly T[];
  readonly nextCursor?: IncrementalPageCursor;
}

const schemaMigration = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at TEXT NOT NULL,
    repository_id TEXT, workspace_id TEXT, user_id TEXT
  );
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), kind TEXT NOT NULL,
    occurred_at TEXT NOT NULL, tool TEXT, path TEXT, outcome TEXT, exit_status REAL
  );
  CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, statement TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS observation_events (
    observation_id TEXT NOT NULL REFERENCES observations(id), event_id TEXT NOT NULL REFERENCES events(id),
    position INTEGER NOT NULL, PRIMARY KEY (observation_id, event_id), UNIQUE (observation_id, position)
  );
  CREATE TABLE IF NOT EXISTS clusters (id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS cluster_observations (
    cluster_id TEXT NOT NULL REFERENCES clusters(id), observation_id TEXT NOT NULL REFERENCES observations(id),
    position INTEGER NOT NULL, PRIMARY KEY (cluster_id, observation_id), UNIQUE (cluster_id, position)
  );
  CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL REFERENCES clusters(id), kind TEXT NOT NULL, statement TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id), polarity TEXT NOT NULL,
    summary TEXT NOT NULL, revalidates_to TEXT
  );
  CREATE TABLE IF NOT EXISTS knowledge (
    id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id), state TEXT NOT NULL, statement TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS knowledge_evidence (
    knowledge_id TEXT NOT NULL REFERENCES knowledge(id), evidence_id TEXT NOT NULL REFERENCES evidence(id),
    position INTEGER NOT NULL, PRIMARY KEY (knowledge_id, evidence_id), UNIQUE (knowledge_id, position)
  );
  CREATE TABLE IF NOT EXISTS knowledge_transition_history (
    id INTEGER PRIMARY KEY, knowledge_id TEXT NOT NULL REFERENCES knowledge(id), from_state TEXT NOT NULL,
    to_state TEXT NOT NULL, evidence_id TEXT NOT NULL REFERENCES evidence(id), occurred_at TEXT NOT NULL
  );
`;

const retrievalMigration = `
  CREATE TABLE IF NOT EXISTS knowledge_metadata (
    knowledge_id TEXT PRIMARY KEY REFERENCES knowledge(id),
    scope TEXT NOT NULL CHECK (scope IN ('global', 'repository')),
    repository_id TEXT,
    path TEXT,
    tool TEXT,
    tags_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    approval_kind TEXT,
    approved_at TEXT,
    activation TEXT,
    merged_provenance TEXT
  );
  CREATE TABLE IF NOT EXISTS observation_tombstones (
    observation_id TEXT PRIMARY KEY REFERENCES observations(id),
    tombstoned_at TEXT NOT NULL
  );
`;

const eventRetentionMigration = `
  CREATE TABLE IF NOT EXISTS event_tombstones (
    event_id TEXT PRIMARY KEY REFERENCES events(id),
    tombstoned_at TEXT NOT NULL
  );
`;

const eventMetadataMigration = `
  ALTER TABLE events ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
`;

const incrementalCaptureMigration = `
  CREATE TABLE IF NOT EXISTS capture_events (
    event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE RESTRICT,
    source TEXT NOT NULL CHECK (source IN ('codex', 'claude-code', 'cursor')),
    source_event_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('pre-intent', 'pre-action', 'post-result')),
    signature_json TEXT NOT NULL,
    summary TEXT NOT NULL,
    capture_outcome TEXT CHECK (capture_outcome IN ('succeeded', 'failed', 'unknown')),
    related_event_id TEXT,
    UNIQUE (source, source_event_id)
  );
  CREATE TABLE IF NOT EXISTS revalidation_proposals (
    id TEXT PRIMARY KEY,
    knowledge_id TEXT NOT NULL REFERENCES knowledge(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    contradiction_count INTEGER NOT NULL CHECK (contradiction_count >= 2),
    status TEXT NOT NULL CHECK (status = 'proposed'),
    UNIQUE (knowledge_id)
  );
`;

const captureEnforcementSnapshotMigration = `
  CREATE TABLE IF NOT EXISTS capture_enforcement_snapshots (
    event_id TEXT PRIMARY KEY REFERENCES capture_events(event_id) ON DELETE RESTRICT,
    input_binding TEXT NOT NULL,
    enforcing_references_json TEXT NOT NULL,
    override_references_json TEXT NOT NULL
  );
`;

const captureEffectBundleMigration = `
  CREATE TABLE IF NOT EXISTS capture_effect_bundles (
    event_id TEXT PRIMARY KEY REFERENCES capture_events(event_id) ON DELETE RESTRICT,
    bundle_hash TEXT NOT NULL
  );
`;

const sessionEndMigration = `
  ALTER TABLE sessions ADD COLUMN ended_at TEXT;
`;

const repositoryRegistryMigration = `
  CREATE TABLE IF NOT EXISTS repositories (
    repository_id TEXT PRIMARY KEY,
    repository_root TEXT NOT NULL,
    observed_at TEXT NOT NULL
  );
`;
const repositorySourcesMigration = `ALTER TABLE repositories ADD COLUMN selected_sources_json TEXT NOT NULL DEFAULT '[]';`;

const conversationLifecycleMigration = `
  CREATE TABLE IF NOT EXISTS capture_conversations (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN ('codex', 'claude-code', 'cursor')),
    first_receipt_at TEXT NOT NULL,
    identifier_provenance TEXT NOT NULL CHECK (identifier_provenance = 'hook-session-id')
  ) STRICT;
  CREATE TABLE IF NOT EXISTS capture_runs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES capture_conversations(id) ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK (state IN ('open', 'ended', 'unresolved')),
    receipt_started_at TEXT NOT NULL,
    source_started_at TEXT,
    receipt_ended_at TEXT,
    source_ended_at TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS lifecycle_signals (
    source TEXT NOT NULL CHECK (source IN ('codex', 'claude-code', 'cursor')),
    source_event_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES capture_conversations(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('start', 'end')),
    receipt_at TEXT NOT NULL,
    source_at TEXT,
    resolution TEXT NOT NULL CHECK (resolution IN ('resolved', 'unresolved')),
    resolved_run_id TEXT REFERENCES capture_runs(id) ON DELETE RESTRICT,
    PRIMARY KEY (source, source_event_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS capture_event_lifecycle (
    event_id TEXT PRIMARY KEY REFERENCES capture_events(event_id) ON DELETE RESTRICT,
    conversation_id TEXT NOT NULL REFERENCES capture_conversations(id) ON DELETE RESTRICT,
    run_id TEXT REFERENCES capture_runs(id) ON DELETE RESTRICT
  ) STRICT;
`;

export class ExperienceStore {
  private readonly database: DatabaseSync;

  constructor(databasePath?: string, options: ExperienceDatabaseOptions = {}) {
    let database: DatabaseSync;
    try {
      database = openExperienceDatabase(databasePath, options);
    } catch (error) {
      throw new ExperienceStoreInitializationError('open', error);
    }
    this.database = database;
    try {
      this.migrate();
    } catch (error) {
      try {
        database.close();
      } catch {
        // Preserve the migration failure if cleanup itself fails.
      }
      throw new ExperienceStoreInitializationError('migration', error);
    }
  }

  close(): void {
    this.database.close();
  }

  registerRepository(registration: RepositoryRegistration): void {
    if (!registration || typeof registration.id !== 'string' || !registration.id.trim()
      || typeof registration.root !== 'string' || !registration.root.trim()) {
      throw new TypeError('Repository registration requires an identifier and root.');
    }
    assertCanonicalTimestamp(registration.observedAt);
    const existing = this.database.prepare('SELECT selected_sources_json FROM repositories WHERE repository_id = ?').get(registration.id) as { selected_sources_json: string } | undefined;
    const selectedSources = [...new Set([...(existing ? JSON.parse(existing.selected_sources_json) as string[] : []), ...(registration.selectedSources ?? [])])].filter((source): source is 'codex' | 'cursor' => source === 'codex' || source === 'cursor').sort();
    this.database.prepare(`
      INSERT INTO repositories (repository_id, repository_root, observed_at, selected_sources_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(repository_id) DO UPDATE SET
        repository_root = excluded.repository_root,
        observed_at = excluded.observed_at,
        selected_sources_json = excluded.selected_sources_json
    `).run(registration.id, registration.root, registration.observedAt, JSON.stringify(selectedSources));
  }

  listRepositories(): readonly RepositoryRegistration[] {
    const rows = this.database.prepare(`
      SELECT repository_id, repository_root, observed_at, selected_sources_json FROM repositories ORDER BY repository_root
    `).all() as unknown as RepositoryRow[];
    return rows.map((row) => Object.freeze({
      id: row.repository_id,
      root: row.repository_root,
      observedAt: row.observed_at,
      selectedSources: JSON.parse(row.selected_sources_json) as readonly ('codex' | 'cursor')[]
    }));
  }

  unregisterRepository(repositoryId: string): boolean {
    if (typeof repositoryId !== 'string' || !repositoryId.trim()) throw new TypeError('Repository identifier is required.');
    return Number(this.database.prepare('DELETE FROM repositories WHERE repository_id = ?').run(repositoryId).changes) > 0;
  }

  listRepositoryRecords(repositoryId: string): readonly RepositoryRecord[] {
    const sessions = this.database.prepare(`SELECT id, source, started_at, ended_at, repository_id, workspace_id, user_id FROM sessions WHERE repository_id = ? ORDER BY started_at, id`).all(repositoryId) as unknown as SessionRow[];
    return sessions.map((row) => {
      const events = this.database.prepare(`SELECT ce.rowid AS sequence, ce.event_id, ce.source, ce.source_event_id, ce.phase, ce.signature_json, ce.summary, ce.capture_outcome, ce.related_event_id, e.session_id, e.occurred_at, e.exit_status FROM capture_events ce JOIN events e ON e.id = ce.event_id WHERE e.session_id = ? ORDER BY e.occurred_at, ce.rowid`).all(row.id) as unknown as CaptureRow[];
      return Object.freeze({ session: sessionFromRow(row), events: events.map(captureFromRow) });
    });
  }

  repositoryStats(repositoryId: string): RepositoryStatistics {
    const count = (sql: string, value?: string) => Number((this.database.prepare(sql).get(...(value === undefined ? [] : [value])) as { count: number }).count);
    const sessions = count('SELECT COUNT(*) AS count FROM sessions WHERE repository_id = ?', repositoryId);
    const events = count('SELECT COUNT(*) AS count FROM capture_events ce JOIN events e ON e.id = ce.event_id JOIN sessions s ON s.id = e.session_id WHERE s.repository_id = ?', repositoryId);
    const knowledge = count('SELECT COUNT(*) AS count FROM knowledge_metadata WHERE repository_id = ?', repositoryId);
    const bounds = this.database.prepare(`SELECT MIN(value) AS first, MAX(value) AS last FROM (SELECT started_at AS value FROM sessions WHERE repository_id = ? UNION ALL SELECT e.occurred_at AS value FROM events e JOIN sessions s ON s.id = e.session_id WHERE s.repository_id = ?)`).get(repositoryId, repositoryId) as { first: string | null; last: string | null };
    const sourceRows = this.database.prepare('SELECT source, COUNT(*) AS count FROM sessions WHERE repository_id = ? GROUP BY source').all(repositoryId) as Array<{ source: Session['source']; count: number }>;
    const phaseRows = this.database.prepare('SELECT ce.phase, COUNT(*) AS count FROM capture_events ce JOIN events e ON e.id = ce.event_id JOIN sessions s ON s.id = e.session_id WHERE s.repository_id = ? GROUP BY ce.phase').all(repositoryId) as Array<{ phase: CapturedEventRecord['phase']; count: number }>;
    const sources = { codex: 0, cursor: 0, 'claude-code': 0 }; for (const row of sourceRows) sources[row.source] = row.count;
    const phases = { 'pre-intent': 0, 'pre-action': 0, 'post-result': 0 }; for (const row of phaseRows) phases[row.phase] = row.count;
    return Object.freeze({ sessions, events, knowledge, ...(bounds.first ? { firstRecordedAt: bounds.first } : {}), ...(bounds.last ? { lastRecordedAt: bounds.last } : {}), sources: Object.freeze(sources), phases: Object.freeze(phases) });
  }

  loadSession(id: SessionId): Session | undefined {
    const row = this.database.prepare(`
      SELECT id, source, started_at, ended_at, repository_id, workspace_id, user_id
      FROM sessions WHERE id = ?
    `).get(id) as unknown as SessionRow | undefined;
    return row === undefined ? undefined : sessionFromRow(row);
  }

  loadCapturedSession(id: SessionId): RepositoryRecord | undefined {
    const session = this.loadSession(id);
    if (session === undefined) return undefined;
    const rows = this.database.prepare(`
      SELECT ce.rowid AS sequence, ce.event_id, ce.source, ce.source_event_id, ce.phase, ce.signature_json, ce.summary,
        ce.capture_outcome, ce.related_event_id, e.session_id, e.occurred_at, e.exit_status
      FROM capture_events ce JOIN events e ON e.id = ce.event_id
      WHERE e.session_id = ? ORDER BY e.occurred_at, ce.rowid
    `).all(id) as unknown as CaptureRow[];
    return Object.freeze({ session, events: Object.freeze(rows.map(captureFromRow)) });
  }

  endSession(source: Session['source'], id: SessionId, endedAt: string): IncrementalAppendResult {
    assertCanonicalTimestamp(endedAt);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.loadSession(id);
      if (current === undefined) throw new TypeError('Cannot end a missing session.');
      if (current.source !== source) throw new TypeError('Session end source conflicts with the stored session.');
      if (Date.parse(endedAt) < Date.parse(current.startedAt)) throw new TypeError('Session end cannot precede its start.');
      const eventRows = this.database.prepare('SELECT occurred_at FROM events WHERE session_id = ?').all(id) as Array<{ occurred_at: string }>;
      const latestEventAt = eventRows.reduce<string | undefined>((latest, row) => {
        if (latest === undefined || Date.parse(row.occurred_at) > Date.parse(latest)) return row.occurred_at;
        return latest;
      }, undefined);
      if (latestEventAt !== undefined && Date.parse(endedAt) < Date.parse(latestEventAt)) {
        throw new TypeError('Session end cannot precede its latest event.');
      }
      if (current.endedAt !== undefined) {
        if (current.endedAt !== endedAt) throw new TypeError('Conflicting duplicate session end.');
        this.database.exec('COMMIT');
        return Object.freeze({ inserted: false });
      }
      this.database.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(endedAt, id);
      this.database.exec('COMMIT');
      return Object.freeze({ inserted: true });
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  reopenSession(source: Session['source'], id: SessionId): IncrementalAppendResult {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.loadSession(id);
      if (current === undefined) throw new TypeError('Cannot resume a missing session.');
      if (current.source !== source) throw new TypeError('Session resume source conflicts with the stored session.');
      if (current.endedAt === undefined) {
        this.database.exec('COMMIT');
        return Object.freeze({ inserted: false });
      }
      this.database.prepare('UPDATE sessions SET ended_at = NULL WHERE id = ?').run(id);
      this.database.exec('COMMIT');
      return Object.freeze({ inserted: true });
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  recordLifecycleSignal(signal: LifecycleSignal): IncrementalAppendResult {
    assertLifecycleSignal(signal);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const conversation = this.database.prepare('SELECT id, source, first_receipt_at, identifier_provenance FROM capture_conversations WHERE id = ?').get(signal.conversationId) as ConversationRow | undefined;
      if (conversation === undefined) {
        this.database.prepare(`INSERT INTO capture_conversations (id, source, first_receipt_at, identifier_provenance)
          VALUES (?, ?, ?, 'hook-session-id')`).run(signal.conversationId, signal.source, signal.receiptAt);
      } else if (conversation.source !== signal.source) {
        throw new TypeError('Lifecycle conversation source conflicts with the stored conversation.');
      }
      const duplicate = this.database.prepare(`SELECT source, source_event_id, conversation_id, kind, receipt_at, source_at, resolution, resolved_run_id
        FROM lifecycle_signals WHERE source = ? AND source_event_id = ?`).get(signal.source, signal.sourceEventId) as LifecycleSignalRow | undefined;
      if (duplicate !== undefined) {
        if (duplicate.conversation_id !== signal.conversationId || duplicate.kind !== signal.kind || duplicate.receipt_at !== signal.receiptAt || duplicate.source_at !== (signal.sourceAt ?? null)) {
          throw new TypeError('Conflicting duplicate lifecycle signal identity.');
        }
        this.database.exec('COMMIT');
        return Object.freeze({ inserted: false });
      }

      const openRuns = this.database.prepare(`SELECT id, conversation_id, state, receipt_started_at, source_started_at, receipt_ended_at, source_ended_at
      FROM capture_runs WHERE conversation_id = ? AND state = 'open' ORDER BY receipt_started_at, id`).all(signal.conversationId) as unknown as CaptureRunRow[];
      let resolution: RecordedLifecycleSignal['resolution'] = 'unresolved';
      let resolvedRunId: string | undefined;
      if (signal.kind === 'start' && openRuns.length === 0) {
        const runId = `${signal.conversationId}:run:${this.nextRunOrdinal(signal.conversationId)}`;
        this.database.prepare(`INSERT INTO capture_runs (id, conversation_id, state, receipt_started_at, source_started_at, receipt_ended_at, source_ended_at)
          VALUES (?, ?, 'open', ?, ?, NULL, NULL)`).run(runId, signal.conversationId, signal.receiptAt, signal.sourceAt ?? null);
        resolution = 'resolved';
        resolvedRunId = runId;
      } else if (signal.kind === 'end' && openRuns.length === 1 && sourceTimeDoesNotPrecedeRun(signal, openRuns[0]!)) {
        const run = openRuns[0]!;
        this.database.prepare(`UPDATE capture_runs SET state = 'ended', receipt_ended_at = ?, source_ended_at = ? WHERE id = ?`)
          .run(signal.receiptAt, signal.sourceAt ?? null, run.id);
        resolution = 'resolved';
        resolvedRunId = run.id;
      }
      this.database.prepare(`INSERT INTO lifecycle_signals
        (source, source_event_id, conversation_id, kind, receipt_at, source_at, resolution, resolved_run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(signal.source, signal.sourceEventId, signal.conversationId, signal.kind, signal.receiptAt, signal.sourceAt ?? null, resolution, resolvedRunId ?? null);
      this.database.exec('COMMIT');
      return Object.freeze({ inserted: true });
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  loadConversation(id: string): CaptureConversation | undefined {
    const row = this.database.prepare('SELECT id, source, first_receipt_at, identifier_provenance FROM capture_conversations WHERE id = ?').get(id) as ConversationRow | undefined;
    return row === undefined ? undefined : conversationFromRow(row);
  }

  listConversationRuns(conversationId: string): readonly CaptureRun[] {
    const rows = this.database.prepare(`SELECT id, conversation_id, state, receipt_started_at, source_started_at, receipt_ended_at, source_ended_at
      FROM capture_runs WHERE conversation_id = ? ORDER BY receipt_started_at, id`).all(conversationId) as unknown as CaptureRunRow[];
    return Object.freeze(rows.map(captureRunFromRow));
  }

  listLifecycleSignals(conversationId: string): readonly RecordedLifecycleSignal[] {
    const rows = this.database.prepare(`SELECT source, source_event_id, conversation_id, kind, receipt_at, source_at, resolution, resolved_run_id
      FROM lifecycle_signals WHERE conversation_id = ? ORDER BY receipt_at, rowid`).all(conversationId) as unknown as LifecycleSignalRow[];
    return Object.freeze(rows.map(lifecycleSignalFromRow));
  }

  conversationForLegacySession(sessionId: SessionId): CaptureConversation | undefined {
    return this.loadConversation(sessionId);
  }

  import(record: ExperienceImport): void {
    const validation = validateImport(record);
    if (!validation.ok) throw new Error(`${validation.code}: ${validation.message}`);
    this.validateMetadata(record);

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const sessions = this.database.prepare('INSERT INTO sessions (id, source, started_at, ended_at, repository_id, workspace_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const item of record.sessions) sessions.run(item.id, item.source, item.startedAt, item.endedAt ?? null, item.repositoryId ?? null, item.workspaceId ?? null, item.userId ?? null);
      const events = this.database.prepare('INSERT INTO events (id, session_id, kind, occurred_at, tool, path, tags_json, outcome, exit_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const item of record.events) events.run(item.id, item.sessionId, item.kind, item.occurredAt, item.tool ?? null, item.path ?? null, JSON.stringify(normalizeTags(item.tags ?? [])), item.outcome ?? null, item.exitStatus ?? null);
      const observations = this.database.prepare('INSERT INTO observations (id, statement) VALUES (?, ?)');
      const observationEvents = this.database.prepare('INSERT INTO observation_events (observation_id, event_id, position) VALUES (?, ?, ?)');
      for (const item of record.observations) {
        observations.run(item.id, item.statement);
        item.eventIds.forEach((eventId, position) => observationEvents.run(item.id, eventId, position));
      }
      const clusters = this.database.prepare('INSERT INTO clusters (id) VALUES (?)');
      const clusterObservations = this.database.prepare('INSERT INTO cluster_observations (cluster_id, observation_id, position) VALUES (?, ?, ?)');
      for (const item of record.clusters) {
        clusters.run(item.id);
        item.observationIds.forEach((observationId, position) => clusterObservations.run(item.id, observationId, position));
      }
      const candidates = this.database.prepare('INSERT INTO candidates (id, cluster_id, kind, statement) VALUES (?, ?, ?, ?)');
      for (const item of record.candidates) candidates.run(item.id, item.clusterId, item.kind, item.statement);
      const evidence = this.database.prepare('INSERT INTO evidence (id, candidate_id, polarity, summary, revalidates_to) VALUES (?, ?, ?, ?, ?)');
      for (const item of record.evidence) evidence.run(item.id, item.candidateId, item.polarity, item.summary, item.revalidatesTo ?? null);
      const knowledge = this.database.prepare('INSERT INTO knowledge (id, candidate_id, state, statement) VALUES (?, ?, ?, ?)');
      const knowledgeEvidence = this.database.prepare('INSERT INTO knowledge_evidence (knowledge_id, evidence_id, position) VALUES (?, ?, ?)');
      const lifecycleHistory = this.database.prepare('INSERT INTO knowledge_transition_history (knowledge_id, from_state, to_state, evidence_id, occurred_at) VALUES (?, ?, ?, ?, ?)');
      for (const item of record.knowledge) {
        const lifecycle = reconcileImportedKnowledgeLifecycle(
          item,
          item.evidenceIds.map((evidenceId) => record.evidence.find((evidence) => evidence.id === evidenceId)!)
        );
        knowledge.run(item.id, item.candidateId, lifecycle.entry.state, item.statement);
        item.evidenceIds.forEach((evidenceId, position) => knowledgeEvidence.run(item.id, evidenceId, position));
        for (const transition of lifecycle.history) {
          lifecycleHistory.run(item.id, transition.from, transition.to, transition.evidenceId, new Date().toISOString());
        }
      }
      const metadata = this.database.prepare('INSERT INTO knowledge_metadata (knowledge_id, scope, repository_id, path, tool, tags_json, created_at, approval_kind, approved_at, activation, merged_provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const item of record.knowledge) {
        const value = this.resolveMetadata(item.id, record, record.knowledgeMetadata?.[item.id]);
        metadata.run(item.id, value.scope, value.repositoryId ?? null, value.path ? normalizePath(value.path) : null, value.tool ?? null, JSON.stringify([...new Set(value.tags ?? [])].sort()), value.createdAt, value.approvalKind ?? null, value.approvedAt ?? null, value.activation ?? null, value.mergedProvenance ?? null);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  appendIncremental(input: IncrementalCaptureAppend): IncrementalAppendResult {
    if (!input || typeof input !== 'object') throw new TypeError('Incremental append must be an object.');
    assertOnlyIncrementalKeys(input as unknown as Record<string, unknown>, ['session', 'event', 'enforcementSnapshot', 'candidate', 'evidence', 'transition', 'evidenceUpdates']);
    assertIncrementalEffectGrammar(input);
    if (input.session !== undefined) assertIncrementalSession(input.session);
    if (input.candidate !== undefined) assertIncrementalCandidateResources(input.candidate);
    if (input.evidence !== undefined) assertIncrementalEvidenceResources(input.evidence);
    if (input.transition !== undefined) assertIncrementalTransition(input.transition);
    if (input.evidenceUpdates !== undefined) {
      if (!Array.isArray(input.evidenceUpdates) || input.evidenceUpdates.length < 1 || input.evidenceUpdates.length > 256) throw new TypeError('Incremental evidence update limit exceeded.');
      for (const update of input.evidenceUpdates) {
        assertOnlyIncrementalKeys(update as unknown as Record<string, unknown>, ['evidence', 'transition']);
        assertIncrementalEvidenceResources(update.evidence);
        assertIncrementalTransition(update.transition);
      }
    }
    if (input.candidate !== undefined && input.event === undefined) throw new TypeError('Candidate capture requires its source event.');
    if (input.enforcementSnapshot !== undefined && input.event?.phase !== 'pre-action') throw new TypeError('Enforcement snapshot requires its pre-action event.');

    this.database.exec('BEGIN IMMEDIATE');
    try {
      let sessionInserted = false;
      let appendedEvent: CapturedEventRecord | undefined;
      let inserted = false;
      if (input.event !== undefined) {
        const event = validateNormalizedCaptureEvent(input.event);
        this.insertSession(input.session, event);
        const duplicate = this.captureByIdentity(event.source, event.sourceEventId);
        if (duplicate !== undefined) {
          if (JSON.stringify(duplicate) !== JSON.stringify(event)) throw new TypeError('Conflicting duplicate source-event identity.');
        } else {
          this.assertPostResultLink(event);
          this.insertCaptureEvent(event);
          this.linkCaptureEventToLifecycle(event);
          inserted = true;
        }
        if (duplicate !== undefined) this.assertPostResultLink(event);
        if (event.phase !== 'post-result' && (input.candidate !== undefined || input.evidence !== undefined || (input.evidenceUpdates?.length ?? 0) > 0)) {
          throw new TypeError('Captured event lifecycle mutation requires a post-result event.');
        }
        appendedEvent = event;
        if (input.enforcementSnapshot !== undefined) inserted = this.insertOrVerifyEnforcementSnapshot(event, input.enforcementSnapshot) || inserted;
        this.assertPostResultEffects(event, input);
        inserted = this.insertOrVerifyEffectBundle(event, input) || inserted;
      } else if (input.session !== undefined) {
        sessionInserted = this.insertOrVerifySession(input.session);
      }

      if (input.candidate !== undefined) inserted = this.insertCandidateCapture(input.event!, input.candidate) || inserted;
      if (input.evidence !== undefined) {
        assertTransitionAfterEvent(appendedEvent, input.transition);
        inserted = this.insertIncrementalEvidence(input.evidence, input.transition) || inserted;
      }
      for (const update of input.evidenceUpdates ?? []) {
        assertTransitionAfterEvent(appendedEvent, update.transition);
        inserted = this.insertIncrementalEvidence(update.evidence, update.transition) || inserted;
      }
      this.database.exec('COMMIT');
      return Object.freeze({ inserted: inserted || sessionInserted });
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  listCapturedEventsPage(request: IncrementalPageRequest = {}): IncrementalPage<CapturedEventRecord> {
    const page = checkedPageRequest(request, this.captureHighWater());
    const rows = this.database.prepare(`
      SELECT ce.rowid AS sequence, ce.event_id, ce.source, ce.source_event_id, ce.phase, ce.signature_json, ce.summary,
        ce.capture_outcome, ce.related_event_id, e.session_id, e.occurred_at, e.exit_status
      FROM capture_events ce JOIN events e ON e.id = ce.event_id
      WHERE ce.rowid > ? AND ce.rowid <= ? ORDER BY ce.rowid LIMIT ?
    `).all(page.afterSequence, page.highWaterSequence, page.limit + 1) as unknown as CaptureRow[];
    return pageResult(rows, page, captureFromRow);
  }

  loadCaptureEnforcementSnapshot(source: CapturedEventRecord['source'], sourceEventId: string): CaptureEnforcementSnapshot | undefined {
    const row = this.database.prepare(`
      SELECT s.input_binding, s.enforcing_references_json, s.override_references_json
      FROM capture_enforcement_snapshots s JOIN capture_events ce ON ce.event_id = s.event_id
      WHERE ce.source = ? AND ce.source_event_id = ?
    `).get(source, sourceEventId) as { input_binding: string; enforcing_references_json: string; override_references_json: string } | undefined;
    if (row === undefined) return undefined;
    return checkedEnforcementSnapshot({
      inputBinding: row.input_binding,
      enforcingReferences: JSON.parse(row.enforcing_references_json) as unknown,
      overrideReferences: JSON.parse(row.override_references_json) as unknown
    });
  }

  listCandidatesPage(request: IncrementalPageRequest = {}): IncrementalPage<CandidateLesson> {
    const page = checkedPageRequest(request, tableHighWater(this.database, 'candidates'));
    const rows = this.database.prepare('SELECT rowid AS sequence, id, cluster_id, kind, statement FROM candidates WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?')
      .all(page.afterSequence, page.highWaterSequence, page.limit + 1) as unknown as CandidateRow[];
    return pageResult(rows, page, (row) => Object.freeze({ id: row.id as CandidateLessonId, clusterId: row.cluster_id as ClusterId, kind: row.kind, statement: row.statement }));
  }

  listEvidencePage(request: IncrementalPageRequest = {}): IncrementalPage<Evidence> {
    const page = checkedPageRequest(request, tableHighWater(this.database, 'evidence'));
    const rows = this.database.prepare('SELECT rowid AS sequence, id, candidate_id, polarity, summary, revalidates_to FROM evidence WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?')
      .all(page.afterSequence, page.highWaterSequence, page.limit + 1) as unknown as EvidenceRow[];
    return pageResult(rows, page, evidenceFromRow);
  }

  listTransitionHistoryPage(knowledgeId: string, request: IncrementalPageRequest = {}): IncrementalPage<TransitionHistoryEntry> {
    if (!canonicalIncrementalIdentifier.test(knowledgeId)) throw new RangeError('Transition history knowledge id is invalid.');
    const highWater = (this.database.prepare('SELECT COALESCE(MAX(id), 0) AS high_water FROM knowledge_transition_history WHERE knowledge_id = ?').get(knowledgeId) as { high_water: number }).high_water;
    const page = checkedPageRequest(request, highWater);
    const rows = this.database.prepare(`
      SELECT id AS sequence, from_state, to_state, evidence_id, occurred_at
      FROM knowledge_transition_history WHERE knowledge_id = ? AND id > ? AND id <= ? ORDER BY id LIMIT ?
    `).all(knowledgeId, page.afterSequence, page.highWaterSequence, page.limit + 1) as unknown as TransitionRow[];
    return pageResult(rows, page, (row) => Object.freeze({
      from: row.from_state, to: row.to_state, evidenceId: row.evidence_id as EvidenceId, occurredAt: row.occurred_at
    }));
  }

  listRevalidationProposalsPage(request: IncrementalPageRequest = {}): IncrementalPage<RevalidationProposal> {
    const page = checkedPageRequest(request, tableHighWater(this.database, 'revalidation_proposals'));
    const rows = this.database.prepare('SELECT rowid AS sequence, id, knowledge_id, created_at, contradiction_count, status FROM revalidation_proposals WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?')
      .all(page.afterSequence, page.highWaterSequence, page.limit + 1) as unknown as ProposalRow[];
    return pageResult(rows, page, (row) => Object.freeze({ id: row.id, knowledgeId: row.knowledge_id, createdAt: row.created_at, contradictionCount: row.contradiction_count, status: row.status }));
  }

  inspect(id: KnowledgeId): KnowledgeEntry | undefined {
    const row = this.database.prepare('SELECT id, candidate_id, state, statement FROM knowledge WHERE id = ?').get(id) as KnowledgeRow | undefined;
    return row ? this.toKnowledgeEntry(row) : undefined;
  }

  listKnowledge(): KnowledgeEntry[] {
    const rows = this.database.prepare('SELECT id, candidate_id, state, statement FROM knowledge ORDER BY id').all() as unknown as KnowledgeRow[];
    return rows.map((row) => this.toKnowledgeEntry(row));
  }

  retrieve(filter: RetrievalFilter): RetrievedKnowledgeEntry[] {
    if (filter.scope === 'repository' && !filter.repositoryId) return [];

    const rows = this.database.prepare(`
      SELECT k.id, k.candidate_id, k.state, k.statement,
        m.knowledge_id, m.scope, m.repository_id, m.path, m.tool, m.tags_json, m.created_at,
        m.approval_kind, m.approved_at, m.activation, m.merged_provenance
      FROM knowledge k
      JOIN knowledge_metadata m ON m.knowledge_id = k.id
    `).all() as unknown as Array<KnowledgeRow & KnowledgeMetadataRow>;

    const normalizedPath = filter.path ? normalizePath(filter.path) : undefined;
    return rows
      .filter((row) => this.matchesFilter(row, filter, normalizedPath))
      .map((row) => ({ entry: this.toKnowledgeEntry(row), metadata: row, score: this.matchScore(row, filter, normalizedPath) }))
      .sort((left, right) => right.score - left.score || right.metadata.created_at.localeCompare(left.metadata.created_at) || left.entry.id.localeCompare(right.entry.id))
      .map(({ entry, metadata }) => ({ ...entry, authoritative: this.isAuthoritative(metadata) }));
  }

  expireUnprotected(now: string): number {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const candidates = this.database.prepare(`
        SELECT o.id
        FROM observations o
        LEFT JOIN observation_tombstones t ON t.observation_id = o.id
        WHERE t.observation_id IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM cluster_observations co
            JOIN candidates c ON c.cluster_id = co.cluster_id
            JOIN knowledge k ON k.candidate_id = c.id
            WHERE co.observation_id = o.id
              AND k.state IN ('candidate', 'observed', 'confirmed', 'verified', 'disputed')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM cluster_observations co
            JOIN candidates c ON c.cluster_id = co.cluster_id
            JOIN knowledge_transition_history h ON h.knowledge_id IN (
              SELECT k.id FROM knowledge k WHERE k.candidate_id = c.id
            )
            WHERE co.observation_id = o.id
          )
      `).all() as Array<{ id: string }>;
      const tombstone = this.database.prepare('INSERT INTO observation_tombstones (observation_id, tombstoned_at) VALUES (?, ?)');
      for (const observation of candidates) tombstone.run(observation.id, now);
      const expired = this.database.prepare(`
        SELECT t.observation_id AS id
        FROM observation_tombstones t
        WHERE t.tombstoned_at < ?
          AND NOT EXISTS (
            SELECT 1
            FROM cluster_observations co
            JOIN candidates c ON c.cluster_id = co.cluster_id
            JOIN knowledge k ON k.candidate_id = c.id
            WHERE co.observation_id = t.observation_id
              AND k.state IN ('candidate', 'observed', 'confirmed', 'verified', 'disputed')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM cluster_observations co
            JOIN candidates c ON c.cluster_id = co.cluster_id
            JOIN knowledge_transition_history h ON h.knowledge_id IN (
              SELECT k.id FROM knowledge k WHERE k.candidate_id = c.id
            )
            WHERE co.observation_id = t.observation_id
          )
      `).all(now) as Array<{ id: string }>;
      const removeClusterReference = this.database.prepare('DELETE FROM cluster_observations WHERE observation_id = ?');
      const removeEventReference = this.database.prepare('DELETE FROM observation_events WHERE observation_id = ?');
      const removeTombstone = this.database.prepare('DELETE FROM observation_tombstones WHERE observation_id = ?');
      const removeObservation = this.database.prepare('DELETE FROM observations WHERE id = ?');
      for (const observation of expired) {
        removeClusterReference.run(observation.id);
        removeEventReference.run(observation.id);
        removeTombstone.run(observation.id);
        removeObservation.run(observation.id);
      }
      const eventCandidates = this.database.prepare(`
        SELECT e.id
        FROM events e
        LEFT JOIN event_tombstones t ON t.event_id = e.id
        WHERE t.event_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM observation_events oe WHERE oe.event_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM capture_events ce WHERE ce.event_id = e.id)
      `).all() as Array<{ id: string }>;
      const tombstoneEvent = this.database.prepare('INSERT INTO event_tombstones (event_id, tombstoned_at) VALUES (?, ?)');
      for (const event of eventCandidates) tombstoneEvent.run(event.id, now);
      const expiredEvents = this.database.prepare(`
        SELECT t.event_id AS id
        FROM event_tombstones t
        WHERE t.tombstoned_at < ?
          AND NOT EXISTS (SELECT 1 FROM observation_events oe WHERE oe.event_id = t.event_id)
          AND NOT EXISTS (SELECT 1 FROM capture_events ce WHERE ce.event_id = t.event_id)
      `).all(now) as Array<{ id: string }>;
      const removeEventTombstone = this.database.prepare('DELETE FROM event_tombstones WHERE event_id = ?');
      const removeEvent = this.database.prepare('DELETE FROM events WHERE id = ?');
      for (const event of expiredEvents) {
        removeEventTombstone.run(event.id);
        removeEvent.run(event.id);
      }
      this.database.exec('COMMIT');
      return candidates.length + expired.length + eventCandidates.length + expiredEvents.length;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private migrate(): void {
    this.database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const applied = new Set((this.database.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(({ version }) => version));
      if (!applied.has(1)) {
        this.database.exec(schemaMigration);
        this.database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
      }
      if (!applied.has(2)) {
        this.database.exec(retrievalMigration);
        this.database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(2, new Date().toISOString());
      }
      if (!applied.has(3)) {
        this.database.exec(eventRetentionMigration);
        this.database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(3, new Date().toISOString());
      }
      if (!applied.has(4)) {
        this.database.exec(eventMetadataMigration);
        this.database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(4, new Date().toISOString());
      }
      if (!applied.has(5)) {
        this.database.exec(overrideAuditMigration);
        this.database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(5, new Date().toISOString());
      }
      if (!applied.has(6)) {
        ensureOverrideAuditUseMigration(this.database);
        this.database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(6, new Date().toISOString());
      } else {
        ensureOverrideAuditUseMigration(this.database);
      }
      if (!applied.has(7)) {
        ensureOverrideEvidenceMigration(this.database);
        this.database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(7, new Date().toISOString());
      } else {
        ensureOverrideEvidenceMigration(this.database);
      }
      if (!applied.has(8)) {
        this.database.exec(incrementalCaptureMigration);
        this.database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(8, new Date().toISOString());
      }
      if (!applied.has(9)) {
        this.database.exec(captureEnforcementSnapshotMigration);
        this.database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(9, new Date().toISOString());
      }
      if (!applied.has(10)) {
        this.database.exec(captureEffectBundleMigration);
        this.database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(10, new Date().toISOString());
      }
      if (!applied.has(11)) {
        this.database.exec(sessionEndMigration);
        this.database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(11, new Date().toISOString());
      }
      if (!applied.has(12)) {
        this.database.exec(repositoryRegistryMigration);
        this.database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(12, new Date().toISOString());
      }
      if (!applied.has(13)) { this.database.exec(repositorySourcesMigration); this.database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(13, new Date().toISOString()); }
      if (!applied.has(14)) {
        this.database.exec(conversationLifecycleMigration);
        this.database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(14, new Date().toISOString());
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private toKnowledgeEntry(row: KnowledgeRow): KnowledgeEntry {
    const evidenceRows = this.database.prepare('SELECT evidence_id FROM knowledge_evidence WHERE knowledge_id = ? ORDER BY position').all(row.id) as Array<{ evidence_id: string }>;
    return {
      id: row.id as KnowledgeId,
      candidateId: row.candidate_id as KnowledgeEntry['candidateId'],
      evidenceIds: evidenceRows.map((item) => item.evidence_id as KnowledgeEntry['evidenceIds'][number]),
      state: row.state,
      statement: row.statement
    };
  }

  private captureByIdentity(source: CapturedEventRecord['source'], sourceEventId: string): CapturedEventRecord | undefined {
    const row = this.database.prepare(`
      SELECT ce.rowid AS sequence, ce.event_id, ce.source, ce.source_event_id, ce.phase, ce.signature_json, ce.summary,
        ce.capture_outcome, ce.related_event_id, e.session_id, e.occurred_at, e.exit_status
      FROM capture_events ce JOIN events e ON e.id = ce.event_id
      WHERE ce.source = ? AND ce.source_event_id = ?
    `).get(source, sourceEventId) as unknown as CaptureRow | undefined;
    return row === undefined ? undefined : captureFromRow(row);
  }

  private nextRunOrdinal(conversationId: string): number {
    return Number((this.database.prepare('SELECT COUNT(*) AS count FROM capture_runs WHERE conversation_id = ?').get(conversationId) as { count: number }).count) + 1;
  }

  private linkCaptureEventToLifecycle(event: CapturedEventRecord): void {
    const conversation = this.database.prepare('SELECT id FROM capture_conversations WHERE id = ? AND source = ?').get(event.sessionId, event.source) as { id: string } | undefined;
    if (conversation === undefined) return;
    const run = this.database.prepare(`SELECT id FROM capture_runs WHERE conversation_id = ? AND state = 'open'
      ORDER BY receipt_started_at DESC, id DESC LIMIT 1`).get(conversation.id) as { id: string } | undefined;
    this.database.prepare(`INSERT OR IGNORE INTO capture_event_lifecycle (event_id, conversation_id, run_id) VALUES (?, ?, ?)`)
      .run(event.id, conversation.id, run?.id ?? null);
  }

  private insertSession(session: Session | undefined, event: CapturedEventRecord): void {
    if (session !== undefined && (session.id !== event.sessionId || session.source !== event.source)) {
      throw new TypeError('Capture session does not match normalized event provenance.');
    }
    const existing = this.database.prepare('SELECT id, source, started_at, ended_at, repository_id, workspace_id, user_id FROM sessions WHERE id = ?').get(event.sessionId) as unknown as SessionRow | undefined;
    if (existing === undefined) {
      if (session === undefined) throw new TypeError('Capture requires a new session record.');
      this.insertOrVerifySession(session);
      if (Date.parse(event.occurredAt) < Date.parse(session.startedAt)) throw new TypeError('Capture event cannot precede its session start.');
      return;
    }
    const persisted = sessionFromRow(existing);
    assertIncrementalSession(persisted);
    if (existing.source !== event.source) throw new TypeError('Capture source conflicts with the existing session.');
    if (session !== undefined) this.assertSameSession(existing, session);
    if (Date.parse(event.occurredAt) < Date.parse(persisted.startedAt)) throw new TypeError('Capture event cannot precede its session start.');
    if (persisted.endedAt !== undefined && Date.parse(event.occurredAt) > Date.parse(persisted.endedAt)) throw new TypeError('Capture event cannot occur after its session end.');
  }

  private insertOrVerifySession(session: Session): boolean {
    const existing = this.database.prepare('SELECT id, source, started_at, ended_at, repository_id, workspace_id, user_id FROM sessions WHERE id = ?').get(session.id) as unknown as SessionRow | undefined;
    if (existing !== undefined) {
      this.assertSameSession(existing, session);
      return false;
    }
    if (session.endedAt !== undefined) throw new TypeError('New sessions must start open; close them with endSession.');
    const validation = validateImport({ sessions: [session], events: [], observations: [], clusters: [], candidates: [], evidence: [], knowledge: [] });
    if (!validation.ok) throw new TypeError(`${validation.code}: ${validation.message}`);
    this.database.prepare('INSERT INTO sessions (id, source, started_at, ended_at, repository_id, workspace_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(session.id, session.source, session.startedAt, session.endedAt ?? null, session.repositoryId ?? null, session.workspaceId ?? null, session.userId ?? null);
    return true;
  }

  private assertSameSession(row: SessionRow, session: Session): void {
    if (row.source !== session.source || row.started_at !== session.startedAt || row.repository_id !== (session.repositoryId ?? null)
      || row.workspace_id !== (session.workspaceId ?? null) || row.user_id !== (session.userId ?? null)) {
      throw new TypeError('Conflicting duplicate session identity.');
    }
    if (session.endedAt !== undefined && row.ended_at !== session.endedAt) {
      throw new TypeError('Conflicting duplicate session end.');
    }
  }

  private insertCaptureEvent(event: CapturedEventRecord): void {
    const domainEvent: Event = {
      id: event.id as EventId,
      sessionId: event.sessionId,
      kind: event.phase,
      occurredAt: event.occurredAt,
      ...(event.signature.kind === 'action' ? { tool: event.signature.tool } : event.signature.tool === undefined ? {} : { tool: event.signature.tool }),
      ...(event.signature.path === undefined ? {} : { path: event.signature.path }),
      ...(event.outcome === undefined ? {} : { outcome: event.outcome === 'succeeded' ? 'passed' : event.outcome }),
      ...(event.exitStatus === undefined ? {} : { exitStatus: event.exitStatus })
    };
    const session = this.database.prepare('SELECT id, source, started_at, ended_at, repository_id, workspace_id, user_id FROM sessions WHERE id = ?').get(event.sessionId) as unknown as SessionRow;
    const persistedSession = sessionFromRow(session);
    assertIncrementalSession(persistedSession);
    if (Date.parse(event.occurredAt) < Date.parse(persistedSession.startedAt)) throw new TypeError('Capture event cannot precede its session start.');
    if (persistedSession.endedAt !== undefined && Date.parse(event.occurredAt) > Date.parse(persistedSession.endedAt)) throw new TypeError('Capture event cannot occur after its session end.');
    const validation = validateImport({ sessions: [persistedSession], events: [domainEvent], observations: [], clusters: [], candidates: [], evidence: [], knowledge: [] });
    if (!validation.ok) throw new TypeError(`${validation.code}: ${validation.message}`);
    this.database.prepare('INSERT INTO events (id, session_id, kind, occurred_at, tool, path, tags_json, outcome, exit_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(domainEvent.id, domainEvent.sessionId, domainEvent.kind, domainEvent.occurredAt, domainEvent.tool ?? null, domainEvent.path ?? null, '[]', domainEvent.outcome ?? null, domainEvent.exitStatus ?? null);
    this.database.prepare(`INSERT INTO capture_events
      (event_id, source, source_event_id, phase, signature_json, summary, capture_outcome, related_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.id, event.source, event.sourceEventId, event.phase, JSON.stringify(event.signature), event.summary, event.outcome ?? null, event.relatedEventId ?? null);
  }

  private assertPostResultLink(event: CapturedEventRecord): void {
    if (event.phase !== 'post-result') return;
    if (event.relatedEventId === undefined) throw new TypeError('Post-result capture requires a related pre-action.');
    const related = this.database.prepare(`
      SELECT ce.phase, ce.signature_json, e.session_id, e.occurred_at
      FROM capture_events ce JOIN events e ON e.id = ce.event_id
      WHERE ce.source = ? AND ce.source_event_id = ?
    `).get(event.source, event.relatedEventId) as { phase: string; signature_json: string; session_id: string; occurred_at: string } | undefined;
    if (related === undefined || related.phase !== 'pre-action') throw new TypeError('Post-result capture requires an existing related pre-action.');
    if (related.session_id !== event.sessionId) throw new TypeError('Post-result capture session does not match its related pre-action.');
    if (related.signature_json !== JSON.stringify(event.signature)) throw new TypeError('Post-result capture signature does not match its related pre-action.');
    if (Date.parse(event.occurredAt) < Date.parse(related.occurred_at)) throw new TypeError('Post-result capture cannot precede its related pre-action.');
  }

  private insertOrVerifyEnforcementSnapshot(event: CapturedEventRecord, input: CaptureEnforcementSnapshot): boolean {
    const snapshot = checkedEnforcementSnapshot(input);
    const existing = this.database.prepare(`SELECT input_binding, enforcing_references_json, override_references_json
      FROM capture_enforcement_snapshots WHERE event_id = ?`).get(event.id) as {
        input_binding: string; enforcing_references_json: string; override_references_json: string;
      } | undefined;
    const enforcing = JSON.stringify(snapshot.enforcingReferences);
    const overrides = JSON.stringify(snapshot.overrideReferences);
    if (existing !== undefined) {
      if (existing.input_binding !== snapshot.inputBinding || existing.enforcing_references_json !== enforcing || existing.override_references_json !== overrides) {
        throw new TypeError('Conflicting duplicate enforcement snapshot.');
      }
      return false;
    }
    this.database.prepare(`INSERT INTO capture_enforcement_snapshots
      (event_id, input_binding, enforcing_references_json, override_references_json) VALUES (?, ?, ?, ?)`)
      .run(event.id, snapshot.inputBinding, enforcing, overrides);
    return true;
  }

  private insertOrVerifyEffectBundle(event: CapturedEventRecord, input: IncrementalCaptureAppend): boolean {
    const effects = canonicalEffectBundle(input);
    if (effects === undefined) return false;
    const existing = this.database.prepare('SELECT bundle_hash FROM capture_effect_bundles WHERE event_id = ?').get(event.id) as { bundle_hash: string } | undefined;
    if (existing !== undefined) {
      if (existing.bundle_hash !== effects) throw new TypeError('Conflicting duplicate capture side-effect bundle.');
      return false;
    }
    this.database.prepare('INSERT INTO capture_effect_bundles (event_id, bundle_hash) VALUES (?, ?)').run(event.id, effects);
    return true;
  }

  private assertPostResultEffects(event: CapturedEventRecord, input: IncrementalCaptureAppend): void {
    if (event.phase !== 'post-result') return;
    const hasLifecycleEffects = input.candidate !== undefined || input.evidence !== undefined || (input.evidenceUpdates?.length ?? 0) > 0;
    if (!hasLifecycleEffects) return;
    if (event.outcome === 'unknown') throw new TypeError('Unknown post-result cannot produce lifecycle evidence.');
    if (input.candidate !== undefined) {
      if (event.outcome !== 'failed') throw new TypeError('Candidate failure capture requires an explicit failed result.');
      if (input.candidate.evidence.polarity !== 'confirms') throw new TypeError('Failed candidate capture requires confirming evidence.');
      const candidateSnapshot = event.relatedEventId === undefined ? undefined : this.loadCaptureEnforcementSnapshot(event.source, event.relatedEventId);
      if (candidateSnapshot !== undefined && candidateSnapshot.enforcingReferences.length + candidateSnapshot.overrideReferences.length > 0) {
        throw new TypeError('Failure candidate conflicts with its persisted enforcement snapshot.');
      }
      return;
    }
    const snapshot = event.relatedEventId === undefined ? undefined : this.loadCaptureEnforcementSnapshot(event.source, event.relatedEventId);
    if (snapshot === undefined) throw new TypeError('Post-result lifecycle evidence requires its persisted enforcement snapshot.');
    if (input.evidence !== undefined && input.transition === undefined) throw new TypeError('Post-result lifecycle evidence requires a knowledge transition.');
    const allowed = new Set([...snapshot.enforcingReferences, ...snapshot.overrideReferences].map(({ knowledgeId }) => knowledgeId));
    const updates = input.evidenceUpdates ?? (input.evidence === undefined || input.transition === undefined ? [] : [{ evidence: input.evidence, transition: input.transition }]);
    const expectedPolarity = event.outcome === 'succeeded' ? 'contradicts' : 'confirms';
    const updatedKnowledge = new Set<string>();
    for (const update of updates) {
      if (updatedKnowledge.has(update.transition.knowledgeId)) throw new TypeError('Captured result cannot contain duplicate knowledge updates.');
      updatedKnowledge.add(update.transition.knowledgeId);
      if (update.evidence.revalidatesTo !== undefined || update.transition.target !== undefined) {
        throw new TypeError('Capture-derived evidence cannot request revalidation or an arbitrary target.');
      }
      if (!allowed.has(update.transition.knowledgeId) || update.evidence.polarity !== expectedPolarity) {
        throw new TypeError('Post-result lifecycle evidence conflicts with its persisted enforcement snapshot.');
      }
    }
  }

  private insertCandidateCapture(event: CapturedEventRecord, bundle: NonNullable<IncrementalCaptureAppend['candidate']>): boolean {
    assertIncrementalCandidateResources(bundle);
    const candidateId = bundle.candidate.id as CandidateLessonId;
    const evidenceCandidateId = (bundle.evidence.candidateId ?? bundle.candidate.id) as CandidateLessonId;
    const sessionRow = this.database.prepare('SELECT id, source, started_at, ended_at, repository_id, workspace_id, user_id FROM sessions WHERE id = ?').get(event.sessionId) as unknown as SessionRow;
    const domainEvent = this.domainEvent(event);
    const record: ExperienceImport = {
      sessions: [sessionFromRow(sessionRow)], events: [domainEvent],
      observations: [{ id: bundle.observation.id as ObservationId, eventIds: [event.id as EventId], statement: bundle.observation.statement }],
      clusters: [{ id: bundle.cluster.id as ClusterId, observationIds: [bundle.observation.id as ObservationId] }],
      candidates: [{ id: candidateId, clusterId: bundle.cluster.id as ClusterId, kind: bundle.candidate.kind, statement: bundle.candidate.statement }],
      evidence: [{ id: bundle.evidence.id as EvidenceId, candidateId: evidenceCandidateId, polarity: bundle.evidence.polarity, summary: bundle.evidence.summary }],
      knowledge: []
    };
    const validation = validateImport(record);
    if (!validation.ok) throw new TypeError(`${validation.code}: ${validation.message}`);
    const existing = this.database.prepare('SELECT statement FROM observations WHERE id = ?').get(bundle.observation.id) as { statement: string } | undefined;
    if (existing !== undefined) {
      const cluster = this.database.prepare('SELECT id FROM clusters WHERE id = ?').get(bundle.cluster.id) as { id: string } | undefined;
      const candidate = this.database.prepare('SELECT cluster_id, kind, statement FROM candidates WHERE id = ?').get(bundle.candidate.id) as { cluster_id: string; kind: string; statement: string } | undefined;
      const evidence = this.database.prepare('SELECT candidate_id, polarity, summary, revalidates_to FROM evidence WHERE id = ?').get(bundle.evidence.id) as { candidate_id: string; polarity: string; summary: string; revalidates_to: string | null } | undefined;
      const observationEvent = this.database.prepare('SELECT 1 AS found FROM observation_events WHERE observation_id = ? AND event_id = ? AND position = 0').get(bundle.observation.id, event.id);
      const clusterObservation = this.database.prepare('SELECT 1 AS found FROM cluster_observations WHERE cluster_id = ? AND observation_id = ? AND position = 0').get(bundle.cluster.id, bundle.observation.id);
      if (existing.statement !== bundle.observation.statement || cluster === undefined || candidate?.cluster_id !== bundle.cluster.id
        || candidate?.kind !== bundle.candidate.kind || candidate?.statement !== bundle.candidate.statement
        || evidence?.candidate_id !== evidenceCandidateId || evidence?.polarity !== bundle.evidence.polarity
        || evidence?.summary !== bundle.evidence.summary || evidence?.revalidates_to !== null
        || observationEvent === undefined || clusterObservation === undefined) {
        throw new TypeError('Conflicting duplicate candidate capture bundle.');
      }
      return false;
    }
    for (const [table, id] of [['clusters', bundle.cluster.id], ['candidates', bundle.candidate.id], ['evidence', bundle.evidence.id]] as const) {
      if (this.database.prepare(`SELECT 1 AS found FROM ${table} WHERE id = ?`).get(id) !== undefined) throw new TypeError('Conflicting duplicate candidate capture bundle.');
    }
    this.database.prepare('INSERT INTO observations (id, statement) VALUES (?, ?)').run(bundle.observation.id, bundle.observation.statement);
    this.database.prepare('INSERT INTO observation_events (observation_id, event_id, position) VALUES (?, ?, 0)').run(bundle.observation.id, event.id);
    this.database.prepare('INSERT INTO clusters (id) VALUES (?)').run(bundle.cluster.id);
    this.database.prepare('INSERT INTO cluster_observations (cluster_id, observation_id, position) VALUES (?, ?, 0)').run(bundle.cluster.id, bundle.observation.id);
    this.database.prepare('INSERT INTO candidates (id, cluster_id, kind, statement) VALUES (?, ?, ?, ?)').run(bundle.candidate.id, bundle.cluster.id, bundle.candidate.kind, bundle.candidate.statement);
    this.database.prepare('INSERT INTO evidence (id, candidate_id, polarity, summary, revalidates_to) VALUES (?, ?, ?, ?, NULL)')
      .run(bundle.evidence.id, evidenceCandidateId, bundle.evidence.polarity, bundle.evidence.summary);
    return true;
  }

  private insertIncrementalEvidence(input: NonNullable<IncrementalCaptureAppend['evidence']>, transition: IncrementalCaptureAppend['transition']): boolean {
    const resolvedCandidateId = input.candidateId ?? this.candidateIdForKnowledge(transition?.knowledgeId);
    const evidence: Evidence = {
      id: input.id as EvidenceId, candidateId: resolvedCandidateId as CandidateLessonId,
      polarity: input.polarity, summary: input.summary,
      ...(input.revalidatesTo === undefined ? {} : { revalidatesTo: input.revalidatesTo })
    };
    const validation = validateIncrementalEvidence(evidence);
    if (!validation.ok) throw new TypeError(`${validation.code}: ${validation.message}`);
    try {
      assertDurableTextSafe(evidence.summary);
    } catch {
      throw new TypeError('Incremental evidence summary contains private or credential-like material.');
    }
    const candidate = this.database.prepare('SELECT id FROM candidates WHERE id = ?').get(evidence.candidateId);
    if (candidate === undefined) throw new TypeError('Incremental evidence references a missing candidate.');
    const existingEvidence = this.database.prepare('SELECT candidate_id, polarity, summary, revalidates_to FROM evidence WHERE id = ?').get(evidence.id) as { candidate_id: string; polarity: string; summary: string; revalidates_to: string | null } | undefined;
    if (existingEvidence !== undefined) {
      if (existingEvidence.candidate_id !== evidence.candidateId || existingEvidence.polarity !== evidence.polarity
        || existingEvidence.summary !== evidence.summary || existingEvidence.revalidates_to !== (evidence.revalidatesTo ?? null)) {
        throw new TypeError('Conflicting duplicate incremental evidence.');
      }
      if (transition !== undefined) {
        const attached = this.database.prepare('SELECT 1 AS found FROM knowledge_evidence WHERE knowledge_id = ? AND evidence_id = ?').get(transition.knowledgeId, evidence.id);
        if (attached === undefined) throw new TypeError('Conflicting duplicate incremental evidence side effect.');
        if (transition.target !== undefined) {
          const history = this.database.prepare('SELECT to_state, occurred_at FROM knowledge_transition_history WHERE knowledge_id = ? AND evidence_id = ?').get(transition.knowledgeId, evidence.id) as { to_state: string; occurred_at: string } | undefined;
          if (history?.to_state !== transition.target || history.occurred_at !== transition.occurredAt) throw new TypeError('Conflicting duplicate incremental transition.');
        }
        if (evidence.polarity === 'contradicts') return this.maybeCreateRevalidationProposal(transition.knowledgeId, transition.occurredAt);
      }
      return false;
    }
    this.database.prepare('INSERT INTO evidence (id, candidate_id, polarity, summary, revalidates_to) VALUES (?, ?, ?, ?, ?)')
      .run(evidence.id, evidence.candidateId, evidence.polarity, evidence.summary, evidence.revalidatesTo ?? null);
    if (transition === undefined) return true;
    assertCanonicalTimestamp(transition.occurredAt);
    const row = this.database.prepare(`
      SELECT k.id, k.candidate_id, k.state, k.statement, m.created_at
      FROM knowledge k JOIN knowledge_metadata m ON m.knowledge_id = k.id
      WHERE k.id = ?
    `).get(transition.knowledgeId) as (KnowledgeRow & { created_at: string }) | undefined;
    if (row === undefined) throw new TypeError('Incremental transition references missing knowledge.');
    assertCanonicalTimestamp(row.created_at);
    if (transition.occurredAt < row.created_at) throw new TypeError('Incremental transition cannot precede knowledge creation.');
    const latest = this.database.prepare(`
      SELECT occurred_at FROM knowledge_transition_history
      WHERE knowledge_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1
    `).get(transition.knowledgeId) as { occurred_at: string } | undefined;
    if (latest !== undefined) {
      assertCanonicalTimestamp(latest.occurred_at);
      // Equal timestamps are valid; append-only sequence IDs provide deterministic order.
      if (transition.occurredAt < latest.occurred_at) throw new TypeError('Incremental transition cannot precede the latest transition.');
    }
    const current: KnowledgeEntry = {
      id: row.id as KnowledgeId,
      candidateId: row.candidate_id as CandidateLessonId,
      evidenceIds: [],
      state: row.state,
      statement: row.statement
    };
    if (current.candidateId !== evidence.candidateId) throw new TypeError('Knowledge evidence must support its candidate.');
    const lifecycle = applyTransition(current, evidence, [], transition.target);
    if (transition.target !== undefined && lifecycle.history.at(-1)?.to !== transition.target) {
      throw new TypeError('Incremental lifecycle transition did not reach the exact target.');
    }
    const attached = lifecycle.entry.evidenceIds.includes(evidence.id);
    if (!attached) throw new TypeError('Incremental evidence does not permit the requested lifecycle transition.');
    if (attached) {
      const position = (this.database.prepare('SELECT COUNT(*) AS count FROM knowledge_evidence WHERE knowledge_id = ?').get(row.id) as { count: number }).count;
      this.database.prepare('INSERT INTO knowledge_evidence (knowledge_id, evidence_id, position) VALUES (?, ?, ?)').run(row.id, evidence.id, position);
    }
    if (lifecycle.entry.state !== current.state) this.database.prepare('UPDATE knowledge SET state = ? WHERE id = ?').run(lifecycle.entry.state, row.id);
    for (const item of lifecycle.history) {
      this.database.prepare('INSERT INTO knowledge_transition_history (knowledge_id, from_state, to_state, evidence_id, occurred_at) VALUES (?, ?, ?, ?, ?)')
        .run(row.id, item.from, item.to, item.evidenceId, transition.occurredAt);
    }
    if (evidence.polarity === 'contradicts') this.maybeCreateRevalidationProposal(row.id, transition.occurredAt);
    return true;
  }

  private candidateIdForKnowledge(knowledgeId: string | undefined): string {
    if (knowledgeId === undefined) throw new TypeError('Incremental evidence requires a candidate or knowledge transition.');
    const row = this.database.prepare('SELECT candidate_id FROM knowledge WHERE id = ?').get(knowledgeId) as { candidate_id: string } | undefined;
    if (row === undefined) throw new TypeError('Capture evidence references missing knowledge.');
    return row.candidate_id;
  }

  private maybeCreateRevalidationProposal(knowledgeId: string, occurredAt: string): boolean {
    const count = (this.database.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_evidence ke JOIN evidence e ON e.id = ke.evidence_id
      WHERE ke.knowledge_id = ? AND e.polarity = 'contradicts'
    `).get(knowledgeId) as { count: number }).count;
    if (count < 2) return false;
    const id = createHash('sha256').update('ael:revalidation-proposal:v1\0').update(knowledgeId).digest('hex');
    const result = this.database.prepare(`INSERT INTO revalidation_proposals (id, knowledge_id, created_at, contradiction_count, status)
      VALUES (?, ?, ?, ?, 'proposed') ON CONFLICT (knowledge_id) DO NOTHING`)
      .run(id, knowledgeId, occurredAt, count);
    return Number(result.changes) > 0;
  }

  private domainEvent(event: CapturedEventRecord): Event {
    return {
      id: event.id as EventId, sessionId: event.sessionId, kind: event.phase, occurredAt: event.occurredAt,
      ...(event.signature.kind === 'action' ? { tool: event.signature.tool } : event.signature.tool === undefined ? {} : { tool: event.signature.tool }),
      ...(event.signature.path === undefined ? {} : { path: event.signature.path }),
      ...(event.outcome === undefined ? {} : { outcome: event.outcome === 'succeeded' ? 'passed' : event.outcome }),
      ...(event.exitStatus === undefined ? {} : { exitStatus: event.exitStatus })
    };
  }

  private captureHighWater(): number {
    return tableHighWater(this.database, 'capture_events');
  }

  private defaultMetadata(knowledgeId: string, record: ExperienceImport): Required<Pick<KnowledgeMetadata, 'scope' | 'createdAt'>> & KnowledgeMetadata {
    const candidate = record.knowledge.find((item) => item.id === knowledgeId);
    const cluster = record.candidates.find((item) => item.id === candidate?.candidateId)?.clusterId;
    const observationIds = record.clusters.find((item) => item.id === cluster)?.observationIds ?? [];
    const events = observationIds.flatMap((observationId) => {
      const eventIds = record.observations.find((item) => item.id === observationId)?.eventIds ?? [];
      return eventIds.map((eventId) => record.events.find((item) => item.id === eventId)).filter((event): event is ExperienceImport['events'][number] => event !== undefined);
    });
    const repositoryIds = new Set(events
      .map((event) => record.sessions.find((item) => item.id === event.sessionId)?.repositoryId)
      .filter((repositoryId): repositoryId is NonNullable<typeof repositoryId> => repositoryId !== undefined));
    if (repositoryIds.size > 1) throw new Error('INVALID_METADATA: Mixed repository provenance is not eligible for repository knowledge.');
    const hasGlobalSource = events.some((event) => record.sessions.find((item) => item.id === event.sessionId)?.repositoryId === undefined);
    const repositoryId = [...repositoryIds][0];
    if (repositoryId && hasGlobalSource) throw new Error('INVALID_METADATA: Mixed global and repository provenance is not eligible for repository knowledge.');
    return {
      scope: repositoryId ? 'repository' : 'global',
      repositoryId,
      path: consistentValue(events.map((event) => event.path ? normalizePath(event.path) : undefined), 'path'),
      tool: consistentValue(events.map((event) => event.tool), 'tool'),
      tags: consistentTags(events.map((event) => event.tags ?? [])),
      createdAt: consistentValue(events.map((event) => event.occurredAt), 'creation timestamp') ?? new Date(0).toISOString()
    };
  }

  private validateMetadata(record: ExperienceImport): void {
    for (const item of record.knowledge) this.resolveMetadata(item.id, record, record.knowledgeMetadata?.[item.id]);
  }

  private resolveMetadata(knowledgeId: string, record: ExperienceImport, input: KnowledgeMetadata | undefined): Required<Pick<KnowledgeMetadata, 'scope' | 'createdAt'>> & KnowledgeMetadata {
    const provenance = this.defaultMetadata(knowledgeId, record);
    if (!input) return provenance;
    if (input.scope !== undefined && input.scope !== provenance.scope) throw new Error('INVALID_METADATA: Knowledge scope must match source provenance.');
    if (input.repositoryId !== undefined && input.repositoryId !== provenance.repositoryId) throw new Error('INVALID_METADATA: Repository ID must match source provenance.');
    if (input.path !== undefined && normalizePath(input.path) !== provenance.path) throw new Error('INVALID_METADATA: Path must match source provenance.');
    if (input.tool !== undefined && input.tool !== provenance.tool) throw new Error('INVALID_METADATA: Tool must match source provenance.');
    if (input.createdAt !== provenance.createdAt) throw new Error('INVALID_METADATA: Creation time must match source provenance.');
    if (input.tags !== undefined && JSON.stringify(normalizeTags(input.tags)) !== JSON.stringify(provenance.tags ?? [])) throw new Error('INVALID_METADATA: Tags must match source provenance.');
    if (input.activation === 'merged-team-active' && (!provenance.repositoryId || !input.mergedProvenance?.startsWith(`${provenance.repositoryId}:`))) {
      throw new Error('INVALID_METADATA: Team activation requires matching merged provenance.');
    }
    return { ...input, ...provenance, scope: provenance.scope, repositoryId: provenance.repositoryId };
  }

  private matchesFilter(row: KnowledgeMetadataRow & KnowledgeRow, filter: RetrievalFilter, normalizedPath: string | undefined): boolean {
    if (filter.scope && row.scope !== filter.scope) return false;
    if (row.scope === 'repository' && filter.repositoryId !== undefined && row.repository_id !== filter.repositoryId) return false;
    if (filter.repositoryId && row.repository_id !== filter.repositoryId) return false;
    if (normalizedPath && row.path !== normalizedPath) return false;
    if (filter.tool && row.tool !== filter.tool) return false;
    if (filter.state && row.state !== filter.state) return false;
    const tags = JSON.parse(row.tags_json) as string[];
    return !filter.tags || filter.tags.every((tag) => tags.includes(tag));
  }

  private matchScore(row: KnowledgeMetadataRow & KnowledgeRow, filter: RetrievalFilter, normalizedPath: string | undefined): number {
    return Number(filter.scope !== undefined && row.scope === filter.scope)
      + Number(filter.repositoryId !== undefined && row.repository_id === filter.repositoryId)
      + Number(normalizedPath !== undefined && row.path === normalizedPath)
      + Number(filter.tool !== undefined && row.tool === filter.tool)
      + Number(filter.state !== undefined && row.state === filter.state)
      + Number(filter.tags !== undefined && filter.tags.every((tag) => (JSON.parse(row.tags_json) as string[]).includes(tag)));
  }

  private isAuthoritative(row: KnowledgeMetadataRow): boolean {
    return (row.scope === 'global' && row.approval_kind === 'user' && row.approved_at !== null)
      || (row.scope === 'repository' && row.activation === 'merged-team-active' && Boolean(row.merged_provenance));
  }
}

function normalizePath(value: string): string {
  const normalized = posix.normalize(value.replaceAll('\\', '/'));
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function sessionFromRow(row: SessionRow): Session {
  return {
    id: row.id as SessionId,
    source: row.source,
    startedAt: row.started_at,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    ...(row.repository_id === null ? {} : { repositoryId: row.repository_id as Session['repositoryId'] }),
    ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id as Session['workspaceId'] }),
    ...(row.user_id === null ? {} : { userId: row.user_id as Session['userId'] })
  };
}

function captureFromRow(row: CaptureRow): CapturedEventRecord {
  const signature = JSON.parse(row.signature_json) as CapturedEventRecord['signature'];
  if (signature.kind === 'action' && signature.arguments !== undefined) Object.freeze(signature.arguments);
  Object.freeze(signature);
  return Object.freeze({
    id: row.event_id,
    source: row.source,
    sourceEventId: row.source_event_id,
    sessionId: row.session_id as SessionId,
    phase: row.phase,
    occurredAt: row.occurred_at,
    signature,
    summary: row.summary,
    ...(row.capture_outcome === null ? {} : { outcome: row.capture_outcome }),
    ...(row.exit_status === null ? {} : { exitStatus: row.exit_status }),
    ...(row.related_event_id === null ? {} : { relatedEventId: row.related_event_id })
  });
}

function evidenceFromRow(row: EvidenceRow): Evidence {
  return Object.freeze({
    id: row.id as EvidenceId,
    candidateId: row.candidate_id as CandidateLessonId,
    polarity: row.polarity,
    summary: row.summary,
    ...(row.revalidates_to === null ? {} : { revalidatesTo: row.revalidates_to })
  });
}

function assertCanonicalTimestamp(value: string): void {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new TypeError('Transition timestamp must be canonical ISO time.');
}

function assertIncrementalCandidateResources(bundle: NonNullable<IncrementalCaptureAppend['candidate']>): void {
  assertOnlyIncrementalKeys(bundle as unknown as Record<string, unknown>, ['observation', 'cluster', 'candidate', 'evidence']);
  assertOnlyIncrementalKeys(bundle.observation as unknown as Record<string, unknown>, ['id', 'statement']);
  assertOnlyIncrementalKeys(bundle.cluster as unknown as Record<string, unknown>, ['id']);
  assertOnlyIncrementalKeys(bundle.candidate as unknown as Record<string, unknown>, ['id', 'kind', 'statement']);
  assertOnlyIncrementalKeys(bundle.evidence as unknown as Record<string, unknown>, ['id', 'candidateId', 'polarity', 'summary']);
  for (const [field, value, maximum] of [
    ['observation id', bundle.observation.id, 512],
    ['cluster id', bundle.cluster.id, 512],
    ['candidate id', bundle.candidate.id, 512],
    ['evidence id', bundle.evidence.id, 512],
    ['observation statement', bundle.observation.statement, 2_048],
    ['candidate statement', bundle.candidate.statement, 2_048],
    ['evidence summary', bundle.evidence.summary, 2_048]
  ] as const) {
    if (value.length < 1 || value.length > maximum || value !== value.trim() || /[\u0000-\u001F\u007F]/.test(value)) {
      throw new TypeError(`Incremental ${field} is invalid or exceeds its resource limit.`);
    }
    if (field.endsWith('id') && !canonicalIncrementalIdentifier.test(value)) throw new TypeError(`Incremental ${field} is invalid.`);
    try {
      assertDurableTextSafe(value);
    } catch {
      throw new TypeError(`Incremental ${field} contains private or credential-like material.`);
    }
  }
  if (bundle.evidence.candidateId !== undefined && !canonicalIncrementalIdentifier.test(bundle.evidence.candidateId)) {
    throw new TypeError('Incremental evidence candidate id is invalid.');
  }
}

function assertIncrementalEvidenceResources(evidence: NonNullable<IncrementalCaptureAppend['evidence']>): void {
  if (!evidence || typeof evidence !== 'object') throw new TypeError('Incremental evidence is invalid.');
  assertOnlyIncrementalKeys(evidence as unknown as Record<string, unknown>, ['id', 'candidateId', 'polarity', 'summary', 'revalidatesTo']);
  if (typeof evidence.id !== 'string' || !canonicalIncrementalIdentifier.test(evidence.id)) throw new TypeError('Incremental evidence id is invalid.');
  if (evidence.candidateId !== undefined && (typeof evidence.candidateId !== 'string' || !canonicalIncrementalIdentifier.test(evidence.candidateId))) {
    throw new TypeError('Incremental evidence candidate id is invalid.');
  }
  if (evidence.polarity !== 'confirms' && evidence.polarity !== 'contradicts') throw new TypeError('Incremental evidence polarity is invalid.');
  if (typeof evidence.summary !== 'string' || evidence.summary.length < 1 || evidence.summary.length > 2_048 || evidence.summary !== evidence.summary.trim()
    || /[\u0000-\u001F\u007F]/.test(evidence.summary)) throw new TypeError('Incremental evidence summary is invalid or exceeds its resource limit.');
  if (evidence.revalidatesTo !== undefined && !['observed', 'confirmed', 'verified'].includes(evidence.revalidatesTo)) throw new TypeError('Incremental evidence revalidation target is invalid.');
  for (const [field, value] of [['id', evidence.id], ['candidate id', evidence.candidateId], ['summary', evidence.summary]] as const) {
    if (value === undefined) continue;
    try {
      assertDurableTextSafe(value);
    } catch {
      throw new TypeError(`Incremental evidence ${field} contains private or credential-like material.`);
    }
  }
}

function assertOnlyIncrementalKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) throw new TypeError(`Unsupported incremental field: ${unexpected}.`);
}

function assertIncrementalEffectGrammar(input: IncrementalCaptureAppend): void {
  const hasCandidate = input.candidate !== undefined;
  const hasEvidence = input.evidence !== undefined;
  const hasTransition = input.transition !== undefined;
  const hasUpdates = input.evidenceUpdates !== undefined;
  if (hasCandidate && (hasEvidence || hasTransition || hasUpdates)) {
    throw new TypeError('Incremental candidate effect form is exclusive.');
  }
  if (hasUpdates && (hasEvidence || hasTransition)) throw new TypeError('Incremental evidence effect forms cannot be mixed.');
  if (hasTransition && !hasEvidence) throw new TypeError('Knowledge transition requires its evidence effect form.');
}

const canonicalIncrementalIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,511}$/;

function checkedEnforcementSnapshot(input: unknown): CaptureEnforcementSnapshot {
  if (!input || typeof input !== 'object') throw new TypeError('Capture enforcement snapshot is invalid.');
  assertOnlyIncrementalKeys(input as unknown as Record<string, unknown>, ['inputBinding', 'enforcingReferences', 'overrideReferences']);
  const value = input as { inputBinding?: unknown; enforcingReferences?: unknown; overrideReferences?: unknown };
  if (typeof value.inputBinding !== 'string' || !canonicalIncrementalIdentifier.test(value.inputBinding)) throw new TypeError('Capture input binding is invalid.');
  assertSnapshotIdentifierSafe(value.inputBinding, 'input binding');
  const checkReferences = (value: unknown, field: string): readonly { ruleId: string; knowledgeId: string }[] => {
    if (!Array.isArray(value) || value.length > 256) throw new TypeError(`Capture ${field} references exceed their resource limit.`);
    const seen = new Set<string>();
    const checked = value.map((item) => {
      if (!item || typeof item !== 'object') throw new TypeError(`Capture ${field} reference is invalid.`);
      assertOnlyIncrementalKeys(item as Record<string, unknown>, ['ruleId', 'knowledgeId']);
      const { ruleId, knowledgeId } = item as { ruleId?: unknown; knowledgeId?: unknown };
      if (typeof ruleId !== 'string' || typeof knowledgeId !== 'string' || !canonicalIncrementalIdentifier.test(ruleId) || !canonicalIncrementalIdentifier.test(knowledgeId)) {
        throw new TypeError(`Capture ${field} reference is invalid.`);
      }
      assertSnapshotIdentifierSafe(ruleId, `${field} rule reference`);
      assertSnapshotIdentifierSafe(knowledgeId, `${field} knowledge reference`);
      const identity = `${ruleId}\0${knowledgeId}`;
      if (seen.has(identity)) throw new TypeError(`Capture ${field} references contain duplicates.`);
      seen.add(identity);
      return Object.freeze({ ruleId, knowledgeId });
    });
    const sorted = [...checked].sort((left, right) => compareText(left.ruleId, right.ruleId) || compareText(left.knowledgeId, right.knowledgeId));
    if (JSON.stringify(checked) !== JSON.stringify(sorted)) throw new TypeError(`Capture ${field} references are not canonical.`);
    return Object.freeze(checked);
  };
  return Object.freeze({
    inputBinding: value.inputBinding,
    enforcingReferences: checkReferences(value.enforcingReferences, 'enforcing'),
    overrideReferences: checkReferences(value.overrideReferences, 'override')
  });
}

function assertSnapshotIdentifierSafe(value: string, field: string): void {
  try {
    assertDurableTextSafe(value);
  } catch {
    throw new TypeError(`Capture ${field} contains private or credential-like material.`);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalEffectBundle(input: IncrementalCaptureAppend): string | undefined {
  if (input.candidate === undefined && input.evidence === undefined && input.evidenceUpdates === undefined) return undefined;
  const value = {
    ...(input.candidate === undefined ? {} : { candidate: input.candidate }),
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    ...(input.transition === undefined ? {} : { transition: input.transition }),
    ...(input.evidenceUpdates === undefined ? {} : { evidenceUpdates: input.evidenceUpdates })
  };
  return createHash('sha256').update('ael:capture-effect-bundle:v1\0').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function assertIncrementalSession(session: Session): void {
  if (!session || typeof session !== 'object') throw new TypeError('Incremental session is invalid.');
  assertOnlyIncrementalKeys(session as unknown as Record<string, unknown>, ['id', 'source', 'startedAt', 'endedAt', 'repositoryId', 'workspaceId', 'userId']);
  if (session.source !== 'codex' && session.source !== 'claude-code' && session.source !== 'cursor') throw new TypeError('Incremental session source is invalid.');
  assertCanonicalTimestamp(session.startedAt);
  if (session.endedAt !== undefined) {
    assertCanonicalTimestamp(session.endedAt);
    if (Date.parse(session.endedAt) < Date.parse(session.startedAt)) throw new TypeError('Incremental session end cannot precede its start.');
  }
  for (const [field, value] of [
    ['session id', session.id], ['repository id', session.repositoryId],
    ['workspace id', session.workspaceId], ['user id', session.userId]
  ] as const) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || !canonicalIncrementalIdentifier.test(value)) throw new TypeError(`Incremental ${field} is invalid.`);
    try {
      assertDurableTextSafe(value);
    } catch {
      throw new TypeError(`Incremental ${field} contains private or credential-like material.`);
    }
  }
}

function assertIncrementalTransition(transition: NonNullable<IncrementalCaptureAppend['transition']>): void {
  if (!transition || typeof transition !== 'object') throw new TypeError('Incremental transition is invalid.');
  assertOnlyIncrementalKeys(transition as unknown as Record<string, unknown>, ['knowledgeId', 'occurredAt', 'target']);
  if (typeof transition.knowledgeId !== 'string' || !canonicalIncrementalIdentifier.test(transition.knowledgeId)) throw new TypeError('Incremental transition knowledge id is invalid.');
  assertCanonicalTimestamp(transition.occurredAt);
  if (transition.target !== undefined && !['candidate', 'observed', 'confirmed', 'verified', 'disputed', 'superseded', 'rejected', 'expired'].includes(transition.target)) {
    throw new TypeError('Incremental transition target is invalid.');
  }
}

function assertTransitionAfterEvent(
  event: CapturedEventRecord | undefined,
  transition: IncrementalCaptureAppend['transition']
): void {
  if (event !== undefined && transition !== undefined && transition.occurredAt < event.occurredAt) {
    throw new TypeError('Incremental event cannot occur after its lifecycle transition.');
  }
}

function assertLifecycleSignal(signal: LifecycleSignal): void {
  if (!signal || typeof signal !== 'object') throw new TypeError('Lifecycle signal is invalid.');
  const value = signal as unknown as Record<string, unknown>;
  const allowed = ['sourceEventId', 'source', 'conversationId', 'kind', 'receiptAt', 'sourceAt'];
  assertOnlyIncrementalKeys(value, allowed);
  if (signal.source !== 'codex' && signal.source !== 'claude-code' && signal.source !== 'cursor') throw new TypeError('Lifecycle signal source is invalid.');
  if (signal.kind !== 'start' && signal.kind !== 'end') throw new TypeError('Lifecycle signal kind is invalid.');
  for (const [name, identifier] of [['source event id', signal.sourceEventId], ['conversation id', signal.conversationId]] as const) {
    if (typeof identifier !== 'string' || !canonicalIncrementalIdentifier.test(identifier)) throw new TypeError(`Lifecycle ${name} is invalid.`);
    assertSnapshotIdentifierSafe(identifier, `lifecycle ${name}`);
  }
  assertCanonicalTimestamp(signal.receiptAt);
  if (signal.sourceAt !== undefined) assertCanonicalTimestamp(signal.sourceAt);
}

function sourceTimeDoesNotPrecedeRun(signal: LifecycleSignal, run: CaptureRunRow): boolean {
  return signal.sourceAt === undefined || run.source_started_at === null || Date.parse(signal.sourceAt) >= Date.parse(run.source_started_at);
}

function conversationFromRow(row: ConversationRow): CaptureConversation {
  return Object.freeze({ id: row.id, source: row.source, firstReceiptAt: row.first_receipt_at, identifierProvenance: row.identifier_provenance });
}

function captureRunFromRow(row: CaptureRunRow): CaptureRun {
  return Object.freeze({
    id: row.id, conversationId: row.conversation_id, state: row.state,
    receiptStartedAt: row.receipt_started_at,
    ...(row.source_started_at === null ? {} : { sourceStartedAt: row.source_started_at }),
    ...(row.receipt_ended_at === null ? {} : { receiptEndedAt: row.receipt_ended_at }),
    ...(row.source_ended_at === null ? {} : { sourceEndedAt: row.source_ended_at })
  });
}

function lifecycleSignalFromRow(row: LifecycleSignalRow): RecordedLifecycleSignal {
  return Object.freeze({
    source: row.source, sourceEventId: row.source_event_id, conversationId: row.conversation_id,
    kind: row.kind, receiptAt: row.receipt_at,
    ...(row.source_at === null ? {} : { sourceAt: row.source_at }),
    resolution: row.resolution,
    ...(row.resolved_run_id === null ? {} : { resolvedRunId: row.resolved_run_id })
  });
}

interface CheckedPage {
  readonly afterSequence: number;
  readonly highWaterSequence: number;
  readonly limit: number;
}

function checkedPageRequest(request: IncrementalPageRequest, currentHighWater: number): CheckedPage {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new RangeError('Incremental page request is invalid.');
  const unexpectedRequestField = Object.keys(request).find((key) => !['cursor', 'limit'].includes(key));
  if (unexpectedRequestField !== undefined) throw new RangeError(`Unsupported incremental page request field: ${unexpectedRequestField}.`);
  const limit = request.limit ?? MAX_INCREMENTAL_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_INCREMENTAL_PAGE_SIZE) {
    throw new RangeError(`Incremental page size must be between 1 and ${MAX_INCREMENTAL_PAGE_SIZE}.`);
  }
  const cursor = request.cursor ?? { afterSequence: 0, highWaterSequence: currentHighWater };
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)
    || Object.keys(cursor).some((key) => !['afterSequence', 'highWaterSequence'].includes(key))) {
    throw new RangeError('Incremental page cursor is invalid.');
  }
  if (!Number.isSafeInteger(cursor.afterSequence) || cursor.afterSequence < 0
    || !Number.isSafeInteger(cursor.highWaterSequence) || cursor.highWaterSequence < cursor.afterSequence
    || cursor.highWaterSequence > currentHighWater) {
    throw new RangeError('Incremental page cursor is invalid.');
  }
  return { afterSequence: cursor.afterSequence, highWaterSequence: cursor.highWaterSequence, limit };
}

function pageResult<Row extends { sequence: number }, Value>(
  rows: readonly Row[],
  page: CheckedPage,
  convert: (row: Row) => Value
): IncrementalPage<Value> {
  const visible = rows.slice(0, page.limit);
  const entries = Object.freeze(visible.map(convert));
  const nextCursor = rows.length > page.limit
    ? Object.freeze({ afterSequence: visible.at(-1)!.sequence, highWaterSequence: page.highWaterSequence })
    : undefined;
  return Object.freeze({ entries, ...(nextCursor === undefined ? {} : { nextCursor }) });
}

function tableHighWater(database: DatabaseSync, table: 'capture_events' | 'candidates' | 'evidence' | 'revalidation_proposals'): number {
  return (database.prepare(`SELECT COALESCE(MAX(rowid), 0) AS high_water FROM ${table}`).get() as { high_water: number }).high_water;
}

function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags)].sort();
}

function consistentValue<T>(values: readonly T[], field: string): T | undefined {
  const [value, ...remaining] = values;
  if (remaining.some((item) => item !== value)) throw new Error(`INVALID_METADATA: Ambiguous ${field} across source events.`);
  return value;
}

function consistentTags(values: readonly (readonly string[])[]): string[] {
  const [tags = [], ...remaining] = values.map(normalizeTags);
  if (remaining.some((item) => JSON.stringify(item) !== JSON.stringify(tags))) throw new Error('INVALID_METADATA: Ambiguous tags across source events.');
  return tags;
}
