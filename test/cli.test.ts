import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli.js';

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
