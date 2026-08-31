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

test('selects default v2 implicitly while retaining explicit default v1 compatibility', async () => {
  const root = codexSessionRoot();
  const selected = await runCliAsync(['review', 'session', '--source', 'codex', '--root', root, '--session', 'session.jsonl', '--profile', 'default@1', '--json']);
  const defaultSelected = await runCliAsync(['review', 'session', '--source', 'codex', '--root', root, '--session', 'session.jsonl', '--json']);
  const v2Selected = await runCliAsync(['review', 'session', '--source', 'codex', '--root', root, '--session', 'session.jsonl', '--profile', 'default@2', '--json']);

  assert.equal(selected.exitCode, 0);
  assert.deepEqual(JSON.parse(selected.stdout).profile, { id: 'default', version: '1' });
  assert.equal(defaultSelected.exitCode, 0);
  assert.deepEqual(JSON.parse(defaultSelected.stdout).profile, { id: 'default', version: '2' });
  assert.equal(v2Selected.exitCode, 0);
  assert.deepEqual(JSON.parse(v2Selected.stdout).profile, { id: 'default', version: '2' });

  for (const profile of ['default@3', 'unknown@1']) {
    const unknown = await runCliAsync(['review', 'session', '--source', 'codex', '--root', root, '--session', 'session.jsonl', '--profile', profile, '--json']);
    assert.deepEqual(JSON.parse(unknown.stdout), { error: { code: 'REVIEW_ERROR', message: 'Review failed.' } }, profile);
    assert.equal(unknown.exitCode, 1, profile);
  }
});
