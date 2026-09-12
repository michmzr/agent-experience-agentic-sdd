import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { OperationalLearningService } from '../src/learning/service.js';
import { OperationalLearningRepository } from '../src/learning/repository.js';

test('returns false when no committed analysis job is pending', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-learning-service-'));
  const service = new OperationalLearningService(join(dataDir, 'experience.sqlite'));
  assert.deepEqual(service.runNext(), { status: 'idle' });
});

test('coalesces admission into one detector-version stream and keeps later input pending', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-learning-stream-'));
  const databasePath = join(dataDir, 'experience.sqlite');
  const repository = new OperationalLearningRepository(databasePath, () => '2026-09-12T10:00:00.000Z');
  try {
    repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', detectorVersion: 'm6-deterministic@1', inputHighWater: 5 });
    repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', detectorVersion: 'm6-deterministic@1', inputHighWater: 8 });
    assert.equal(repository.streamsFor('repo-1')[0]?.desiredThrough, 8);
    const claimed = repository.claim();
    assert.equal(claimed?.inputFrom, 1);
    assert.equal(claimed?.inputThrough, 8);
    repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', detectorVersion: 'm6-deterministic@1', inputHighWater: 10 });
    repository.saveResult(claimed!.id, { episodes: [], findings: [], candidates: [] });
    assert.equal(repository.streamsFor('repo-1')[0]?.state, 'pending');
    assert.equal(repository.analysisRunsFor('repo-1')[0]?.inputThrough, 8);
  } finally { repository.close(); }
});

test('recovers a stale lease and never reruns an unchanged completed range', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-learning-lease-'));
  let time = '2026-09-12T10:00:00.000Z';
  const repository = new OperationalLearningRepository(join(dataDir, 'experience.sqlite'), () => time);
  try {
    repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', detectorVersion: 'm6-deterministic@1', inputHighWater: 5 });
    const first = repository.claim();
    time = '2026-09-12T10:05:00.000Z';
    const recovered = repository.claim();
    assert.equal(recovered?.id, first?.id);
    repository.saveResult(recovered!.id, { episodes: [], findings: [], candidates: [] });
    repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', detectorVersion: 'm6-deterministic@1', inputHighWater: 5 });
    assert.equal(repository.claim(), undefined);
  } finally { repository.close(); }
});
