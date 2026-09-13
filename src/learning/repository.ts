import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { openExperienceDatabase } from '../storage/database.js';
import { createLearningCandidate, createOperationalEpisode, type AnalysisCoverage, type LearningCandidate, type OperationalEpisode, type OperationalFinding } from './contracts.js';

export const DETECTOR_SET_VERSION = 'm6-deterministic@1';
// Legacy jobs were produced exclusively by this detector set, regardless of future defaults.
const LEGACY_DETECTOR_SET_VERSION = 'm6-deterministic@1';
const emptyCheckpointJson = '{"version":1,"pendingEvents":[]}';

const streamSchema = `
  CREATE TABLE IF NOT EXISTS operational_analysis_schema (version INTEGER PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS operational_analysis_streams (
    repository_id TEXT NOT NULL, session_id TEXT NOT NULL, detector_set_version TEXT NOT NULL,
    committed_high_water INTEGER NOT NULL, processed_high_water INTEGER NOT NULL DEFAULT 0,
    checkpoint_json TEXT NOT NULL DEFAULT '${emptyCheckpointJson}', next_generation INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(repository_id, session_id, detector_set_version)
  );
  CREATE TABLE IF NOT EXISTS operational_analysis_diagnostics (
    code TEXT PRIMARY KEY, occurrences INTEGER NOT NULL, last_at TEXT NOT NULL
  );
`;

function jobsSchema(table: 'operational_analysis_jobs' | 'operational_analysis_jobs_next'): string {
  return `CREATE TABLE ${table} (
    id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, session_id TEXT NOT NULL, detector_set_version TEXT NOT NULL,
    input_low_water INTEGER NOT NULL, input_high_water INTEGER NOT NULL, processed_high_water INTEGER NOT NULL,
    state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry_after TEXT, lease_owner TEXT,
    lease_expires_at TEXT, failure_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    FOREIGN KEY(repository_id, session_id, detector_set_version)
      REFERENCES operational_analysis_streams(repository_id, session_id, detector_set_version)
  )`;
}

const jobIndexes = `
  CREATE UNIQUE INDEX IF NOT EXISTS operational_analysis_one_pending
    ON operational_analysis_jobs(repository_id, session_id, detector_set_version)
    WHERE state IN ('pending', 'retryable-failure');
  CREATE UNIQUE INDEX IF NOT EXISTS operational_analysis_one_running
    ON operational_analysis_jobs(repository_id, session_id, detector_set_version) WHERE state = 'running';
`;

const resultSchema = `
  CREATE TABLE IF NOT EXISTS operational_episodes (
    id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, session_id TEXT NOT NULL, detector TEXT NOT NULL, state TEXT NOT NULL,
    evidence_json TEXT NOT NULL, payload_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS operational_findings (
    id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES operational_episodes(id), kind TEXT NOT NULL, evidence_json TEXT NOT NULL, statement TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS operational_candidates (
    id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES operational_episodes(id), kind TEXT NOT NULL, state TEXT NOT NULL,
    statement TEXT NOT NULL, conditions_json TEXT NOT NULL, procedure_json TEXT NOT NULL, invalidation_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS operational_candidate_evidence (
    candidate_id TEXT NOT NULL REFERENCES operational_candidates(id), event_id TEXT NOT NULL, polarity TEXT NOT NULL,
    PRIMARY KEY(candidate_id, event_id)
  );
  CREATE TABLE IF NOT EXISTS operational_analysis_coverage (
    job_id TEXT NOT NULL REFERENCES operational_analysis_jobs(id), detector TEXT NOT NULL, status TEXT NOT NULL,
    examined_events INTEGER NOT NULL, findings INTEGER NOT NULL, PRIMARY KEY(job_id, detector)
  );
`;

export interface AnalysisAdmission { readonly repositoryId: string; readonly sessionId: string; readonly inputHighWater: number; readonly detectorSetVersion?: string; }
export interface AnalysisStream {
  readonly repositoryId: string; readonly sessionId: string; readonly detectorSetVersion: string;
  readonly committedHighWater: number; readonly processedHighWater: number;
  readonly checkpoint: { readonly version: number; readonly pendingEvents: readonly unknown[] };
}
export interface AnalysisJob {
  readonly id: string; readonly repositoryId: string; readonly sessionId: string; readonly detectorSetVersion: string;
  readonly inputLowWater: number; readonly inputHighWater: number; readonly processedHighWater: number;
  readonly state: 'pending' | 'running' | 'completed' | 'retryable-failure' | 'quarantined-input'; readonly attempts: number;
  readonly retryAfter: string | null; readonly leaseOwner: string | null; readonly leaseExpiresAt: string | null; readonly failureReason: string | null;
}
interface StreamRow {
  repository_id: string; session_id: string; detector_set_version: string; committed_high_water: number;
  processed_high_water: number; checkpoint_json: string; next_generation: number;
}
interface JobRow {
  id: string; repository_id: string; session_id: string; detector_set_version: string;
  input_low_water: number; input_high_water: number; processed_high_water: number;
  state: AnalysisJob['state']; attempts: number; retry_after: string | null; lease_owner: string | null;
  lease_expires_at: string | null; failure_reason: string | null; created_at: string; updated_at: string;
}
export interface LearningResult { readonly episodes: readonly OperationalEpisode[]; readonly findings: readonly OperationalFinding[]; readonly candidates: readonly LearningCandidate[]; readonly coverage?: readonly AnalysisCoverage[]; }
export interface OperationalLearningReport { readonly candidates: readonly (Omit<LearningCandidate, 'state'> & { readonly state: 'candidate' | 'disputed' })[]; readonly findings: readonly OperationalFinding[]; readonly episodes: readonly OperationalEpisode[]; readonly coverage: readonly AnalysisCoverage[]; }

export class OperationalLearningRepository {
  private readonly database: DatabaseSync;
  constructor(databasePath?: string, private readonly now: () => string = () => new Date().toISOString()) {
    this.database = openExperienceDatabase(databasePath);
    try { this.initialize(); } catch (error) { this.database.close(); throw error; }
  }
  close(): void { this.database.close(); }

  enqueue(input: AnalysisAdmission): AnalysisJob | undefined {
    const version = input.detectorSetVersion ?? DETECTOR_SET_VERSION;
    assertStreamIdentity(input.repositoryId, input.sessionId, version);
    if (!Number.isSafeInteger(input.inputHighWater) || input.inputHighWater < 0) throw new TypeError('Analysis high-water is invalid.');
    const timestamp = this.now();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const isNewStream = this.streamRow(input.repositoryId, input.sessionId, version) === undefined;
      this.database.prepare(`INSERT INTO operational_analysis_streams
        (repository_id, session_id, detector_set_version, committed_high_water, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(repository_id, session_id, detector_set_version) DO UPDATE SET
        committed_high_water = MAX(committed_high_water, excluded.committed_high_water), updated_at = excluded.updated_at`)
        .run(input.repositoryId, input.sessionId, version, input.inputHighWater, timestamp, timestamp);
      const stream = this.streamRow(input.repositoryId, input.sessionId, version)!;
      const pending = this.database.prepare(`SELECT id FROM operational_analysis_jobs WHERE repository_id = ? AND session_id = ?
        AND detector_set_version = ? AND state IN ('pending', 'retryable-failure')`).get(input.repositoryId, input.sessionId, version) as { id: string } | undefined;
      let job: AnalysisJob | undefined;
      if (pending) {
        this.database.prepare('UPDATE operational_analysis_jobs SET input_high_water = MAX(input_high_water, ?), updated_at = ? WHERE id = ?')
          .run(stream.committed_high_water, timestamp, pending.id);
        job = this.jobById(pending.id);
      } else {
        const running = this.database.prepare(`SELECT input_high_water FROM operational_analysis_jobs WHERE repository_id = ? AND session_id = ?
          AND detector_set_version = ? AND state = 'running'`).get(input.repositoryId, input.sessionId, version) as { input_high_water: number } | undefined;
        // Repository conventions also need one initial analysis when the stream contains no events.
        if (isNewStream || stream.committed_high_water > Math.max(stream.processed_high_water, running?.input_high_water ?? 0)) {
          job = this.insertPendingJob(stream, timestamp);
        }
      }
      this.database.exec('COMMIT');
      return job;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  stream(repositoryId: string, sessionId: string, detectorSetVersion = DETECTOR_SET_VERSION): AnalysisStream | undefined {
    assertStreamIdentity(repositoryId, sessionId, detectorSetVersion);
    const row = this.streamRow(repositoryId, sessionId, detectorSetVersion);
    if (!row) return undefined;
    return Object.freeze({ repositoryId, sessionId, detectorSetVersion, committedHighWater: row.committed_high_water,
      processedHighWater: row.processed_high_water, checkpoint: freezeJson(JSON.parse(row.checkpoint_json)) as AnalysisStream['checkpoint'] });
  }

  jobsForStream(repositoryId: string, sessionId: string, detectorSetVersion = DETECTOR_SET_VERSION): readonly AnalysisJob[] {
    assertStreamIdentity(repositoryId, sessionId, detectorSetVersion);
    return Object.freeze(this.database.prepare(`SELECT * FROM operational_analysis_jobs WHERE repository_id = ? AND session_id = ?
      AND detector_set_version = ? ORDER BY created_at, id`).all(repositoryId, sessionId, detectorSetVersion).map((row) => this.job(row)));
  }

  claim(repositoryId?: string): AnalysisJob | undefined {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.database.prepare(`SELECT j.* FROM operational_analysis_jobs j WHERE j.state IN ('pending', 'retryable-failure')
        ${repositoryId === undefined ? '' : 'AND j.repository_id = ?'} AND NOT EXISTS (
          SELECT 1 FROM operational_analysis_jobs running WHERE running.repository_id = j.repository_id AND running.session_id = j.session_id
          AND running.detector_set_version = j.detector_set_version AND running.state = 'running') ORDER BY j.created_at, j.id LIMIT 1`).get(...(repositoryId === undefined ? [] : [repositoryId]));
      if (!row) { this.database.exec('COMMIT'); return undefined; }
      this.database.prepare(`UPDATE operational_analysis_jobs SET state = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?`).run(this.now(), (row as { id: string }).id);
      const claimed = this.job(this.database.prepare(`SELECT * FROM operational_analysis_jobs WHERE id = ?`).get((row as { id: string }).id));
      this.database.exec('COMMIT'); return claimed;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  retry(jobId: string, reason: 'execution-failure' | 'timeout' | 'invalid-input' = 'execution-failure'): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const job = this.jobById(jobId);
      if (!job || job.state !== 'running') throw new TypeError('Analysis job is not running.');
      const state = reason === 'invalid-input' || job.attempts >= 4 ? 'quarantined-input' : 'retryable-failure';
      let highWater = job.inputHighWater;
      if (state === 'retryable-failure') {
        const pending = this.database.prepare(`SELECT id, input_high_water FROM operational_analysis_jobs
          WHERE repository_id = ? AND session_id = ? AND detector_set_version = ? AND state IN ('pending', 'retryable-failure')`)
          .get(job.repositoryId, job.sessionId, job.detectorSetVersion) as { id: string; input_high_water: number } | undefined;
        if (pending) {
          highWater = Math.max(highWater, pending.input_high_water);
          this.database.prepare('DELETE FROM operational_analysis_jobs WHERE id = ?').run(pending.id);
        }
      }
      this.database.prepare(`UPDATE operational_analysis_jobs SET state = ?, input_high_water = ?, failure_reason = ?, updated_at = ? WHERE id = ?`)
        .run(state, highWater, reason, this.now(), jobId);
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  jobById(id: string): AnalysisJob | undefined {
    const row = this.database.prepare(`SELECT * FROM operational_analysis_jobs WHERE id = ?`).get(id);
    return row === undefined ? undefined : this.job(row);
  }

  saveResult(jobId: string, result: LearningResult): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const job = this.job(this.database.prepare(`SELECT * FROM operational_analysis_jobs WHERE id = ?`).get(jobId));
      if (job.state !== 'running') throw new TypeError('Analysis job is not running.');
      for (const rawEpisode of result.episodes) {
        const episode = createOperationalEpisode(rawEpisode);
        if (episode.repositoryId !== job.repositoryId || episode.sessionId !== job.sessionId) throw new TypeError('Episode scope conflicts with job.');
        this.database.prepare(`INSERT INTO operational_episodes (id, repository_id, session_id, detector, state, evidence_json, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, evidence_json = excluded.evidence_json, payload_json = excluded.payload_json`).run(episode.id, job.repositoryId, job.sessionId, episode.detector, episode.state, JSON.stringify(episode.evidenceEventIds), JSON.stringify(episode));
      }
      for (const finding of result.findings) this.database.prepare(`INSERT INTO operational_findings (id, episode_id, kind, evidence_json, statement) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).run(finding.id, finding.episodeId, finding.kind, JSON.stringify(finding.evidenceEventIds), finding.statement);
      for (const rawCandidate of result.candidates) {
        const candidate = createLearningCandidate(rawCandidate);
        this.database.prepare(`INSERT INTO operational_candidates (id, episode_id, kind, state, statement, conditions_json, procedure_json, invalidation_json) VALUES (?, ?, ?, 'candidate', ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).run(candidate.id, candidate.episodeId, candidate.kind, candidate.statement, JSON.stringify(candidate.conditions), JSON.stringify(candidate.procedure), JSON.stringify(candidate.invalidationConditions));
        for (const eventId of candidate.evidenceEventIds) this.database.prepare(`INSERT OR IGNORE INTO operational_candidate_evidence (candidate_id, event_id, polarity) VALUES (?, ?, 'confirms')`).run(candidate.id, eventId);
      }
      for (const coverage of result.coverage ?? []) {
        this.database.prepare(`INSERT INTO operational_analysis_coverage (job_id, detector, status, examined_events, findings) VALUES (?, ?, ?, ?, ?) ON CONFLICT(job_id, detector) DO UPDATE SET status = excluded.status, examined_events = excluded.examined_events, findings = excluded.findings`).run(jobId, coverage.detector, coverage.status, coverage.examinedEvents, coverage.findings);
      }
      const timestamp = this.now();
      this.database.prepare(`UPDATE operational_analysis_jobs SET state = 'completed', processed_high_water = input_high_water, updated_at = ? WHERE id = ?`).run(timestamp, jobId);
      this.database.prepare(`UPDATE operational_analysis_streams SET processed_high_water = MAX(processed_high_water, ?), updated_at = ?
        WHERE repository_id = ? AND session_id = ? AND detector_set_version = ?`).run(job.inputHighWater, timestamp, job.repositoryId, job.sessionId, job.detectorSetVersion);
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  contradict(candidateId: string, eventId: string): void { this.database.prepare(`INSERT OR IGNORE INTO operational_candidate_evidence (candidate_id, event_id, polarity) VALUES (?, ?, 'contradicts')`).run(candidateId, eventId); this.database.prepare(`UPDATE operational_candidates SET state = 'disputed' WHERE id = ?`).run(candidateId); }

  report(repositoryId: string): OperationalLearningReport {
    const episodes = (this.database.prepare(`SELECT payload_json FROM operational_episodes WHERE repository_id = ? ORDER BY id`).all(repositoryId) as Array<{ payload_json: string }>).map(({ payload_json }) => JSON.parse(payload_json) as OperationalEpisode);
    const findings = (this.database.prepare(`SELECT f.id, f.episode_id, f.kind, f.evidence_json, f.statement FROM operational_findings f JOIN operational_episodes e ON e.id = f.episode_id WHERE e.repository_id = ? ORDER BY f.id`).all(repositoryId) as Array<{ id: string; episode_id: string; kind: OperationalFinding['kind']; evidence_json: string; statement: string }>).map((row) => Object.freeze({ id: row.id, episodeId: row.episode_id, kind: row.kind, evidenceEventIds: Object.freeze(JSON.parse(row.evidence_json) as string[]), statement: row.statement }));
    const candidates = (this.database.prepare(`SELECT c.id, c.episode_id, c.kind, c.state, c.statement, c.conditions_json, c.procedure_json, c.invalidation_json FROM operational_candidates c JOIN operational_episodes e ON e.id = c.episode_id WHERE e.repository_id = ? ORDER BY c.id`).all(repositoryId) as Array<{ id: string; episode_id: string; kind: LearningCandidate['kind']; state: 'candidate' | 'disputed'; statement: string; conditions_json: string; procedure_json: string; invalidation_json: string }>).map((row) => Object.freeze({ id: row.id, episodeId: row.episode_id, kind: row.kind, state: row.state, statement: row.statement, conditions: Object.freeze(JSON.parse(row.conditions_json) as string[]), procedure: Object.freeze(JSON.parse(row.procedure_json) as string[]), evidenceEventIds: Object.freeze((this.database.prepare(`SELECT event_id FROM operational_candidate_evidence WHERE candidate_id = ? ORDER BY event_id`).all(row.id) as Array<{ event_id: string }>).map(({ event_id }) => event_id)), invalidationConditions: Object.freeze(JSON.parse(row.invalidation_json) as string[]) }));
    const coverage = (this.database.prepare(`SELECT c.detector, c.status, c.examined_events, c.findings FROM operational_analysis_coverage c JOIN operational_analysis_jobs j ON j.id = c.job_id WHERE j.repository_id = ? ORDER BY c.detector, j.id`).all(repositoryId) as Array<{ detector: string; status: AnalysisCoverage['status']; examined_events: number; findings: number }>).map((row) => Object.freeze({ detector: row.detector, status: row.status, examinedEvents: row.examined_events, findings: row.findings }));
    return Object.freeze({ episodes: Object.freeze(episodes), findings: Object.freeze(findings), candidates: Object.freeze(candidates), coverage: Object.freeze(coverage) });
  }

  private initialize(): void {
    // Rebuild the parent table without rewriting or cascading existing coverage foreign keys.
    // SQLite requires changing foreign_keys before starting the migration transaction.
    this.database.exec('PRAGMA foreign_keys = OFF');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(streamSchema);
      const versions = this.database.prepare('SELECT version FROM operational_analysis_schema').all() as Array<{ version: number }>;
      if (versions.length > 1 || (versions.length === 1 && versions[0]!.version !== 1)) throw new TypeError('Unsupported operational analysis schema version.');
      if (versions.length === 0) {
        const exists = this.database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'operational_analysis_jobs'`).get();
        if (exists) this.migrateLegacyJobs();
        else this.database.exec(jobsSchema('operational_analysis_jobs'));
        this.database.exec(jobIndexes);
        this.database.exec(resultSchema);
        if (this.database.prepare('PRAGMA foreign_key_check').all().length > 0) throw new TypeError('Operational analysis migration violates foreign keys.');
        this.database.prepare('INSERT INTO operational_analysis_schema(version) VALUES (1)').run();
      }
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    finally { this.database.exec('PRAGMA foreign_keys = ON'); }
  }

  private migrateLegacyJobs(): void {
    const columns = this.database.prepare('PRAGMA table_info(operational_analysis_jobs)').all().map((row) => row.name);
    if (columns.join(',') !== 'id,repository_id,session_id,input_high_water,state,attempts,created_at,updated_at') {
      throw new TypeError('Unsupported legacy operational analysis schema.');
    }
    const streams = this.database.prepare(`SELECT repository_id, session_id, MAX(input_high_water) AS committed_high_water,
      MAX(CASE WHEN state = 'completed' THEN input_high_water ELSE 0 END) AS processed_high_water,
      MIN(created_at) AS created_at, MAX(updated_at) AS updated_at,
      MAX(CASE WHEN state IN ('pending', 'running', 'retryable-failure') THEN input_high_water ELSE 0 END) AS outstanding_high_water,
      MAX(CASE WHEN state IN ('pending', 'running', 'retryable-failure') THEN 1 ELSE 0 END) AS has_outstanding,
      MAX(CASE WHEN state = 'completed' THEN 1 ELSE 0 END) AS has_completed,
      MAX(CASE WHEN state = 'running' THEN 1 ELSE 0 END) AS was_running,
      MAX(CASE WHEN state IN ('pending', 'running', 'retryable-failure') THEN attempts ELSE 0 END) AS attempts
      FROM operational_analysis_jobs GROUP BY repository_id, session_id`).all() as unknown as Array<{
        repository_id: string; session_id: string; committed_high_water: number; processed_high_water: number;
        created_at: string; updated_at: string; outstanding_high_water: number; has_outstanding: number;
        has_completed: number; was_running: number; attempts: number;
      }>;
    for (const stream of streams) {
      this.database.prepare(`INSERT INTO operational_analysis_streams
        (repository_id, session_id, detector_set_version, committed_high_water, processed_high_water, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(stream.repository_id, stream.session_id, LEGACY_DETECTOR_SET_VERSION,
          stream.committed_high_water, stream.processed_high_water, stream.created_at, stream.updated_at);
    }
    this.database.exec(jobsSchema('operational_analysis_jobs_next'));
    this.database.prepare(`INSERT INTO operational_analysis_jobs_next
      (id, repository_id, session_id, detector_set_version, input_low_water, input_high_water, processed_high_water,
       state, attempts, created_at, updated_at)
      SELECT id, repository_id, session_id, ?, 0, input_high_water, CASE WHEN state = 'completed' THEN input_high_water ELSE 0 END,
        state, attempts, created_at, updated_at FROM operational_analysis_jobs WHERE state IN ('completed', 'quarantined-input')`)
      .run(LEGACY_DETECTOR_SET_VERSION);
    this.database.exec('DROP TABLE operational_analysis_jobs');
    this.database.exec('ALTER TABLE operational_analysis_jobs_next RENAME TO operational_analysis_jobs');
    for (const legacy of streams) {
      if (!legacy.has_outstanding || (legacy.has_completed && legacy.outstanding_high_water <= legacy.processed_high_water)) continue;
      const stream = this.streamRow(legacy.repository_id, legacy.session_id, LEGACY_DETECTOR_SET_VERSION)!;
      const job = this.insertPendingJob({ ...stream, committed_high_water: legacy.outstanding_high_water }, legacy.updated_at);
      this.database.prepare('UPDATE operational_analysis_jobs SET state = ?, attempts = ? WHERE id = ?')
        .run(legacy.was_running ? 'retryable-failure' : 'pending', legacy.attempts, job.id);
    }
  }

  private streamRow(repositoryId: string, sessionId: string, detectorSetVersion: string): StreamRow | undefined {
    return this.database.prepare(`SELECT * FROM operational_analysis_streams WHERE repository_id = ? AND session_id = ?
      AND detector_set_version = ?`).get(repositoryId, sessionId, detectorSetVersion) as unknown as StreamRow | undefined;
  }

  private insertPendingJob(stream: StreamRow, timestamp: string): AnalysisJob {
    if (!Number.isSafeInteger(stream.next_generation) || stream.next_generation >= Number.MAX_SAFE_INTEGER) throw new TypeError('Analysis generation is exhausted.');
    const id = createHash('sha256').update(JSON.stringify([stream.repository_id, stream.session_id, stream.detector_set_version, stream.next_generation])).digest('hex');
    this.database.prepare(`UPDATE operational_analysis_streams SET next_generation = next_generation + 1 WHERE repository_id = ?
      AND session_id = ? AND detector_set_version = ?`).run(stream.repository_id, stream.session_id, stream.detector_set_version);
    this.database.prepare(`INSERT INTO operational_analysis_jobs
      (id, repository_id, session_id, detector_set_version, input_low_water, input_high_water, processed_high_water, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(id, stream.repository_id, stream.session_id, stream.detector_set_version,
        stream.processed_high_water, stream.committed_high_water, stream.processed_high_water, timestamp, timestamp);
    return this.jobById(id)!;
  }

  private job(row: unknown): AnalysisJob {
    if (!row) throw new TypeError('Analysis job was not found.');
    const value = row as JobRow;
    return Object.freeze({ id: value.id, repositoryId: value.repository_id, sessionId: value.session_id,
      detectorSetVersion: value.detector_set_version, inputLowWater: value.input_low_water, inputHighWater: value.input_high_water,
      processedHighWater: value.processed_high_water, state: value.state, attempts: value.attempts,
      retryAfter: value.retry_after, leaseOwner: value.lease_owner, leaseExpiresAt: value.lease_expires_at, failureReason: value.failure_reason });
  }
}

function assertStreamIdentity(repositoryId: string, sessionId: string, detectorSetVersion: string): void {
  for (const value of [repositoryId, sessionId, detectorSetVersion]) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9._:@/-]{1,512}$/.test(value)) throw new TypeError('Analysis stream identity is invalid.');
  }
}

function freezeJson(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
