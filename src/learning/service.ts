import { createHash, createHmac } from 'node:crypto';
import type { CapturedEventRecord } from '../capture/contracts.js';
import { ExperienceStore } from '../storage/experience-store.js';
import { createEpisodeEvidence, type AnalysisCoverage, type EpisodeEvidence, type EpisodeEvidenceState } from './contracts.js';
import { detectOperationalEpisodes } from './detectors.js';
import { readProjectInstructionContext } from './project-conventions.js';
import { OperationalLearningRepository, type OperationalLearningReport } from './repository.js';
import { resolveRepository } from '../repository/local-repository.js';
import { loadProjectSettings } from '../config/project-settings.js';

const DEFAULT_MAX_EVENTS = 1_024;
const DEFAULT_DEADLINE_MS = 250;
const MAX_SUPPLIED_EPISODE_EVIDENCE = 128;

export interface LearningRunResult {
  readonly status: 'idle' | 'completed' | 'retryable-failure' | 'quarantined-input';
  readonly jobId?: string;
}

export interface LearningRunOptions {
  readonly maxEvents?: number;
  readonly deadlineMs?: number;
  readonly repositoryId?: string;
  /** Explicit bounded typed task evidence, used without transcript inference. */
  readonly episodeEvidence?: readonly EpisodeEvidence[];
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
          repository.preserveContextSnapshot({ repositoryId, sessionId, repositoryFamilyKey: local.repositoryFamilyKey, worktreeKey: local.worktreeKey, instructions: context.instructions, conventions: context.conventions, ...lifecycleContext(store, sessionId, repository.contextSecret()) });
        }
        repository.enqueue({ repositoryId, sessionId, inputHighWater: record.events.length });
      } finally { repository.close(); }
    } finally { store.close(); }
  }

  runNext(options: LearningRunOptions = {}): LearningRunResult {
    const maxEvents = validateLimit(options.maxEvents, DEFAULT_MAX_EVENTS, 'Event limit');
    const deadlineMs = validateLimit(options.deadlineMs, DEFAULT_DEADLINE_MS, 'Deadline');
    const suppliedEvidence = validateSuppliedEpisodeEvidence(options.episodeEvidence);
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
          const episodeEvidence = mergeEpisodeEvidence(episodeEvidenceFromCapture(events), suppliedEvidence);
          const result = detectOperationalEpisodes({ repositoryId: job.repositoryId, sessionId: job.sessionId, events, conventions, episodeEvidence });
          if (performance.now() - startedAt > deadlineMs) {
            repository.retry(job.id, 'timeout', job.leaseToken);
            return Object.freeze({ status: retryState(repository, job.id), jobId: job.id });
          }
          const coverage = Object.freeze([coverageFor(job.detectorVersion, events.length, job.inputThrough - job.inputFrom + 1, result.findings.length)]);
          repository.saveResult(job.id, { ...result, episodeEvidence, coverage, inputDigest: `${job.inputFrom}:${job.inputThrough}:${events.map(({ id }) => id).join(',')}`, cost: events.length }, job.leaseToken);
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

function episodeEvidenceFromCapture(events: readonly CapturedEventRecord[]): readonly EpisodeEvidence[] {
  const requests = new Map(events.filter(({ phase }) => phase === 'pre-action').map((event) => [event.sourceEventId, event]));
  return Object.freeze(events.flatMap((event) => {
    if (event.phase === 'pre-action') {
      const id = captureEvidenceId(event.source, event.sourceEventId);
      return [createEpisodeEvidence({ id, kind: 'tool-request', state: 'observed', decisionKey: captureDecisionKey(event), scopeKey: 'repository', evidenceIds: [id] })];
    }
    if (event.phase !== 'post-result') return [];
    const request = event.relatedEventId === undefined ? undefined : requests.get(event.relatedEventId);
    const id = captureEvidenceId(event.source, event.sourceEventId);
    const relatedId = event.relatedEventId === undefined ? id : captureEvidenceId(event.source, event.relatedEventId);
    return [createEpisodeEvidence({
      id, kind: 'tool-result', state: captureEvidenceState(event.outcome),
      ...(request === undefined ? {} : { decisionKey: captureDecisionKey(request), scopeKey: 'repository' }),
      evidenceIds: [relatedId]
    })];
  }));
}

function validateSuppliedEpisodeEvidence(supplied: readonly EpisodeEvidence[] | undefined): readonly EpisodeEvidence[] {
  if (supplied === undefined) return Object.freeze([]);
  if (!Array.isArray(supplied) || supplied.length > MAX_SUPPLIED_EPISODE_EVIDENCE) throw new TypeError('Supplied episode evidence is invalid.');
  const validated = supplied.map(createEpisodeEvidence);
  const ids = new Set<string>();
  for (const evidence of validated) {
    if (ids.has(evidence.id)) throw new TypeError('Supplied episode evidence contains duplicate identity.');
    ids.add(evidence.id);
  }
  return Object.freeze(validated);
}

function mergeEpisodeEvidence(captured: readonly EpisodeEvidence[], supplied: readonly EpisodeEvidence[]): readonly EpisodeEvidence[] {
  const merged = [...captured, ...supplied];
  const ids = new Set<string>();
  for (const evidence of merged) {
    if (ids.has(evidence.id)) throw new TypeError('Supplied episode evidence contains duplicate identity.');
    ids.add(evidence.id);
  }
  return Object.freeze(merged);
}

function captureEvidenceId(source: string, sourceEventId: string): string {
  return `capture-${createHash('sha256').update(`ael:episode-evidence:v1\\0${source}\\0${sourceEventId}`).digest('hex')}`;
}

function captureDecisionKey(event: CapturedEventRecord): string {
  return `decision-${createHash('sha256').update(`ael:episode-decision:v1\\0${JSON.stringify(event.signature)}`).digest('hex')}`;
}

function captureEvidenceState(outcome: CapturedEventRecord['outcome']): EpisodeEvidenceState {
  return outcome === 'succeeded' ? 'succeeded' : outcome === 'failed' ? 'failed' : 'observed';
}

function lifecycleContext(store: ExperienceStore, sessionId: string, contextSecret: Uint8Array): { readonly sourceAgentKey?: string; readonly conversationKey?: string; readonly runKey?: string } {
  const conversation = store.conversationForLegacySession(sessionId as never);
  if (conversation === undefined) return Object.freeze({});
  const base = Object.freeze({
    sourceAgentKey: localContextKey(contextSecret, 'source-agent', conversation.source),
    conversationKey: localContextKey(contextSecret, 'conversation', conversation.id)
  });
  const runs = store.listConversationRuns(conversation.id);
  return runs.length === 1 ? Object.freeze({ ...base, runKey: localContextKey(contextSecret, 'run', runs[0]!.id) }) : base;
}

function localContextKey(contextSecret: Uint8Array, kind: string, value: string): string {
  return createHmac('sha256', contextSecret).update(`ael:operational-context:${kind}:v1\0${value}`).digest('hex');
}

function coverageFor(detector: string, examinedEvents: number, totalEvents: number, findings: number): AnalysisCoverage {
  return Object.freeze({ detector, status: examinedEvents < totalEvents ? 'incomplete' : 'completed', examinedEvents, findings });
}

function retryState(repository: OperationalLearningRepository, jobId: string): 'retryable-failure' | 'quarantined-input' {
  return repository.jobById(jobId)?.state === 'quarantined-input' ? 'quarantined-input' : 'retryable-failure';
}

function validateLimit(value: number | undefined, fallback: number, label: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError(`${label} is invalid.`);
  return limit;
}
