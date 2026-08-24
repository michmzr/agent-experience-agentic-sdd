import assert from 'node:assert/strict';
import test from 'node:test';

import { runCli } from '../src/cli.js';

test('returns an error for an unknown command', () => {
  const result = runCli(['unknown']);

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Unknown command: unknown/);
});
