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

test('ACL-A4 accepted candidate is visible through public lessons and scoped retrieve', () => {
  const root = mkdtempSync(join(tmpdir(), 'acl-public-retrieve-'));
  try {
    const repository = new CandidateRepository(join(root, 'experience.sqlite'));
    const candidate = repository.register({ repositoryId: 'repo-a', kind: 'convention',
      statement: 'Use pnpm in package-a.', applicability: { scope: 'subproject', path: 'package-a' },
      propositionKey: 'package-manager', originId: 'origin-a', source: 'operational' });
    repository.review({ repositoryId: 'repo-a', candidateId: candidate.id, actorId: 'reviewer',
      target: 'observed', evidenceId: 'instruction-a', reviewedAt: '2026-09-30T10:00:00.000Z' },
    { id: 'instruction-a', repositoryId: 'repo-a', originId: 'session-a', kind: 'instruction-context' });
    repository.close();
    const invoke = (...args: string[]) => runCli([...args, '--data-dir', root, '--json']);
    const listed = JSON.parse(invoke('lessons', 'list', '--scope', 'repo', '--repository-id', 'repo-a').stdout);
    assert.equal(listed.some((item: { id: string }) => item.id === candidate.id), true);
    const matching = JSON.parse(invoke('retrieve', '--scope', 'repo', '--repository-id', 'repo-a', '--path', 'package-a').stdout);
    assert.equal(matching.some((item: { id: string }) => item.id === candidate.id), true);
    const wrong = JSON.parse(invoke('retrieve', '--scope', 'repo', '--repository-id', 'repo-a', '--path', 'package-b').stdout);
    assert.equal(wrong.some((item: { id: string }) => item.id === candidate.id), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
