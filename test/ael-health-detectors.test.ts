import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli, runCliAsync } from '../src/cli.js';
import { ingestPassiveHook } from '../src/capture/hook-ingress.js';
import { normalizeMappedCapture } from '../src/capture/normalization.js';
import { ExperienceService } from '../src/application/experience-service.js';
import { OperationalLearningService } from '../src/learning/service.js';
import { OperationalLearningRepository } from '../src/learning/repository.js';
import { ExperienceStore } from '../src/storage/experience-store.js';
import { initializeGitRepository } from './helpers/git-repository.js';
import { resolveRepository } from '../src/repository/local-repository.js';

const at = '2026-09-30T10:00:00.000Z';

test('ARC-A5 completed unknown-only results report insufficient repair evidence', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'arc-detectors-'));
  const databasePath = join(dataDir, 'experience.sqlite');
  try {
    const store = new ExperienceStore(databasePath);
    store.registerRepository({ id: 'repo-arc' as never, root: dataDir, observedAt: at });
    store.appendIncremental({ session: { id: 'session-arc' as never, source: 'codex', repositoryId: 'repo-arc' as never, startedAt: at } });
    store.appendIncremental({ event: normalizeMappedCapture({ source: 'codex', sourceEventId: 'request-arc', sessionId: 'session-arc' as never,
      phase: 'pre-action', occurredAt: '2026-09-30T10:00:01.000Z', tool: 'shell', action: 'test', summary: 'Test.' }) });
    store.appendIncremental({ event: normalizeMappedCapture({ source: 'codex', sourceEventId: 'result-arc', sessionId: 'session-arc' as never,
      phase: 'post-result', occurredAt: '2026-09-30T10:00:02.000Z', tool: 'shell', action: 'test', summary: 'Result.',
      outcome: 'unknown', relatedEventId: 'request-arc' }) });
    store.close();
    const learning = new OperationalLearningService(databasePath);
    assert.equal(learning.enqueueCommittedSession('repo-arc', 'session-arc'), true);
    assert.equal(learning.runNext({ repositoryId: 'repo-arc' }).status, 'completed');
    const legacyCommands = [
      ['analysis', 'report'], ['analysis', 'report', '--schema-version', '2'],
      ['status'], ['status', '--schema-version', '2']
    ].map(args => [...args, '--data-dir', dataDir, '--repository-id', 'repo-arc', '--json']);
    const legacyBefore = legacyCommands.map(args => runCli(args).stdout);
    const command = (args: string[]) => {
      const result = runCli([...args, '--data-dir', dataDir, '--repository-id', 'repo-arc', '--json']);
      assert.equal(result.exitCode, args[0] === 'status' ? 1 : 0, result.stdout);
      return JSON.parse(result.stdout) as { analysis: { state: string; result?: string; detectorEvaluation?: { detectors: Array<{ detector: string; status: string }> } }; detectorEvaluation?: { detectors: Array<{ detector: string; status: string }> } };
    };
    const report = command(['analysis', 'report', '--schema-version', '3']);
    assert.equal(report.analysis.state, 'completed');
    assert.equal(report.detectorEvaluation?.detectors.find(item => item.detector === 'repairs')?.status, 'insufficient-evidence');
    assert.equal(report.detectorEvaluation?.detectors.some(item => item.status === 'evaluated-no-findings'), false);
    const status = command(['status', '--schema-version', '3']);
    assert.equal(status.analysis.detectorEvaluation?.detectors.find(item => item.detector === 'repairs')?.status, 'insufficient-evidence');
    assert.deepEqual(legacyCommands.map(args => runCli(args).stdout), legacyBefore);
    const late = new ExperienceStore(databasePath);
    late.appendIncremental({ event: normalizeMappedCapture({ source: 'codex', sourceEventId: 'late-request', sessionId: 'session-arc' as never,
      phase: 'pre-action', occurredAt: '2026-09-30T10:00:03.000Z', tool: 'shell', action: 'test', summary: 'Late test.' }) });
    late.close();
    const stale = command(['analysis', 'report', '--schema-version', '3']);
    assert.equal(stale.detectorEvaluation?.detectors.find(item => item.detector === 'repairs')?.status, 'incomplete');
    const known = new ExperienceStore(databasePath);
    known.appendIncremental({ event: normalizeMappedCapture({ source: 'codex', sourceEventId: 'late-result', sessionId: 'session-arc' as never,
      phase: 'post-result', occurredAt: '2026-09-30T10:00:04.000Z', tool: 'shell', action: 'test', summary: 'Known result.',
      outcome: 'succeeded', relatedEventId: 'late-request' }) });
    known.close();
    assert.equal(learning.enqueueCommittedSession('repo-arc', 'session-arc'), true);
    assert.equal(learning.runNext({ repositoryId: 'repo-arc' }).status, 'completed');
    const mixed = command(['analysis', 'report', '--schema-version', '3']);
    assert.equal(mixed.detectorEvaluation?.detectors.find(item => item.detector === 'repairs')?.status, 'unsupported');
    assert.equal(mixed.detectorEvaluation?.detectors.some(item => item.status === 'evaluated-no-findings'), false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('ARC-A6 absent store reports unavailable without claiming detector evaluation', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'arc-unavailable-'));
  try {
    const result = runCli(['status', '--schema-version', '3', '--data-dir', dataDir, '--repository-id', 'repo-arc', '--json']);
    assert.equal(result.exitCode, 1);
    const health = JSON.parse(result.stdout) as { analysis: { state: string; detectorEvaluation: { state: string; detectors: Array<{ status: string }> } } };
    assert.equal(health.analysis.state, 'unavailable');
    assert.equal(health.analysis.detectorEvaluation.state, 'unavailable');
    assert.ok(health.analysis.detectorEvaluation.detectors.every(detector => detector.status === 'unsupported'));
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('ARC-A6 opt-out capture remains passive and malformed hook input fails open', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'arc-opt-out-'));
  const root = mkdtempSync(join(tmpdir(), 'arc-opt-out-repo-'));
  try {
    initializeGitRepository(root);
    const repositoryId = resolveRepository(root)!.id;
    mkdirSync(join(root, '.ael'));
    writeFileSync(join(root, '.ael/settings.json'), '{"version":1,"captureDeliveryDeadlineMs":2000,"automaticOperationalLearning":false}\n');
    const service = new ExperienceService({ dataDir, scheduleAnalysis() { throw new Error('Opt-out must not schedule analysis.'); } });
    service.initRepository({ id: repositoryId, root, sources: ['codex'], observedAt: at });
    const admitted = ingestPassiveHook({ source: 'codex', databasePath: join(dataDir, 'experience.sqlite'), workingDirectory: root,
      repositoryId: repositoryId as never, now: () => at, scheduleDrain: () => undefined,
      input: JSON.stringify({ session_id: 'disabled-session', hook_event_name: 'SessionStart', source: 'startup' }) });
    assert.equal(admitted.status, 'captured');
    const drain = runCli(['capture', 'drain', '--data-dir', dataDir, '--json']);
    assert.equal(drain.exitCode, 0, drain.stdout);
    const report = runCli(['analysis', 'report', '--schema-version', '3', '--repository-id', repositoryId, '--data-dir', dataDir, '--json']);
    assert.equal(report.exitCode, 0, report.stdout);
    assert.equal((JSON.parse(report.stdout) as { analysis: { state: string } }).analysis.state, 'not-run');
    const malformed = await runCliAsync(['capture', 'hook', '--source', 'codex', '--data-dir', dataDir],
      { workingDirectory: root, hookInput: '{invalid-private-payload' });
    assert.equal(malformed.exitCode, 0);
    assert.equal(malformed.stdout, '');
    assert.equal(malformed.stderr.includes('invalid-private-payload'), false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test('ARC-A6 public worker recovers an expired analysis lease', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'arc-expired-lease-'));
  const databasePath = join(dataDir, 'experience.sqlite');
  try {
    writeFileSync(join(dataDir, 'analysis-worker.json'), '{"version":1,"maxProcesses":1,"idleTimeoutMs":1000}\n');
    const store = new ExperienceStore(databasePath);
    store.registerRepository({ id: 'repo-lease' as never, root: dataDir, observedAt: at });
    store.appendIncremental({ session: { id: 'session-lease' as never, source: 'codex', repositoryId: 'repo-lease' as never, startedAt: at } });
    store.appendIncremental({ event: normalizeMappedCapture({ source: 'codex', sourceEventId: 'request-lease', sessionId: 'session-lease' as never,
      phase: 'pre-action', occurredAt: at, tool: 'shell', action: 'test', summary: 'Test.' }) });
    store.close();
    assert.equal(new OperationalLearningService(databasePath).enqueueCommittedSession('repo-lease', 'session-lease'), true);
    const stale = new OperationalLearningRepository(databasePath, () => '2000-01-01T00:00:00.000Z');
    assert.ok(stale.claim({ ownerId: 'abandoned-worker', leaseMs: 1, repositoryId: 'repo-lease' }));
    stale.close();
    const worker = await runCliAsync(['analysis', 'worker', '--data-dir', dataDir]);
    assert.equal(worker.exitCode, 0, worker.stderr);
    const report = runCli(['analysis', 'report', '--schema-version', '3', '--repository-id', 'repo-lease', '--data-dir', dataDir, '--json']);
    assert.equal(report.exitCode, 0, report.stdout);
    const analysis = (JSON.parse(report.stdout) as { analysis: { state: string; retries: number } }).analysis;
    assert.equal(analysis.state, 'completed');
    assert.ok(analysis.retries >= 1);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('ARC-A6 passive hook remains fail-open when the main store path is unavailable', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'arc-store-unavailable-'));
  try {
    mkdirSync(join(dataDir, 'experience.sqlite'));
    const result = await runCliAsync(['capture', 'hook', '--source', 'codex', '--data-dir', dataDir],
      { hookInput: JSON.stringify({ session_id: 'unavailable-session', hook_event_name: 'SessionStart', source: 'startup' }) });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes(dataDir), false);
    const report = runCli(['analysis', 'report', '--schema-version', '3', '--repository-id', 'repo-unavailable', '--data-dir', dataDir, '--json']);
    assert.equal(report.exitCode, 1);
    assert.equal(report.stdout.includes(dataDir), false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
