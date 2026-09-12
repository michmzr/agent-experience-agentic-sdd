import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { OperationalLearningRepository } from '../src/learning/repository.js';

function path(): string { return join(mkdtempSync(join(tmpdir(), 'ael-learning-repository-')), 'experience.sqlite'); }

test('coalesces an equivalent job and persists candidates across restart', () => {
  const databasePath = path();
  const repository = new OperationalLearningRepository(databasePath, () => '2026-09-08T11:00:00.000Z');
  const first = repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 4 });
  const repeated = repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 4 });
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
  const claimed = repository.claim();
  repository.saveResult(claimed!.id, {
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
  let now = '2026-09-12T10:00:00.000Z';
  const repository = new OperationalLearningRepository(path(), () => now);
  const job = repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 1 });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const claimed = repository.claim();
    assert.equal(claimed?.state, 'running');
    repository.retry(claimed!.id);
    now = new Date(Date.parse(now) + 2 ** (attempt - 1) * 1_000).toISOString();
  }
  const fourth = repository.claim();
  assert.equal(fourth?.attempts, 4);
  repository.retry(fourth!.id);
  assert.equal(repository.jobById(fourth!.id)?.state, 'quarantined-input');
  assert.equal(repository.claim(), undefined);
  repository.close();
});

test('quarantines invalid input without retrying it', () => {
  const repository = new OperationalLearningRepository(path());
  const job = repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-2', inputHighWater: 1 });
  const claimed = repository.claim();
  repository.retry(claimed!.id, 'invalid-input');
  assert.equal(repository.jobById(claimed!.id)?.state, 'quarantined-input');
  assert.equal(repository.jobById(claimed!.id)?.attempts, 1);
  repository.close();
});

test('retries a timed-out job as an execution failure', () => {
  const repository = new OperationalLearningRepository(path());
  const job = repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-3', inputHighWater: 1 });
  const claimed = repository.claim();
  repository.retry(claimed!.id, 'timeout');
  assert.equal(repository.jobById(claimed!.id)?.state, 'retryable-failure');
  repository.close();
});

test('persists deterministic bounded retry eligibility and completed cost counters', () => {
  const databasePath = path();
  let now = '2026-09-12T10:00:00.000Z';
  const repository = new OperationalLearningRepository(databasePath, () => now);
  try {
    repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-4', inputHighWater: 1 });
    const first = repository.claim();
    repository.retry(first!.id);
    assert.equal(repository.jobById(first!.id)?.nextEligibleAt, '2026-09-12T10:00:01.000Z');
    assert.equal(repository.claim(), undefined);
    now = '2026-09-12T10:00:01.000Z';
    const retry = repository.claim();
    repository.saveResult(retry!.id, { episodes: [], findings: [], candidates: [], cost: 7 });
    assert.deepEqual(repository.report('repo-1').cost, { completedRuns: 1, total: 7 });
  } finally { repository.close(); }
});
