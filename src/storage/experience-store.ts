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
  CapturedEventRecord,
  IncrementalAppendResult,
  IncrementalCaptureAppend,
  RevalidationProposal
} from '../capture/contracts.js';
import { validateNormalizedCaptureEvent } from '../capture/normalization.js';
import { openExperienceDatabase } from './database.js';
import { ensureOverrideAuditUseMigration, ensureOverrideEvidenceMigration, overrideAuditMigration } from './override-store.js';

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
  repository_id: string | null;
  workspace_id: string | null;
  user_id: string | null;
}

interface CaptureRow {
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
  id: string;
  cluster_id: string;
  kind: CandidateLesson['kind'];
  statement: string;
}

interface EvidenceRow {
  id: string;
  candidate_id: string;
  polarity: Evidence['polarity'];
  summary: string;
  revalidates_to: Evidence['revalidatesTo'] | null;
}

interface TransitionRow {
  from_state: KnowledgeState;
  to_state: KnowledgeState;
  evidence_id: string;
  occurred_at: string;
}

interface ProposalRow {
  id: string;
  knowledge_id: string;
  created_at: string;
  contradiction_count: number;
  status: 'proposed';
}

export type KnowledgeScope = 'global' | 'repository';

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

export class ExperienceStore {
  private readonly database: DatabaseSync;

  constructor(databasePath?: string) {
    this.database = openExperienceDatabase(databasePath);
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  import(record: ExperienceImport): void {
    const validation = validateImport(record);
    if (!validation.ok) throw new Error(`${validation.code}: ${validation.message}`);
    this.validateMetadata(record);

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const sessions = this.database.prepare('INSERT INTO sessions (id, source, started_at, repository_id, workspace_id, user_id) VALUES (?, ?, ?, ?, ?, ?)');
      for (const item of record.sessions) sessions.run(item.id, item.source, item.startedAt, item.repositoryId ?? null, item.workspaceId ?? null, item.userId ?? null);
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
    assertOnlyIncrementalKeys(input as unknown as Record<string, unknown>, ['session', 'event', 'candidate', 'evidence', 'transition', 'evidenceUpdates']);
    if (input.transition !== undefined) assertOnlyIncrementalKeys(input.transition as unknown as Record<string, unknown>, ['knowledgeId', 'occurredAt', 'target']);
    if (input.evidenceUpdates !== undefined) {
      if (!Array.isArray(input.evidenceUpdates) || input.evidenceUpdates.length > 256) throw new TypeError('Incremental evidence update limit exceeded.');
      for (const update of input.evidenceUpdates) {
        assertOnlyIncrementalKeys(update as unknown as Record<string, unknown>, ['evidence', 'transition']);
        assertOnlyIncrementalKeys(update.transition as unknown as Record<string, unknown>, ['knowledgeId', 'occurredAt', 'target']);
      }
    }
    if (input.candidate !== undefined && input.event === undefined) throw new TypeError('Candidate capture requires its source event.');
    if (input.transition !== undefined && input.evidence === undefined) throw new TypeError('Knowledge transition requires evidence.');
    if (input.evidenceUpdates !== undefined && (input.evidence !== undefined || input.transition !== undefined)) throw new TypeError('Incremental evidence forms cannot be mixed.');

    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (input.event !== undefined) {
        const event = validateNormalizedCaptureEvent(input.event);
        this.insertSession(input.session, event);
        const duplicate = this.captureByIdentity(event.source, event.sourceEventId);
        if (duplicate !== undefined) {
          if (JSON.stringify(duplicate) !== JSON.stringify(event)) throw new TypeError('Conflicting duplicate source-event identity.');
          this.database.exec('COMMIT');
          return Object.freeze({ inserted: false });
        }
        this.insertCaptureEvent(event);
      } else if (input.session !== undefined) {
        this.insertOrVerifySession(input.session);
      }

      if (input.candidate !== undefined) this.insertCandidateCapture(input.event!, input.candidate);
      if (input.evidence !== undefined) this.insertIncrementalEvidence(input.evidence, input.transition);
      for (const update of input.evidenceUpdates ?? []) this.insertIncrementalEvidence(update.evidence, update.transition);
      this.database.exec('COMMIT');
      return Object.freeze({ inserted: input.event !== undefined || input.session !== undefined || input.candidate !== undefined || input.evidence !== undefined || (input.evidenceUpdates?.length ?? 0) > 0 });
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  listCapturedEvents(): CapturedEventRecord[] {
    const rows = this.database.prepare(`
      SELECT ce.event_id, ce.source, ce.source_event_id, ce.phase, ce.signature_json, ce.summary,
        ce.capture_outcome, ce.related_event_id, e.session_id, e.occurred_at, e.exit_status
      FROM capture_events ce JOIN events e ON e.id = ce.event_id
      ORDER BY e.occurred_at, ce.rowid
    `).all() as unknown as CaptureRow[];
    return rows.map(captureFromRow);
  }

  listCandidates(): CandidateLesson[] {
    return (this.database.prepare('SELECT id, cluster_id, kind, statement FROM candidates ORDER BY id').all() as unknown as CandidateRow[])
      .map((row) => ({ id: row.id as CandidateLessonId, clusterId: row.cluster_id as ClusterId, kind: row.kind, statement: row.statement }));
  }

  listEvidence(): Evidence[] {
    return (this.database.prepare('SELECT id, candidate_id, polarity, summary, revalidates_to FROM evidence ORDER BY id').all() as unknown as EvidenceRow[])
      .map(evidenceFromRow);
  }

  listTransitionHistory(knowledgeId: string): TransitionHistoryEntry[] {
    return (this.database.prepare(`
      SELECT from_state, to_state, evidence_id, occurred_at
      FROM knowledge_transition_history WHERE knowledge_id = ? ORDER BY id
    `).all(knowledgeId) as unknown as TransitionRow[]).map((row) => ({
      from: row.from_state, to: row.to_state, evidenceId: row.evidence_id as EvidenceId, occurredAt: row.occurred_at
    }));
  }

  listRevalidationProposals(): RevalidationProposal[] {
    return (this.database.prepare('SELECT id, knowledge_id, created_at, contradiction_count, status FROM revalidation_proposals ORDER BY id').all() as unknown as ProposalRow[])
      .map((row) => Object.freeze({ id: row.id, knowledgeId: row.knowledge_id, createdAt: row.created_at, contradictionCount: row.contradiction_count, status: row.status }));
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
      `).all() as Array<{ id: string }>;
      const tombstoneEvent = this.database.prepare('INSERT INTO event_tombstones (event_id, tombstoned_at) VALUES (?, ?)');
      for (const event of eventCandidates) tombstoneEvent.run(event.id, now);
      const expiredEvents = this.database.prepare(`
        SELECT t.event_id AS id
        FROM event_tombstones t
        WHERE t.tombstoned_at < ?
          AND NOT EXISTS (SELECT 1 FROM observation_events oe WHERE oe.event_id = t.event_id)
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
      SELECT ce.event_id, ce.source, ce.source_event_id, ce.phase, ce.signature_json, ce.summary,
        ce.capture_outcome, ce.related_event_id, e.session_id, e.occurred_at, e.exit_status
      FROM capture_events ce JOIN events e ON e.id = ce.event_id
      WHERE ce.source = ? AND ce.source_event_id = ?
    `).get(source, sourceEventId) as unknown as CaptureRow | undefined;
    return row === undefined ? undefined : captureFromRow(row);
  }

  private insertSession(session: Session | undefined, event: CapturedEventRecord): void {
    if (session !== undefined && (session.id !== event.sessionId || session.source !== event.source)) {
      throw new TypeError('Capture session does not match normalized event provenance.');
    }
    const existing = this.database.prepare('SELECT id, source, started_at, repository_id, workspace_id, user_id FROM sessions WHERE id = ?').get(event.sessionId) as unknown as SessionRow | undefined;
    if (existing === undefined) {
      if (session === undefined) throw new TypeError('Capture requires a new session record.');
      this.insertOrVerifySession(session);
      return;
    }
    if (existing.source !== event.source) throw new TypeError('Capture source conflicts with the existing session.');
    if (session !== undefined) this.assertSameSession(existing, session);
  }

  private insertOrVerifySession(session: Session): void {
    const existing = this.database.prepare('SELECT id, source, started_at, repository_id, workspace_id, user_id FROM sessions WHERE id = ?').get(session.id) as unknown as SessionRow | undefined;
    if (existing !== undefined) {
      this.assertSameSession(existing, session);
      return;
    }
    const validation = validateImport({ sessions: [session], events: [], observations: [], clusters: [], candidates: [], evidence: [], knowledge: [] });
    if (!validation.ok) throw new TypeError(`${validation.code}: ${validation.message}`);
    this.database.prepare('INSERT INTO sessions (id, source, started_at, repository_id, workspace_id, user_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(session.id, session.source, session.startedAt, session.repositoryId ?? null, session.workspaceId ?? null, session.userId ?? null);
  }

  private assertSameSession(row: SessionRow, session: Session): void {
    if (row.source !== session.source || row.started_at !== session.startedAt || row.repository_id !== (session.repositoryId ?? null)
      || row.workspace_id !== (session.workspaceId ?? null) || row.user_id !== (session.userId ?? null)) {
      throw new TypeError('Conflicting duplicate session identity.');
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
    const session = this.database.prepare('SELECT id, source, started_at, repository_id, workspace_id, user_id FROM sessions WHERE id = ?').get(event.sessionId) as unknown as SessionRow;
    const validation = validateImport({ sessions: [sessionFromRow(session)], events: [domainEvent], observations: [], clusters: [], candidates: [], evidence: [], knowledge: [] });
    if (!validation.ok) throw new TypeError(`${validation.code}: ${validation.message}`);
    this.database.prepare('INSERT INTO events (id, session_id, kind, occurred_at, tool, path, tags_json, outcome, exit_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(domainEvent.id, domainEvent.sessionId, domainEvent.kind, domainEvent.occurredAt, domainEvent.tool ?? null, domainEvent.path ?? null, '[]', domainEvent.outcome ?? null, domainEvent.exitStatus ?? null);
    this.database.prepare(`INSERT INTO capture_events
      (event_id, source, source_event_id, phase, signature_json, summary, capture_outcome, related_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.id, event.source, event.sourceEventId, event.phase, JSON.stringify(event.signature), event.summary, event.outcome ?? null, event.relatedEventId ?? null);
  }

  private insertCandidateCapture(event: CapturedEventRecord, bundle: NonNullable<IncrementalCaptureAppend['candidate']>): void {
    assertIncrementalCandidateResources(bundle);
    const candidateId = bundle.candidate.id as CandidateLessonId;
    const evidenceCandidateId = (bundle.evidence.candidateId ?? bundle.candidate.id) as CandidateLessonId;
    const sessionRow = this.database.prepare('SELECT id, source, started_at, repository_id, workspace_id, user_id FROM sessions WHERE id = ?').get(event.sessionId) as unknown as SessionRow;
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
    this.database.prepare('INSERT INTO observations (id, statement) VALUES (?, ?)').run(bundle.observation.id, bundle.observation.statement);
    this.database.prepare('INSERT INTO observation_events (observation_id, event_id, position) VALUES (?, ?, 0)').run(bundle.observation.id, event.id);
    this.database.prepare('INSERT INTO clusters (id) VALUES (?)').run(bundle.cluster.id);
    this.database.prepare('INSERT INTO cluster_observations (cluster_id, observation_id, position) VALUES (?, ?, 0)').run(bundle.cluster.id, bundle.observation.id);
    this.database.prepare('INSERT INTO candidates (id, cluster_id, kind, statement) VALUES (?, ?, ?, ?)').run(bundle.candidate.id, bundle.cluster.id, bundle.candidate.kind, bundle.candidate.statement);
    this.database.prepare('INSERT INTO evidence (id, candidate_id, polarity, summary, revalidates_to) VALUES (?, ?, ?, ?, NULL)')
      .run(bundle.evidence.id, evidenceCandidateId, bundle.evidence.polarity, bundle.evidence.summary);
  }

  private insertIncrementalEvidence(input: NonNullable<IncrementalCaptureAppend['evidence']>, transition: IncrementalCaptureAppend['transition']): void {
    const resolvedCandidateId = input.candidateId ?? this.candidateIdForKnowledge(transition?.knowledgeId);
    const evidence: Evidence = {
      id: input.id as EvidenceId, candidateId: resolvedCandidateId as CandidateLessonId,
      polarity: input.polarity, summary: input.summary,
      ...(input.revalidatesTo === undefined ? {} : { revalidatesTo: input.revalidatesTo })
    };
    const validation = validateIncrementalEvidence(evidence);
    if (!validation.ok) throw new TypeError(`${validation.code}: ${validation.message}`);
    const candidate = this.database.prepare('SELECT id FROM candidates WHERE id = ?').get(evidence.candidateId);
    if (candidate === undefined) throw new TypeError('Incremental evidence references a missing candidate.');
    this.database.prepare('INSERT INTO evidence (id, candidate_id, polarity, summary, revalidates_to) VALUES (?, ?, ?, ?, ?)')
      .run(evidence.id, evidence.candidateId, evidence.polarity, evidence.summary, evidence.revalidatesTo ?? null);
    if (transition === undefined) return;
    assertCanonicalTimestamp(transition.occurredAt);
    const row = this.database.prepare('SELECT id, candidate_id, state, statement FROM knowledge WHERE id = ?').get(transition.knowledgeId) as KnowledgeRow | undefined;
    if (row === undefined) throw new TypeError('Incremental transition references missing knowledge.');
    const current = this.toKnowledgeEntry(row);
    if (current.candidateId !== evidence.candidateId) throw new TypeError('Knowledge evidence must support its candidate.');
    const lifecycle = applyTransition(current, evidence, this.listTransitionHistory(transition.knowledgeId), transition.target);
    const attached = lifecycle.entry.evidenceIds.includes(evidence.id);
    if (!attached) throw new TypeError('Incremental evidence does not permit the requested lifecycle transition.');
    if (attached) {
      const position = current.evidenceIds.length;
      this.database.prepare('INSERT INTO knowledge_evidence (knowledge_id, evidence_id, position) VALUES (?, ?, ?)').run(row.id, evidence.id, position);
    }
    if (lifecycle.entry.state !== current.state) this.database.prepare('UPDATE knowledge SET state = ? WHERE id = ?').run(lifecycle.entry.state, row.id);
    for (const item of lifecycle.history.slice(this.listTransitionHistory(transition.knowledgeId).length)) {
      this.database.prepare('INSERT INTO knowledge_transition_history (knowledge_id, from_state, to_state, evidence_id, occurred_at) VALUES (?, ?, ?, ?, ?)')
        .run(row.id, item.from, item.to, item.evidenceId, transition.occurredAt);
    }
    if (evidence.polarity === 'contradicts') this.maybeCreateRevalidationProposal(row.id, transition.occurredAt);
  }

  private candidateIdForKnowledge(knowledgeId: string | undefined): string {
    if (knowledgeId === undefined) throw new TypeError('Incremental evidence requires a candidate or knowledge transition.');
    const row = this.database.prepare('SELECT candidate_id FROM knowledge WHERE id = ?').get(knowledgeId) as { candidate_id: string } | undefined;
    if (row === undefined) throw new TypeError('Capture evidence references missing knowledge.');
    return row.candidate_id;
  }

  private maybeCreateRevalidationProposal(knowledgeId: string, occurredAt: string): void {
    const count = (this.database.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_evidence ke JOIN evidence e ON e.id = ke.evidence_id
      WHERE ke.knowledge_id = ? AND e.polarity = 'contradicts'
    `).get(knowledgeId) as { count: number }).count;
    if (count < 2) return;
    const id = createHash('sha256').update('ael:revalidation-proposal:v1\0').update(knowledgeId).digest('hex');
    this.database.prepare(`INSERT INTO revalidation_proposals (id, knowledge_id, created_at, contradiction_count, status)
      VALUES (?, ?, ?, ?, 'proposed') ON CONFLICT (knowledge_id) DO NOTHING`)
      .run(id, knowledgeId, occurredAt, count);
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
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new TypeError('Transition timestamp must be canonical ISO time.');
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
    if (value.length < 1 || value.length > maximum) throw new TypeError(`Incremental ${field} exceeds its resource limit.`);
  }
}

function assertOnlyIncrementalKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) throw new TypeError(`Unsupported incremental field: ${unexpected}.`);
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
