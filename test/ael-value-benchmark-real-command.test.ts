import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCliAsync } from '../src/cli.js';
import { buildIdentity, digest } from '../src/benchmark/manifest.js';
import { crossSessionFixtureDigest, crossSessionFixtureDigestV2 } from '../src/benchmark/cross-session-scenario.js';
import { packageManagerFixtureDigest } from '../src/benchmark/real-scenario.js';
import { qualifiedCodexCli } from '../src/host/codex-cli-launcher.js';
import { publicCrossSessionTrial, qualifiesCrossSessionProbe,
  runCrossSessionExploration, writeRealBenchmarkCheckpoint } from '../src/benchmark/real-command.js';
import { createCrossSessionRealProtocol } from '../src/benchmark/paired.js';

function plan(baselineBuildId = 'a'.repeat(64), candidateBuildId = 'b'.repeat(64)) {
  const body = { schemaVersion: 1, corpusVersion: 'b2-1', baselineBuildId,
    candidateBuildId, sourceVersions: { runnerCorpus: 'b2-1', aap: 'codex-exposure-v1' },
    environment: { nodeMajor: Number(process.versions.node.split('.')[0]), platform: process.platform, arch: process.arch },
    seed: 7, scenarios: [{ id: 'package-manager-fact', revision: 1 }],
    budgets: { wallMilliseconds: 60_000, aelOverheadMilliseconds: 10_000, tokens: null },
    agent: { model: 'gpt-6-sol', cliVersion: '0.157.1', binarySha256: qualifiedCodexCli.sha256,
      sandbox: 'workspace-write', approval: 'never' }, fixtureDigest: packageManagerFixtureDigest };
  return { ...body, planDigest: digest(JSON.stringify(body)) };
}

function crossSessionPlan(baselineBuildId = 'a'.repeat(64), candidateBuildId = 'b'.repeat(64)) {
  const body = { schemaVersion: 2, corpusVersion: 'b2-2', baselineBuildId,
    candidateBuildId, sourceVersions: { runnerCorpus: 'b2-2', aap: 'codex-exposure-v1' },
    environment: { nodeMajor: Number(process.versions.node.split('.')[0]), platform: process.platform, arch: process.arch },
    seed: 7, scenarios: [{ id: 'cross-session-package-manager', revision: 1 }],
    budgets: { wallMilliseconds: 60_000, aelOverheadMilliseconds: 10_000, tokens: null },
    agent: { model: 'gpt-6-sol', cliVersion: '0.157.1', binarySha256: qualifiedCodexCli.sha256,
      sandbox: 'workspace-write', approval: 'never' }, fixtureDigest: crossSessionFixtureDigest };
  return { ...body, planDigest: digest(JSON.stringify(body)) };
}

function crossSessionPlanV2(baselineBuildId = 'a'.repeat(64), candidateBuildId = 'b'.repeat(64)) {
  const historical = crossSessionPlan(baselineBuildId, candidateBuildId);
  const { planDigest: _planDigest, ...body } = historical;
  const revised = { ...body, corpusVersion: 'b2-3',
    sourceVersions: { runnerCorpus: 'b2-3', aap: 'codex-exposure-v1' },
    scenarios: [{ id: 'cross-session-package-manager', revision: 2 }],
    fixtureDigest: crossSessionFixtureDigestV2 };
  return { ...revised, planDigest: digest(JSON.stringify(revised)) };
}

test('pre-freeze gate requires two correct B sessions and a qualified repeated disabled read', () => {
  const session = { taskCorrect: true, separateCheck: true, exactReadCount: 1, safetyViolations: [] };
  const complete = { status: 'complete' as const,
    adviceUseQualified: false,
    pilot: { taskCorrect: true, redundantOperationIds: ['op-b2'], safetyViolations: [] },
    sessions: { B1: session, B2: session } };
  assert.equal(qualifiesCrossSessionProbe(complete, 'disabled'), true);
  assert.equal(qualifiesCrossSessionProbe({ ...complete,
    pilot: { ...complete.pilot, redundantOperationIds: [] } }, 'disabled'), false);
  assert.equal(qualifiesCrossSessionProbe({ ...complete,
    sessions: { B1: session, B2: { ...session, exactReadCount: 0 } } }, 'disabled'), false);
  assert.equal(qualifiesCrossSessionProbe({ ...complete,
    sessions: { B1: session, B2: { ...session, separateCheck: false } } }, 'disabled'), false);
  assert.equal(qualifiesCrossSessionProbe({ ...complete,
    status: 'task-failed' }, 'disabled'), false);
  assert.equal(qualifiesCrossSessionProbe({ ...complete, sessions: { B1: session, B2: null } }, 'disabled'), false);
  assert.equal(qualifiesCrossSessionProbe({ ...complete,
    pilot: { ...complete.pilot, redundantOperationIds: [] } }, 'advice'), false);
  assert.equal(qualifiesCrossSessionProbe({ ...complete, adviceUseQualified: true,
    pilot: { ...complete.pilot, redundantOperationIds: [] } }, 'advice'), true);
});

test('public v3 trial projection retains session-bound IDs but drops raw command and output', () => {
  const slot = { scenarioId: 'cross-session-package-manager', pair: 0, condition: 'disabled' as const };
  const trial = { slotIndex: 0, buildId: 'a'.repeat(64), status: 'complete' as const,
    operationSource: 'cli-json-item' as const, unsupportedCode: null,
    pilot: { taskCorrect: true, redundantOperationIds: ['op-b2'], safetyViolations: [],
      wallMilliseconds: 12, aelOverheadMilliseconds: null, tokens: 300 }, totalWallMilliseconds: 12,
    operations: [{ session: 'B1' as const, id: 'op-b1', kind: 'exact-manifest-read', outcome: 'succeeded' as const,
      command: 'cat /private/workspace/secret', output: 'private output' },
    { session: 'B2' as const, id: 'op-b2', kind: 'exact-manifest-read', outcome: 'succeeded' as const,
      command: 'cat /private/workspace/secret', output: 'private output' }],
    sessions: { B1: { sessionId: 'private-session-b1', taskCorrect: true, separateCheck: true,
      exactReadCount: 1, safetyViolations: [] }, B2: { sessionId: 'private-session-b2', taskCorrect: true,
      separateCheck: true, exactReadCount: 1, safetyViolations: [] } } };
  const projected = publicCrossSessionTrial(slot, trial);
  assert.equal(projected.operations.length, 2);
  assert.deepEqual(projected.operations.map(operation => operation.session), ['B1', 'B2']);
  assert.deepEqual(projected.redundantOperationIds, ['op-b2']);
  assert.equal(JSON.stringify(projected).includes('/private/workspace'), false);
  assert.equal(JSON.stringify(projected).includes('private-session'), false);
  assert.equal(JSON.stringify(projected).includes('private output'), false);
  assert.throws(() => publicCrossSessionTrial(slot, { ...trial,
    operations: [{ ...trial.operations[0]!, id: '/private/workspace/secret' }] }));
  assert.throws(() => publicCrossSessionTrial(slot, { ...trial,
    pilot: { ...trial.pilot, safetyViolations: ['/private/workspace/secret'] } }));
});

test('public v3 checkpoint atomically replaces an incomplete report with private file mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'avb-real-checkpoint-'));
  try {
    const output = join(dir, 'report.json');
    writeRealBenchmarkCheckpoint(output, { status: 'incomplete', slots: [] }, true);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.throws(() => writeRealBenchmarkCheckpoint(output, { status: 'complete', slots: [] }, true));
    writeRealBenchmarkCheckpoint(output, { status: 'incomplete', slots: [{ status: 'unsupported' }] }, false);
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.status, 'incomplete');
    assert.equal(report.slots.length, 1);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    const { reportDigest, ...body } = report;
    assert.equal(reportDigest, digest(JSON.stringify(body)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('failed first exploratory B session stops before another child or the 15-slot series', async () => {
  const frozen = crossSessionPlan();
  const { schemaVersion: _schemaVersion, planDigest: _planDigest, ...input } = frozen;
  const protocol = createCrossSessionRealProtocol({ ...input, seedStoreDigest: '0'.repeat(64) } as
    Parameters<typeof createCrossSessionRealProtocol>[0]);
  const calls: number[] = [];
  const failed = { status: 'task-failed' as const, pilot: { taskCorrect: false,
    redundantOperationIds: [], safetyViolations: [] }, sessions: { B1: { taskCorrect: false,
    separateCheck: false, exactReadCount: 0, safetyViolations: [] }, B2: null } };
  const exploratory = await runCrossSessionExploration(protocol, async slotIndex => {
    calls.push(slotIndex);
    return failed as never;
  });
  assert.equal(exploratory.qualified, false);
  assert.equal(exploratory.trials.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(protocol.order[calls[0]!]!.condition, 'disabled');
});

test('pre-freeze exploration uses two disabled pairs and one advice pair outside the series', async () => {
  const frozen = crossSessionPlan();
  const { schemaVersion: _schemaVersion, planDigest: _planDigest, ...input } = frozen;
  const protocol = createCrossSessionRealProtocol({ ...input, seedStoreDigest: '0'.repeat(64) } as
    Parameters<typeof createCrossSessionRealProtocol>[0]);
  const session = { taskCorrect: true, separateCheck: true, exactReadCount: 1, safetyViolations: [] };
  const calls: number[] = [];
  const probe = await runCrossSessionExploration(protocol, async slotIndex => {
    calls.push(slotIndex);
    return { status: 'complete', adviceUseQualified: protocol.order[slotIndex]!.condition === 'advice',
      pilot: { taskCorrect: true, safetyViolations: [], redundantOperationIds: ['b2-read'] },
      sessions: { B1: session, B2: session } } as never;
  });
  assert.equal(probe.qualified, true);
  assert.equal(probe.status, 'qualified-awaiting-freeze');
  assert.equal(probe.trials.length, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(index => ({ pair: protocol.order[index]!.pair,
    condition: protocol.order[index]!.condition })), [
    { pair: 0, condition: 'disabled' }, { pair: 1, condition: 'disabled' },
    { pair: 0, condition: 'advice' }
  ]);
});

test('public real benchmark accepts v3 plan shape before binary preflight', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'avb-real-v3-plan-test-'));
  try {
    const planPath = join(dir, 'plan.json');
    const output = join(dir, 'report.json');
    for (const root of [join(dir, 'baseline'), join(dir, 'candidate')]) {
      mkdirSync(join(root, 'dist/src'), { recursive: true });
      writeFileSync(join(root, 'dist/src/cli.js'), root);
    }
    writeFileSync(planPath, JSON.stringify(crossSessionPlan()));
    const result = await runCliAsync(['benchmark', 'real', 'run', '--plan', planPath,
      '--codex-binary', join(dir, 'missing'), '--baseline-root', join(dir, 'baseline'),
      '--candidate-root', join(dir, 'candidate'), '--output', output, '--json'], { workingDirectory: dir });
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /Real benchmark build differs from frozen plan/);
    assert.throws(() => readFileSync(output));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('public real benchmark accepts b2-3/rev2 plan only with its frozen fixture digest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'avb-real-v3-rev2-plan-'));
  try {
    const planPath = join(dir, 'plan.json');
    const output = join(dir, 'report.json');
    const baselineRoot = join(dir, 'baseline');
    const candidateRoot = join(dir, 'candidate');
    for (const root of [baselineRoot, candidateRoot]) mkdirSync(join(root, 'dist/src'), { recursive: true });
    writeFileSync(join(baselineRoot, 'dist/src/cli.js'), 'baseline');
    writeFileSync(join(candidateRoot, 'dist/src/cli.js'), 'candidate');
    const frozen = crossSessionPlanV2();
    writeFileSync(planPath, JSON.stringify(frozen));
    const args = ['benchmark', 'real', 'run', '--plan', planPath,
      '--codex-binary', join(dir, 'missing'), '--baseline-root', baselineRoot,
      '--candidate-root', candidateRoot, '--output', output, '--json'];
    const accepted = await runCliAsync(args, { workingDirectory: dir });
    assert.equal(accepted.exitCode, 1);
    assert.match(accepted.stdout, /Real benchmark build differs from frozen plan/);
    assert.throws(() => readFileSync(output));
    const substituted = { ...frozen, fixtureDigest: crossSessionFixtureDigest };
    writeFileSync(planPath, JSON.stringify({ ...substituted,
      planDigest: digest(JSON.stringify({ ...substituted, planDigest: undefined })) }));
    const rejected = await runCliAsync(args, { workingDirectory: dir });
    assert.equal(rejected.exitCode, 1);
    assert.doesNotMatch(rejected.stdout, /Real benchmark build differs from frozen plan/);
    assert.throws(() => readFileSync(output));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('public real benchmark rejects both unqualified cross-session revisions without invoking the provider',
  { skip: !existsSync('/opt/homebrew/bin/codex') }, async () => {
  for (const createPlan of [crossSessionPlan, crossSessionPlanV2]) {
    const dir = mkdtempSync(join(tmpdir(), 'avb-real-v3-rejected-'));
    try {
      const planPath = join(dir, 'plan.json');
      const output = join(dir, 'report.json');
      const baselineRoot = join(dir, 'baseline');
      const candidateRoot = join(dir, 'candidate');
      for (const root of [baselineRoot, candidateRoot]) mkdirSync(join(root, 'dist/src'), { recursive: true });
      writeFileSync(join(baselineRoot, 'dist/src/cli.js'), 'baseline');
      writeFileSync(join(candidateRoot, 'dist/src/cli.js'), 'candidate');
      const frozen = createPlan(buildIdentity(baselineRoot), buildIdentity(candidateRoot));
      writeFileSync(planPath, JSON.stringify(frozen));
      const result = await runCliAsync(['benchmark', 'real', 'run', '--plan', planPath,
        '--codex-binary', '/opt/homebrew/bin/codex', '--baseline-root', baselineRoot,
        '--candidate-root', candidateRoot, '--output', output, '--json'], { workingDirectory: dir });
      assert.equal(result.exitCode, 0, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).externalProviderInvoked, false);
      const report = JSON.parse(readFileSync(output, 'utf8'));
      assert.equal(report.schemaVersion, 2);
      assert.equal(report.status, 'incomplete');
      assert.equal(report.conclusion, 'performance-not-established');
      assert.equal(report.exploratory.status, 'rejected');
      assert.equal(report.exploratory.reason, 'scenario-rejected');
      assert.equal(report.protocol, null);
      assert.equal(report.slots.length, 15);
      assert.ok(report.slots.every((slot: { status: string; reason: string }) =>
        slot.status === 'unsupported' && slot.reason === 'scenario-rejected'));
      assert.equal(report.provenance.invocation, 'not-started');
      assert.equal(report.provenance.commandProvenanceLimit, 'command-text-and-output-only');
      assert.equal(statSync(output).mode & 0o777, 0o600);
      assert.equal(JSON.stringify(report).includes(dir), false);
      const { reportDigest, ...body } = report;
      assert.equal(reportDigest, digest(JSON.stringify(body)));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('public real benchmark rejects v3 corpus substitution and changed budgets before any host call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'avb-real-v3-substitution-'));
  try {
    const planPath = join(dir, 'plan.json');
    const output = join(dir, 'report.json');
    const args = ['benchmark', 'real', 'run', '--plan', planPath, '--codex-binary', join(dir, 'missing'),
      '--baseline-root', join(dir, 'baseline'), '--candidate-root', join(dir, 'candidate'),
      '--output', output, '--json'];
    const swapped = crossSessionPlan();
    swapped.fixtureDigest = packageManagerFixtureDigest;
    writeFileSync(planPath, JSON.stringify({ ...swapped, planDigest: digest(JSON.stringify({
      ...swapped, planDigest: undefined })) }));
    const corpus = await runCliAsync(args, { workingDirectory: dir });
    assert.equal(corpus.exitCode, 1);
    assert.throws(() => readFileSync(output));

    const changed = crossSessionPlan();
    changed.budgets.wallMilliseconds = 90_000;
    writeFileSync(planPath, JSON.stringify(changed));
    const budget = await runCliAsync(args, { workingDirectory: dir });
    assert.equal(budget.exitCode, 1);
    assert.match(budget.stdout, /Real benchmark plan was modified/);
    assert.throws(() => readFileSync(output));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('public real benchmark preflight persists an incomplete sanitized report without a model call',
  { skip: !existsSync('/opt/homebrew/bin/codex') }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'avb-real-command-test-'));
  try {
    const planPath = join(dir, 'plan.json');
    const output = join(dir, 'report.json');
    const baselineRoot = join(dir, 'baseline');
    const candidateRoot = join(dir, 'candidate');
    for (const root of [baselineRoot, candidateRoot]) mkdirSync(join(root, 'dist/src'), { recursive: true });
    writeFileSync(join(baselineRoot, 'dist/src/cli.js'), 'baseline');
    writeFileSync(join(candidateRoot, 'dist/src/cli.js'), 'candidate');
    const frozen = plan(buildIdentity(baselineRoot), buildIdentity(candidateRoot));
    writeFileSync(planPath, JSON.stringify(frozen));
    const args = ['benchmark', 'real', 'run', '--plan', planPath, '--codex-binary', '/opt/homebrew/bin/codex',
      '--baseline-root', baselineRoot, '--candidate-root', candidateRoot,
      '--output', output, '--json'];
    const result = await runCliAsync(args, { workingDirectory: dir });
    assert.equal(result.exitCode, 0, result.stdout + result.stderr);
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.status, 'incomplete');
    assert.equal(report.conclusion, 'performance-not-established');
    assert.equal(report.frozenPlan.planDigest, frozen.planDigest);
    assert.equal(report.protocol, null);
    assert.equal(report.protocolDigest, null);
    assert.equal(report.baselineBuildId, frozen.baselineBuildId);
    assert.equal(report.candidateBuildId, frozen.candidateBuildId);
    assert.equal(report.provenance.buildVerification, 'matched');
    assert.equal(report.provenance.binaryVerification, 'matched');
    assert.equal(report.provenance.binarySha256, qualifiedCodexCli.sha256);
    assert.equal(report.slots.length, 15);
    assert.ok(report.slots.every((slot: { status: string; reason: string; operationIds: string[] }) =>
      slot.status === 'unsupported' && slot.reason === 'source-not-qualified' && slot.operationIds.length === 0));
    assert.equal(report.assessment.observedTrials, 0);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(report).includes(dir), false);
    const { reportDigest, ...body } = report;
    assert.equal(reportDigest, digest(JSON.stringify(body)));
    const second = await runCliAsync(args, { workingDirectory: dir });
    assert.equal(second.exitCode, 1);
    assert.equal(readFileSync(output, 'utf8'), JSON.stringify(report, null, 2) + '\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('public real benchmark rejects a modified or unpinned plan before writing a report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'avb-real-plan-test-'));
  try {
    const planPath = join(dir, 'plan.json');
    const output = join(dir, 'report.json');
    const altered = plan();
    altered.agent.model = 'other-model';
    writeFileSync(planPath, JSON.stringify(altered));
    const result = await runCliAsync(['benchmark', 'real', 'run', '--plan', planPath,
      '--codex-binary', join(dir, 'missing'), '--baseline-root', join(dir, 'baseline'),
      '--candidate-root', join(dir, 'candidate'), '--output', output, '--json'], { workingDirectory: dir });
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /error/);
    assert.throws(() => readFileSync(output));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('public real benchmark refuses build or executable substitution before publication', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'avb-real-substitution-test-'));
  try {
    const baselineRoot = join(dir, 'baseline');
    const candidateRoot = join(dir, 'candidate');
    for (const root of [baselineRoot, candidateRoot]) mkdirSync(join(root, 'dist/src'), { recursive: true });
    writeFileSync(join(baselineRoot, 'dist/src/cli.js'), 'baseline');
    writeFileSync(join(candidateRoot, 'dist/src/cli.js'), 'candidate');
    const planPath = join(dir, 'plan.json');
    const output = join(dir, 'report.json');
    const args = ['benchmark', 'real', 'run', '--plan', planPath, '--codex-binary', join(dir, 'codex'),
      '--baseline-root', baselineRoot, '--candidate-root', candidateRoot, '--output', output, '--json'];
    writeFileSync(planPath, JSON.stringify(plan('a'.repeat(64), buildIdentity(candidateRoot))));
    const wrongBuild = await runCliAsync(args, { workingDirectory: dir });
    assert.equal(wrongBuild.exitCode, 1);
    assert.throws(() => readFileSync(output));

    writeFileSync(planPath, JSON.stringify(plan(buildIdentity(baselineRoot), buildIdentity(candidateRoot))));
    writeFileSync(join(dir, 'codex'), '#!/bin/sh\necho codex-cli 0.157.1\n', { mode: 0o700 });
    const wrongBinary = await runCliAsync(args, { workingDirectory: dir });
    assert.equal(wrongBinary.exitCode, 1);
    assert.throws(() => readFileSync(output));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
