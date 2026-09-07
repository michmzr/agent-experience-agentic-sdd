import { dirname, join } from 'node:path';

import { ExperienceStore } from '../storage/experience-store.js';
import { createPassiveCaptureService } from './passive-service.js';
import { CaptureSpool, type CaptureSpoolStatus } from './spool.js';

export interface DrainCaptureSpoolInput {
  readonly databasePath: string;
  readonly now: () => string;
}

export function drainCaptureSpool(input: DrainCaptureSpoolInput): CaptureSpoolStatus {
  const spool = new CaptureSpool(join(dirname(input.databasePath), 'capture-spool.sqlite'));
  let store: ExperienceStore | undefined;
  try {
    store = new ExperienceStore(input.databasePath);
    const service = createPassiveCaptureService({ store });
    for (const claimed of spool.claim(input.now(), 100)) {
      const result = service.capture(claimed.record);
      if (result.status === 'degraded') spool.retry(claimed.deliveryId, input.now());
      else spool.acknowledge(claimed.deliveryId);
    }
    return spool.status();
  } finally {
    try { store?.close(); } finally { spool.close(); }
  }
}
