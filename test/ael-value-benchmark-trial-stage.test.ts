import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../src/cli.js';
import { assessPairedReports, createPairedProtocol } from '../src/benchmark/paired.js';
import { stageTrial } from '../src/benchmark/trial-stage.js';

test('AVB-A4 trial inputs reject non-regular and oversized files before parsing', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ael-avb-input-bound-'));
  try {
    const oversized = join(directory, 'oversized.json');
    writeFileSync(oversized, ' '.repeat(1024 * 1024 + 1));
    assert.throws(() => stageTrial('/dev/null', '0', oversized, oversized, join(directory, 'device-report.json')),
      /Benchmark trial input must be a regular file/);
    assert.throws(() => stageTrial('/dev/zero', '0', oversized, oversized, join(directory, 'zero-report.json')),
      /Benchmark trial input must be a regular file/);
    assert.throws(() => stageTrial(oversized, '0', oversized, oversized, join(directory, 'oversized-report.json')),
      /Benchmark trial input exceeds size bound/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('AVB-A4 trial staging pins a sanitized declaration without qualifying host evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ael-avb-stage-'));
  try {
    const buildId = JSON.parse(runCli(['benchmark', 'identity', '--json']).stdout).buildId as string;
    const environment = { nodeMajor: Number(process.versions.node.split('.')[0]), platform: process.platform, arch: process.arch };
    const protocol = createPairedProtocol({ corpusVersion: 'b2-1', baselineBuildId: buildId, candidateBuildId: buildId,
      sourceVersions: { runnerCorpus: 'b1-1', aap: 'unsupported' }, environment, seed: 17,
      scenarios: [{ id: 'resume', revision: 1 }], budgets: { wallMilliseconds: 60000, aelOverheadMilliseconds: 1000, tokens: null } });
    const slotIndex = protocol.order.findIndex(slot => slot.condition === 'disabled');
    const manifest = { schemaVersion: 2, role: 'baseline', label: 'pilot-baseline', buildId,
      corpusVersion: 'b1-1', environment, budgets: { runMilliseconds: 60000 },
      telemetry: { tokens: 'unavailable', wallTime: 'available' },
      sourceVersions: { codexHook: 1, typedAnnotation: 1, aclReview: 'public-review-v1' }, seed: 1,
      scenarios: ['resume', 'unknown-result', 'recovery', 'scoped-convention', 'typed-verification']
        .map(id => ({ id, revision: 1, kind: 'pipeline' })) };
    const declaration = { taskCorrect: true, redundantOperationIds: ['search-1'], safetyViolations: [],
      wallMilliseconds: 50, aelOverheadMilliseconds: null, tokens: null };
    const protocolPath = join(directory, 'protocol.json'); const manifestPath = join(directory, 'manifest.json');
    const declarationPath = join(directory, 'declaration.json'); const output = join(directory, 'trial.json');
    writeFileSync(protocolPath, JSON.stringify(protocol)); writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(declarationPath, JSON.stringify(declaration));
    const invoke = (out: string) => runCli(['benchmark', 'trial', 'stage', '--protocol', protocolPath,
      '--slot-index', String(slotIndex), '--manifest', manifestPath, '--declaration', declarationPath,
      '--output', out, '--json']);
    const result = invoke(output);
    assert.equal(result.exitCode, 0, result.stdout);
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.status, 'incomplete');
    assert.equal(report.actualHost.status, 'unsupported');
    assert.equal(report.protocolDigest, protocol.protocolDigest);
    assert.deepEqual(report.protocol.budgets, protocol.budgets);
    assert.deepEqual(report.protocol.order, protocol.order);
    assert.deepEqual(report.protocol.sourceVersions, protocol.sourceVersions);
    assert.deepEqual(report.slot, protocol.order[slotIndex]);
    assert.equal(report.pilot, undefined);
    assert.equal(report.declaration.taskCorrect, true);
    assert.equal(report.declaration.aelOverheadMilliseconds, null);
    assert.equal(JSON.stringify(report).includes(directory), false);
    const assessment = assessPairedReports(protocol, [{ slot: protocol.order[slotIndex]!, path: output }]);
    assert.equal(assessment.status, 'incomplete');
    assert.equal(assessment.observedTrials, 0);
    assert.equal(assessment.conclusion, 'performance-not-established');
    assert.equal(invoke(output).exitCode, 1);
    writeFileSync(declarationPath, JSON.stringify({ ...declaration, rawTranscript: 'secret' }));
    assert.equal(invoke(join(directory, 'unsafe.json')).exitCode, 1);
    writeFileSync(declarationPath, JSON.stringify({ ...declaration, tokens: 25 }));
    assert.equal(invoke(join(directory, 'unavailable-tokens.json')).exitCode, 1);
    const credential = `sk-${'a'.repeat(24)}`;
    writeFileSync(declarationPath, JSON.stringify({ ...declaration, redundantOperationIds: [credential] }));
    const privateOutput = join(directory, 'private-operation.json');
    const privateResult = invoke(privateOutput);
    assert.equal(privateResult.exitCode, 1);
    assert.equal(privateResult.stdout.includes(credential) || privateResult.stderr.includes(credential), false);
    assert.equal(existsSync(privateOutput), false);
    writeFileSync(declarationPath, JSON.stringify(declaration));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, label: credential }));
    assert.equal(invoke(join(directory, 'private-label.json')).exitCode, 1);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const privateProtocol = createPairedProtocol({ corpusVersion: protocol.corpusVersion,
      baselineBuildId: protocol.baselineBuildId, candidateBuildId: protocol.candidateBuildId,
      sourceVersions: { ...protocol.sourceVersions, aap: credential }, environment: protocol.environment,
      seed: protocol.seed, scenarios: protocol.scenarios, budgets: protocol.budgets });
    writeFileSync(protocolPath, JSON.stringify(privateProtocol));
    assert.equal(invoke(join(directory, 'private-source.json')).exitCode, 1);
    writeFileSync(protocolPath, JSON.stringify(protocol));
    writeFileSync(protocolPath, JSON.stringify({ ...protocol, budgets: { ...protocol.budgets, wallMilliseconds: 1 } }));
    assert.equal(invoke(join(directory, 'substituted.json')).exitCode, 1);
    writeFileSync(protocolPath, JSON.stringify(protocol));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, role: 'candidate' }));
    assert.equal(invoke(join(directory, 'wrong-role.json')).exitCode, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
