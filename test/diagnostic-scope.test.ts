import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import test from 'node:test';

import { initializeDiagnosticWorkspace, resolveDiagnosticScope } from '../src/capture/diagnostic-scope.js';
import { resolveRepository } from '../src/repository/local-repository.js';
import { initializeGitRepository } from './helpers/git-repository.js';

function temporaryDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const scopeOptions = { dataDirectory: temporaryDirectory('ael-diagnostic-scope-data-') };

test('returns the canonical repository identifier for a Git directory', () => {
  const repository = temporaryDirectory('ael-diagnostic-git-');
  const nested = join(repository, 'nested');
  initializeGitRepository(repository);
  mkdirSync(nested);

  const scope = resolveDiagnosticScope(nested, scopeOptions);

  assert.deepEqual(scope, { kind: 'repository', id: resolveRepository(nested)?.id });
});

test('initializes a Git-trackable workspace configuration from the folder name', () => {
  const parent = temporaryDirectory('ael-diagnostic-workspace-parent-');
  const workspace = join(parent, 'Readable workspace');
  mkdirSync(workspace);

  const scope = resolveDiagnosticScope(workspace, scopeOptions);
  const configPath = join(workspace, '.ael', 'workspace.json');
  const configuration = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;

  assert.deepEqual(scope, { kind: 'workspace', id: 'readable-workspace' });
  assert.deepEqual(configuration, { version: 1, workspaceId: 'readable-workspace' });
  assert.equal(lstatSync(join(workspace, '.ael')).mode & 0o777, 0o755);
  assert.equal(lstatSync(configPath).mode & 0o777, 0o644);
});

test('keeps the first readable slug and disambiguates an equal basename with a persisted path hash', () => {
  const parent = temporaryDirectory('ael-diagnostic-collision-parent-');
  const dataDirectory = temporaryDirectory('ael-diagnostic-collision-data-');
  const first = join(parent, 'first', 'project');
  const second = join(parent, 'second', 'project');
  const moved = join(parent, 'moved-project');
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });

  const firstScope = resolveDiagnosticScope(first, { dataDirectory });
  const secondScope = resolveDiagnosticScope(second, { dataDirectory });
  const suffix = createHash('sha256').update(normalize(realpathSync(second))).digest('hex').slice(0, 8);
  const secondConfiguration = readFileSync(join(second, '.ael', 'workspace.json'), 'utf8');

  assert.deepEqual(firstScope, { kind: 'workspace', id: 'project' });
  assert.deepEqual(secondScope, { kind: 'workspace', id: `project-${suffix}` });
  assert.notDeepEqual(secondScope, firstScope);
  renameSync(second, moved);
  assert.deepEqual(resolveDiagnosticScope(moved, { dataDirectory }), secondScope);
  assert.equal(readFileSync(join(moved, '.ael', 'workspace.json'), 'utf8'), secondConfiguration);
});

test('rejects claim files whose raw content is not one hash followed by one newline', () => {
  const malformedClaims = [
    'a'.repeat(64),
    ` ${'a'.repeat(64)}\n`,
    `${'a'.repeat(64)}\n\n`,
    `${'g'.repeat(64)}\n`
  ];

  for (const claim of malformedClaims) {
    const parent = temporaryDirectory('ael-diagnostic-corrupt-claim-parent-');
    const dataDirectory = temporaryDirectory('ael-diagnostic-corrupt-claim-data-');
    const workspace = join(parent, 'project');
    const claimDirectory = join(dataDirectory, 'workspace-scope-claims');
    const claimPath = join(claimDirectory, 'project');
    mkdirSync(workspace);
    mkdirSync(claimDirectory);
    writeFileSync(claimPath, claim);

    assert.throws(
      () => resolveDiagnosticScope(workspace, { dataDirectory }),
      /claim registry/i
    );
    assert.equal(readFileSync(claimPath, 'utf8'), claim);
  }
});

test('sets workspace configuration modes independently of a restrictive process umask', () => {
  const workspace = temporaryDirectory('ael-diagnostic-umask-workspace-');
  const originalUmask = process.umask(0o077);
  try {
    resolveDiagnosticScope(workspace, scopeOptions);

    assert.equal(lstatSync(join(workspace, '.ael')).mode & 0o777, 0o755);
    assert.equal(lstatSync(join(workspace, '.ael', 'workspace.json')).mode & 0o777, 0o644);
  } finally {
    process.umask(originalUmask);
  }
});

test('initializes an explicit workspace ID without replacing valid configuration', () => {
  const workspace = temporaryDirectory('ael-diagnostic-explicit-workspace-');

  const initialized = initializeDiagnosticWorkspace(workspace, 'explicit-workspace', scopeOptions);
  const repeated = initializeDiagnosticWorkspace(workspace, 'different-workspace', scopeOptions);

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
  const scope = resolveDiagnosticScope(workspace, scopeOptions);
  symlinkSync(workspace, alias);

  assert.deepEqual(resolveDiagnosticScope(alias, scopeOptions), scope);
  renameSync(workspace, moved);
  assert.deepEqual(resolveDiagnosticScope(moved, scopeOptions), scope);
});

test('retains a valid workspace configuration after Git initialization', () => {
  const workspace = temporaryDirectory('ael-diagnostic-git-workspace-');
  const scope = initializeDiagnosticWorkspace(workspace, 'stable-workspace', scopeOptions);
  initializeGitRepository(workspace);

  assert.deepEqual(resolveDiagnosticScope(workspace, scopeOptions), scope);
});

test('retains a root workspace configuration when resolving from a nested Git directory', () => {
  const workspace = temporaryDirectory('ael-diagnostic-git-root-workspace-');
  const nested = join(workspace, 'src');
  const scope = initializeDiagnosticWorkspace(workspace, 'root-workspace', scopeOptions);
  initializeGitRepository(workspace);
  mkdirSync(nested);

  assert.deepEqual(resolveDiagnosticScope(nested, scopeOptions), scope);
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

    assert.throws(() => resolveDiagnosticScope(workspace, scopeOptions), /workspace configuration/i);
    assert.equal(readFileSync(configPath, 'utf8'), configuration);
  }
});

test('accepts a workspace ID at the 64-character boundary', () => {
  const workspace = temporaryDirectory('ael-diagnostic-max-workspace-id-');
  const workspaceId = 'a'.repeat(64);

  assert.deepEqual(initializeDiagnosticWorkspace(workspace, workspaceId, scopeOptions), { kind: 'workspace', id: workspaceId });
});
