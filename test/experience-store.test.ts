import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import type { ExperienceImport, EventId, KnowledgeEntry } from '../src/domain/types.js';
import type { SessionId } from '../src/domain/types.js';
import { normalizeMappedCapture } from '../src/capture/normalization.js';
import { persistPassiveCapture } from '../src/capture/passive-service.js';
import { ExperienceStore, ExperienceStoreInitializationError } from '../src/storage/experience-store.js';

function validImport(): ExperienceImport {
  return {
    sessions: [{ id: 'session-1' as ExperienceImport['sessions'][number]['id'], source: 'codex', startedAt: '2026-08-24T10:00:00.000Z' }],
    events: [{ id: 'event-1' as EventId, sessionId: 'session-1' as ExperienceImport['sessions'][number]['id'], kind: 'test-result', occurredAt: '2026-08-24T10:01:00.000Z', outcome: 'passed' }],
    observations: [{ id: 'observation-1' as ExperienceImport['observations'][number]['id'], eventIds: ['event-1' as EventId], statement: 'The focused test passed.' }],
    clusters: [{ id: 'cluster-1' as ExperienceImport['clusters'][number]['id'], observationIds: ['observation-1' as ExperienceImport['observations'][number]['id']] }],
    candidates: [{ id: 'candidate-1' as ExperienceImport['candidates'][number]['id'], clusterId: 'cluster-1' as ExperienceImport['clusters'][number]['id'], kind: 'successful-workflow', statement: 'Run focused tests before a full check.' }],
    evidence: [{ id: 'evidence-1' as ExperienceImport['evidence'][number]['id'], candidateId: 'candidate-1' as ExperienceImport['candidates'][number]['id'], polarity: 'confirms', summary: 'Focused test passed.' }],
    knowledge: [{ id: 'knowledge-1' as KnowledgeEntry['id'], candidateId: 'candidate-1' as ExperienceImport['candidates'][number]['id'], evidenceIds: ['evidence-1' as ExperienceImport['evidence'][number]['id']], state: 'verified', statement: 'Run focused tests before a full check.' }]
  };
}

test('persists a valid import and reopens it for knowledge inspection', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'ael-store-')), 'experience.sqlite');
  const record = validImport();
  const store = new ExperienceStore(databasePath);

  store.import(record);
  store.close();

  const reopened = new ExperienceStore(databasePath);
  assert.deepEqual(reopened.inspect('knowledge-1' as KnowledgeEntry['id']), record.knowledge[0]);
  assert.deepEqual(reopened.listKnowledge(), record.knowledge);
  reopened.close();
});

test('creates a local SQLite database file with owner-only permissions', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'ael-store-')), 'experience.sqlite');
  const store = new ExperienceStore(databasePath);

  assert.equal(statSync(databasePath).mode & 0o777, 0o600);
  store.close();
});

test('wraps migration schema failures in a typed initialization error', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'ael-store-malformed-migration-')), 'experience.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE schema_migrations (unexpected INTEGER)');
  database.close();

  assert.throws(
    () => new ExperienceStore(databasePath),
    (error: unknown) => error instanceof ExperienceStoreInitializationError && error.stage === 'migration'
  );
});

test('wraps database open failures in a typed initialization error', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'ael-store-open-failure-')), 'experience.sqlite');
  mkdirSync(databasePath);

  assert.throws(
    () => new ExperienceStore(databasePath),
    (error: unknown) => error instanceof ExperienceStoreInitializationError && error.stage === 'open'
  );
});

test('rejects an invalid import before it can mutate stored knowledge', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'ael-store-')), 'experience.sqlite');
  const record = validImport();
  record.observations[0].eventIds = ['event-missing' as EventId];
  const store = new ExperienceStore(databasePath);

  assert.throws(() => store.import(record), /Event references a missing session|Observation references a missing event/);
  assert.deepEqual(store.listKnowledge(), []);
  store.close();
});

test('preserves one Codex conversation across an ended run and a resume', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'ael-store-runs-')), 'experience.sqlite');
  const store = new ExperienceStore(databasePath);
  const startup = '2026-09-12T08:00:00.000Z';
  const firstEnd = '2026-09-12T08:01:00.000Z';
  const resume = '2026-09-12T08:02:00.000Z';
  const secondEnd = '2026-09-12T08:03:00.000Z';

  store.appendIncremental({ session: { id: 'conversation-1' as SessionId, source: 'codex', startedAt: startup } });

  store.recordLifecycleSignal({
    sourceEventId: 'conversation-1:startup', source: 'codex', conversationId: 'conversation-1',
    kind: 'start', startOrigin: 'startup', receiptAt: startup, sourceAt: '2026-09-12T07:59:59.000Z'
  });
  store.recordLifecycleSignal({
    sourceEventId: 'conversation-1:first-end', source: 'codex', conversationId: 'conversation-1', kind: 'end', receiptAt: firstEnd
  });
  store.recordLifecycleSignal({
    sourceEventId: 'conversation-1:resume', source: 'codex', conversationId: 'conversation-1', kind: 'start', startOrigin: 'resume', receiptAt: resume
  });
  const pre = normalizeMappedCapture({
    source: 'codex', sourceEventId: 'later-tool:pre', sessionId: 'conversation-1' as SessionId,
    phase: 'pre-action', occurredAt: '2026-09-12T08:02:01.000Z', tool: 'shell', action: 'test', summary: 'Run a focused test.'
  });
  const post = normalizeMappedCapture({
    source: 'codex', sourceEventId: 'later-tool:post', sessionId: 'conversation-1' as SessionId,
    phase: 'post-result', occurredAt: '2026-09-12T08:02:02.000Z', tool: 'shell', action: 'test', summary: 'Focused test passed.',
    outcome: 'succeeded', exitStatus: 0, relatedEventId: 'later-tool:pre'
  });
  store.appendIncremental({ event: pre });
  store.appendIncremental({ event: post });
  store.recordLifecycleSignal({
    sourceEventId: 'conversation-1:second-end', source: 'codex', conversationId: 'conversation-1', kind: 'end', receiptAt: secondEnd
  });

  assert.deepEqual(store.loadConversation('conversation-1'), {
    id: 'conversation-1', source: 'codex', firstReceiptAt: startup, identifierProvenance: 'hook-session-id'
  });
  assert.deepEqual(store.listConversationRuns('conversation-1'), [
    {
      id: 'conversation-1:run:1', conversationId: 'conversation-1', origin: 'startup', state: 'ended',
      receiptStartedAt: startup, sourceStartedAt: '2026-09-12T07:59:59.000Z', receiptEndedAt: firstEnd
    },
    {
      id: 'conversation-1:run:2', conversationId: 'conversation-1', origin: 'resume', state: 'ended',
      receiptStartedAt: resume, receiptEndedAt: secondEnd
    }
  ]);
  assert.deepEqual(store.loadCapturedSession('conversation-1' as SessionId)?.events.map(({ sourceEventId }) => sourceEventId), ['later-tool:pre', 'later-tool:post']);
  store.close();
});

test('makes exact lifecycle duplicates idempotent and leaves ambiguous signals unresolved', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'ael-store-run-duplicates-')), 'experience.sqlite');
  const store = new ExperienceStore(databasePath);
  const start = { sourceEventId: 'conversation-1:startup', source: 'codex' as const, conversationId: 'conversation-1', kind: 'start' as const, startOrigin: 'startup' as const, receiptAt: '2026-09-12T08:00:00.000Z' };

  assert.equal(store.recordLifecycleSignal(start).inserted, true);
  assert.equal(store.recordLifecycleSignal(start).inserted, false);
  assert.equal(store.recordLifecycleSignal({ ...start, sourceEventId: 'conversation-1:resume', receiptAt: '2026-09-12T08:01:00.000Z' }).inserted, true);
  assert.deepEqual(store.listLifecycleSignals('conversation-1').map(({ sourceEventId, resolution }) => ({ sourceEventId, resolution })), [
    { sourceEventId: 'conversation-1:startup', resolution: 'resolved' },
    { sourceEventId: 'conversation-1:resume', resolution: 'unresolved' }
  ]);
  assert.equal(store.listConversationRuns('conversation-1').length, 1);
  store.close();
});

test('does not fabricate conversation identity for legacy session rows', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'ael-store-legacy-session-')), 'experience.sqlite');
  const store = new ExperienceStore(databasePath);
  const legacyEnd = '2026-09-12T08:01:00.000Z';
  store.import({ ...validImport(), sessions: [{
    id: 'legacy-session' as SessionId, source: 'codex', startedAt: '2026-09-12T08:00:00.000Z', endedAt: legacyEnd
  }], events: [{
    id: 'event-1' as EventId, sessionId: 'legacy-session' as SessionId, kind: 'test-result', occurredAt: legacyEnd, outcome: 'passed'
  }] });

  assert.equal(store.loadSession('legacy-session' as SessionId)?.endedAt, legacyEnd);
  assert.equal(store.conversationForLegacySession('legacy-session' as SessionId), undefined);
  store.close();
});

test('keeps the v1 session closed while storing resumed technical activity in the v2 run', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'ael-store-immutable-resume-')), 'experience.sqlite');
  const store = new ExperienceStore(databasePath);
  const sessionId = 'conversation-immutable' as SessionId;
  const startedAt = '2026-09-12T08:00:00.000Z';
  const endedAt = '2026-09-12T08:01:00.000Z';
  const resumedAt = '2026-09-12T08:02:00.000Z';
  const lifecycle = (sourceEventId: string, kind: 'start' | 'end', receiptAt: string, startOrigin?: 'startup' | 'resume') => ({ sourceEventId, source: 'codex' as const, conversationId: sessionId, kind, receiptAt, ...(startOrigin === undefined ? {} : { startOrigin }) });

  persistPassiveCapture(store, { kind: 'session-start', session: { id: sessionId, source: 'codex', startedAt }, lifecycle: lifecycle('immutable:startup', 'start', startedAt, 'startup') });
  persistPassiveCapture(store, { kind: 'session-end', source: 'codex', sessionId, endedAt, lifecycle: lifecycle('immutable:end', 'end', endedAt) });
  persistPassiveCapture(store, { kind: 'session-start', session: { id: sessionId, source: 'codex', startedAt: resumedAt }, lifecycle: lifecycle('immutable:resume', 'start', resumedAt, 'resume') });

  const pre = normalizeMappedCapture({ source: 'codex', sourceEventId: 'immutable-tool:pre', sessionId, phase: 'pre-action', occurredAt: '2026-09-12T08:02:01.000Z', tool: 'shell', action: 'test', summary: 'Run a focused test.' });
  const post = normalizeMappedCapture({ source: 'codex', sourceEventId: 'immutable-tool:post', sessionId, phase: 'post-result', occurredAt: '2026-09-12T08:02:02.000Z', tool: 'shell', action: 'test', summary: 'Focused test passed.', outcome: 'succeeded', exitStatus: 0, relatedEventId: 'immutable-tool:pre' });
  persistPassiveCapture(store, { kind: 'technical', event: pre });
  persistPassiveCapture(store, { kind: 'technical', event: post });

  assert.equal(store.loadSession(sessionId)?.endedAt, endedAt);
  assert.deepEqual(store.listConversationTechnicalEvents(sessionId).map(({ sourceEventId }) => sourceEventId), ['immutable-tool:pre', 'immutable-tool:post']);
  assert.equal(store.loadCapturedSession(sessionId)?.events.length, 0);
  store.close();
});

test('rejects technical capture after an unresolved end on a startup-origin run', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'ael-store-unresolved-run-')), 'experience.sqlite');
  const store = new ExperienceStore(databasePath);
  const sessionId = 'conversation-unresolved' as SessionId;
  store.appendIncremental({ session: { id: sessionId, source: 'codex', startedAt: '2026-09-12T08:00:00.000Z' } });
  store.recordLifecycleSignal({ sourceEventId: 'unresolved:startup', source: 'codex', conversationId: sessionId, kind: 'start', startOrigin: 'startup', receiptAt: '2026-09-12T08:00:00.000Z', sourceAt: '2026-09-12T08:00:00.000Z' });
  store.recordLifecycleSignal({ sourceEventId: 'unresolved:end', source: 'codex', conversationId: sessionId, kind: 'end', receiptAt: '2026-09-12T08:01:00.000Z', sourceAt: '2026-09-12T07:59:59.000Z' });
  store.endSession('codex', sessionId, '2026-09-12T08:01:00.000Z');
  const event = normalizeMappedCapture({ source: 'codex', sourceEventId: 'unresolved-tool:pre', sessionId, phase: 'pre-action', occurredAt: '2026-09-12T08:02:00.000Z', tool: 'shell', action: 'test', summary: 'Run a focused test.' });

  assert.throws(() => store.appendLifecycleTechnical(event), /resume run/i);
  assert.deepEqual(store.listConversationTechnicalEvents(sessionId), []);
  store.close();
});

test('accepts a resumed end after the v1 session is already closed', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'ael-store-resume-end-')), 'experience.sqlite');
  const store = new ExperienceStore(databasePath);
  const sessionId = 'conversation-resume-end' as SessionId;
  const startup = '2026-09-12T08:00:00.000Z';
  const firstEnd = '2026-09-12T08:01:00.000Z';
  store.applyLifecycle({ lifecycle: { sourceEventId: 'opaque-1', source: 'codex', conversationId: sessionId, kind: 'start', startOrigin: 'startup', receiptAt: startup }, session: { id: sessionId, source: 'codex', startedAt: startup } });
  store.applyLifecycle({ lifecycle: { sourceEventId: 'opaque-2', source: 'codex', conversationId: sessionId, kind: 'end', receiptAt: firstEnd }, end: { source: 'codex', sessionId, endedAt: firstEnd } });
  store.applyLifecycle({ lifecycle: { sourceEventId: 'opaque-3', source: 'codex', conversationId: sessionId, kind: 'start', startOrigin: 'resume', receiptAt: '2026-09-12T08:02:00.000Z' } });

  assert.equal(store.applyLifecycle({ lifecycle: { sourceEventId: 'opaque-4', source: 'codex', conversationId: sessionId, kind: 'end', receiptAt: '2026-09-12T08:03:00.000Z' }, end: { source: 'codex', sessionId, endedAt: '2026-09-12T08:03:00.000Z' } }).inserted, true);
  assert.equal(store.loadSession(sessionId)?.endedAt, firstEnd);
  assert.equal(store.listConversationRuns(sessionId)[1]?.state, 'ended');
  store.close();
});

test('uses lifecycle start origin rather than source-event text and rolls back a failing v1 start', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'ael-store-lifecycle-atomic-')), 'experience.sqlite');
  const store = new ExperienceStore(databasePath);
  const sessionId = 'conversation-atomic' as SessionId;
  const lifecycle = { sourceEventId: 'opaque-event-9', source: 'codex' as const, conversationId: sessionId, kind: 'start' as const, startOrigin: 'startup' as const, receiptAt: '2026-09-12T08:00:00.000Z' };

  assert.throws(() => store.applyLifecycle({ lifecycle, session: { id: sessionId, source: 'codex', startedAt: lifecycle.receiptAt, endedAt: '2026-09-12T08:01:00.000Z' } }), /start open|new sessions/i);
  assert.equal(store.loadConversation(sessionId), undefined);
  assert.equal(store.applyLifecycle({ lifecycle, session: { id: sessionId, source: 'codex', startedAt: lifecycle.receiptAt } }).inserted, true);
  assert.equal(store.loadSession(sessionId)?.startedAt, lifecycle.receiptAt);
  store.close();
});
