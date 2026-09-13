import { randomUUID } from 'node:crypto';

import { validateNormalizedCaptureEvent } from '../capture/normalization.js';
import type { SessionId } from '../domain/types.js';
import { ExperienceStore } from '../storage/experience-store.js';
import { validateDetectorCheckpoint, type AnalysisCoverage, type DetectorCheckpoint } from './contracts.js';
import { detectOperationalEpisodes } from './detectors.js';
import { readProjectToolConventions } from './project-conventions.js';
import {
  DETECTOR_SET_VERSION,
  OperationalLearningRepository,
  type AnalysisFailureReason,
  type AnalysisJob,
  type AnalysisMetrics,
  type OperationalLearningReport
} from './repository.js';

const DEFAULT_MAX_EVENTS = 1_024;
const DEFAULT_DEADLINE_MS = 250;
const JOB_LEASE_MS = 30_000;

interface OperationalLearningDependencies {
  readonly monotonicNow?: () => number;
  readonly detect?: typeof detectOperationalEpisodes;
  readonly openStore?: (databasePath: string) => ExperienceStore;
  readonly readConventions?: typeof readProjectToolConventions;
}

export interface LearningRunOptions {
  readonly ownerId?: string;
  readonly maxEvents?: number;
  readonly deadlineMs?: number;
  readonly repositoryId?: string;
}

export interface LearningRunResult {
  readonly status: 'idle' | 'completed' | 'retryable-failure' | 'quarantined-input';
  readonly jobId?: string;
}

export class OperationalLearningService {
  private readonly monotonicNow: () => number;
  private readonly detect: typeof detectOperationalEpisodes;
  private readonly openStore: (databasePath: string) => ExperienceStore;
  private readonly readConventions: typeof readProjectToolConventions;

  constructor(private readonly databasePath: string, dependencies: OperationalLearningDependencies = {}) {
    this.monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
    this.detect = dependencies.detect ?? detectOperationalEpisodes;
    this.openStore = dependencies.openStore ?? ((path) => new ExperienceStore(path));
    this.readConventions = dependencies.readConventions ?? readProjectToolConventions;
  }

  enqueueCommittedSession(repositoryId: string, sessionId: string): void {
    const store = this.openStore(this.databasePath);
    try {
      const records = store.listRepositoryRecords(repositoryId);
      const record = records.find(({ session }) => session.id === sessionId);
      if (!record) return;
      const repository = new OperationalLearningRepository(this.databasePath);
      try { repository.enqueue({ repositoryId, sessionId, inputHighWater: record.events.length }); } finally { repository.close(); }
    } finally { store.close(); }
  }

  runNext(options: LearningRunOptions = {}): LearningRunResult {
    const maxEvents = validateLimit(options.maxEvents, DEFAULT_MAX_EVENTS, 'Event limit');
    const deadlineMs = validateLimit(options.deadlineMs, DEFAULT_DEADLINE_MS, 'Deadline');
    const ownerId = options.ownerId ?? randomUUID();
    const repository = new OperationalLearningRepository(this.databasePath);
    try {
      const job = repository.claim({ ownerId, leaseMs: JOB_LEASE_MS, ...(options.repositoryId === undefined ? {} : { repositoryId: options.repositoryId }) });
      if (!job) return Object.freeze({ status: 'idle' });
      let store: ExperienceStore;
      try { store = this.openStore(this.databasePath); }
      catch { return this.fail(repository, job, ownerId, 'execution-failure'); }
      try {
        let checkpoint: DetectorCheckpoint;
        let repositoryRoot: string;
        let session: ReturnType<ExperienceStore['loadSession']>;
        let registration: ReturnType<ExperienceStore['listRepositories']>[number] | undefined;
        let stream: ReturnType<OperationalLearningRepository['stream']>;
        try {
          session = store.loadSession(job.sessionId as SessionId);
          registration = store.listRepositories().find(({ id }) => id === job.repositoryId);
          stream = repository.stream(job.repositoryId, job.sessionId, job.detectorSetVersion);
        } catch {
          return this.fail(repository, job, ownerId, 'execution-failure');
        }
        if (!session || session.repositoryId !== job.repositoryId || !registration || !stream || job.detectorSetVersion !== DETECTOR_SET_VERSION) {
          return this.fail(repository, job, ownerId, 'invalid-input');
        }
        try { checkpoint = validateDetectorCheckpoint(stream.checkpoint, job.sessionId); }
        catch { return this.fail(repository, job, ownerId, 'invalid-input'); }
        repositoryRoot = registration.root;

        const startedAt = this.monotonicNow();
        let range;
        try {
          range = store.loadCapturedSessionRange(job.sessionId as SessionId, {
            after: job.inputLowWater,
            through: job.inputHighWater,
            limit: maxEvents
          });
        } catch {
          const elapsedMs = this.monotonicNow() - startedAt;
          return this.fail(repository, job, ownerId, 'execution-failure', job.inputLowWater,
            { eventsLoaded: 0, findings: 0, elapsedMs });
        }
        const metrics = (findings: number, elapsedMs: number): AnalysisMetrics =>
          ({ eventsLoaded: range.events.length, findings, elapsedMs });
        if (range.availableHighWater < job.inputHighWater) {
          const elapsedMs = this.monotonicNow() - startedAt;
          return this.fail(repository, job, ownerId, 'invalid-input', range.actualHighWater, metrics(0, elapsedMs));
        }
        try {
          const identities = new Set(checkpoint.pendingEvents.map(({ id }) => id));
          for (const value of range.events) {
            const event = validateNormalizedCaptureEvent(value);
            if (event.sessionId !== job.sessionId || identities.has(event.id)) throw new TypeError('Captured input conflicts with its stream checkpoint.');
            identities.add(event.id);
          }
        } catch {
          const elapsedMs = this.monotonicNow() - startedAt;
          return this.fail(repository, job, ownerId, 'invalid-input', range.actualHighWater, metrics(0, elapsedMs));
        }

        let result;
        try {
          const conventions = this.readConventions(repositoryRoot);
          result = this.detect({
            repositoryId: job.repositoryId,
            sessionId: job.sessionId,
            events: range.events,
            conventions,
            checkpoint
          });
        } catch {
          const elapsedMs = this.monotonicNow() - startedAt;
          return this.fail(repository, job, ownerId, 'execution-failure', range.actualHighWater, metrics(0, elapsedMs));
        }

        const elapsedMs = this.monotonicNow() - startedAt;
        if (elapsedMs > deadlineMs) {
          return this.fail(repository, job, ownerId, 'timeout', range.actualHighWater, metrics(result.findings.length, elapsedMs));
        }
        const coverage = Object.freeze([coverageFor(job, range.actualHighWater, range.events.length, result.findings.length)]);
        try {
          repository.acknowledge(job.id, {
            ownerId, attempt: job.attempts, processedHighWater: range.actualHighWater, checkpoint: result.checkpoint,
            metrics: { eventsLoaded: range.events.length, findings: result.findings.length, elapsedMs },
            result: { ...result, coverage }
          });
          return Object.freeze({ status: 'completed', jobId: job.id });
        } catch (error) {
          return this.fail(repository, job, ownerId, 'execution-failure', range.actualHighWater,
            metrics(result.findings.length, elapsedMs), error);
        }
      } finally { store.close(); }
    } finally { repository.close(); }
  }

  report(repositoryId: string): OperationalLearningReport {
    const repository = new OperationalLearningRepository(this.databasePath);
    try { return repository.report(repositoryId); } finally { repository.close(); }
  }

  private fail(
    repository: OperationalLearningRepository,
    job: AnalysisJob,
    ownerId: string,
    reason: AnalysisFailureReason,
    processedHighWater?: number,
    metrics?: AnalysisMetrics,
    precedingError?: unknown
  ): LearningRunResult {
    try {
      repository.retry(job.id, {
        ownerId, attempt: job.attempts, reason,
        ...(processedHighWater === undefined ? {} : { processedHighWater }),
        ...(metrics === undefined ? {} : { metrics })
      });
    } catch (error) {
      const current = repository.jobById(job.id);
      if (!current) throw precedingError ?? error;
      const sameLease = current.state === 'running' && current.leaseOwner === ownerId && current.attempts === job.attempts;
      if (sameLease) {
        repository.recoverExpiredJobs();
        const afterRecovery = repository.jobById(job.id);
        if (afterRecovery?.state === 'running' && afterRecovery.leaseOwner === ownerId && afterRecovery.attempts === job.attempts) {
          throw precedingError ?? error;
        }
      }
    }
    return Object.freeze({ status: retryState(repository, job.id), jobId: job.id });
  }
}

function coverageFor(
  job: { readonly detectorSetVersion: string; readonly inputLowWater: number; readonly inputHighWater: number },
  processedHighWater: number,
  examinedEvents: number,
  findings: number
): AnalysisCoverage {
  return Object.freeze({
    detector: job.detectorSetVersion,
    detectorSetVersion: job.detectorSetVersion,
    status: processedHighWater < job.inputHighWater ? 'incomplete' : 'completed',
    inputLowWater: job.inputLowWater,
    requestedHighWater: job.inputHighWater,
    processedHighWater,
    examinedEvents,
    findings
  });
}

function retryState(repository: OperationalLearningRepository, jobId: string): 'retryable-failure' | 'quarantined-input' {
  return repository.jobById(jobId)?.state === 'quarantined-input' ? 'quarantined-input' : 'retryable-failure';
}

function validateLimit(value: number | undefined, fallback: number, label: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError(`${label} is invalid.`);
  return limit;
}
