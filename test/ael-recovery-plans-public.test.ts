import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CaptureSpool } from '../src/capture/spool.js';
import { runCli } from '../src/cli.js';

test('ARC-A2 public recovery plan applies once and preserves the selected scope', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-arc-plan-cli-'));
  const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
  const at = '2026-09-30T10:00:00.000Z';
  const planPath = join(dataDir, 'plan.json');
  try {
    const delivery = spool.admit({ kind: 'session-start', session: { id: 'arc-plan-session' as never, source: 'codex',
      startedAt: at, repositoryId: 'repo-a' as never } }, at);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const next = new Date(Date.parse(at) + attempt * 1000).toISOString();
      assert.equal(spool.claim(next, 1).length, 1);
      spool.retry(delivery.deliveryId, next, 'storage-unavailable');
    }
    const planned = runCli(['capture', 'recovery', 'plan', '--repository-id', 'repo-a', '--output', planPath,
      '--data-dir', dataDir, '--json']);
    assert.equal(planned.exitCode, 0, planned.stdout);
    assert.equal(existsSync(planPath), true);
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as { repositoryId: string; selections: { deliveryId: string }[] };
    assert.equal(plan.repositoryId, 'repo-a');
    assert.deepEqual(plan.selections.map(row => row.deliveryId), [delivery.deliveryId]);
    const applied = runCli(['capture', 'recovery', 'apply', '--input', planPath, '--data-dir', dataDir, '--json']);
    assert.equal(applied.exitCode, 0, applied.stdout);
    assert.equal((JSON.parse(applied.stdout) as { applied: number }).applied, 1);
    const repeated = runCli(['capture', 'recovery', 'apply', '--input', planPath, '--data-dir', dataDir, '--json']);
    assert.equal(repeated.exitCode, 0, repeated.stdout);
    assert.equal((JSON.parse(repeated.stdout) as { alreadyApplied: number }).alreadyApplied, 1);
    const oversized = join(dataDir, 'oversized-plan.json');
    writeFileSync(oversized, 'x'.repeat(256 * 1024 + 1));
    assert.equal(runCli(['capture', 'recovery', 'apply', '--input', oversized, '--data-dir', dataDir, '--json']).exitCode, 1);
  } finally { spool.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
