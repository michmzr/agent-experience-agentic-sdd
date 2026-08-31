import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
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

test('requires explicit hook selection without a terminal and installs an interactive multi-selection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-init-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-init-data-'));
  const terminal = { write() {}, async readLine() { return '2'; } };
  try {
    initializeGitRepository(root);
    assert.equal(runCli(['init', '--data-dir', dataDir, '--json']).exitCode, 2);
    const result = await runCliAsync(['init', '--data-dir', dataDir, '--json'], { terminal, workingDirectory: root, cliEntrypoint: join(process.cwd(), 'dist', 'src', 'cli.js') });
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
