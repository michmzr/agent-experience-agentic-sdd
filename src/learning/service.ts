import { ExperienceStore } from '../storage/experience-store.js';
import type { AnalysisCoverage } from './contracts.js';
import { detectOperationalEpisodes } from './detectors.js';
import { readProjectInstructionContext } from './project-conventions.js';
import { OperationalLearningRepository, type OperationalLearningReport } from './repository.js';
import { resolveRepository } from '../repository/local-repository.js';
import { loadProjectSettings } from '../config/project-settings.js';

const DEFAULT_MAX_EVENTS = 1_024;
const DEFAULT_DEADLINE_MS = 250;

export interface LearningRunResult {
  readonly status: 'idle' | 'completed' | 'retryable-failure' | 'quarantined-input';
  readonly jobId?: string;
}

export class OperationalLearningService {
  constructor(private readonly databasePath: string) {}

  enqueueCommittedSession(repositoryId: string, sessionId: string): void {
    const store = new ExperienceStore(this.databasePath);
    try {
      const records = store.listRepositoryRecords(repositoryId);
      const record = records.find(({ session }) => session.id === sessionId);
      const registration = store.listRepositories().find(({ id }) => id === repositoryId);
      if (!record || !registration) return;
      const repository = new OperationalLearningRepository(this.databasePath);
      try {
        const local = resolveRepository(registration.root);
        if (local) {
          const settings = loadProjectSettings(local.root);
          const context = readProjectInstructionContext(local.root, settings);
          repository.preserveContextSnapshot({ repositoryId, sessionId, repositoryFamilyKey: local.repositoryFamilyKey, worktreeKey: local.worktreeKey, instructions: context.instructions, conventions: context.conventions });
        }
        repository.enqueue({ repositoryId, sessionId, inputHighWater: record.events.length });
      } finally { repository.close(); }
    } finally { store.close(); }
  }

  runNext(options: { readonly maxEvents?: number; readonly deadlineMs?: number; readonly repositoryId?: string } = {}): LearningRunResult {
    const maxEvents = validateLimit(options.maxEvents, DEFAULT_MAX_EVENTS, 'Event limit');
    const deadlineMs = validateLimit(options.deadlineMs, DEFAULT_DEADLINE_MS, 'Deadline');
    const repository = new OperationalLearningRepository(this.databasePath);
    try {
      const job = repository.claim(options.repositoryId, maxEvents);
      if (!job) return Object.freeze({ status: 'idle' });
      const store = new ExperienceStore(this.databasePath);
      try {
        const records = store.listRepositoryRecords(job.repositoryId);
        const record = records.find(({ session }) => session.id === job.sessionId);
        const registration = store.listRepositories().find(({ id }) => id === job.repositoryId);
        if (!record || !registration) {
          repository.retry(job.id, 'invalid-input', job.leaseToken);
          return Object.freeze({ status: 'quarantined-input', jobId: job.id });
        }
        const startedAt = performance.now();
        const events = record.events.slice(job.inputFrom - 1, job.inputThrough);
        try {
          const snapshot = repository.contextSnapshotFor(job.repositoryId, job.sessionId);
          const conventions = snapshot?.conventions ?? readProjectInstructionContext(registration.root, loadProjectSettings(registration.root)).conventions;
          const result = detectOperationalEpisodes({ repositoryId: job.repositoryId, sessionId: job.sessionId, events, conventions });
          if (performance.now() - startedAt > deadlineMs) {
            repository.retry(job.id, 'timeout', job.leaseToken);
            return Object.freeze({ status: retryState(repository, job.id), jobId: job.id });
          }
          const coverage = Object.freeze([coverageFor(events.length, job.inputThrough - job.inputFrom + 1, result.findings.length)]);
          repository.saveResult(job.id, { ...result, coverage, inputDigest: `${job.inputFrom}:${job.inputThrough}:${events.map(({ id }) => id).join(',')}`, cost: events.length }, job.leaseToken);
          return Object.freeze({ status: 'completed', jobId: job.id });
        } catch {
          repository.retry(job.id, 'execution-failure', job.leaseToken);
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

function coverageFor(examinedEvents: number, totalEvents: number, findings: number): AnalysisCoverage {
  return Object.freeze({ detector: 'm6-deterministic@1', status: examinedEvents < totalEvents ? 'incomplete' : 'completed', examinedEvents, findings });
}

function retryState(repository: OperationalLearningRepository, jobId: string): 'retryable-failure' | 'quarantined-input' {
  return repository.jobById(jobId)?.state === 'quarantined-input' ? 'quarantined-input' : 'retryable-failure';
}

function validateLimit(value: number | undefined, fallback: number, label: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError(`${label} is invalid.`);
  return limit;
}
