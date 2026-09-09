import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli, runCliAsync } from '../src/cli.js';
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
