import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { runCli } from '../src/cli.js';
import { assertComparable } from '../src/benchmark/manifest.js';
import { assessBenchmarkSafety, type SafetyRunObservation } from '../src/benchmark/compare.js';
import { DatabaseSync } from 'node:sqlite';

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

test('AVB-A3 safety gates reject wrong scope, persisted secrets, passive intervention and unapproved promotion', () => {
  const cases = JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/ael-value-benchmark/safety-cases.json'), 'utf8')) as Array<{
    id: string; repositoryId: string; mode: SafetyRunObservation['mode']; advice: SafetyRunObservation['advice'];
    interventions: SafetyRunObservation['interventions']; promotions: SafetyRunObservation['promotions'];
    secretLocation: 'none' | 'database' | 'export'; violation: string | null;
  }>;
  const directory = mkdtempSync(join(tmpdir(), 'ael-avb-safety-'));
  try {
    for (const scenario of cases) {
      const databasePath = join(directory, `${scenario.id}.sqlite`);
      const db = new DatabaseSync(databasePath);
      db.exec('CREATE TABLE retained_facts (value TEXT NOT NULL)');
      db.prepare('INSERT INTO retained_facts(value) VALUES (?)').run(
        scenario.secretLocation === 'database' ? `sk-${'a'.repeat(24)}` : 'bounded structural fact');
      db.close();
      const exportPath = join(directory, `${scenario.id}.json`);
      writeFileSync(exportPath, JSON.stringify({ value: scenario.secretLocation === 'export' ? `sk-${'a'.repeat(24)}` : 'bounded structural fact' }));
      const assessed = assessBenchmarkSafety({ taskOutcome: 'succeeded', mode: scenario.mode,
        repositoryId: scenario.repositoryId, advice: scenario.advice, interventions: scenario.interventions,
        promotions: scenario.promotions, persistence: { databasePath, exportPaths: [exportPath] },
        telemetry: { tokens: null, wallMilliseconds: null } });
      assert.equal(assessed.status, scenario.violation === null ? 'correctness-pass' : 'safety-fail', scenario.id);
      assert.equal(assessed.conclusion, 'performance-not-established', scenario.id);
      if (scenario.violation !== null) assert.equal(assessed.violations.includes(scenario.violation), true, scenario.id);
      assert.equal(JSON.stringify(assessed).includes('sk-'), false);
      assert.equal(JSON.stringify(assessed).includes(directory), false);
    }
    const omittedPersistence = assessBenchmarkSafety({ taskOutcome: 'succeeded', mode: 'passive', repositoryId: 'repo-a',
      advice: [], interventions: [], promotions: [], persistence: { exportPaths: [] },
      telemetry: { tokens: null, wallMilliseconds: null } });
    assert.equal(omittedPersistence.status, 'safety-fail');
    assert.equal(omittedPersistence.violations.includes('persistence-unavailable'), true);
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
