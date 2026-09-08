import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { ExperienceStore } from '../storage/experience-store.js';
import { loadProjectSettings } from '../config/project-settings.js';
import { persistPassiveCapture } from './passive-service.js';
import { CaptureSpool, type CaptureSpoolStatus } from './spool.js';

export interface LearningAdmission {
  enqueueCommittedSession(repositoryId: string, sessionId: string): void;
}

export interface DrainCaptureSpoolInput {
  readonly databasePath: string;
  readonly now: () => string;
  readonly projectRoot?: string;
  readonly learningAdmission?: LearningAdmission;
}

export function drainCaptureSpool(input: DrainCaptureSpoolInput): CaptureSpoolStatus {
  const spool = new CaptureSpool(join(dirname(input.databasePath), 'capture-spool.sqlite'));
  const lockOwner = randomUUID();
  let store: ExperienceStore | undefined;
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
          admitCommittedSession(store, claimed.record, settings.automaticOperationalLearning !== false ? input.learningAdmission : undefined);
          spool.acknowledge(claimed.deliveryId, input.now());
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
    return spool.status();
  } finally {
    try { store?.close(); } finally {
      try { spool.releaseDrainLock(lockOwner); } finally { spool.close(); }
    }
  }
}

function admitCommittedSession(store: ExperienceStore, record: Parameters<typeof persistPassiveCapture>[1], learningAdmission: LearningAdmission | undefined): void {
  if (!learningAdmission) return;
  const sessionId = record.kind === 'session-start' ? record.session.id : record.kind === 'session-end' ? record.sessionId : record.event.sessionId;
  const session = store.loadSession(sessionId);
  if (!session?.repositoryId) return;
  try { learningAdmission.enqueueCommittedSession(session.repositoryId, session.id); } catch { /* Analysis admission never affects capture delivery. */ }
}

function isRetryableCaptureError(error: unknown): boolean {
  return error instanceof TypeError && /missing session|requires a new session record|existing related pre-action/i.test(error.message);
}
