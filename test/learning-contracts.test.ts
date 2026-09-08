import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLearningCandidate,
  createOperationalEpisode,
  type LearningCandidate,
  type OperationalEpisode
} from '../src/learning/contracts.js';

const episode: OperationalEpisode = {
  id: 'episode-1',
  sessionId: 'session-1',
  detector: 'command-repair@1',
  state: 'solution-supported',
  evidenceEventIds: ['event-1', 'event-2', 'event-3'],
  attemptedOperation: 'npm install',
  changedOperation: 'pnpm install',
  confirmingEventId: 'event-3'
};

const candidate: LearningCandidate = {
  id: 'candidate-1',
  episodeId: 'episode-1',
  kind: 'successful-workflow',
  state: 'candidate',
  statement: 'Use pnpm install after npm install fails for this repository task.',
  conditions: ['repository:repo-1'],
  procedure: ['Run pnpm install.'],
  evidenceEventIds: ['event-1', 'event-2', 'event-3'],
  invalidationConditions: ['A later task verification contradicts the repair.']
};

test('creates immutable episode and candidate records from bounded operational evidence', () => {
  const storedEpisode = createOperationalEpisode(episode);
  const storedCandidate = createLearningCandidate(candidate);

  assert.deepEqual(storedEpisode, episode);
  assert.deepEqual(storedCandidate, candidate);
  assert.equal(Object.isFrozen(storedEpisode), true);
  assert.equal(Object.isFrozen(storedCandidate.evidenceEventIds), true);
});

test('rejects malformed operational learning identities and duplicate evidence', () => {
  assert.throws(() => createOperationalEpisode({ ...episode, id: '' }), /identity/i);
  assert.throws(() => createOperationalEpisode({ ...episode, evidenceEventIds: ['event-1', 'event-1'] }), /duplicate/i);
  assert.throws(() => createLearningCandidate({ ...candidate, kind: 'heuristic' as never }), /kind/i);
});
