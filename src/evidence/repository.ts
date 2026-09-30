import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { openExperienceDatabase } from '../storage/database.js';
import type { SessionEvidenceInput, SessionEvidenceReport, TypedAnnotationArtifact } from './contracts.js';
import { reconstructSessionEvidence } from './reconstructor.js';

const identifierPattern = /^[A-Za-z0-9._:/-]{1,512}$/;

const migration = `
  CREATE TABLE IF NOT EXISTS session_evidence_reconstructions (
    session_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    input_digest TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    report_json TEXT NOT NULL,
    PRIMARY KEY (session_id, version),
    UNIQUE (session_id, input_digest)
  );
`;

interface ReconstructionRow {
  session_id: string;
  version: number;
  input_digest: string;
  schema_version: number;
  created_at: string;
  report_json: string;
}

export interface StoredSessionEvidence {
  readonly sessionId: string;
  readonly version: number;
  readonly inputDigest: string;
  readonly createdAt: string;
  readonly report: SessionEvidenceReport;
}

export class SessionEvidenceRepository {
  private readonly database: DatabaseSync;

  constructor(databasePath?: string, private readonly now: () => string = () => new Date().toISOString()) {
    this.database = openExperienceDatabase(databasePath);
    this.database.exec(migration);
  }

  close(): void {
    this.database.close();
  }

  save(input: SessionEvidenceInput): StoredSessionEvidence {
    const report = reconstructSessionEvidence(input);
    const reportJson = JSON.stringify(report);
    const inputDigest = createHash('sha256').update(reportJson).digest('hex');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.rowByDigest(input.sessionId, inputDigest);
      if (existing !== undefined) {
        this.database.exec('COMMIT');
        return storedFromRow(existing);
      }
      const version = Number((this.database.prepare(`
        SELECT COALESCE(MAX(version), 0) + 1 AS next_version
        FROM session_evidence_reconstructions WHERE session_id = ?
      `).get(input.sessionId) as { next_version: number }).next_version);
      const createdAt = this.now();
      assertCanonicalTimestamp(createdAt);
      this.database.prepare(`
        INSERT INTO session_evidence_reconstructions
          (session_id, version, input_digest, schema_version, created_at, report_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(input.sessionId, version, inputDigest, report.schemaVersion, createdAt, reportJson);
      this.database.exec('COMMIT');
      return deepFreeze({ sessionId: input.sessionId, version, inputDigest, createdAt, report });
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  latest(sessionId: string): StoredSessionEvidence | undefined {
    assertIdentifier(sessionId);
    const row = this.database.prepare(`
      SELECT session_id, version, input_digest, schema_version, created_at, report_json
      FROM session_evidence_reconstructions WHERE session_id = ? ORDER BY version DESC LIMIT 1
    `).get(sessionId) as unknown as ReconstructionRow | undefined;
    return row === undefined ? undefined : storedFromRow(row);
  }

  history(sessionId: string): readonly StoredSessionEvidence[] {
    assertIdentifier(sessionId);
    const rows = this.database.prepare(`
      SELECT session_id, version, input_digest, schema_version, created_at, report_json
      FROM session_evidence_reconstructions WHERE session_id = ? ORDER BY version
    `).all(sessionId) as unknown as ReconstructionRow[];
    return Object.freeze(rows.map(storedFromRow));
  }

  private rowByDigest(sessionId: string, inputDigest: string): ReconstructionRow | undefined {
    return this.database.prepare(`
      SELECT session_id, version, input_digest, schema_version, created_at, report_json
      FROM session_evidence_reconstructions WHERE session_id = ? AND input_digest = ?
    `).get(sessionId, inputDigest) as unknown as ReconstructionRow | undefined;
  }
}

const typedImportMigration = `
  CREATE TABLE IF NOT EXISTS imported_typed_evidence (
    producer_namespace TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
    evidence_id TEXT NOT NULL,
    producer_version TEXT NOT NULL,
    context_revision TEXT NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN ('user-declared', 'agent-claimed')),
    kind TEXT NOT NULL,
    resolution TEXT NOT NULL CHECK(resolution IN ('resolved', 'pending')),
    operation_source TEXT NOT NULL,
    operation_source_event_id TEXT NOT NULL,
    content_digest TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    retained_at TEXT NOT NULL,
    PRIMARY KEY (producer_namespace, repository_id, session_id, evidence_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS imported_typed_evidence_pending
    ON imported_typed_evidence(repository_id, session_id, resolution);
`;

export class ImportedTypedEvidenceRepository {
  private readonly database: DatabaseSync;

  constructor(databasePath: string, private readonly now: () => string = () => new Date().toISOString()) {
    this.database = openExperienceDatabase(databasePath);
    this.database.exec(typedImportMigration);
  }

  close(): void { this.database.close(); }

  save(artifact: TypedAnnotationArtifact) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const registered = this.database.prepare('SELECT 1 FROM repositories WHERE repository_id = ?').get(artifact.repositoryId);
      const session = this.database.prepare('SELECT repository_id FROM sessions WHERE id = ?').get(artifact.sessionId) as {
        repository_id: string | null;
      } | undefined;
      if (!registered || session?.repository_id !== artifact.repositoryId) throw new TypeError('Annotation repository or session scope is invalid.');
      const rows = artifact.records.map((record) => {
        const payloadJson = JSON.stringify({ producerKind: artifact.producer.kind, producerVersion: artifact.producer.version,
          contextRevision: artifact.contextRevision, ...record });
        const digest = createHash('sha256').update(payloadJson).digest('hex');
        const existing = this.database.prepare(`SELECT content_digest FROM imported_typed_evidence WHERE producer_namespace = ?
          AND repository_id = ? AND session_id = ? AND evidence_id = ?`)
          .get(artifact.producer.namespace, artifact.repositoryId, artifact.sessionId, record.id) as { content_digest: string } | undefined;
        if (existing && existing.content_digest !== digest) throw new TypeError('Annotation evidence identity conflicts with retained content.');
        const matches = this.database.prepare(`SELECT l.session_id, s.repository_id, COALESCE(ce.phase, re.phase) AS phase
          FROM logical_evidence l JOIN sessions s ON s.id = l.session_id
          LEFT JOIN capture_events ce ON l.path = 'legacy' AND ce.event_id = l.event_id
          LEFT JOIN capture_run_events re ON l.path = 'run' AND re.event_id = l.event_id
          WHERE l.source = ? AND l.source_event_id = ?`).all(record.operation.source, record.operation.sourceEventId) as Array<{
            session_id: string; repository_id: string | null; phase: string | null;
          }>;
        const own = matches.find((match) => match.session_id === artifact.sessionId && match.repository_id === artifact.repositoryId);
        if (own && own.phase !== 'pre-action') throw new TypeError('Annotation must reference a retained operation request.');
        if (!own && matches.length > 0) throw new TypeError('Annotation operation reference crosses repository or session scope.');
        if (!own) {
          const physical = this.database.prepare(`SELECT session_id, phase FROM (
            SELECT e.session_id, ce.phase FROM capture_events ce JOIN events e ON e.id = ce.event_id
              WHERE ce.source = ? AND ce.source_event_id = ?
            UNION ALL
            SELECT re.conversation_id AS session_id, re.phase FROM capture_run_events re
              WHERE re.source = ? AND re.source_event_id = ?
          )`).all(record.operation.source, record.operation.sourceEventId,
            record.operation.source, record.operation.sourceEventId) as Array<{ session_id: string; phase: string }>;
          if (physical.some(({ session_id }) => session_id !== artifact.sessionId)) {
            throw new TypeError('Annotation operation reference crosses session scope.');
          }
          if (physical.some(({ phase }) => phase !== 'pre-action')) {
            throw new TypeError('Annotation must reference an operation request.');
          }
        }
        return { record, payloadJson, digest, existing, resolution: own ? 'resolved' : 'pending' } as const;
      });
      let retained = 0;
      let pending = 0;
      const retainedAt = this.now();
      assertCanonicalTimestamp(retainedAt);
      for (const row of rows) {
        if (row.resolution === 'pending') pending++;
        if (row.existing) {
          this.database.prepare(`UPDATE imported_typed_evidence SET resolution = ? WHERE producer_namespace = ?
            AND repository_id = ? AND session_id = ? AND evidence_id = ?`).run(row.resolution, artifact.producer.namespace,
              artifact.repositoryId, artifact.sessionId, row.record.id);
          continue;
        }
        this.database.prepare(`INSERT INTO imported_typed_evidence
          (producer_namespace, repository_id, session_id, evidence_id, producer_version, context_revision, origin, kind,
           resolution, operation_source, operation_source_event_id, content_digest, payload_json, retained_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(artifact.producer.namespace, artifact.repositoryId,
            artifact.sessionId, row.record.id, artifact.producer.version, artifact.contextRevision, row.record.origin,
            row.record.kind, row.resolution, row.record.operation.source, row.record.operation.sourceEventId,
            row.digest, row.payloadJson, retainedAt);
        retained++;
      }
      this.database.exec('COMMIT');
      return Object.freeze({ version: 1 as const, repositoryId: artifact.repositoryId, sessionId: artifact.sessionId,
        received: artifact.records.length, retained, pending });
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
}

function storedFromRow(row: ReconstructionRow): StoredSessionEvidence {
  if (row.schema_version !== 1 || createHash('sha256').update(row.report_json).digest('hex') !== row.input_digest) {
    throw new Error('Session evidence history integrity check failed.');
  }
  const report = JSON.parse(row.report_json) as SessionEvidenceReport;
  return deepFreeze({
    sessionId: row.session_id,
    version: row.version,
    inputDigest: row.input_digest,
    createdAt: row.created_at,
    report
  });
}

function assertIdentifier(value: string): void {
  if (!identifierPattern.test(value)) throw new TypeError('Session identity is invalid.');
}

function assertCanonicalTimestamp(value: string): void {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw new TypeError('Reconstruction timestamp is invalid.');
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
