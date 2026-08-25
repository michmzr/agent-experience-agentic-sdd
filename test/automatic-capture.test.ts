import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { adaptCodexCapture } from '../src/capture/adapters/codex.js';
import { createCaptureService } from '../src/capture/capture-service.js';
import { LEARNING_PROFILE } from '../src/config/runtime-profile.js';
import type { CandidateLessonId, Evidence, KnowledgeEntry, SessionId } from '../src/domain/types.js';
import type { GateDecision } from '../src/runtime/gate.js';
import { ExperienceStore } from '../src/storage/experience-store.js';

const now = '2026-08-25T10:00:00.000Z';
const learningDecision: GateDecision = {
  outcome: 'WARN', operationClass: 'protected', captureEnabled: LEARNING_PROFILE.captureEnabled, retrievalEnabled: true,
  explanations: [{ code: 'HARD_BLOCKING_DISABLED', message: 'Learning profile downgraded a block.', outcome: 'WARN', ruleId: 'rule-1', matchStrength: 'exact', authoritative: true, knowledgeState: 'verified' }],
  references: [{ ruleId: 'rule-1', knowledgeId: 'knowledge-1', evidenceIds: ['seed-evidence'] }],
  status: { health: 'healthy', profileId: 'learning', hardBlocking: false, retrievalMode: 'deterministic', fallbackSource: 'memory', circuitState: 'closed' },
  inputBinding: 'binding-1'
};

function seededStore(): ExperienceStore {
  const target = new ExperienceStore(join(mkdtempSync(join(tmpdir(), 'ael-auto-capture-')), 'experience.sqlite'));
  target.import({
    sessions: [{ id: 'seed-session' as SessionId, source: 'codex', startedAt: now }],
    events: [{ id: 'seed-event' as never, sessionId: 'seed-session' as SessionId, kind: 'test-result', occurredAt: now, outcome: 'passed' }],
    observations: [{ id: 'seed-observation' as never, eventIds: ['seed-event' as never], statement: 'Force push was prohibited.' }],
    clusters: [{ id: 'seed-cluster' as never, observationIds: ['seed-observation' as never] }],
    candidates: [{ id: 'candidate-1' as CandidateLessonId, clusterId: 'seed-cluster' as never, kind: 'convention', statement: 'Do not force push.' }],
    evidence: [{ id: 'seed-evidence' as Evidence['id'], candidateId: 'candidate-1' as CandidateLessonId, polarity: 'confirms', summary: 'Repository convention.' }],
    knowledge: [{ id: 'knowledge-1' as KnowledgeEntry['id'], candidateId: 'candidate-1' as CandidateLessonId, evidenceIds: ['seed-evidence' as Evidence['id']], state: 'verified', statement: 'Do not force push.' }]
  });
  return target;
}

function capture(eventId: string, kind: 'pre_action' | 'post_result', outcome?: 'succeeded' | 'failed' | 'unknown', relatedEventId = 'pre-1') {
  return adaptCodexCapture({ event_id: eventId, session_id: 'runtime-session', event_kind: kind, occurred_at: now, tool: 'git', action: 'push', arguments: ['--force'], cwd: '/work/repo', summary: outcome ? 'Reviewed force push succeeded.' : 'Attempt force push.', ...(kind === 'post_result' ? { outcome, exit_status: 0, related_event_id: relatedEventId } : {}) });
}

function capturedPhases(target: ExperienceStore): string[] {
  return target.listCapturedEventsPage().entries.map(({ phase }) => phase);
}

test('learning downgrade records both pre-action and post-result evidence', () => {
  const target = seededStore();
  const service = createCaptureService({ store: target, session: { id: 'runtime-session' as SessionId, source: 'codex', startedAt: now } });
  assert.equal(service.capture(capture('pre-1', 'pre_action'), learningDecision).status, 'captured');
  assert.equal(service.capture(capture('post-1', 'post_result', 'succeeded'), learningDecision).status, 'captured');
  assert.equal(service.capture(capture('post-1', 'post_result', 'succeeded'), learningDecision).status, 'duplicate');
  assert.deepEqual(capturedPhases(target), ['pre-action', 'post-result']);
  assert.equal(target.inspect('knowledge-1' as KnowledgeEntry['id'])?.state, 'disputed');
  assert.equal(target.inspect('knowledge-1' as KnowledgeEntry['id'])?.evidenceIds.length, 2);
  target.close();
});

test('repeated successful contradictions create a proposal without deleting or silently revalidating knowledge', () => {
  const target = seededStore();
  const service = createCaptureService({ store: target, session: { id: 'runtime-session' as SessionId, source: 'codex', startedAt: now } });
  service.capture(capture('pre-1', 'pre_action'), learningDecision);
  service.capture(capture('post-1', 'post_result', 'succeeded'), learningDecision);
  service.capture(capture('pre-2', 'pre_action'), learningDecision);
  service.capture(capture('post-2', 'post_result', 'succeeded', 'pre-2'), learningDecision);

  const knowledge = target.inspect('knowledge-1' as KnowledgeEntry['id']);
  assert.equal(knowledge?.state, 'disputed');
  assert.equal(knowledge?.evidenceIds.length, 3);
  assert.deepEqual(target.listRevalidationProposalsPage().entries.map(({ knowledgeId }) => knowledgeId), ['knowledge-1']);
  assert.equal(target.listTransitionHistoryPage('knowledge-1').entries.filter(({ to }) => to === 'verified').length, 0);
  target.close();
});

test('treats a successful audited override as contradiction evidence after continuation', () => {
  const target = seededStore();
  const service = createCaptureService({ store: target, session: { id: 'runtime-session' as SessionId, source: 'codex', startedAt: now } });
  const continued: GateDecision = {
    ...learningDecision,
    outcome: 'ALLOW',
    override: { overrideId: 'override-1', scope: 'rule', overriddenRuleIds: ['rule-1'] }
  };
  service.capture(capture('pre-override', 'pre_action'), continued);
  assert.equal(service.capture(capture('post-override', 'post_result', 'succeeded', 'pre-override'), continued).status, 'captured');
  assert.equal(target.inspect('knowledge-1' as KnowledgeEntry['id'])?.state, 'disputed');
  assert.equal(target.listEvidencePage().entries.find(({ id }) => id !== 'seed-evidence')?.polarity, 'contradicts');
  target.close();
});

test('captures contradiction only for enforcing or explicitly overridden rule references', () => {
  const target = seededStore();
  target.import({
    sessions: [{ id: 'context-session' as SessionId, source: 'codex', startedAt: now }],
    events: [{ id: 'context-event' as never, sessionId: 'context-session' as SessionId, kind: 'test-result', occurredAt: now, outcome: 'passed' }],
    observations: [{ id: 'context-observation' as never, eventIds: ['context-event' as never], statement: 'Context only.' }],
    clusters: [{ id: 'context-cluster' as never, observationIds: ['context-observation' as never] }],
    candidates: [{ id: 'context-candidate' as CandidateLessonId, clusterId: 'context-cluster' as never, kind: 'heuristic', statement: 'Context only.' }],
    evidence: [{ id: 'context-evidence' as Evidence['id'], candidateId: 'context-candidate' as CandidateLessonId, polarity: 'confirms', summary: 'Context.' }],
    knowledge: [{ id: 'context-knowledge' as KnowledgeEntry['id'], candidateId: 'context-candidate' as CandidateLessonId, evidenceIds: ['context-evidence' as Evidence['id']], state: 'observed', statement: 'Context only.' }]
  });
  const decision: GateDecision = {
    ...learningDecision,
    explanations: [...learningDecision.explanations, { code: 'CONTEXT_ONLY', message: 'Context.', outcome: 'ALLOW', ruleId: 'context-rule', matchStrength: 'metadata', authoritative: true, knowledgeState: 'observed' }],
    references: [...learningDecision.references, { ruleId: 'context-rule', knowledgeId: 'context-knowledge', evidenceIds: ['context-evidence'] }]
  };
  const service = createCaptureService({ store: target, session: { id: 'runtime-session' as SessionId, source: 'codex', startedAt: now } });
  service.capture(capture('pre-scope', 'pre_action'), decision);
  assert.deepEqual(target.loadCaptureEnforcementSnapshot('codex', 'pre-scope'), {
    inputBinding: 'binding-1',
    enforcingReferences: [{ ruleId: 'rule-1', knowledgeId: 'knowledge-1' }],
    overrideReferences: []
  });
  const fabricatedPostDecision = { ...decision, references: [decision.references[1]!] };
  service.capture(capture('post-scope', 'post_result', 'succeeded', 'pre-scope'), fabricatedPostDecision);
  assert.equal(target.inspect('knowledge-1' as KnowledgeEntry['id'])?.state, 'disputed');
  assert.deepEqual(target.inspect('context-knowledge' as KnowledgeEntry['id'])?.evidenceIds, ['context-evidence']);
  target.close();
});

test('rejects a post-result whose decision binding differs from the persisted pre-action snapshot', () => {
  const target = seededStore();
  const service = createCaptureService({ store: target, session: { id: 'runtime-session' as SessionId, source: 'codex', startedAt: now } });
  service.capture(capture('pre-stale', 'pre_action'), learningDecision);
  const result = service.capture(capture('post-stale', 'post_result', 'succeeded', 'pre-stale'), { ...learningDecision, inputBinding: 'different-binding' });
  assert.equal(result.status, 'degraded');
  assert.deepEqual(capturedPhases(target), ['pre-action']);
  assert.equal(target.inspect('knowledge-1' as KnowledgeEntry['id'])?.state, 'verified');
  target.close();
});

test('unknown post-result persists the event without lifecycle evidence or state changes', () => {
  const target = seededStore();
  const service = createCaptureService({ store: target, session: { id: 'runtime-session' as SessionId, source: 'codex', startedAt: now } });
  service.capture(capture('pre-unknown', 'pre_action'), learningDecision);
  assert.equal(service.capture(capture('post-unknown', 'post_result', 'unknown', 'pre-unknown'), learningDecision).status, 'captured');
  assert.equal(target.inspect('knowledge-1' as KnowledgeEntry['id'])?.state, 'verified');
  assert.deepEqual(target.inspect('knowledge-1' as KnowledgeEntry['id'])?.evidenceIds, ['seed-evidence']);
  assert.deepEqual(capturedPhases(target), ['pre-action', 'post-result']);
  target.close();
});

test('capture failure cannot change the synchronous gate outcome and returns a privacy-safe diagnostic', () => {
  const service = createCaptureService({
    store: { appendIncremental() { throw new Error('Bearer: super-secret-token-value'); } },
    session: { id: 'runtime-session' as SessionId, source: 'codex', startedAt: now }
  });
  const result = service.capture(capture('pre-1', 'pre_action'), learningDecision);
  assert.equal(result.status, 'degraded');
  assert.equal(result.decision, learningDecision);
  assert.deepEqual(result.diagnostic, { code: 'CAPTURE_PERSISTENCE_FAILED', phase: 'pre-action', retryable: true });
  assert.equal(JSON.stringify(result).includes('super-secret'), false);
});
