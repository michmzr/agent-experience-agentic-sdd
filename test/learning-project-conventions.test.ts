import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readProjectInstructionContext } from '../src/learning/project-conventions.js';
import { resolveRepository } from '../src/repository/local-repository.js';
import { initializeGitRepository } from './helpers/git-repository.js';

test('reads configured bounded instruction locations as context without claiming delivery or reading', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-instruction-context-'));
  mkdirSync(join(root, '.agents'));
  writeFileSync(join(root, '.agents', 'AGENTS.md'), 'Please use pnpm rather than npm for package commands.\n');

  const context = readProjectInstructionContext(root, { instructionLocations: ['.agents/AGENTS.md'] });

  assert.deepEqual(context.instructions.map(({ location, scope, found, delivered, explicitlyRead }) => ({ location, scope, found, delivered, explicitlyRead })), [
    { location: '.agents/AGENTS.md', scope: 'repository', found: true, delivered: 'unknown', explicitlyRead: 'unknown' }
  ]);
  assert.equal(context.instructions[0]?.digest.includes('pnpm'), false);
  assert.deepEqual(context.conventions.map(({ tool, replaces, source }) => ({ tool, replaces, source })), [
    { tool: 'pnpm', replaces: 'npm', source: '.agents/AGENTS.md:1' }
  ]);
});

test('keys repository families together while retaining distinct worktree identities', () => {
  const repository = mkdtempSync(join(tmpdir(), 'ael-context-primary-'));
  const worktree = join(mkdtempSync(join(tmpdir(), 'ael-context-worktree-')), 'linked');
  initializeGitRepository(repository);
  execFileSync('git', ['-C', repository, 'worktree', 'add', '--quiet', '--detach', worktree], { stdio: 'ignore' });

  const primary = resolveRepository(repository)!;
  const linked = resolveRepository(worktree)!;

  assert.notEqual(primary.id, linked.id);
  assert.equal(primary.repositoryFamilyKey, linked.repositoryFamilyKey);
  assert.notEqual(primary.worktreeKey, linked.worktreeKey);
  assert.equal(primary.root.includes(repository), true);
  assert.equal(primary.repositoryFamilyKey.includes(repository), false);
  assert.equal(primary.worktreeKey.includes(repository), false);
});
