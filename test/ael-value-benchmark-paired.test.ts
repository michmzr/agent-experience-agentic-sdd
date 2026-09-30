import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../src/cli.js';
import { assessPairedReports, createPairedProtocol } from '../src/benchmark/paired.js';
import { digest } from '../src/benchmark/manifest.js';
import { assessPairedPilot, type PilotTrial } from '../src/benchmark/pilot.js';

const b1Scenarios = ['resume', 'unknown-result', 'recovery', 'scoped-convention', 'typed-verification'] as const;

test('AVB-B2 freezes five paired repetitions with pinned order and budget', () => {
  const buildId = 'a'.repeat(64);
  const input = { corpusVersion: 'b2-1', baselineBuildId: buildId, candidateBuildId: 'b'.repeat(64),
    sourceVersions: { runnerCorpus: 'b1-1', aap: 'unsupported' },
    environment: { nodeMajor: Number(process.versions.node.split('.')[0]), platform: process.platform, arch: process.arch },
    seed: 7, scenarios: [{ id: 'resume', revision: 1 as const }],
    budgets: { wallMilliseconds: 60000, aelOverheadMilliseconds: 10000, tokens: null } };
  const protocol = createPairedProtocol(input);
  assert.equal(protocol.order.length, 15);
  assert.deepEqual(new Set(protocol.order.map(slot => `${slot.scenarioId}:${slot.pair}:${slot.condition}`)).size, 15);
  assert.deepEqual(new Set(protocol.order.map(slot => slot.pair)), new Set([0, 1, 2, 3, 4]));
  assert.equal(protocol.protocolDigest, createPairedProtocol(input).protocolDigest);
  assert.notEqual(protocol.protocolDigest, createPairedProtocol({ ...input, seed: 8 }).protocolDigest);
  assert.throws(() => createPairedProtocol({ ...input, budgets: { ...input.budgets, wallMilliseconds: 0 } }));
  assert.throws(() => createPairedProtocol({ ...input, privatePath: '/private/project' } as never));
});

test('AVB-B2 reads a public runner report but leaves actual session B incomplete', () => {
  const directory = mkdtempSync(join(tmpdir(), 'avb-b2-public-'));
  try {
    const identity = JSON.parse(runCli(['benchmark', 'identity', '--json']).stdout) as { buildId: string };
    const environment = { nodeMajor: Number(process.versions.node.split('.')[0]), platform: process.platform, arch: process.arch };
    const manifest = { schemaVersion: 2, role: 'candidate', label: 'avb-b2-probe', buildId: identity.buildId,
      corpusVersion: 'b1-1', environment, budgets: { runMilliseconds: 60000 },
      telemetry: { tokens: 'unavailable', wallTime: 'available' },
      sourceVersions: { codexHook: 1, typedAnnotation: 1, aclReview: 'unsupported' }, seed: 1,
      scenarios: b1Scenarios.map(id => ({ id, revision: 1, kind: 'pipeline' })) };
    const manifestPath = join(directory, 'manifest.json'); const reportPath = join(directory, 'report.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const run = runCli(['benchmark', 'run', '--manifest', manifestPath, '--output', reportPath, '--json']);
    assert.equal(run.exitCode, 0, run.stdout);
    const raw = JSON.parse(readFileSync(reportPath, 'utf8')) as { actualHost: { status: string } };
    assert.equal(raw.actualHost.status, 'unsupported');
    const protocol = createPairedProtocol({ corpusVersion: 'b2-1', baselineBuildId: identity.buildId,
      candidateBuildId: identity.buildId, sourceVersions: { runnerCorpus: 'b1-1', aap: 'unsupported' },
      environment, seed: 7, scenarios: [{ id: 'resume', revision: 1 }],
      budgets: { wallMilliseconds: 60000, aelOverheadMilliseconds: 10000, tokens: null } });
    const slot = protocol.order.find(item => item.condition === 'advice')!;
    const result = assessPairedReports(protocol, [{ slot, path: reportPath }]);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.conclusion, 'performance-not-established');
    assert.equal(result.observedTrials, 0);
    assert.equal(result.telemetry.tokens, 'unavailable');
    assert.throws(() => assessPairedReports({ ...protocol, candidateBuildId: 'f'.repeat(64) }, [{ slot, path: reportPath }]));
    const original = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
    const { reportDigest: _old, ...forged } = original;
    const seal = (body: Record<string, unknown>) => writeFileSync(reportPath, JSON.stringify({ ...body, reportDigest: digest(JSON.stringify(body)) }));
    seal({ ...forged, actualHost: { status: 'observed', qualification: 'verified' },
      pilot: { scenarioId: slot.scenarioId, pair: slot.pair, condition: slot.condition, integrationVersion: 'aap-record@1',
        taskCorrect: true, redundantOperationIds: [], safetyViolations: [], wallMilliseconds: 1,
        aelOverheadMilliseconds: 0, tokens: 1 } });
    assert.equal(assessPairedReports(protocol, [{ slot, path: reportPath }]).status, 'incomplete');
    seal({ ...forged, manifest: { ...manifest, environment: { ...environment, platform: 'different' } } });
    assert.throws(() => assessPairedReports(protocol, [{ slot, path: reportPath }]));
    seal(forged);
    writeFileSync(reportPath, readFileSync(reportPath, 'utf8').replace('"actualHost":{"status":"unsupported"', '"actualHost":{"status":"observed"'));
    assert.throws(() => assessPairedReports(protocol, [{ slot, path: reportPath }]));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('AVB-B2 reports token and AEL overhead distributions without a false improvement claim', () => {
  const trials: PilotTrial[] = Array.from({ length: 5 }, (_, pair) => [
    { scenarioId: 'resume', pair, condition: 'disabled' as const, taskCorrect: true,
      redundantOperationIds: [`baseline-${pair}`, `baseline-extra-${pair}`], safetyViolations: [],
      wallMilliseconds: 100, aelOverheadMilliseconds: 0, tokens: 100 },
    { scenarioId: 'resume', pair, condition: 'passive' as const, taskCorrect: true,
      redundantOperationIds: [`passive-${pair}`], safetyViolations: [],
      wallMilliseconds: 100, aelOverheadMilliseconds: null, tokens: null },
    { scenarioId: 'resume', pair, condition: 'advice' as const, taskCorrect: true,
      redundantOperationIds: [`advice-${pair}`], safetyViolations: [],
      wallMilliseconds: 80, aelOverheadMilliseconds: 30, tokens: 90 }
  ]).flat();
  const result = assessPairedPilot(trials);
  assert.equal(result.status, 'behavioral-pass');
  assert.equal(result.conclusion, 'performance-not-established');
  assert.equal(result.scenarios[0]?.net?.medianSavedMilliseconds, -10);
  assert.deepEqual((result.scenarios[0] as unknown as { tokens?: Record<string, number | null> })?.tokens,
    { disabled: 100, passive: null, advice: 90 });
  const completeTelemetry = trials.map(trial => trial.condition === 'passive'
    ? { ...trial, aelOverheadMilliseconds: 5, tokens: 100 } : trial);
  assert.equal(assessPairedPilot(completeTelemetry).conclusion, 'performance-not-established');
  const unsafe = trials.map(trial => trial.condition === 'advice' && trial.pair === 2
    ? { ...trial, safetyViolations: ['wrong-scope-advice'] } : trial);
  assert.equal(assessPairedPilot(unsafe).status, 'safety-fail');
  assert.equal(assessPairedPilot(unsafe).conclusion, 'performance-not-established');
});
