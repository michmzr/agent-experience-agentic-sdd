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

test('incrementally appends a session and event idempotently by source-event identity', () => {
  const target = store();
  const input = { session: { id: 'session-1' as SessionId, source: 'codex' as const, startedAt: now }, event: event() };
  assert.equal(target.appendIncremental(input).inserted, true);
  assert.equal(target.appendIncremental(input).inserted, false);
  assert.equal(target.listCapturedEvents().length, 1);
  assert.throws(() => target.appendIncremental({ ...input, event: { ...event(), summary: 'Different result.' } }), /conflicting duplicate/i);
  target.close();
});

test('revalidates the normalized boundary before storing a structurally forged event', () => {
  const target = store();
  const forged = { ...event(), summary: 'Bearer: abcdefghijklmnopqrstuvwxyz' };
  assert.throws(() => target.appendIncremental({ session: { id: 'session-1' as SessionId, source: 'codex', startedAt: now }, event: forged }), /credential|canonical/i);
  assert.deepEqual(target.listCapturedEvents(), []);
  assert.throws(() => target.appendIncremental({
    session: { id: 'session-1' as SessionId, source: 'codex', startedAt: now },
    event: event(), rawTranscript: 'complete conversation'
  } as never), /unsupported incremental field/i);
  target.close();
});

test('failed capture creates observation, candidate, and evidence without durable knowledge', () => {
  const target = store();
  target.appendIncremental({
    session: { id: 'session-1' as SessionId, source: 'codex', startedAt: now }, event: event(),
    candidate: {
      observation: { id: 'observation-1', statement: 'Git push failed.' },
      cluster: { id: 'cluster-1' },
      candidate: { id: 'candidate-1', kind: 'failure', statement: 'Git push failed for the normalized action.' },
      evidence: { id: 'evidence-1', polarity: 'confirms', summary: 'The normalized action returned exit status 1.' }
    }
  });
  assert.deepEqual(target.listCandidates().map(({ id }) => id), ['candidate-1']);
  assert.deepEqual(target.listEvidence().map(({ id }) => id), ['evidence-1']);
  assert.deepEqual(target.listKnowledge(), []);
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
  assert.deepEqual(target.listTransitionHistory('knowledge-1').map(({ from, to, evidenceId }) => ({ from, to, evidenceId })), [
    { from: 'verified', to: 'disputed', evidenceId: 'contradiction-1' },
    { from: 'disputed', to: 'verified', evidenceId: 'revalidation-1' }
  ]);
  target.close();
});

test('rolls back the complete incremental append when any relationship is invalid', () => {
  const target = store();
  assert.throws(() => target.appendIncremental({
    session: { id: 'session-1' as SessionId, source: 'codex', startedAt: now }, event: event(),
    candidate: {
      observation: { id: 'observation-1', statement: 'Git push failed.' }, cluster: { id: 'cluster-1' },
      candidate: { id: 'candidate-1', kind: 'failure', statement: 'Git push failed.' },
      evidence: { id: 'evidence-1', candidateId: 'different-candidate', polarity: 'confirms', summary: 'Mismatch.' }
    }
  }), /candidate/i);
  assert.deepEqual(target.listCapturedEvents(), []);
  assert.deepEqual(target.listCandidates(), []);
  target.close();
});
