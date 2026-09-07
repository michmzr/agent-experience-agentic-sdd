import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { runCliAsync } from '../src/cli.js';
import { resolveDiagnosticScope } from '../src/capture/diagnostic-scope.js';
import { ingestPassiveHook } from '../src/capture/hook-ingress.js';
import { CaptureSpool } from '../src/capture/spool.js';
import { CaptureDiagnosticStore } from '../src/storage/capture-diagnostic-store.js';
import { ExperienceStore } from '../src/storage/experience-store.js';

const now = () => '2026-09-04T08:00:00.000Z';

test('counts rejected Cursor delivery in its non-Git workspace scope', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ael-cursor-workspace-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-cursor-diagnostic-data-'));
  try {
    const result = await runCliAsync(
      ['capture', 'hook', '--source', 'cursor', '--data-dir', dataDir],
      {
        workingDirectory: workspace,
        now,
        hookInput: JSON.stringify({
          conversation_id: 'session-1', hook_event_name: 'preToolUse', cwd: workspace,
          tool_name: 'Terminal', tool_use_id: 'tool-1', tool_input: { command: 'echo diagnostic-marker' }
        })
      }
    );

    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    const workspaceId = JSON.parse(readFileSync(join(workspace, '.ael', 'workspace.json'), 'utf8')).workspaceId;
    assert.equal(workspaceId, basename(workspace).toLowerCase());
    const store = new CaptureDiagnosticStore(join(dataDir, 'capture-diagnostics.sqlite'));
    try {
      assert.deepEqual(store.counts({ source: 'cursor', scope: resolveDiagnosticScope(workspace) }), {
        'invalid-working-directory': 0,
        'persistence-failure': 0,
        'unsafe-command-shape': 0,
        'unsupported-tool': 1
      });
    } finally { store.close(); }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('durably admits capture before the primary experience database can be opened', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ael-cursor-open-failure-workspace-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-cursor-open-failure-data-'));
  const databasePath = join(dataDir, 'experience.sqlite');
  mkdirSync(databasePath);
  try {
    const result = ingestPassiveHook({
      source: 'cursor',
      input: JSON.stringify({ conversation_id: 'open-failure-session', hook_event_name: 'sessionStart' }),
      databasePath,
      workingDirectory: workspace,
      now,
      scheduleDrain: () => undefined
    });

    assert.deepEqual(result, { status: 'captured' });
    const scope = resolveDiagnosticScope(workspace);
    const diagnostics = new CaptureDiagnosticStore(join(dataDir, 'capture-diagnostics.sqlite'));
    try {
      assert.equal(diagnostics.counts({ source: 'cursor', scope })['persistence-failure'], 0);
    } finally { diagnostics.close(); }
    assertPending(dataDir);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('durably admits capture while the primary experience database is busy', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ael-cursor-busy-workspace-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-cursor-busy-data-'));
  const databasePath = join(dataDir, 'experience.sqlite');
  const initialized = new ExperienceStore(databasePath);
  initialized.close();
  const blocker = new DatabaseSync(databasePath);
  blocker.exec('BEGIN IMMEDIATE');
  try {
    const result = ingestPassiveHook({
      source: 'cursor',
      input: JSON.stringify({ conversation_id: 'busy-session', hook_event_name: 'sessionStart' }),
      databasePath,
      workingDirectory: workspace,
      now,
      scheduleDrain: () => undefined
    });

    assert.deepEqual(result, { status: 'captured' });
    const scope = resolveDiagnosticScope(workspace);
    const diagnostics = new CaptureDiagnosticStore(join(dataDir, 'capture-diagnostics.sqlite'));
    try {
      assert.equal(diagnostics.counts({ source: 'cursor', scope })['persistence-failure'], 0);
    } finally { diagnostics.close(); }
    assertPending(dataDir);
  } finally {
    blocker.exec('ROLLBACK');
    blocker.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('durably admits capture before a malformed primary migration is repaired', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ael-cursor-migration-failure-workspace-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-cursor-migration-failure-data-'));
  const databasePath = join(dataDir, 'experience.sqlite');
  const malformed = new DatabaseSync(databasePath);
  malformed.exec('CREATE TABLE schema_migrations (unexpected INTEGER)');
  malformed.close();
  try {
    const result = ingestPassiveHook({
      source: 'cursor',
      input: JSON.stringify({ conversation_id: 'migration-failure-session', hook_event_name: 'sessionStart' }),
      databasePath,
      workingDirectory: workspace,
      now,
      scheduleDrain: () => undefined
    });

    assert.deepEqual(result, { status: 'captured' });
    const scope = resolveDiagnosticScope(workspace);
    const diagnostics = new CaptureDiagnosticStore(join(dataDir, 'capture-diagnostics.sqlite'));
    try {
      assert.equal(diagnostics.counts({ source: 'cursor', scope })['persistence-failure'], 0);
    } finally { diagnostics.close(); }
    assertPending(dataDir);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('does not consult rejection diagnostics after durable admission', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ael-cursor-double-failure-workspace-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-cursor-double-failure-data-'));
  const databasePath = join(dataDir, 'experience.sqlite');
  mkdirSync(databasePath);
  let attempts = 0;
  try {
    const result = ingestPassiveHook({
      source: 'cursor',
      input: JSON.stringify({ conversation_id: 'double-failure-session', hook_event_name: 'sessionStart' }),
      databasePath,
      workingDirectory: workspace,
      now,
      scheduleDrain: () => undefined,
      diagnosticStoreFactory: () => {
        attempts += 1;
        throw new Error('diagnostic store unavailable');
      }
    });

    assert.deepEqual(result, { status: 'captured' });
    assert.equal(attempts, 0);
    assertPending(dataDir);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function assertPending(dataDir: string): void {
  const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
  try {
    assert.equal(spool.status().pending, 1);
  } finally {
    spool.close();
  }
}
