import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli.js';
import { CandidateRepository } from '../src/knowledge/candidate-repository.js';

test('ACL-A1 public candidate list and inspect retain typed origin after restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'acl-public-'));
  try {
    const repository = new CandidateRepository(join(root, 'experience.sqlite'));
    const candidate = repository.register({ repositoryId: 'repo-a', kind: 'convention',
      statement: 'Run pnpm for this repository.', applicability: { scope: 'repository' },
      propositionKey: 'use-pnpm', originId: 'origin-a', source: 'operational', sessionId: 'private-session-a' });
    repository.close();
    const invoke = (...args: string[]) => runCli(['candidates', ...args, '--data-dir', root, '--json']);
    const listed = invoke('list', '--repository-id', 'repo-a');
    assert.equal(listed.exitCode, 0);
    assert.deepEqual(JSON.parse(listed.stdout).map((item: { id: string }) => item.id), [candidate.id]);
    assert.equal(listed.stdout.includes('private-session-a'), false);
    assert.equal(JSON.parse(invoke('list', '--repository-id', 'repo-b').stdout).length, 0);
    const inspected = invoke('inspect', candidate.id, '--repository-id', 'repo-a');
    assert.equal(JSON.parse(inspected.stdout).kind, 'convention');
    assert.equal(inspected.stdout.includes('private-session-a'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
