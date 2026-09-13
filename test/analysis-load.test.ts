import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { adaptCodexCapture } from '../src/capture/adapters/codex.js';
import type { NormalizedCaptureEvent } from '../src/capture/contracts.js';
import type { SessionId } from '../src/domain/types.js';
import { OperationalLearningRepository, type AnalysisWorkerSlot } from '../src/learning/repository.js';
import { OperationalLearningService } from '../src/learning/service.js';
import { runAnalysisCoordinator, type AnalysisWorkerHost } from '../src/learning/worker.js';
import { ExperienceStore } from '../src/storage/experience-store.js';

const startedAt = '2026-09-13T10:00:00.000Z';
const temporaryDirectories: string[] = [];

test.after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function fixture(prefix: string): { readonly dataDir: string; readonly databasePath: string; readonly root: string } {
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(dataDir);
  const root = join(dataDir, 'repository');
  mkdirSync(root);
  writeFileSync(join(root, 'AGENTS.md'), 'Use pnpm instead of npm\n');
  return { dataDir, root, databasePath: join(dataDir, 'experience.sqlite') };
}

function event(sessionId: string, ordinal: number): NormalizedCaptureEvent {
  const repairIndex = ordinal % 4;
  const groupOrdinal = ordinal - repairIndex;
  const sourceEventId = `${sessionId}-event-${String(ordinal).padStart(4, '0')}`;
  const requestOrdinal = repairIndex === 1 || repairIndex === 3 ? ordinal - 1 : ordinal;
  const requestId = `${sessionId}-event-${String(requestOrdinal).padStart(4, '0')}`;
  const failed = repairIndex < 2;
  const result = repairIndex === 1 || repairIndex === 3;
  return adaptCodexCapture({
    event_id: sourceEventId,
    session_id: sessionId,
    event_kind: result ? 'post_result' : 'pre_action',
    occurred_at: new Date(Date.parse(startedAt) + ordinal).toISOString(),
    tool: 'shell',
    action: failed ? 'npm' : 'pnpm',
    arguments: [`install-${groupOrdinal}`],
    cwd: '/work/repository',
    summary: 'Sanitized load fixture.',
    ...(result ? {
      outcome: failed ? 'failed' : 'succeeded',
      exit_status: failed ? 1 : 0,
      related_event_id: requestId
    } : {})
  });
}

function register(store: ExperienceStore, root: string, sessionIds: readonly string[]): void {
  store.registerRepository({ id: 'repo-1', root, observedAt: startedAt });
  for (const sessionId of sessionIds) {
    store.appendIncremental({
      session: { id: sessionId as SessionId, source: 'codex', startedAt, repositoryId: 'repo-1' as never }
    });
  }
}

function setImmediatePromise(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) await setImmediatePromise();
  assert.ok(predicate(), message);
}

function resultIdentityCounts(databasePath: string): Readonly<Record<string, { readonly total: number; readonly unique: number }>> {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Object.freeze(Object.fromEntries(['operational_episodes', 'operational_findings', 'operational_candidates'].map((table) => {
      const row = database.prepare(`SELECT COUNT(*) AS total, COUNT(DISTINCT id) AS unique_count FROM ${table}`).get() as {
        total: number; unique_count: number;
      };
      return [table, Object.freeze({ total: Number(row.total), unique: Number(row.unique_count) })];
    })));
  } finally { database.close(); }
}

function assertNoDuplicateResults(databasePath: string, requireResults = false): void {
  const counts = resultIdentityCounts(databasePath);
  if (requireResults) {
    assert.ok(counts.operational_episodes!.total > 0, 'fixture must produce at least one operational episode');
    assert.ok(counts.operational_findings!.total > 0, 'fixture must produce at least one operational finding');
    assert.ok(counts.operational_candidates!.total > 0, 'fixture must produce at least one operational candidate');
  }
  for (const value of Object.values(counts)) assert.equal(value.total, value.unique);
}

test('coalesces 565 high-water admissions into one 559-event stream without measurable rereads', async () => {
  const { dataDir, databasePath, root } = fixture('ael-analysis-load-');
  const store = new ExperienceStore(databasePath);
  register(store, root, ['session-load']);
  const repository = new OperationalLearningRepository(databasePath);
  for (let admission = 1; admission <= 565; admission += 1) {
    const highWater = Math.min(admission, 559);
    if (admission <= 559) assert.equal(store.appendIncremental({ event: event('session-load', admission - 1) }).inserted, true);
    repository.enqueueWithOutcome({ repositoryId: 'repo-1', sessionId: 'session-load', inputHighWater: highWater });
  }

  assert.equal(repository.jobsForStream('repo-1', 'session-load').length, 1);
  assert.equal(repository.stream('repo-1', 'session-load')?.committedHighWater, 559);
  let activeChildren = 0;
  let maximumChildren = 0;
  let coordinatorNow = Date.now();
  const service = new OperationalLearningService(databasePath);
  const host: AnalysisWorkerHost = {
    now: () => coordinatorNow,
    delay: async (delayMs) => { coordinatorNow += delayMs; await setImmediatePromise(); },
    spawnChild: async (_directory, slot) => {
      activeChildren += 1;
      maximumChildren = Math.max(maximumChildren, activeChildren);
      const result = service.runNext({ ownerId: `load-${slot.slotId}`, workerSlot: slot });
      await setImmediatePromise();
      repository.releaseWorkerSlot(slot);
      activeChildren -= 1;
      return result.status === 'completed' ? 0 : 1;
    }
  };
  assert.deepEqual(await runAnalysisCoordinator(dataDir,
    { version: 1, maxProcesses: 3, idleTimeoutMs: 1_000 }, repository, host, 'load-coordinator'), { status: 'idle-timeout' });

  const stream = repository.stream('repo-1', 'session-load');
  const status = repository.status();
  const captured = store.loadCapturedSessionRange('session-load' as SessionId, { after: 0, through: 559, limit: 559 });
  assert.equal(captured.actualHighWater, 559);
  assert.deepEqual(captured.events.map(({ sourceEventId }) => sourceEventId),
    Array.from({ length: 559 }, (_, ordinal) => `session-load-event-${String(ordinal).padStart(4, '0')}`));
  assert.equal(stream?.processedHighWater, 559);
  assert.equal(stream?.committedHighWater, 559);
  assert.equal(status.uniqueAcknowledgedEvents, 559);
  assert.ok(status.rereadRatio <= 1.05, `reread ratio ${status.rereadRatio} exceeded 1.05`);
  assert.equal(status.failureCounts['execution-failure'] + status.failureCounts.timeout +
    status.failureCounts['invalid-input'] + status.failureCounts['lease-expired'], 0);
  assert.deepEqual({ pending: status.jobs.pending, running: status.jobs.running,
    retryable: status.jobs['retryable-failure'], quarantined: status.jobs['quarantined-input'] },
    { pending: 0, running: 0, retryable: 0, quarantined: 0 });
  assert.ok(maximumChildren <= 3);

  const database = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(Number((database.prepare('SELECT COUNT(*) AS count FROM operational_analysis_streams').get() as { count: number }).count), 1);
  database.close();
  assertNoDuplicateResults(databasePath, true);
  repository.close();
  store.close();
});

test('restart recovers three leased streams and arrivals admitted while their children are active', async () => {
  const { dataDir, databasePath, root } = fixture('ael-analysis-restart-');
  const sessionIds = ['session-a', 'session-b', 'session-c'] as const;
  const store = new ExperienceStore(databasePath);
  register(store, root, sessionIds);
  const repository = new OperationalLearningRepository(databasePath);
  for (const sessionId of sessionIds) {
    store.appendIncremental({ event: event(sessionId, 0) });
    repository.enqueueWithOutcome({ repositoryId: 'repo-1', sessionId, inputHighWater: 1 });
  }

  let logicalNow = Date.now();
  let wakeCoordinator: (() => void) | undefined;
  const heldChildren: Array<{ readonly finish: () => void }> = [];
  const lostHost: AnalysisWorkerHost = {
    now: () => logicalNow,
    delay: () => new Promise<void>((resolve) => { wakeCoordinator = resolve; }),
    spawnChild: (_directory, slot) => {
      const childRepository = new OperationalLearningRepository(databasePath);
      const claimed = childRepository.claim({ ownerId: `lost-${slot.slotId}`, leaseMs: 30_000, workerSlot: slot });
      childRepository.close();
      assert.ok(claimed);
      return new Promise<number>((resolve) => heldChildren.push({ finish: () => resolve(1) }));
    }
  };
  const lostCoordinator = runAnalysisCoordinator(dataDir,
    { version: 1, maxProcesses: 3, idleTimeoutMs: 300_000 }, repository, lostHost, 'lost-coordinator');
  await waitUntil(() => heldChildren.length === 3 && wakeCoordinator !== undefined,
    'three child slots must hold claimed work before coordinator loss');

  for (const sessionId of sessionIds) {
    store.appendIncremental({ event: event(sessionId, 1) });
    repository.enqueueWithOutcome({ repositoryId: 'repo-1', sessionId, inputHighWater: 2 });
  }
  const database = new DatabaseSync(databasePath);
  database.prepare(`UPDATE operational_analysis_coordinator SET owner_id = 'takeover-fence', attempt = attempt + 1,
    lease_expires_at = '2999-01-01T00:00:00.000Z' WHERE singleton = 1`).run();
  logicalNow += 6_000;
  wakeCoordinator!();
  assert.deepEqual(await lostCoordinator, { status: 'lease-held' });
  for (const child of heldChildren) child.finish();
  await setImmediatePromise();

  database.prepare("UPDATE operational_analysis_coordinator SET lease_expires_at = '2000-01-01T00:00:00.000Z'").run();
  database.prepare("UPDATE operational_analysis_jobs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE state = 'running'").run();
  database.prepare("UPDATE operational_analysis_worker_slots SET lease_expires_at = '2000-01-01T00:00:00.000Z'").run();
  assert.equal(repository.recoverExpiredJobs(), 3);
  database.prepare("UPDATE operational_analysis_jobs SET retry_after = '2000-01-01T00:00:00.000Z' WHERE state = 'retryable-failure'").run();
  database.close();

  let activeChildren = 0;
  let maximumChildren = 0;
  let restartNow = Date.now();
  const service = new OperationalLearningService(databasePath);
  const restartHost: AnalysisWorkerHost = {
    now: () => restartNow,
    delay: async (delayMs) => { restartNow += delayMs; await setImmediatePromise(); },
    spawnChild: async (_directory, slot: AnalysisWorkerSlot) => {
      activeChildren += 1;
      maximumChildren = Math.max(maximumChildren, activeChildren);
      const result = service.runNext({ ownerId: `restart-${slot.slotId}`, workerSlot: slot });
      await setImmediatePromise();
      repository.releaseWorkerSlot(slot);
      activeChildren -= 1;
      return result.status === 'completed' ? 0 : 1;
    }
  };
  assert.deepEqual(await runAnalysisCoordinator(dataDir,
    { version: 1, maxProcesses: 3, idleTimeoutMs: 1_000 }, repository, restartHost, 'restart-coordinator'),
    { status: 'idle-timeout' });

  for (const sessionId of sessionIds) {
    const stream = repository.stream('repo-1', sessionId);
    assert.equal(stream?.committedHighWater, 2);
    assert.equal(stream?.processedHighWater, 2);
    assert.deepEqual(store.loadCapturedSessionRange(sessionId as SessionId, { after: 0, through: 2, limit: 2 })
      .events.map(({ sourceEventId }) => sourceEventId), [`${sessionId}-event-0000`, `${sessionId}-event-0001`]);
  }
  const status = repository.status();
  assert.equal(status.uniqueAcknowledgedEvents, 6);
  assert.deepEqual({ pending: status.jobs.pending, running: status.jobs.running,
    retryable: status.jobs['retryable-failure'], quarantined: status.jobs['quarantined-input'] },
    { pending: 0, running: 0, retryable: 0, quarantined: 0 });
  assert.equal(maximumChildren, 3);
  assert.ok(maximumChildren <= 3);
  assertNoDuplicateResults(databasePath);
  repository.close();
  store.close();
});
