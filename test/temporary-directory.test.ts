import assert from 'node:assert/strict';
import test from 'node:test';

import { removeTemporaryDirectory } from '../src/cli/temporary-directory.js';

test('retries transient directory removal while a detached hook is finishing', async () => {
  let attempts = 0;
  const delays: number[] = [];

  await removeTemporaryDirectory('/tmp/ael-test-directory', {
    remove: () => {
      attempts += 1;
      if (attempts < 3) throw filesystemError('ENOTEMPTY');
    },
    delay: async (milliseconds) => { delays.push(milliseconds); }
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 10]);
});

test('does not retry a non-transient directory removal failure', async () => {
  let attempts = 0;

  await assert.rejects(
    removeTemporaryDirectory('/tmp/ael-test-directory', {
      remove: () => {
        attempts += 1;
        throw filesystemError('EACCES');
      },
      delay: async () => { throw new Error('delay must not run'); }
    }),
    { code: 'EACCES' }
  );

  assert.equal(attempts, 1);
});

test('bounds retries for a persistent transient directory removal failure', async () => {
  let attempts = 0;

  await assert.rejects(
    removeTemporaryDirectory('/tmp/ael-test-directory', {
      remove: () => {
        attempts += 1;
        throw filesystemError('ENOTEMPTY');
      },
      delay: async () => undefined
    }),
    { code: 'ENOTEMPTY' }
  );

  assert.equal(attempts, 21);
});

function filesystemError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
