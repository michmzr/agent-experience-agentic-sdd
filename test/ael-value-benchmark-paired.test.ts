import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
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
      sourceVersions: { codexHook: 1, typedAnnotation: 1, aclReview: 'public-review-v1' }, seed: 1,
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
    assert.throws(() => assessPairedReports(protocol, [{ slot, path: reportPath }]));
    const { schemaVersion: _schemaVersion, pairs: _pairs, order: _order, protocolDigest: _protocolDigest, ...protocolInput } = protocol;
    const claimedHostProtocol = createPairedProtocol({ ...protocolInput, sourceVersions: { ...protocol.sourceVersions, aap: 'aap-record@1' } });
    assert.throws(() => assessPairedReports(claimedHostProtocol, [{ slot, path: reportPath }]),
      'a locally re-sealed synthetic runner report is not a host delivery witness');
    seal({ ...forged, manifest: { ...manifest, environment: { ...environment, platform: 'different' } } });
    assert.throws(() => assessPairedReports(protocol, [{ slot, path: reportPath }]));
    seal(forged);
    writeFileSync(reportPath, readFileSync(reportPath, 'utf8').replace('"actualHost":{"status":"unsupported"', '"actualHost":{"status":"observed"'));
    assert.throws(() => assessPairedReports(protocol, [{ slot, path: reportPath }]));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('AVB-A4 assesses a publicly staged trial as incomplete without counting its declaration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'avb-b2-staged-assessment-'));
  try {
    const identity = JSON.parse(runCli(['benchmark', 'identity', '--json']).stdout) as { buildId: string };
    const environment = { nodeMajor: Number(process.versions.node.split('.')[0]), platform: process.platform, arch: process.arch };
    const protocol = createPairedProtocol({ corpusVersion: 'b2-1', baselineBuildId: identity.buildId,
      candidateBuildId: identity.buildId, sourceVersions: { runnerCorpus: 'b1-1', aap: 'unsupported' },
      environment, seed: 7, scenarios: [{ id: 'resume', revision: 1 }],
      budgets: { wallMilliseconds: 60000, aelOverheadMilliseconds: 10000, tokens: null } });
    const slotIndex = protocol.order.findIndex(item => item.condition === 'advice');
    const slot = protocol.order[slotIndex]!;
    const manifest = { schemaVersion: 2, role: 'candidate', label: 'avb-b2-stage', buildId: identity.buildId,
      corpusVersion: 'b1-1', environment, budgets: { runMilliseconds: 60000 },
      telemetry: { tokens: 'unavailable', wallTime: 'available' },
      sourceVersions: { codexHook: 1, typedAnnotation: 1, aclReview: 'public-review-v1' }, seed: 1,
      scenarios: b1Scenarios.map(id => ({ id, revision: 1, kind: 'pipeline' })) };
    const protocolPath = join(directory, 'protocol.json');
    const manifestPath = join(directory, 'manifest.json');
    const declarationPath = join(directory, 'declaration.json');
    const reportPath = join(directory, 'report.json');
    writeFileSync(protocolPath, JSON.stringify(protocol));
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(declarationPath, JSON.stringify({ taskCorrect: true, redundantOperationIds: [],
      safetyViolations: [], wallMilliseconds: 100, aelOverheadMilliseconds: 5, tokens: null }));
    const stage = runCli(['benchmark', 'trial', 'stage', '--protocol', protocolPath, '--slot-index', String(slotIndex),
      '--manifest', manifestPath, '--declaration', declarationPath, '--output', reportPath, '--json']);
    assert.equal(stage.exitCode, 0, stage.stdout);
    const result = assessPairedReports(protocol, [{ slot, path: reportPath }]);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.observedTrials, 0);
    assert.equal(result.missingSlots, protocol.order.length);
    assert.equal(result.conclusion, 'performance-not-established');

    const original = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
    const { reportDigest: _old, ...body } = original;
    const forged = { ...body, slot: { ...slot, pair: (slot.pair + 1) % 5 } };
    writeFileSync(reportPath, JSON.stringify({ ...forged, reportDigest: digest(JSON.stringify(forged)) }));
    assert.throws(() => assessPairedReports(protocol, [{ slot, path: reportPath }]));
    const claimed = { ...body, actualHost: { status: 'observed', qualification: 'verified' } };
    writeFileSync(reportPath, JSON.stringify({ ...claimed, reportDigest: digest(JSON.stringify(claimed)) }));
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
  const measurementRows = result.scenarios[0] as unknown as { measurements?: { pair: number }[] };
  assert.deepEqual(measurementRows.measurements?.filter(item => item.pair === 0), [
    { condition: 'disabled', pair: 0, wallMilliseconds: 100, aelOverheadMilliseconds: 0, tokens: 100 },
    { condition: 'passive', pair: 0, wallMilliseconds: 100, aelOverheadMilliseconds: null, tokens: null },
    { condition: 'advice', pair: 0, wallMilliseconds: 80, aelOverheadMilliseconds: 30, tokens: 90 }
  ]);
  const completeTelemetry = trials.map(trial => trial.condition === 'passive'
    ? { ...trial, aelOverheadMilliseconds: 5, tokens: 100 } : trial);
  assert.equal(assessPairedPilot(completeTelemetry).conclusion, 'performance-not-established');
  const unsafe = trials.map(trial => trial.condition === 'advice' && trial.pair === 2
    ? { ...trial, safetyViolations: ['wrong-scope-advice'] } : trial);
  assert.equal(assessPairedPilot(unsafe).status, 'safety-fail');
  assert.equal(assessPairedPilot(unsafe).conclusion, 'performance-not-established');
});

test('AVB-A5 compares the median within matched disabled/advice pairs', () => {
  const disabled = [1, 1, 1, 10, 10];
  const advice = [0, 0, 10, 9, 9];
  const trials: PilotTrial[] = disabled.flatMap((count, pair) => [
    { scenarioId: 'resume', pair, condition: 'disabled' as const, taskCorrect: true,
      redundantOperationIds: Array.from({ length: count }, (_, index) => `disabled-${pair}-${index}`),
      safetyViolations: [], wallMilliseconds: 100, aelOverheadMilliseconds: 0, tokens: 100 },
    { scenarioId: 'resume', pair, condition: 'passive' as const, taskCorrect: true,
      redundantOperationIds: [], safetyViolations: [], wallMilliseconds: 100, aelOverheadMilliseconds: 0, tokens: 100 },
    { scenarioId: 'resume', pair, condition: 'advice' as const, taskCorrect: true,
      redundantOperationIds: Array.from({ length: advice[pair]! }, (_, index) => `advice-${pair}-${index}`),
      safetyViolations: [], wallMilliseconds: 90, aelOverheadMilliseconds: 1, tokens: 90 }
  ]);
  const result = assessPairedPilot(trials);
  assert.equal(result.scenarios[0]?.status, 'behavioral-pass');
  assert.equal(result.scenarios[0]?.medianRedundantOperations.disabled, 1);
  assert.equal(result.scenarios[0]?.medianRedundantOperations.advice, 9);
  assert.equal(result.scenarios[0]?.medianSavedRedundantOperations, 1);
});

test('AVB-A4 reads only bounded regular report files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'avb-b2-bounds-'));
  try {
    const protocol = createPairedProtocol({ corpusVersion: 'b2-1', baselineBuildId: 'a'.repeat(64),
      candidateBuildId: 'b'.repeat(64), sourceVersions: { runnerCorpus: 'b1-1', aap: 'unsupported' },
      environment: { nodeMajor: Number(process.versions.node.split('.')[0]), platform: process.platform, arch: process.arch },
      seed: 7, scenarios: [{ id: 'resume', revision: 1 }],
      budgets: { wallMilliseconds: 60000, aelOverheadMilliseconds: 10000, tokens: null } });
    const slot = protocol.order[0]!;
    const devicePath = process.platform === 'win32' ? 'NUL' : '/dev/null';
    assert.throws(() => assessPairedReports(protocol, [{ slot, path: devicePath }]),
      { name: 'TypeError', message: 'Paired report must be a regular file.' });
    if (process.platform !== 'win32') assert.throws(() => assessPairedReports(protocol, [{ slot, path: '/dev/zero' }]),
      { name: 'TypeError', message: 'Paired report must be a regular file.' });
    const oversized = join(directory, 'oversized.json');
    writeFileSync(oversized, '');
    truncateSync(oversized, 4 * 1024 * 1024 + 1);
    assert.throws(() => assessPairedReports(protocol, [{ slot, path: oversized }]),
      { name: 'TypeError', message: 'Paired report exceeds size bound.' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
