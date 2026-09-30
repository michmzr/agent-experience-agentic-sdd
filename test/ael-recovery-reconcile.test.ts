import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { runCli } from '../src/cli.js';
import { normalizeMappedCapture } from '../src/capture/normalization.js';
import type { RepositoryId, SessionId } from '../src/domain/types.js';
import { ExperienceStore } from '../src/storage/experience-store.js';

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'arc-reconcile-'));
  const root = join(dataDir, 'project');
  mkdirSync(root);
  const databasePath = join(dataDir, 'experience.sqlite');
  const repositoryId = 'arc-repo' as RepositoryId;
  const sessionId = 'arc-session' as SessionId;
  const store = new ExperienceStore(databasePath);
  store.registerRepository({ id: repositoryId, root, observedAt: '2026-09-30T10:00:00.000Z' });
  store.appendIncremental({ session: { id: sessionId, source: 'codex', startedAt: '2026-09-30T10:00:00.000Z', repositoryId } });
  store.appendIncremental({ event: normalizeMappedCapture({ source: 'codex', sourceEventId: 'arc-request', sessionId,
    phase: 'pre-action', occurredAt: '2026-09-30T10:00:01.000Z', tool: 'shell', action: 'test', summary: 'Test.' }) });
  store.close();
  const invoke = (...args: string[]) => runCli(['analysis', 'reconcile', '--repository-id', repositoryId, '--data-dir', dataDir, '--json', ...args]);
  return { dataDir, root, databasePath, repositoryId, sessionId, invoke };
}

test('ARC-A3 preview is read-only; apply admits missing work exactly once', () => {
  const { dataDir, databasePath, repositoryId, invoke } = fixture();
  const before = new DatabaseSync(databasePath, { readOnly: true });
  const schemaCountBefore = (before.prepare('SELECT COUNT(*) AS count FROM sqlite_master WHERE name = ?').get('operational_analysis_jobs') as { count: number }).count;
  before.close();
  const preview = invoke();
  assert.equal(preview.exitCode, 0);
  assert.equal(JSON.parse(preview.stdout).missing, 1);
  const afterPreview = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal((afterPreview.prepare('SELECT COUNT(*) AS count FROM sqlite_master WHERE name = ?').get('operational_analysis_jobs') as { count: number }).count, schemaCountBefore);
  afterPreview.close();
  const applied = invoke('--apply');
  assert.equal(applied.exitCode, 0);
  assert.equal(JSON.parse(applied.stdout).added, 1);
  assert.equal(JSON.parse(invoke('--apply').stdout).added, 0);
  const run = runCli(['analysis', 'run', '--repository-id', repositoryId, '--data-dir', dataDir, '--json']);
  assert.equal(run.exitCode, 0);
  assert.equal(JSON.parse(run.stdout).status, 'completed');
  const checked = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal((checked.prepare('SELECT COUNT(*) AS count FROM operational_analysis_jobs').get() as { count: number }).count, 1);
  checked.close();
});

test('ARC-A3 admits retained resumed events absent from the detector stream', () => {
  const { databasePath, sessionId, invoke } = fixture();
  const store = new ExperienceStore(databasePath);
  store.endSession('codex', sessionId, '2026-09-30T10:01:00.000Z');
  store.recordLifecycleSignal({ source: 'codex', sourceEventId: 'arc-resume', conversationId: sessionId,
    kind: 'start', startOrigin: 'resume', receiptAt: '2026-09-30T10:02:00.000Z' });
  store.appendLifecycleTechnical(normalizeMappedCapture({ source: 'codex', sourceEventId: 'arc-resumed-request', sessionId,
    phase: 'pre-action', occurredAt: '2026-09-30T10:02:01.000Z', tool: 'shell', action: 'test', summary: 'Resumed test.' }));
  store.close();
  const preview = JSON.parse(invoke().stdout);
  assert.equal(preview.sessions[0].highWater, 2);
  const applied = JSON.parse(invoke('--apply').stdout);
  assert.equal(applied.added, 1);
  assert.equal(JSON.parse(invoke('--apply').stdout).added, 0);
});

test('ARC-A3 explicit apply records the opt-out override and malformed --apply is rejected', () => {
  const { root, databasePath, invoke } = fixture();
  mkdirSync(join(root, '.ael'));
  writeFileSync(join(root, '.ael', 'settings.json'), JSON.stringify({ version: 1, captureDeliveryDeadlineMs: 2000, automaticOperationalLearning: false }));
  assert.equal(JSON.parse(invoke().stdout).optedOut, 1);
  const applied = JSON.parse(invoke('--apply').stdout);
  assert.equal(applied.added, 1);
  assert.deepEqual(applied.overrideScope.sessionIds, ['arc-session']);
  assert.equal(invoke('--apply', 'unexpected').exitCode, 2);
  const checked = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal((checked.prepare('SELECT COUNT(*) AS count FROM analysis_reconciliation_overrides').get() as { count: number }).count, 1);
  checked.close();
});

test('ARC-A3 incomplete backfill is explicit and cannot admit missing work', () => {
  const { databasePath, invoke } = fixture();
  const damaged = new DatabaseSync(databasePath);
  damaged.exec('DELETE FROM logical_evidence');
  damaged.close();
  const preview = JSON.parse(invoke().stdout);
  assert.equal(preview.unavailable, 1);
  assert.equal(preview.missing, 0);
  const applied = JSON.parse(invoke('--apply').stdout);
  assert.equal(applied.added, 0);
  const checked = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal((checked.prepare('SELECT COUNT(*) AS count FROM sqlite_master WHERE name = ?').get('operational_analysis_jobs') as { count: number }).count, 0);
  checked.close();
});

test('ARC-A3 orphaned detector stream is unavailable rather than current', () => {
  const { databasePath, repositoryId, sessionId, invoke } = fixture();
  assert.equal(JSON.parse(invoke('--apply').stdout).added, 1);
  const damaged = new DatabaseSync(databasePath);
  damaged.prepare('DELETE FROM operational_analysis_jobs WHERE repository_id = ? AND session_id = ?')
    .run(repositoryId, sessionId);
  damaged.close();
  const preview = JSON.parse(invoke().stdout);
  assert.equal(preview.unavailable, 1);
  assert.equal(preview.sessions[0].status, 'unavailable');
  assert.equal(JSON.parse(invoke('--apply').stdout).added, 0);
});

test('ARC-A3 preview scans sessions in bounded pages with an explicit cursor', () => {
  const { databasePath, repositoryId, invoke } = fixture();
  const store = new ExperienceStore(databasePath);
  for (let index = 0; index < 101; index++) {
    store.appendIncremental({ session: { id: `other-${String(index).padStart(3, '0')}` as SessionId,
      source: 'codex', startedAt: '2026-09-30T10:00:00.000Z', repositoryId } });
  }
  store.close();
  const first = JSON.parse(invoke().stdout);
  assert.equal(first.scanned, 100);
  assert.equal(typeof first.nextCursor, 'string');
  const second = JSON.parse(invoke('--after-session', first.nextCursor).stdout);
  assert.equal(second.scanned, 2);
  assert.equal(second.nextCursor, undefined);
});
