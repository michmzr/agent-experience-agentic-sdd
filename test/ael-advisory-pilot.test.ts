import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AdvisoryConfigurationStore } from '../src/advice/configuration.js';

test('AAP-A1 advice is default-off and explicit repository revocation survives restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-advice-config-'));
  const path = join(root, 'advice.sqlite');
  try {
    const first = new AdvisoryConfigurationStore(path);
    assert.deepEqual(first.status('repo-a'), { enabled: false });
    assert.equal(existsSync(path), false);
    assert.deepEqual(first.setEnabled('repo-a', true), { enabled: true });
    assert.deepEqual(first.status('repo-b'), { enabled: false });
    const reopened = new AdvisoryConfigurationStore(path);
    assert.deepEqual(reopened.status('repo-a'), { enabled: true });
    assert.deepEqual(reopened.setEnabled('repo-a', false), { enabled: false });
    assert.deepEqual(new AdvisoryConfigurationStore(path).status('repo-a'), { enabled: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
