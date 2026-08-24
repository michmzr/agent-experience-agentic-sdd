import type { DatabaseSync } from 'node:sqlite';

import { posix } from 'node:path';

import type { ExperienceImport, KnowledgeEntry, KnowledgeId, KnowledgeMetadata, KnowledgeState } from '../domain/types.js';
import { validateImport } from '../domain/validation.js';
import { openExperienceDatabase } from './database.js';

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
      for (const item of record.knowledge) {
        knowledge.run(item.id, item.candidateId, item.state, item.statement);
        item.evidenceIds.forEach((evidenceId, position) => knowledgeEvidence.run(item.id, evidenceId, position));
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
    if (row.scope === 'repository' && row.repository_id !== filter.repositoryId) return false;
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
