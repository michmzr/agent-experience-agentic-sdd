import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { verifyHookReadiness } from '../src/capture/hook-readiness.js';

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), 'ael-hook-readiness-test-'));
}

test('verifies both project hook sources without using the default database', () => {
  const root = temporaryRoot();
  try {
    const result = verifyHookReadiness({ worktreePath: process.cwd(), temporaryRoot: root });
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
