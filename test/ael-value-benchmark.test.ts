import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { runCli } from '../src/cli.js';
import { assertComparable } from '../src/benchmark/manifest.js';

test('AVB-A1 public run pins current build and preserves the frozen synthetic baseline', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ael-avb-'));
  try {
    const identityResult = runCli(['benchmark', 'identity', '--json']);
    assert.equal(identityResult.exitCode, 0, identityResult.stdout);
    const identity = JSON.parse(identityResult.stdout);
    const manifest = { schemaVersion: 1, role: 'baseline', label: 'current-main-before-integration', buildId: identity.buildId,
      corpusVersion: 'b0-1', environment: { nodeMajor: Number(process.versions.node.split('.')[0]), platform: process.platform, arch: process.arch },
      budgets: { runMilliseconds: 10000 }, telemetry: { tokens: 'unavailable', wallTime: 'available' },
      scenarios: [{ id: 'codex-resume-matcher', revision: 1, kind: 'synthetic' }] };
    const manifestPath = join(directory, 'manifest.json');
    const reportPath = join(directory, 'report.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = runCli(['benchmark', 'run', '--manifest', manifestPath, '--output', reportPath, '--json']);
    assert.equal(result.exitCode, 0, result.stdout);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.buildId, identity.buildId);
    assert.equal(report.label, manifest.label);
    assert.equal(report.observations[0].kind, 'synthetic');
    assert.equal(typeof report.observations[0].resumeSupported, 'boolean');
    const frozen = JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/ael-value-benchmark/current-main-b0.report.json'), 'utf8'));
    const { reportDigest, ...frozenBody } = frozen;
    assert.equal(createHash('sha256').update(JSON.stringify(frozenBody)).digest('hex'), reportDigest);
    assert.equal(frozen.observations[0].resumeSupported, false);
    assert.equal(report.actualHost.status, 'unsupported');
    assert.equal(JSON.stringify(report).includes(process.cwd()), false);
    assert.equal(runCli(['benchmark', 'run', '--manifest', manifestPath, '--output', reportPath, '--json']).exitCode, 1);
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, privatePath: '/tmp/private-project', credential: 'AVB_SECRET_SENTINEL' }));
    assert.equal(runCli(['benchmark', 'run', '--manifest', manifestPath, '--output', join(directory, 'private.json'), '--json']).exitCode, 1);
    assert.equal(readFileSync(reportPath, 'utf8').includes('AVB_SECRET_SENTINEL'), false);
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, buildId: '0'.repeat(64) }));
    assert.equal(runCli(['benchmark', 'run', '--manifest', manifestPath, '--output', join(directory, 'substitute.json'), '--json']).exitCode, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('AVB-A1 comparison accepts declared build difference and rejects changed context', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ael-avb-'));
  try {
    const identity = JSON.parse(runCli(['benchmark', 'identity', '--json']).stdout);
    const manifest = { schemaVersion: 1, role: 'baseline', label: 'current-main-before-integration', buildId: identity.buildId,
      corpusVersion: 'b0-1', environment: { nodeMajor: Number(process.versions.node.split('.')[0]), platform: process.platform, arch: process.arch },
      budgets: { runMilliseconds: 10000 }, telemetry: { tokens: 'unavailable', wallTime: 'available' },
      scenarios: [{ id: 'codex-resume-matcher', revision: 1, kind: 'synthetic' }] };
    const baselineManifest = join(directory, 'baseline-manifest.json');
    const candidateManifest = join(directory, 'candidate-manifest.json');
    const baseline = join(directory, 'baseline.json');
    const candidate = join(directory, 'candidate.json');
    writeFileSync(baselineManifest, JSON.stringify(manifest));
    writeFileSync(candidateManifest, JSON.stringify({ ...manifest, role: 'candidate', label: 'candidate' }));
    assert.equal(runCli(['benchmark', 'run', '--manifest', baselineManifest, '--output', baseline, '--json']).exitCode, 0);
    assert.equal(runCli(['benchmark', 'run', '--manifest', candidateManifest, '--output', candidate, '--json']).exitCode, 0);
    assert.equal(runCli(['benchmark', 'compare', '--baseline', baseline, '--candidate', candidate, '--output', join(directory, 'ok.json'), '--json']).exitCode, 0);
    assert.doesNotThrow(() => assertComparable(manifest as never, { ...manifest, role: 'candidate', buildId: '1'.repeat(64) } as never));
    const candidateReport = JSON.parse(readFileSync(candidate, 'utf8'));
    candidateReport.buildId = '1'.repeat(64);
    candidateReport.manifest.buildId = candidateReport.buildId;
    writeFileSync(candidate, JSON.stringify(candidateReport));
    assert.equal(runCli(['benchmark', 'compare', '--baseline', baseline, '--candidate', candidate, '--output', join(directory, 'substitution.json'), '--json']).exitCode, 1);
    candidateReport.manifest.scenarios[0].revision = 2;
    const { reportDigest: oldDigest, ...scenarioBody } = candidateReport;
    candidateReport.reportDigest = createHash('sha256').update(JSON.stringify(scenarioBody)).digest('hex');
    writeFileSync(candidate, JSON.stringify(candidateReport));
    assert.equal(runCli(['benchmark', 'compare', '--baseline', baseline, '--candidate', candidate, '--output', join(directory, 'bad-scenario.json'), '--json']).exitCode, 1);
    candidateReport.manifest.scenarios[0].revision = 1;
    candidateReport.manifest.environment.platform = 'different';
    const { reportDigest: previousDigest, ...environmentBody } = candidateReport;
    candidateReport.reportDigest = createHash('sha256').update(JSON.stringify(environmentBody)).digest('hex');
    writeFileSync(candidate, JSON.stringify(candidateReport));
    assert.equal(runCli(['benchmark', 'compare', '--baseline', baseline, '--candidate', candidate, '--output', join(directory, 'bad-environment.json'), '--json']).exitCode, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
