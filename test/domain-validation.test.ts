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

test('returns INVALID_SHAPE instead of throwing for a malformed entity', () => {
  const record = validImport() as unknown as { observations: unknown[] };
  record.observations[0] = { id: 'o' };

  assert.doesNotThrow(() => validateImport(record as unknown as ExperienceImport));
  const result = validateImport(record as unknown as ExperienceImport);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'INVALID_SHAPE');
});

test('rejects invalid and non-active evidence revalidation targets', () => {
  for (const revalidatesTo of ['candidate', 'superseded', 'invalid-state']) {
    const record = validImport();
    (record.evidence[0] as { revalidatesTo?: string }).revalidatesTo = revalidatesTo;

    assert.equal(validateImport(record).ok, false, revalidatesTo);
  }
});

test('rejects GitHub fine-grained personal access tokens', () => {
  const record = validImport();
  record.observations[0].statement = 'github_pat_abcdefghijklmnopqrstuvwxyz1234567890';

  assert.equal(validateImport(record).ok, false);
});

test('rejects cross-candidate contradiction evidence without changing knowledge', () => {
  const evidence: Evidence = {
    ...contradictionEvidence(),
    candidateId: 'candidate-other' as CandidateLessonId
  };
  const result = applyTransition(verifiedKnowledge(), evidence);

  assert.equal(result.entry.state, 'verified');
  assert.deepEqual(result.entry.evidenceIds, ['evidence-1']);
  assert.deepEqual(result.history, []);
});

test('records each explicit terminal transition through the canonical policy', () => {
  for (const target of ['superseded', 'rejected', 'expired'] as const) {
    const evidence: Evidence = {
      id: `evidence-${target}` as Evidence['id'],
      candidateId: 'candidate-1' as CandidateLessonId,
      polarity: 'contextualizes',
      summary: `Mark knowledge ${target}.`
    };
    const result = applyTransition(verifiedKnowledge(), evidence, [], target);

    assert.equal(result.entry.state, target);
    assert.equal(result.history.at(-1)?.to, target);
  }
});

test('rejects duplicate and empty identifiers before reference checks', () => {
  const duplicate = validImport();
  duplicate.events.push({ ...duplicate.events[0] });
  const empty = validImport();
  empty.events[0].id = '' as EventId;

  for (const record of [duplicate, empty]) {
    const result = validateImport(record);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'INVALID_SHAPE');
  }
});

test('rejects unsupported event outcomes', () => {
  const record = validImport();
  (record.events[0] as { outcome?: string }).outcome = 'partial';

  assert.equal(validateImport(record).ok, false);
});

test('does not allow an explicit target to override an active contradiction dispute', () => {
  const result = applyTransition(verifiedKnowledge(), contradictionEvidence(), [], 'expired');

  assert.equal(result.entry.state, 'verified');
  assert.deepEqual(result.entry.evidenceIds, ['evidence-1']);
  assert.deepEqual(result.history, []);
});

test('rejects contradictory evidence as disputed-state revalidation', () => {
  const evidence: Evidence = {
    ...contradictionEvidence(),
    id: 'evidence-revalidation-contradiction' as Evidence['id'],
    revalidatesTo: 'verified'
  };
  const record = validImport();
  (record.evidence[0] as { polarity: Evidence['polarity']; revalidatesTo?: Evidence['revalidatesTo'] }).polarity = 'contradicts';
  (record.evidence[0] as { revalidatesTo?: Evidence['revalidatesTo'] }).revalidatesTo = 'verified';
  const result = applyTransition(disputedKnowledge(), evidence);

  assert.equal(validateImport(record).ok, false);
  assert.equal(result.entry.state, 'disputed');
  assert.deepEqual(result.entry.evidenceIds, ['evidence-1', 'evidence-contradiction']);
  assert.deepEqual(result.history, []);
});
