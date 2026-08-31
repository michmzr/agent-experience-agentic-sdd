import assert from 'node:assert/strict';
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
