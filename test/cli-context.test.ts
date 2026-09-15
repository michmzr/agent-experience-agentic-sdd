import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { after, test } from 'node:test';

import { resolveCliContext } from '../src/cli/context.js';
import { removeTemporaryDirectory } from '../src/cli/temporary-directory.js';
import { initializeGitRepository } from './helpers/git-repository.js';

const temporaryDirectories: string[] = [];

after(async () => {
  for (const directory of temporaryDirectories.reverse()) await removeTemporaryDirectory(directory);
});

test('uses the nearest configured workspace from a nested directory before Git', () => {
  const root = temporaryDirectory('ael-cli-context-');
  const nested = join(root, 'packages', 'app');
  initializeGitRepository(root);
  mkdirSync(nested, { recursive: true });
  configureWorkspace(root, 'configured-workspace');

  assert.deepEqual(resolveCliContext(nested), {
    scope: 'workspace',
    id: 'configured-workspace',
    root: normalize(realpathSync(root))
  });
});

test('prefers the nearest configured workspace over a configured parent', () => {
  const root = temporaryDirectory('ael-cli-nearest-context-');
  const child = join(root, 'child');
  const nested = join(child, 'src');
  mkdirSync(nested, { recursive: true });
  configureWorkspace(root, 'parent-workspace');
  configureWorkspace(child, 'child-workspace');

  assert.deepEqual(resolveCliContext(nested), {
    scope: 'workspace',
    id: 'child-workspace',
    root: normalize(realpathSync(child))
  });
});

test('falls back to canonical Git context when no workspace is configured', () => {
  const root = temporaryDirectory('ael-cli-git-context-');
  const nested = join(root, 'src');
  initializeGitRepository(root);
  mkdirSync(nested);

  const context = resolveCliContext(nested);

  assert.equal(context?.scope, 'repository');
  assert.equal(context?.root, normalize(realpathSync(root)));
  assert.match(context?.id ?? '', /^[a-f0-9]{64}$/);
});

test('returns undefined outside configured workspace and Git without creating metadata', () => {
  const root = temporaryDirectory('ael-cli-no-context-');

  assert.equal(resolveCliContext(root), undefined);
});

test('rejects malformed nearest workspace metadata instead of falling back to Git', () => {
  const root = temporaryDirectory('ael-cli-invalid-context-');
  const nested = join(root, 'src');
  initializeGitRepository(root);
  mkdirSync(nested);
  mkdirSync(join(root, '.ael'));
  writeFileSync(join(root, '.ael', 'workspace.json'), '{broken');

  assert.throws(() => resolveCliContext(nested), /workspace configuration is invalid/i);
});

test('rejects a symlinked workspace metadata directory', () => {
  const root = temporaryDirectory('ael-cli-symlink-context-');
  const external = temporaryDirectory('ael-cli-symlink-target-');
  configureWorkspace(external, 'external-workspace');
  symlinkSync(join(external, '.ael'), join(root, '.ael'));

  assert.throws(() => resolveCliContext(root), /workspace configuration is invalid/i);
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function configureWorkspace(root: string, workspaceId: string): void {
  mkdirSync(join(root, '.ael'));
  writeFileSync(join(root, '.ael', 'workspace.json'), `${JSON.stringify({ version: 1, workspaceId })}\n`);
}
