import assert from 'node:assert/strict';
import test from 'node:test';

import { runCliAsync } from '../src/cli.js';

test('rejects the non-interactive latest session selector before loading a session', async () => {
  const result = await runCliAsync(['review', 'session', '--source', 'codex', '--root', '/unused', '--session', 'latest']);

  assert.deepEqual(result, {
    exitCode: 2,
    stdout: '',
    stderr: 'INVALID_SYNTAX: Session selector latest is not supported.\n'
  });
});
