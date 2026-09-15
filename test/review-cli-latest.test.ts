import assert from 'node:assert/strict';
import test from 'node:test';

import { runCliAsync } from '../src/cli.js';

test('rejects the latest session selector outside the interactive repository-scoped flow', async () => {
  const result = await runCliAsync(['review', 'session', '--source', 'codex', '--root', '/unused', '--session', 'latest']);

  assert.deepEqual(result, {
    exitCode: 2,
    stdout: '',
    stderr: [
      'Error',
      '',
      'Message    Interactive repository scope is required for session selection.',
      'Code       INVALID_SYNTAX',
      'Next step  Run `ael --help` to inspect supported command forms.',
      ''
    ].join('\n')
  });
});
