import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCliAsync } from '../src/cli.js';

function codexSessionRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ael-review-profile-'));
  writeFileSync(join(root, 'session.jsonl'), `${JSON.stringify({ kind: 'message', occurredAt: '2026-08-24T10:00:00.000Z' })}\n`);
  return root;
}

test('selects the explicit default versioned review profile and rejects unknown identifiers or versions', async () => {
  const root = codexSessionRoot();
  const selected = await runCliAsync(['review', 'session', '--source', 'codex', '--root', root, '--session', 'session.jsonl', '--profile', 'default@1', '--json']);

  assert.equal(selected.exitCode, 0);
  assert.deepEqual(JSON.parse(selected.stdout).profile, { id: 'default', version: '1' });

  for (const profile of ['default@2', 'unknown@1']) {
    const unknown = await runCliAsync(['review', 'session', '--source', 'codex', '--root', root, '--session', 'session.jsonl', '--profile', profile, '--json']);
    assert.deepEqual(JSON.parse(unknown.stdout), { error: { code: 'REVIEW_ERROR', message: 'Review failed.' } }, profile);
    assert.equal(unknown.exitCode, 1, profile);
  }
});
