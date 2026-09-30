import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../src/cli.js';

test('AVB-A2/B1 public runner observes the retained pipeline after SQLite restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ael-avb-b1-'));
  try {
    const identity = JSON.parse(runCli(['benchmark', 'identity', '--json']).stdout) as { buildId: string };
    const manifest = { schemaVersion: 2, role: 'candidate', label: 'controlled-local-b1', buildId: identity.buildId,
      corpusVersion: 'b1-1', environment: { nodeMajor: Number(process.versions.node.split('.')[0]), platform: process.platform, arch: process.arch },
      budgets: { runMilliseconds: 60000 }, telemetry: { tokens: 'unavailable', wallTime: 'available' },
      sourceVersions: { codexHook: 1, typedAnnotation: 1, aclReview: 'unsupported' }, seed: 1,
      scenarios: [
        { id: 'resume', revision: 1, kind: 'pipeline' },
        { id: 'unknown-result', revision: 1, kind: 'pipeline' },
        { id: 'recovery', revision: 1, kind: 'pipeline' },
        { id: 'scoped-convention', revision: 1, kind: 'pipeline' },
        { id: 'typed-verification', revision: 1, kind: 'pipeline' }
      ] };
    const manifestPath = join(directory, 'manifest.json'); const reportPath = join(directory, 'report.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = runCli(['benchmark', 'run', '--manifest', manifestPath, '--output', reportPath, '--json']);
    assert.equal(result.exitCode, 0, result.stdout);
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { observations: Array<{ scenarioId: string; status: string; evidence: Record<string, unknown> }>; aclReview: { status: string }; actualHost: { status: string } };
    assert.deepEqual(report.observations.map(value => value.scenarioId), manifest.scenarios.map(value => value.id));
    assert.ok(report.observations.every(value => value.status === 'observed'));
    assert.equal(report.observations[0]?.evidence.resumedRuns, 1);
    assert.equal(report.observations[1]?.evidence.retainedUnknownResults, 1);
    assert.equal(report.observations[2]?.evidence.healthyRowsSelected, 0);
    assert.equal(report.observations[3]?.evidence.retainedScopedContext, true);
    assert.equal(report.observations[4]?.evidence.resolvedUserAnnotations, 1);
    assert.equal(report.observations[4]?.evidence.crossScopeRejected, true);
    assert.equal(report.aclReview.status, 'unsupported');
    assert.equal(report.actualHost.status, 'unsupported');
    assert.equal(JSON.stringify(report).includes(directory), false);
    assert.equal(runCli(['benchmark', 'run', '--manifest', manifestPath, '--output', reportPath, '--json']).exitCode, 1);
    for (const [index, changed] of [
      { ...manifest, seed: 2 },
      { ...manifest, sourceVersions: { ...manifest.sourceVersions, typedAnnotation: 2 } },
      { ...manifest, scenarios: [...manifest.scenarios].reverse() },
      { ...manifest, privatePath: '/private/fixture' }
    ].entries()) {
      writeFileSync(manifestPath, JSON.stringify(changed));
      assert.equal(runCli(['benchmark', 'run', '--manifest', manifestPath, '--output', join(directory, `rejected-${index}.json`), '--json']).exitCode, 1);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
