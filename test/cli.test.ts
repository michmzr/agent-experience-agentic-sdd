import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli, runCliAsync } from '../src/cli.js';
import { CaptureSpool } from '../src/capture/spool.js';
import {
  OperationalLearningRepository,
  type AnalysisJob,
  type LearningResult
} from '../src/learning/repository.js';
import { normalizeMappedCapture } from '../src/capture/normalization.js';
import { ExperienceStore } from '../src/storage/experience-store.js';
import { initializeGitRepository } from './helpers/git-repository.js';

function acknowledgeForCli(
  repository: OperationalLearningRepository,
  job: AnalysisJob,
  ownerId: string,
  result: LearningResult
): void {
  repository.acknowledge(job.id, {
    ownerId,
    attempt: job.attempts,
    processedHighWater: job.inputHighWater,
    checkpoint: { version: 1, pendingEvents: [] },
    result,
    metrics: {
      eventsLoaded: job.inputHighWater - job.inputLowWater,
      findings: result.findings.length,
      elapsedMs: 0
    }
  });
}

test('groups public help and documents context precedence', () => {
  const result = runCli(['--help']);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^Usage: ael <command> \[options\]$/m);
  for (const heading of ['Setup', 'Observation', 'Review', 'Runtime', 'Knowledge', 'Skills']) {
    assert.match(result.stdout, new RegExp(`^${heading}$`, 'm'));
  }
  assert.match(result.stdout, /unregister \[--repository-id <id>\]/);
  assert.match(result.stdout, /runtime config explain \[--workspace <path>\]/);
  assert.match(result.stdout, /^Context: explicit option > nearest \.ael\/workspace\.json > Git root > interactive prompt\.$/m);
  assert.equal(result.stdout.includes('worker-child'), false);
  assert.equal(result.stdout.includes('capture hook'), false);
});

test('returns an error for an unknown command', () => {
  const result = runCli(['unknown']);

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Unknown command\./);
});

test('renders structured human errors and optional terminal color', () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'ael-cli-human-error-'));
  try {
    const plain = runCli(['unregister'], { workingDirectory });
    const colored = runCli(['unregister'], { workingDirectory, humanOutput: { color: true, width: 100 } });

    assert.equal(plain.exitCode, 1);
    assert.equal(plain.stderr, [
      'Error',
      '',
      'Message    A repository or workspace is required. Pass --repository-id or run the command inside a configured AEL workspace.',
      'Code       CONTEXT_REQUIRED',
      'Next step  Run `ael init` in the workspace or pass --repository-id.',
      ''
    ].join('\n'));
    assert.match(colored.stderr, /\u001b\[1mError\u001b\[0m/);
    assert.match(colored.stderr, /CONTEXT_REQUIRED/);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test('exposes the repository observability command forms', () => {
  for (const args of [
    ['list', 'records', '--repository-id', 'repo-a', '--json'],
    ['stats', '--repository-id', 'repo-a', '--json'],
    ['status-global', '--repository-id', 'repo-a', '--json']
  ]) {
    const result = runCli(args);
    assert.notEqual(result.exitCode, 2, result.stderr);
  }
});

test('reports filtered analysis metrics with global worker configuration and live children', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-analysis-status-'));
  try {
    writeFileSync(join(dataDir, 'analysis-worker.json'), JSON.stringify({ version: 1, maxProcesses: 5, idleTimeoutMs: 1_234 }));
    const repository = new OperationalLearningRepository(join(dataDir, 'experience.sqlite'));
    repository.enqueue({ repositoryId: 'repo-a', sessionId: 'session-a', inputHighWater: 2 });
    repository.enqueue({ repositoryId: 'repo-b', sessionId: 'session-b', inputHighWater: 1 });
    const job = repository.claim({ ownerId: 'manual', leaseMs: 60_000, repositoryId: 'repo-a' })!;
    repository.retry(job.id, { ownerId: 'manual', attempt: job.attempts, reason: 'execution-failure' });
    const coordinator = repository.acquireCoordinatorLease({ ownerId: 'coordinator', leaseMs: 60_000 })!;
    repository.reserveWorkerSlot({ ...coordinator, leaseMs: 30_000, maxProcesses: 5 });
    repository.close();

    const result = runCli(['analysis', 'status', '--repository-id', 'repo-b', '--session', 'session-b', '--data-dir', dataDir, '--json']);
    assert.equal(result.exitCode, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.deepEqual(status.workerConfig, { version: 1, maxProcesses: 5, idleTimeoutMs: 1_234 });
    assert.equal(status.activeChildren, 1);
    assert.equal(status.jobs.pending, 1);
    assert.equal(status.jobs['retryable-failure'], 0);
    assert.equal(status.totalAttempts, 0);
    assert.equal(status.totalRetries, 0);
    assert.equal(status.failureCounts['execution-failure'], 0);
    assert.equal(status.coordinatorLease.ownerId, 'coordinator');
    assert.equal(typeof status.oldestOutstandingAgeMs, 'number');
    assert.equal(status.nextRetryAt, null);
    assert.equal(status.eventsLoaded, 0);
    assert.equal(status.uniqueAcknowledgedEvents, 0);
    assert.equal(status.rereadRatio, 0);

    const human = runCli(['analysis', 'status', '--data-dir', dataDir]);
    assert.equal(human.exitCode, 0, human.stderr);
    assert.match(human.stdout, /^Scheduled retries\s+1$/m);
    assert.match(human.stdout, /^execution-failure\s+1$/m);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('bounds analysis worker configuration and internal argument errors without affecting passive capture', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-analysis-config-'));
  const marker = 'private-worker-token';
  try {
    writeFileSync(join(dataDir, 'analysis-worker.json'), `{\"version\":1,\"maxProcesses\":99,\"idleTimeoutMs\":300000,\"private\":\"${marker}\"}`);
    const worker = await runCliAsync(['analysis', 'worker', '--data-dir', dataDir], { humanOutput: { color: true } });
    assert.equal(worker.exitCode, 1);
    assert.equal(worker.stdout, '');
    assert.match(worker.stderr, /^ANALYSIS_CONFIGURATION_ERROR: Analysis worker configuration is invalid\.\n$/);
    assert.equal(worker.stderr.includes(marker), false);

    const status = runCli(['analysis', 'status', '--data-dir', dataDir, '--json']);
    assert.equal(status.exitCode, 1);
    assert.deepEqual(JSON.parse(status.stdout), { error: {
      code: 'ANALYSIS_CONFIGURATION_ERROR', message: 'Analysis worker configuration is invalid.'
    } });
    assert.equal(status.stdout.includes(marker), false);

    const invalidChild = await runCliAsync(['analysis', 'worker-child', '--data-dir', dataDir,
      '--worker-slot-id', marker, '--worker-slot-owner', 'owner', '--worker-slot-attempt', 'not-an-integer'], { humanOutput: { color: true } });
    assert.equal(invalidChild.exitCode, 2);
    assert.equal(invalidChild.stdout, '');
    assert.match(invalidChild.stderr, /^INVALID_SYNTAX: Analysis worker arguments are invalid\.\n$/);
    assert.equal(invalidChild.stderr.includes(marker), false);

    const lostWatchdog = await runCliAsync(['analysis', 'worker-watchdog', '--data-dir', dataDir,
      '--worker-slot-id', '00000000-0000-4000-8000-000000000000', '--worker-slot-owner', 'owner', '--worker-slot-attempt', '1'], { humanOutput: { color: true } });
    assert.equal(lostWatchdog.exitCode, 1);
    assert.equal(lostWatchdog.stdout, '');
    assert.equal(lostWatchdog.stderr, 'ANALYSIS_WORKER_FAILED: Analysis worker failed.\n');

    const capture = await runCliAsync(['capture', 'hook', '--source', 'codex', '--data-dir', dataDir], { hookInput: '{}'});
    assert.equal(capture.exitCode, 0);
    assert.equal(capture.stdout, '');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('accepts a Git top-level repository path and rejects a nested path', () => {
  assert.notEqual(runCli(['stats', '--repository', process.cwd(), '--json']).exitCode, 2);
  const nested = runCli(['stats', '--repository', 'src', '--json']);
  assert.equal(nested.exitCode, 1);
  assert.match(nested.stdout, /REPOSITORY_ROOT_REQUIRED/);
});

test('returns a nonzero status when repository hooks are unavailable', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-status-'));
  try {
    const result = runCli(['status', '--repository', process.cwd(), '--json', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /"status":"not-ready"/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('reports installation, delivery, data quality, and analysis independently in schema version 2', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-health-v2-'));
  try {
    const initial = JSON.parse(runCli(['status', '--repository', process.cwd(), '--schema-version', '2', '--json', '--data-dir', dataDir]).stdout) as {
      schemaVersion: number; installation: { state: string }; delivery: { state: string }; dataQuality: { state: string; denominator: { state: string } }; analysis: { state: string; result: string; coverage: { required: boolean; detectors: unknown[] } };
    };
    assert.equal(initial.schemaVersion, 2);
    assert.equal(initial.installation.state, 'not-ready');
    assert.equal(initial.delivery.state, 'unknown');
    assert.equal(initial.dataQuality.state, 'not-applicable');
    assert.equal(initial.dataQuality.denominator.state, 'unavailable');
    assert.equal(initial.analysis.state, 'not-run');
    assert.equal(initial.analysis.result, 'unavailable');
    assert.deepEqual(initial.analysis.coverage, { required: true, total: 0, truncated: false, detectors: [] });

    const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
    spool.admitWithReceipt({ kind: 'session-start', session: { source: 'codex', id: 'session-health' as never, startedAt: '2026-09-13T08:00:00.000Z', repositoryId: 'repo-health' as never } }, { source: 'codex', receivedAt: '2026-09-13T08:00:00.000Z' });
    spool.close();
    const learning = new OperationalLearningRepository(join(dataDir, 'experience.sqlite'));
    learning.enqueue({ repositoryId: 'repo-health', sessionId: 'session-health', inputHighWater: 3 });
    learning.close();

    const pending = JSON.parse(runCli(['status', '--repository-id', 'repo-health', '--schema-version', '2', '--json', '--data-dir', dataDir]).stdout) as {
      delivery: { state: string }; dataQuality: { admittedOperations: { state: string }; receipts: { accounting: string } }; analysis: { state: string; desiredThrough: number; completedThrough: number; result: string; coverage: { detectors: unknown[] } };
    };
    assert.equal(pending.delivery.state, 'backlogged');
    assert.deepEqual(pending.dataQuality.admittedOperations, { state: 'unavailable' });
    assert.equal(pending.dataQuality.receipts.accounting, 'unavailable');
    assert.equal(pending.analysis.state, 'pending');
    assert.equal(pending.analysis.desiredThrough, 3);
    assert.equal(pending.analysis.completedThrough, 0);
    assert.equal(pending.analysis.result, 'unavailable');
    assert.deepEqual(pending.analysis.coverage.detectors, []);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('keeps legacy status JSON byte-for-byte compatible unless schema version 2 is explicit', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-health-legacy-'));
  try {
    const legacy = runCli(['status-global', '--json', '--data-dir', dataDir]);
    const repeated = runCli(['status-global', '--json', '--data-dir', dataDir]);
    assert.equal(repeated.stdout, legacy.stdout);
    assert.equal(runCli(['status-global', '--schema-version', '1', '--json', '--data-dir', dataDir]).exitCode, 2);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('renders only version 2 dimensions and derives status exit from installation', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-health-human-'));
  const root = mkdtempSync(join(tmpdir(), 'ael-health-human-repo-'));
  try {
    initializeGitRepository(root);
    const notReady = runCli(['status', '--repository', root, '--schema-version', '2', '--data-dir', dataDir]);
    assert.equal(notReady.exitCode, 1);
    assert.match(notReady.stdout, /^Installation\s+not-ready$/m);
    assert.match(notReady.stdout, /^Delivery\s+unknown$/m);
    assert.equal(notReady.stdout.includes('Root:'), false);
    assert.equal(notReady.stdout.includes('Database:'), false);

    const initialized = runCli(['init', '--scope', 'repo', '--hooks', 'cursor', '--data-dir', dataDir, '--json'], { workingDirectory: root, cliEntrypoint: join(process.cwd(), 'dist', 'src', 'cli.js') });
    assert.equal(initialized.exitCode, 0, initialized.stderr);
    const readyJson = runCli(['status', '--repository', root, '--schema-version', '2', '--data-dir', dataDir, '--json']);
    assert.equal(readyJson.exitCode, 0);
    assert.equal((JSON.parse(readyJson.stdout) as { installation: { state: string } }).installation.state, 'ready');
    const ready = runCli(['status', '--repository', root, '--schema-version', '2', '--data-dir', dataDir]);
    assert.equal(ready.exitCode, 0);
    assert.match(ready.stdout, /^Installation\s+ready$/m);

    const learning = new OperationalLearningRepository(join(dataDir, 'experience.sqlite'));
    learning.enqueue({ repositoryId: 'repo-failed', sessionId: 'session-failed', inputHighWater: 1 });
    const job = learning.claim({ ownerId: 'cli-failed', leaseMs: 60_000, repositoryId: 'repo-failed' })!;
    learning.retry(job.id, { ownerId: 'cli-failed', attempt: job.attempts, reason: 'execution-failure' });
    learning.close();
    const failed = runCli(['analysis', 'report', '--repository-id', 'repo-failed', '--schema-version', '2', '--data-dir', dataDir]);
    assert.equal(failed.exitCode, 0);
    assert.match(failed.stdout, /^Analysis report  \[failed\]/m);
    assert.equal(failed.stdout.includes('findings'), false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }); }
});

test('reports unknown results and a completed no-findings analysis without leaking paths globally', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-health-complete-'));
  const repositoryId = 'repo-quality';
  try {
    const store = new ExperienceStore(join(dataDir, 'experience.sqlite'));
    store.appendIncremental({
      session: { id: 'session-quality' as never, source: 'codex', startedAt: '2026-09-13T09:00:00.000Z', repositoryId: repositoryId as never },
      event: normalizeMappedCapture({ source: 'codex', sourceEventId: 'request-quality', sessionId: 'session-quality' as never, phase: 'pre-action', occurredAt: '2026-09-13T09:00:00.000Z', tool: 'shell', action: 'run', summary: 'Run check.' })
    });
    store.close();
    const unknown = JSON.parse(runCli(['status', '--repository-id', repositoryId, '--schema-version', '2', '--json', '--data-dir', dataDir]).stdout) as {
      dataQuality: { state: string; admittedOperations: { state: string }; denominator: { state: string; count?: number }; results: { linked: number; unknown: Record<string, number> }; observedTimeRange: { first: string; last: string } }; analysis: { state: string };
    };
    assert.equal(unknown.dataQuality.state, 'degraded');
    assert.deepEqual(unknown.dataQuality.admittedOperations, { state: 'unavailable' });
    assert.deepEqual(unknown.dataQuality.denominator, { state: 'known', count: 1 });
    assert.deepEqual(unknown.dataQuality.results, { linked: 0, unknown: { 'result-not-delivered': 1 } });
    assert.deepEqual(unknown.dataQuality.observedTimeRange, { first: '2026-09-13T09:00:00.000Z', last: '2026-09-13T09:00:00.000Z' });
    assert.equal(unknown.analysis.state, 'not-run');

    const learning = new OperationalLearningRepository(join(dataDir, 'experience.sqlite'));
    learning.enqueue({ repositoryId, sessionId: 'session-quality', inputHighWater: 2 });
    const job = learning.claim({ ownerId: 'cli-complete', leaseMs: 60_000, repositoryId })!;
    const completedCoverage = [{ detector: job.detectorSetVersion, detectorSetVersion: job.detectorSetVersion,
      status: 'completed' as const, inputLowWater: job.inputLowWater, requestedHighWater: job.inputHighWater,
      processedHighWater: job.inputHighWater, examinedEvents: 2, findings: 0 }];
    acknowledgeForCli(learning, job, 'cli-complete', { episodes: [], findings: [], candidates: [], coverage: completedCoverage });
    learning.close();
    const complete = JSON.parse(runCli(['analysis', 'report', '--repository-id', repositoryId, '--schema-version', '2', '--json', '--data-dir', dataDir]).stdout) as {
      schemaVersion: number; analysis: { state: string; result: string; cost: { completedRuns: number; total: number }; range: { from: number; through: number }; coverage: { required: boolean; detectors: unknown[] } };
    };
    assert.equal(complete.schemaVersion, 2);
    assert.equal(complete.analysis.state, 'completed');
    assert.equal(complete.analysis.result, 'no-findings');
    assert.deepEqual(complete.analysis.cost, { completedRuns: 1, total: 2 });
    assert.deepEqual(complete.analysis.range, { from: 1, through: 2 });
    assert.deepEqual(complete.analysis.coverage, { required: true, total: 1, truncated: false, detectors: completedCoverage });

    const global = runCli(['status-global', '--schema-version', '2', '--json', '--data-dir', dataDir]).stdout;
    assert.equal(global.includes(dataDir), false);
    assert.equal(global.includes('experience.sqlite'), false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('requires coverage for every completed stream range and does not reuse repository receipts', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-health-ranges-'));
  try {
    const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
    spool.admitWithReceipt({ kind: 'session-start', session: { source: 'codex', id: 'session-a' as never, startedAt: '2026-09-13T10:00:00.000Z', repositoryId: 'repo-a' as never } }, { source: 'codex', receivedAt: '2026-09-13T10:00:00.000Z' });
    spool.close();
    const learning = new OperationalLearningRepository(join(dataDir, 'experience.sqlite'));
    learning.enqueue({ repositoryId: 'repo-a', sessionId: 'session-a', inputHighWater: 1 });
    const first = learning.claim({ ownerId: 'cli-uncovered', leaseMs: 60_000, repositoryId: 'repo-a' })!;
    acknowledgeForCli(learning, first, 'cli-uncovered', { episodes: [], findings: [], candidates: [] });
    learning.enqueue({ repositoryId: 'repo-a', sessionId: 'session-b', inputHighWater: 1 });
    const second = learning.claim({ ownerId: 'cli-covered', leaseMs: 60_000, repositoryId: 'repo-a' })!;
    acknowledgeForCli(learning, second, 'cli-covered', { episodes: [], findings: [], candidates: [], coverage: [{
      detector: second.detectorSetVersion, detectorSetVersion: second.detectorSetVersion, status: 'completed',
      inputLowWater: second.inputLowWater, requestedHighWater: second.inputHighWater,
      processedHighWater: second.inputHighWater, examinedEvents: 1, findings: 0
    }] });
    learning.close();

    const reportA = JSON.parse(runCli(['status', '--repository-id', 'repo-a', '--schema-version', '2', '--json', '--data-dir', dataDir]).stdout) as { dataQuality: { receipts: { accounting: string } }; analysis: { state: string; result: string } };
    const reportB = JSON.parse(runCli(['status', '--repository-id', 'repo-b', '--schema-version', '2', '--json', '--data-dir', dataDir]).stdout) as { dataQuality: { receipts: { accounting: string }; admittedOperations: { state: string } } };
    assert.equal(reportA.analysis.state, 'incomplete');
    assert.equal(reportA.analysis.result, 'unavailable');
    assert.equal(reportA.dataQuality.receipts.accounting, 'unavailable');
    assert.equal(reportB.dataQuality.receipts.accounting, 'unavailable');
    assert.deepEqual(reportB.dataQuality.admittedOperations, { state: 'unavailable' });
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('does not call an uncovered completed stream a no-findings analysis', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-health-uncovered-'));
  try {
    const learning = new OperationalLearningRepository(join(dataDir, 'experience.sqlite'));
    learning.enqueue({ repositoryId: 'repo-uncovered', sessionId: 'session-uncovered', inputHighWater: 1 });
    const job = learning.claim({ ownerId: 'cli-uncovered', leaseMs: 60_000, repositoryId: 'repo-uncovered' })!;
    acknowledgeForCli(learning, job, 'cli-uncovered', { episodes: [], findings: [], candidates: [] });
    learning.close();

    const report = JSON.parse(runCli(['analysis', 'report', '--repository-id', 'repo-uncovered', '--schema-version', '2', '--json', '--data-dir', dataDir]).stdout) as {
      analysis: { state: string; result: string; coverage: { required: boolean; detectors: unknown[] } };
    };
    assert.equal(report.analysis.state, 'incomplete');
    assert.equal(report.analysis.result, 'unavailable');
    assert.deepEqual(report.analysis.coverage, { required: true, total: 0, truncated: false, detectors: [] });
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('bounds version 2 detector summaries while retaining aggregate high waters', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-health-bounds-'));
  try {
    const learning = new OperationalLearningRepository(join(dataDir, 'experience.sqlite'));
    for (let index = 0; index < 70; index += 1) learning.enqueue({ repositoryId: 'repo-bounded', sessionId: `session-${index}`, detectorSetVersion: `detector-${index}@1`, inputHighWater: 1 });
    learning.close();
    const report = JSON.parse(runCli(['analysis', 'report', '--repository-id', 'repo-bounded', '--schema-version', '2', '--json', '--data-dir', dataDir]).stdout) as { analysis: { detectorVersions: string[]; detectorVersionTotal: number; detectorVersionsTruncated: boolean; desiredThrough: number; coverage: { detectors: unknown[] } } };
    assert.equal(report.analysis.desiredThrough, 70);
    assert.equal(report.analysis.detectorVersions.length, 64);
    assert.equal(report.analysis.detectorVersionTotal, 70);
    assert.equal(report.analysis.detectorVersionsTruncated, true);
    assert.equal(report.analysis.coverage.detectors.length, 0);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('uses coverage failures beyond the displayed sample when deriving analysis state', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-health-coverage-total-'));
  try {
    const learning = new OperationalLearningRepository(join(dataDir, 'experience.sqlite'));
    for (let index = 0; index < 65; index += 1) {
      learning.enqueue({ repositoryId: 'repo-coverage-total', sessionId: `coverage-${index}`, detectorSetVersion: `coverage-${index}@1`, inputHighWater: 1 });
      const ownerId = `coverage-owner-${index}`;
      const job = learning.claim({ ownerId, leaseMs: 60_000, repositoryId: 'repo-coverage-total' })!;
      acknowledgeForCli(learning, job, ownerId, { episodes: [], findings: [], candidates: [], coverage: [{
        detector: job.detectorSetVersion, detectorSetVersion: job.detectorSetVersion,
        status: index === 64 ? 'failed' : 'completed', inputLowWater: job.inputLowWater,
        requestedHighWater: job.inputHighWater, processedHighWater: job.inputHighWater,
        examinedEvents: 1, findings: 0
      }] });
    }
    learning.close();
    const report = JSON.parse(runCli(['analysis', 'report', '--repository-id', 'repo-coverage-total', '--schema-version', '2', '--json', '--data-dir', dataDir]).stdout) as { analysis: { state: string; coverage: { total: number; truncated: boolean; detectors: unknown[] } } };
    assert.equal(report.analysis.state, 'failed');
    assert.equal(report.analysis.coverage.total, 65);
    assert.equal(report.analysis.coverage.truncated, true);
    assert.equal(report.analysis.coverage.detectors.length, 64);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('initializes an idempotent workspace configuration without replacing a valid ID', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ael-workspace-init-'));
  try {
    const first = runCli(['init', '--workspace-id', 'explicit-workspace', '--json'], { workingDirectory: workspace });
    assert.equal(first.exitCode, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), { kind: 'workspace', id: 'explicit-workspace' });

    const repeated = runCli(['init', '--workspace-id', 'replacement-workspace', '--json'], { workingDirectory: workspace });
    assert.equal(repeated.exitCode, 0, repeated.stderr);
    assert.deepEqual(JSON.parse(repeated.stdout), { kind: 'workspace', id: 'explicit-workspace' });
    assert.deepEqual(JSON.parse(readFileSync(join(workspace, '.ael', 'workspace.json'), 'utf8')), { version: 1, workspaceId: 'explicit-workspace' });
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('returns a bounded error for malformed workspace configuration', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ael-workspace-invalid-'));
  try {
    mkdirSync(join(workspace, '.ael'));
    writeFileSync(join(workspace, '.ael', 'workspace.json'), '{bad json');
    const result = runCli(['init', '--json'], { workingDirectory: workspace });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(JSON.parse(result.stdout), { error: { code: 'WORKSPACE_INITIALIZATION_FAILED', message: 'Workspace initialization failed.' } });
    assert.equal(result.stdout.includes(workspace), false);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('initializes a repository when its hook scope is explicit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-init-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-init-data-'));
  const terminal = { write() {}, async readLine() { return '2'; } };
  try {
    initializeGitRepository(root);
    assert.equal(runCli(['init', '--data-dir', dataDir, '--json'], { workingDirectory: root }).exitCode, 0);
    const result = await runCliAsync(['init', '--scope', 'repo', '--hooks', 'codex,cursor', '--data-dir', dataDir, '--json'], { terminal, workingDirectory: root, cliEntrypoint: join(process.cwd(), 'dist', 'src', 'cli.js') });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(runCli(['init', '--scope', 'repo', '--hooks', 'codex', '--data-dir', dataDir, '--json'], { workingDirectory: root, cliEntrypoint: join(process.cwd(), 'dist', 'src', 'cli.js') }).exitCode, 0);
    const global = runCli(['status-global', '--data-dir', dataDir, '--json']);
    assert.equal(global.exitCode, 0);
    const report = JSON.parse(global.stdout) as { repositories: Array<{ selectedSources: string[]; status: string }> };
    assert.deepEqual(report.repositories.map((repository) => repository.selectedSources), [['codex', 'cursor']]);
    assert.deepEqual(report.repositories.map((repository) => repository.status), ['ready']);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('initializes a non-Git workspace with hooks and reports it as ready', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-init-workspace-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-init-workspace-data-'));
  try {
    const initialized = runCli(
      ['init', '--scope', 'workspace', '--hooks', 'codex,cursor', '--data-dir', dataDir, '--json'],
      { workingDirectory: root, cliEntrypoint: join(process.cwd(), 'dist', 'src', 'cli.js') }
    );
    assert.equal(initialized.exitCode, 0, initialized.stderr);

    const report = JSON.parse(runCli(['status-global', '--data-dir', dataDir, '--json']).stdout) as {
      repositories: Array<{ repository: { id: string; root: string }; selectedSources: string[]; status: string }>;
    };
    assert.equal(report.repositories.length, 1);
    assert.equal(report.repositories[0]?.repository.root, realpathSync(root));
    assert.match(report.repositories[0]?.repository.id ?? '', /^ael-init-workspace-[a-z0-9]+$/);
    assert.deepEqual(report.repositories[0]?.selectedSources, ['codex', 'cursor']);
    assert.equal(report.repositories[0]?.status, 'ready');
    const wrapper = readFileSync(join(root, '.agents', 'hooks', 'ael-passive-capture.sh'), 'utf8');
    assert.equal(wrapper.includes(`--repository-id "${report.repositories[0]?.repository.id}"`), true);
    assert.equal(wrapper.includes('git rev-parse'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('unregisters a stale repository from the global status report', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-unregister-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-unregister-data-'));
  try {
    initializeGitRepository(root);
    const initialized = runCli(
      ['init', '--scope', 'repo', '--hooks', 'cursor', '--data-dir', dataDir, '--json'],
      { workingDirectory: root, cliEntrypoint: join(process.cwd(), 'dist', 'src', 'cli.js') }
    );
    assert.equal(initialized.exitCode, 0, initialized.stderr);
    const before = JSON.parse(runCli(['status-global', '--data-dir', dataDir, '--json']).stdout) as {
      repositories: Array<{ repository: { id: string } }>;
    };
    const repositoryId = before.repositories[0]!.repository.id;

    const removed = runCli(['unregister', '--repository-id', repositoryId, '--data-dir', dataDir, '--json']);
    assert.equal(removed.exitCode, 0, removed.stderr);
    assert.deepEqual(JSON.parse(removed.stdout), { repositoryId, removed: true });
    const after = JSON.parse(runCli(['status-global', '--data-dir', dataDir, '--json']).stdout) as { repositories: unknown[] };
    assert.deepEqual(after.repositories, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('keeps a moved registered repository in the global status report', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-status-moved-'));
  const moved = `${root}-moved`;
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-status-data-'));
  try {
    initializeGitRepository(root);
    assert.equal(runCli(['init', '--scope', 'repo', '--hooks', 'cursor', '--data-dir', dataDir, '--json'], { workingDirectory: root, cliEntrypoint: join(process.cwd(), 'dist', 'src', 'cli.js') }).exitCode, 0);
    renameSync(root, moved);
    const report = JSON.parse(runCli(['status-global', '--data-dir', dataDir, '--json']).stdout) as { repositories: Array<{ status: string }> };
    assert.deepEqual(report.repositories.map((repository) => repository.status), ['not-ready']);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
