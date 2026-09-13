import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { AnalysisWorkerSettings } from '../src/learning/worker-settings.js';
import {
  createProductionAnalysisWorkerHost,
  runAnalysisCoordinator,
  type AnalysisWorkerHost,
  type AnalysisWorkerRepository
} from '../src/learning/worker.js';

const origin = Date.parse('2026-09-13T10:00:00.000Z');

class FakeRepository implements AnalysisWorkerRepository {
  pending = 0;
  running = 0;
  expired = 0;
  retryAt: number | undefined;
  lease: { ownerId: string; attempt: number; leaseExpiresAt: string } | undefined;
  attempts = 0;
  renewals = 0;
  releases = 0;
  recoveryCalls = 0;
  readonly acquisitionInputs: { ownerId: string; leaseMs: number }[] = [];
  readonly renewalInputs: { ownerId: string; attempt: number; leaseMs: number }[] = [];
  readonly diagnostics: string[] = [];

  constructor(private readonly currentTime: () => number) {}

  acquireCoordinatorLease(input: { ownerId: string; leaseMs: number }) {
    this.acquisitionInputs.push({ ...input });
    if (this.lease && Date.parse(this.lease.leaseExpiresAt) > this.currentTime()) return undefined;
    this.attempts += 1;
    this.lease = { ownerId: input.ownerId, attempt: this.attempts,
      leaseExpiresAt: new Date(this.currentTime() + input.leaseMs).toISOString() };
    return Object.freeze({ ...this.lease });
  }

  renewCoordinatorLease(input: { ownerId: string; attempt: number; leaseMs: number }) {
    this.renewalInputs.push({ ...input });
    if (!this.lease || this.lease.ownerId !== input.ownerId || this.lease.attempt !== input.attempt ||
      Date.parse(this.lease.leaseExpiresAt) <= this.currentTime()) return undefined;
    this.renewals += 1;
    this.lease = { ownerId: input.ownerId, attempt: input.attempt,
      leaseExpiresAt: new Date(this.currentTime() + input.leaseMs).toISOString() };
    return Object.freeze({ ...this.lease });
  }

  releaseCoordinatorLease(input: { ownerId: string; attempt: number }): boolean {
    if (!this.lease || this.lease.ownerId !== input.ownerId || this.lease.attempt !== input.attempt) return false;
    this.releases += 1;
    this.lease = undefined;
    return true;
  }

  recoverExpiredJobs(): number {
    this.recoveryCalls += 1;
    const recovered = this.expired;
    this.running -= recovered;
    this.pending += recovered;
    this.expired = 0;
    return recovered;
  }

  claimableCount(): number {
    return this.pending + (this.retryAt !== undefined && this.currentTime() >= this.retryAt ? 1 : 0);
  }

  status() {
    const eligibleRetry = this.retryAt !== undefined && this.currentTime() >= this.retryAt;
    return {
      activeRunningCount: this.running - this.expired,
      nextRetryAt: this.retryAt === undefined ? null : new Date(this.retryAt).toISOString(),
      jobs: {
        pending: this.pending,
        running: this.running,
        completed: 0,
        'retryable-failure': this.retryAt === undefined ? 0 : 1,
        'quarantined-input': 0
      },
      eligibleRetry
    };
  }

  recordDiagnostic(code: 'coordinator-launch-failed' | 'child-process-failed'): void {
    this.diagnostics.push(code);
  }

  takeWork(): void {
    if (this.pending > 0) this.pending -= 1;
    else if (this.retryAt !== undefined && this.currentTime() >= this.retryAt) this.retryAt = undefined;
    else throw new Error('No work is available.');
    this.running += 1;
  }

  finishWork(): void { this.running -= 1; }
}

interface DeferredChild { readonly finish: (code?: number) => void; }

function harness(options: { pending?: number; expired?: number; retryDelayMs?: number; idleTimeoutMs?: number; maxProcesses?: number } = {}) {
  let millis = origin;
  let active = 0;
  let maximumActive = 0;
  const startTimes: number[] = [];
  const children: DeferredChild[] = [];
  const repository = new FakeRepository(() => millis);
  repository.pending = options.pending ?? 0;
  repository.expired = options.expired ?? 0;
  repository.running = repository.expired;
  if (options.retryDelayMs !== undefined) repository.retryAt = millis + options.retryDelayMs;
  const host: AnalysisWorkerHost = {
    now: () => millis,
    delay: async (delayMs) => {
      millis += delayMs;
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    spawnChild: () => {
      repository.takeWork();
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      startTimes.push(millis);
      return new Promise<number>((resolve) => {
        children.push({ finish: (code = 0) => {
          repository.finishWork();
          active -= 1;
          resolve(code);
        } });
      });
    }
  };
  const settings: AnalysisWorkerSettings = Object.freeze({
    version: 1,
    maxProcesses: options.maxProcesses ?? 3,
    idleTimeoutMs: options.idleTimeoutMs ?? 1_000
  });
  return { repository, host, settings, children, startTimes, maximumActive: () => maximumActive,
    now: () => millis, advanceTime: (delayMs: number) => { millis += delayMs; } };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await nextTurn();
  assert.ok(predicate(), 'expected coordinator state was not reached');
}

test('only one coordinator owns the global lease', async () => {
  const setup = harness({ pending: 1 });
  const first = runAnalysisCoordinator('/data', setup.settings, setup.repository, setup.host, 'owner-1');
  await nextTurn();

  assert.deepEqual(await runAnalysisCoordinator('/data', setup.settings, setup.repository, setup.host, 'owner-2'),
    { status: 'lease-held' });
  setup.children[0]!.finish();
  assert.deepEqual(await first, { status: 'idle-timeout' });
  assert.equal(setup.repository.releases, 1);
});

test('uses ten-second fenced leases and permits takeover only after expiry', async () => {
  const setup = harness({ pending: 1 });
  const first = runAnalysisCoordinator('/data', setup.settings, setup.repository, setup.host, 'owner-1');

  assert.deepEqual(setup.repository.acquisitionInputs[0], { ownerId: 'owner-1', leaseMs: 10_000 });
  assert.deepEqual(await runAnalysisCoordinator('/data', setup.settings, setup.repository, setup.host, 'owner-2'),
    { status: 'lease-held' });
  assert.equal(setup.repository.lease?.ownerId, 'owner-1');

  setup.advanceTime(10_000);
  const takeover = runAnalysisCoordinator('/data', setup.settings, setup.repository, setup.host, 'owner-2');
  assert.equal(setup.repository.lease?.ownerId, 'owner-2');
  assert.equal(setup.repository.lease?.attempt, 2);
  await waitUntil(() => setup.repository.renewalInputs.length > 0);
  assert.ok(setup.repository.renewalInputs.every(({ leaseMs }) => leaseMs === 10_000));

  setup.children[0]!.finish();
  assert.deepEqual(await first, { status: 'lease-held' });
  assert.deepEqual(await takeover, { status: 'idle-timeout' });
});

test('lease takeover counts predecessor children against the global process cap', async () => {
  const setup = harness({ pending: 5, maxProcesses: 3 });
  const predecessor = runAnalysisCoordinator('/data', setup.settings, setup.repository, setup.host, 'owner-1');
  await waitUntil(() => setup.children.length === 3);

  setup.advanceTime(10_000);
  const successor = runAnalysisCoordinator('/data', setup.settings, setup.repository, setup.host, 'owner-2');
  const childrenAtTakeover = setup.children.length;

  let finished = 0;
  while (finished < 5) {
    await waitUntil(() => setup.children.length > finished);
    setup.children[finished]!.finish();
    finished += 1;
    await nextTurn();
  }
  assert.deepEqual(await predecessor, { status: 'lease-held' });
  assert.deepEqual(await successor, { status: 'idle-timeout' });
  assert.equal(childrenAtTakeover, 3);
  assert.equal(setup.maximumActive(), 3);
});

test('recovers expired jobs before counting work and starts a child for the recovered job', async () => {
  const setup = harness({ expired: 1 });
  const running = runAnalysisCoordinator('/data', setup.settings, setup.repository, setup.host, 'owner');
  await waitUntil(() => setup.children.length === 1);

  assert.ok(setup.repository.recoveryCalls >= 1);
  assert.equal(setup.repository.expired, 0);
  setup.children[0]!.finish();
  assert.deepEqual(await running, { status: 'idle-timeout' });
});

test('honours configured child concurrency and replaces completed children', async () => {
  for (const maxProcesses of [1, 3, 5]) {
    const setup = harness({ pending: 7, maxProcesses });
    const running = runAnalysisCoordinator('/data', setup.settings, setup.repository, setup.host, `owner-${maxProcesses}`);
    await nextTurn();
    assert.equal(setup.children.length, maxProcesses);
    assert.equal(setup.maximumActive(), maxProcesses);

    let finished = 0;
    while (finished < 7) {
      setup.children[finished]!.finish();
      finished += 1;
      await nextTurn();
    }
    assert.deepEqual(await running, { status: 'idle-timeout' });
    assert.equal(setup.maximumActive(), maxProcesses);
    assert.equal(setup.children.length, 7);
  }
});

test('records a nonzero child exit without stopping its sibling', async () => {
  const setup = harness({ pending: 2, maxProcesses: 2 });
  const running = runAnalysisCoordinator('/data', setup.settings, setup.repository, setup.host, 'owner');
  await nextTurn();
  setup.children[0]!.finish(7);
  await nextTurn();

  assert.deepEqual(setup.repository.diagnostics, ['child-process-failed']);
  assert.equal(setup.children.length, 2);
  setup.children[1]!.finish();
  assert.deepEqual(await running, { status: 'idle-timeout' });
});

test('renews the lease during work and stops spawning after fenced lease loss', async () => {
  const setup = harness({ pending: 2, maxProcesses: 1 });
  const running = runAnalysisCoordinator('/data', setup.settings, setup.repository, setup.host, 'owner');
  await waitUntil(() => setup.repository.renewals >= 1);

  setup.repository.lease = { ownerId: 'competitor', attempt: 99,
    leaseExpiresAt: new Date(setup.now() + 60_000).toISOString() };
  await nextTurn();
  assert.deepEqual(await running, { status: 'lease-held' });
  assert.equal(setup.children.length, 1);
  assert.equal(setup.repository.releases, 0);
  setup.children[0]!.finish();
});

test('waits for a 30 second retry instead of treating the stream as idle', async () => {
  const setup = harness({ retryDelayMs: 30_000, idleTimeoutMs: 300_000 });
  const running = runAnalysisCoordinator('/data', setup.settings, setup.repository, setup.host, 'owner');
  while (setup.children.length === 0) await nextTurn();

  assert.equal(setup.startTimes[0], origin + 30_000);
  setup.children[0]!.finish();
  assert.deepEqual(await running, { status: 'idle-timeout' });
});

test('releases its lease after exactly five simulated idle minutes', async () => {
  const setup = harness({ idleTimeoutMs: 300_000 });
  assert.deepEqual(await runAnalysisCoordinator('/data', setup.settings, setup.repository, setup.host, 'owner'),
    { status: 'idle-timeout' });
  assert.equal(setup.now(), origin + 300_000);
  assert.equal(setup.repository.releases, 1);
});

test('production host starts a one-shot worker child with the data directory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ael-analysis-worker-'));
  const entrypoint = join(directory, 'child.mjs');
  writeFileSync(entrypoint, `import { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst data = process.argv.at(-1);\nwriteFileSync(join(data, 'args.json'), JSON.stringify(process.argv.slice(2)));\n`);

  assert.equal(await createProductionAnalysisWorkerHost(entrypoint).spawnChild(directory), 0);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'args.json'), 'utf8')),
    ['analysis', 'worker-child', '--data-dir', directory]);
});
