import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { DETECTOR_SET_VERSION, OperationalLearningRepository } from '../src/learning/repository.js';

function path(): string { return join(mkdtempSync(join(tmpdir(), 'ael-learning-repository-')), 'experience.sqlite'); }

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

test('migrates legacy progress and coverage once while coalescing subsequent admissions', () => {
  const databasePath = path();
  legacyDatabase(databasePath, ['pending', 'completed', 'pending']);
  for (let reopen = 0; reopen < 3; reopen += 1) {
    const repository = new OperationalLearningRepository(databasePath);
    assert.equal(repository.stream('repo-1', 'session-1')?.committedHighWater, 8);
    assert.equal(repository.stream('repo-1', 'session-1')?.processedHighWater, 4);
    assert.equal(repository.jobById('legacy-4')?.state, 'completed');
    assert.equal(repository.jobsForStream('repo-1', 'session-1').filter(({ state }) => state === 'pending').length, 1);
    assert.deepEqual(repository.report('repo-1').coverage, [{ detector: 'm6-deterministic@1', status: 'completed', examinedEvents: 4, findings: 0 }]);
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
  const repository = new OperationalLearningRepository(databasePath);
  const active = repository.jobsForStream('repo-1', 'session-1').filter(({ state }) => state !== 'completed');
  assert.equal(active.length, 1);
  assert.equal(active[0]?.state, 'retryable-failure');
  assert.equal(active[0]?.inputHighWater, 8);
  assert.equal(active[0]?.inputLowWater, 4);
  assert.equal(active[0]?.processedHighWater, 4);
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
    const repository = new OperationalLearningRepository(databasePath);
    if (state === 'running') {
      assert.equal(repository.jobsForStream('repo-1', 'session-1')[0]?.state, 'retryable-failure');
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
  const repository = new OperationalLearningRepository(path());
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
  const repository = new OperationalLearningRepository(path());
  const job = repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 1 });
  assert.ok(job);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const claimed = repository.claim();
    assert.equal(claimed?.state, 'running');
    repository.retry(claimed!.id);
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
    let repository = new OperationalLearningRepository(databasePath);
    const input = { repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 4 };
    const original = repository.enqueue(input);
    assert.ok(original);
    const attempts = reason === 'invalid-input' ? 1 : 4;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      assert.equal(repository.claim()?.id, original.id);
      repository.retry(original.id, reason);
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
