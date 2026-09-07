import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { performance } from 'node:perf_hooks';

import { drainCaptureSpool } from '../src/capture/spool-drain.js';
import { ingestPassiveHook } from '../src/capture/hook-ingress.js';
import { normalizeMappedCapture } from '../src/capture/normalization.js';
import { CaptureSpool } from '../src/capture/spool.js';
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
      input: JSON.stringify({ session_id: 'm4-session', cwd: '/work/repo', hook_event_name: 'SessionStart', source: 'startup' }),
      scheduleDrain: () => undefined
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

test('keeps admitted work pending when consumer startup fails and drains it later', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-m4-startup-'));
  const databasePath = join(dataDir, 'experience.sqlite');
  try {
    const admitted = ingestPassiveHook({
      source: 'codex', databasePath, now: () => '2026-09-07T08:00:00.000Z',
      input: JSON.stringify({ session_id: 'startup-session', hook_event_name: 'SessionStart', source: 'startup' }),
      scheduleDrain: () => { throw new Error('worker unavailable'); }
    });
    assert.deepEqual(admitted, { status: 'captured' });
    assert.equal(runCli(['capture', 'status', '--data-dir', dataDir, '--json']).stdout.includes('"pending":1'), true);
    drainCaptureSpool({ databasePath, now: () => '2026-09-07T08:00:01.000Z' });
    const store = new ExperienceStore(databasePath);
    try { assert.equal(store.loadSession('startup-session' as never)?.source, 'codex'); }
    finally { store.close(); }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('fails open within the hook deadline when the durable spool is busy', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-m4-spool-lock-'));
  const databasePath = join(dataDir, 'experience.sqlite');
  const spoolPath = join(dataDir, 'capture-spool.sqlite');
  const initialized = runCli(['capture', 'status', '--data-dir', dataDir, '--json']);
  assert.equal(initialized.exitCode, 0);
  const blocker = new DatabaseSync(spoolPath);
  blocker.exec('BEGIN IMMEDIATE');
  const startedAt = performance.now();
  try {
    const result = ingestPassiveHook({
      source: 'codex', databasePath, now: () => '2026-09-07T08:00:00.000Z', scheduleDrain: () => undefined,
      input: JSON.stringify({ session_id: 'busy-spool-session', hook_event_name: 'SessionStart', source: 'startup' })
    });
    const elapsedMs = performance.now() - startedAt;
    assert.deepEqual(result, { status: 'degraded', code: 'PERSISTENCE_FAILED' });
    assert.ok(elapsedMs < 250, `busy-spool admission took ${elapsedMs}ms`);
  } finally {
    blocker.exec('ROLLBACK');
    blocker.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('retries reordered lifecycle dependencies and accepts an in-bound late event', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-m4-reordered-'));
  const databasePath = join(dataDir, 'experience.sqlite');
  const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
  try {
    spool.admit({ kind: 'session-end', source: 'codex', sessionId: 'reordered-session' as never, endedAt: '2026-09-07T08:03:00.000Z' }, '2026-09-07T08:00:00.000Z');
    spool.admit({ kind: 'technical', event: normalizeMappedCapture({
      source: 'codex', sourceEventId: 'reordered-tool:pre', sessionId: 'reordered-session' as never,
      phase: 'pre-action', occurredAt: '2026-09-07T08:02:00.000Z', tool: 'git', action: 'status', summary: 'Run git status.'
    }) }, '2026-09-07T08:00:01.000Z');
    spool.admit({ kind: 'session-start', session: {
      id: 'reordered-session' as never, source: 'codex', startedAt: '2026-09-07T08:01:00.000Z'
    } }, '2026-09-07T08:00:02.000Z');
  } finally { spool.close(); }

  try {
    assert.equal(drainCaptureSpool({ databasePath, now: () => '2026-09-07T08:00:10.000Z' }).pending, 2);
    assert.equal(drainCaptureSpool({ databasePath, now: () => '2026-09-07T08:00:11.000Z' }).committed, 3);
    const store = new ExperienceStore(databasePath);
    try {
      assert.equal(store.loadSession('reordered-session' as never)?.endedAt, '2026-09-07T08:03:00.000Z');
      assert.equal(store.listCapturedEventsPage().entries.length, 1);
    } finally { store.close(); }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('reports aggregate spool status through the explicit CLI', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-m4-status-'));
  try {
    const result = runCli(['capture', 'status', '--data-dir', dataDir, '--json']);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      version: 1, admitted: 0, pending: 0, claimed: 0, committed: 0, quarantined: 0, failedAdmission: 0,
      delayedDelivery: { count: 0 }
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('benchmarks disabled, enabled and locked-main-store hook admission', (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-m4-benchmark-'));
  const databasePath = join(dataDir, 'experience.sqlite');
  const initialized = new ExperienceStore(databasePath);
  initialized.close();
  try {
    const disabled = measure(100, () => undefined);
    const enabled = measure(100, (index) => admitBenchmarkHook(databasePath, `enabled-${index}`));
    const blocker = new DatabaseSync(databasePath);
    blocker.exec('BEGIN IMMEDIATE');
    let locked: readonly number[];
    try { locked = measure(100, (index) => admitBenchmarkHook(databasePath, `locked-${index}`)); }
    finally { blocker.exec('ROLLBACK'); blocker.close(); }

    const report = { disabled: statistics(disabled), enabled: statistics(enabled), lockedMainStore: statistics(locked) };
    context.diagnostic(`M4 benchmark ${JSON.stringify(report)}`);
    assert.ok(report.enabled.p99Ms < 250, `enabled hook p99 was ${report.enabled.p99Ms}ms`);
    assert.ok(report.lockedMainStore.p99Ms < 250, `locked-main-store hook p99 was ${report.lockedMainStore.p99Ms}ms`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function admitBenchmarkHook(databasePath: string, sessionId: string): void {
  const result = ingestPassiveHook({
    source: 'codex', databasePath, now: () => '2026-09-07T08:00:00.000Z', scheduleDrain: () => undefined,
    input: JSON.stringify({ session_id: sessionId, hook_event_name: 'SessionStart', source: 'startup' })
  });
  assert.deepEqual(result, { status: 'captured' });
}

function measure(count: number, operation: (index: number) => void): readonly number[] {
  const values: number[] = [];
  const startedAt = performance.now();
  for (let index = 0; index < count; index += 1) {
    const start = performance.now();
    operation(index);
    values.push(performance.now() - start);
  }
  Object.defineProperty(values, 'elapsedMs', { value: performance.now() - startedAt });
  return values;
}

function statistics(values: readonly number[]): { p50Ms: number; p95Ms: number; p99Ms: number; throughputPerSecond: number } {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (value: number) => Number(sorted[Math.ceil(sorted.length * value) - 1]!.toFixed(3));
  const elapsedMs = (values as readonly number[] & { elapsedMs: number }).elapsedMs;
  return {
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
    throughputPerSecond: Number((values.length / (elapsedMs / 1_000)).toFixed(1))
  };
}
