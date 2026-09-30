import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { ExperienceStore } from '../storage/experience-store.js';
import { loadProjectSettings } from '../config/project-settings.js';
import { OperationalLearningRepository } from '../learning/repository.js';
import { startAnalysisWorker, type AnalysisWorkerScheduler } from '../learning/worker-launcher.js';
import { persistPassiveCapture, type PassiveCaptureRecord } from './passive-service.js';
import { CaptureSpool, type CaptureSpoolStatus } from './spool.js';

export interface LearningAdmission {
  enqueueCommittedSession(repositoryId: string, sessionId: string): boolean;
}

export interface DrainCaptureSpoolInput {
  readonly databasePath: string;
  readonly now: () => string;
  readonly projectRoot?: string;
  readonly learningAdmission?: LearningAdmission;
  readonly scheduleAnalysis?: AnalysisWorkerScheduler;
}

export function drainCaptureSpool(input: DrainCaptureSpoolInput): CaptureSpoolStatus {
  const spool = new CaptureSpool(join(dirname(input.databasePath), 'capture-spool.sqlite'));
  const lockOwner = randomUUID();
  let ownsDrainLock = false;
  let store: ExperienceStore | undefined;
  let analysisWorkAdded = false;
  let captureAcknowledged = false;
  const unacknowledgedAnalysisAdmissions = new Set<string>();
  try {
    const settings = loadProjectSettings(input.projectRoot ?? process.cwd());
    const lockNow = new Date().toISOString();
    if (!spool.tryAcquireDrainLock(lockOwner, lockNow, settings.captureDeliveryDeadlineMs + 1_000)) return spool.status();
    ownsDrainLock = true;
    store = new ExperienceStore(input.databasePath);
    const idleDeadline = Date.now() + settings.captureDeliveryDeadlineMs;
    do {
      const claimedRecords = spool.claim(input.now(), 100);
      for (const claimed of claimedRecords) {
        const observedAt = input.now();
        const deadlineAt = new Date(Date.parse(claimed.admittedAt) + settings.captureDeliveryDeadlineMs).toISOString();
        if (Date.parse(observedAt) > Date.parse(deadlineAt)) spool.recordDelayedDelivery(claimed.deliveryId, deadlineAt, observedAt);
        try {
          const dependency = missingDependency(store, input.databasePath, claimed.record);
          if (dependency !== undefined) {
            spool.waitForDependency(claimed.deliveryId, dependency.reason, dependency.source, dependency.id, input.now());
            continue;
          }
          const conflict = captureConflict(store, claimed.record);
          if (conflict !== undefined) {
            spool.quarantine(claimed.deliveryId, 'CORRUPT', input.now(), conflict);
            continue;
          }
          persistPassiveCapture(store, claimed.record);
          const analysisAdmission = admitCommittedSession(store, claimed.record, input.learningAdmission);
          if (analysisAdmission.admitted) unacknowledgedAnalysisAdmissions.add(claimed.deliveryId);
          releaseSatisfiedDependency(spool, claimed.record, input.now());
          spool.acknowledge(claimed.deliveryId, input.now());
          unacknowledgedAnalysisAdmissions.delete(claimed.deliveryId);
          captureAcknowledged = true;
          analysisWorkAdded ||= analysisAdmission.workAdded;
        } catch (error) {
          if (error instanceof TypeError) spool.quarantine(claimed.deliveryId, 'CORRUPT', input.now(), 'unknown-legacy');
          else spool.retry(claimed.deliveryId, input.now(), 'storage-unavailable');
        }
      }
      const status = spool.status();
      if (status.pending === 0) break;
      if (!spool.hasEligiblePending()) break;
      if (claimedRecords.length === 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    } while (Date.now() < idleDeadline);
    const status = spool.status();
    const reachedWakeBoundary = captureAcknowledged || (status.pending === 0 && status.claimed === 0);
    const hasWakeIntent = analysisWorkAdded || hasOutstandingAnalysisWork(input.databasePath, input.now);
    if (reachedWakeBoundary && unacknowledgedAnalysisAdmissions.size === 0 && hasWakeIntent) {
      scheduleAnalysis(input.databasePath, input.now, input.scheduleAnalysis ?? startAnalysisWorker);
    }
    return status;
  } finally {
    try { store?.close(); } finally {
      try { if (ownsDrainLock) spool.completeDrain(lockOwner); } finally { spool.close(); }
    }
  }
}

export function waitForWorkerCompletion(dataDirectory: string): boolean {
  const spool = new CaptureSpool(join(dataDirectory, 'capture-spool.sqlite'));
  try { return spool.isDrainComplete(); } finally { spool.close(); }
}

interface AnalysisAdmissionResult { readonly admitted: boolean; readonly workAdded: boolean; }

function admitCommittedSession(store: ExperienceStore, record: Parameters<typeof persistPassiveCapture>[1], learningAdmission: LearningAdmission | undefined): AnalysisAdmissionResult {
  if (!learningAdmission) return { admitted: false, workAdded: false };
  const sessionId = record.kind === 'session-start' ? record.session.id : record.kind === 'session-end' ? record.sessionId : record.event.sessionId;
  const session = store.loadSession(sessionId);
  if (!session?.repositoryId) return { admitted: false, workAdded: false };
  const registration = store.listRepositories().find(({ id }) => id === session.repositoryId);
  if (!registration) return { admitted: false, workAdded: false };
  try {
    if (loadProjectSettings(registration.root).automaticOperationalLearning === false) return { admitted: false, workAdded: false };
    return { admitted: true, workAdded: learningAdmission.enqueueCommittedSession(session.repositoryId, session.id) };
  }
  catch { return { admitted: false, workAdded: false }; /* Analysis admission never affects capture delivery. */ }
}

function hasOutstandingAnalysisWork(databasePath: string, now: () => string): boolean {
  let repository: OperationalLearningRepository | undefined;
  try {
    repository = new OperationalLearningRepository(databasePath, now);
    return repository.hasOutstandingWork();
  } catch {
    return false;
  } finally {
    try { repository?.close(); } catch { /* Wake inspection remains best effort. */ }
  }
}

function scheduleAnalysis(databasePath: string, now: () => string, schedule: AnalysisWorkerScheduler): void {
  let failureRecorded = false;
  const onFailure = (): void => {
    if (failureRecorded) return;
    failureRecorded = true;
    let repository: OperationalLearningRepository | undefined;
    try {
      repository = new OperationalLearningRepository(databasePath, now);
      repository.recordDiagnostic('coordinator-launch-failed');
    } catch {
      // Diagnostics cannot change durable capture acknowledgement.
    } finally {
      try { repository?.close(); } catch { /* Diagnostics cleanup remains best effort. */ }
    }
  };
  try { schedule({ dataDirectory: dirname(databasePath), onFailure }); }
  catch { onFailure(); }
}

function missingDependency(store: ExperienceStore, databasePath: string, record: PassiveCaptureRecord): { readonly reason: 'missing-session' | 'missing-request'; readonly source: 'codex' | 'cursor'; readonly id: string } | undefined {
  if (record.kind === 'session-end' && store.loadSession(record.sessionId) === undefined) {
    return supportedSource(record.source) === undefined ? undefined : { reason: 'missing-session', source: supportedSource(record.source)!, id: record.sessionId };
  }
  if (record.kind !== 'technical') return undefined;
  const source = supportedSource(record.event.source);
  if (source === undefined) return undefined;
  if (record.session === undefined && store.loadSession(record.event.sessionId) === undefined) {
    return { reason: 'missing-session', source, id: record.event.sessionId };
  }
  if (record.event.phase !== 'post-result' || record.event.relatedEventId === undefined) return undefined;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const related = database.prepare(`SELECT 1 FROM capture_events WHERE source = ? AND source_event_id = ? AND phase = 'pre-action'
      UNION ALL SELECT 1 FROM capture_run_events WHERE source = ? AND source_event_id = ? AND phase = 'pre-action' LIMIT 1`)
      .get(record.event.source, record.event.relatedEventId, record.event.source, record.event.relatedEventId);
    return related === undefined ? { reason: 'missing-request', source, id: record.event.relatedEventId } : undefined;
  } finally { database.close(); }
}

function captureConflict(store: ExperienceStore, record: PassiveCaptureRecord): 'conflicting-identity' | 'lifecycle-conflict' | undefined {
  if (record.kind === 'session-start' && record.lifecycle?.startOrigin !== 'resume') {
    const current = store.loadSession(record.session.id);
    if (current !== undefined && (current.source !== record.session.source || current.startedAt !== record.session.startedAt
      || current.repositoryId !== record.session.repositoryId || current.workspaceId !== record.session.workspaceId
      || current.userId !== record.session.userId)) return 'conflicting-identity';
  }
  if (record.kind === 'session-end') {
    const current = store.loadSession(record.sessionId);
    if (current !== undefined && current.source !== record.source) return 'lifecycle-conflict';
  }
  return undefined;
}

function releaseSatisfiedDependency(spool: CaptureSpool, record: PassiveCaptureRecord, now: string): void {
  if (record.kind === 'session-start') {
    const source = supportedSource(record.session.source);
    if (source !== undefined) spool.releaseDependency(source, record.session.id, now);
  } else if (record.kind === 'technical' && record.event.phase === 'pre-action') {
    const source = supportedSource(record.event.source);
    if (source !== undefined) spool.releaseDependency(source, record.event.sourceEventId, now);
  }
}

function supportedSource(source: string): 'codex' | 'cursor' | undefined {
  return source === 'codex' || source === 'cursor' ? source : undefined;
}
