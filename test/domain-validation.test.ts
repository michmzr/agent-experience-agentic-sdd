import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  CandidateLessonId,
  Evidence,
  EventId,
  ExperienceImport,
  KnowledgeEntry,
  ObservationId,
  SessionId
} from '../src/domain/types.js';
import { applyTransition } from '../src/domain/transitions.js';
import { validateImport } from '../src/domain/validation.js';

function validImport(): ExperienceImport {
  return {
    sessions: [{ id: 'session-1' as SessionId, source: 'codex' as const, startedAt: '2026-08-24T10:00:00.000Z' }],
    events: [{ id: 'event-1' as EventId, sessionId: 'session-1' as SessionId, kind: 'test-result', occurredAt: '2026-08-24T10:01:00.000Z', outcome: 'passed' }],
    observations: [{ id: 'observation-1' as ObservationId, eventIds: ['event-1' as EventId], statement: 'The focused test passed.' }],
    clusters: [{ id: 'cluster-1' as ExperienceImport['clusters'][number]['id'], observationIds: ['observation-1' as ObservationId] }],
    candidates: [{ id: 'candidate-1' as CandidateLessonId, clusterId: 'cluster-1' as ExperienceImport['clusters'][number]['id'], kind: 'successful-workflow', statement: 'Run focused tests before a full check.' }],
    evidence: [{ id: 'evidence-1' as Evidence['id'], candidateId: 'candidate-1' as CandidateLessonId, polarity: 'confirms', summary: 'Focused test passed.' }],
    knowledge: [{ id: 'knowledge-1' as KnowledgeEntry['id'], candidateId: 'candidate-1' as CandidateLessonId, evidenceIds: ['evidence-1' as Evidence['id']], state: 'verified', statement: 'Run focused tests before a full check.' }]
  };
}

function fixtureWithMissingEventReference() {
  const record = validImport();
  record.observations[0].eventIds = ['event-missing' as EventId];
  return record;
}

function verifiedKnowledge(): KnowledgeEntry {
  return validImport().knowledge[0] as KnowledgeEntry;
}

function contradictionEvidence(): Evidence {
  return {
    id: 'evidence-contradiction' as Evidence['id'],
    candidateId: 'candidate-1' as CandidateLessonId,
    polarity: 'contradicts',
    summary: 'A verified workflow failed in the same conditions.'
  };
}

function rawTranscriptFixture() {
  return { ...validImport(), rawTranscript: 'full source session' };
}

function pemFixture() {
  const record = validImport();
  record.observations[0].statement = '-----BEGIN PRIVATE KEY-----';
  return record;
}

test('rejects an observation whose source event is missing', () => {
  const result = validateImport(fixtureWithMissingEventReference());

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'MISSING_REFERENCE');
});

test('moves active knowledge to disputed when contradiction evidence is imported', () => {
  const result = applyTransition(verifiedKnowledge(), contradictionEvidence());

  assert.equal(result.entry.state, 'disputed');
  assert.equal(result.entry.evidenceIds.at(-1), 'evidence-contradiction');
  assert.equal(result.history.at(-1)?.to, 'disputed');
});

test('rejects raw transcript and credential-like text', () => {
  assert.equal(validateImport(rawTranscriptFixture()).ok, false);
  assert.equal(validateImport(pemFixture()).ok, false);
});
