import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { normalizeMappedCapture } from '../src/capture/normalization.js';
import type { RepositoryId, SessionId } from '../src/domain/types.js';
import { OperationalLearningService } from '../src/learning/service.js';
import { OperationalLearningRepository } from '../src/learning/repository.js';
import { reconstructSessionEvidence } from '../src/evidence/reconstructor.js';
import type { EvidenceObservation } from '../src/evidence/contracts.js';
import { sourceEvidenceCapabilities } from '../src/evidence/capabilities.js';
import { projectCapturedSessionEvidence } from '../src/evidence/capture-projection.js';
import { detectOperationalEpisodes } from '../src/learning/detectors.js';
import { ExperienceStore } from '../src/storage/experience-store.js';

test('AEC-A2 resumed technical events enter the logical reader exactly once', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'aec-continuity-')), 'store.sqlite');
  const store = new ExperienceStore(path);
  const sessionId = 'aec-conversation' as SessionId;
  const repositoryId = 'aec-repository' as RepositoryId;
  const at = '2026-09-29T10:00:00.000Z';
  store.registerRepository({ id: repositoryId, root: '/tmp/aec-repository', observedAt: at });
  store.appendIncremental({ session: { id: sessionId, source: 'codex', startedAt: at, repositoryId } });
  store.recordLifecycleSignal({ source: 'codex', sourceEventId: 'aec-start', conversationId: sessionId, kind: 'start', startOrigin: 'startup', receiptAt: at });
  store.recordLifecycleSignal({ source: 'codex', sourceEventId: 'aec-end', conversationId: sessionId, kind: 'end', receiptAt: '2026-09-29T10:01:00.000Z' });
  store.endSession('codex', sessionId, '2026-09-29T10:01:00.000Z');
  store.recordLifecycleSignal({ source: 'codex', sourceEventId: 'aec-resume', conversationId: sessionId, kind: 'start', startOrigin: 'resume', receiptAt: '2026-09-29T10:02:00.000Z' });
  const event = normalizeMappedCapture({ source: 'codex', sourceEventId: 'aec-tool', sessionId, phase: 'pre-action', occurredAt: '2026-09-29T10:02:01.000Z', tool: 'shell', action: 'test', summary: 'Test.' });
  const result = normalizeMappedCapture({ source: 'codex', sourceEventId: 'aec-result', sessionId, phase: 'post-result', occurredAt: '2026-09-29T10:02:02.000Z', tool: 'shell', action: 'test', summary: 'Result.', outcome: 'unknown', relatedEventId: 'aec-tool' });
  assert.equal(store.appendLifecycleTechnical(event).inserted, true);
  assert.equal(store.appendLifecycleTechnical(result).inserted, true);
  assert.equal(store.appendLifecycleTechnical(event).inserted, false);
  assert.deepEqual(store.loadLogicalEvidencePage(sessionId, { after: 0, through: store.logicalEvidenceHighWater(sessionId), limit: 10 }).events.map(({ sourceEventId }) => sourceEventId), ['aec-tool', 'aec-result']);
  assert.deepEqual(store.listRepositoryRecords(repositoryId)[0]?.events.map(({ sourceEventId }) => sourceEventId), ['aec-tool', 'aec-result']);
  assert.equal(store.repositoryQuality(repositoryId).operations, 1);
  assert.equal(store.repositoryQuality(repositoryId).linked, 1);
  store.close();
  assert.equal(new OperationalLearningService(path).enqueueCommittedSession(repositoryId, sessionId), true);
  const learning = new OperationalLearningRepository(path);
  assert.equal(learning.stream(repositoryId, sessionId)?.committedHighWater, 2);
  learning.close();
});

test('AEC-A1 Codex process exit remains unqualified without observed host envelopes', () => {
  assert.equal(sourceEvidenceCapabilities.codex.processExit, 'unqualified');
});

test('AEC-A3 fixed watermark pages exclude late appended evidence', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'aec-pages-')), 'store.sqlite');
  const store = new ExperienceStore(path);
  const sessionId = 'aec-pages' as SessionId;
  store.appendIncremental({ session: { id: sessionId, source: 'codex', startedAt: '2026-09-29T10:00:00.000Z' } });
  const append = (ordinal: number) => store.appendIncremental({ event: normalizeMappedCapture({
    source: 'codex', sourceEventId: `event-${ordinal}`, sessionId, phase: 'pre-action',
    occurredAt: `2026-09-29T10:00:0${ordinal}.000Z`, tool: 'shell', action: 'test', summary: 'Test.'
  }) });
  append(1);
  append(2);
  const watermark = store.logicalEvidenceHighWater(sessionId);
  const first = store.loadLogicalEvidencePage(sessionId, { after: 0, through: watermark, limit: 1 });
  append(3);
  const second = store.loadLogicalEvidencePage(sessionId, { after: first.nextCursor, through: watermark, limit: 1 });
  const exhausted = store.loadLogicalEvidencePage(sessionId, { after: second.nextCursor, through: watermark, limit: 1 });
  assert.deepEqual([...first.events, ...second.events].map(({ sourceEventId }) => sourceEventId), ['event-1', 'event-2']);
  assert.equal(exhausted.events.length, 0);
  assert.deepEqual(store.loadLogicalEvidencePage(sessionId, { after: watermark, through: store.logicalEvidenceHighWater(sessionId), limit: 1 }).events.map(({ sourceEventId }) => sourceEventId), ['event-3']);
  assert.throws(() => store.loadLogicalEvidencePage(sessionId, { after: 0, through: watermark, limit: 1025 }), RangeError);
  store.close();
});

test('AEC-A6 legacy backfill survives restart without changing source rows', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'aec-migration-')), 'store.sqlite');
  const sessionId = 'aec-legacy' as SessionId;
  const store = new ExperienceStore(path);
  store.appendIncremental({ session: { id: sessionId, source: 'codex', startedAt: '2026-09-29T10:00:00.000Z' } });
  const event = normalizeMappedCapture({ source: 'codex', sourceEventId: 'aec-legacy-event', sessionId,
    phase: 'pre-action', occurredAt: '2026-09-29T10:00:01.000Z', tool: 'shell', action: 'test', summary: 'Test.' });
  store.appendIncremental({ event });
  const original = store.loadCapturedSession(sessionId);
  store.close();

  const oldDatabase = new DatabaseSync(path);
  oldDatabase.exec('DROP TABLE logical_evidence; DELETE FROM schema_migrations WHERE version = 18');
  oldDatabase.close();
  const upgraded = new ExperienceStore(path);
  assert.deepEqual(upgraded.loadCapturedSession(sessionId), original);
  assert.deepEqual(upgraded.loadLogicalEvidencePage(sessionId, { after: 0, through: upgraded.logicalEvidenceHighWater(sessionId), limit: 10 }).events.map(({ sourceEventId }) => sourceEventId), ['aec-legacy-event']);
  assert.deepEqual(upgraded.backfillLogicalEvidence(), { indexed: 0, remaining: 0 });
  upgraded.close();
  const reopened = new ExperienceStore(path);
  assert.equal(reopened.logicalEvidenceHighWater(sessionId), 1);
  reopened.close();
  const checked = new DatabaseSync(path);
  assert.deepEqual(checked.prepare('PRAGMA foreign_key_check').all(), []);
  checked.close();
});

test('AEC-A6 bounded legacy backfill resumes after interruption between pages', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'aec-backfill-pages-')), 'store.sqlite');
  const sessionId = 'aec-many-legacy' as SessionId;
  const store = new ExperienceStore(path);
  store.appendIncremental({ session: { id: sessionId, source: 'codex', startedAt: '2026-09-29T10:00:00.000Z' } });
  for (let ordinal = 0; ordinal < 1025; ordinal++) {
    store.appendIncremental({ event: normalizeMappedCapture({ source: 'codex', sourceEventId: `aec-old-${ordinal}`, sessionId,
      phase: 'pre-action', occurredAt: new Date(Date.parse('2026-09-29T10:00:01.000Z') + ordinal).toISOString(),
      tool: 'shell', action: 'test', summary: 'Test.' }) });
  }
  const original = store.loadCapturedSession(sessionId);
  store.close();

  const oldDatabase = new DatabaseSync(path);
  oldDatabase.exec('DROP TABLE logical_evidence; DELETE FROM schema_migrations WHERE version = 18');
  oldDatabase.close();
  const firstPass = new ExperienceStore(path);
  assert.deepEqual(firstPass.logicalEvidenceCoverage(sessionId), { indexed: 1024, unindexed: 1, conflicts: 0 });
  assert.throws(() => firstPass.logicalEvidenceHighWater(sessionId), /backfill is incomplete/i);
  assert.throws(() => firstPass.loadLogicalEvidencePage(sessionId, { after: 0, through: 1024, limit: 1 }), /backfill is incomplete/i);
  firstPass.close();
  const resumed = new ExperienceStore(path);
  assert.equal(resumed.logicalEvidenceHighWater(sessionId), 1025);
  assert.deepEqual(resumed.backfillLogicalEvidence(), { indexed: 0, remaining: 0 });
  assert.deepEqual(resumed.loadCapturedSession(sessionId), original);
  assert.deepEqual(resumed.loadLogicalEvidencePage(sessionId, { after: 1024, through: 1025, limit: 1 }).events.map(({ sourceEventId }) => sourceEventId), ['aec-old-1024']);
  resumed.close();
});

test('AEC-A6 conflicting legacy and resumed identities remain quarantined without blocking migration', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'aec-conflict-')), 'store.sqlite');
  const sessionId = 'aec-conflict-session' as SessionId;
  const store = new ExperienceStore(path);
  store.appendIncremental({ session: { id: sessionId, source: 'codex', startedAt: '2026-09-29T10:00:00.000Z' } });
  store.appendIncremental({ event: normalizeMappedCapture({ source: 'codex', sourceEventId: 'same-source-id', sessionId,
    phase: 'pre-action', occurredAt: '2026-09-29T10:00:01.000Z', tool: 'shell', action: 'test', summary: 'Old.' }) });
  store.endSession('codex', sessionId, '2026-09-29T10:01:00.000Z');
  store.recordLifecycleSignal({ source: 'codex', sourceEventId: 'resume-signal', conversationId: sessionId,
    kind: 'start', startOrigin: 'resume', receiptAt: '2026-09-29T10:02:00.000Z' });
  store.appendLifecycleTechnical(normalizeMappedCapture({ source: 'codex', sourceEventId: 'same-source-id', sessionId,
    phase: 'pre-action', occurredAt: '2026-09-29T10:02:01.000Z', tool: 'shell', action: 'test', summary: 'Resumed.' }));
  store.close();
  const oldDatabase = new DatabaseSync(path);
  oldDatabase.exec('DROP TABLE logical_evidence_conflicts; DROP TABLE logical_evidence; DELETE FROM schema_migrations WHERE version = 18');
  oldDatabase.close();
  const reopened = new ExperienceStore(path);
  assert.deepEqual(reopened.logicalEvidenceCoverage(sessionId), { indexed: 1, unindexed: 0, conflicts: 1 });
  assert.equal(reopened.loadCapturedSession(sessionId)?.events.length, 1);
  assert.equal(reopened.listConversationTechnicalEvents(sessionId).length, 1);
  reopened.close();
  const checked = new DatabaseSync(path);
  assert.equal((checked.prepare('SELECT COUNT(*) AS count FROM logical_evidence_conflicts').get() as { count: number }).count, 1);
  checked.close();
});

test('AEC-A6 an equivalent source event in both paths has one logical identity', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'aec-equivalent-')), 'store.sqlite');
  const sessionId = 'aec-equivalent-session' as SessionId;
  const store = new ExperienceStore(path);
  store.appendIncremental({ session: { id: sessionId, source: 'codex', startedAt: '2026-09-29T10:00:00.000Z' } });
  const event = normalizeMappedCapture({ source: 'codex', sourceEventId: 'shared-source-id', sessionId,
    phase: 'pre-action', occurredAt: '2026-09-29T10:00:01.000Z', tool: 'shell', action: 'test', summary: 'Same.' });
  store.appendIncremental({ event });
  store.endSession('codex', sessionId, '2026-09-29T10:01:00.000Z');
  store.recordLifecycleSignal({ source: 'codex', sourceEventId: 'equivalent-resume', conversationId: sessionId,
    kind: 'start', startOrigin: 'resume', receiptAt: '2026-09-29T10:02:00.000Z' });
  store.appendLifecycleTechnical(event);
  store.close();
  const oldDatabase = new DatabaseSync(path);
  oldDatabase.exec('DROP TABLE logical_evidence_conflicts; DROP TABLE logical_evidence; DELETE FROM schema_migrations WHERE version = 18');
  oldDatabase.close();
  const reopened = new ExperienceStore(path);
  assert.deepEqual(reopened.logicalEvidenceCoverage(sessionId), { indexed: 1, unindexed: 0, conflicts: 0 });
  reopened.close();
  const checked = new DatabaseSync(path);
  assert.equal((checked.prepare("SELECT disposition FROM logical_evidence_conflicts").get() as { disposition: string }).disposition, 'equivalent');
  checked.close();
});

test('AEC-A6 backfill orders a result after its request across a one-event learning page', () => {
  const root = mkdtempSync(join(tmpdir(), 'aec-backfill-order-'));
  const path = join(root, 'store.sqlite');
  const sessionId = 'aec-ordered' as SessionId;
  const repositoryId = 'aec-ordered-repo' as RepositoryId;
  const store = new ExperienceStore(path);
  store.registerRepository({ id: repositoryId, root, observedAt: '2026-09-29T10:00:00.000Z' });
  store.appendIncremental({ session: { id: sessionId, source: 'codex', startedAt: '2026-09-29T10:00:00.000Z', repositoryId } });
  store.appendIncremental({ event: normalizeMappedCapture({ source: 'codex', sourceEventId: 'z-request', sessionId,
    phase: 'pre-action', occurredAt: '2026-09-29T10:00:01.000Z', tool: 'shell', action: 'test', summary: 'Test.' }) });
  store.appendIncremental({ event: normalizeMappedCapture({ source: 'codex', sourceEventId: 'a-result', sessionId,
    phase: 'post-result', occurredAt: '2026-09-29T10:00:02.000Z', tool: 'shell', action: 'test', summary: 'Result.',
    outcome: 'unknown', relatedEventId: 'z-request' }) });
  store.close();
  const oldDatabase = new DatabaseSync(path);
  oldDatabase.exec('DROP TABLE logical_evidence_conflicts; DROP TABLE logical_evidence; DELETE FROM schema_migrations WHERE version = 18');
  oldDatabase.close();
  const reopened = new ExperienceStore(path);
  assert.deepEqual(reopened.loadLogicalEvidencePage(sessionId, { after: 0, through: 2, limit: 1 }).events.map(({ sourceEventId }) => sourceEventId), ['z-request']);
  assert.deepEqual(reopened.loadLogicalEvidencePage(sessionId, { after: 1, through: 2, limit: 1 }).events.map(({ sourceEventId }) => sourceEventId), ['a-result']);
  reopened.close();
  const learning = new OperationalLearningService(path);
  assert.equal(learning.enqueueCommittedSession(repositoryId, sessionId), true);
  assert.equal(learning.runNext({ maxEvents: 1, ownerId: 'aec-first' }).status, 'completed');
  assert.equal(learning.runNext({ maxEvents: 1, ownerId: 'aec-second' }).status, 'completed');
  const repository = new OperationalLearningRepository(path);
  assert.equal(repository.stream(repositoryId, sessionId)?.processedHighWater, 2);
  assert.deepEqual(repository.stream(repositoryId, sessionId)?.checkpoint.pendingEvents, []);
  repository.close();
});

test('AEC-A4 process interpretations remain distinct from task verification', () => {
  const kinds = ['no-match', 'interrupted', 'environment-limited', 'expected-red', 'failed-test'] as const;
  const observations: EvidenceObservation[] = kinds.flatMap((kind, index) => {
    const request = `request-${index}`;
    return [
      { id: request, sourceEventId: request, kind: 'request' as const, occurredAt: `2026-09-29T10:00:0${index}.000Z` },
      { id: `result-${index}`, sourceEventId: `result-${index}`, kind: 'result' as const,
        occurredAt: `2026-09-29T10:00:1${index}.000Z`, relatedEventId: request,
        exitStatus: 1, outcome: 'failed' as const, interpretation: { version: 1 as const, kind } },
      ...(kind === 'expected-red' || kind === 'failed-test' ? [{ id: `verification-${index}`, sourceEventId: `verification-${index}`,
        kind: 'task-verification' as const, occurredAt: `2026-09-29T10:00:2${index}.000Z`, relatedEventId: request,
        outcome: kind === 'expected-red' ? 'succeeded' as const : 'failed' as const }] : [])
    ];
  });
  observations.push({ id: 'zero-request', sourceEventId: 'zero-request', kind: 'request', occurredAt: '2026-09-29T10:00:30.000Z' });
  observations.push({ id: 'zero-result', sourceEventId: 'zero-result', kind: 'result', occurredAt: '2026-09-29T10:00:31.000Z', relatedEventId: 'zero-request', exitStatus: 0, outcome: 'succeeded' });
  const report = reconstructSessionEvidence({ schemaVersion: 1, source: 'codex', sessionId: 'aec-interpretations',
    startedAt: '2026-09-29T10:00:00.000Z', observations });
  assert.deepEqual(report.operations.slice(0, 5).map(({ result }) => result?.interpretation?.kind), kinds);
  assert.equal(report.operations[3]?.taskOutcome, 'succeeded');
  assert.equal(report.operations[4]?.taskOutcome, 'failed');
  assert.equal(report.operations[5]?.processOutcome, 'succeeded');
  assert.equal(report.operations[5]?.taskOutcome, 'unknown');
});

test('AEC-A4 an rg no-match cannot start a repair episode', () => {
  const sessionId = 'aec-rg' as SessionId;
  const make = (sourceEventId: string, phase: 'pre-action' | 'post-result', second: number, argumentsValue: readonly string[], relatedEventId?: string, exitStatus?: number) =>
    normalizeMappedCapture({ source: 'codex', sourceEventId, sessionId, phase,
      occurredAt: `2026-09-29T10:00:0${second}.000Z`, tool: 'shell', action: 'rg', arguments: argumentsValue, summary: 'Search.',
      ...(phase === 'post-result' ? { relatedEventId: relatedEventId!, outcome: exitStatus === 0 ? 'succeeded' as const : 'failed' as const, exitStatus: exitStatus! } : {}) });
  const result = detectOperationalEpisodes({ repositoryId: 'aec-repo', sessionId, conventions: [], events: [
    make('rg-first', 'pre-action', 1, ['pattern', 'first']),
    make('rg-first-result', 'post-result', 2, ['pattern', 'first'], 'rg-first', 1),
    make('rg-second', 'pre-action', 3, ['pattern', 'second']),
    make('rg-second-result', 'post-result', 4, ['pattern', 'second'], 'rg-second', 0)
  ] });
  assert.equal(result.findings.some(({ kind }) => kind === 'ambiguous-repair'), false);
});

test('AEC-A5 qualified execution keys resolve late results and leave conflicts unresolved', () => {
  const base = { schemaVersion: 1 as const, source: 'codex' as const, sessionId: 'aec-async', startedAt: '2026-09-29T10:00:00.000Z' };
  const request = { id: 'request', sourceEventId: 'request', executionKey: 'execution-1', kind: 'request' as const, occurredAt: '2026-09-29T10:00:01.000Z' };
  const delayed = { id: 'delayed', sourceEventId: 'delayed', executionKey: 'execution-1', kind: 'result' as const,
    occurredAt: '2026-09-29T10:00:03.000Z', relatedEventId: 'request', resultProvenance: 'async-completion' as const,
    exitStatus: 0, outcome: 'succeeded' as const };
  const matched = reconstructSessionEvidence({ ...base, observations: [request, delayed] });
  assert.equal(matched.operations[0]?.resultEvidenceId, 'delayed');
  const wrong = reconstructSessionEvidence({ ...base, observations: [request, { ...delayed, executionKey: 'execution-2' }] });
  assert.equal(wrong.operations[0]?.result?.unknownReason, 'correlation-missing');
  assert.deepEqual(wrong.unmatchedEvidenceIds, ['delayed']);
  const conflict = reconstructSessionEvidence({ ...base, observations: [request, delayed,
    { ...delayed, id: 'other', sourceEventId: 'other', occurredAt: '2026-09-29T10:00:04.000Z', exitStatus: 1, outcome: 'failed' }] });
  assert.equal(conflict.operations[0]?.resultEvidenceId, undefined);
  assert.equal(conflict.operations[0]?.result?.unknownReason, 'correlation-missing');
  assert.deepEqual(conflict.unmatchedEvidenceIds, ['delayed', 'other']);
  const capturedSessionId = 'aec-projected' as SessionId;
  const projected = projectCapturedSessionEvidence({ session: { id: capturedSessionId, source: 'codex', startedAt: base.startedAt }, events: [
    normalizeMappedCapture({ source: 'codex', sourceEventId: 'projected-request', sessionId: capturedSessionId,
      phase: 'pre-action', occurredAt: '2026-09-29T10:00:01.000Z', tool: 'shell', action: 'test', summary: 'Test.' }),
    normalizeMappedCapture({ source: 'codex', sourceEventId: 'projected-result', sessionId: capturedSessionId,
      phase: 'post-result', occurredAt: '2026-09-29T10:00:03.000Z', tool: 'shell', action: 'test', summary: 'Result.',
      outcome: 'unknown', relatedEventId: 'projected-request' })
  ] });
  assert.equal(projected.observations[0]?.executionKey, 'projected-request');
  assert.equal(reconstructSessionEvidence(projected).operations[0]?.resultEvidenceId, projected.observations[1]?.id);
});
