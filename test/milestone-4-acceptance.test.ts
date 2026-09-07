import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { drainCaptureSpool } from '../src/capture/spool-drain.js';
import { ingestPassiveHook } from '../src/capture/hook-ingress.js';
import { runCli } from '../src/cli.js';
import { ExperienceStore } from '../src/storage/experience-store.js';

test('admits a hook while the main store is locked and drains it later', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-m4-'));
  const databasePath = join(dataDir, 'experience.sqlite');
  const initialized = new ExperienceStore(databasePath);
  initialized.close();
  const blocker = new DatabaseSync(databasePath);
  blocker.exec('BEGIN IMMEDIATE');
  try {
    const admitted = ingestPassiveHook({
      source: 'codex', databasePath, now: () => '2026-09-07T08:00:00.000Z',
      input: JSON.stringify({ session_id: 'm4-session', cwd: '/work/repo', hook_event_name: 'SessionStart', source: 'startup' })
    });
    assert.deepEqual(admitted, { status: 'captured' });
    blocker.exec('ROLLBACK');
    drainCaptureSpool({ databasePath, now: () => '2026-09-07T08:00:01.000Z' });
    const store = new ExperienceStore(databasePath);
    assert.equal(store.loadSession('m4-session' as never)?.startedAt, '2026-09-07T08:00:00.000Z');
    store.close();
  } finally {
    try { blocker.close(); } catch { /* transaction already rolled back */ }
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('reports aggregate spool status through the explicit CLI', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-m4-status-'));
  try {
    const result = runCli(['capture', 'status', '--data-dir', dataDir, '--json']);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      version: 1, admitted: 0, pending: 0, claimed: 0, committed: 0, quarantined: 0, failedAdmission: 0
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
