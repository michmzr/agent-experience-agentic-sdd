import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  CandidateLessonId,
  Evidence,
  EventId,
  ExperienceImport,
  KnowledgeEntry,
  ObservationId,
  SessionId,
  TransitionHistoryEntry
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

function disputedKnowledge(): KnowledgeEntry {
  return applyTransition(verifiedKnowledge(), contradictionEvidence()).entry;
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

test('rejects unsupported lesson kinds and evidence polarities', () => {
  const invalidKind = validImport();
  invalidKind.candidates[0].kind = 'unsupported-kind' as never;
  const invalidPolarity = validImport();
  (invalidPolarity.evidence[0] as { polarity: string }).polarity = 'unsupported-polarity';

  assert.equal(validateImport(invalidKind).ok, false);
  assert.equal(validateImport(invalidPolarity).ok, false);
});

test('rejects all unexpected durable-knowledge fields, including direct event references', () => {
  for (const field of ['eventId', 'eventIds', 'event', 'sourceEvent', 'unexpected']) {
    const record = validImport() as unknown as { knowledge: Array<Record<string, unknown>> };
    record.knowledge[0][field] = 'event-1';

    assert.equal(validateImport(record as unknown as ExperienceImport).ok, false, field);
  }
});

test('does not revalidate disputed knowledge with evidence already attached', () => {
  const evidence = { ...contradictionEvidence(), polarity: 'confirms' as const, revalidatesTo: 'verified' as const };
  const result = applyTransition(disputedKnowledge(), evidence);

  assert.equal(result.entry.state, 'disputed');
  assert.equal(result.entry.evidenceIds.filter((id) => id === evidence.id).length, 1);
  assert.equal(result.history.length, 0);
});

test('returns immutable transition records without caller-owned mutation paths', () => {
  const entry = verifiedKnowledge();
  const evidence = contradictionEvidence();
  const history: TransitionHistoryEntry[] = [{ from: 'confirmed', to: 'verified', evidenceId: 'evidence-1' as Evidence['id'] }];
  const result = applyTransition(entry, evidence, history);

  (entry.evidenceIds as Evidence['id'][]).push('later-evidence' as Evidence['id']);
  (history[0] as { to: TransitionHistoryEntry['to'] }).to = 'disputed';

  assert.equal(Object.isFrozen(result.entry), true);
  assert.equal(Object.isFrozen(result.entry.evidenceIds), true);
  assert.equal(Object.isFrozen(result.history), true);
  assert.equal(Object.isFrozen(result.history[0]), true);
  assert.deepEqual(result.entry.evidenceIds, ['evidence-1', 'evidence-contradiction']);
  assert.equal(result.history[0].to, 'verified');
});

test('rejects encrypted and PGP PEM private-key headers', () => {
  for (const header of ['-----BEGIN ENCRYPTED PRIVATE KEY-----', '-----BEGIN PGP PRIVATE KEY BLOCK-----']) {
    const record = validImport();
    record.observations[0].statement = header;

    assert.equal(validateImport(record).ok, false, header);
  }
});
