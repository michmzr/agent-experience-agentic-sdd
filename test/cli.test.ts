import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli, runCliAsync } from '../src/cli.js';
import { CaptureSpool } from '../src/capture/spool.js';
import { OperationalLearningRepository } from '../src/learning/repository.js';
import { normalizeMappedCapture } from '../src/capture/normalization.js';
import { ExperienceStore } from '../src/storage/experience-store.js';
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
      schemaVersion: number; installation: { state: string }; delivery: { state: string }; dataQuality: { state: string; denominator: { state: string } }; analysis: { state: string; result: string };
    };
    assert.equal(initial.schemaVersion, 2);
    assert.equal(initial.installation.state, 'not-ready');
    assert.equal(initial.delivery.state, 'unknown');
    assert.equal(initial.dataQuality.state, 'not-applicable');
    assert.equal(initial.dataQuality.denominator.state, 'unavailable');
    assert.equal(initial.analysis.state, 'not-run');
    assert.equal(initial.analysis.result, 'unavailable');

    const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
    spool.admitWithReceipt({ kind: 'session-start', session: { source: 'codex', id: 'session-health' as never, startedAt: '2026-09-13T08:00:00.000Z', repositoryId: 'repo-health' as never } }, { source: 'codex', receivedAt: '2026-09-13T08:00:00.000Z' });
    spool.close();
    const learning = new OperationalLearningRepository(join(dataDir, 'experience.sqlite'));
    learning.enqueue({ repositoryId: 'repo-health', sessionId: 'session-health', inputHighWater: 3 });
    learning.close();

    const pending = JSON.parse(runCli(['status', '--repository-id', 'repo-health', '--schema-version', '2', '--json', '--data-dir', dataDir]).stdout) as {
      delivery: { state: string }; dataQuality: { receipts: { accepted: number } }; analysis: { state: string; desiredThrough: number; completedThrough: number; result: string };
    };
    assert.equal(pending.delivery.state, 'backlogged');
    assert.equal(pending.dataQuality.receipts.accepted, 1);
    assert.equal(pending.analysis.state, 'pending');
    assert.equal(pending.analysis.desiredThrough, 3);
    assert.equal(pending.analysis.completedThrough, 0);
    assert.equal(pending.analysis.result, 'unavailable');
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
      dataQuality: { state: string; results: { linked: number; unknown: Record<string, number> }; observedTimeRange: { first: string; last: string } }; analysis: { state: string };
    };
    assert.equal(unknown.dataQuality.state, 'degraded');
    assert.deepEqual(unknown.dataQuality.results, { linked: 0, unknown: { 'result-not-delivered': 1 } });
    assert.deepEqual(unknown.dataQuality.observedTimeRange, { first: '2026-09-13T09:00:00.000Z', last: '2026-09-13T09:00:00.000Z' });
    assert.equal(unknown.analysis.state, 'not-run');

    const learning = new OperationalLearningRepository(join(dataDir, 'experience.sqlite'));
    learning.enqueue({ repositoryId, sessionId: 'session-quality', inputHighWater: 2 });
    const job = learning.claim(repositoryId)!;
    learning.saveResult(job.id, { episodes: [], findings: [], candidates: [], coverage: [{ detector: 'm6-deterministic@1', status: 'completed', examinedEvents: 2, findings: 0 }], cost: 3 }, job.leaseToken);
    learning.close();
    const complete = JSON.parse(runCli(['analysis', 'report', '--repository-id', repositoryId, '--schema-version', '2', '--json', '--data-dir', dataDir]).stdout) as {
      schemaVersion: number; analysis: { state: string; result: string; cost: { completedRuns: number; total: number }; range: { from: number; through: number } };
    };
    assert.equal(complete.schemaVersion, 2);
    assert.equal(complete.analysis.state, 'completed');
    assert.equal(complete.analysis.result, 'no-findings');
    assert.deepEqual(complete.analysis.cost, { completedRuns: 1, total: 3 });
    assert.deepEqual(complete.analysis.range, { from: 1, through: 2 });

    const global = runCli(['status-global', '--schema-version', '2', '--json', '--data-dir', dataDir]).stdout;
    assert.equal(global.includes(dataDir), false);
    assert.equal(global.includes('experience.sqlite'), false);
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
