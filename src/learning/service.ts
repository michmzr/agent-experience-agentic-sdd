import { createHash, createHmac, randomUUID } from 'node:crypto';

import type { CapturedEventRecord } from '../capture/contracts.js';
import { validateNormalizedCaptureEvent } from '../capture/normalization.js';
import { loadProjectSettings } from '../config/project-settings.js';
import type { SessionId } from '../domain/types.js';
import { resolveRepository } from '../repository/local-repository.js';
import { annotationEvidenceId, readIndexedAnnotation } from '../evidence/import.js';
import { ExperienceStore, type IndexedAnnotationEvidence } from '../storage/experience-store.js';
import {
  createEpisodeEvidence,
  validateDetectorCheckpoint,
  type AnalysisCoverage,
  type DetectorCheckpoint,
  type EpisodeEvidence,
  type EpisodeEvidenceState
} from './contracts.js';
import { detectOperationalEpisodes } from './detectors.js';
import { readProjectInstructionContext, type ProjectToolConvention } from './project-conventions.js';
import {
  DETECTOR_SET_VERSION,
  PREVIOUS_DETECTOR_SET_VERSION,
  OperationalLearningRepository,
  type AnalysisFailureReason,
  type AnalysisJob,
  type AnalysisMetrics,
  type AnalysisWorkerSlotFence,
  type OperationalLearningReport
} from './repository.js';

const DEFAULT_MAX_EVENTS = 1_024;
const DEFAULT_DEADLINE_MS = 250;
const JOB_LEASE_MS = 30_000;
const RELATION_LOOKBACK_PAGE = 128;

interface OperationalLearningDependencies {
  readonly monotonicNow?: () => number;
  readonly detect?: typeof detectOperationalEpisodes;
  readonly openStore?: (databasePath: string) => ExperienceStore;
  readonly readConventions?: (repositoryRoot: string) => readonly ProjectToolConvention[];
  readonly readContext?: typeof readProjectInstructionContext;
}

export interface LearningRunOptions {
  readonly ownerId?: string;
  readonly maxEvents?: number;
  readonly deadlineMs?: number;
  readonly repositoryId?: string;
  readonly workerSlot?: AnalysisWorkerSlotFence;
  /** Explicit bounded typed task evidence, used without transcript inference. */
  readonly episodeEvidence?: readonly EpisodeEvidence[];
}

export interface LearningRunResult {
  readonly status: 'idle' | 'completed' | 'retryable-failure' | 'quarantined-input';
  readonly jobId?: string;
}

export class OperationalLearningService {
  private readonly monotonicNow: () => number;
  private readonly detect: typeof detectOperationalEpisodes;
  private readonly openStore: (databasePath: string) => ExperienceStore;
  private readonly readConventions?: (repositoryRoot: string) => readonly ProjectToolConvention[];
  private readonly readContext: typeof readProjectInstructionContext;

  constructor(private readonly databasePath: string, dependencies: OperationalLearningDependencies = {}) {
    this.monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
    this.detect = dependencies.detect ?? detectOperationalEpisodes;
    this.openStore = dependencies.openStore ?? ((path) => new ExperienceStore(path));
    this.readConventions = dependencies.readConventions;
    this.readContext = dependencies.readContext ?? readProjectInstructionContext;
  }

  enqueueCommittedSession(repositoryId: string, sessionId: string): boolean {
    const store = this.openStore(this.databasePath);
    try {
      const records = store.listRepositoryRecords(repositoryId);
      const record = records.find(({ session }) => session.id === sessionId);
      const registration = store.listRepositories().find(({ id }) => id === repositoryId);
      if (!record || !registration) return false;
      const repository = new OperationalLearningRepository(this.databasePath);
      try {
        const local = resolveRepository(registration.root);
        if (local && repository.contextSnapshotFor(repositoryId, sessionId) === undefined) {
          const settings = loadProjectSettings(local.root);
          const context = this.readContext(local.root, settings);
          repository.preserveContextSnapshot({ repositoryId, sessionId,
            repositoryFamilyKey: local.repositoryFamilyKey, worktreeKey: local.worktreeKey,
            instructions: context.instructions, conventions: context.conventions, scopedConventions: context.scopedConventions,
            ...lifecycleContext(store, sessionId, repository.contextSecret()) });
        }
        return repository.enqueueWithOutcome({ repositoryId, sessionId,
          inputHighWater: store.logicalEvidenceHighWater(sessionId as SessionId) }).workAdded;
      } finally { repository.close(); }
    } finally { store.close(); }
  }

  runNext(options: LearningRunOptions = {}): LearningRunResult {
    const maxEvents = validateLimit(options.maxEvents, DEFAULT_MAX_EVENTS, 'Event limit');
    const deadlineMs = validateLimit(options.deadlineMs, DEFAULT_DEADLINE_MS, 'Deadline');
    const suppliedEvidence = validateSuppliedEpisodeEvidence(options.episodeEvidence);
    const ownerId = options.ownerId ?? randomUUID();
    const repository = new OperationalLearningRepository(this.databasePath);
    try {
      const job = repository.claim({ ownerId, leaseMs: JOB_LEASE_MS,
        ...(options.repositoryId === undefined ? {} : { repositoryId: options.repositoryId }),
        ...(options.workerSlot === undefined ? {} : { workerSlot: options.workerSlot }) });
      if (!job) return Object.freeze({ status: 'idle' });
      let store: ExperienceStore;
      try { store = this.openStore(this.databasePath); }
      catch { return this.fail(repository, job, ownerId, 'execution-failure'); }
      try {
        let checkpoint: DetectorCheckpoint;
        let repositoryRoot: string;
        let conventions: readonly ProjectToolConvention[];
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
        if (!session || session.repositoryId !== job.repositoryId || !registration || !stream
          || ![DETECTOR_SET_VERSION, PREVIOUS_DETECTOR_SET_VERSION].includes(job.detectorSetVersion)) {
          return this.fail(repository, job, ownerId, 'invalid-input');
        }
        try { checkpoint = validateDetectorCheckpoint(stream.checkpoint, job.sessionId); }
        catch { return this.fail(repository, job, ownerId, 'invalid-input'); }
        repositoryRoot = registration.root;
        try {
          const snapshot = repository.contextSnapshotFor(job.repositoryId, job.sessionId);
          conventions = snapshot?.conventions ?? this.readConventions?.(repositoryRoot) ?? [];
        } catch {
          return this.fail(repository, job, ownerId, 'execution-failure');
        }

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
          ({ eventsLoaded: range.events.length + range.annotations.length, findings, elapsedMs });
        if (range.availableHighWater < job.inputHighWater) {
          const elapsedMs = this.monotonicNow() - startedAt;
          return this.fail(repository, job, ownerId, 'invalid-input', Math.min(range.actualHighWater, range.availableHighWater), metrics(0, elapsedMs));
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
        let episodeEvidence: readonly EpisodeEvidence[];
        let relationCursor: number | undefined;
        try {
          const relationPage = loadRelatedAnnotationPage(store, job.repositoryId, job.sessionId as SessionId,
            job.inputLowWater, range.annotations, checkpoint.relationCursor ?? 0);
          relationCursor = relationPage.nextCursor;
          episodeEvidence = mergeEpisodeEvidence(
            [...(checkpoint.typedEvidence ?? []), ...episodeEvidenceFromCapture([...checkpoint.pendingEvents, ...range.events]),
              ...range.annotations.map(annotationEvidenceFromIndexed),
              ...relationPage.evidence], suppliedEvidence);
          result = this.detect({
            repositoryId: job.repositoryId,
            sessionId: job.sessionId,
            events: range.events,
            conventions,
            checkpoint,
            episodeEvidence
          });
        } catch {
          const elapsedMs = this.monotonicNow() - startedAt;
          return this.fail(repository, job, ownerId, 'execution-failure', range.actualHighWater, metrics(0, elapsedMs));
        }

        const elapsedMs = this.monotonicNow() - startedAt;
        if (elapsedMs > deadlineMs) {
          return this.fail(repository, job, ownerId, 'timeout', range.actualHighWater, metrics(result.findings.length, elapsedMs));
        }
        const processedHighWater = relationCursor === undefined ? range.actualHighWater : job.inputLowWater;
        const coverage = Object.freeze([coverageFor(job, processedHighWater,
          range.events.length + range.annotations.length, result.findings.length)]);
        try {
          repository.acknowledge(job.id, {
            ownerId, attempt: job.attempts, processedHighWater,
            checkpoint: validateDetectorCheckpoint({ ...result.checkpoint,
              ...(relationCursor === undefined ? {} : { pendingEvents: checkpoint.pendingEvents }),
              ...(relationCursor === undefined ? {} : { relationCursor }) }, job.sessionId),
            metrics: { eventsLoaded: range.events.length + range.annotations.length, findings: result.findings.length, elapsedMs },
            result: { ...result, episodeEvidence, coverage }
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
      const recovered = repository.recoverExpiredAttempt(job.id, {
        ownerId, attempt: job.attempts,
        ...(processedHighWater === undefined ? {} : { processedHighWater }),
        ...(metrics === undefined ? {} : { metrics })
      });
      if (!recovered) {
        const current = repository.jobById(job.id);
        if (!current || (current.state === 'running' && current.leaseOwner === ownerId && current.attempts === job.attempts)) {
          throw precedingError ?? error;
        }
      }
    }
    return Object.freeze({ status: retryState(repository, job.id), jobId: job.id });
  }
}

function episodeEvidenceFromCapture(events: readonly CapturedEventRecord[]): readonly EpisodeEvidence[] {
  const requests = new Map(events.filter(({ phase }) => phase === 'pre-action').map((event) => [event.sourceEventId, event]));
  return Object.freeze(events.flatMap((event) => {
    if (event.phase === 'pre-action') {
      const id = captureEvidenceId(event.source, event.sourceEventId);
      return [createEpisodeEvidence({ id, kind: 'tool-request', state: 'observed', origin: 'source-observed',
        decisionKey: captureDecisionKey(event), scopeKey: 'repository', evidenceIds: [id] })];
    }
    if (event.phase !== 'post-result') return [];
    const request = event.relatedEventId === undefined ? undefined : requests.get(event.relatedEventId);
    const id = captureEvidenceId(event.source, event.sourceEventId);
    const relatedId = event.relatedEventId === undefined ? id : captureEvidenceId(event.source, event.relatedEventId);
    return [createEpisodeEvidence({ id, kind: 'tool-result', state: captureEvidenceState(event.outcome), origin: 'source-observed',
      ...(request === undefined ? {} : { decisionKey: captureDecisionKey(request), scopeKey: 'repository' }),
      evidenceIds: [relatedId] })];
  }));
}

function annotationEvidenceFromIndexed(indexed: IndexedAnnotationEvidence): EpisodeEvidence {
  const { record, contextRevision } = readIndexedAnnotation(indexed);
  const id = annotationEvidenceId(indexed.producerNamespace, indexed.repositoryId, indexed.sessionId, indexed.evidenceId);
  const decisionKey = `decision-${createHash('sha256').update(record.decisionKey).digest('hex')}`;
  const scopeKey = `scope-${createHash('sha256').update(JSON.stringify([
    indexed.repositoryId, contextRevision, record.scopeKey
  ])).digest('hex')}`;
  return createEpisodeEvidence({ id, kind: record.kind, state: record.state, origin: record.origin,
    decisionKey, scopeKey, reasonClass: record.reasonClass,
    evidenceIds: [captureEvidenceId(record.operation.source, record.operation.sourceEventId),
      ...(record.relatedEvidenceIds ?? []).map((related) => annotationEvidenceId(indexed.producerNamespace,
        indexed.repositoryId, indexed.sessionId, related))] });
}

function loadRelatedAnnotationPage(store: ExperienceStore, repositoryId: string, sessionId: SessionId,
  beforeOrdinal: number, current: readonly IndexedAnnotationEvidence[], after: number): {
    readonly evidence: readonly EpisodeEvidence[]; readonly nextCursor?: number;
  } {
  type Lookup = { readonly kind: 'identity'; readonly namespace: string; readonly evidenceId: string } |
    { readonly kind: 'claim'; readonly namespace: string; readonly contextRevision: string;
      readonly decisionKey: string; readonly scopeKey: string };
  const keys = new Map<string, Lookup>();
  for (const indexed of current) {
    const { record, contextRevision } = readIndexedAnnotation(indexed);
    for (const evidenceId of record.relatedEvidenceIds ?? []) {
      const key = JSON.stringify(['identity', indexed.producerNamespace, evidenceId]);
      keys.set(key, { kind: 'identity', namespace: indexed.producerNamespace, evidenceId });
    }
    if (record.kind === 'agent-claim' && record.state === 'succeeded') {
      const key = JSON.stringify(['claim', indexed.producerNamespace, contextRevision, record.decisionKey, record.scopeKey]);
      keys.set(key, { kind: 'claim', namespace: indexed.producerNamespace, contextRevision,
        decisionKey: record.decisionKey, scopeKey: record.scopeKey });
    }
  }
  const ordered = [...keys.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
  if (after > ordered.length) throw new TypeError('Annotation relation continuation cursor is invalid.');
  const page = ordered.slice(after, after + RELATION_LOOKBACK_PAGE);
  const evidence = page.flatMap((lookup) => {
    const indexed = lookup.kind === 'identity'
      ? store.loadIndexedAnnotationByIdentity(repositoryId, sessionId, lookup.namespace, lookup.evidenceId, beforeOrdinal)
      : store.loadPriorScopedClaim(repositoryId, sessionId, lookup.namespace, lookup.contextRevision,
        lookup.decisionKey, lookup.scopeKey, beforeOrdinal);
    return indexed === undefined ? [] : [annotationEvidenceFromIndexed(indexed)];
  });
  const nextCursor = after + page.length < ordered.length ? after + page.length : undefined;
  return Object.freeze({ evidence: Object.freeze(evidence), ...(nextCursor === undefined ? {} : { nextCursor }) });
}

function validateSuppliedEpisodeEvidence(supplied: readonly EpisodeEvidence[] | undefined): readonly EpisodeEvidence[] {
  if (supplied === undefined) return Object.freeze([]);
  if (!Array.isArray(supplied) || supplied.length > 128) throw new TypeError('Supplied episode evidence is invalid.');
  const validated = supplied.map(createEpisodeEvidence);
  const ids = new Set<string>();
  for (const evidence of validated) {
    if (ids.has(evidence.id)) throw new TypeError('Supplied episode evidence contains duplicate identity.');
    ids.add(evidence.id);
  }
  return Object.freeze(validated);
}

function mergeEpisodeEvidence(captured: readonly EpisodeEvidence[], supplied: readonly EpisodeEvidence[]): readonly EpisodeEvidence[] {
  const internal = new Map<string, EpisodeEvidence>();
  for (const evidence of captured) {
    const previous = internal.get(evidence.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(evidence)) {
      throw new TypeError('Indexed episode evidence identity conflicts with retained content.');
    }
    internal.set(evidence.id, evidence);
  }
  for (const evidence of supplied) {
    if (internal.has(evidence.id)) throw new TypeError('Supplied episode evidence contains duplicate identity.');
    internal.set(evidence.id, evidence);
  }
  return Object.freeze([...internal.values()]);
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

function lifecycleContext(store: ExperienceStore, sessionId: string, contextSecret: Uint8Array): {
  readonly sourceAgentKey?: string; readonly conversationKey?: string; readonly runKey?: string;
} {
  const conversation = store.conversationForLegacySession(sessionId as SessionId);
  if (conversation === undefined) return Object.freeze({});
  const base = Object.freeze({
    sourceAgentKey: localContextKey(contextSecret, 'source-agent', conversation.source),
    conversationKey: localContextKey(contextSecret, 'conversation', conversation.id)
  });
  const runs = store.listConversationRuns(conversation.id);
  return runs.length === 1 ? Object.freeze({ ...base,
    runKey: localContextKey(contextSecret, 'run', runs[0]!.id) }) : base;
}

function localContextKey(contextSecret: Uint8Array, kind: string, value: string): string {
  return createHmac('sha256', contextSecret).update(`ael:operational-context:${kind}:v1\0${value}`).digest('hex');
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
