import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { RepositoryId } from '../src/domain/types.js';
import { CaptureDiagnosticStore } from '../src/storage/capture-diagnostic-store.js';

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

function cursorScope(repositoryId?: string): { readonly source: 'cursor'; readonly repositoryId?: RepositoryId } {
  return repositoryId === undefined ? { source: 'cursor' } : { source: 'cursor', repositoryId: repositoryId as RepositoryId };
}

test('opens empty stores with four fixed zero counts and reopens persisted aggregates', () => {
  const path = databasePath();
  const store = new CaptureDiagnosticStore(path);

  assert.deepEqual(store.counts(cursorScope()), zeroCounts);
  assert.deepEqual(Object.keys(store.counts(cursorScope('repository-a'))), [...categories]);
  store.increment(cursorScope(), 'unsupported-tool');
  store.increment(cursorScope('repository-a'), 'unsafe-command-shape');
  store.close();

  const reopened = new CaptureDiagnosticStore(path);
  assert.deepEqual(reopened.counts(cursorScope()), { ...zeroCounts, 'unsupported-tool': 1 });
  assert.deepEqual(reopened.counts(cursorScope('repository-a')), { ...zeroCounts, 'unsafe-command-shape': 1 });
  reopened.close();
});

test('increments repeated categories atomically without crossing repository or global scopes', () => {
  const store = new CaptureDiagnosticStore(databasePath());
  for (let index = 0; index < 100; index += 1) store.increment(cursorScope('repository-a'), 'persistence-failure');
  store.increment(cursorScope('repository-b'), 'persistence-failure');
  store.increment(cursorScope(), 'persistence-failure');

  assert.equal(store.counts(cursorScope('repository-a'))['persistence-failure'], 100);
  assert.equal(store.counts(cursorScope('repository-b'))['persistence-failure'], 1);
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
  const scope = cursorScope('repository-a');
  const initial = store.counts(scope);

  assert.throws(() => store.increment({ source: 'codex' } as never, 'unsupported-tool'));
  assert.throws(() => store.increment(cursorScope('/private/repository/credential'), 'unsupported-tool'));
  assert.throws(() => store.increment(scope, 'pnpm publish --token=sk-test-credential' as never));
  assert.throws(() => store.counts({ source: 'cursor', repositoryId: 'session 42' as RepositoryId }));
  assert.deepEqual(store.counts(scope), initial);
  store.close();

  const bytes = readFileSync(path);
  for (const marker of ['pnpm publish --token=sk-test-credential', '/private/repository/credential', 'sk-test-credential', 'session 42']) {
    assert.equal(bytes.includes(Buffer.from(marker)), false, marker);
  }
});

test('rejects zero, overflow, and malformed schema rows without modifying the existing database', () => {
  for (const corruptCount of [0, Number.MAX_SAFE_INTEGER + 1]) {
    const path = databasePath();
    const seeded = new CaptureDiagnosticStore(path);
    seeded.increment(cursorScope('repository-a'), 'unsupported-tool');
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
