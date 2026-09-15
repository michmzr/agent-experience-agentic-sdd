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
      stderr: [
        'Error  [failed]',
        '',
        `Message    Unsupported option: --${option}.`,
        'Code       INVALID_SYNTAX',
        'Next step  Run `ael --help` to inspect supported command forms.',
        ''
      ].join('\n')
    });
  }
});

test('routes review commands when options precede the command', async () => {
  const result = await runCliAsync([
    '--json', 'review', 'sessions', '--source', 'codex', '--root', '/unused', '--session', 'session-123'
  ]);

  assert.equal(result.exitCode, 2);
  assert.deepEqual(JSON.parse(result.stdout), {
    error: { code: 'INVALID_SYNTAX', message: 'Unsupported option: --session.' }
  });
});
