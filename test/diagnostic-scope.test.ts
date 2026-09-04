import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveDiagnosticScope } from '../src/capture/diagnostic-scope.js';
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

test('creates a private stable workspace marker and hashes only its UUID', () => {
  const workspace = temporaryDirectory('ael-diagnostic-workspace-');

  const scope = resolveDiagnosticScope(workspace);
  const markerPath = join(workspace, '.ael', 'workspace-id');
  const marker = readFileSync(markerPath, 'utf8');

  assert.equal(scope.kind, 'workspace');
  assert.match(scope.id, /^[a-f0-9]{64}$/);
  assert.match(marker, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(lstatSync(join(workspace, '.ael')).mode & 0o777, 0o700);
  assert.equal(lstatSync(markerPath).mode & 0o777, 0o600);
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

test('rejects a malformed existing workspace marker without replacing it', () => {
  const workspace = temporaryDirectory('ael-diagnostic-invalid-marker-');
  const markerDirectory = join(workspace, '.ael');
  const markerPath = join(markerDirectory, 'workspace-id');
  mkdirSync(markerDirectory, { mode: 0o700 });
  const marker = 'not-a-workspace-uuid';
  writeFileSync(markerPath, marker, { mode: 0o600 });

  assert.throws(() => resolveDiagnosticScope(workspace), /workspace marker/i);
  assert.equal(readFileSync(markerPath, 'utf8'), marker);
});
