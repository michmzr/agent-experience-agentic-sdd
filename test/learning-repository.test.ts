import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { DETECTOR_SET_VERSION, OperationalLearningRepository } from '../src/learning/repository.js';

function path(): string { return join(mkdtempSync(join(tmpdir(), 'ael-learning-repository-')), 'experience.sqlite'); }

const emptyResult = { episodes: [], findings: [], candidates: [] };
const emptyCheckpoint = { version: 1, pendingEvents: [] };

for (const reason of ['execution-failure', 'timeout'] as const) {
  test(`failed ${reason} attempt records loaded work before a successful reread without acknowledging failed progress`, () => {
    const databasePath = path();
    let millis = Date.parse('2026-09-13T10:00:00.000Z');
    const repository = new OperationalLearningRepository(databasePath, () => new Date(millis).toISOString());
    repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 4 });
    const first = repository.claim({ ownerId: 'owner', leaseMs: 60_000 })!;
    repository.retry(first.id, { ownerId: 'owner', attempt: first.attempts, reason, processedHighWater: 3,
      metrics: { eventsLoaded: 4, findings: 1, elapsedMs: 12.5 } });
    assert.equal(repository.stream('repo-1', 'session-1')?.processedHighWater, 0);
    assert.equal(repository.status().uniqueAcknowledgedEvents, 0);
    assert.equal(repository.status().eventsLoaded, 4);
    millis += 1_000;
    const second = repository.claim({ ownerId: 'owner', leaseMs: 60_000 })!;
    assert.equal(second.inputLowWater, 0);
    repository.acknowledge(second.id, { ownerId: 'owner', attempt: second.attempts, processedHighWater: 4,
      checkpoint: emptyCheckpoint, result: emptyResult, metrics: { eventsLoaded: 4, findings: 0, elapsedMs: 10 } });
    const status = repository.status();
    assert.equal(status.eventsLoaded, 8);
    assert.equal(status.uniqueAcknowledgedEvents, 4);
    assert.equal(status.rereadRatio, 2);
    assert.equal(status.totalRetries, 1);
    assert.equal(status.failureCounts[reason], 1);
    const database = new DatabaseSync(databasePath);
    const failed = database.prepare('SELECT * FROM operational_analysis_attempts WHERE job_id = ? AND attempt = 1').get(first.id)!;
    assert.equal(failed.events_loaded, 4); assert.equal(failed.processed_high_water, 3);
    assert.equal(failed.findings, 1); assert.equal(failed.elapsed_ms, 12.5);
    assert.equal(failed.failure_category, reason);
    database.close(); repository.close();
    const reopened = new OperationalLearningRepository(databasePath);
    assert.equal(reopened.status().rereadRatio, 2);
    assert.equal(reopened.status().failureCounts[reason], 1);
    reopened.close();
  });
}

test('failed attempt metrics reject invalid ranges, counters, durations and owners atomically', () => {
  const repository = new OperationalLearningRepository(path(), () => '2026-09-13T10:00:00.000Z');
  repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 4 });
  const job = repository.claim({ ownerId: 'owner', leaseMs: 60_000 })!;
  const input = { ownerId: 'owner', attempt: 1, reason: 'timeout' as const, processedHighWater: 3,
    metrics: { eventsLoaded: 4, findings: 1, elapsedMs: 12.5 } };
  for (const change of [{ ownerId: 'other' }, { attempt: 2 }, { processedHighWater: -1 }, { processedHighWater: 5 },
    ...[-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].flatMap((invalid) => [
      { metrics: { ...input.metrics, eventsLoaded: invalid } }, { metrics: { ...input.metrics, findings: invalid } },
      { metrics: { ...input.metrics, elapsedMs: invalid } }
    ]), { metrics: { ...input.metrics, eventsLoaded: 2 } },
    ...[null, undefined].map((invalid) => ({ processedHighWater: 0, metrics: { ...input.metrics, eventsLoaded: invalid as unknown as number } }))]) {
    assert.throws(() => repository.retry(job.id, { ...input, ...change }));
    assert.equal(repository.jobById(job.id)?.state, 'running');
    assert.equal(repository.status().eventsLoaded, 0);
    assert.equal(repository.status().totalRetries, 0);
  }
  repository.close();
});

test('status classifies every failed attempt including quarantine and applies only metric filters', () => {
  let millis = Date.parse('2026-09-13T10:00:00.000Z');
  const repository = new OperationalLearningRepository(path(), () => new Date(millis).toISOString());
  repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 1 });
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const job = repository.claim({ repositoryId: 'repo-1', ownerId: 'owner', leaseMs: 60_000 })!;
    repository.retry(job.id, { ownerId: 'owner', attempt, reason: 'timeout' });
    millis += [1_000, 5_000, 30_000, 0][attempt - 1]!;
  }
  repository.enqueue({ repositoryId: 'repo-2', sessionId: 'session-2', detectorSetVersion: 'v2', inputHighWater: 1 });
  const invalid = repository.claim({ repositoryId: 'repo-2', ownerId: 'owner', leaseMs: 60_000 })!;
  repository.retry(invalid.id, { ownerId: 'owner', attempt: 1, reason: 'invalid-input' });
  repository.enqueue({ repositoryId: 'repo-2', sessionId: 'session-3', detectorSetVersion: 'v2', inputHighWater: 1 });
  repository.claim({ repositoryId: 'repo-2', ownerId: 'owner', leaseMs: 1 });
  millis += 1;
  repository.recoverExpiredJobs();
  const status = repository.status();
  assert.deepEqual(status.failureCounts, { 'execution-failure': 0, timeout: 4, 'invalid-input': 1, 'lease-expired': 1 });
  assert.equal(status.totalRetries, 4, 'terminal failures count as failures but do not schedule a retry');
  assert.ok(Object.isFrozen(status.failureCounts));
  assert.deepEqual(repository.status({ repositoryId: 'repo-2', sessionId: 'session-2', detectorSetVersion: 'v2' }).failureCounts,
    { 'execution-failure': 0, timeout: 0, 'invalid-input': 1, 'lease-expired': 0 });
  assert.deepEqual(repository.status({ repositoryId: 'missing' }).failureCounts,
    { 'execution-failure': 0, timeout: 0, 'invalid-input': 0, 'lease-expired': 0 });
  repository.close();
});

test('upgrades a version-one running job without a lease into recoverable bounded retry', () => {
  const databasePath = path();
  const now = () => '2026-09-13T10:00:00.000Z';
  const repository = new OperationalLearningRepository(databasePath, now);
  const original = repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 10 })!;
  repository.claim();
  repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 12 });
  repository.close();
  const database = new DatabaseSync(databasePath);
  database.exec(`DROP TABLE operational_analysis_attempts; DROP TABLE operational_analysis_coordinator;
    ALTER TABLE operational_analysis_coverage DROP COLUMN detector_set_version;
    ALTER TABLE operational_analysis_coverage DROP COLUMN input_low_water;
    ALTER TABLE operational_analysis_coverage DROP COLUMN requested_high_water;
    ALTER TABLE operational_analysis_coverage DROP COLUMN processed_high_water;
    UPDATE operational_analysis_schema SET version = 1;
    UPDATE operational_analysis_jobs SET lease_owner = NULL, lease_expires_at = NULL;`);
  database.close();
  const reopened = new OperationalLearningRepository(databasePath, now);
  assert.equal(reopened.jobById(original.id)?.state, 'retryable-failure');
  assert.equal(reopened.jobById(original.id)?.inputHighWater, 12);
  assert.equal(reopened.jobById(original.id)?.retryAfter, '2026-09-13T10:00:01.000Z');
  assert.equal(reopened.status().totalAttempts, 1);
  assert.equal(reopened.recoverExpiredJobs(), 0);
  reopened.close();
});

test('leased claims exclude another connection and partial acknowledgement refreshes queued successor', () => {
  const databasePath = path();
  const repository = new OperationalLearningRepository(databasePath);
  const other = new OperationalLearningRepository(databasePath);
  repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 10 });
  const first = repository.claim({ ownerId: 'owner-1', leaseMs: 60_000 })!;
  assert.equal(first.leaseOwner, 'owner-1');
  assert.equal(first.attempts, 1);
  assert.equal(other.claim({ ownerId: 'owner-2', leaseMs: 60_000 }), undefined);
  const successor = other.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 12 })!;
  const coverage = { detector: DETECTOR_SET_VERSION, detectorSetVersion: DETECTOR_SET_VERSION, status: 'incomplete' as const,
    inputLowWater: 0, requestedHighWater: 10, processedHighWater: 6, examinedEvents: 6, findings: 0 };
  repository.acknowledge(first.id, { ownerId: 'owner-1', attempt: 1, processedHighWater: 6,
    checkpoint: emptyCheckpoint, result: { ...emptyResult, coverage: [coverage] }, metrics: { eventsLoaded: 6, elapsedMs: 20 } });
  assert.equal(repository.stream('repo-1', 'session-1')?.processedHighWater, 6);
  const next = other.claim({ ownerId: 'owner-2', leaseMs: 60_000 })!;
  assert.equal(next.id, successor.id);
  assert.equal(next.inputLowWater, 6);
  assert.equal(next.inputHighWater, 12);
  assert.deepEqual(repository.report('repo-1').coverage, [coverage]);
  assert.throws(() => repository.acknowledge(first.id, { ownerId: 'owner-1', attempt: 1, processedHighWater: 10,
    checkpoint: emptyCheckpoint, result: emptyResult, metrics: { eventsLoaded: 4, elapsedMs: 1 } }), /lease|running/i);
  repository.close(); other.close();
  const reopened = new OperationalLearningRepository(databasePath);
  assert.equal(reopened.status().uniqueAcknowledgedEvents, 6);
  assert.deepEqual(reopened.report('repo-1').coverage, [coverage]);
  reopened.close();
});

test('acknowledgement creates remaining work and handles a zero-event range once', () => {
  for (const highWater of [0, 10]) {
    const repository = new OperationalLearningRepository(path());
    repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: highWater });
    const job = repository.claim({ ownerId: 'owner', leaseMs: 60_000 })!;
    repository.acknowledge(job.id, { ownerId: 'owner', attempt: 1, processedHighWater: Math.min(6, highWater),
      checkpoint: emptyCheckpoint, result: emptyResult, metrics: { eventsLoaded: Math.min(6, highWater), elapsedMs: 1 } });
    assert.equal(repository.claimableCount(), highWater === 0 ? 0 : 1);
    assert.equal(repository.hasActiveOrClaimableWork(), highWater > 0);
    if (highWater) assert.equal(repository.claim({ ownerId: 'next', leaseMs: 60_000 })?.inputLowWater, 6);
    repository.close();
  }
});

test('acknowledgement rejects stale ownership, bad range, checkpoint, version and cross-stream results atomically', () => {
  const repository = new OperationalLearningRepository(path());
  repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 10 });
  const job = repository.claim({ ownerId: 'owner', leaseMs: 60_000 })!;
  const input = { ownerId: 'owner', attempt: 1, processedHighWater: 6, checkpoint: emptyCheckpoint,
    result: emptyResult, metrics: { eventsLoaded: 6, elapsedMs: 1 } };
  const invalid = [ { ownerId: 'other' }, { attempt: 2 }, { processedHighWater: 11 }, { processedHighWater: -1 },
    { checkpoint: { version: 2, pendingEvents: [] } }, { metrics: { eventsLoaded: -1, elapsedMs: 1 } },
    { result: { ...emptyResult, coverage: [{ detector: 'detector', detectorSetVersion: 'other', status: 'completed' as const,
      inputLowWater: 0, requestedHighWater: 10, processedHighWater: 6, examinedEvents: 6, findings: 0 }] } },
    { result: { ...emptyResult, episodes: [{ id: 'alien', repositoryId: 'other', sessionId: 'session-1', detector: DETECTOR_SET_VERSION,
      state: 'unresolved' as const, evidenceEventIds: [] }] } },
    { result: { ...emptyResult, findings: [{ id: 'alien', episodeId: 'missing', kind: 'command-repair' as const, evidenceEventIds: [], statement: 'bad' }] } },
    { metrics: { eventsLoaded: 0, elapsedMs: 1 } }
  ];
  for (const change of invalid) {
    assert.throws(() => repository.acknowledge(job.id, { ...input, ...change }));
    assert.equal(repository.stream('repo-1', 'session-1')?.processedHighWater, 0);
    assert.equal(repository.jobById(job.id)?.state, 'running');
    assert.equal(repository.status().uniqueAcknowledgedEvents, 0);
  }
  repository.close();
});

test('leased retries respect injected time, fence stale attempts and quarantine fourth or invalid failure', () => {
  let millis = Date.parse('2026-09-13T10:00:00.000Z');
  const repository = new OperationalLearningRepository(path(), () => new Date(millis).toISOString());
  repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 1 });
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const job = repository.claim({ ownerId: 'owner', leaseMs: 60_000 })!;
    assert.equal(job.attempts, attempt);
    if (attempt > 1) assert.throws(() => repository.retry(job.id, { ownerId: 'owner', attempt: attempt - 1, reason: 'timeout' }), /lease/i);
    repository.retry(job.id, { ownerId: 'owner', attempt, reason: 'timeout' });
    assert.equal(repository.claimableCount(), 0);
    if (attempt < 4) {
      const delay = [1_000, 5_000, 30_000][attempt - 1]!;
      assert.equal(repository.jobById(job.id)?.retryAfter, new Date(millis + delay).toISOString());
      millis += delay - 1;
      assert.equal(repository.claim({ ownerId: 'owner', leaseMs: 60_000 }), undefined);
      millis += 1;
    } else assert.equal(repository.jobById(job.id)?.state, 'quarantined-input');
  }
  repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-2', inputHighWater: 1 });
  const invalid = repository.claim({ ownerId: 'owner', leaseMs: 60_000 })!;
  repository.retry(invalid.id, { ownerId: 'owner', attempt: 1, reason: 'invalid-input' });
  assert.equal(repository.jobById(invalid.id)?.state, 'quarantined-input');
  assert.equal(repository.status().totalRetries, 3);
  repository.close();
});

test('expired jobs recover once and old owners cannot acknowledge or retry', () => {
  let millis = Date.parse('2026-09-13T10:00:00.000Z');
  const repository = new OperationalLearningRepository(path(), () => new Date(millis).toISOString());
  repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 4 });
  const first = repository.claim({ ownerId: 'first', leaseMs: 10 })!;
  millis += 10;
  assert.throws(() => repository.retry(first.id, { ownerId: 'first', attempt: 1, reason: 'timeout' }), /lease/i);
  assert.equal(repository.recoverExpiredJobs(), 1);
  assert.equal(repository.recoverExpiredJobs(), 0);
  assert.equal(repository.jobById(first.id)?.failureReason, 'lease-expired');
  millis += 1_000;
  const second = repository.claim({ ownerId: 'second', leaseMs: 10 })!;
  assert.equal(second.attempts, 2);
  assert.throws(() => repository.acknowledge(first.id, { ownerId: 'first', attempt: 1, processedHighWater: 4,
    checkpoint: emptyCheckpoint, result: emptyResult, metrics: { eventsLoaded: 4, elapsedMs: 1 } }), /lease/i);
  assert.throws(() => repository.retry(first.id, { ownerId: 'first', attempt: 1, reason: 'timeout' }), /lease/i);
  repository.close();
});

test('four expired leases quarantine without admitting an unresolved successor', () => {
  let millis = Date.parse('2026-09-13T10:00:00.000Z');
  const repository = new OperationalLearningRepository(path(), () => new Date(millis).toISOString());
  const input = { repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 4 };
  const original = repository.enqueue(input)!;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    repository.claim({ ownerId: 'owner', leaseMs: 10 });
    millis += 10;
    assert.equal(repository.recoverExpiredJobs(), 1);
    if (attempt < 4) millis += [1_000, 5_000, 30_000][attempt - 1]!;
  }
  assert.equal(repository.jobById(original.id)?.state, 'quarantined-input');
  assert.equal(repository.jobById(original.id)?.attempts, 4);
  repository.enqueue({ ...input, inputHighWater: 8 });
  assert.equal(repository.claimableCount(), 0);
  assert.equal(repository.status().totalRetries, 3);
  repository.close();
});

test('coordinator convenience API retains a local generation fence after owner reuse', () => {
  let millis = Date.parse('2026-09-13T10:00:00.000Z');
  const databasePath = path();
  const repository = new OperationalLearningRepository(databasePath, () => new Date(millis).toISOString());
  const other = new OperationalLearningRepository(databasePath, () => new Date(millis).toISOString());
  assert.equal(repository.tryAcquireCoordinatorLease('owner', 10), true);
  assert.equal(repository.renewCoordinatorLease('owner', 20), true);
  millis += 20;
  assert.equal(other.tryAcquireCoordinatorLease('owner', 10), true);
  assert.equal(repository.renewCoordinatorLease('owner', 20), false);
  assert.equal(repository.releaseCoordinatorLease('owner'), false);
  assert.equal(other.releaseCoordinatorLease('owner'), true);
  repository.close(); other.close();
});

test('global coordinator lease lifecycle is fenced by generation and expiry', () => {
  let millis = Date.parse('2026-09-13T10:00:00.000Z');
  const databasePath = path();
  const repository = new OperationalLearningRepository(databasePath, () => new Date(millis).toISOString());
  const other = new OperationalLearningRepository(databasePath, () => new Date(millis).toISOString());
  const first = repository.acquireCoordinatorLease({ ownerId: 'first', leaseMs: 10 })!;
  assert.ok(first);
  assert.equal(other.acquireCoordinatorLease({ ownerId: 'second', leaseMs: 10 }), undefined);
  assert.equal(repository.renewCoordinatorLease({ ownerId: 'first', attempt: first.attempt, leaseMs: 20 })?.leaseExpiresAt,
    new Date(millis + 20).toISOString());
  millis += 20;
  assert.equal(repository.renewCoordinatorLease({ ownerId: 'first', attempt: first.attempt, leaseMs: 20 }), undefined);
  const second = other.acquireCoordinatorLease({ ownerId: 'second', leaseMs: 10 })!;
  assert.equal(second.attempt, first.attempt + 1);
  assert.equal(repository.releaseCoordinatorLease({ ownerId: 'first', attempt: first.attempt }), false);
  assert.equal(other.releaseCoordinatorLease({ ownerId: 'second', attempt: second.attempt }), true);
  assert.equal(repository.status().coordinatorLease, null);
  repository.close(); other.close();
});

test('status freezes filtered job and attempt metrics while preserving global lease and diagnostics', () => {
  let millis = Date.parse('2026-09-13T10:00:00.000Z');
  const databasePath = path();
  const repository = new OperationalLearningRepository(databasePath, () => new Date(millis).toISOString());
  repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 10 });
  const job = repository.claim({ ownerId: 'owner', leaseMs: 60_000 })!;
  repository.acknowledge(job.id, { ownerId: 'owner', attempt: 1, processedHighWater: 6,
    checkpoint: emptyCheckpoint, result: emptyResult, metrics: { eventsLoaded: 8, elapsedMs: 1 } });
  repository.enqueue({ repositoryId: 'repo-2', sessionId: 'session-2', inputHighWater: 0, detectorSetVersion: 'v2' });
  repository.claim({ ownerId: 'owner-2', leaseMs: 60_000, repositoryId: 'repo-2' });
  repository.acquireCoordinatorLease({ ownerId: 'coordinator', leaseMs: 60_000 });
  repository.recordDiagnostic('coordinator-launch-failed'); repository.recordDiagnostic('coordinator-launch-failed');
  repository.recordDiagnostic('child-process-failed');
  millis += 100;
  const status = repository.status();
  assert.equal(status.jobs.completed, 1); assert.equal(status.jobs.pending, 1); assert.equal(status.jobs.running, 1);
  assert.equal(status.activeRunningCount, 1); assert.equal(status.oldestOutstandingAgeMs, 100);
  assert.equal(status.totalAttempts, 2); assert.equal(status.eventsLoaded, 8);
  assert.equal(status.uniqueAcknowledgedEvents, 6); assert.equal(status.rereadRatio, 8 / 6);
  assert.equal(status.diagnostics['coordinator-launch-failed'], 2);
  assert.equal(status.diagnostics['child-process-failed'], 1);
  const filtered = repository.status({ repositoryId: 'repo-2', sessionId: 'session-2', detectorSetVersion: 'v2' });
  assert.equal(filtered.totalAttempts, 1); assert.equal(filtered.uniqueAcknowledgedEvents, 0); assert.equal(filtered.rereadRatio, 0);
  assert.equal(filtered.jobs.completed, 0); assert.equal(filtered.coordinatorLease?.ownerId, 'coordinator');
  for (const value of [status, status.jobs, status.diagnostics, status.coordinatorLease]) assert.ok(Object.isFrozen(value));
  const database = new DatabaseSync(databasePath);
  const columns = database.prepare('PRAGMA table_info(operational_analysis_attempts)').all().map(({ name }) => name);
  assert.ok(columns.includes('events_loaded')); assert.ok(columns.includes('detector_set_version'));
  assert.ok(!columns.some((column) => /payload|text/.test(String(column))));
  const attempt = database.prepare('SELECT * FROM operational_analysis_attempts WHERE job_id = ?').get(job.id)!;
  assert.equal(attempt.input_low_water, 0); assert.equal(attempt.requested_high_water, 10);
  assert.equal(attempt.processed_high_water, 6); assert.equal(attempt.events_loaded, 8);
  assert.equal(attempt.findings, 0); assert.equal(attempt.elapsed_ms, 1); assert.equal(attempt.outcome, 'completed');
  assert.equal(attempt.failure_category, null); assert.equal(attempt.started_at, attempt.finished_at);
  database.close(); repository.close();
});

function legacyDatabase(databasePath: string, states: readonly string[]): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE operational_analysis_jobs (
      id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, session_id TEXT NOT NULL, input_high_water INTEGER NOT NULL,
      state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(repository_id, session_id, input_high_water)
    );
    CREATE TABLE operational_analysis_coverage (
      job_id TEXT NOT NULL REFERENCES operational_analysis_jobs(id), detector TEXT NOT NULL, status TEXT NOT NULL,
      examined_events INTEGER NOT NULL, findings INTEGER NOT NULL, PRIMARY KEY(job_id, detector)
    );
    CREATE TABLE operational_episodes (
      id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, session_id TEXT NOT NULL, detector TEXT NOT NULL, state TEXT NOT NULL,
      evidence_json TEXT NOT NULL, payload_json TEXT NOT NULL
    );
    CREATE TABLE operational_findings (
      id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES operational_episodes(id), kind TEXT NOT NULL, evidence_json TEXT NOT NULL, statement TEXT NOT NULL
    );
    CREATE TABLE operational_candidates (
      id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES operational_episodes(id), kind TEXT NOT NULL, state TEXT NOT NULL,
      statement TEXT NOT NULL, conditions_json TEXT NOT NULL, procedure_json TEXT NOT NULL, invalidation_json TEXT NOT NULL
    );
    CREATE TABLE operational_candidate_evidence (
      candidate_id TEXT NOT NULL REFERENCES operational_candidates(id), event_id TEXT NOT NULL, polarity TEXT NOT NULL,
      PRIMARY KEY(candidate_id, event_id)
    );
  `);
  [2, 4, 8].forEach((highWater, index) => {
    database.prepare('INSERT INTO operational_analysis_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`legacy-${highWater}`, 'repo-1', 'session-1', highWater, states[index]!, index, '2026-09-08T11:00:00.000Z', '2026-09-08T11:00:00.000Z');
    if (states[index] === 'completed') database.prepare('INSERT INTO operational_analysis_coverage VALUES (?, ?, ?, ?, ?)')
      .run(`legacy-${highWater}`, 'm6-deterministic@1', 'completed', highWater, 0);
  });
  const episode = { id: 'legacy-episode', repositoryId: 'repo-1', sessionId: 'session-1', detector: 'm6-deterministic@1', state: 'solution-supported', evidenceEventIds: ['event-1'] };
  database.prepare('INSERT INTO operational_episodes VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(episode.id, episode.repositoryId, episode.sessionId, episode.detector, episode.state, JSON.stringify(episode.evidenceEventIds), JSON.stringify(episode));
  database.prepare('INSERT INTO operational_findings VALUES (?, ?, ?, ?, ?)').run('legacy-finding', episode.id, 'repository-tool-convention', '["event-1"]', 'Use pnpm.');
  database.prepare('INSERT INTO operational_candidates VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('legacy-candidate', episode.id, 'convention', 'candidate', 'Use pnpm.', '["repository:repo-1"]', '["Use pnpm."]', '["Instruction changes."]');
  database.prepare('INSERT INTO operational_candidate_evidence VALUES (?, ?, ?)').run('legacy-candidate', 'event-1', 'confirms');
  database.close();
}

test('legacy migration quarantines the fourth running attempt without permitting a fifth claim', () => {
  const databasePath = path();
  legacyDatabase(databasePath, ['pending', 'completed', 'running']);
  const database = new DatabaseSync(databasePath);
  database.prepare("UPDATE operational_analysis_jobs SET attempts = 4 WHERE id = 'legacy-8'").run();
  database.close();
  const now = () => '2026-09-13T10:00:00.000Z';
  for (let reopen = 0; reopen < 2; reopen += 1) {
    const repository = new OperationalLearningRepository(databasePath, now);
    const outstanding = repository.jobsForStream('repo-1', 'session-1').find(({ state }) => state !== 'completed')!;
    assert.equal(repository.claim({ ownerId: 'owner', leaseMs: 60_000 }), undefined, 'a migrated fourth attempt must never be claimed again');
    assert.equal(outstanding.state, 'quarantined-input');
    assert.equal(outstanding.attempts, 4);
    assert.equal(outstanding.failureReason, 'lease-expired');
    assert.equal(outstanding.retryAfter, null);
    assert.equal(repository.claimableCount(), 0);
    repository.close();
  }
});

function versionOneRetryableDatabase(databasePath: string, attempts: number, retryAfter: string | null): void {
  legacyDatabase(databasePath, ['pending', 'pending', 'pending']);
  const database = new DatabaseSync(databasePath);
  database.exec(`DROP TABLE operational_analysis_jobs;
    CREATE TABLE operational_analysis_schema (version INTEGER PRIMARY KEY);
    INSERT INTO operational_analysis_schema VALUES (1);
    CREATE TABLE operational_analysis_streams (
      repository_id TEXT NOT NULL, session_id TEXT NOT NULL, detector_set_version TEXT NOT NULL,
      committed_high_water INTEGER NOT NULL, processed_high_water INTEGER NOT NULL DEFAULT 0,
      checkpoint_json TEXT NOT NULL DEFAULT '{"version":1,"pendingEvents":[]}', next_generation INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(repository_id, session_id, detector_set_version)
    );
    CREATE TABLE operational_analysis_jobs (
      id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, session_id TEXT NOT NULL, detector_set_version TEXT NOT NULL,
      input_low_water INTEGER NOT NULL, input_high_water INTEGER NOT NULL, processed_high_water INTEGER NOT NULL,
      state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry_after TEXT, lease_owner TEXT,
      lease_expires_at TEXT, failure_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(repository_id, session_id, detector_set_version)
        REFERENCES operational_analysis_streams(repository_id, session_id, detector_set_version)
    );
    CREATE UNIQUE INDEX operational_analysis_one_pending ON operational_analysis_jobs(repository_id, session_id, detector_set_version)
      WHERE state IN ('pending', 'retryable-failure');
    CREATE UNIQUE INDEX operational_analysis_one_running ON operational_analysis_jobs(repository_id, session_id, detector_set_version)
      WHERE state = 'running';`);
  database.prepare(`INSERT INTO operational_analysis_streams (repository_id, session_id, detector_set_version,
    committed_high_water, next_generation, created_at, updated_at) VALUES ('repo-1', 'session-1', ?, 8, 2, ?, ?)`)
    .run(DETECTOR_SET_VERSION, '2026-09-12T10:00:00.000Z', '2026-09-12T10:00:00.000Z');
  database.prepare(`INSERT INTO operational_analysis_jobs (id, repository_id, session_id, detector_set_version,
    input_low_water, input_high_water, processed_high_water, state, attempts, retry_after, failure_reason, created_at, updated_at)
    VALUES ('v1-job', 'repo-1', 'session-1', ?, 0, 8, 0, 'retryable-failure', ?, ?, 'execution-failure', ?, ?)`)
    .run(DETECTOR_SET_VERSION, attempts, retryAfter, '2026-09-12T10:00:00.000Z', '2026-09-12T10:00:00.000Z');
  database.close();
}

for (const attempts of [2, 4]) {
  for (const retryAfter of [null, '2026-09-13T10:00:02.000Z']) {
    test(`version-one retryable attempt ${attempts} ${retryAfter === null ? 'without eligibility receives bounded recovery' : 'retains eligibility only within its attempt budget'}`, () => {
      const databasePath = path();
      versionOneRetryableDatabase(databasePath, attempts, retryAfter);
      let millis = Date.parse('2026-09-13T10:00:00.000Z');
      const expectedRetryAfter = attempts >= 4 ? null : retryAfter ?? '2026-09-13T10:00:05.000Z';
      for (let reopen = 0; reopen < 2; reopen += 1) {
        const repository = new OperationalLearningRepository(databasePath, () => new Date(millis).toISOString());
        const job = repository.jobById('v1-job')!;
        assert.equal(job.state, attempts >= 4 ? 'quarantined-input' : 'retryable-failure');
        assert.equal(job.retryAfter, expectedRetryAfter);
        assert.equal(job.attempts, attempts);
        assert.equal(job.failureReason, retryAfter !== null && attempts < 4 ? 'execution-failure' : 'lease-expired');
        assert.equal(repository.claim({ ownerId: 'owner', leaseMs: 60_000 }), undefined);
        if (reopen === 1 && expectedRetryAfter !== null) {
          millis = Date.parse(expectedRetryAfter);
          assert.equal(repository.claim({ ownerId: 'owner', leaseMs: 60_000 })?.attempts, attempts + 1);
        }
        repository.close();
        millis += 1_000;
      }
    });
  }
}

test('legacy running recovery preserves deterministic retry eligibility below four attempts', () => {
  for (const attempt of [1, 2, 3]) {
    const databasePath = path();
    legacyDatabase(databasePath, ['pending', 'completed', 'running']);
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE operational_analysis_jobs SET attempts = 0 WHERE id = 'legacy-2'").run();
    database.prepare("UPDATE operational_analysis_jobs SET attempts = ? WHERE id = 'legacy-8'").run(attempt);
    database.close();
    let millis = Date.parse('2026-09-13T10:00:00.000Z');
    const repository = new OperationalLearningRepository(databasePath, () => new Date(millis).toISOString());
    const outstanding = repository.jobsForStream('repo-1', 'session-1').find(({ state }) => state !== 'completed')!;
    const delay = [1_000, 5_000, 30_000][attempt - 1]!;
    assert.equal(outstanding.retryAfter, new Date(millis + delay).toISOString());
    assert.equal(outstanding.failureReason, 'lease-expired');
    assert.equal(repository.claim({ ownerId: 'owner', leaseMs: 60_000 }), undefined);
    millis += delay;
    assert.equal(repository.claim({ ownerId: 'owner', leaseMs: 60_000 })?.attempts, attempt + 1);
    repository.close();
  }
});

test('filtered status keeps the active running count global across repositories', () => {
  const repository = new OperationalLearningRepository(path(), () => '2026-09-13T10:00:00.000Z');
  for (const repositoryId of ['repo-1', 'repo-2']) {
    repository.enqueue({ repositoryId, sessionId: 'session-1', inputHighWater: 4 });
    repository.claim({ repositoryId, ownerId: 'owner', leaseMs: 60_000 });
  }
  const filtered = repository.status({ repositoryId: 'unmatched', sessionId: 'unmatched' });
  assert.equal(filtered.activeRunningCount, 2);
  assert.deepEqual(filtered.jobs, { pending: 0, running: 0, completed: 0, 'retryable-failure': 0, 'quarantined-input': 0 });
  assert.equal(filtered.totalAttempts, 0);
  assert.equal(repository.status({ repositoryId: 'repo-1' }).activeRunningCount, 2);
  repository.close();
});

test('public retry accepts lease-expired with owner fencing and normal backoff', () => {
  const databasePath = path();
  const repository = new OperationalLearningRepository(databasePath, () => '2026-09-13T10:00:00.000Z');
  repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 4 });
  const job = repository.claim({ ownerId: 'owner', leaseMs: 60_000 })!;
  repository.retry(job.id, { ownerId: 'owner', attempt: job.attempts, reason: 'lease-expired' });
  assert.equal(repository.jobById(job.id)?.state, 'retryable-failure');
  assert.equal(repository.jobById(job.id)?.retryAfter, '2026-09-13T10:00:01.000Z');
  assert.equal(repository.jobById(job.id)?.failureReason, 'lease-expired');
  assert.equal(repository.claimableCount(), 0);
  assert.throws(() => repository.retry(job.id, { ownerId: 'owner', attempt: job.attempts, reason: 'lease-expired' }), /lease/i);
  const database = new DatabaseSync(databasePath);
  assert.equal(database.prepare('SELECT failure_category FROM operational_analysis_attempts WHERE job_id = ?').get(job.id)?.failure_category, 'lease-expired');
  database.close(); repository.close();
});

test('migrates legacy progress and coverage once while coalescing subsequent admissions', () => {
  const databasePath = path();
  legacyDatabase(databasePath, ['pending', 'completed', 'pending']);
  for (let reopen = 0; reopen < 3; reopen += 1) {
    const repository = new OperationalLearningRepository(databasePath);
    assert.equal(repository.stream('repo-1', 'session-1')?.committedHighWater, 8);
    assert.equal(repository.stream('repo-1', 'session-1')?.processedHighWater, 4);
    assert.equal(repository.jobById('legacy-4')?.state, 'completed');
    assert.equal(repository.jobsForStream('repo-1', 'session-1').filter(({ state }) => state === 'pending').length, 1);
    assert.deepEqual(repository.report('repo-1').coverage, [{ detector: 'm6-deterministic@1', detectorSetVersion: DETECTOR_SET_VERSION,
      inputLowWater: 0, requestedHighWater: 4, processedHighWater: 4, status: 'completed', examinedEvents: 4, findings: 0 }]);
    assert.equal(repository.report('repo-1').episodes[0]?.id, 'legacy-episode');
    assert.equal(repository.report('repo-1').findings[0]?.id, 'legacy-finding');
    assert.deepEqual(repository.report('repo-1').candidates[0]?.evidenceEventIds, ['event-1']);
    repository.close();
  }
  const repository = new OperationalLearningRepository(databasePath);
  const admitted = [9, 10, 11].map((inputHighWater) => repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater }));
  assert.ok(admitted[0]);
  assert.equal(new Set(admitted.map((job) => job?.id)).size, 1);
  assert.equal(admitted[2]?.inputHighWater, 11);
  assert.equal(admitted[2]?.inputLowWater, 4);
  const running = repository.claim();
  assert.equal(running?.id, admitted[0].id);
  const successor = repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 12 });
  const extended = repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 13 });
  assert.ok(successor);
  assert.equal(successor.id, extended?.id);
  assert.notEqual(successor.id, running?.id);
  assert.match(successor.id, /^[a-f0-9]{64}$/);
  assert.equal(repository.claim(), undefined, 'the same stream cannot be claimed while running');
  assert.deepEqual(repository.stream('repo-1', 'session-1'), {
    repositoryId: 'repo-1', sessionId: 'session-1', detectorSetVersion: DETECTOR_SET_VERSION,
    committedHighWater: 13, processedHighWater: 4, checkpoint: { version: 1, pendingEvents: [] }
  });
  assert.deepEqual(repository.jobsForStream('repo-1', 'session-1').filter(({ state }) => state !== 'completed').map(({ state, inputHighWater }) => ({ state, inputHighWater })).sort((a, b) => a.inputHighWater - b.inputHighWater), [
    { state: 'running', inputHighWater: 11 }, { state: 'pending', inputHighWater: 13 }
  ]);
  repository.close();
});

test('recovers legacy running rows into one retryable successor without replaying completed input', () => {
  const databasePath = path();
  legacyDatabase(databasePath, ['running', 'completed', 'retryable-failure']);
  let millis = Date.parse('2026-09-13T10:00:00.000Z');
  const repository = new OperationalLearningRepository(databasePath, () => new Date(millis).toISOString());
  const active = repository.jobsForStream('repo-1', 'session-1').filter(({ state }) => state !== 'completed');
  assert.equal(active.length, 1);
  assert.equal(active[0]?.state, 'retryable-failure');
  assert.equal(active[0]?.inputHighWater, 8);
  assert.equal(active[0]?.inputLowWater, 4);
  assert.equal(active[0]?.processedHighWater, 4);
  assert.equal(repository.claim(), undefined);
  millis = Date.parse(active[0]!.retryAfter!);
  assert.equal(repository.claim()?.id, active[0]?.id);
  repository.close();
  const reopened = new OperationalLearningRepository(databasePath);
  assert.equal(reopened.jobById(active[0]!.id)?.state, 'running', 'migration must not run on subsequent opens');
  reopened.close();
});

test('migrates unfinished empty legacy streams but does not repeat completed convention analysis', () => {
  for (const state of ['running', 'completed']) {
    const databasePath = path();
    legacyDatabase(databasePath, ['pending', 'pending', 'pending']);
    const database = new DatabaseSync(databasePath);
    database.prepare("DELETE FROM operational_analysis_jobs WHERE id != 'legacy-8'").run();
    database.prepare("UPDATE operational_analysis_jobs SET input_high_water = 0, state = ? WHERE id = 'legacy-8'").run(state);
    database.close();
    let millis = Date.parse('2026-09-13T10:00:00.000Z');
    const repository = new OperationalLearningRepository(databasePath, () => new Date(millis).toISOString());
    if (state === 'running') {
      assert.equal(repository.jobsForStream('repo-1', 'session-1')[0]?.state, 'retryable-failure');
      assert.equal(repository.claim(), undefined);
      millis = Date.parse(repository.jobsForStream('repo-1', 'session-1')[0]!.retryAfter!);
      assert.equal(repository.claim()?.inputHighWater, 0);
    } else {
      assert.equal(repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 0 }), undefined);
      assert.equal(repository.jobById('legacy-8')?.state, 'completed');
    }
    repository.close();
  }
});

test('unchanged processed input creates no job and each detector version schedules input once', () => {
  const repository = new OperationalLearningRepository(path());
  const input = { repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 4 };
  const first = repository.enqueue(input);
  assert.ok(first);
  assert.match(first.id, /^[a-f0-9]{64}$/);
  repository.claim();
  repository.saveResult(first.id, { episodes: [], findings: [], candidates: [] });
  assert.equal(repository.stream('repo-1', 'session-1')?.processedHighWater, 4);
  assert.equal(repository.enqueue(input), undefined);
  assert.equal(repository.enqueue({ ...input, inputHighWater: 2 }), undefined);
  assert.equal(repository.stream('repo-1', 'session-1')?.committedHighWater, 4);
  assert.equal(repository.jobsForStream('repo-1', 'session-1').length, 1);
  const version = 'm6-deterministic@2';
  const next = repository.enqueue({ ...input, detectorSetVersion: version });
  assert.ok(next);
  assert.notEqual(next.id, first.id);
  assert.equal(next.inputLowWater, 0);
  assert.equal(repository.stream('repo-1', 'session-1', version)?.processedHighWater, 0);
  assert.equal(repository.enqueue({ ...input, detectorSetVersion: version })?.id, next.id);
  repository.claim();
  repository.saveResult(next.id, { episodes: [], findings: [], candidates: [] });
  assert.equal(repository.enqueue({ ...input, detectorSetVersion: version }), undefined);
  assert.equal(repository.jobsForStream('repo-1', 'session-1', version).length, 1);
  repository.close();
});

test('schema enforces one running and one pending or retryable row per versioned stream', () => {
  const databasePath = path();
  const repository = new OperationalLearningRepository(databasePath);
  repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 1 });
  repository.claim();
  repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 2 });
  const database = new DatabaseSync(databasePath);
  assert.equal(database.prepare('SELECT version FROM operational_analysis_schema').all().length, 1);
  const columns = database.prepare('PRAGMA table_info(operational_analysis_jobs)').all().map((row) => row.name);
  for (const column of ['input_low_water', 'processed_high_water', 'detector_set_version', 'retry_after', 'lease_owner', 'lease_expires_at', 'failure_reason']) assert.ok(columns.includes(column), column);
  for (const state of ['pending', 'retryable-failure', 'running']) {
    assert.throws(() => database.prepare(`INSERT INTO operational_analysis_jobs (id, repository_id, session_id, detector_set_version, input_low_water, input_high_water, processed_high_water, state, created_at, updated_at) VALUES (?, 'repo-1', 'session-1', ?, 0, 3, 0, ?, 'now', 'now')`).run(`duplicate-${state}`, DETECTOR_SET_VERSION, state), /UNIQUE constraint failed/);
  }
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  database.close();
  repository.close();
});

test('analyzes an empty stream once per detector version for repository conventions', () => {
  const repository = new OperationalLearningRepository(path());
  const input = { repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 0 };
  for (const detectorSetVersion of [DETECTOR_SET_VERSION, 'm6-deterministic@2']) {
    const job = repository.enqueue({ ...input, detectorSetVersion });
    assert.ok(job, 'a new detector set must inspect repository conventions even without events');
    assert.equal(repository.enqueue({ ...input, detectorSetVersion })?.id, job.id);
    repository.claim();
    repository.saveResult(job.id, { episodes: [], findings: [], candidates: [] });
    assert.equal(repository.enqueue({ ...input, detectorSetVersion }), undefined);
    assert.equal(repository.jobsForStream('repo-1', 'session-1', detectorSetVersion).length, 1);
  }
  repository.close();
});

test('admission validates stream identity and high-water before durable changes', () => {
  const repository = new OperationalLearningRepository(path());
  const input = { repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 1 };
  for (const invalid of [{ repositoryId: '' }, { sessionId: ' ' }, { detectorSetVersion: '' }, ...[-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((inputHighWater) => ({ inputHighWater }))]) {
    assert.throws(() => repository.enqueue({ ...input, ...invalid }), TypeError);
  }
  assert.equal(repository.stream('repo-1', 'session-1'), undefined);
  repository.close();
});

test('retry merges a pending successor without violating the stream uniqueness constraint', () => {
  let millis = Date.parse('2026-09-13T10:00:00.000Z');
  const repository = new OperationalLearningRepository(path(), () => new Date(millis).toISOString());
  repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 4 });
  const running = repository.claim();
  assert.ok(running);
  repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 8 });
  repository.retry(running.id);
  const jobs = repository.jobsForStream('repo-1', 'session-1');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.id, running.id);
  assert.equal(jobs[0]?.state, 'retryable-failure');
  assert.equal(jobs[0]?.inputHighWater, 8);
  millis += 1_000;
  assert.equal(repository.claim()?.id, running.id);
  repository.close();
});

test('migration failure rolls back the legacy schema and can be safely retried', () => {
  const databasePath = path();
  legacyDatabase(databasePath, ['pending', 'completed', 'pending']);
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = OFF');
  database.prepare('INSERT INTO operational_analysis_coverage VALUES (?, ?, ?, ?, ?)').run('missing-job', 'm6-deterministic@1', 'completed', 1, 0);
  assert.throws(() => new OperationalLearningRepository(databasePath), /migration violates foreign keys/);
  assert.deepEqual(database.prepare('SELECT id FROM operational_analysis_jobs ORDER BY input_high_water').all().map(({ id }) => id), ['legacy-2', 'legacy-4', 'legacy-8']);
  assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'operational_analysis_schema'").get(), undefined);
  database.prepare("DELETE FROM operational_analysis_coverage WHERE job_id = 'missing-job'").run();
  database.close();
  const repository = new OperationalLearningRepository(databasePath);
  assert.equal(repository.stream('repo-1', 'session-1')?.processedHighWater, 4);
  repository.close();
});

test('returns frozen stream state and consumes job generations across reopen', () => {
  const databasePath = path();
  let repository = new OperationalLearningRepository(databasePath);
  const input = { repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 1 };
  const first = repository.enqueue(input);
  assert.ok(first);
  const stream = repository.stream('repo-1', 'session-1');
  assert.ok(stream);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(stream));
  assert.ok(Object.isFrozen(stream.checkpoint));
  assert.ok(Object.isFrozen(stream.checkpoint.pendingEvents));
  assert.ok(Object.isFrozen(repository.jobsForStream('repo-1', 'session-1')));
  repository.claim();
  repository.saveResult(first.id, { episodes: [], findings: [], candidates: [] });
  repository.close();
  repository = new OperationalLearningRepository(databasePath);
  const next = repository.enqueue({ ...input, inputHighWater: 2 });
  assert.ok(next);
  assert.notEqual(first.id, next.id);
  const database = new DatabaseSync(databasePath);
  assert.equal(database.prepare('SELECT next_generation FROM operational_analysis_streams').get()?.next_generation, 3);
  database.close();
  repository.close();
});

test('coalesces an equivalent job and persists candidates across restart', () => {
  const databasePath = path();
  const repository = new OperationalLearningRepository(databasePath, () => '2026-09-08T11:00:00.000Z');
  const first = repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 4 });
  const repeated = repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 4 });
  assert.ok(first);
  assert.ok(repeated);
  assert.equal(first.id, repeated.id);
  const job = repository.claim();
  assert.ok(job);
  repository.saveResult(job!.id, {
    episodes: [{ id: 'episode-1', repositoryId: 'repo-1', sessionId: 'session-1', detector: 'm6-deterministic@1', state: 'solution-supported', evidenceEventIds: ['event-1'] }],
    findings: [],
    candidates: [{ id: 'candidate-1', episodeId: 'episode-1', kind: 'convention', state: 'candidate', statement: 'Use pnpm.', conditions: ['repository:repo-1'], procedure: ['Use pnpm.'], evidenceEventIds: ['event-1'], invalidationConditions: ['Instruction changes.'] }]
  });
  repository.close();

  const reopened = new OperationalLearningRepository(databasePath);
  assert.deepEqual(reopened.report('repo-1').candidates.map(({ id, kind, state }) => ({ id, kind, state })), [{ id: 'candidate-1', kind: 'convention', state: 'candidate' }]);
  reopened.close();
});

test('retains contradictory evidence and marks the candidate disputed', () => {
  const repository = new OperationalLearningRepository(path());
  const job = repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 1 });
  assert.ok(job);
  repository.claim();
  repository.saveResult(job.id, {
    episodes: [{ id: 'episode-1', repositoryId: 'repo-1', sessionId: 'session-1', detector: 'm6-deterministic@1', state: 'solution-supported', evidenceEventIds: ['event-1'] }],
    findings: [], candidates: [{ id: 'candidate-1', episodeId: 'episode-1', kind: 'convention', state: 'candidate', statement: 'Use pnpm.', conditions: ['repository:repo-1'], procedure: ['Use pnpm.'], evidenceEventIds: ['event-1'], invalidationConditions: ['Instruction changes.'] }]
  });
  repository.contradict('candidate-1', 'event-2');
  const report = repository.report('repo-1');
  assert.equal(report.candidates[0]?.state, 'disputed');
  assert.deepEqual(report.candidates[0]?.evidenceEventIds, ['event-1', 'event-2']);
  repository.close();
});

test('retries a bounded failed job and quarantines it after the fourth failure', () => {
  let millis = Date.parse('2026-09-13T10:00:00.000Z');
  const repository = new OperationalLearningRepository(path(), () => new Date(millis).toISOString());
  const job = repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 1 });
  assert.ok(job);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const claimed = repository.claim();
    assert.equal(claimed?.state, 'running');
    repository.retry(claimed!.id);
    millis += [1_000, 5_000, 30_000][attempt - 1]!;
  }
  const fourth = repository.claim();
  assert.equal(fourth?.attempts, 4);
  repository.retry(fourth!.id);
  assert.equal(repository.jobById(job.id)?.state, 'quarantined-input');
  assert.equal(repository.claim(), undefined);
  repository.close();
});

test('quarantines invalid input without retrying it', () => {
  const repository = new OperationalLearningRepository(path());
  const job = repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-2', inputHighWater: 1 });
  assert.ok(job);
  const claimed = repository.claim();
  repository.retry(claimed!.id, 'invalid-input');
  assert.equal(repository.jobById(job.id)?.state, 'quarantined-input');
  assert.equal(repository.jobById(job.id)?.attempts, 1);
  repository.close();
});

test('retries a timed-out job as an execution failure', () => {
  const repository = new OperationalLearningRepository(path());
  const job = repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-3', inputHighWater: 1 });
  assert.ok(job);
  const claimed = repository.claim();
  repository.retry(claimed!.id, 'timeout');
  assert.equal(repository.jobById(job.id)?.state, 'retryable-failure');
  repository.close();
});

for (const reason of ['execution-failure', 'invalid-input'] as const) {
  test(`unchanged admission preserves ${reason} quarantine and higher input waits behind its unprocessed prefix`, () => {
    const databasePath = path();
    let millis = Date.parse('2026-09-13T10:00:00.000Z');
    let repository = new OperationalLearningRepository(databasePath, () => new Date(millis).toISOString());
    const input = { repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 4 };
    const original = repository.enqueue(input);
    assert.ok(original);
    const attempts = reason === 'invalid-input' ? 1 : 4;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      assert.equal(repository.claim()?.id, original.id);
      repository.retry(original.id, reason);
      millis += [1_000, 5_000, 30_000, 0][attempt]!;
    }
    const quarantined = repository.jobById(original.id);
    assert.equal(quarantined?.state, 'quarantined-input');
    assert.equal(quarantined?.attempts, attempts);
    assert.equal(repository.enqueue(input), undefined);
    assert.equal(repository.jobsForStream('repo-1', 'session-1').length, 1);
    assert.equal(repository.claim(), undefined);

    const successor = repository.enqueue({ ...input, inputHighWater: 8 });
    assert.ok(successor, 'higher committed demand remains durable behind the quarantine');
    assert.equal(successor.inputLowWater, 0, 'the quarantined prefix must not be skipped');
    assert.equal(successor.processedHighWater, 0);
    assert.equal(successor.inputHighWater, 8);
    assert.equal(repository.stream('repo-1', 'session-1')?.processedHighWater, 0);
    assert.equal(repository.stream('repo-1', 'session-1')?.committedHighWater, 8);
    assert.deepEqual(repository.jobById(original.id), quarantined);
    assert.equal(repository.enqueue({ ...input, inputHighWater: 8 }), undefined);
    assert.equal(repository.claim(), undefined, 'a successor cannot restart an unresolved quarantined prefix');
    repository.close();
    repository = new OperationalLearningRepository(databasePath);
    assert.equal(repository.claim(), undefined);
    assert.deepEqual(repository.jobById(original.id), quarantined);
    assert.equal(repository.jobById(successor.id)?.attempts, 0);
    repository.close();
  });
}

test('a successor queued before quarantine remains blocked while another stream can be claimed', () => {
  const repository = new OperationalLearningRepository(path());
  const input = { repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 2 };
  const completed = repository.enqueue(input);
  assert.ok(completed);
  repository.claim();
  repository.saveResult(completed.id, { episodes: [], findings: [], candidates: [] });
  const running = repository.enqueue({ ...input, inputHighWater: 4 });
  assert.ok(running);
  repository.claim();
  const successor = repository.enqueue({ ...input, inputHighWater: 8 });
  assert.ok(successor);
  repository.retry(running.id, 'invalid-input');
  assert.equal(repository.claim(), undefined);
  assert.equal(repository.jobById(successor.id)?.inputLowWater, 2);
  assert.equal(repository.stream('repo-1', 'session-1')?.processedHighWater, 2);
  assert.equal(repository.enqueue({ ...input, inputHighWater: 9 })?.id, successor.id);
  assert.equal(repository.claim(), undefined);
  const independent = repository.enqueue({ ...input, detectorSetVersion: 'm6-deterministic@2' });
  assert.ok(independent);
  assert.equal(repository.claim()?.id, independent.id);
  repository.close();
});
