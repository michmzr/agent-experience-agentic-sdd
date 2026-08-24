import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { runCliAsync } from '../src/cli.js';
import { initializeGitRepository } from './helpers/git-repository.js';

const occurredAt = '2026-08-24T10:00:00.000Z';

test('rejects an interactive artifact from a different repository with the same basename', async () => {
  const left = gitRepository('ael-repository-left-', 'shared');
  const right = gitRepository('ael-repository-right-', 'shared');
  writeSession(right);
  const root = right;
  let terminalUsed = false;

  const result = await runCliAsync(
    ['review', 'session', '--source', 'codex', '--root', root, '--interactive', '--repository', basename(left), '--session', 'latest', '--json'],
    { terminal: terminalThatMustNotRun(() => { terminalUsed = true; }) }
  );

  assert.equal(result.exitCode, 1);
  assert.equal(terminalUsed, false);
  assert.equal(result.stdout.includes(left), false);
  assert.equal(result.stdout.includes(right), false);
  assert.equal(result.stdout.includes(root), false);

  const differentCanonicalRepository = await runCliAsync(
    ['review', 'session', '--source', 'codex', '--root', root, '--interactive', '--repository', left, '--session', 'latest', '--json'],
    { terminal: terminalThatMustNotRun(() => {}) }
  );
  assert.equal(differentCanonicalRepository.exitCode, 1);
  assert.equal(differentCanonicalRepository.stdout.includes(left), false);
  assert.equal(differentCanonicalRepository.stdout.includes(right), false);
});

test('rejects non-Git and nested-repository artifacts from interactive repository scope', async () => {
  const repository = gitRepository('ael-repository-outer-', 'outer');
  const nestedRepository = gitRepositoryAt(join(repository, 'nested'));
  const nestedRoot = sessionRoot(nestedRepository);
  const nonGitRoot = join(mkdtempSync(join(tmpdir(), 'ael-no-repository-')), 'sessions');
  mkdirSync(nonGitRoot);
  writeSession(nonGitRoot);

  for (const root of [nestedRoot, nonGitRoot]) {
    const result = await runCliAsync(
      ['review', 'session', '--source', 'codex', '--root', root, '--interactive', '--repository', repository, '--session', 'latest', '--json'],
      { terminal: terminalThatMustNotRun(() => {}) }
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout.includes(repository), false);
    assert.equal(result.stdout.includes(root), false);
  }
});

test('canonicalizes a nested repository path and completes actual CLI latest selection', async () => {
  const repository = gitRepository('ael-repository-success-', 'repo');
  const requestedRepository = join(repository, 'packages', 'app');
  mkdirSync(requestedRepository, { recursive: true });
  const root = sessionRoot(repository);
  const output: string[] = [];

  const result = await runCliAsync(
    ['review', 'session', '--source', 'codex', '--root', root, '--interactive', '--repository', requestedRepository, '--session', 'latest', '--json'],
    { terminal: {
      write(value) { output.push(value); },
      async readLine(prompt) { output.push(prompt); return 'yes'; }
    } }
  );

  assert.equal(result.exitCode, 0);
  assert.match(output.join(''), /Run review for latest\.jsonl\?/);
  assert.equal(result.stdout.includes(repository), false);
  assert.equal(result.stdout.includes(root), false);
});

test('accepts a valid Git worktree gitfile as a canonical repository boundary', async () => {
  const repository = gitRepository('ael-repository-primary-', 'repo');
  const worktree = join(mkdtempSync(join(tmpdir(), 'ael-repository-worktree-')), 'repo-worktree');
  execFileSync('git', ['-C', repository, 'worktree', 'add', '--quiet', '--detach', worktree], { stdio: 'ignore' });
  const root = sessionRoot(worktree);

  const result = await runCliAsync(
    ['review', 'session', '--source', 'codex', '--root', root, '--interactive', '--repository', worktree, '--session', 'latest', '--json'],
    { terminal: { write() {}, async readLine() { return 'yes'; } } }
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.includes(worktree), false);
  assert.equal(result.stdout.includes(repository), false);
});

test('public discovery exposes identifiers and recency but no repository identity or path', async () => {
  const repository = gitRepository('ael-repository-public-', 'repo');
  const root = sessionRoot(repository);

  const result = await runCliAsync(['review', 'sessions', '--source', 'codex', '--root', root, '--json']);

  assert.equal(result.exitCode, 0);
  const [descriptor] = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
  assert.deepEqual(Object.keys(descriptor ?? {}).sort(), ['id', 'source', 'updatedAt']);
  assert.equal(result.stdout.includes(repository), false);
  assert.equal(result.stdout.includes(root), false);
  assert.equal(result.stdout.includes('repositoryHint'), false);
});

test('rejects a symlinked artifact root without exposing either filesystem path', async () => {
  const repository = gitRepository('ael-repository-symlink-', 'repo');
  const realRoot = sessionRoot(repository);
  const linkedRoot = join(mkdtempSync(join(tmpdir(), 'ael-linked-root-')), 'sessions');
  symlinkSync(realRoot, linkedRoot);

  const result = await runCliAsync(
    ['review', 'session', '--source', 'codex', '--root', linkedRoot, '--interactive', '--repository', repository, '--session', 'latest', '--json'],
    { terminal: terminalThatMustNotRun(() => {}) }
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout.includes(repository), false);
  assert.equal(result.stdout.includes(realRoot), false);
  assert.equal(result.stdout.includes(linkedRoot), false);
});

function gitRepository(prefix: string, name: string): string {
  const parent = mkdtempSync(join(tmpdir(), prefix));
  return gitRepositoryAt(join(parent, name));
}

function gitRepositoryAt(repository: string): string {
  mkdirSync(repository, { recursive: true });
  initializeGitRepository(repository);
  return repository;
}

function sessionRoot(repository: string): string {
  const root = join(repository, '.review-sessions');
  mkdirSync(root);
  writeSession(root);
  return root;
}

function writeSession(root: string): void {
  writeFileSync(join(root, 'latest.jsonl'), `${JSON.stringify({ kind: 'message', occurredAt, text: `Review ${basename(root)}` })}\n`);
}

function terminalThatMustNotRun(markUsed: () => void) {
  return {
    write() { markUsed(); },
    async readLine() { markUsed(); return 'yes'; }
  };
}
