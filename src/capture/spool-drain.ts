import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { ExperienceStore } from '../storage/experience-store.js';
import { loadProjectSettings } from '../config/project-settings.js';
import { persistPassiveCapture } from './passive-service.js';
import { CaptureSpool, type CaptureSpoolStatus } from './spool.js';

export interface DrainCaptureSpoolInput {
  readonly databasePath: string;
  readonly now: () => string;
  readonly projectRoot?: string;
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

function isRetryableCaptureError(error: unknown): boolean {
  return error instanceof TypeError && /missing session|requires a new session record|existing related pre-action/i.test(error.message);
}
