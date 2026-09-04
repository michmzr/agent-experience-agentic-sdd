import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { initializeDiagnosticWorkspace, resolveDiagnosticScope } from '../src/capture/diagnostic-scope.js';
import { resolveRepository } from '../src/repository/local-repository.js';
import { initializeGitRepository } from './helpers/git-repository.js';

function temporaryDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('returns the canonical repository identifier for a Git directory', () => {
  const repository = temporaryDirectory('ael-diagnostic-git-');
  const nested = join(repository, 'nested');
  initializeGitRepository(repository);
  mkdirSync(nested);

  const scope = resolveDiagnosticScope(nested);

  assert.deepEqual(scope, { kind: 'repository', id: resolveRepository(nested)?.id });
});

test('initializes a Git-trackable workspace configuration from the folder name', () => {
  const parent = temporaryDirectory('ael-diagnostic-workspace-parent-');
  const workspace = join(parent, 'Readable workspace');
  mkdirSync(workspace);

  const scope = resolveDiagnosticScope(workspace);
  const configPath = join(workspace, '.ael', 'workspace.json');
  const configuration = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;

  assert.deepEqual(scope, { kind: 'workspace', id: 'readable-workspace' });
  assert.deepEqual(configuration, { version: 1, workspaceId: 'readable-workspace' });
  assert.equal(lstatSync(join(workspace, '.ael')).mode & 0o777, 0o755);
  assert.equal(lstatSync(configPath).mode & 0o777, 0o644);
});

test('sets workspace configuration modes independently of a restrictive process umask', () => {
  const workspace = temporaryDirectory('ael-diagnostic-umask-workspace-');
  const originalUmask = process.umask(0o077);
  try {
    resolveDiagnosticScope(workspace);

    assert.equal(lstatSync(join(workspace, '.ael')).mode & 0o777, 0o755);
    assert.equal(lstatSync(join(workspace, '.ael', 'workspace.json')).mode & 0o777, 0o644);
  } finally {
    process.umask(originalUmask);
  }
});

test('initializes an explicit workspace ID without replacing valid configuration', () => {
  const workspace = temporaryDirectory('ael-diagnostic-explicit-workspace-');

  const initialized = initializeDiagnosticWorkspace(workspace, 'explicit-workspace');
  const repeated = initializeDiagnosticWorkspace(workspace, 'different-workspace');

  assert.deepEqual(initialized, { kind: 'workspace', id: 'explicit-workspace' });
  assert.deepEqual(repeated, initialized);
  assert.deepEqual(JSON.parse(readFileSync(join(workspace, '.ael', 'workspace.json'), 'utf8')), {
    version: 1,
    workspaceId: 'explicit-workspace'
  });
});

test('resolves a symlink and a moved workspace to the same stable scope', () => {
  const parent = temporaryDirectory('ael-diagnostic-workspace-parent-');
  const workspace = join(parent, 'workspace');
  const alias = join(parent, 'alias');
  const moved = join(parent, 'moved');
  mkdirSync(workspace);
  const scope = resolveDiagnosticScope(workspace);
  symlinkSync(workspace, alias);

  assert.deepEqual(resolveDiagnosticScope(alias), scope);
  renameSync(workspace, moved);
  assert.deepEqual(resolveDiagnosticScope(moved), scope);
});

test('retains a valid workspace configuration after Git initialization', () => {
  const workspace = temporaryDirectory('ael-diagnostic-git-workspace-');
  const scope = initializeDiagnosticWorkspace(workspace, 'stable-workspace');
  initializeGitRepository(workspace);

  assert.deepEqual(resolveDiagnosticScope(workspace), scope);
});

test('rejects a malformed existing workspace configuration without replacing it', () => {
  const configurations = [
    '{"version":1,"workspaceId":"not a slug"}',
    '{"version":1,"workspaceId":"valid-workspace","unexpected":true}',
    '{"version":1,"workspaceId":"-leading-hyphen"}',
    '{"version":1,"workspaceId":"trailing-hyphen-"}',
    '{"version":1,"workspaceId":"repeated--hyphen"}',
    '{"version":1,"workspaceId":"Uppercase-workspace"}',
    `{\"version\":1,\"workspaceId\":\"${'a'.repeat(65)}\"}`
  ];
  for (const configuration of configurations) {
    const workspace = temporaryDirectory('ael-diagnostic-invalid-configuration-');
    const configDirectory = join(workspace, '.ael');
    const configPath = join(configDirectory, 'workspace.json');
    mkdirSync(configDirectory, { mode: 0o755 });
    writeFileSync(configPath, configuration, { mode: 0o644 });

    assert.throws(() => resolveDiagnosticScope(workspace), /workspace configuration/i);
    assert.equal(readFileSync(configPath, 'utf8'), configuration);
  }
});

test('accepts a workspace ID at the 64-character boundary', () => {
  const workspace = temporaryDirectory('ael-diagnostic-max-workspace-id-');
  const workspaceId = 'a'.repeat(64);

  assert.deepEqual(initializeDiagnosticWorkspace(workspace, workspaceId), { kind: 'workspace', id: workspaceId });
});
