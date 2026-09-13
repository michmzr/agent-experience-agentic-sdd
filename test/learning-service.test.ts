import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { adaptCodexCapture } from '../src/capture/adapters/codex.js';
import type { NormalizedCaptureEvent } from '../src/capture/contracts.js';
import type { SessionId } from '../src/domain/types.js';
import { DETECTOR_SET_VERSION, OperationalLearningRepository } from '../src/learning/repository.js';
import { OperationalLearningService } from '../src/learning/service.js';
import { ExperienceStore } from '../src/storage/experience-store.js';

const startedAt = '2026-09-13T10:00:00.000Z';

function fixture(input: { readonly register?: boolean; readonly session?: boolean } = {}): {
  readonly databasePath: string;
  readonly store: ExperienceStore;
} {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-learning-service-'));
  const root = join(dataDir, 'repository');
  mkdirSync(root);
  const databasePath = join(dataDir, 'experience.sqlite');
  const store = new ExperienceStore(databasePath);
  if (input.register !== false) store.registerRepository({ id: 'repo-1', root, observedAt: startedAt });
  if (input.session !== false) store.appendIncremental({
    session: { id: 'session-1' as SessionId, source: 'codex', startedAt, repositoryId: 'repo-1' as never }
  });
  return { databasePath, store };
}

function event(input: {
  readonly id: string;
  readonly phase: 'pre-action' | 'post-result';
  readonly action: string;
  readonly second: number;
  readonly outcome?: 'succeeded' | 'failed';
  readonly relatedEventId?: string;
}): NormalizedCaptureEvent {
  return adaptCodexCapture({
    event_id: input.id,
    session_id: 'session-1',
    event_kind: input.phase === 'pre-action' ? 'pre_action' : 'post_result',
    occurred_at: `2026-09-13T10:00:${String(input.second).padStart(2, '0')}.000Z`,
    tool: 'shell', action: input.action, arguments: ['install'], cwd: '/work/repo', summary: 'Sanitized capture.',
    ...(input.phase === 'post-result' ? {
      outcome: input.outcome, exit_status: input.outcome === 'succeeded' ? 0 : 1, related_event_id: input.relatedEventId
    } : {})
  });
}

function repairEvents(): readonly NormalizedCaptureEvent[] {
  return [
    event({ id: 'failed-request', phase: 'pre-action', action: 'npm', second: 1 }),
    event({ id: 'failed-result', phase: 'post-result', action: 'npm', second: 2, outcome: 'failed', relatedEventId: 'failed-request' }),
    event({ id: 'changed-request', phase: 'pre-action', action: 'pnpm', second: 3 }),
    event({ id: 'changed-result', phase: 'post-result', action: 'pnpm', second: 4, outcome: 'succeeded', relatedEventId: 'changed-request' })
  ];
}

function append(store: ExperienceStore, events: readonly NormalizedCaptureEvent[]): void {
  for (const captured of events) store.appendIncremental({ event: captured });
}

test('returns idle when no committed analysis job is pending', () => {
  const { databasePath, store } = fixture();
  store.close();
  const service = new OperationalLearningService(databasePath);
  assert.deepEqual(service.runNext(), { status: 'idle' });
});

test('analyzes only the claimed high-water when later events already exist', () => {
  const { databasePath, store } = fixture();
  append(store, repairEvents());
  const service = new OperationalLearningService(databasePath);
  service.enqueueCommittedSession('repo-1', 'session-1');
  append(store, [
    event({ id: 'later-request', phase: 'pre-action', action: 'git', second: 5 }),
    event({ id: 'later-result', phase: 'post-result', action: 'git', second: 6, outcome: 'succeeded', relatedEventId: 'later-request' })
  ]);
  store.close();

  assert.equal(service.runNext({ ownerId: 'worker-1', maxEvents: 10 }).status, 'completed');
  assert.deepEqual(service.report('repo-1').coverage, [{
    detector: DETECTOR_SET_VERSION, detectorSetVersion: DETECTOR_SET_VERSION, status: 'completed',
    inputLowWater: 0, requestedHighWater: 4, processedHighWater: 4, examinedEvents: 4, findings: 1
  }]);
  const repository = new OperationalLearningRepository(databasePath);
  assert.equal(repository.status().eventsLoaded, 4);
  assert.equal(repository.stream('repo-1', 'session-1')?.processedHighWater, 4);
  repository.close();
});

test('partially acknowledges the actual page and resumes with checkpoint continuity', () => {
  const { databasePath, store } = fixture();
  append(store, repairEvents());
  store.close();
  const service = new OperationalLearningService(databasePath);
  service.enqueueCommittedSession('repo-1', 'session-1');

  assert.equal(service.runNext({ ownerId: 'worker-1', maxEvents: 2 }).status, 'completed');
  let repository = new OperationalLearningRepository(databasePath);
  assert.equal(repository.stream('repo-1', 'session-1')?.processedHighWater, 2);
  assert.deepEqual(repository.stream('repo-1', 'session-1')?.checkpoint.pendingEvents.map((item) =>
    (item as { sourceEventId: string }).sourceEventId), ['failed-request', 'failed-result']);
  repository.close();
  assert.deepEqual(service.report('repo-1').coverage, [{
    detector: DETECTOR_SET_VERSION, detectorSetVersion: DETECTOR_SET_VERSION, status: 'incomplete',
    inputLowWater: 0, requestedHighWater: 4, processedHighWater: 2, examinedEvents: 2, findings: 0
  }]);

  assert.equal(service.runNext({ ownerId: 'worker-2', maxEvents: 2 }).status, 'completed');
  repository = new OperationalLearningRepository(databasePath);
  assert.equal(repository.stream('repo-1', 'session-1')?.processedHighWater, 4);
  assert.equal(repository.status().eventsLoaded, 4);
  assert.equal(repository.status().uniqueAcknowledgedEvents, 4);
  assert.equal(repository.status().rereadRatio, 1);
  repository.close();
  const report = service.report('repo-1');
  assert.equal(report.findings.length, 1);
  assert.deepEqual(report.coverage.map(({ inputLowWater, requestedHighWater, processedHighWater, status }) =>
    ({ inputLowWater, requestedHighWater, processedHighWater, status })).sort((left, right) => left.inputLowWater - right.inputLowWater), [
    { inputLowWater: 0, requestedHighWater: 4, processedHighWater: 2, status: 'incomplete' },
    { inputLowWater: 2, requestedHighWater: 4, processedHighWater: 4, status: 'completed' }
  ]);
});

test('does not create another job when completed input is admitted unchanged', () => {
  const { databasePath, store } = fixture();
  append(store, repairEvents());
  store.close();
  const service = new OperationalLearningService(databasePath);
  service.enqueueCommittedSession('repo-1', 'session-1');
  assert.equal(service.runNext({ ownerId: 'worker-1' }).status, 'completed');
  service.enqueueCommittedSession('repo-1', 'session-1');
  assert.deepEqual(service.runNext({ ownerId: 'worker-2' }), { status: 'idle' });
});

test('quarantines missing session, registration, or claimed capture input immediately', () => {
  for (const missing of ['session', 'registration', 'captured-input'] as const) {
    const { databasePath, store } = fixture({ register: missing !== 'registration', session: missing !== 'session' });
    store.close();
    const repository = new OperationalLearningRepository(databasePath);
    const job = repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 1 })!;
    repository.close();

    const result = new OperationalLearningService(databasePath).runNext({ ownerId: 'worker-1' });
    assert.deepEqual(result, { status: 'quarantined-input', jobId: job.id });
    const reopened = new OperationalLearningRepository(databasePath);
    assert.equal(reopened.jobById(job.id)?.failureReason, 'invalid-input');
    assert.equal(reopened.status().failureCounts['invalid-input'], 1);
    reopened.close();
  }
});

test('records loaded work on execution failure without advancing acknowledged progress', () => {
  const { databasePath, store } = fixture();
  append(store, repairEvents().slice(0, 2));
  store.close();
  const service = new OperationalLearningService(databasePath, {
    monotonicNow: sequenceClock(10, 22.5),
    detect() { throw new Error('detector failed'); }
  });
  service.enqueueCommittedSession('repo-1', 'session-1');

  assert.equal(service.runNext({ ownerId: 'worker-1' }).status, 'retryable-failure');
  const repository = new OperationalLearningRepository(databasePath);
  assert.equal(repository.stream('repo-1', 'session-1')?.processedHighWater, 0);
  assert.equal(repository.status().eventsLoaded, 2);
  assert.equal(repository.status().uniqueAcknowledgedEvents, 0);
  assert.equal(repository.status().failureCounts['execution-failure'], 1);
  repository.close();
  const database = new DatabaseSync(databasePath);
  const attempt = database.prepare('SELECT processed_high_water, events_loaded, findings, elapsed_ms FROM operational_analysis_attempts').get()!;
  assert.deepEqual({ ...attempt }, { processed_high_water: 2, events_loaded: 2, findings: 0, elapsed_ms: 12.5 });
  database.close();
});

test('records loaded work and findings on deadline timeout without acknowledging the stream', () => {
  const { databasePath, store } = fixture();
  append(store, repairEvents());
  store.close();
  const service = new OperationalLearningService(databasePath, { monotonicNow: sequenceClock(10, 22.5) });
  service.enqueueCommittedSession('repo-1', 'session-1');

  assert.equal(service.runNext({ ownerId: 'worker-1', deadlineMs: 10 }).status, 'retryable-failure');
  const repository = new OperationalLearningRepository(databasePath);
  assert.equal(repository.stream('repo-1', 'session-1')?.processedHighWater, 0);
  assert.equal(repository.status().eventsLoaded, 4);
  assert.equal(repository.status().uniqueAcknowledgedEvents, 0);
  assert.equal(repository.status().failureCounts.timeout, 1);
  assert.equal(repository.status().totalRetries, 1);
  repository.close();
  const database = new DatabaseSync(databasePath);
  const attempt = database.prepare('SELECT processed_high_water, events_loaded, findings, elapsed_ms FROM operational_analysis_attempts').get()!;
  assert.deepEqual({ ...attempt }, { processed_high_water: 4, events_loaded: 4, findings: 1, elapsed_ms: 12.5 });
  database.close();
});

function sequenceClock(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}
