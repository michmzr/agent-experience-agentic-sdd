import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Worker as NodeWorker } from 'node:worker_threads';

import type { AnalysisDiagnostic, AnalysisStatus, AnalysisWorkerSlot, AnalysisWorkerSlotFence, CoordinatorLease } from './repository.js';
import type { AnalysisWorkerSettings } from './worker-settings.js';

const COORDINATOR_LEASE_MS = 10_000;
const LEASE_RENEWAL_MS = COORDINATOR_LEASE_MS / 2;
const WORKER_SLOT_LEASE_MS = 45_000;
const WATCHDOG_HEARTBEAT_MS = 5_000;
const WATCHDOG_EXECUTION_LIMIT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

export interface AnalysisWorkerRepository {
  acquireCoordinatorLease(input: { readonly ownerId: string; readonly leaseMs: number }): CoordinatorLease | undefined;
  renewCoordinatorLease(input: { readonly ownerId: string; readonly attempt: number; readonly leaseMs: number }): CoordinatorLease | undefined;
  releaseCoordinatorLease(input: { readonly ownerId: string; readonly attempt: number }): boolean;
  recoverExpiredJobs(): number;
  claimableCount(): number;
  status(): Pick<AnalysisStatus, 'activeRunningCount' | 'nextRetryAt'>;
  reserveWorkerSlot(input: { readonly ownerId: string; readonly attempt: number; readonly leaseMs: number;
    readonly maxProcesses: number }): AnalysisWorkerSlot | undefined;
  releaseWorkerSlot(input: AnalysisWorkerSlotFence): boolean;
  recordDiagnostic(code: AnalysisDiagnostic): void;
}

export interface AnalysisWorkerHost {
  readonly now: () => number;
  readonly delay: (delayMs: number) => Promise<void>;
  readonly spawnChild: (dataDirectory: string, slot: AnalysisWorkerSlot) => Promise<number>;
}

export interface AnalysisCoordinatorResult {
  readonly status: 'idle-timeout' | 'lease-held';
}

export interface AnalysisWatchdogRepository {
  renewWorkerSlot(input: AnalysisWorkerSlotFence & { readonly leaseMs: number }): boolean;
  releaseWorkerSlot(input: AnalysisWorkerSlotFence): boolean;
}

export interface AnalysisWorkerExecution {
  readonly completion: Promise<number>;
  readonly terminate: () => Promise<number | void>;
}

export interface AnalysisWatchdogHost {
  readonly now: () => number;
  readonly delay: (delayMs: number) => Promise<void>;
  readonly spawnWorker: (dataDirectory: string, slot: AnalysisWorkerSlot) => AnalysisWorkerExecution;
}

export interface AnalysisWatchdogResult {
  readonly status: 'completed' | 'lease-lost' | 'timed-out' | 'launch-failed';
  readonly exitCode?: number;
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
  let callbacksEnabled = true;

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

      const launchCount = Math.min(Math.max(0, settings.maxProcesses - active.size), claimable);
      for (let index = 0; index < launchCount; index += 1) {
        const slot = repository.reserveWorkerSlot({ ownerId, attempt: lease.attempt,
          leaseMs: WORKER_SLOT_LEASE_MS, maxProcesses: settings.maxProcesses });
        if (!slot) break;
        let child: Promise<number>;
        try { child = host.spawnChild(dataDirectory, slot); }
        catch {
          repository.releaseWorkerSlot(slot);
          repository.recordDiagnostic('coordinator-launch-failed');
          continue;
        }
        let tracked: Promise<void>;
        tracked = child.then((exitCode) => {
          if (callbacksEnabled && exitCode !== 0) repository.recordDiagnostic('child-process-failed');
        }, () => {
          if (callbacksEnabled) {
            repository.releaseWorkerSlot(slot);
            repository.recordDiagnostic('coordinator-launch-failed');
          }
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
    callbacksEnabled = false;
    repository.releaseCoordinatorLease({ ownerId, attempt: lease.attempt });
  }
}

export function createProductionAnalysisWorkerHost(entrypoint = process.argv[1]): AnalysisWorkerHost {
  if (!entrypoint) throw new TypeError('Analysis worker entrypoint is unavailable.');
  return Object.freeze({
    now: () => Date.now(),
    delay: (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
    spawnChild: (dataDirectory: string, slot: AnalysisWorkerSlot) => new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath,
        [entrypoint, 'analysis', 'worker-watchdog', '--data-dir', dataDirectory,
          '--worker-slot-id', slot.slotId, '--worker-slot-owner', slot.ownerId,
          '--worker-slot-attempt', String(slot.attempt)], { stdio: 'ignore' });
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

/**
 * CLI wiring: `analysis worker-watchdog` calls this runner. Its Worker thread invokes
 * `analysis worker-child` with the same slot arguments, which the child passes to its job claim.
 */
export async function runAnalysisWorkerWatchdog(
  dataDirectory: string,
  slot: AnalysisWorkerSlot,
  repository: AnalysisWatchdogRepository,
  host: AnalysisWatchdogHost
): Promise<AnalysisWatchdogResult> {
  if (!repository.renewWorkerSlot({ ...slot, leaseMs: WORKER_SLOT_LEASE_MS })) {
    return Object.freeze({ status: 'lease-lost' });
  }
  let execution: AnalysisWorkerExecution;
  try { execution = host.spawnWorker(dataDirectory, slot); }
  catch {
    repository.releaseWorkerSlot(slot);
    return Object.freeze({ status: 'launch-failed' });
  }

  let completed = false;
  let exitCode = 1;
  let releaseAfterStop = false;
  void execution.completion.then((code) => {
    exitCode = code;
    completed = true;
  }, () => {
    exitCode = 1;
    completed = true;
  });
  const startedAt = host.now();
  const deadline = startedAt + WATCHDOG_EXECUTION_LIMIT_MS;
  let nextHeartbeat = startedAt + WATCHDOG_HEARTBEAT_MS;
  try {
    while (!completed) {
      const now = host.now();
      if (now >= deadline) {
        await execution.terminate();
        releaseAfterStop = true;
        return Object.freeze({ status: 'timed-out' });
      }
      if (now >= nextHeartbeat) {
        if (!repository.renewWorkerSlot({ ...slot, leaseMs: WORKER_SLOT_LEASE_MS })) {
          await execution.terminate();
          releaseAfterStop = true;
          return Object.freeze({ status: 'lease-lost' });
        }
        nextHeartbeat = now + WATCHDOG_HEARTBEAT_MS;
      }
      await host.delay(Math.max(1, Math.min(POLL_INTERVAL_MS, deadline - now, nextHeartbeat - now)));
    }
    releaseAfterStop = true;
    return Object.freeze({ status: 'completed', exitCode });
  } finally {
    if (releaseAfterStop) repository.releaseWorkerSlot(slot);
  }
}

export function createProductionAnalysisWatchdogHost(entrypoint = process.argv[1]): AnalysisWatchdogHost {
  if (!entrypoint) throw new TypeError('Analysis worker entrypoint is unavailable.');
  return Object.freeze({
    now: () => Date.now(),
    delay: (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
    spawnWorker: (dataDirectory: string, slot: AnalysisWorkerSlot) => {
      const worker = new NodeWorker(entrypoint, { argv: ['analysis', 'worker-child', '--data-dir', dataDirectory,
        '--worker-slot-id', slot.slotId, '--worker-slot-owner', slot.ownerId,
        '--worker-slot-attempt', String(slot.attempt)], stdout: true, stderr: true });
      worker.stdout?.resume();
      worker.stderr?.resume();
      let settled = false;
      const completion = new Promise<number>((resolve) => {
        worker.once('error', () => {
          if (settled) return;
          settled = true;
          resolve(1);
        });
        worker.once('exit', (code) => {
          if (settled) return;
          settled = true;
          resolve(code);
        });
      });
      return Object.freeze({ completion, terminate: () => worker.terminate() });
    }
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
