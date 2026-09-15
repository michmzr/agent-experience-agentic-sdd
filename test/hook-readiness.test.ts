import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { verifyHookReadiness } from '../src/cli/hook-readiness.js';
import { runCliAsync } from '../src/cli.js';

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), 'ael-hook-readiness-test-'));
}

test('verifies both project hook sources without using the default database', async () => {
  const root = temporaryRoot();
  try {
    const result = await verifyHookReadiness({ worktreePath: process.cwd(), temporaryRoot: root });
    assert.deepEqual(result, {
      status: 'ready',
      sources: [
        { source: 'codex', status: 'ready' },
        { source: 'cursor', status: 'ready' }
      ]
    });
    assert.equal(existsSync(root), true);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exposes worktree readiness through the CLI', async () => {
  const root = temporaryRoot();
  try {
    assert.deepEqual(await runCliAsync(['hooks', 'verify', '--worktree', process.cwd()]), {
      exitCode: 0,
      stdout: 'Hook readiness  [ready]\n\nSources  codex, cursor\n',
      stderr: ''
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('routes hook verification when options precede the command', async () => {
  const result = await runCliAsync(['--worktree', process.cwd(), '--json', 'hooks', 'verify']);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'ready',
    sources: [
      { source: 'codex', status: 'ready' },
      { source: 'cursor', status: 'ready' }
    ]
  });
});

test('keeps syntax exit code 2 for asynchronous hook verification', async () => {
  const human = await runCliAsync(['hooks', 'verify']);
  const json = await runCliAsync(['hooks', 'verify', '--json']);

  assert.equal(human.exitCode, 2);
  assert.match(human.stderr, /^Code\s+INVALID_SYNTAX$/m);
  assert.equal(json.exitCode, 2);
  assert.equal(JSON.parse(json.stdout).error.code, 'INVALID_SYNTAX');
});
