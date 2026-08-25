import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { adaptCodexCapture } from '../src/capture/adapters/codex.js';
import type { CandidateLessonId, Evidence, KnowledgeEntry, SessionId } from '../src/domain/types.js';
import { ExperienceStore } from '../src/storage/experience-store.js';

const now = '2026-08-25T10:00:00.000Z';

function store(): ExperienceStore {
  return new ExperienceStore(join(mkdtempSync(join(tmpdir(), 'ael-capture-')), 'experience.sqlite'));
}

function event(id = 'event-1') {
  return adaptCodexCapture({ event_id: id, session_id: 'session-1', event_kind: 'post_result', occurred_at: now, tool: 'git', action: 'push', arguments: ['main'], cwd: '/work/repo', summary: 'Git push failed.', outcome: 'failed', exit_status: 1, related_event_id: 'pre-1' });
}

function preEvent(id = 'pre-1', action = 'push', occurredAt = now) {
  return adaptCodexCapture({ event_id: id, session_id: 'session-1', event_kind: 'pre_action', occurred_at: occurredAt, tool: 'git', action, arguments: ['main'], cwd: '/work/repo', summary: `Run git ${action}.` });
}

test('incrementally appends a session and event idempotently by source-event identity', () => {
  const target = store();
  const input = { session: { id: 'session-1' as SessionId, source: 'codex' as const, startedAt: now }, event: preEvent() };
  assert.equal(target.appendIncremental(input).inserted, true);
  assert.equal(target.appendIncremental(input).inserted, false);
  assert.equal(target.listCapturedEventsPage().entries.length, 1);
  assert.throws(() => target.appendIncremental({ ...input, event: { ...preEvent(), summary: 'Different result.' } }), /conflicting duplicate/i);
  assert.equal(target.appendIncremental({ session: input.session }).inserted, false);
  target.close();
});

test('reports a new session-only append once and an identical retry as a no-op', () => {
  const target = store();
  const session = { id: 'session-only' as SessionId, source: 'cursor' as const, startedAt: now };
  assert.equal(target.appendIncremental({ session }).inserted, true);
  assert.equal(target.appendIncremental({ session }).inserted, false);
  target.close();
});

test('revalidates the normalized boundary before storing a structurally forged event', () => {
  const target = store();
  const forged = { ...event(), summary: 'Bearer: abcdefghijklmnopqrstuvwxyz' };
  assert.throws(() => target.appendIncremental({ session: { id: 'session-1' as SessionId, source: 'codex', startedAt: now }, event: forged }), /credential|canonical/i);
  assert.deepEqual(target.listCapturedEventsPage().entries, []);
  assert.throws(() => target.appendIncremental({
    session: { id: 'session-1' as SessionId, source: 'codex', startedAt: now },
    event: event(), rawTranscript: 'complete conversation'
  } as never), /unsupported incremental field/i);
  target.close();
});

test('failed capture creates observation, candidate, and evidence without durable knowledge', () => {
  const target = store();
  target.appendIncremental({ session: { id: 'session-1' as SessionId, source: 'codex', startedAt: now }, event: preEvent() });
  target.appendIncremental({
    event: event(),
    candidate: {
      observation: { id: 'observation-1', statement: 'Git push failed.' },
      cluster: { id: 'cluster-1' },
      candidate: { id: 'candidate-1', kind: 'failure', statement: 'Git push failed for the normalized action.' },
      evidence: { id: 'evidence-1', polarity: 'confirms', summary: 'The normalized action returned exit status 1.' }
    }
  });
  assert.deepEqual(target.listCandidatesPage().entries.map(({ id }) => id), ['candidate-1']);
  assert.deepEqual(target.listEvidencePage().entries.map(({ id }) => id), ['evidence-1']);
  assert.deepEqual(target.listKnowledge(), []);
  assert.doesNotThrow(() => target.expireUnprotected('2026-08-26T10:00:00.000Z'));
  assert.doesNotThrow(() => target.expireUnprotected('2026-08-27T10:00:00.000Z'));
  assert.equal(target.listCapturedEventsPage().entries.length, 2);
  target.close();
});

test('attaches contradiction evidence, disputes active knowledge, explicitly revalidates, and preserves history', () => {
  const target = store();
  target.import({
    sessions: [{ id: 'seed-session' as SessionId, source: 'codex', startedAt: now }],
    events: [{ id: 'seed-event' as never, sessionId: 'seed-session' as SessionId, kind: 'test-result', occurredAt: now, outcome: 'passed' }],
    observations: [{ id: 'seed-observation' as never, eventIds: ['seed-event' as never], statement: 'The rule was observed.' }],
    clusters: [{ id: 'seed-cluster' as never, observationIds: ['seed-observation' as never] }],
    candidates: [{ id: 'candidate-1' as CandidateLessonId, clusterId: 'seed-cluster' as never, kind: 'convention', statement: 'Do not force push.' }],
    evidence: [{ id: 'seed-evidence' as Evidence['id'], candidateId: 'candidate-1' as CandidateLessonId, polarity: 'confirms', summary: 'Repository convention.' }],
    knowledge: [{ id: 'knowledge-1' as KnowledgeEntry['id'], candidateId: 'candidate-1' as CandidateLessonId, evidenceIds: ['seed-evidence' as Evidence['id']], state: 'verified', statement: 'Do not force push.' }]
  });

  target.appendIncremental({ evidence: { id: 'contradiction-1', candidateId: 'candidate-1', polarity: 'contradicts', summary: 'A reviewed force push succeeded.' }, transition: { knowledgeId: 'knowledge-1', occurredAt: now } });
  assert.equal(target.inspect('knowledge-1' as KnowledgeEntry['id'])?.state, 'disputed');
  target.appendIncremental({ evidence: { id: 'revalidation-1', candidateId: 'candidate-1', polarity: 'confirms', summary: 'The convention was revalidated.', revalidatesTo: 'verified' }, transition: { knowledgeId: 'knowledge-1', occurredAt: '2026-08-25T11:00:00.000Z' } });

  assert.equal(target.inspect('knowledge-1' as KnowledgeEntry['id'])?.state, 'verified');
  assert.deepEqual(target.listTransitionHistoryPage('knowledge-1').entries.map(({ from, to, evidenceId }) => ({ from, to, evidenceId })), [
    { from: 'verified', to: 'disputed', evidenceId: 'contradiction-1' },
    { from: 'disputed', to: 'verified', evidenceId: 'revalidation-1' }
  ]);
  target.close();
});

test('rolls back the complete incremental append when any relationship is invalid', () => {
  const target = store();
  target.appendIncremental({ session: { id: 'session-1' as SessionId, source: 'codex', startedAt: now }, event: preEvent() });
  assert.throws(() => target.appendIncremental({
    event: event(),
    candidate: {
      observation: { id: 'observation-1', statement: 'Git push failed.' }, cluster: { id: 'cluster-1' },
      candidate: { id: 'candidate-1', kind: 'failure', statement: 'Git push failed.' },
      evidence: { id: 'evidence-1', candidateId: 'different-candidate', polarity: 'confirms', summary: 'Mismatch.' }
    }
  }), /candidate/i);
  assert.deepEqual(target.listCapturedEventsPage().entries.map(({ phase }) => phase), ['pre-action']);
  assert.deepEqual(target.listCandidatesPage().entries, []);
  target.close();
});

test('rejects unlinked and mismatched post-results atomically', () => {
  const target = store();
  const session = { id: 'session-1' as SessionId, source: 'codex' as const, startedAt: now };
  assert.throws(() => target.appendIncremental({ session, event: event() }), /related pre-action/i);
  target.appendIncremental({ session, event: preEvent('pre-1', 'status') });
  assert.throws(() => target.appendIncremental({ event: event() }), /signature/i);
  target.appendIncremental({ event: preEvent('pre-late', 'push', '2026-08-25T11:00:00.000Z') });
  assert.throws(() => target.appendIncremental({ event: { ...event('post-early'), relatedEventId: 'pre-late' } }), /cannot precede/i);
  assert.deepEqual(target.listCapturedEventsPage().entries.map(({ phase }) => phase), ['pre-action', 'pre-action']);
  target.close();
});

test('rolls back evidence when an explicit transition target is not reached exactly', () => {
  const target = store();
  // Seed candidate knowledge, then request an invalid verified jump from candidate.
  target.import({
    sessions: [{ id: 'seed-session' as SessionId, source: 'codex', startedAt: now }],
    events: [{ id: 'seed-event' as never, sessionId: 'seed-session' as SessionId, kind: 'test-result', occurredAt: now, outcome: 'passed' }],
    observations: [{ id: 'seed-observation' as never, eventIds: ['seed-event' as never], statement: 'Observed.' }],
    clusters: [{ id: 'seed-cluster' as never, observationIds: ['seed-observation' as never] }],
    candidates: [{ id: 'candidate-jump' as CandidateLessonId, clusterId: 'seed-cluster' as never, kind: 'convention', statement: 'Convention.' }],
    evidence: [{ id: 'seed-evidence' as Evidence['id'], candidateId: 'candidate-jump' as CandidateLessonId, polarity: 'confirms', summary: 'Seed.' }],
    knowledge: [{ id: 'knowledge-jump' as KnowledgeEntry['id'], candidateId: 'candidate-jump' as CandidateLessonId, evidenceIds: ['seed-evidence' as Evidence['id']], state: 'candidate', statement: 'Convention.' }]
  });
  assert.throws(() => target.appendIncremental({
    evidence: { id: 'jump-evidence', candidateId: 'candidate-jump', polarity: 'confirms', summary: 'One confirmation.' },
    transition: { knowledgeId: 'knowledge-jump', occurredAt: now, target: 'verified' }
  }), /exact target/i);
  assert.deepEqual(target.inspect('knowledge-jump' as KnowledgeEntry['id'])?.evidenceIds, ['seed-evidence']);
  assert.equal(target.listEvidencePage().entries.some(({ id }) => id === 'jump-evidence'), false);
  target.close();
});

test('rejects an explicit target when knowledge is already in that state and no transition occurs', () => {
  const target = store();
  target.import({
    sessions: [{ id: 'seed-session' as SessionId, source: 'codex', startedAt: now }],
    events: [{ id: 'seed-event' as never, sessionId: 'seed-session' as SessionId, kind: 'test-result', occurredAt: now, outcome: 'passed' }],
    observations: [{ id: 'seed-observation' as never, eventIds: ['seed-event' as never], statement: 'Verified.' }],
    clusters: [{ id: 'seed-cluster' as never, observationIds: ['seed-observation' as never] }],
    candidates: [{ id: 'candidate-same' as CandidateLessonId, clusterId: 'seed-cluster' as never, kind: 'convention', statement: 'Convention.' }],
    evidence: [{ id: 'seed-evidence' as Evidence['id'], candidateId: 'candidate-same' as CandidateLessonId, polarity: 'confirms', summary: 'Seed.' }],
    knowledge: [{ id: 'knowledge-same' as KnowledgeEntry['id'], candidateId: 'candidate-same' as CandidateLessonId, evidenceIds: ['seed-evidence' as Evidence['id']], state: 'verified', statement: 'Convention.' }]
  });
  assert.throws(() => target.appendIncremental({
    evidence: { id: 'same-evidence', candidateId: 'candidate-same', polarity: 'confirms', summary: 'More evidence.' },
    transition: { knowledgeId: 'knowledge-same', occurredAt: now, target: 'verified' }
  }), /exact target/i);
  assert.equal(target.listEvidencePage().entries.some(({ id }) => id === 'same-evidence'), false);
  target.close();
});

test('rejects malformed incremental identifiers, timestamps, private fields, and resource excess', () => {
  const target = store();
  for (const session of [
    { id: '../session' as SessionId, source: 'codex' as const, startedAt: now },
    { id: 'session-1' as SessionId, source: 'codex' as const, startedAt: '2026-08-25 10:00:00Z' },
    { id: 'session-1' as SessionId, source: 'codex' as const, startedAt: now, userId: 'ghp_abcdefghijklmnopqrstuvwxyz123456' as never }
  ]) assert.throws(() => target.appendIncremental({ session }), /invalid|canonical|private|credential/i);
  assert.throws(() => adaptCodexCapture({ event_id: 'event-1', session_id: 'session-1', event_kind: 'pre_action', occurred_at: now, tool: 'git', action: 'push', arguments: ['main\nrm -rf repo'], summary: 'Run.' }), /argument/i);
  assert.deepEqual(target.listCapturedEventsPage().entries, []);
  target.close();
});

test('rejects an event before its session start and rolls back the new session', () => {
  const target = store();
  const session = { id: 'session-1' as SessionId, source: 'codex' as const, startedAt: now };
  const early = preEvent('pre-early', 'push', '2026-08-25T09:59:59.999Z');
  assert.throws(() => target.appendIncremental({ session, event: early }), /session start/i);
  assert.deepEqual(target.listCapturedEventsPage().entries, []);
  assert.equal(target.appendIncremental({ session }).inserted, true);
  target.close();
});

test('rejects transitions before knowledge creation and before the latest persisted transition after reopen', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'ael-causal-')), 'experience.sqlite');
  const target = new ExperienceStore(databasePath);
  target.import({
    sessions: [{ id: 'seed-session' as SessionId, source: 'codex', startedAt: now }],
    events: [{ id: 'seed-event' as never, sessionId: 'seed-session' as SessionId, kind: 'test-result', occurredAt: now, outcome: 'passed' }],
    observations: [{ id: 'seed-observation' as never, eventIds: ['seed-event' as never], statement: 'Verified.' }],
    clusters: [{ id: 'seed-cluster' as never, observationIds: ['seed-observation' as never] }],
    candidates: [{ id: 'candidate-causal' as CandidateLessonId, clusterId: 'seed-cluster' as never, kind: 'convention', statement: 'Convention.' }],
    evidence: [{ id: 'seed-evidence' as Evidence['id'], candidateId: 'candidate-causal' as CandidateLessonId, polarity: 'confirms', summary: 'Seed.' }],
    knowledge: [{ id: 'knowledge-causal' as KnowledgeEntry['id'], candidateId: 'candidate-causal' as CandidateLessonId, evidenceIds: ['seed-evidence' as Evidence['id']], state: 'verified', statement: 'Convention.' }]
  });
  assert.throws(() => target.appendIncremental({
    evidence: { id: 'before-creation', candidateId: 'candidate-causal', polarity: 'contradicts', summary: 'Too early.' },
    transition: { knowledgeId: 'knowledge-causal', occurredAt: '2026-08-25T09:59:59.999Z' }
  }), /knowledge creation/i);
  target.appendIncremental({
    evidence: { id: 'dispute-evidence', candidateId: 'candidate-causal', polarity: 'contradicts', summary: 'Dispute.' },
    transition: { knowledgeId: 'knowledge-causal', occurredAt: '2026-08-25T11:00:00.000Z' }
  });
  const runtimeSession = { id: 'session-1' as SessionId, source: 'codex' as const, startedAt: now };
  target.appendIncremental({ session: runtimeSession, event: preEvent('pre-causal', 'push', '2026-08-25T12:00:00.000Z') });
  const post = adaptCodexCapture({
    event_id: 'post-causal', session_id: 'session-1', event_kind: 'post_result', occurred_at: '2026-08-25T13:00:00.000Z',
    tool: 'git', action: 'push', arguments: ['main'], cwd: '/work/repo', summary: 'Push succeeded.',
    outcome: 'succeeded', exit_status: 0, related_event_id: 'pre-causal'
  });
  assert.throws(() => target.appendIncremental({
    event: post,
    evidenceUpdates: [{
      evidence: { id: 'pre-result-evidence', candidateId: 'candidate-causal', polarity: 'contradicts', summary: 'Impossible ordering.' },
      transition: { knowledgeId: 'knowledge-causal', occurredAt: '2026-08-25T12:59:59.999Z' }
    }]
  }), /event.*transition|transition.*event/i);
  assert.equal(target.listCapturedEventsPage().entries.some(({ sourceEventId }) => sourceEventId === 'post-causal'), false);
  target.close();

  const reopened = new ExperienceStore(databasePath);
  assert.throws(() => reopened.appendIncremental({
    evidence: { id: 'early-revalidation', candidateId: 'candidate-causal', polarity: 'confirms', summary: 'Early.', revalidatesTo: 'verified' },
    transition: { knowledgeId: 'knowledge-causal', occurredAt: '2026-08-25T10:59:59.999Z' }
  }), /latest transition/i);
  assert.equal(reopened.inspect('knowledge-causal' as KnowledgeEntry['id'])?.state, 'disputed');
  assert.equal(reopened.listEvidencePage().entries.some(({ id }) => id === 'early-revalidation'), false);

  reopened.appendIncremental({
    evidence: { id: 'equal-revalidation', candidateId: 'candidate-causal', polarity: 'confirms', summary: 'Equal timestamp.', revalidatesTo: 'verified' },
    transition: { knowledgeId: 'knowledge-causal', occurredAt: '2026-08-25T11:00:00.000Z' }
  });
  assert.equal(reopened.inspect('knowledge-causal' as KnowledgeEntry['id'])?.state, 'verified');
  assert.deepEqual(reopened.listTransitionHistoryPage('knowledge-causal').entries.map(({ occurredAt }) => occurredAt), [
    '2026-08-25T11:00:00.000Z', '2026-08-25T11:00:00.000Z'
  ]);
  reopened.close();
});

test('paginates every incremental capture collection with bounded stable cursors', () => {
  const target = store();
  const session = { id: 'session-1' as SessionId, source: 'codex' as const, startedAt: now };
  for (let index = 0; index < 5; index += 1) target.appendIncremental({ session, event: preEvent(`pre-${index}`) });
  const first = target.listCapturedEventsPage({ limit: 2 });
  target.appendIncremental({ session, event: preEvent('pre-later') });
  const second = target.listCapturedEventsPage({ limit: 2, cursor: first.nextCursor });
  const third = target.listCapturedEventsPage({ limit: 2, cursor: second.nextCursor });
  assert.deepEqual([...first.entries, ...second.entries, ...third.entries].map(({ sourceEventId }) => sourceEventId), ['pre-0', 'pre-1', 'pre-2', 'pre-3', 'pre-4']);
  assert.throws(() => target.listCapturedEventsPage({ limit: 101 }), /page size/i);
  assert.throws(() => target.listCandidatesPage({ limit: 101 }), /page size/i);
  assert.throws(() => target.listEvidencePage({ limit: 101 }), /page size/i);
  assert.throws(() => target.listTransitionHistoryPage('knowledge-1', { limit: 101 }), /page size/i);
  assert.throws(() => target.listRevalidationProposalsPage({ limit: 101 }), /page size/i);
  assert.throws(() => target.listCapturedEventsPage({ limit: 1, unexpected: true } as never), /page request field/i);
  assert.throws(() => target.listCapturedEventsPage({ cursor: { afterSequence: 3, highWaterSequence: 2 } }), /cursor/i);
  assert.equal('listCapturedEvents' in target, false);
  target.close();
});
