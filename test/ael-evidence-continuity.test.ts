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
