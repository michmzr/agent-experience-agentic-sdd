import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { NormalizedCaptureEvent } from '../capture/contracts.js';
import { validateNormalizedCaptureEvent } from '../capture/normalization.js';
import { openExperienceDatabase } from '../storage/database.js';
import {
  createEpisodeEvidence,
  createLearningCandidate,
  createOperationalEpisode,
  type AnalysisCoverage,
  type EpisodeEvidence,
  type LegacyAnalysisCoverage,
  type LearningCandidate,
  type OperationalEpisode,
  type OperationalFinding
} from './contracts.js';
import { createTypedEpisode, createTypedFinding, type DerivedOperationalEpisode, type DerivedOperationalFinding } from './detectors.js';
import type { InstructionContext, ProjectToolConvention } from './project-conventions.js';

export const DETECTOR_SET_VERSION = 'm9-typed-evidence@1';
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

const leaseSchema = `
  CREATE TABLE IF NOT EXISTS operational_analysis_coordinator (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), owner_id TEXT, attempt INTEGER NOT NULL,
    lease_expires_at TEXT, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS operational_analysis_attempts (
    job_id TEXT NOT NULL REFERENCES operational_analysis_jobs(id), attempt INTEGER NOT NULL,
    repository_id TEXT NOT NULL, session_id TEXT NOT NULL, detector_set_version TEXT NOT NULL,
    input_low_water INTEGER NOT NULL, requested_high_water INTEGER NOT NULL, processed_high_water INTEGER NOT NULL,
    events_loaded INTEGER NOT NULL DEFAULT 0, findings INTEGER NOT NULL DEFAULT 0, elapsed_ms REAL NOT NULL DEFAULT 0,
    outcome TEXT NOT NULL, failure_category TEXT, started_at TEXT NOT NULL, finished_at TEXT,
    PRIMARY KEY(job_id, attempt)
  );
`;

const workerSlotSchema = `
  CREATE TABLE IF NOT EXISTS operational_analysis_worker_slots (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, owner_attempt INTEGER NOT NULL,
    lease_expires_at TEXT NOT NULL, job_id TEXT REFERENCES operational_analysis_jobs(id),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS operational_analysis_worker_slot_job
    ON operational_analysis_worker_slots(job_id) WHERE job_id IS NOT NULL;
`;

const resultSchema = `
  CREATE TABLE IF NOT EXISTS operational_episodes (
    id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, session_id TEXT NOT NULL, detector TEXT NOT NULL, state TEXT NOT NULL,
    evidence_json TEXT NOT NULL, payload_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS operational_findings (
    id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES operational_episodes(id), kind TEXT NOT NULL, evidence_json TEXT NOT NULL, statement TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS operational_episode_evidence (
    id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, session_id TEXT NOT NULL, payload_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS operational_insufficient_findings (
    id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, session_id TEXT NOT NULL, evidence_json TEXT NOT NULL, statement TEXT NOT NULL
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

const contextSchema = `
  CREATE TABLE IF NOT EXISTS operational_context_snapshots (
    repository_id TEXT NOT NULL, session_id TEXT NOT NULL, repository_family_key TEXT NOT NULL,
    worktree_key TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(repository_id, session_id)
  );
  CREATE TABLE IF NOT EXISTS operational_context_secret (
    id INTEGER PRIMARY KEY CHECK (id = 1), secret BLOB NOT NULL
  ) STRICT;
`;

export interface AnalysisAdmission { readonly repositoryId: string; readonly sessionId: string; readonly inputHighWater: number; readonly detectorSetVersion?: string; }
export interface AnalysisAdmissionOutcome { readonly job: AnalysisJob | undefined; readonly workAdded: boolean; }
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
export interface LearningResult { readonly episodes: readonly DerivedOperationalEpisode[]; readonly findings: readonly DerivedOperationalFinding[]; readonly candidates: readonly LearningCandidate[]; readonly episodeEvidence?: readonly EpisodeEvidence[]; readonly coverage?: readonly AnalysisCoverage[]; }
export interface LegacyLearningResult extends Omit<LearningResult, 'coverage'> { readonly coverage?: readonly LegacyAnalysisCoverage[]; }
export interface AnalysisFence { readonly ownerId: string; readonly attempt: number; }
export interface AnalysisWorkerSlotFence extends AnalysisFence { readonly slotId: string; }
export interface AnalysisWorkerSlot extends AnalysisWorkerSlotFence { readonly leaseExpiresAt: string; readonly jobId: string | null; }
export interface AnalysisWorkerSlotReservation extends AnalysisFence { readonly leaseMs: number; readonly maxProcesses: number; }
export interface AnalysisClaim {
  readonly ownerId: string; readonly leaseMs: number; readonly repositoryId?: string;
  readonly workerSlot?: AnalysisWorkerSlotFence;
}
export interface AnalysisMetrics { readonly eventsLoaded: number; readonly findings?: number; readonly elapsedMs: number; }
export interface AnalysisAcknowledgement extends AnalysisFence {
  readonly processedHighWater: number; readonly checkpoint: AnalysisStream['checkpoint'];
  readonly result: LearningResult; readonly metrics: AnalysisMetrics;
}
export type AnalysisFailureReason = 'execution-failure' | 'timeout' | 'invalid-input' | 'lease-expired';
export interface AnalysisRetry extends AnalysisFence {
  readonly reason: AnalysisFailureReason;
  /** Examined progress for this failed attempt only; it never acknowledges stream progress. */
  readonly processedHighWater?: number;
  readonly metrics?: AnalysisMetrics;
}
export interface ExpiredAnalysisAttempt extends AnalysisFence {
  /** Examined progress for this expired attempt only; it never acknowledges stream progress. */
  readonly processedHighWater?: number;
  readonly metrics?: AnalysisMetrics;
}
export interface AnalysisFilters { readonly repositoryId?: string; readonly sessionId?: string; readonly detectorSetVersion?: string; }
export interface CoordinatorLease extends AnalysisFence { readonly leaseExpiresAt: string; }
export type AnalysisDiagnostic = 'coordinator-launch-failed' | 'child-process-failed';
export interface AnalysisStatus {
  readonly jobs: Readonly<Record<AnalysisJob['state'], number>>;
  readonly oldestOutstandingAgeMs: number | null; readonly nextRetryAt: string | null;
  readonly coordinatorLease: CoordinatorLease | null; readonly activeRunningCount: number; readonly activeChildren: number;
  readonly totalAttempts: number; readonly totalRetries: number; readonly eventsLoaded: number;
  readonly uniqueAcknowledgedEvents: number; readonly rereadRatio: number;
  /** Counts every classified attempt, including failures that quarantine instead of scheduling another retry. */
  readonly failureCounts: Readonly<Record<AnalysisFailureReason, number>>;
  readonly diagnostics: Readonly<Record<AnalysisDiagnostic, number>>;
}
export type OperationalAnalysisStatus = AnalysisStatus;
export interface OperationalContextSnapshot {
  readonly repositoryId: string; readonly sessionId: string; readonly repositoryFamilyKey: string; readonly worktreeKey: string;
  readonly instructions: readonly InstructionContext[]; readonly conventions: readonly ProjectToolConvention[];
  readonly sourceAgentKey?: string; readonly runKey?: string; readonly conversationKey?: string;
}
export interface OperationalLearningReport {
  readonly candidates: readonly (Omit<LearningCandidate, 'state'> & { readonly state: 'candidate' | 'disputed' })[];
  readonly findings: readonly DerivedOperationalFinding[]; readonly episodes: readonly DerivedOperationalEpisode[];
  readonly episodeEvidence: readonly EpisodeEvidence[]; readonly coverage: readonly AnalysisCoverage[];
  readonly cost: { readonly completedRuns: number; readonly total: number };
}
export interface OperationalAnalysisQuality {
  readonly streams: { readonly total: number; readonly pending: number; readonly running: number; readonly completed: number; readonly failed: number; readonly quarantined: number; readonly desiredThrough: number; readonly completedThrough: number };
  readonly runs: { readonly completed: number; readonly retries: number; readonly firstInput: number; readonly lastInput: number };
  readonly detectorVersions: readonly string[]; readonly detectorVersionTotal: number;
  readonly coverage: { readonly uncoveredCompletedRanges: number; readonly total: number; readonly failed: number; readonly incomplete: number; readonly detectors: readonly AnalysisCoverage[] };
  readonly findings: number; readonly cost: { readonly completedRuns: number; readonly total: number };
}

export class OperationalLearningRepository {
  private readonly database: DatabaseSync;
  // Task 6 removes these compatibility handles with the synchronous service API.
  private readonly legacyOwner = `legacy:${randomUUID()}`;
  private readonly legacyClaims = new Map<string, AnalysisJob>();
  private readonly coordinatorHandles = new Map<string, CoordinatorLease>();
  constructor(databasePath?: string, private readonly now: () => string = () => new Date().toISOString()) {
    this.database = openExperienceDatabase(databasePath);
    try { this.initialize(); } catch (error) { this.database.close(); throw error; }
  }
  close(): void { this.database.close(); }

  contextSecret(): Uint8Array {
    const existing = this.database.prepare('SELECT secret FROM operational_context_secret WHERE id = 1')
      .get() as { secret?: Uint8Array } | undefined;
    if (existing?.secret !== undefined) return existing.secret;
    this.database.prepare('INSERT OR IGNORE INTO operational_context_secret (id, secret) VALUES (1, ?)').run(randomBytes(32));
    const stored = this.database.prepare('SELECT secret FROM operational_context_secret WHERE id = 1')
      .get() as { secret?: Uint8Array } | undefined;
    if (stored?.secret === undefined) throw new TypeError('Operational context secret is unavailable.');
    return stored.secret;
  }

  preserveContextSnapshot(snapshot: OperationalContextSnapshot): void {
    const payload = freezeContext(snapshot);
    this.database.prepare(`INSERT OR IGNORE INTO operational_context_snapshots
      (repository_id, session_id, repository_family_key, worktree_key, payload_json) VALUES (?, ?, ?, ?, ?)`)
      .run(snapshot.repositoryId, snapshot.sessionId, snapshot.repositoryFamilyKey, snapshot.worktreeKey, JSON.stringify(payload));
  }

  contextSnapshotFor(repositoryId: string, sessionId: string): OperationalContextSnapshot | undefined {
    const row = this.database.prepare(`SELECT payload_json FROM operational_context_snapshots
      WHERE repository_id = ? AND session_id = ?`).get(repositoryId, sessionId) as { payload_json: string } | undefined;
    return row === undefined ? undefined : freezeContext(JSON.parse(row.payload_json) as OperationalContextSnapshot);
  }

  enqueue(input: AnalysisAdmission): AnalysisJob | undefined {
    return this.enqueueWithOutcome(input).job;
  }

  enqueueWithOutcome(input: AnalysisAdmission): AnalysisAdmissionOutcome {
    const version = input.detectorSetVersion ?? DETECTOR_SET_VERSION;
    assertStreamIdentity(input.repositoryId, input.sessionId, version);
    if (!Number.isSafeInteger(input.inputHighWater) || input.inputHighWater < 0) throw new TypeError('Analysis high-water is invalid.');
    const timestamp = this.now();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const previousStream = this.streamRow(input.repositoryId, input.sessionId, version);
      const isNewStream = previousStream === undefined;
      this.database.prepare(`INSERT INTO operational_analysis_streams
        (repository_id, session_id, detector_set_version, committed_high_water, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(repository_id, session_id, detector_set_version) DO UPDATE SET
        committed_high_water = MAX(committed_high_water, excluded.committed_high_water), updated_at = excluded.updated_at`)
        .run(input.repositoryId, input.sessionId, version, input.inputHighWater, timestamp, timestamp);
      const stream = this.streamRow(input.repositoryId, input.sessionId, version)!;
      const quarantined = this.database.prepare(`SELECT 1 FROM operational_analysis_jobs WHERE repository_id = ? AND session_id = ?
        AND detector_set_version = ? AND state = 'quarantined-input' AND input_high_water >= ?`)
        .get(input.repositoryId, input.sessionId, version, stream.processed_high_water);
      if (quarantined && previousStream !== undefined && input.inputHighWater <= previousStream.committed_high_water) {
        this.database.exec('COMMIT');
        return Object.freeze({ job: undefined, workAdded: false });
      }
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
      const workAdded = job !== undefined && (isNewStream || input.inputHighWater > previousStream.committed_high_water);
      return Object.freeze({ job, workAdded });
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

  claim(input?: AnalysisClaim | string): AnalysisJob | undefined {
    if (typeof input !== 'object') {
      const job = this.claim({ ownerId: this.legacyOwner, leaseMs: 60_000, ...(input === undefined ? {} : { repositoryId: input }) });
      if (job) this.legacyClaims.set(job.id, job);
      return job;
    }
    assertLeaseInput(input);
    if (input.workerSlot) assertWorkerSlotFence(input.workerSlot);
    return this.transaction(() => {
      const timestamp = this.now();
      if (input.workerSlot) {
        const slot = this.database.prepare(`SELECT 1 FROM operational_analysis_worker_slots
          WHERE id = ? AND owner_id = ? AND owner_attempt = ? AND lease_expires_at > ? AND job_id IS NULL`)
          .get(input.workerSlot.slotId, input.workerSlot.ownerId, input.workerSlot.attempt, timestamp);
        if (!slot) throw new TypeError('Analysis worker slot is not current.');
      }
      const row = this.claimableRows(timestamp, input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId })[0];
      if (!row) return undefined;
      const stream = this.streamRow(row.repository_id, row.session_id, row.detector_set_version)!;
      this.database.prepare(`UPDATE operational_analysis_jobs SET state = 'running', attempts = attempts + 1,
        input_low_water = ?, processed_high_water = ?, lease_owner = ?, lease_expires_at = ?, retry_after = NULL, updated_at = ? WHERE id = ?`)
        .run(stream.processed_high_water, stream.processed_high_water, input.ownerId, expiresAt(timestamp, input.leaseMs), timestamp, row.id);
      const claimed = this.jobById(row.id)!;
      this.database.prepare(`INSERT INTO operational_analysis_attempts (job_id, attempt, repository_id, session_id, detector_set_version,
        input_low_water, requested_high_water, processed_high_water, outcome, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`)
        .run(claimed.id, claimed.attempts, claimed.repositoryId, claimed.sessionId, claimed.detectorSetVersion,
          claimed.inputLowWater, claimed.inputHighWater, claimed.inputLowWater, timestamp);
      if (input.workerSlot) {
        const linked = this.database.prepare(`UPDATE operational_analysis_worker_slots SET job_id = ?, updated_at = ?
          WHERE id = ? AND owner_id = ? AND owner_attempt = ? AND lease_expires_at > ? AND job_id IS NULL`)
          .run(claimed.id, timestamp, input.workerSlot.slotId, input.workerSlot.ownerId, input.workerSlot.attempt, timestamp);
        if (linked.changes !== 1) throw new TypeError('Analysis worker slot is not current.');
      }
      return claimed;
    });
  }

  retry(jobId: string, input: AnalysisRetry | AnalysisFailureReason = 'execution-failure'): void {
    if (typeof input === 'string') {
      const claimed = this.legacyClaims.get(jobId);
      if (!claimed) throw new TypeError('Analysis lease is not owned by this repository.');
      return this.retry(jobId, { ownerId: this.legacyOwner, attempt: claimed.attempts, reason: input });
    }
    if (!['execution-failure', 'timeout', 'invalid-input', 'lease-expired'].includes(input.reason)) throw new TypeError('Analysis failure category is invalid.');
    this.transaction(() => {
      const timestamp = this.now();
      const job = this.assertOwnedJob(jobId, input, timestamp);
      this.failAttempt(job, input.reason, timestamp, input.processedHighWater, input.metrics);
    });
  }

  recoverExpiredJobs(): number {
    return this.transaction(() => {
      const timestamp = this.now();
      const expired = this.database.prepare(`SELECT * FROM operational_analysis_jobs WHERE state = 'running' AND lease_expires_at <= ?`).all(timestamp);
      for (const row of expired) this.failAttempt(this.job(row), 'lease-expired', timestamp);
      return expired.length;
    });
  }

  recoverExpiredAttempt(jobId: string, input: ExpiredAnalysisAttempt): boolean {
    assertFence(input);
    return this.transaction(() => {
      const timestamp = this.now();
      const row = this.database.prepare(`SELECT * FROM operational_analysis_jobs
        WHERE id = ? AND state = 'running' AND lease_owner = ? AND attempts = ? AND lease_expires_at <= ?`)
        .get(jobId, input.ownerId, input.attempt, timestamp);
      if (!row) return false;
      this.failAttempt(this.job(row), 'lease-expired', timestamp, input.processedHighWater, input.metrics);
      return true;
    });
  }

  claimableCount(filters: AnalysisFilters = {}): number { return this.claimableRows(this.now(), filters).length; }

  hasActiveOrClaimableWork(filters: AnalysisFilters = {}): boolean {
    const timestamp = this.now();
    const filter = sqlFilters(filters);
    return this.claimableRows(timestamp, filters).length > 0 || this.database.prepare(`SELECT 1 FROM operational_analysis_jobs j
      WHERE state = 'running' AND lease_expires_at > ? ${filter.sql} LIMIT 1`).get(timestamp, ...filter.values) !== undefined;
  }

  hasOutstandingWork(filters: AnalysisFilters = {}): boolean {
    const filter = sqlFilters(filters);
    return this.database.prepare(`SELECT 1 FROM operational_analysis_jobs j
      WHERE state IN ('pending', 'retryable-failure', 'running') ${filter.sql} LIMIT 1`)
      .get(...filter.values) !== undefined;
  }

  jobById(id: string): AnalysisJob | undefined {
    const row = this.database.prepare(`SELECT * FROM operational_analysis_jobs WHERE id = ?`).get(id);
    return row === undefined ? undefined : this.job(row);
  }

  /** Task 6 removes this adapter after the service adopts explicit acknowledgements. */
  saveResult(jobId: string, result: LegacyLearningResult): void {
    const job = this.legacyClaims.get(jobId);
    if (!job) throw new TypeError('Analysis lease is not owned by this repository.');
    this.acknowledge(jobId, { ownerId: this.legacyOwner, attempt: job.attempts, processedHighWater: job.inputHighWater,
      checkpoint: { version: 1, pendingEvents: [] }, metrics: { eventsLoaded: job.inputHighWater - job.inputLowWater, elapsedMs: 0 },
      result: { ...result, coverage: (result.coverage ?? []).map((coverage) => ({ ...coverage,
        detectorSetVersion: job.detectorSetVersion, inputLowWater: job.inputLowWater,
        requestedHighWater: job.inputHighWater, processedHighWater: job.inputHighWater })) } });
  }

  acknowledge(jobId: string, input: AnalysisAcknowledgement): void {
    this.transaction(() => {
      const timestamp = this.now();
      const job = this.assertOwnedJob(jobId, input, timestamp);
      assertInteger(input.processedHighWater, 'Processed high-water');
      if (input.processedHighWater < job.inputLowWater || input.processedHighWater > job.inputHighWater) throw new TypeError('Processed range conflicts with job.');
      assertInteger(input.metrics.eventsLoaded, 'Events loaded');
      if (input.metrics.eventsLoaded < input.processedHighWater - job.inputLowWater) throw new TypeError('Events loaded cannot be smaller than the processed range.');
      if (input.metrics.findings !== undefined && input.metrics.findings !== input.result.findings.length) throw new TypeError('Findings metric conflicts with result.');
      if (!Number.isFinite(input.metrics.elapsedMs) || input.metrics.elapsedMs < 0) throw new TypeError('Elapsed time is invalid.');
      const checkpointJson = validateCheckpoint(input.checkpoint, job.sessionId);
      this.validateResult(job, input.result, input.processedHighWater);
      this.persistResult(job, input.result);
      this.database.prepare(`UPDATE operational_analysis_jobs SET state = 'completed', processed_high_water = ?,
        lease_owner = NULL, lease_expires_at = NULL, failure_reason = NULL, updated_at = ? WHERE id = ? AND lease_owner = ? AND attempts = ?`)
        .run(input.processedHighWater, timestamp, jobId, input.ownerId, input.attempt);
      this.database.prepare(`UPDATE operational_analysis_streams SET processed_high_water = ?, checkpoint_json = ?, updated_at = ?
        WHERE repository_id = ? AND session_id = ? AND detector_set_version = ?`)
        .run(input.processedHighWater, checkpointJson, timestamp, job.repositoryId, job.sessionId, job.detectorSetVersion);
      this.database.prepare(`UPDATE operational_analysis_attempts SET processed_high_water = ?, events_loaded = ?, findings = ?, elapsed_ms = ?,
        outcome = 'completed', finished_at = ? WHERE job_id = ? AND attempt = ?`)
        .run(input.processedHighWater, input.metrics.eventsLoaded, input.result.findings.length, input.metrics.elapsedMs, timestamp, jobId, input.attempt);
      const stream = this.streamRow(job.repositoryId, job.sessionId, job.detectorSetVersion)!;
      if (stream.committed_high_water > stream.processed_high_water) {
        const pending = this.pendingJob(job);
        if (pending) this.database.prepare(`UPDATE operational_analysis_jobs SET input_high_water = MAX(input_high_water, ?),
          input_low_water = ?, processed_high_water = ?, updated_at = ? WHERE id = ?`)
          .run(stream.committed_high_water, stream.processed_high_water, stream.processed_high_water, timestamp, pending.id);
        else this.insertPendingJob(stream, timestamp);
      }
    });
  }

  private persistResult(job: AnalysisJob, result: LearningResult): void {
      for (const rawEvidence of result.episodeEvidence ?? []) {
        const evidence = createEpisodeEvidence(rawEvidence);
        const payload = JSON.stringify(evidence);
        const existing = this.database.prepare(`SELECT repository_id, session_id, payload_json
          FROM operational_episode_evidence WHERE id = ?`).get(evidence.id) as {
            repository_id: string; session_id: string; payload_json: string;
          } | undefined;
        if (existing !== undefined) {
          if (existing.repository_id !== job.repositoryId || existing.session_id !== job.sessionId) {
            throw new TypeError('Evidence identity collision across analysis job scope.');
          }
          if (existing.payload_json !== payload) throw new TypeError('Evidence payload conflicts with immutable identity.');
        } else {
          this.database.prepare(`INSERT INTO operational_episode_evidence
            (id, repository_id, session_id, payload_json) VALUES (?, ?, ?, ?)`)
            .run(evidence.id, job.repositoryId, job.sessionId, payload);
        }
      }
      for (const rawEpisode of result.episodes) {
        const episode = isTypedEpisode(rawEpisode) ? createTypedEpisode(rawEpisode) : createOperationalEpisode(rawEpisode);
        if (episode.repositoryId !== job.repositoryId || episode.sessionId !== job.sessionId) throw new TypeError('Episode scope conflicts with job.');
        this.database.prepare(`INSERT INTO operational_episodes (id, repository_id, session_id, detector, state, evidence_json, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, evidence_json = excluded.evidence_json, payload_json = excluded.payload_json`).run(episode.id, job.repositoryId, job.sessionId, episode.detector, episode.state, JSON.stringify(episode.evidenceEventIds), JSON.stringify(episode));
      }
      for (const finding of result.findings) {
        if (finding.kind === 'insufficient-evidence') {
          const typed = createTypedFinding(finding);
          this.database.prepare(`INSERT INTO operational_insufficient_findings
            (id, repository_id, session_id, evidence_json, statement) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
            .run(typed.id, job.repositoryId, job.sessionId, JSON.stringify(typed.evidenceEventIds), typed.statement);
        } else {
          this.database.prepare(`INSERT INTO operational_findings
            (id, episode_id, kind, evidence_json, statement) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
            .run(finding.id, finding.episodeId, finding.kind, JSON.stringify(finding.evidenceEventIds), finding.statement);
        }
      }
      for (const rawCandidate of result.candidates) {
        const candidate = createLearningCandidate(rawCandidate);
        this.database.prepare(`INSERT INTO operational_candidates (id, episode_id, kind, state, statement, conditions_json, procedure_json, invalidation_json) VALUES (?, ?, ?, 'candidate', ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).run(candidate.id, candidate.episodeId, candidate.kind, candidate.statement, JSON.stringify(candidate.conditions), JSON.stringify(candidate.procedure), JSON.stringify(candidate.invalidationConditions));
        for (const eventId of candidate.evidenceEventIds) this.database.prepare(`INSERT OR IGNORE INTO operational_candidate_evidence (candidate_id, event_id, polarity) VALUES (?, ?, 'confirms')`).run(candidate.id, eventId);
      }
      for (const coverage of result.coverage ?? []) {
        this.database.prepare(`INSERT INTO operational_analysis_coverage (job_id, detector, status, examined_events, findings,
          detector_set_version, input_low_water, requested_high_water, processed_high_water) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(job_id, detector) DO UPDATE SET status = excluded.status, examined_events = excluded.examined_events,
          findings = excluded.findings, detector_set_version = excluded.detector_set_version, input_low_water = excluded.input_low_water,
          requested_high_water = excluded.requested_high_water, processed_high_water = excluded.processed_high_water`)
          .run(job.id, coverage.detector, coverage.status, coverage.examinedEvents, coverage.findings,
            coverage.detectorSetVersion, coverage.inputLowWater, coverage.requestedHighWater, coverage.processedHighWater);
      }
  }

  contradict(candidateId: string, eventId: string): void {
    this.transaction(() => {
      this.database.prepare(`INSERT OR IGNORE INTO operational_candidate_evidence (candidate_id, event_id, polarity) VALUES (?, ?, 'contradicts')`).run(candidateId, eventId);
      this.database.prepare(`UPDATE operational_candidates SET state = 'disputed' WHERE id = ?`).run(candidateId);
    });
  }

  report(repositoryId: string): OperationalLearningReport {
    const episodes = (this.database.prepare(`SELECT payload_json FROM operational_episodes WHERE repository_id = ? ORDER BY id`).all(repositoryId) as Array<{ payload_json: string }>).map(({ payload_json }) => JSON.parse(payload_json) as DerivedOperationalEpisode);
    const findings = (this.database.prepare(`SELECT f.id, f.episode_id, f.kind, f.evidence_json, f.statement
      FROM operational_findings f JOIN operational_episodes e ON e.id = f.episode_id WHERE e.repository_id = ?
      UNION ALL SELECT id, id, 'insufficient-evidence', evidence_json, statement
      FROM operational_insufficient_findings WHERE repository_id = ? ORDER BY id`).all(repositoryId, repositoryId) as Array<{
        id: string; episode_id: string; kind: DerivedOperationalFinding['kind']; evidence_json: string; statement: string;
      }>).map((row) => Object.freeze({ id: row.id, episodeId: row.episode_id, kind: row.kind,
        evidenceEventIds: Object.freeze(JSON.parse(row.evidence_json) as string[]), statement: row.statement }));
    const episodeEvidence = (this.database.prepare(`SELECT payload_json FROM operational_episode_evidence
      WHERE repository_id = ? ORDER BY id`).all(repositoryId) as Array<{ payload_json: string }>)
      .map(({ payload_json }) => createEpisodeEvidence(JSON.parse(payload_json) as EpisodeEvidence));
    const candidates = (this.database.prepare(`SELECT c.id, c.episode_id, c.kind, c.state, c.statement, c.conditions_json, c.procedure_json, c.invalidation_json FROM operational_candidates c JOIN operational_episodes e ON e.id = c.episode_id WHERE e.repository_id = ? ORDER BY c.id`).all(repositoryId) as Array<{ id: string; episode_id: string; kind: LearningCandidate['kind']; state: 'candidate' | 'disputed'; statement: string; conditions_json: string; procedure_json: string; invalidation_json: string }>).map((row) => Object.freeze({ id: row.id, episodeId: row.episode_id, kind: row.kind, state: row.state, statement: row.statement, conditions: Object.freeze(JSON.parse(row.conditions_json) as string[]), procedure: Object.freeze(JSON.parse(row.procedure_json) as string[]), evidenceEventIds: Object.freeze((this.database.prepare(`SELECT event_id FROM operational_candidate_evidence WHERE candidate_id = ? ORDER BY event_id`).all(row.id) as Array<{ event_id: string }>).map(({ event_id }) => event_id)), invalidationConditions: Object.freeze(JSON.parse(row.invalidation_json) as string[]) }));
    const coverage = (this.database.prepare(`SELECT c.* FROM operational_analysis_coverage c JOIN operational_analysis_jobs j ON j.id = c.job_id WHERE j.repository_id = ? ORDER BY c.detector, j.id`).all(repositoryId) as Array<{ detector: string; status: AnalysisCoverage['status']; examined_events: number; findings: number; detector_set_version: string; input_low_water: number; requested_high_water: number; processed_high_water: number }>).map((row) => Object.freeze({ detector: row.detector, status: row.status, examinedEvents: row.examined_events, findings: row.findings, detectorSetVersion: row.detector_set_version, inputLowWater: row.input_low_water, requestedHighWater: row.requested_high_water, processedHighWater: row.processed_high_water }));
    const cost = this.database.prepare(`SELECT COUNT(*) AS completed_runs, COALESCE(SUM(events_loaded), 0) AS total
      FROM operational_analysis_attempts WHERE repository_id = ? AND outcome = 'completed'`).get(repositoryId) as { completed_runs: number; total: number };
    return publicReport(Object.freeze({ episodes: Object.freeze(episodes), findings: Object.freeze(findings),
      candidates: Object.freeze(candidates), episodeEvidence: Object.freeze(episodeEvidence), coverage: Object.freeze(coverage),
      cost: Object.freeze({ completedRuns: cost.completed_runs, total: cost.total }) }), this.contextSecret());
  }

  quality(repositoryId: string): OperationalAnalysisQuality {
    const streams = this.database.prepare(`SELECT * FROM operational_analysis_streams WHERE repository_id = ?`)
      .all(repositoryId) as unknown as StreamRow[];
    const streamStates = { pending: 0, running: 0, completed: 0, failed: 0, quarantined: 0 };
    for (const stream of streams) {
      const jobs = this.database.prepare(`SELECT state, input_high_water FROM operational_analysis_jobs WHERE repository_id = ?
        AND session_id = ? AND detector_set_version = ?`).all(repositoryId, stream.session_id, stream.detector_set_version) as Array<{
          state: AnalysisJob['state']; input_high_water: number;
        }>;
      const states = new Set(jobs.map(({ state }) => state));
      if (jobs.some(({ state, input_high_water }) => state === 'quarantined-input' && input_high_water >= stream.processed_high_water)) streamStates.quarantined += 1;
      else if (states.has('running')) streamStates.running += 1;
      else if (states.has('retryable-failure')) streamStates.failed += 1;
      else if (stream.processed_high_water < stream.committed_high_water) streamStates.pending += 1;
      else streamStates.completed += 1;
    }
    const runs = this.database.prepare(`SELECT COALESCE(SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
      COALESCE(SUM(CASE WHEN attempts > 1 THEN attempts - 1 ELSE 0 END), 0) AS retries,
      COALESCE(MIN(input_low_water + 1), 0) AS first_input, COALESCE(MAX(input_high_water), 0) AS last_input
      FROM operational_analysis_jobs WHERE repository_id = ?`).get(repositoryId) as { completed: number; retries: number; first_input: number; last_input: number };
    const detectorVersionTotal = Number((this.database.prepare(`SELECT COUNT(DISTINCT detector_set_version) AS count
      FROM operational_analysis_streams WHERE repository_id = ?`).get(repositoryId) as { count: number }).count);
    const detectorVersions = (this.database.prepare(`SELECT detector_set_version FROM operational_analysis_streams
      WHERE repository_id = ? GROUP BY detector_set_version ORDER BY detector_set_version LIMIT 64`).all(repositoryId) as Array<{ detector_set_version: string }>).map(({ detector_set_version }) => detector_set_version);
    const coverageRows = this.database.prepare(`SELECT c.* FROM operational_analysis_coverage c JOIN operational_analysis_jobs j
      ON j.id = c.job_id WHERE j.repository_id = ? ORDER BY c.job_id, c.detector`).all(repositoryId) as Array<{
        detector: string; status: AnalysisCoverage['status']; examined_events: number; findings: number;
        detector_set_version: string; input_low_water: number; requested_high_water: number; processed_high_water: number;
      }>;
    const coverage = coverageRows.slice(0, 64).map((row) => Object.freeze({ detector: row.detector, status: row.status,
      examinedEvents: row.examined_events, findings: row.findings, detectorSetVersion: row.detector_set_version,
      inputLowWater: row.input_low_water, requestedHighWater: row.requested_high_water, processedHighWater: row.processed_high_water }));
    const uncoveredCompletedRanges = Number((this.database.prepare(`SELECT COUNT(*) AS count FROM operational_analysis_jobs j
      WHERE j.repository_id = ? AND j.state = 'completed' AND NOT EXISTS
        (SELECT 1 FROM operational_analysis_coverage c WHERE c.job_id = j.id AND c.detector = j.detector_set_version
          AND c.status = 'completed')`).get(repositoryId) as { count: number }).count);
    const ordinaryFindings = Number((this.database.prepare(`SELECT COUNT(*) AS count FROM operational_findings f
      JOIN operational_episodes e ON e.id = f.episode_id WHERE e.repository_id = ?`).get(repositoryId) as { count: number }).count);
    const insufficientFindings = Number((this.database.prepare(`SELECT COUNT(*) AS count FROM operational_insufficient_findings
      WHERE repository_id = ?`).get(repositoryId) as { count: number }).count);
    const cost = this.database.prepare(`SELECT COUNT(*) AS completed_runs, COALESCE(SUM(events_loaded), 0) AS total
      FROM operational_analysis_attempts WHERE repository_id = ? AND outcome = 'completed'`).get(repositoryId) as { completed_runs: number; total: number };
    return Object.freeze({ streams: Object.freeze({ total: streams.length, ...streamStates,
      desiredThrough: streams.reduce((sum, stream) => sum + stream.committed_high_water, 0),
      completedThrough: streams.reduce((sum, stream) => sum + stream.processed_high_water, 0) }),
      runs: Object.freeze({ completed: runs.completed, retries: runs.retries, firstInput: runs.first_input, lastInput: runs.last_input }),
      detectorVersions: Object.freeze(detectorVersions), detectorVersionTotal,
      coverage: Object.freeze({ uncoveredCompletedRanges, total: coverageRows.length,
        failed: coverageRows.filter(({ status }) => status === 'failed').length,
        incomplete: coverageRows.filter(({ status }) => status === 'incomplete').length, detectors: Object.freeze(coverage) }),
      findings: ordinaryFindings + insufficientFindings,
      cost: Object.freeze({ completedRuns: cost.completed_runs, total: cost.total }) });
  }

  tryAcquireCoordinatorLease(ownerId: string, leaseMs: number): boolean {
    const lease = this.acquireCoordinatorLease({ ownerId, leaseMs });
    if (lease) this.coordinatorHandles.set(ownerId, lease);
    return lease !== undefined;
  }

  acquireCoordinatorLease(input: AnalysisClaim): CoordinatorLease | undefined {
    assertLeaseInput(input);
    return this.transaction(() => {
      const timestamp = this.now();
      const current = this.database.prepare('SELECT owner_id, attempt, lease_expires_at FROM operational_analysis_coordinator WHERE singleton = 1')
        .get() as { owner_id: string | null; attempt: number; lease_expires_at: string | null } | undefined;
      if (current?.lease_expires_at && current.lease_expires_at > timestamp) return undefined;
      const attempt = (current?.attempt ?? 0) + 1;
      const leaseExpiresAt = expiresAt(timestamp, input.leaseMs);
      this.database.prepare(`INSERT INTO operational_analysis_coordinator VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET owner_id = excluded.owner_id, attempt = excluded.attempt,
        lease_expires_at = excluded.lease_expires_at, updated_at = excluded.updated_at`)
        .run(input.ownerId, attempt, leaseExpiresAt, timestamp);
      return Object.freeze({ ownerId: input.ownerId, attempt, leaseExpiresAt });
    });
  }

  renewCoordinatorLease(ownerId: string, leaseMs: number): boolean;
  renewCoordinatorLease(input: AnalysisFence & { readonly leaseMs: number }): CoordinatorLease | undefined;
  renewCoordinatorLease(input: string | (AnalysisFence & { readonly leaseMs: number }), leaseMs?: number): CoordinatorLease | undefined | boolean {
    if (typeof input === 'string') {
      const handle = this.coordinatorHandles.get(input);
      return handle !== undefined && this.renewCoordinatorLease({ ...handle, leaseMs: leaseMs! }) !== undefined;
    }
    assertLeaseInput(input); assertFence(input);
    return this.transaction(() => {
      const timestamp = this.now();
      const leaseExpiresAt = expiresAt(timestamp, input.leaseMs);
      const result = this.database.prepare(`UPDATE operational_analysis_coordinator SET lease_expires_at = ?, updated_at = ?
        WHERE singleton = 1 AND owner_id = ? AND attempt = ? AND lease_expires_at > ?`)
        .run(leaseExpiresAt, timestamp, input.ownerId, input.attempt, timestamp);
      return result.changes ? Object.freeze({ ownerId: input.ownerId, attempt: input.attempt, leaseExpiresAt }) : undefined;
    });
  }

  releaseCoordinatorLease(input: string | AnalysisFence): boolean {
    if (typeof input === 'string') {
      const handle = this.coordinatorHandles.get(input);
      return handle !== undefined && this.releaseCoordinatorLease(handle);
    }
    assertFence(input);
    return this.transaction(() => this.database.prepare(`UPDATE operational_analysis_coordinator SET owner_id = NULL,
      lease_expires_at = NULL, updated_at = ? WHERE singleton = 1 AND owner_id = ? AND attempt = ? AND lease_expires_at > ?`)
      .run(this.now(), input.ownerId, input.attempt, this.now()).changes !== 0);
  }

  reserveWorkerSlot(input: AnalysisWorkerSlotReservation): AnalysisWorkerSlot | undefined {
    assertFence(input); assertLeaseInput(input);
    assertInteger(input.maxProcesses, 'Maximum analysis processes');
    if (input.maxProcesses < 1 || input.maxProcesses > 16) throw new TypeError('Maximum analysis processes is invalid.');
    return this.transaction(() => {
      const timestamp = this.now();
      const coordinator = this.database.prepare(`SELECT 1 FROM operational_analysis_coordinator
        WHERE singleton = 1 AND owner_id = ? AND attempt = ? AND lease_expires_at > ?`)
        .get(input.ownerId, input.attempt, timestamp);
      if (!coordinator) return undefined;
      this.database.prepare('DELETE FROM operational_analysis_worker_slots WHERE lease_expires_at <= ?').run(timestamp);
      const occupied = this.database.prepare(`SELECT
        (SELECT COUNT(*) FROM operational_analysis_worker_slots s WHERE s.lease_expires_at > ?) +
        (SELECT COUNT(*) FROM operational_analysis_jobs j WHERE j.state = 'running' AND j.lease_expires_at > ?
          AND NOT EXISTS (SELECT 1 FROM operational_analysis_worker_slots s
            WHERE s.job_id = j.id AND s.lease_expires_at > ?)) AS count`).get(timestamp, timestamp, timestamp) as { count: number };
      if (occupied.count >= input.maxProcesses) return undefined;
      const slotId = randomUUID();
      const leaseExpiresAt = expiresAt(timestamp, input.leaseMs);
      this.database.prepare(`INSERT INTO operational_analysis_worker_slots
        (id, owner_id, owner_attempt, lease_expires_at, job_id, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)`)
        .run(slotId, input.ownerId, input.attempt, leaseExpiresAt, timestamp, timestamp);
      return Object.freeze({ slotId, ownerId: input.ownerId, attempt: input.attempt, leaseExpiresAt, jobId: null });
    });
  }

  renewWorkerSlot(input: AnalysisWorkerSlotFence & { readonly leaseMs: number }): boolean {
    assertWorkerSlotFence(input); assertLeaseInput(input);
    return this.transaction(() => {
      const timestamp = this.now();
      return this.database.prepare(`UPDATE operational_analysis_worker_slots SET lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND owner_id = ? AND owner_attempt = ? AND lease_expires_at > ?`)
        .run(expiresAt(timestamp, input.leaseMs), timestamp, input.slotId, input.ownerId, input.attempt, timestamp).changes === 1;
    });
  }

  releaseWorkerSlot(input: AnalysisWorkerSlotFence): boolean {
    assertWorkerSlotFence(input);
    return this.transaction(() => this.database.prepare(`DELETE FROM operational_analysis_worker_slots
      WHERE id = ? AND owner_id = ? AND owner_attempt = ?`)
      .run(input.slotId, input.ownerId, input.attempt).changes === 1);
  }

  recordDiagnostic(code: AnalysisDiagnostic): void {
    if (!['coordinator-launch-failed', 'child-process-failed'].includes(code)) throw new TypeError('Analysis diagnostic code is invalid.');
    this.transaction(() => this.database.prepare(`INSERT INTO operational_analysis_diagnostics (code, occurrences, last_at) VALUES (?, 1, ?)
      ON CONFLICT(code) DO UPDATE SET occurrences = occurrences + 1, last_at = excluded.last_at`).run(code, this.now()));
  }

  status(filters: AnalysisFilters = {}): AnalysisStatus {
    // A read transaction gives the job counts and aggregate metrics one consistent snapshot.
    this.database.exec('BEGIN');
    try {
      const timestamp = this.now();
      const filter = sqlFilters(filters);
      const rows = this.database.prepare(`SELECT j.* FROM operational_analysis_jobs j WHERE 1 = 1 ${filter.sql}`).all(...filter.values) as unknown as JobRow[];
      const jobs: Record<AnalysisJob['state'], number> = { pending: 0, running: 0, completed: 0, 'retryable-failure': 0, 'quarantined-input': 0 };
      let oldest: string | null = null; let nextRetryAt: string | null = null;
      for (const job of rows) {
        jobs[job.state] += 1;
        if (job.state !== 'completed' && (oldest === null || job.created_at < oldest)) oldest = job.created_at;
        if (job.state === 'retryable-failure' && job.retry_after !== null && (nextRetryAt === null || job.retry_after < nextRetryAt)) nextRetryAt = job.retry_after;
      }
      const active = this.database.prepare(`SELECT
        (SELECT COUNT(*) FROM operational_analysis_worker_slots s WHERE s.lease_expires_at > ?) AS active_children,
        (SELECT COUNT(*) FROM operational_analysis_worker_slots s WHERE s.lease_expires_at > ?) +
        (SELECT COUNT(*) FROM operational_analysis_jobs j WHERE j.state = 'running' AND j.lease_expires_at > ?
          AND NOT EXISTS (SELECT 1 FROM operational_analysis_worker_slots s
            WHERE s.job_id = j.id AND s.lease_expires_at > ?)) AS active_running_count`)
        .get(timestamp, timestamp, timestamp, timestamp) as { active_children: number; active_running_count: number };
      const metrics = this.database.prepare(`SELECT COUNT(*) AS total_attempts,
        COALESCE(SUM(CASE WHEN j.outcome = 'retryable-failure' THEN 1 ELSE 0 END), 0) AS total_retries,
        COALESCE(SUM(j.events_loaded), 0) AS events_loaded,
        COALESCE(SUM(CASE WHEN j.outcome = 'completed' THEN j.processed_high_water - j.input_low_water ELSE 0 END), 0) AS acknowledged
        FROM operational_analysis_attempts j WHERE 1 = 1 ${filter.sql}`).get(...filter.values) as {
          total_attempts: number; total_retries: number; events_loaded: number; acknowledged: number;
        };
      const failureCounts: Record<AnalysisFailureReason, number> = { 'execution-failure': 0, timeout: 0, 'invalid-input': 0, 'lease-expired': 0 };
      const failures = this.database.prepare(`SELECT j.failure_category, COUNT(*) AS occurrences FROM operational_analysis_attempts j
        WHERE j.failure_category IS NOT NULL ${filter.sql} GROUP BY j.failure_category`).all(...filter.values);
      for (const failure of failures) {
        if (failure.failure_category === 'execution-failure' || failure.failure_category === 'timeout' ||
          failure.failure_category === 'invalid-input' || failure.failure_category === 'lease-expired') {
          failureCounts[failure.failure_category] = Number(failure.occurrences);
        }
      }
      const lease = this.database.prepare(`SELECT owner_id, attempt, lease_expires_at FROM operational_analysis_coordinator
        WHERE singleton = 1 AND owner_id IS NOT NULL AND lease_expires_at > ?`).get(timestamp) as { owner_id: string; attempt: number; lease_expires_at: string } | undefined;
      const diagnostics: Record<AnalysisDiagnostic, number> = { 'coordinator-launch-failed': 0, 'child-process-failed': 0 };
      for (const row of this.database.prepare('SELECT code, occurrences FROM operational_analysis_diagnostics').all()) {
        if (row.code === 'coordinator-launch-failed' || row.code === 'child-process-failed') diagnostics[row.code] = Number(row.occurrences);
      }
      const status = Object.freeze({ jobs: Object.freeze(jobs), oldestOutstandingAgeMs: oldest === null ? null : Math.max(0, Date.parse(timestamp) - Date.parse(oldest)),
        nextRetryAt, activeRunningCount: active.active_running_count, activeChildren: active.active_children,
        totalAttempts: metrics.total_attempts, totalRetries: metrics.total_retries,
        eventsLoaded: metrics.events_loaded, uniqueAcknowledgedEvents: metrics.acknowledged,
        rereadRatio: metrics.acknowledged === 0 ? 0 : metrics.events_loaded / metrics.acknowledged,
        failureCounts: Object.freeze(failureCounts),
        coordinatorLease: lease ? Object.freeze({ ownerId: lease.owner_id, attempt: lease.attempt, leaseExpiresAt: lease.lease_expires_at }) : null,
        diagnostics: Object.freeze(diagnostics) });
      this.database.exec('COMMIT');
      return status;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  private initialize(): void {
    // Rebuild the parent table without rewriting or cascading existing coverage foreign keys.
    // SQLite requires changing foreign_keys before starting the migration transaction.
    this.database.exec('PRAGMA foreign_keys = OFF');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const versionTableExists = this.database.prepare(`SELECT 1 FROM sqlite_master
        WHERE type = 'table' AND name = 'operational_analysis_schema'`).get() !== undefined;
      if (!versionTableExists && this.isCurrentMainSchema()) this.migrateCurrentMainSchema();
      this.database.exec(streamSchema);
      const versions = this.database.prepare('SELECT version FROM operational_analysis_schema').all() as Array<{ version: number }>;
      if (versions.length > 1 || (versions.length === 1 && ![1, 2, 3].includes(versions[0]!.version))) throw new TypeError('Unsupported operational analysis schema version.');
      let version = versions[0]?.version;
      if (versions.length === 0) {
        const exists = this.database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'operational_analysis_jobs'`).get();
        if (exists) this.migrateLegacyJobs();
        else this.database.exec(jobsSchema('operational_analysis_jobs'));
        this.database.exec(jobIndexes);
        this.database.exec(resultSchema);
        if (this.database.prepare('PRAGMA foreign_key_check').all().length > 0) throw new TypeError('Operational analysis migration violates foreign keys.');
        this.database.prepare('INSERT INTO operational_analysis_schema(version) VALUES (1)').run();
        version = 1;
      }
      if (version === 1) {
        this.database.exec(leaseSchema);
        this.database.exec(`ALTER TABLE operational_analysis_coverage ADD COLUMN detector_set_version TEXT NOT NULL DEFAULT '${LEGACY_DETECTOR_SET_VERSION}';
          ALTER TABLE operational_analysis_coverage ADD COLUMN input_low_water INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE operational_analysis_coverage ADD COLUMN requested_high_water INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE operational_analysis_coverage ADD COLUMN processed_high_water INTEGER NOT NULL DEFAULT 0;
          UPDATE operational_analysis_coverage SET
            detector_set_version = (SELECT detector_set_version FROM operational_analysis_jobs WHERE id = job_id),
            input_low_water = (SELECT input_low_water FROM operational_analysis_jobs WHERE id = job_id),
            requested_high_water = (SELECT input_high_water FROM operational_analysis_jobs WHERE id = job_id),
            processed_high_water = (SELECT processed_high_water FROM operational_analysis_jobs WHERE id = job_id);
          UPDATE operational_analysis_schema SET version = 2;`);
        this.restoreMigratedCompletedAttempts();
        const timestamp = this.now();
        const recoverable = this.database.prepare(`SELECT * FROM operational_analysis_jobs
          WHERE (state = 'running' AND (lease_owner IS NULL OR lease_expires_at IS NULL))
            OR (state = 'retryable-failure' AND (retry_after IS NULL OR attempts >= 4))
          ORDER BY CASE WHEN state = 'running' THEN 0 ELSE 1 END`).all() as unknown as JobRow[];
        for (const row of recoverable) {
          // Recovering the running predecessor can already coalesce this retryable successor.
          if (!this.jobById(row.id)) continue;
          this.database.prepare(`UPDATE operational_analysis_jobs SET state = 'running', lease_owner = 'schema-migration', lease_expires_at = ?,
            attempts = MAX(attempts, 1) WHERE id = ?`).run(timestamp, row.id);
          const job = this.jobById(row.id)!;
          this.database.prepare(`INSERT INTO operational_analysis_attempts (job_id, attempt, repository_id, session_id, detector_set_version,
            input_low_water, requested_high_water, processed_high_water, outcome, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`)
            .run(job.id, job.attempts, job.repositoryId, job.sessionId, job.detectorSetVersion,
              job.inputLowWater, job.inputHighWater, job.processedHighWater, row.updated_at);
          this.failAttempt(job, 'lease-expired', timestamp);
        }
        version = 2;
      }
      this.database.exec(workerSlotSchema);
      this.database.exec(resultSchema);
      this.database.exec(contextSchema);
      if (version === 2) {
        this.database.prepare('UPDATE operational_analysis_schema SET version = 3').run();
        version = 3;
      }
      if (version !== 3) throw new TypeError('Unsupported operational analysis schema version.');
      if (this.database.prepare('PRAGMA foreign_key_check').all().length > 0) throw new TypeError('Operational analysis migration violates foreign keys.');
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    finally { this.database.exec('PRAGMA foreign_keys = ON'); }
  }

  private isCurrentMainSchema(): boolean {
    const table = this.database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table'
      AND name = 'operational_analysis_streams'`).get();
    if (!table) return false;
    const columns = new Set((this.database.prepare('PRAGMA table_info(operational_analysis_streams)').all() as Array<{ name: string }>).map(({ name }) => name));
    return columns.has('detector_version') && columns.has('desired_through') && columns.has('completed_through') && !columns.has('detector_set_version');
  }

  private migrateCurrentMainSchema(): void {
    const jobColumns = new Set((this.database.prepare('PRAGMA table_info(operational_analysis_jobs)').all() as Array<{ name: string }>).map(({ name }) => name));
    for (const required of ['id', 'repository_id', 'session_id', 'detector_version', 'input_high_water', 'state', 'attempts', 'created_at', 'updated_at']) {
      if (!jobColumns.has(required)) throw new TypeError('Unsupported current-main operational analysis schema.');
    }
    this.database.exec(`CREATE TABLE operational_analysis_streams_next (
      repository_id TEXT NOT NULL, session_id TEXT NOT NULL, detector_set_version TEXT NOT NULL,
      committed_high_water INTEGER NOT NULL, processed_high_water INTEGER NOT NULL DEFAULT 0,
      checkpoint_json TEXT NOT NULL DEFAULT '${emptyCheckpointJson}', next_generation INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(repository_id, session_id, detector_set_version)
    )`);
    this.database.exec(`INSERT INTO operational_analysis_streams_next
      (repository_id, session_id, detector_set_version, committed_high_water, processed_high_water, created_at, updated_at)
      SELECT repository_id, session_id, detector_version, desired_through, completed_through, created_at, updated_at
      FROM operational_analysis_streams`);
    this.database.exec(`CREATE TABLE operational_analysis_jobs_next (
      id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, session_id TEXT NOT NULL, detector_set_version TEXT NOT NULL,
      input_low_water INTEGER NOT NULL, input_high_water INTEGER NOT NULL, processed_high_water INTEGER NOT NULL,
      state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry_after TEXT, lease_owner TEXT,
      lease_expires_at TEXT, failure_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(repository_id, session_id, detector_set_version)
        REFERENCES operational_analysis_streams_next(repository_id, session_id, detector_set_version)
    )`);
    const inputFrom = jobColumns.has('input_from') ? 'input_from' : '1';
    const inputThrough = jobColumns.has('input_through') ? 'COALESCE(input_through, input_high_water)' : 'input_high_water';
    const nextEligible = jobColumns.has('next_eligible_at') ? 'next_eligible_at' : 'NULL';
    const streamFilter = jobColumns.has('stream_id') ? 'WHERE stream_id IS NOT NULL' : '';
    this.database.exec(`INSERT INTO operational_analysis_jobs_next
      (id, repository_id, session_id, detector_set_version, input_low_water, input_high_water, processed_high_water,
       state, attempts, retry_after, lease_owner, lease_expires_at, failure_reason, created_at, updated_at)
      SELECT id, repository_id, session_id, detector_version, MAX(0, ${inputFrom} - 1), ${inputThrough},
        CASE WHEN state = 'completed' THEN ${inputThrough} ELSE MAX(0, ${inputFrom} - 1) END,
        state, attempts, ${nextEligible}, NULL, NULL, NULL, created_at, updated_at
      FROM operational_analysis_jobs ${streamFilter}`);
    if (jobColumns.has('stream_id')) this.migrateUnlinkedCurrentMainJobs(inputThrough, nextEligible);
    this.database.exec(`CREATE TABLE operational_analysis_completed_migration (
      job_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, events_loaded REAL, findings INTEGER NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT NOT NULL, input_digest TEXT
    )`);
    const legacyCost = jobColumns.has('cost') ? 'cost' : 'NULL AS cost';
    const legacyDigest = jobColumns.has('input_digest') ? 'input_digest' : 'NULL AS input_digest';
    const completed = this.database.prepare(`SELECT id, attempts, ${legacyCost}, ${legacyDigest}, created_at, updated_at
      FROM operational_analysis_jobs WHERE state = 'completed'`).all() as Array<{
        id: string; attempts: number; cost: number | null; input_digest: string | null; created_at: string; updated_at: string;
      }>;
    const migratedAttempt = this.database.prepare(`INSERT INTO operational_analysis_completed_migration
      (job_id, attempts, events_loaded, findings, started_at, finished_at, input_digest) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const row of completed) {
      if (row.cost !== null && (!Number.isSafeInteger(row.cost) || row.cost < 0)) {
        throw new TypeError('Completed current-main analysis cost is invalid.');
      }
      const findings = Number((this.database.prepare(`SELECT COALESCE(SUM(findings), 0) AS count
        FROM operational_analysis_coverage WHERE job_id = ?`).get(row.id) as { count: number }).count);
      migratedAttempt.run(row.id, Math.max(1, row.attempts), row.cost ?? 0, findings,
        row.created_at, row.updated_at, row.input_digest);
    }
    this.database.exec(`DROP TABLE operational_analysis_jobs;
      DROP TABLE operational_analysis_streams;
      ALTER TABLE operational_analysis_streams_next RENAME TO operational_analysis_streams;
      ALTER TABLE operational_analysis_jobs_next RENAME TO operational_analysis_jobs;`);
    this.database.exec(jobIndexes);
    this.database.exec('CREATE TABLE operational_analysis_schema (version INTEGER PRIMARY KEY)');
    this.database.prepare('INSERT INTO operational_analysis_schema(version) VALUES (1)').run();
  }

  private restoreMigratedCompletedAttempts(): void {
    const exists = this.database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table'
      AND name = 'operational_analysis_completed_migration'`).get();
    if (!exists) return;
    this.database.exec(`INSERT INTO operational_analysis_attempts
      (job_id, attempt, repository_id, session_id, detector_set_version, input_low_water,
       requested_high_water, processed_high_water, events_loaded, findings, elapsed_ms,
       outcome, failure_category, started_at, finished_at)
      SELECT m.job_id, m.attempts, j.repository_id, j.session_id, j.detector_set_version,
        j.input_low_water, j.input_high_water, j.processed_high_water, CAST(m.events_loaded AS INTEGER),
        m.findings, 0, 'completed', NULL, m.started_at, m.finished_at
      FROM operational_analysis_completed_migration m JOIN operational_analysis_jobs j ON j.id = m.job_id`);
    this.database.exec('DROP TABLE operational_analysis_completed_migration');
  }

  private migrateUnlinkedCurrentMainJobs(inputThroughExpression: string, retryAfterExpression: string): void {
    const rows = this.database.prepare(`SELECT id, repository_id, session_id, ${inputThroughExpression} AS input_through,
      state, attempts, ${retryAfterExpression} AS retry_after, created_at, updated_at FROM operational_analysis_jobs WHERE stream_id IS NULL
      ORDER BY repository_id, session_id, input_through, updated_at, id`).all() as Array<{
        id: string; repository_id: string; session_id: string; input_through: number; state: AnalysisJob['state'];
        attempts: number; retry_after: string | null; created_at: string; updated_at: string;
      }>;
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = `${row.repository_id}\0${row.session_id}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const group of groups.values()) {
      const first = group[0]!;
      const existing = this.database.prepare(`SELECT committed_high_water, processed_high_water, created_at, updated_at
        FROM operational_analysis_streams_next WHERE repository_id = ? AND session_id = ? AND detector_set_version = ?`)
        .get(first.repository_id, first.session_id, LEGACY_DETECTOR_SET_VERSION) as {
          committed_high_water: number; processed_high_water: number; created_at: string; updated_at: string;
        } | undefined;
      const committedHighWater = Math.max(existing?.committed_high_water ?? 0, ...group.map(({ input_through }) => input_through));
      const processedHighWater = Math.max(existing?.processed_high_water ?? 0,
        ...group.filter(({ state }) => state === 'completed').map(({ input_through }) => input_through));
      const active = group.filter(({ state, input_through }) => input_through > processedHighWater &&
        (state === 'pending' || state === 'running' || state === 'retryable-failure')).at(-1);
      const createdAt = [existing?.created_at, ...group.map(({ created_at }) => created_at)].filter((value): value is string => value !== undefined).sort()[0]!;
      const updatedAt = [existing?.updated_at, ...group.map(({ updated_at }) => updated_at)].filter((value): value is string => value !== undefined).sort().at(-1)!;
      this.database.prepare(`INSERT INTO operational_analysis_streams_next
        (repository_id, session_id, detector_set_version, committed_high_water, processed_high_water, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(repository_id, session_id, detector_set_version) DO UPDATE SET
          committed_high_water = excluded.committed_high_water, processed_high_water = excluded.processed_high_water,
          created_at = excluded.created_at, updated_at = excluded.updated_at`)
        .run(first.repository_id, first.session_id, LEGACY_DETECTOR_SET_VERSION,
          committedHighWater, processedHighWater, createdAt, updatedAt);
      const insert = this.database.prepare(`INSERT INTO operational_analysis_jobs_next
        (id, repository_id, session_id, detector_set_version, input_low_water, input_high_water, processed_high_water,
         state, attempts, retry_after, lease_owner, lease_expires_at, failure_reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`);
      for (const row of group) {
        const selected = row === active;
        const state = selected ? row.state === 'running' ? 'running' : 'retryable-failure'
          : row.state === 'quarantined-input' ? 'quarantined-input' : 'completed';
        const inputLowWater = selected ? processedHighWater : 0;
        insert.run(row.id, row.repository_id, row.session_id, LEGACY_DETECTOR_SET_VERSION,
          inputLowWater, row.input_through, state === 'completed' ? row.input_through : inputLowWater,
          state, selected && state === 'running' ? Math.max(1, row.attempts) : row.attempts,
          selected && state === 'retryable-failure' ? row.retry_after ?? row.updated_at : null,
          row.created_at, row.updated_at);
      }
    }
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
        // The version-two migration recovers this unleased running row through the shared bounded retry path.
        .run(legacy.was_running ? 'running' : 'pending', legacy.attempts, job.id);
    }
  }

  private streamRow(repositoryId: string, sessionId: string, detectorSetVersion: string): StreamRow | undefined {
    return this.database.prepare(`SELECT * FROM operational_analysis_streams WHERE repository_id = ? AND session_id = ?
      AND detector_set_version = ?`).get(repositoryId, sessionId, detectorSetVersion) as unknown as StreamRow | undefined;
  }

  private transaction<T>(action: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.database.exec('COMMIT'); return result; }
    catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  private assertOwnedJob(jobId: string, fence: AnalysisFence, timestamp: string): AnalysisJob {
    assertFence(fence);
    const job = this.jobById(jobId);
    if (!job || job.state !== 'running' || job.leaseOwner !== fence.ownerId || job.attempts !== fence.attempt ||
      job.leaseExpiresAt === null || job.leaseExpiresAt <= timestamp) throw new TypeError('Analysis lease is not current or job is not running.');
    return job;
  }

  private pendingJob(job: AnalysisJob): { id: string; input_high_water: number } | undefined {
    return this.database.prepare(`SELECT id, input_high_water FROM operational_analysis_jobs
      WHERE repository_id = ? AND session_id = ? AND detector_set_version = ? AND state IN ('pending', 'retryable-failure')`)
      .get(job.repositoryId, job.sessionId, job.detectorSetVersion) as { id: string; input_high_water: number } | undefined;
  }

  private failAttempt(job: AnalysisJob, reason: AnalysisFailureReason, timestamp: string,
    processedHighWater = job.inputLowWater, metrics?: AnalysisMetrics): void {
    const eventsLoaded = metrics === undefined ? 0 : metrics.eventsLoaded;
    const findings = metrics?.findings ?? 0;
    assertInteger(processedHighWater, 'Failed attempt processed high-water');
    assertInteger(eventsLoaded, 'Failed attempt events loaded');
    assertInteger(findings, 'Failed attempt findings');
    if (processedHighWater < job.inputLowWater || processedHighWater > job.inputHighWater ||
      eventsLoaded < processedHighWater - job.inputLowWater) throw new TypeError('Failed attempt metrics conflict with the claimed range.');
    if (metrics !== undefined && (!Number.isFinite(metrics.elapsedMs) || metrics.elapsedMs < 0 || metrics.elapsedMs > Number.MAX_SAFE_INTEGER)) {
      throw new TypeError('Failed attempt elapsed time is invalid.');
    }
    const state = reason === 'invalid-input' || job.attempts >= 4 ? 'quarantined-input' : 'retryable-failure';
    let highWater = job.inputHighWater;
    if (state === 'retryable-failure') {
      const pending = this.pendingJob(job);
      if (pending) {
        highWater = Math.max(highWater, pending.input_high_water);
        this.database.prepare('DELETE FROM operational_analysis_jobs WHERE id = ?').run(pending.id);
      }
    }
    const retryAfter = state === 'quarantined-input' ? null : expiresAt(timestamp, [1_000, 5_000, 30_000][Math.min(job.attempts - 1, 2)]!);
    this.database.prepare(`UPDATE operational_analysis_jobs SET state = ?, input_high_water = ?, failure_reason = ?,
      retry_after = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND state = 'running' AND lease_owner = ? AND attempts = ?`)
      .run(state, highWater, reason, retryAfter, timestamp, job.id, job.leaseOwner, job.attempts);
    this.database.prepare(`UPDATE operational_analysis_attempts SET outcome = ?, failure_category = ?, finished_at = ?,
      processed_high_water = ?, events_loaded = ?, findings = ?,
      elapsed_ms = COALESCE(?, MAX(0, (julianday(?) - julianday(started_at)) * 86400000)) WHERE job_id = ? AND attempt = ?`)
      .run(state, reason, timestamp, processedHighWater, eventsLoaded, findings, metrics?.elapsedMs ?? null, timestamp, job.id, job.attempts);
  }

  private claimableRows(timestamp: string, filters: AnalysisFilters): JobRow[] {
    const filter = sqlFilters(filters);
    // A later range must retain an unresolved quarantined prefix.
    return this.database.prepare(`SELECT j.* FROM operational_analysis_jobs j
      JOIN operational_analysis_streams s ON s.repository_id = j.repository_id AND s.session_id = j.session_id
        AND s.detector_set_version = j.detector_set_version WHERE j.state IN ('pending', 'retryable-failure')
      AND (j.retry_after IS NULL OR j.retry_after <= ?) ${filter.sql} AND NOT EXISTS (
        SELECT 1 FROM operational_analysis_jobs running WHERE running.repository_id = j.repository_id AND running.session_id = j.session_id
        AND running.detector_set_version = j.detector_set_version AND running.state = 'running') AND NOT EXISTS (
        SELECT 1 FROM operational_analysis_jobs blocked WHERE blocked.repository_id = j.repository_id AND blocked.session_id = j.session_id
        AND blocked.detector_set_version = j.detector_set_version AND blocked.state = 'quarantined-input'
        AND blocked.input_high_water >= s.processed_high_water) ORDER BY j.created_at, j.id`).all(timestamp, ...filter.values) as unknown as JobRow[];
  }

  private validateResult(job: AnalysisJob, result: LearningResult, processedHighWater: number): void {
    const stagedEvidence = new Set<string>();
    for (const rawEvidence of result.episodeEvidence ?? []) {
      const evidence = createEpisodeEvidence(rawEvidence);
      if (stagedEvidence.has(evidence.id)) throw new TypeError('Duplicate episode evidence identity.');
      stagedEvidence.add(evidence.id);
    }
    for (const rawEvidence of result.episodeEvidence ?? []) {
      const evidence = createEpisodeEvidence(rawEvidence);
      if (!this.referencesEvidenceInScope(evidence.evidenceIds, job, stagedEvidence)) {
        throw new TypeError('Evidence reference is missing from the analysis job scope.');
      }
      const existing = this.database.prepare(`SELECT repository_id, session_id, payload_json
        FROM operational_episode_evidence WHERE id = ?`).get(evidence.id) as {
          repository_id: string; session_id: string; payload_json: string;
        } | undefined;
      if (existing !== undefined && (existing.repository_id !== job.repositoryId || existing.session_id !== job.sessionId)) {
        throw new TypeError('Evidence identity collision across analysis job scope.');
      }
      if (existing !== undefined && existing.payload_json !== JSON.stringify(evidence)) {
        throw new TypeError('Evidence payload conflicts with immutable identity.');
      }
    }
    const episodes = new Set<string>();
    for (const rawEpisode of result.episodes) {
      const episode = isTypedEpisode(rawEpisode) ? createTypedEpisode(rawEpisode) : createOperationalEpisode(rawEpisode);
      if (episode.repositoryId !== job.repositoryId || episode.sessionId !== job.sessionId ||
        (episode.detector !== job.detectorSetVersion && episode.detector !== LEGACY_DETECTOR_SET_VERSION))
        throw new TypeError('Episode scope or detector version conflicts with job.');
      if (isTypedEpisode(episode) && !this.referencesEvidenceInScope(typedEpisodeReferences(episode), job, stagedEvidence)) {
        throw new TypeError('Episode evidence is missing from the analysis job scope.');
      }
      const existing = this.database.prepare('SELECT repository_id, session_id, detector FROM operational_episodes WHERE id = ?').get(episode.id);
      if (existing && (existing.repository_id !== job.repositoryId || existing.session_id !== job.sessionId || existing.detector !== episode.detector))
        throw new TypeError('Episode identity conflicts with persisted scope.');
      if (episodes.has(episode.id)) throw new TypeError('Duplicate episode identity.');
      episodes.add(episode.id);
    }
    const findingIds = new Set<string>();
    for (const finding of result.findings) {
      if (findingIds.has(finding.id)) throw new TypeError('Duplicate finding identity.');
      findingIds.add(finding.id);
      if (finding.kind === 'insufficient-evidence') {
        const typed = createTypedFinding(finding);
        if (!this.referencesEvidenceInScope(typed.evidenceEventIds, job, stagedEvidence)) {
          throw new TypeError('Finding evidence is missing from the analysis job scope.');
        }
        const existing = this.database.prepare(`SELECT repository_id, session_id, evidence_json, statement
          FROM operational_insufficient_findings WHERE id = ?`).get(typed.id) as {
            repository_id: string; session_id: string; evidence_json: string; statement: string;
          } | undefined;
        if (existing !== undefined && (existing.repository_id !== job.repositoryId || existing.session_id !== job.sessionId)) {
          throw new TypeError('Finding identity conflicts with persisted scope.');
        }
        if (existing !== undefined && (existing.evidence_json !== JSON.stringify(typed.evidenceEventIds) || existing.statement !== typed.statement)) {
          throw new TypeError('Finding payload conflicts with immutable identity.');
        }
        continue;
      }
      if (!episodes.has(finding.episodeId)) throw new TypeError('Finding scope conflicts with result.');
      assertStreamIdentity(finding.id, finding.episodeId, finding.kind);
      if (!['repository-tool-convention', 'command-repair', 'ambiguous-repair'].includes(finding.kind) ||
        typeof finding.statement !== 'string' || !finding.statement.trim() || finding.statement.length > 2_048) throw new TypeError('Finding is invalid.');
      for (const eventId of finding.evidenceEventIds) assertStreamIdentity(eventId, eventId, eventId);
      const existing = this.database.prepare('SELECT episode_id FROM operational_findings WHERE id = ?').get(finding.id);
      if (existing && existing.episode_id !== finding.episodeId) throw new TypeError('Finding identity conflicts with persisted scope.');
    }
    for (const rawCandidate of result.candidates) {
      const candidate = createLearningCandidate(rawCandidate);
      if (!episodes.has(candidate.episodeId)) throw new TypeError('Candidate scope conflicts with result.');
      const existing = this.database.prepare('SELECT episode_id FROM operational_candidates WHERE id = ?').get(candidate.id);
      if (existing && existing.episode_id !== candidate.episodeId) throw new TypeError('Candidate identity conflicts with persisted scope.');
    }
    const detectors = new Set<string>();
    for (const coverage of result.coverage ?? []) {
      assertStreamIdentity(coverage.detector, coverage.detectorSetVersion, coverage.detector);
      assertInteger(coverage.examinedEvents, 'Examined events'); assertInteger(coverage.findings, 'Coverage findings');
      if (coverage.detectorSetVersion !== job.detectorSetVersion || coverage.inputLowWater !== job.inputLowWater ||
        coverage.requestedHighWater !== job.inputHighWater || coverage.processedHighWater !== processedHighWater ||
        !['completed', 'incomplete', 'failed'].includes(coverage.status) || detectors.has(coverage.detector) ||
        (coverage.status === 'completed' && processedHighWater !== job.inputHighWater)) throw new TypeError('Coverage range or detector version conflicts with job.');
      detectors.add(coverage.detector);
    }
  }

  private referencesEvidenceInScope(evidenceIds: readonly string[], job: AnalysisJob, staged = new Set<string>()): boolean {
    const statement = this.database.prepare(`SELECT 1 FROM operational_episode_evidence
      WHERE id = ? AND repository_id = ? AND session_id = ?`);
    return evidenceIds.every((id) => staged.has(id) || statement.get(id, job.repositoryId, job.sessionId) !== undefined);
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

function assertInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} is invalid.`);
}

function assertFence(input: AnalysisFence): void {
  assertStreamIdentity(input.ownerId, input.ownerId, input.ownerId);
  assertInteger(input.attempt, 'Attempt');
  if (input.attempt < 1) throw new TypeError('Attempt is invalid.');
}

function assertWorkerSlotFence(input: AnalysisWorkerSlotFence): void {
  assertFence(input);
  assertStreamIdentity(input.slotId, input.slotId, input.slotId);
}

function assertLeaseInput(input: AnalysisClaim): void {
  assertStreamIdentity(input.ownerId, input.ownerId, input.ownerId);
  assertInteger(input.leaseMs, 'Lease duration');
  if (input.leaseMs < 1) throw new TypeError('Lease duration is invalid.');
}

function expiresAt(timestamp: string, millis: number): string {
  return new Date(Date.parse(timestamp) + millis).toISOString();
}

function sqlFilters(filters: AnalysisFilters): { sql: string; values: string[] } {
  const conditions: string[] = []; const values: string[] = [];
  for (const [key, column] of [['repositoryId', 'repository_id'], ['sessionId', 'session_id'], ['detectorSetVersion', 'detector_set_version']] as const) {
    const value = filters[key];
    if (value !== undefined) {
      assertStreamIdentity(value, value, value);
      conditions.push(`AND j.${column} = ?`); values.push(value);
    }
  }
  return { sql: conditions.join(' '), values };
}

function validateCheckpoint(checkpoint: AnalysisStream['checkpoint'], sessionId: string): string {
  if (!checkpoint || checkpoint.version !== 1 || !Array.isArray(checkpoint.pendingEvents) || checkpoint.pendingEvents.length > 128 ||
    Object.keys(checkpoint).some((key) => key !== 'version' && key !== 'pendingEvents')) throw new TypeError('Detector checkpoint is invalid.');
  const identities = new Set<string>();
  const pendingEvents = checkpoint.pendingEvents.map((value) => {
    const event = validateNormalizedCaptureEvent(value as NormalizedCaptureEvent);
    if (event.sessionId !== sessionId || identities.has(event.id)) throw new TypeError('Checkpoint event scope or identity is invalid.');
    identities.add(event.id);
    return event;
  });
  return JSON.stringify({ version: 1, pendingEvents });
}

function freezeJson(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

type TypedEpisode = Extract<DerivedOperationalEpisode, { readonly kind: string }>;

function isTypedEpisode(value: DerivedOperationalEpisode): value is TypedEpisode {
  return 'kind' in value;
}

function typedEpisodeReferences(value: TypedEpisode): readonly string[] {
  if (value.kind === 'correction') return [value.originalDecisionEvidenceId, value.changedDecisionEvidenceId,
    ...(value.reasonEvidenceId === undefined ? [] : [value.reasonEvidenceId]),
    ...(value.outcomeEvidenceId === undefined ? [] : [value.outcomeEvidenceId]), ...value.evidenceEventIds];
  if (value.kind === 'verification-gap') return [value.closureEvidenceId,
    ...(value.implementationEvidenceId === undefined ? [] : [value.implementationEvidenceId]),
    ...(value.checkExecutionEvidenceId === undefined ? [] : [value.checkExecutionEvidenceId]),
    ...(value.checkResultEvidenceId === undefined ? [] : [value.checkResultEvidenceId]),
    ...(value.criterionEvidenceId === undefined ? [] : [value.criterionEvidenceId]), ...value.evidenceEventIds];
  return [value.firstAcceptanceEvidenceId, value.repeatedAcceptanceEvidenceId, ...value.evidenceEventIds];
}

function publicReport(report: OperationalLearningReport, secret: Uint8Array): OperationalLearningReport {
  const evidenceId = (value: string) => reportPseudonym(secret, 'evidence', value);
  const key = (value: string) => reportPseudonym(secret, 'key', value);
  const recordId = (value: string) => reportPseudonym(secret, 'record', value);
  const episodeEvidence = report.episodeEvidence.map((value) => Object.freeze({
    ...value, id: evidenceId(value.id),
    ...(value.decisionKey === undefined ? {} : { decisionKey: key(value.decisionKey) }),
    ...(value.scopeKey === undefined ? {} : { scopeKey: key(value.scopeKey) }),
    evidenceIds: Object.freeze(value.evidenceIds.map(evidenceId))
  }));
  const episodes = report.episodes.map((value) => isTypedEpisode(value) ? publicTypedEpisode(value, evidenceId, key, recordId) : value);
  const findings = report.findings.map((value) => value.kind === 'insufficient-evidence'
    ? Object.freeze({ ...value, id: recordId(value.id), episodeId: recordId(value.episodeId),
        evidenceEventIds: Object.freeze(value.evidenceEventIds.map(evidenceId)) })
    : value);
  return Object.freeze({ ...report, episodes: Object.freeze(episodes), findings: Object.freeze(findings),
    episodeEvidence: Object.freeze(episodeEvidence) });
}

function publicTypedEpisode(value: TypedEpisode, evidenceId: (value: string) => string,
  key: (value: string) => string, recordId: (value: string) => string): TypedEpisode {
  const base = { ...value, id: recordId(value.id), evidenceEventIds: Object.freeze(value.evidenceEventIds.map(evidenceId)) };
  if (value.kind === 'correction') return Object.freeze({ ...base,
    originalDecisionEvidenceId: evidenceId(value.originalDecisionEvidenceId),
    changedDecisionEvidenceId: evidenceId(value.changedDecisionEvidenceId),
    ...(value.reasonEvidenceId === undefined ? {} : { reasonEvidenceId: evidenceId(value.reasonEvidenceId) }),
    ...(value.outcomeEvidenceId === undefined ? {} : { outcomeEvidenceId: evidenceId(value.outcomeEvidenceId) }) });
  if (value.kind === 'verification-gap') return Object.freeze({ ...base,
    ...(value.implementationEvidenceId === undefined ? {} : { implementationEvidenceId: evidenceId(value.implementationEvidenceId) }),
    ...(value.checkExecutionEvidenceId === undefined ? {} : { checkExecutionEvidenceId: evidenceId(value.checkExecutionEvidenceId) }),
    ...(value.checkResultEvidenceId === undefined ? {} : { checkResultEvidenceId: evidenceId(value.checkResultEvidenceId) }),
    closureEvidenceId: evidenceId(value.closureEvidenceId),
    ...(value.criterionEvidenceId === undefined ? {} : { criterionEvidenceId: evidenceId(value.criterionEvidenceId) }) });
  return Object.freeze({ ...base, firstAcceptanceEvidenceId: evidenceId(value.firstAcceptanceEvidenceId),
    repeatedAcceptanceEvidenceId: evidenceId(value.repeatedAcceptanceEvidenceId), scopeKey: key(value.scopeKey) });
}

function reportPseudonym(secret: Uint8Array, category: 'evidence' | 'key' | 'record', value: string): string {
  return `${category}-${createHmac('sha256', secret).update(`ael:operational-learning-report:${category}:v1\0${value}`).digest('hex').slice(0, 32)}`;
}

function freezeContext(value: OperationalContextSnapshot): OperationalContextSnapshot {
  return Object.freeze({ ...value,
    instructions: Object.freeze(value.instructions.map((instruction) => Object.freeze({ ...instruction }))),
    conventions: Object.freeze(value.conventions.map((convention) => Object.freeze({ ...convention }))) });
}
