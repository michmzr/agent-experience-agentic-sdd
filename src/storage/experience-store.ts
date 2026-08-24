import type { DatabaseSync } from 'node:sqlite';

import type { ExperienceImport, KnowledgeEntry, KnowledgeId } from '../domain/types.js';
import { validateImport } from '../domain/validation.js';
import { openExperienceDatabase } from './database.js';

interface KnowledgeRow {
  id: string;
  candidate_id: string;
  state: KnowledgeEntry['state'];
  statement: string;
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

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const sessions = this.database.prepare('INSERT INTO sessions (id, source, started_at, repository_id, workspace_id, user_id) VALUES (?, ?, ?, ?, ?, ?)');
      for (const item of record.sessions) sessions.run(item.id, item.source, item.startedAt, item.repositoryId ?? null, item.workspaceId ?? null, item.userId ?? null);
      const events = this.database.prepare('INSERT INTO events (id, session_id, kind, occurred_at, tool, path, outcome, exit_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const item of record.events) events.run(item.id, item.sessionId, item.kind, item.occurredAt, item.tool ?? null, item.path ?? null, item.outcome ?? null, item.exitStatus ?? null);
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

  // Task 4 will provide ranked retrieval. This conservative result cannot expose unrelated private data.
  retrieve(_query: string): KnowledgeEntry[] {
    return [];
  }

  // Task 4 will define retention policy and protected-state semantics.
  expireUnprotected(_now: string): number {
    return 0;
  }

  private migrate(): void {
    this.database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = this.database.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(1);
    if (applied) return;

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(schemaMigration);
      this.database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
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
}
