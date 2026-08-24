import assert from 'node:assert/strict';
import test from 'node:test';

import { runCliAsync } from '../src/cli.js';

test('rejects session-only options on review sessions with the standard invalid-invocation diagnostic', async () => {
  for (const [option, value] of [['session', 'session-123'], ['allow-expensive-checks', undefined]] as const) {
    const result = await runCliAsync([
      'review', 'sessions', '--source', 'codex', '--root', '/unused', `--${option}`,
      ...(value ? [value] : [])
    ]);

    assert.deepEqual(result, {
      exitCode: 2,
      stdout: '',
      stderr: `INVALID_SYNTAX: Unsupported option: --${option}.\n`
    });
  }
});
