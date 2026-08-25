import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli.js';

test('reports degraded status without creating a missing snapshot', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-runtime-status-'));
  try {
    const result = runCli(['runtime', 'status', '--json', '--data-dir', dataDir]);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      health: 'degraded', profileId: 'normal', hardBlocking: true,
      retrievalMode: 'degraded', fallbackSource: 'degraded-policy', circuitState: 'closed'
    });
    assert.equal(runCli(['runtime', 'status', '--data-dir', dataDir]).stdout, 'Runtime degraded; profile normal; fallback degraded-policy; circuit closed.\n');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
test('reports a healthy current snapshot after evaluation initialized it', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-runtime-status-'));
  const input = join(dataDir, 'action.json');
  try {
    writeFileSync(input, JSON.stringify({ operationClass: 'normal', signature: { kind: 'intent', verb: 'read', target: 'status' } }));
    assert.equal(runCli(['runtime', 'evaluate', '--input', input, '--data-dir', dataDir]).exitCode, 0);

    const status = JSON.parse(runCli(['runtime', 'status', '--json', '--data-dir', dataDir]).stdout);
    assert.deepEqual(status, {
      health: 'healthy', profileId: 'normal', hardBlocking: true,
      retrievalMode: 'deterministic', fallbackSource: 'snapshot', circuitState: 'closed'
    });
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
