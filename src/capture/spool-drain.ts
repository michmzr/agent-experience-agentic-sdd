import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { ExperienceStore } from '../storage/experience-store.js';
import { loadProjectSettings } from '../config/project-settings.js';
import { OperationalLearningRepository } from '../learning/repository.js';
import { startAnalysisWorker, type AnalysisWorkerScheduler } from '../learning/worker-launcher.js';
import { persistPassiveCapture } from './passive-service.js';
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
  let store: ExperienceStore | undefined;
  let analysisWorkAdded = false;
  let captureAcknowledged = false;
  const unacknowledgedAnalysisAdmissions = new Set<string>();
  try {
    const settings = loadProjectSettings(input.projectRoot ?? process.cwd());
    const lockNow = new Date().toISOString();
    if (!spool.tryAcquireDrainLock(lockOwner, lockNow, settings.captureDeliveryDeadlineMs + 1_000)) return spool.status();
    store = new ExperienceStore(input.databasePath);
    const idleDeadline = Date.now() + settings.captureDeliveryDeadlineMs;
    do {
      const claimedRecords = spool.claim(input.now(), 100);
      for (const claimed of claimedRecords) {
        const observedAt = input.now();
        const deadlineAt = new Date(Date.parse(claimed.admittedAt) + settings.captureDeliveryDeadlineMs).toISOString();
        if (Date.parse(observedAt) > Date.parse(deadlineAt)) spool.recordDelayedDelivery(claimed.deliveryId, deadlineAt, observedAt);
        try {
          persistPassiveCapture(store, claimed.record);
          const analysisAdmission = admitCommittedSession(store, claimed.record, input.learningAdmission);
          if (analysisAdmission.admitted) unacknowledgedAnalysisAdmissions.add(claimed.deliveryId);
          spool.acknowledge(claimed.deliveryId, input.now());
          unacknowledgedAnalysisAdmissions.delete(claimed.deliveryId);
          captureAcknowledged = true;
          analysisWorkAdded ||= analysisAdmission.workAdded;
        } catch (error) {
          if (isRetryableCaptureError(error)) spool.retry(claimed.deliveryId, input.now());
          else if (error instanceof TypeError) spool.quarantine(claimed.deliveryId, 'CORRUPT', input.now());
          else spool.retry(claimed.deliveryId, input.now());
        }
      }
      const status = spool.status();
      if (status.pending === 0) break;
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
      try { spool.releaseDrainLock(lockOwner); } finally { spool.close(); }
    }
  }
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

function isRetryableCaptureError(error: unknown): boolean {
  return error instanceof TypeError && /missing session|requires a new session record|existing related pre-action/i.test(error.message);
}
