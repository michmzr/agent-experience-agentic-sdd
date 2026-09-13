import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEpisodeEvidence,
  createLearningCandidate,
  createOperationalEpisode,
  type EpisodeEvidence,
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

const toolRequest: EpisodeEvidence = {
  id: 'evidence-tool-request-1',
  kind: 'tool-request',
  state: 'observed',
  decisionKey: 'decision-install',
  scopeKey: 'repository-repo-1',
  evidenceIds: ['capture-request-1']
};

const toolResult: EpisodeEvidence = {
  id: 'evidence-tool-result-1',
  kind: 'tool-result',
  state: 'failed',
  decisionKey: 'decision-install',
  reasonClass: 'failure',
  evidenceIds: ['capture-result-1']
};

const agentClaim: EpisodeEvidence = {
  id: 'evidence-agent-claim-1',
  kind: 'agent-claim',
  state: 'observed',
  scopeKey: 'repository-repo-1',
  evidenceIds: ['capture-claim-1']
};

const taskTransition: EpisodeEvidence = {
  id: 'evidence-task-transition-1',
  kind: 'task-transition',
  state: 'closed',
  scopeKey: 'task-issue-9',
  evidenceIds: ['capture-transition-1']
};

const inference: EpisodeEvidence = {
  id: 'evidence-inference-1',
  kind: 'analyzer-inference',
  state: 'observed',
  detectorVersion: 'typed-evidence@1',
  decisionKey: 'decision-install',
  evidenceIds: ['evidence-tool-request-1', 'evidence-tool-result-1']
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

test('creates immutable, typed episode evidence without free text', () => {
  const records = [toolRequest, toolResult, agentClaim, taskTransition, inference].map(createEpisodeEvidence);

  assert.deepEqual(records, [toolRequest, toolResult, agentClaim, taskTransition, inference]);
  assert.equal(Object.isFrozen(records[0]), true);
  assert.equal(Object.isFrozen(records[0]?.evidenceIds), true);
});

test('rejects malformed, duplicate, free-text, and dependency-free episode evidence', () => {
  assert.throws(() => createEpisodeEvidence({ ...toolRequest, kind: 'transcript' as never }), /kind/i);
  assert.throws(() => createEpisodeEvidence({ ...toolRequest, evidenceIds: ['capture-request-1', 'capture-request-1'] }), /duplicate/i);
  assert.throws(() => createEpisodeEvidence({ ...toolRequest, scopeKey: '' }), /scope/i);
  assert.throws(() => createEpisodeEvidence({ ...toolRequest, freeText: 'raw command output' } as EpisodeEvidence), /field/i);
  assert.throws(() => createEpisodeEvidence({ ...toolResult, reasonClass: 'raw command output' as never }), /reason/i);
  assert.throws(() => createEpisodeEvidence({ ...inference, detectorVersion: '' }), /detector/i);
  const { detectorVersion: _detectorVersion, ...inferenceWithoutDetector } = inference;
  assert.throws(() => createEpisodeEvidence(inferenceWithoutDetector), /detector/i);
  assert.throws(() => createEpisodeEvidence({ ...inference, evidenceIds: [] }), /evidence/i);
});
