import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { openExperienceDatabase } from '../storage/database.js';
import type { SessionEvidenceInput, SessionEvidenceReport } from './contracts.js';
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
      SELECT session_id, version, input_digest, created_at, report_json
      FROM session_evidence_reconstructions WHERE session_id = ? ORDER BY version DESC LIMIT 1
    `).get(sessionId) as unknown as ReconstructionRow | undefined;
    return row === undefined ? undefined : storedFromRow(row);
  }

  history(sessionId: string): readonly StoredSessionEvidence[] {
    assertIdentifier(sessionId);
    const rows = this.database.prepare(`
      SELECT session_id, version, input_digest, created_at, report_json
      FROM session_evidence_reconstructions WHERE session_id = ? ORDER BY version
    `).all(sessionId) as unknown as ReconstructionRow[];
    return Object.freeze(rows.map(storedFromRow));
  }

  private rowByDigest(sessionId: string, inputDigest: string): ReconstructionRow | undefined {
    return this.database.prepare(`
      SELECT session_id, version, input_digest, created_at, report_json
      FROM session_evidence_reconstructions WHERE session_id = ? AND input_digest = ?
    `).get(sessionId, inputDigest) as unknown as ReconstructionRow | undefined;
  }
}

function storedFromRow(row: ReconstructionRow): StoredSessionEvidence {
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
