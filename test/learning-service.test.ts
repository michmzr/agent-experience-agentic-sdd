import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { OperationalLearningService } from '../src/learning/service.js';
import { OperationalLearningRepository } from '../src/learning/repository.js';
import { normalizeMappedCapture } from '../src/capture/normalization.js';
import { ExperienceStore } from '../src/storage/experience-store.js';
import { initializeGitRepository } from './helpers/git-repository.js';

test('returns false when no committed analysis job is pending', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-learning-service-'));
  const service = new OperationalLearningService(join(dataDir, 'experience.sqlite'));
  assert.deepEqual(service.runNext(), { status: 'idle' });
});

test('coalesces admission into one detector-version stream and keeps later input pending', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-learning-stream-'));
  const databasePath = join(dataDir, 'experience.sqlite');
  const repository = new OperationalLearningRepository(databasePath, () => '2026-09-12T10:00:00.000Z');
  try {
    repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', detectorVersion: 'm6-deterministic@1', inputHighWater: 5 });
    repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', detectorVersion: 'm6-deterministic@1', inputHighWater: 8 });
    assert.equal(repository.streamsFor('repo-1')[0]?.desiredThrough, 8);
    const claimed = repository.claim();
    assert.equal(claimed?.inputFrom, 1);
    assert.equal(claimed?.inputThrough, 8);
    repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', detectorVersion: 'm6-deterministic@1', inputHighWater: 10 });
    repository.saveResult(claimed!.id, { episodes: [], findings: [], candidates: [] }, claimed!.leaseToken);
    assert.equal(repository.streamsFor('repo-1')[0]?.state, 'pending');
    assert.equal(repository.analysisRunsFor('repo-1')[0]?.inputThrough, 8);
  } finally { repository.close(); }
});

test('recovers a stale lease and never reruns an unchanged completed range', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-learning-lease-'));
  let time = '2026-09-12T10:00:00.000Z';
  const repository = new OperationalLearningRepository(join(dataDir, 'experience.sqlite'), () => time);
  try {
    repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', detectorVersion: 'm6-deterministic@1', inputHighWater: 5 });
    const first = repository.claim();
    time = '2026-09-12T10:05:00.000Z';
    const recovered = repository.claim();
    assert.equal(recovered?.id, first?.id);
    repository.saveResult(recovered!.id, { episodes: [], findings: [], candidates: [] }, recovered!.leaseToken);
    repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', detectorVersion: 'm6-deterministic@1', inputHighWater: 5 });
    assert.equal(repository.claim(), undefined);
  } finally { repository.close(); }
});

test('preserves first retained instruction context and leaves unavailable source provenance unknown', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-learning-context-history-'));
  const databasePath = join(dataDir, 'experience.sqlite');
  const project = join(dataDir, 'project');
  mkdirSync(project);
  initializeGitRepository(project);
  writeFileSync(join(project, 'AGENTS.md'), 'Use pnpm instead of npm.\n');
  const store = new ExperienceStore(databasePath);
  try {
    store.registerRepository({ id: 'repo-1', root: project, observedAt: '2026-09-13T10:00:00.000Z' });
    store.appendIncremental({ session: { id: 'session-1' as never, source: 'codex', startedAt: '2026-09-13T10:00:00.000Z', repositoryId: 'repo-1' as never } });
  } finally { store.close(); }

  const service = new OperationalLearningService(databasePath);
  service.enqueueCommittedSession('repo-1', 'session-1');
  writeFileSync(join(project, 'AGENTS.md'), 'Use npm instead of pnpm.\n');

  const repository = new OperationalLearningRepository(databasePath);
  try {
    const snapshot = repository.contextSnapshotFor('repo-1', 'session-1');
    const instruction = snapshot?.instructions.find(({ location }) => location === 'AGENTS.md');
    assert.equal(instruction?.found, true);
    assert.equal(instruction?.delivered, 'unknown');
    assert.equal(instruction?.explicitlyRead, 'unknown');
    assert.equal(snapshot?.sourceAgentKey, undefined);
    assert.equal(snapshot?.conversationKey, undefined);
    assert.equal(instruction?.digest.includes('npm'), false);
    assert.equal(snapshot?.conventions[0]?.tool, 'pnpm');
  } finally { repository.close(); }
});

test('preserves privacy-safe lifecycle provenance and leaves an ambiguous run unknown', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-learning-context-lifecycle-'));
  const databasePath = join(dataDir, 'experience.sqlite');
  const project = join(dataDir, 'project');
  mkdirSync(project);
  initializeGitRepository(project);
  writeFileSync(join(project, 'AGENTS.md'), 'Use pnpm instead of npm.\n');
  const store = new ExperienceStore(databasePath);
  try {
    store.registerRepository({ id: 'repo-1', root: project, observedAt: '2026-09-13T10:00:00.000Z' });
    store.applyLifecycle({
      lifecycle: { sourceEventId: 'opaque-start', source: 'codex', conversationId: 'conversation-secret', kind: 'start', startOrigin: 'startup', receiptAt: '2026-09-13T10:00:00.000Z' },
      session: { id: 'conversation-secret' as never, source: 'codex', startedAt: '2026-09-13T10:00:00.000Z', repositoryId: 'repo-1' as never }
    });
  } finally { store.close(); }

  new OperationalLearningService(databasePath).enqueueCommittedSession('repo-1', 'conversation-secret');
  const repository = new OperationalLearningRepository(databasePath);
  try {
    const snapshot = repository.contextSnapshotFor('repo-1', 'conversation-secret');
    assert.equal(snapshot?.sourceAgentKey?.includes('codex') ?? true, false);
    assert.equal(snapshot?.conversationKey?.includes('conversation-secret') ?? true, false);
    assert.equal(snapshot?.runKey?.includes('conversation-secret') ?? true, false);
    assert.ok(snapshot?.sourceAgentKey);
    assert.ok(snapshot?.conversationKey);
    assert.ok(snapshot?.runKey);
    assert.notEqual(snapshot?.conversationKey, createHmac('sha256', snapshot!.repositoryFamilyKey).update('ael:operational-context:conversation:v1\0conversation-secret').digest('hex'));
  } finally { repository.close(); }

  const ambiguousPath = join(mkdtempSync(join(tmpdir(), 'ael-learning-context-ambiguous-')), 'experience.sqlite');
  const ambiguousStore = new ExperienceStore(ambiguousPath);
  try {
    ambiguousStore.registerRepository({ id: 'repo-1', root: project, observedAt: '2026-09-13T10:00:00.000Z' });
    ambiguousStore.applyLifecycle({
      lifecycle: { sourceEventId: 'ambiguous-start', source: 'codex', conversationId: 'conversation-ambiguous', kind: 'start', startOrigin: 'startup', receiptAt: '2026-09-13T10:00:00.000Z' },
      session: { id: 'conversation-ambiguous' as never, source: 'codex', startedAt: '2026-09-13T10:00:00.000Z', repositoryId: 'repo-1' as never }
    });
    ambiguousStore.recordLifecycleSignal({ sourceEventId: 'ambiguous-end', source: 'codex', conversationId: 'conversation-ambiguous', kind: 'end', receiptAt: '2026-09-13T10:01:00.000Z' });
    ambiguousStore.recordLifecycleSignal({ sourceEventId: 'ambiguous-resume', source: 'codex', conversationId: 'conversation-ambiguous', kind: 'start', startOrigin: 'resume', receiptAt: '2026-09-13T10:02:00.000Z' });
  } finally { ambiguousStore.close(); }
  new OperationalLearningService(ambiguousPath).enqueueCommittedSession('repo-1', 'conversation-ambiguous');
  const ambiguousRepository = new OperationalLearningRepository(ambiguousPath);
  try {
    const snapshot = ambiguousRepository.contextSnapshotFor('repo-1', 'conversation-ambiguous');
    assert.ok(snapshot?.conversationKey);
    assert.equal(snapshot?.runKey, undefined);
  } finally { ambiguousRepository.close(); }
});

test('projects retained tool activity into bounded typed evidence without leaking capture markers', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-learning-typed-service-'));
  const databasePath = join(dataDir, 'experience.sqlite');
  const project = join(dataDir, 'project');
  mkdirSync(project);
  initializeGitRepository(project);
  const store = new ExperienceStore(databasePath);
  try {
    store.registerRepository({ id: 'repo-typed', root: project, observedAt: '2026-09-13T10:00:00.000Z' });
    const request = normalizeMappedCapture({
      source: 'codex', sourceEventId: 'Liquibase-marker-request', sessionId: 'session-typed' as never,
      phase: 'pre-action', occurredAt: '2026-09-13T10:00:01.000Z', tool: 'shell', action: 'run', arguments: ['Liquibase-marker'], summary: 'Run migration.'
    });
    const result = normalizeMappedCapture({
      source: 'codex', sourceEventId: 'Liquibase-marker-result', sessionId: 'session-typed' as never,
      phase: 'post-result', occurredAt: '2026-09-13T10:00:02.000Z', tool: 'shell', action: 'run', arguments: ['Liquibase-marker'], summary: 'Migration completed.', outcome: 'succeeded', exitStatus: 0, relatedEventId: 'Liquibase-marker-request'
    });
    store.appendIncremental({ session: { id: 'session-typed' as never, source: 'codex', startedAt: '2026-09-13T10:00:00.000Z', repositoryId: 'repo-typed' as never }, event: request });
    store.appendIncremental({ event: result });
  } finally { store.close(); }

  const service = new OperationalLearningService(databasePath);
  service.enqueueCommittedSession('repo-typed', 'session-typed');
  assert.equal(service.runNext({ repositoryId: 'repo-typed' }).status, 'completed');
  const report = service.report('repo-typed');
  assert.deepEqual(report.episodeEvidence.map(({ kind, state }) => ({ kind, state })).sort((left, right) => left.kind.localeCompare(right.kind)), [
    { kind: 'tool-result', state: 'succeeded' },
    { kind: 'tool-request', state: 'observed' }
  ].sort((left, right) => left.kind.localeCompare(right.kind)));
  assert.equal(JSON.stringify(report).includes('Liquibase'), false);
});
