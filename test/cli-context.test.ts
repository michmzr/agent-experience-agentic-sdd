import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { after, test } from 'node:test';

import { resolveCliContext } from '../src/cli/context.js';
import { removeTemporaryDirectory } from '../src/cli/temporary-directory.js';
import { runCli } from '../src/cli.js';
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

  const result = runCli(['unregister', '--json'], { workingDirectory: nested });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(JSON.parse(result.stdout), { error: {
    code: 'WORKSPACE_CONFIGURATION_ERROR',
    message: 'Diagnostic workspace configuration is invalid.'
  } });
});

test('rejects a symlinked workspace metadata directory', () => {
  const root = temporaryDirectory('ael-cli-symlink-context-');
  const external = temporaryDirectory('ael-cli-symlink-target-');
  configureWorkspace(external, 'external-workspace');
  symlinkSync(join(external, '.ael'), join(root, '.ael'));

  assert.throws(() => resolveCliContext(root), /workspace configuration is invalid/i);
});

test('defaults repository-scoped commands to a configured workspace identity', () => {
  const workspace = temporaryDirectory('ael-cli-command-workspace-');
  const nested = join(workspace, 'src');
  const dataDirectory = temporaryDirectory('ael-cli-command-data-');
  mkdirSync(nested);
  configureWorkspace(workspace, 'configured-workspace');
  assert.equal(runCli(['init', '--scope', 'global', '--data-dir', dataDirectory]).exitCode, 0);

  const unregister = runCli(['unregister', '--json', '--data-dir', dataDirectory], { workingDirectory: nested });
  const lessons = runCli(['lessons', 'list', '--scope', 'repo', '--json', '--data-dir', dataDirectory], { workingDirectory: nested });
  const retrieve = runCli(['retrieve', '--scope', 'repo', '--json', '--data-dir', dataDirectory], { workingDirectory: nested });
  const exported = runCli(['export', '--scope', 'repo', '--json', '--data-dir', dataDirectory], { workingDirectory: nested });
  const diagnostics = runCli(['hooks', 'diagnostics', '--json', '--data-dir', dataDirectory], { workingDirectory: nested });

  assert.deepEqual(JSON.parse(unregister.stdout), { repositoryId: 'configured-workspace', removed: false });
  assert.deepEqual(JSON.parse(lessons.stdout), []);
  assert.deepEqual(JSON.parse(retrieve.stdout), []);
  assert.deepEqual(JSON.parse(exported.stdout).knowledge, []);
  assert.deepEqual(JSON.parse(diagnostics.stdout).scope, { kind: 'workspace', id: 'configured-workspace' });
  assert.equal(existsSync(join(nested, '.ael')), false);
});

test('diagnostics prefer a nested workspace over its outer Git repository', () => {
  const repository = temporaryDirectory('ael-cli-diagnostic-outer-git-');
  const workspace = join(repository, 'packages', 'workspace');
  const nested = join(workspace, 'src');
  const dataDirectory = temporaryDirectory('ael-cli-diagnostic-outer-git-data-');
  initializeGitRepository(repository);
  mkdirSync(nested, { recursive: true });
  configureWorkspace(workspace, 'nested-workspace');

  const diagnostics = runCli(['experience', 'inspect', '--json', '--data-dir', dataDirectory], { workingDirectory: nested });

  assert.equal(diagnostics.exitCode, 0, diagnostics.stderr);
  assert.deepEqual(JSON.parse(diagnostics.stdout).scope, { kind: 'workspace', id: 'nested-workspace' });
  assert.equal(existsSync(join(nested, '.ael')), false);
});

test('explicit diagnostic paths resolve to their nearest configured workspace', () => {
  const workspace = temporaryDirectory('ael-cli-explicit-diagnostic-workspace-');
  const nested = join(workspace, 'src');
  const dataDirectory = temporaryDirectory('ael-cli-explicit-diagnostic-data-');
  mkdirSync(nested);
  configureWorkspace(workspace, 'explicit-workspace');

  const diagnostics = runCli([
    'hooks', 'diagnostics', '--repository', nested, '--json', '--data-dir', dataDirectory
  ]);

  assert.equal(diagnostics.exitCode, 0, diagnostics.stderr);
  assert.deepEqual(JSON.parse(diagnostics.stdout).scope, { kind: 'workspace', id: 'explicit-workspace' });
  assert.equal(existsSync(join(nested, '.ael')), false);
});

test('reports malformed workspace metadata from an explicit diagnostic path', () => {
  const workspace = temporaryDirectory('ael-cli-explicit-invalid-workspace-');
  const nested = join(workspace, 'src');
  const dataDirectory = temporaryDirectory('ael-cli-explicit-invalid-data-');
  mkdirSync(nested);
  mkdirSync(join(workspace, '.ael'));
  writeFileSync(join(workspace, '.ael', 'workspace.json'), '{broken');

  const diagnostics = runCli([
    'experience', 'inspect', '--repository', nested, '--json', '--data-dir', dataDirectory
  ]);

  assert.equal(diagnostics.exitCode, 1);
  assert.deepEqual(JSON.parse(diagnostics.stdout), {
    error: {
      code: 'WORKSPACE_CONFIGURATION_ERROR',
      message: 'Diagnostic workspace configuration is invalid.'
    }
  });
  assert.equal(existsSync(join(nested, '.ael')), false);
});

test('defaults path and identity commands to Git context from a nested directory', () => {
  const repository = temporaryDirectory('ael-cli-command-git-');
  const nested = join(repository, 'src');
  const dataDirectory = temporaryDirectory('ael-cli-command-git-data-');
  const missingInput = join(repository, 'missing.json');
  initializeGitRepository(repository);
  mkdirSync(nested);
  assert.equal(runCli(['init', '--scope', 'global', '--data-dir', dataDirectory]).exitCode, 0);

  const analysisRun = runCli(['analysis', 'run', '--json', '--data-dir', dataDirectory], { workingDirectory: nested });
  const analysisReport = runCli(['analysis', 'report', '--json', '--data-dir', dataDirectory], { workingDirectory: nested });
  const validation = runCli(['knowledge', 'validate', '--json', '--data-dir', dataDirectory], { workingDirectory: nested });
  const promotion = runCli(['knowledge', 'promote', '--input', missingInput, '--json', '--data-dir', dataDirectory], { workingDirectory: nested });
  const refresh = runCli(['knowledge', 'refresh-runtime', '--trusted-ref', 'HEAD', '--json', '--data-dir', dataDirectory], { workingDirectory: nested });

  for (const result of [analysisRun, analysisReport, validation, promotion, refresh]) {
    assert.notEqual(result.exitCode, 2, result.stderr || result.stdout);
    assert.doesNotMatch(result.stderr || result.stdout, /Option is required: --(?:repository|repository-id)/);
  }
});

test('keeps explicit context ahead of workspace discovery and preserves inferred JSON', () => {
  const workspace = temporaryDirectory('ael-cli-explicit-workspace-');
  const nested = join(workspace, 'nested');
  const inferredData = temporaryDirectory('ael-cli-inferred-data-');
  const explicitData = temporaryDirectory('ael-cli-explicit-data-');
  mkdirSync(nested);
  configureWorkspace(workspace, 'configured-workspace');

  const explicit = runCli(['unregister', '--repository-id', 'explicit-repository', '--json', '--data-dir', explicitData], { workingDirectory: nested });
  assert.deepEqual(JSON.parse(explicit.stdout), { repositoryId: 'explicit-repository', removed: false });

  const inferred = runCli(['runtime', 'config', 'explain', '--json', '--data-dir', inferredData], { workingDirectory: nested });
  const selected = runCli(['runtime', 'config', 'explain', '--workspace', workspace, '--json', '--data-dir', explicitData], { workingDirectory: nested });
  assert.equal(inferred.stdout, selected.stdout);
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
