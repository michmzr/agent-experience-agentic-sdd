import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveDiagnosticScope, type DiagnosticScope } from '../src/capture/diagnostic-scope.js';
import { CaptureDiagnosticStore } from '../src/storage/capture-diagnostic-store.js';
import { initializeGitRepository } from './helpers/git-repository.js';

const categories = [
  'invalid-working-directory',
  'persistence-failure',
  'unsafe-command-shape',
  'unsupported-tool'
] as const;

const zeroCounts = {
  'invalid-working-directory': 0,
  'persistence-failure': 0,
  'unsafe-command-shape': 0,
  'unsupported-tool': 0
};

function databasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'ael-capture-diagnostics-')), 'capture-diagnostics.sqlite');
}

function workspaceDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function repositoryScope(): DiagnosticScope {
  const directory = workspaceDirectory('ael-diagnostic-repository-');
  initializeGitRepository(directory);
  return resolveDiagnosticScope(directory);
}

function workspaceScope(): DiagnosticScope {
  return resolveDiagnosticScope(workspaceDirectory('ael-diagnostic-workspace-'));
}

function cursorScope(scope: DiagnosticScope = resolveDiagnosticScope()): { readonly source: 'cursor'; readonly scope: DiagnosticScope } {
  return { source: 'cursor', scope };
}

test('opens empty stores with four fixed zero counts and reopens persisted aggregates', () => {
  const path = databasePath();
  const store = new CaptureDiagnosticStore(path);
  const repository = repositoryScope();

  assert.deepEqual(store.counts(cursorScope()), zeroCounts);
  assert.deepEqual(Object.keys(store.counts(cursorScope(repository))), [...categories]);
  store.increment(cursorScope(), 'unsupported-tool');
  store.increment(cursorScope(repository), 'unsafe-command-shape');
  store.close();

  const reopened = new CaptureDiagnosticStore(path);
  assert.deepEqual(reopened.counts(cursorScope()), { ...zeroCounts, 'unsupported-tool': 1 });
  assert.deepEqual(reopened.counts(cursorScope(repository)), { ...zeroCounts, 'unsafe-command-shape': 1 });
  reopened.close();
});

test('increments repeated categories atomically without crossing repository, workspace, or global scopes', () => {
  const store = new CaptureDiagnosticStore(databasePath());
  const repository = repositoryScope();
  const workspace = workspaceScope();
  for (let index = 0; index < 100; index += 1) store.increment(cursorScope(repository), 'persistence-failure');
  store.increment(cursorScope(workspace), 'persistence-failure');
  store.increment(cursorScope(), 'persistence-failure');

  assert.equal(store.counts(cursorScope(repository))['persistence-failure'], 100);
  assert.equal(store.counts(cursorScope(workspace))['persistence-failure'], 1);
  assert.equal(store.counts(cursorScope())['persistence-failure'], 1);
  store.close();
});

test('creates the database and parent directory with owner-only permissions', () => {
  const path = databasePath();
  const store = new CaptureDiagnosticStore(path);

  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(path, '..')).mode & 0o777, 0o700);
  store.close();
});

test('rejects invalid scope and category inputs before mutating counts or persisting payload markers', () => {
  const path = databasePath();
  const store = new CaptureDiagnosticStore(path);
  const scope = cursorScope(repositoryScope());
  const workspace = workspaceDirectory('ael-diagnostic-private-workspace-');
  const workspaceScope = cursorScope(resolveDiagnosticScope(workspace));
  const workspaceConfiguration = JSON.parse(readFileSync(join(workspace, '.ael', 'workspace.json'), 'utf8')) as { workspaceId: string };
  const initial = store.counts(scope);

  store.increment(workspaceScope, 'unsupported-tool');
  assert.throws(() => store.increment({ source: 'codex' } as never, 'unsupported-tool'));
  assert.throws(() => store.increment({ source: 'cursor', scope: { kind: 'workspace', id: '/private/repository/credential' } } as never, 'unsupported-tool'));
  assert.throws(() => store.increment({ source: 'cursor', scope: { kind: 'workspace', id: 'sk-test-credential' } } as never, 'unsupported-tool'));
  assert.throws(() => store.increment({ source: 'cursor', scope: { kind: 'workspace', id: 'c'.repeat(64) } } as never, 'unsupported-tool'));
  assert.throws(() => store.increment(scope, 'pnpm publish --token=sk-test-credential' as never));
  assert.throws(() => store.counts({ source: 'cursor', scope: { kind: 'repository', id: 'session-42' } } as never));
  assert.deepEqual(store.counts(scope), initial);
  store.close();

  const bytes = readFileSync(path);
  for (const marker of ['pnpm publish --token=sk-test-credential', '/private/repository/credential', 'sk-test-credential', 'session-42', workspace]) {
    assert.equal(bytes.includes(Buffer.from(marker)), false, marker);
  }
  assert.equal(bytes.includes(Buffer.from(workspaceConfiguration.workspaceId)), true);
});

test('rejects zero, overflow, and malformed schema rows without modifying the existing database', () => {
  for (const corruptCount of [0, Number.MAX_SAFE_INTEGER + 1]) {
    const path = databasePath();
    const seeded = new CaptureDiagnosticStore(path);
    seeded.increment(cursorScope(repositoryScope()), 'unsupported-tool');
    seeded.close();
    const database = new DatabaseSync(path);
    database.exec('PRAGMA ignore_check_constraints = ON');
    database.prepare('UPDATE capture_diagnostic_counts SET count = ?').run(corruptCount);
    database.exec('PRAGMA ignore_check_constraints = OFF');
    database.close();
    const before = readFileSync(path);

    assert.throws(() => new CaptureDiagnosticStore(path));
    assert.deepEqual(readFileSync(path), before);
  }

  const path = databasePath();
  const database = new DatabaseSync(path);
  database.exec('CREATE TABLE capture_diagnostic_counts (source TEXT, scope_key TEXT, category TEXT, count INTEGER)');
  database.close();
  const before = readFileSync(path);

  assert.throws(() => new CaptureDiagnosticStore(path), /schema/i);
  assert.deepEqual(readFileSync(path), before);
});
