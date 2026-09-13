import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { AnalysisDiagnostic, AnalysisStatus, CoordinatorLease } from './repository.js';
import type { AnalysisWorkerSettings } from './worker-settings.js';

const COORDINATOR_LEASE_MS = 10_000;
const LEASE_RENEWAL_MS = COORDINATOR_LEASE_MS / 2;
const POLL_INTERVAL_MS = 250;

export interface AnalysisWorkerRepository {
  acquireCoordinatorLease(input: { readonly ownerId: string; readonly leaseMs: number }): CoordinatorLease | undefined;
  renewCoordinatorLease(input: { readonly ownerId: string; readonly attempt: number; readonly leaseMs: number }): CoordinatorLease | undefined;
  releaseCoordinatorLease(input: { readonly ownerId: string; readonly attempt: number }): boolean;
  recoverExpiredJobs(): number;
  claimableCount(): number;
  status(): Pick<AnalysisStatus, 'activeRunningCount' | 'nextRetryAt'>;
  recordDiagnostic(code: AnalysisDiagnostic): void;
}

export interface AnalysisWorkerHost {
  readonly now: () => number;
  readonly delay: (delayMs: number) => Promise<void>;
  readonly spawnChild: (dataDirectory: string) => Promise<number>;
}

export interface AnalysisCoordinatorResult {
  readonly status: 'idle-timeout' | 'lease-held';
}

export async function runAnalysisCoordinator(
  dataDirectory: string,
  settings: AnalysisWorkerSettings,
  repository: AnalysisWorkerRepository,
  host: AnalysisWorkerHost,
  ownerId: string = randomUUID()
): Promise<AnalysisCoordinatorResult> {
  validateSettings(settings);
  const initialLease = repository.acquireCoordinatorLease({ ownerId, leaseMs: COORDINATOR_LEASE_MS });
  if (!initialLease) return Object.freeze({ status: 'lease-held' });

  let lease = initialLease;
  let nextRenewal = host.now() + LEASE_RENEWAL_MS;
  let idleSince = host.now();
  const active = new Set<Promise<void>>();

  try {
    while (true) {
      const now = host.now();
      if (!Number.isFinite(now)) throw new TypeError('Analysis worker clock is invalid.');
      if (now >= nextRenewal) {
        const renewed = repository.renewCoordinatorLease({ ownerId, attempt: lease.attempt, leaseMs: COORDINATOR_LEASE_MS });
        if (!renewed) return Object.freeze({ status: 'lease-held' });
        lease = renewed;
        nextRenewal = now + LEASE_RENEWAL_MS;
      }

      repository.recoverExpiredJobs();
      const claimable = repository.claimableCount();
      const status = repository.status();
      if (claimable > 0 || status.activeRunningCount > 0 || active.size > 0) idleSince = now;

      const launchCount = Math.min(settings.maxProcesses - active.size, claimable);
      for (let index = 0; index < launchCount; index += 1) {
        let child: Promise<number>;
        try { child = host.spawnChild(dataDirectory); }
        catch {
          repository.recordDiagnostic('coordinator-launch-failed');
          continue;
        }
        let tracked: Promise<void>;
        tracked = child.then((exitCode) => {
          if (exitCode !== 0) repository.recordDiagnostic('child-process-failed');
        }, () => {
          repository.recordDiagnostic('coordinator-launch-failed');
        }).finally(() => {
          active.delete(tracked);
        });
        active.add(tracked);
      }
      if (launchCount > 0) idleSince = now;

      if (active.size === 0 && repository.claimableCount() === 0 && repository.status().activeRunningCount === 0 &&
        now - idleSince >= settings.idleTimeoutMs) {
        return Object.freeze({ status: 'idle-timeout' });
      }

      const waitMs = nextWait(now, nextRenewal, idleSince + settings.idleTimeoutMs, status.nextRetryAt);
      await host.delay(waitMs);
    }
  } finally {
    repository.releaseCoordinatorLease({ ownerId, attempt: lease.attempt });
  }
}

export function createProductionAnalysisWorkerHost(entrypoint = process.argv[1]): AnalysisWorkerHost {
  if (!entrypoint) throw new TypeError('Analysis worker entrypoint is unavailable.');
  return Object.freeze({
    now: () => Date.now(),
    delay: (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
    spawnChild: (dataDirectory: string) => new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath,
        [entrypoint, 'analysis', 'worker-child', '--data-dir', dataDirectory], { stdio: 'ignore' });
      let settled = false;
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        resolve(code ?? 1);
      });
    })
  });
}

function nextWait(now: number, renewalAt: number, idleAt: number, nextRetryAt: string | null): number {
  const boundaries = [now + POLL_INTERVAL_MS, renewalAt, idleAt];
  if (nextRetryAt !== null) {
    const retryAt = Date.parse(nextRetryAt);
    if (Number.isFinite(retryAt) && retryAt > now) boundaries.push(retryAt);
  }
  return Math.max(1, Math.min(...boundaries.map((boundary) => Math.max(1, boundary - now))));
}

function validateSettings(settings: AnalysisWorkerSettings): void {
  if (settings.version !== 1 || !Number.isSafeInteger(settings.maxProcesses) || settings.maxProcesses < 1 || settings.maxProcesses > 16 ||
    !Number.isSafeInteger(settings.idleTimeoutMs) || settings.idleTimeoutMs < 1_000 || settings.idleTimeoutMs > 3_600_000) {
    throw new TypeError('Analysis worker settings are invalid.');
  }
}
