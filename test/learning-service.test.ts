import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { adaptCodexCapture } from '../src/capture/adapters/codex.js';
import type { NormalizedCaptureEvent } from '../src/capture/contracts.js';
import type { SessionId } from '../src/domain/types.js';
import { detectOperationalEpisodes } from '../src/learning/detectors.js';
import { DETECTOR_SET_VERSION, OperationalLearningRepository } from '../src/learning/repository.js';
import { OperationalLearningService } from '../src/learning/service.js';
import { normalizeMappedCapture } from '../src/capture/normalization.js';
import type { EpisodeEvidence } from '../src/learning/contracts.js';
import { ExperienceStore } from '../src/storage/experience-store.js';
import { initializeGitRepository } from './helpers/git-repository.js';

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

test('rejects malformed or duplicate supplied evidence before claiming a valid analysis stream', () => {
  for (const supplied of [
    [{ id: 'invalid-evidence', kind: 'invalid-kind' as never, state: 'observed' as const, evidenceIds: ['invalid-evidence'] }],
    [
      { id: 'duplicate-evidence', kind: 'task-transition' as const, state: 'closed' as const, decisionKey: 'issue-9', scopeKey: 'repository', evidenceIds: ['duplicate-evidence'] },
      { id: 'duplicate-evidence', kind: 'task-transition' as const, state: 'closed' as const, decisionKey: 'issue-9', scopeKey: 'repository', evidenceIds: ['duplicate-evidence'] }
    ]
  ]) {
    const { databasePath, service } = pendingLearningService();
    assert.throws(() => service.runNext({ repositoryId: 'repo-pending', episodeEvidence: supplied }), /evidence|duplicate|kind/i);
    const repository = new OperationalLearningRepository(databasePath);
    try { assert.equal(repository.jobsForStream('repo-pending', 'session-pending')[0]?.state, 'pending'); } finally { repository.close(); }
    assert.equal(service.runNext({ repositoryId: 'repo-pending' }).status, 'completed');
  }
});

test('coalesces admission into one detector-version stream and keeps later input pending', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-learning-stream-'));
  const databasePath = join(dataDir, 'experience.sqlite');
  const repository = new OperationalLearningRepository(databasePath, () => '2026-09-12T10:00:00.000Z');
  try {
    repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', detectorSetVersion: DETECTOR_SET_VERSION, inputHighWater: 5 });
    repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', detectorSetVersion: DETECTOR_SET_VERSION, inputHighWater: 8 });
    assert.equal(repository.stream('repo-1', 'session-1')?.committedHighWater, 8);
    const claimed = repository.claim({ ownerId: 'coalesced-owner', leaseMs: 60_000 })!;
    assert.equal(claimed.inputLowWater, 0);
    assert.equal(claimed.inputHighWater, 8);
    repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', detectorSetVersion: DETECTOR_SET_VERSION, inputHighWater: 10 });
    repository.acknowledge(claimed.id, { ownerId: 'coalesced-owner', attempt: claimed.attempts,
      processedHighWater: 8, checkpoint: { version: 1, pendingEvents: [] },
      result: { episodes: [], findings: [], candidates: [] },
      metrics: { eventsLoaded: 8, findings: 0, elapsedMs: 0 } });
    assert.equal(repository.stream('repo-1', 'session-1')?.committedHighWater, 10);
    assert.equal(repository.stream('repo-1', 'session-1')?.processedHighWater, 8);
    assert.equal(repository.jobById(claimed.id)?.inputHighWater, 8);
    assert.equal(repository.jobsForStream('repo-1', 'session-1').some(({ state, inputHighWater }) =>
      state === 'pending' && inputHighWater === 10), true);
  } finally { repository.close(); }
});

test('recovers a stale lease and never reruns an unchanged completed range', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-learning-lease-'));
  let time = '2026-09-12T10:00:00.000Z';
  const repository = new OperationalLearningRepository(join(dataDir, 'experience.sqlite'), () => time);
  try {
    repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', detectorSetVersion: DETECTOR_SET_VERSION, inputHighWater: 5 });
    const first = repository.claim({ ownerId: 'stale-owner', leaseMs: 60_000 });
    time = '2026-09-12T10:05:00.000Z';
    assert.equal(repository.recoverExpiredJobs(), 1);
    time = '2026-09-12T10:05:01.000Z';
    const recovered = repository.claim({ ownerId: 'recovered-owner', leaseMs: 60_000 });
    assert.equal(recovered?.id, first?.id);
    repository.acknowledge(recovered!.id, { ownerId: 'recovered-owner', attempt: recovered!.attempts,
      processedHighWater: 5, checkpoint: { version: 1, pendingEvents: [] },
      result: { episodes: [], findings: [], candidates: [] },
      metrics: { eventsLoaded: 5, findings: 0, elapsedMs: 0 } });
    assert.equal(repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', detectorSetVersion: DETECTOR_SET_VERSION, inputHighWater: 5 }), undefined);
    assert.equal(repository.claim({ ownerId: 'unchanged-owner', leaseMs: 60_000 }), undefined);
  } finally { repository.close(); }
});

test('preserves first retained instruction context and leaves unavailable source provenance unknown', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-learning-context-history-'));
  const databasePath = join(dataDir, 'experience.sqlite');
  const project = join(dataDir, 'project');
  mkdirSync(project);
  initializeGitRepository(project);
  writeFileSync(join(project, 'AGENTS.md'), 'Use pnpm instead of npm.\n');
  const store = new ExperienceStore(databasePath);
  try {
    store.registerRepository({ id: 'repo-1', root: project, observedAt: '2026-09-13T10:00:00.000Z' });
    store.appendIncremental({ session: { id: 'session-1' as never, source: 'codex', startedAt: '2026-09-13T10:00:00.000Z', repositoryId: 'repo-1' as never } });
  } finally { store.close(); }

  const service = new OperationalLearningService(databasePath);
  service.enqueueCommittedSession('repo-1', 'session-1');
  writeFileSync(join(project, 'AGENTS.md'), 'Use npm instead of pnpm.\n');

  const repository = new OperationalLearningRepository(databasePath);
  try {
    const snapshot = repository.contextSnapshotFor('repo-1', 'session-1');
    const instruction = snapshot?.instructions.find(({ location }) => location === 'AGENTS.md');
    assert.equal(instruction?.found, true);
    assert.equal(instruction?.delivered, 'unknown');
    assert.equal(instruction?.explicitlyRead, 'unknown');
    assert.equal(snapshot?.sourceAgentKey, undefined);
    assert.equal(snapshot?.conversationKey, undefined);
    assert.equal(instruction?.digest.includes('npm'), false);
    assert.equal(snapshot?.conventions[0]?.tool, 'pnpm');
  } finally { repository.close(); }
});

test('preserves privacy-safe lifecycle provenance and leaves an ambiguous run unknown', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-learning-context-lifecycle-'));
  const databasePath = join(dataDir, 'experience.sqlite');
  const project = join(dataDir, 'project');
  mkdirSync(project);
  initializeGitRepository(project);
  writeFileSync(join(project, 'AGENTS.md'), 'Use pnpm instead of npm.\n');
  const store = new ExperienceStore(databasePath);
  try {
    store.registerRepository({ id: 'repo-1', root: project, observedAt: '2026-09-13T10:00:00.000Z' });
    store.applyLifecycle({
      lifecycle: { sourceEventId: 'opaque-start', source: 'codex', conversationId: 'conversation-secret', kind: 'start', startOrigin: 'startup', receiptAt: '2026-09-13T10:00:00.000Z' },
      session: { id: 'conversation-secret' as never, source: 'codex', startedAt: '2026-09-13T10:00:00.000Z', repositoryId: 'repo-1' as never }
    });
  } finally { store.close(); }

  new OperationalLearningService(databasePath).enqueueCommittedSession('repo-1', 'conversation-secret');
  const repository = new OperationalLearningRepository(databasePath);
  try {
    const snapshot = repository.contextSnapshotFor('repo-1', 'conversation-secret');
    assert.equal(snapshot?.sourceAgentKey?.includes('codex') ?? true, false);
    assert.equal(snapshot?.conversationKey?.includes('conversation-secret') ?? true, false);
    assert.equal(snapshot?.runKey?.includes('conversation-secret') ?? true, false);
    assert.ok(snapshot?.sourceAgentKey);
    assert.ok(snapshot?.conversationKey);
    assert.ok(snapshot?.runKey);
    assert.notEqual(snapshot?.conversationKey, createHmac('sha256', snapshot!.repositoryFamilyKey).update('ael:operational-context:conversation:v1\0conversation-secret').digest('hex'));
  } finally { repository.close(); }

  const ambiguousPath = join(mkdtempSync(join(tmpdir(), 'ael-learning-context-ambiguous-')), 'experience.sqlite');
  const ambiguousStore = new ExperienceStore(ambiguousPath);
  try {
    ambiguousStore.registerRepository({ id: 'repo-1', root: project, observedAt: '2026-09-13T10:00:00.000Z' });
    ambiguousStore.applyLifecycle({
      lifecycle: { sourceEventId: 'ambiguous-start', source: 'codex', conversationId: 'conversation-ambiguous', kind: 'start', startOrigin: 'startup', receiptAt: '2026-09-13T10:00:00.000Z' },
      session: { id: 'conversation-ambiguous' as never, source: 'codex', startedAt: '2026-09-13T10:00:00.000Z', repositoryId: 'repo-1' as never }
    });
    ambiguousStore.recordLifecycleSignal({ sourceEventId: 'ambiguous-end', source: 'codex', conversationId: 'conversation-ambiguous', kind: 'end', receiptAt: '2026-09-13T10:01:00.000Z' });
    ambiguousStore.recordLifecycleSignal({ sourceEventId: 'ambiguous-resume', source: 'codex', conversationId: 'conversation-ambiguous', kind: 'start', startOrigin: 'resume', receiptAt: '2026-09-13T10:02:00.000Z' });
  } finally { ambiguousStore.close(); }
  new OperationalLearningService(ambiguousPath).enqueueCommittedSession('repo-1', 'conversation-ambiguous');
  const ambiguousRepository = new OperationalLearningRepository(ambiguousPath);
  try {
    const snapshot = ambiguousRepository.contextSnapshotFor('repo-1', 'conversation-ambiguous');
    assert.ok(snapshot?.conversationKey);
    assert.equal(snapshot?.runKey, undefined);
  } finally { ambiguousRepository.close(); }
});

test('projects retained tool activity into bounded typed evidence without leaking capture markers', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-learning-typed-service-'));
  const databasePath = join(dataDir, 'experience.sqlite');
  const project = join(dataDir, 'project');
  mkdirSync(project);
  initializeGitRepository(project);
  const store = new ExperienceStore(databasePath);
  try {
    store.registerRepository({ id: 'repo-typed', root: project, observedAt: '2026-09-13T10:00:00.000Z' });
    const request = normalizeMappedCapture({
      source: 'codex', sourceEventId: 'Liquibase-marker-request', sessionId: 'session-typed' as never,
      phase: 'pre-action', occurredAt: '2026-09-13T10:00:01.000Z', tool: 'shell', action: 'run', arguments: ['Liquibase-marker'], summary: 'Run migration.'
    });
    const result = normalizeMappedCapture({
      source: 'codex', sourceEventId: 'Liquibase-marker-result', sessionId: 'session-typed' as never,
      phase: 'post-result', occurredAt: '2026-09-13T10:00:02.000Z', tool: 'shell', action: 'run', arguments: ['Liquibase-marker'], summary: 'Migration completed.', outcome: 'succeeded', exitStatus: 0, relatedEventId: 'Liquibase-marker-request'
    });
    store.appendIncremental({ session: { id: 'session-typed' as never, source: 'codex', startedAt: '2026-09-13T10:00:00.000Z', repositoryId: 'repo-typed' as never }, event: request });
    store.appendIncremental({ event: result });
  } finally { store.close(); }

  const service = new OperationalLearningService(databasePath);
  service.enqueueCommittedSession('repo-typed', 'session-typed');
  assert.equal(service.runNext({ repositoryId: 'repo-typed', episodeEvidence: fixtureEpisodeEvidence() }).status, 'completed');
  const report = service.report('repo-typed');
  assert.deepEqual(report.episodeEvidence.map(({ kind, state }) => ({ kind, state })).sort((left, right) => left.kind.localeCompare(right.kind)), [
    { kind: 'agent-claim', state: 'succeeded' },
    { kind: 'agent-claim', state: 'succeeded' },
    { kind: 'task-transition', state: 'closed' },
    { kind: 'tool-result', state: 'succeeded' },
    { kind: 'tool-request', state: 'observed' }
  ].sort((left, right) => left.kind.localeCompare(right.kind)));
  assert.equal(report.episodes.some(({ kind }) => kind === 'verification-gap'), true);
  assert.equal(report.episodes.some(({ kind }) => kind === 'repeated-acceptance'), false);
  assert.deepEqual(report.coverage, [{
    detector: DETECTOR_SET_VERSION, detectorSetVersion: DETECTOR_SET_VERSION, status: 'completed',
    inputLowWater: 0, requestedHighWater: 2, processedHighWater: 2, examinedEvents: 2, findings: 0
  }]);
  assert.equal(JSON.stringify(report).includes('Liquibase'), false);
});

function fixtureEpisodeEvidence(): readonly EpisodeEvidence[] {
  const fixtureUrl = new URL('../../test/fixtures/reliable-observation/scenarios.json', import.meta.url);
  return (JSON.parse(readFileSync(fixtureUrl, 'utf8')) as { readonly episodeEvidence: readonly EpisodeEvidence[] }).episodeEvidence;
}

function pendingLearningService(): { readonly databasePath: string; readonly service: OperationalLearningService } {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-learning-supplied-evidence-'));
  const databasePath = join(dataDir, 'experience.sqlite');
  const project = join(dataDir, 'project');
  mkdirSync(project);
  initializeGitRepository(project);
  const store = new ExperienceStore(databasePath);
  try {
    store.registerRepository({ id: 'repo-pending', root: project, observedAt: '2026-09-13T10:00:00.000Z' });
    store.appendIncremental({ session: { id: 'session-pending' as never, source: 'codex', startedAt: '2026-09-13T10:00:00.000Z', repositoryId: 'repo-pending' as never } });
  } finally { store.close(); }
  const service = new OperationalLearningService(databasePath);
  service.enqueueCommittedSession('repo-pending', 'session-pending');
  return { databasePath, service };
}

test('passes a complete durable worker slot fence into the job claim', () => {
  const { databasePath, store } = fixture();
  append(store, repairEvents());
  store.close();
  const service = new OperationalLearningService(databasePath);
  service.enqueueCommittedSession('repo-1', 'session-1');
  const repository = new OperationalLearningRepository(databasePath);
  const coordinator = repository.acquireCoordinatorLease({ ownerId: 'coordinator', leaseMs: 60_000 })!;
  const slot = repository.reserveWorkerSlot({ ...coordinator, leaseMs: 30_000, maxProcesses: 1 })!;
  repository.close();

  assert.equal(service.runNext({ ownerId: 'worker-child', workerSlot: slot }).status, 'completed');
  const reopened = new OperationalLearningRepository(databasePath);
  assert.equal(reopened.status().activeRunningCount, 1, 'watchdog owns the live slot until it releases it');
  reopened.close();
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
  assert.equal(service.enqueueCommittedSession('repo-1', 'session-1'), true);
  assert.equal(service.enqueueCommittedSession('repo-1', 'session-1'), false);
  assert.equal(service.runNext({ ownerId: 'worker-1' }).status, 'completed');
  assert.equal(service.enqueueCommittedSession('repo-1', 'session-1'), false);
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

test('retries an unexpected captured-range I/O failure instead of quarantining input', () => {
  const { databasePath, store } = fixture();
  append(store, repairEvents().slice(0, 2));
  store.close();
  const service = new OperationalLearningService(databasePath, {
    openStore(path: string) {
      const target = new ExperienceStore(path);
      target.loadCapturedSessionRange = () => { throw new Error('storage unavailable'); };
      return target;
    }
  });
  service.enqueueCommittedSession('repo-1', 'session-1');

  assert.equal(service.runNext({ ownerId: 'worker-1' }).status, 'retryable-failure');
  const repository = new OperationalLearningRepository(databasePath);
  assert.equal(repository.stream('repo-1', 'session-1')?.processedHighWater, 0);
  assert.equal(repository.status().failureCounts['execution-failure'], 1);
  assert.equal(repository.status().failureCounts['invalid-input'], 0);
  repository.close();
});

test('records convention read failure before loading captured work', () => {
  const { databasePath, store } = fixture();
  append(store, repairEvents().slice(0, 2));
  store.close();
  const service = new OperationalLearningService(databasePath, {
    monotonicNow: sequenceClock(10, 15),
    readConventions() { throw new Error('instruction storage unavailable'); }
  });
  service.enqueueCommittedSession('repo-1', 'session-1');

  assert.equal(service.runNext({ ownerId: 'worker-1' }).status, 'retryable-failure');
  const repository = new OperationalLearningRepository(databasePath);
  assert.equal(repository.stream('repo-1', 'session-1')?.processedHighWater, 0);
  assert.equal(repository.status().eventsLoaded, 0);
  assert.equal(repository.status().failureCounts['execution-failure'], 1);
  repository.close();
});

for (const point of ['failure', 'timeout', 'acknowledgement'] as const) {
  test(`controls lease expiry before ${point} without stale-owner mutation`, () => {
    const { databasePath, store } = fixture();
    append(store, repairEvents());
    store.close();
    const service = new OperationalLearningService(databasePath, {
      monotonicNow: sequenceClock(10, point === 'timeout' ? 25 : 15),
      detect(input) {
        const result = detectOperationalEpisodes(input);
        expireLease(databasePath);
        if (point === 'failure') throw new Error('detector failed after lease expiry');
        return result;
      }
    });
    service.enqueueCommittedSession('repo-1', 'session-1');

    const result = service.runNext({ ownerId: 'worker-1', deadlineMs: point === 'timeout' ? 10 : 250 });
    assert.equal(result.status, 'retryable-failure');
    const repository = new OperationalLearningRepository(databasePath);
    assert.equal(repository.stream('repo-1', 'session-1')?.processedHighWater, 0);
    assert.equal(repository.jobsForStream('repo-1', 'session-1')[0]?.state, 'retryable-failure');
    assert.equal(repository.jobsForStream('repo-1', 'session-1')[0]?.failureReason, 'lease-expired');
    assert.equal(repository.status().failureCounts['lease-expired'], 1);
    repository.close();
    const database = new DatabaseSync(databasePath);
    const attempt = database.prepare(`SELECT processed_high_water, events_loaded, findings, elapsed_ms
      FROM operational_analysis_attempts WHERE attempt = 1`).get()!;
    assert.deepEqual({ ...attempt }, {
      processed_high_water: 4,
      events_loaded: 4,
      findings: point === 'failure' ? 0 : 1,
      elapsed_ms: point === 'timeout' ? 15 : 5
    });
    database.close();
  });
}

test('does not recover or mutate a current lease acquired by another owner', () => {
  const { databasePath, store } = fixture();
  append(store, repairEvents());
  store.close();
  const service = new OperationalLearningService(databasePath, {
    monotonicNow: sequenceClock(10, 15),
    detect(input) {
      const result = detectOperationalEpisodes(input);
      expireLease(databasePath);
      let millis = Date.now() + 31_000;
      const other = new OperationalLearningRepository(databasePath, () => new Date(millis).toISOString());
      assert.equal(other.recoverExpiredJobs(), 1);
      millis += 1_000;
      assert.equal(other.claim({ ownerId: 'worker-2', leaseMs: 60_000 })?.leaseOwner, 'worker-2');
      other.close();
      return result;
    }
  });
  service.enqueueCommittedSession('repo-1', 'session-1');

  assert.equal(service.runNext({ ownerId: 'worker-1' }).status, 'retryable-failure');
  const repository = new OperationalLearningRepository(databasePath);
  const job = repository.jobsForStream('repo-1', 'session-1')[0];
  assert.equal(job?.state, 'running');
  assert.equal(job?.leaseOwner, 'worker-2');
  assert.equal(job?.attempts, 2);
  repository.close();
});

function sequenceClock(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

function expireLease(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  database.prepare("UPDATE operational_analysis_jobs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE state = 'running'").run();
  database.close();
}
