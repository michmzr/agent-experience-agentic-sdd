import { randomUUID } from 'node:crypto';

import { validateNormalizedCaptureEvent } from '../capture/normalization.js';
import type { SessionId } from '../domain/types.js';
import { ExperienceStore } from '../storage/experience-store.js';
import { validateDetectorCheckpoint, type AnalysisCoverage, type DetectorCheckpoint } from './contracts.js';
import { detectOperationalEpisodes } from './detectors.js';
import { readProjectToolConventions } from './project-conventions.js';
import { DETECTOR_SET_VERSION, OperationalLearningRepository, type OperationalLearningReport } from './repository.js';

const DEFAULT_MAX_EVENTS = 1_024;
const DEFAULT_DEADLINE_MS = 250;
const JOB_LEASE_MS = 30_000;

interface OperationalLearningDependencies {
  readonly monotonicNow?: () => number;
  readonly detect?: typeof detectOperationalEpisodes;
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

  constructor(private readonly databasePath: string, dependencies: OperationalLearningDependencies = {}) {
    this.monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
    this.detect = dependencies.detect ?? detectOperationalEpisodes;
  }

  enqueueCommittedSession(repositoryId: string, sessionId: string): void {
    const store = new ExperienceStore(this.databasePath);
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
      const store = new ExperienceStore(this.databasePath);
      try {
        let checkpoint: DetectorCheckpoint;
        let repositoryRoot: string;
        try {
          const session = store.loadSession(job.sessionId as SessionId);
          const registration = store.listRepositories().find(({ id }) => id === job.repositoryId);
          const stream = repository.stream(job.repositoryId, job.sessionId, job.detectorSetVersion);
          if (!session || session.repositoryId !== job.repositoryId || !registration || !stream || job.detectorSetVersion !== DETECTOR_SET_VERSION) {
            throw new TypeError('Analysis input is outside the claimed stream.');
          }
          checkpoint = validateDetectorCheckpoint(stream.checkpoint, job.sessionId);
          repositoryRoot = registration.root;
        } catch {
          repository.retry(job.id, { ownerId, attempt: job.attempts, reason: 'invalid-input' });
          return Object.freeze({ status: 'quarantined-input', jobId: job.id });
        }

        const startedAt = this.monotonicNow();
        let range;
        try {
          range = store.loadCapturedSessionRange(job.sessionId as SessionId, {
            after: job.inputLowWater,
            through: job.inputHighWater,
            limit: maxEvents
          });
          if (range.availableHighWater < job.inputHighWater) throw new TypeError('Captured input does not reach the claimed high-water.');
          const identities = new Set(checkpoint.pendingEvents.map(({ id }) => id));
          for (const value of range.events) {
            const event = validateNormalizedCaptureEvent(value);
            if (event.sessionId !== job.sessionId || identities.has(event.id)) throw new TypeError('Captured input conflicts with its stream checkpoint.');
            identities.add(event.id);
          }
        } catch {
          repository.retry(job.id, { ownerId, attempt: job.attempts, reason: 'invalid-input' });
          return Object.freeze({ status: 'quarantined-input', jobId: job.id });
        }

        let result;
        try {
          result = this.detect({
            repositoryId: job.repositoryId,
            sessionId: job.sessionId,
            events: range.events,
            conventions: readProjectToolConventions(repositoryRoot),
            checkpoint
          });
        } catch {
          const elapsedMs = this.monotonicNow() - startedAt;
          repository.retry(job.id, {
            ownerId, attempt: job.attempts, reason: 'execution-failure', processedHighWater: range.actualHighWater,
            metrics: { eventsLoaded: range.events.length, findings: 0, elapsedMs }
          });
          return Object.freeze({ status: retryState(repository, job.id), jobId: job.id });
        }

        const elapsedMs = this.monotonicNow() - startedAt;
        if (elapsedMs > deadlineMs) {
          repository.retry(job.id, {
            ownerId, attempt: job.attempts, reason: 'timeout', processedHighWater: range.actualHighWater,
            metrics: { eventsLoaded: range.events.length, findings: result.findings.length, elapsedMs }
          });
          return Object.freeze({ status: retryState(repository, job.id), jobId: job.id });
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
          if (repository.jobById(job.id)?.state !== 'running') throw error;
          repository.retry(job.id, {
            ownerId, attempt: job.attempts, reason: 'execution-failure', processedHighWater: range.actualHighWater,
            metrics: { eventsLoaded: range.events.length, findings: result.findings.length, elapsedMs }
          });
          return Object.freeze({ status: retryState(repository, job.id), jobId: job.id });
        }
      } finally { store.close(); }
    } finally { repository.close(); }
  }

  report(repositoryId: string): OperationalLearningReport {
    const repository = new OperationalLearningRepository(this.databasePath);
    try { return repository.report(repositoryId); } finally { repository.close(); }
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
