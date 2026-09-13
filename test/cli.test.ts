import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli, runCliAsync } from '../src/cli.js';
import { OperationalLearningRepository } from '../src/learning/repository.js';
import { initializeGitRepository } from './helpers/git-repository.js';

test('returns an error for an unknown command', () => {
  const result = runCli(['unknown']);

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Unknown command\./);
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
    assert.match(human.stdout, /Scheduled retries: 1/);
    assert.match(human.stdout, /Failure attempts: execution-failure=1/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('bounds analysis worker configuration and internal argument errors without affecting passive capture', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-analysis-config-'));
  const marker = 'private-worker-token';
  try {
    writeFileSync(join(dataDir, 'analysis-worker.json'), `{\"version\":1,\"maxProcesses\":99,\"idleTimeoutMs\":300000,\"private\":\"${marker}\"}`);
    const worker = await runCliAsync(['analysis', 'worker', '--data-dir', dataDir]);
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
      '--worker-slot-id', marker, '--worker-slot-owner', 'owner', '--worker-slot-attempt', 'not-an-integer']);
    assert.equal(invalidChild.exitCode, 2);
    assert.equal(invalidChild.stdout, '');
    assert.match(invalidChild.stderr, /^INVALID_SYNTAX: Analysis worker arguments are invalid\.\n$/);
    assert.equal(invalidChild.stderr.includes(marker), false);

    const lostWatchdog = await runCliAsync(['analysis', 'worker-watchdog', '--data-dir', dataDir,
      '--worker-slot-id', '00000000-0000-4000-8000-000000000000', '--worker-slot-owner', 'owner', '--worker-slot-attempt', '1']);
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
