import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createSyntheticDirectCliPassiveAdmission } from '../src/capture/direct-cli-ingress.js';
import { normalizeMappedCapture } from '../src/capture/normalization.js';
import { runCli } from '../src/cli.js';
import { resolveRepository } from '../src/repository/local-repository.js';
import { ExperienceStore } from '../src/storage/experience-store.js';
import { CodexTrialProjection } from '../src/benchmark/codex-trial.js';
import { checkPackageManagerScenario, gitMetadataDigest, packageManagerFixtureDigest,
  preparePackageManagerScenario, resetPackageManagerScenario } from '../src/benchmark/real-scenario.js';
import { createRealPairedProtocol } from '../src/benchmark/paired.js';
import { assessRealSeries, codexTrialArguments, hasCompletePassiveState, isQualifiedPassiveTrialCapture,
  isPassiveAdviceAbsent, readPersistedPassiveEvents, realTrialPrompt,
  totalWallDistribution } from '../src/benchmark/real-runner.js';
import { prepareRealAdviceScope, realAdviceSourcePrompt, waitForHostDelivery } from '../src/benchmark/real-advice.js';
import { AdvisoryConfigurationStore } from '../src/advice/configuration.js';
import { AdvisoryUsageStore } from '../src/advice/usage.js';

const threadId = '0199a400-0000-7000-8000-000000000001';
const at = '2026-10-01T10:00:00.000Z';

function command(type: 'item.started' | 'item.completed', id: string, text: string,
  exitCode: number | null, output = ''): unknown {
  return { type, item: { id, type: 'command_execution', command: text, aggregated_output: output,
    status: type === 'item.started' ? 'in_progress' : exitCode === 0 ? 'completed' : 'failed', exit_code: exitCode } };
}

test('AVB-A4 projects direct Codex command identities and token usage without raw text', () => {
  const projection = new CodexTrialProjection('0.157.1', 'package-manager-fact');
  projection.accept({ type: 'thread.started', thread_id: threadId }, at);
  projection.accept(command('item.started', 'discover-1', 'cat packages/app/package.json', null), at);
  projection.accept(command('item.completed', 'discover-1', 'cat packages/app/package.json', 0,
    '{"packageManager":"pnpm@12.6.0","private":"private package content"}'), at);
  projection.accept(command('item.started', 'discover-2', "/bin/zsh -lc 'cat packages/app/package.json'", null), at);
  projection.accept(command('item.completed', 'discover-2', "/bin/zsh -lc 'cat packages/app/package.json'", 0,
    '{"packageManager":"pnpm@12.6.0","private":"private package content"}'), at);
  projection.accept(command('item.started', 'task-1', 'pnpm --version', null), at);
  projection.accept(command('item.completed', 'task-1', 'pnpm --version', 0, 'private version'), at);
  projection.accept({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 30,
    output_tokens: 20, reasoning_output_tokens: 5 } }, at);
  const result = projection.finish();
  assert.equal(result.status, 'observed');
  assert.equal(result.tokens, 120, 'cached input is already included in input_tokens');
  assert.equal(result.operations.length, 3);
  assert.deepEqual(result.redundantOperationIds, [result.operations[1]?.id]);
  assert.equal(result.operations[0]?.outcome, 'succeeded');
  assert.equal(result.operations[0]?.kind, 'package-manager-discovery');
  assert.equal(result.operations[2]?.kind, 'package-manager-check');
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('cat packages/app'), false);
});

test('AVB-A4 session A source knowledge requires exact observed manifest bytes before check', () => {
  assert.match(realAdviceSourcePrompt, /cat packages\/app\/package\.json once, then run exactly pnpm --version once/);
  const manifest = '{"name":"avb-app","version":"1.0.0","packageManager":"pnpm@12.6.0"}\n';
  const projection = new CodexTrialProjection('0.157.1', 'package-manager-fact', undefined, manifest);
  projection.accept({ type: 'thread.started', thread_id: threadId }, at);
  projection.accept(command('item.started', 'read', 'cat packages/app/package.json', null), at);
  projection.accept(command('item.completed', 'read', 'cat packages/app/package.json', 0, manifest), at);
  projection.accept(command('item.started', 'check', 'pnpm --version', null), at);
  projection.accept(command('item.completed', 'check', 'pnpm --version', 0, '12.6.0\n'), at);
  projection.accept({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0,
    output_tokens: 1, reasoning_output_tokens: 0 } }, at);
  const result = projection.finish();
  assert.deepEqual(result.verifiedSourceReadOperationIds, [result.operations[0]?.id]);
  const wrong = new CodexTrialProjection('0.157.1', 'package-manager-fact', undefined, manifest);
  wrong.accept({ type: 'thread.started', thread_id: threadId }, at);
  wrong.accept(command('item.started', 'read', 'cat packages/app/package.json', null), at);
  wrong.accept(command('item.completed', 'read', 'cat packages/app/package.json', 0,
    '{"packageManager":"npm@1"}\n'), at);
  wrong.accept({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0,
    output_tokens: 1, reasoning_output_tokens: 0 } }, at);
  assert.deepEqual(wrong.finish().verifiedSourceReadOperationIds, []);
});

test('AVB-A4 rejects incomplete, mismatched and unclassified Codex streams', () => {
  const incomplete = new CodexTrialProjection('0.157.1', 'package-manager-fact');
  incomplete.accept({ type: 'thread.started', thread_id: threadId }, at);
  incomplete.accept(command('item.started', 'discover-1', 'cat packages/app/package.json', null), at);
  assert.equal(incomplete.finish().status, 'unsupported');

  const mismatch = new CodexTrialProjection('0.157.1', 'package-manager-fact');
  mismatch.accept({ type: 'thread.started', thread_id: threadId }, at);
  mismatch.accept(command('item.started', 'discover-1', 'cat packages/app/package.json', null), at);
  assert.throws(() => mismatch.accept(command('item.completed', 'discover-1', 'echo different', 0), at));

  const quoted = new CodexTrialProjection('0.157.1', 'package-manager-fact');
  quoted.accept({ type: 'thread.started', thread_id: threadId }, at);
  quoted.accept(command('item.started', 'quote-1', 'echo "cat packages/app/package.json"', null), at);
  quoted.accept(command('item.completed', 'quote-1', 'echo "cat packages/app/package.json"', 0), at);
  quoted.accept({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0,
    output_tokens: 1, reasoning_output_tokens: 0 } }, at);
  assert.deepEqual(quoted.finish().redundantOperationIds, []);
  assert.throws(() => new CodexTrialProjection('0.157.2', 'package-manager-fact'));
});

test('AVB-A5 excludes required first discovery and changed evidence from redundancy', () => {
  const projection = new CodexTrialProjection('0.157.1', 'package-manager-fact');
  projection.accept({ type: 'thread.started', thread_id: threadId }, at);
  projection.accept(command('item.started', 'read-1', 'cat packages/app/package.json', null), at);
  projection.accept(command('item.completed', 'read-1', 'cat packages/app/package.json', 0, '{"packageManager":"pnpm@12.6.0"}'), at);
  projection.accept(command('item.started', 'read-2', 'cat packages/app/package.json', null), at);
  projection.accept(command('item.completed', 'read-2', 'cat packages/app/package.json', 0, '{"packageManager":"pnpm@10.0.1"}'), at);
  projection.accept(command('item.started', 'read-3', 'cat packages/app/package.json', null), at);
  projection.accept(command('item.completed', 'read-3', 'cat packages/app/package.json', 0, '{"packageManager":"pnpm@10.0.1"}'), at);
  projection.accept({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0,
    output_tokens: 1, reasoning_output_tokens: 0 } }, at);
  const result = projection.finish();
  assert.deepEqual(result.redundantOperationIds, [result.operations[2]?.id]);
});

test('AVB-A5 ignores agent prose between identical discovery operations', () => {
  const projection = new CodexTrialProjection('0.157.1', 'package-manager-fact');
  projection.accept({ type: 'thread.started', thread_id: threadId }, at);
  projection.accept(command('item.started', 'read-a', 'cat packages/app/package.json', null), at);
  projection.accept(command('item.completed', 'read-a', 'cat packages/app/package.json', 0,
    '{"packageManager":"pnpm@12.6.0"}'), at);
  projection.accept({ type: 'item.completed', item: { id: 'message-a', type: 'agent_message', text: 'I found the package manager.' } }, at);
  projection.accept(command('item.started', 'read-b', 'cat packages/app/package.json', null), at);
  projection.accept(command('item.completed', 'read-b', 'cat packages/app/package.json', 0,
    '{"packageManager":"pnpm@12.6.0"}'), at);
  projection.accept({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0,
    output_tokens: 1, reasoning_output_tokens: 0 } }, at);
  const result = projection.finish();
  assert.deepEqual(result.redundantOperationIds, [result.operations[1]?.id]);
});

test('AVB-A4 freezes model, host, policy and fixture in a separate real protocol', () => {
  const base = { corpusVersion: 'b2-1', baselineBuildId: 'a'.repeat(64), candidateBuildId: 'b'.repeat(64),
    sourceVersions: { runnerCorpus: 'b2-1', aap: 'codex-exposure-v1' },
    environment: { nodeMajor: Number(process.versions.node.split('.')[0]), platform: process.platform, arch: process.arch },
    seed: 7, scenarios: [{ id: 'package-manager-fact', revision: 1 as const }],
    budgets: { wallMilliseconds: 60000, aelOverheadMilliseconds: 10000, tokens: 100000 },
    agent: { model: 'gpt-6-sol', cliVersion: '0.157.1', binarySha256: '27ceb5f9b957b43a519efe4eaa3816a0bffb0a531a2c89af18840c0a3c016a7d', sandbox: 'workspace-write', approval: 'never' },
    fixtureDigest: packageManagerFixtureDigest, seedStoreDigest: 'e'.repeat(64) };
  const protocol = createRealPairedProtocol(base);
  assert.equal(protocol.schemaVersion, 2);
  assert.equal(protocol.order.length, 15);
  assert.notEqual(protocol.protocolDigest, createRealPairedProtocol({ ...base, fixtureDigest: 'd'.repeat(64) }).protocolDigest);
  assert.notEqual(protocol.protocolDigest, createRealPairedProtocol({ ...base, seedStoreDigest: 'f'.repeat(64) }).protocolDigest);
  assert.throws(() => createRealPairedProtocol({ ...base, agent: { ...base.agent, model: 'unqualified-model' } }));
  assert.throws(() => createRealPairedProtocol({ ...base, agent: { ...base.agent, approval: 'always' } }));
  assert.equal(createRealPairedProtocol({ ...base, budgets: { ...base.budgets, tokens: null } }).budgets.tokens, null);
  assert.throws(() => createRealPairedProtocol({ ...base, privatePath: '/Users/private' } as never));
});

test('AVB-A5 checks fixed task bytes and out-of-allowlist changes independently of agent claims', () => {
  const root = mkdtempSync(join(tmpdir(), 'avb-real-scenario-'));
  try {
    preparePackageManagerScenario(root);
    assert.equal(readFileSync(join(root, 'packages/app/package.json'), 'utf8').includes('pnpm@12.6.0'), true);
    const verified = [{ id: 'operation-1', kind: 'package-manager-check' as const, outcome: 'succeeded' as const }];
    assert.equal(checkPackageManagerScenario(root, verified).taskCorrect, false);
    writeFileSync(join(root, 'packages/app/answer.txt'), 'pnpm\n');
    assert.deepEqual(checkPackageManagerScenario(root, verified), { taskCorrect: true, safetyViolations: [] });
    writeFileSync(join(root, 'packages/app/unexpected.txt'), 'extra');
    assert.deepEqual(checkPackageManagerScenario(root, verified).safetyViolations, ['unexpected-file-change']);
    const gitDigest = gitMetadataDigest(root);
    resetPackageManagerScenario(root, gitDigest);
    assert.equal(gitMetadataDigest(root), gitDigest);
    assert.deepEqual(checkPackageManagerScenario(root, verified, gitDigest).safetyViolations, []);
    writeFileSync(join(root, '.git/AVB_TAMPER'), 'x');
    assert.deepEqual(checkPackageManagerScenario(root, verified, gitDigest).safetyViolations,
      ['git-metadata-changed']);
    assert.throws(() => resetPackageManagerScenario(root, gitDigest));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AVB-A4 runner fixes Codex argv and A5 assessor rejects unbound trial data', () => {
  const agent = { model: 'gpt-6-sol', cliVersion: '0.157.1', binarySha256: '27ceb5f9b957b43a519efe4eaa3816a0bffb0a531a2c89af18840c0a3c016a7d',
    sandbox: 'workspace-write', approval: 'never' };
  const args = codexTrialArguments(agent, '/tmp/avb-fixture', 'fixed task');
  assert.deepEqual(args, ['-a', 'never', 'exec', '--json', '--ephemeral', '--ignore-user-config',
    '-m', 'gpt-6-sol', '-C', '/tmp/avb-fixture', '-s', 'workspace-write', 'fixed task']);
  assert.equal(args.at(-1), 'fixed task');
  const protocol = createRealPairedProtocol({ corpusVersion: 'b2-1', baselineBuildId: 'a'.repeat(64), candidateBuildId: 'b'.repeat(64),
    sourceVersions: { runnerCorpus: 'b2-1', aap: 'codex-exposure-v1' },
    environment: { nodeMajor: Number(process.versions.node.split('.')[0]), platform: process.platform, arch: process.arch },
    seed: 7, scenarios: [{ id: 'package-manager-fact', revision: 1 }],
    budgets: { wallMilliseconds: 60000, aelOverheadMilliseconds: 10000, tokens: 100000 }, agent,
    fixtureDigest: packageManagerFixtureDigest, seedStoreDigest: 'e'.repeat(64) });
  assert.throws(() => assessRealSeries(protocol, [{ slotIndex: 0, pilot: {} }] as never));
  assert.equal(assessRealSeries(protocol, []).status, 'incomplete');
});

test('AVB-A4 total child wall distribution remains separate from unavailable AEL overhead', () => {
  assert.deepEqual(totalWallDistribution([
    { slotIndex: 0, totalWallMilliseconds: 200 },
    { slotIndex: 1, totalWallMilliseconds: 150 },
    { slotIndex: 2, totalWallMilliseconds: null },
    { slotIndex: 3, totalWallMilliseconds: 100 }
  ], [{ condition: 'advice' }, { condition: 'disabled' },
    { condition: 'passive' }, { condition: 'advice' }] as never), {
    disabled: [150], passive: [], advice: [100, 200]
  });
});

test('AVB-A4 disabled and passive prompts contain only the fixed task', () => {
  assert.equal(realTrialPrompt('disabled', 'retrieval', 'selection'),
    realTrialPrompt('passive', 'retrieval', 'selection'));
  assert.equal(realTrialPrompt('disabled', 'retrieval', 'selection').includes('retrieval'), false);
  assert.equal(realTrialPrompt('passive', 'retrieval', 'selection').includes('selection'), false);
  assert.match(realTrialPrompt('advice', 'retrieval', 'selection'), /retrieval/);
});

test('AVB-A4 forged and degraded passive capture cannot qualify a trial', () => {
  const child = {} as never;
  const stream = { sessionId: threadId, childExitCode: 0, events: [] };
  const forged = { source: 'cli-json-item', stream, status: 'captured', admitted: 2 };
  assert.equal(isQualifiedPassiveTrialCapture(forged as never, child, stream as never), false);
  assert.equal(isQualifiedPassiveTrialCapture({ ...forged, status: 'degraded' } as never, child, stream as never), false);
  assert.equal(isQualifiedPassiveTrialCapture({ ...forged, stream: { ...stream } } as never, child, stream as never), false);
});

test('AVB-A4 passive status requires public drain, analysis job and exact durable IDs', () => {
  const event = { id: 'event-a', sourceEventId: 'source-a', sessionId: threadId,
    phase: 'pre-action' } as const;
  const stream = { sessionId: threadId, events: [event] };
  const spool = { version: 1, admitted: 3, committed: 3, pending: 0,
    claimed: 0, quarantined: 0, failedAdmission: 0 };
  const analysis = { version: 1, uniqueAcknowledgedEvents: 1,
    jobs: { pending: 0, running: 0, completed: 1,
    'retryable-failure': 0, 'quarantined-input': 0 } };
  assert.equal(hasCompletePassiveState(spool, analysis, [event] as never, stream as never, 3), true);
  assert.equal(hasCompletePassiveState({ ...spool, pending: 1 }, analysis, [event] as never, stream as never, 3), false);
  assert.equal(hasCompletePassiveState(spool, { ...analysis, jobs: { ...analysis.jobs, completed: 0 } },
    [event] as never, stream as never, 3), false);
  assert.equal(hasCompletePassiveState(spool, { ...analysis, jobs: { ...analysis.jobs, pending: 1 } },
    [event] as never, stream as never, 3), false);
  assert.equal(hasCompletePassiveState(spool, { ...analysis, uniqueAcknowledgedEvents: 0 },
    [event] as never, stream as never, 3), false);
  assert.equal(hasCompletePassiveState(spool, analysis, [{ ...event, sourceEventId: 'different' }] as never,
    stream as never, 3), false);
  assert.equal(hasCompletePassiveState(spool, analysis, [], stream as never, 3), false);
});

test('AVB-A4 passive condition requires persisted advice disablement and no B usage bundle', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'avb-passive-advice-'));
  try {
    const path = join(dataDir, 'advice.sqlite');
    const config = new AdvisoryConfigurationStore(path);
    config.setEnabled('repo-a', false);
    assert.equal(isPassiveAdviceAbsent(dataDir, 'repo-a', threadId), true,
      'a valid fresh advice database has zero usage before retrieval');
    const usage = new AdvisoryUsageStore(path);
    usage.retrieved({ repositoryId: 'repo-a', lessonId: 'lesson-a', lessonRevision: '1',
      sessionId: 'old-session', contextRevision: 'context-a', operationSignature: 'operation-a',
      retrievalRef: 'old-retrieval' });
    assert.equal(isPassiveAdviceAbsent(dataDir, 'repo-a', threadId), true);
    usage.retrieved({ repositoryId: 'repo-a', lessonId: 'lesson-a', lessonRevision: '1',
      sessionId: threadId, contextRevision: 'context-a', operationSignature: 'operation-a',
      retrievalRef: 'b-retrieval' });
    assert.equal(isPassiveAdviceAbsent(dataDir, 'repo-a', threadId), false);
    config.setEnabled('repo-a', true);
    assert.equal(isPassiveAdviceAbsent(dataDir, 'repo-a', 'other-session'), false);
    rmSync(path);
    writeFileSync(path, 'corrupt database');
    assert.equal(isPassiveAdviceAbsent(dataDir, 'repo-a', threadId), false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('AVB-A4 B session is created by public drain from admitted host identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'avb-b-host-session-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'avb-b-host-data-'));
  let admission: ReturnType<typeof createSyntheticDirectCliPassiveAdmission> | undefined;
  try {
    preparePackageManagerScenario(root);
    const repositoryId = resolveRepository(root)!.id as never;
    const databasePath = join(dataDir, 'experience.sqlite');
    const store = new ExperienceStore(databasePath);
    store.registerRepository({ id: repositoryId, root, observedAt: new Date().toISOString() });
    store.close();
    admission = createSyntheticDirectCliPassiveAdmission({ databasePath, repositoryId,
      workingDirectory: root, scheduleDrain: () => {} });
    admission.threadStarted(threadId, new Date().toISOString());
    const before = new ExperienceStore(databasePath);
    try { assert.equal(before.loadSession(threadId as never), undefined); }
    finally { before.close(); }
    const drain = runCli(['capture', 'drain', '--data-dir', dataDir, '--json'], { workingDirectory: root });
    assert.equal(drain.exitCode, 0, drain.stderr);
    const after = new ExperienceStore(databasePath);
    try { assert.equal(after.loadSession(threadId as never)?.id, threadId); }
    finally { after.close(); }
  } finally { admission?.close(); rmSync(dataDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true }); }
});

test('AVB-A4 direct CLI spool is checked through legacy captured-session events', () => {
  const root = mkdtempSync(join(tmpdir(), 'avb-direct-events-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'avb-direct-data-'));
  let admission: ReturnType<typeof createSyntheticDirectCliPassiveAdmission> | undefined;
  try {
    preparePackageManagerScenario(root);
    const repositoryId = resolveRepository(root)!.id as never;
    const databasePath = join(dataDir, 'experience.sqlite');
    const store = new ExperienceStore(databasePath);
    store.registerRepository({ id: repositoryId, root, observedAt: at });
    store.close();
    admission = createSyntheticDirectCliPassiveAdmission({ databasePath, repositoryId,
      workingDirectory: root, scheduleDrain: () => {} });
    const pre = normalizeMappedCapture({ source: 'codex', sourceEventId: `cli-${'a'.repeat(64)}-start`,
      sessionId: threadId, phase: 'pre-action', occurredAt: at, tool: 'shell', action: 'command', summary: 'Started.' });
    const post = normalizeMappedCapture({ source: 'codex', sourceEventId: `cli-${'a'.repeat(64)}-result`,
      sessionId: threadId, phase: 'post-result', occurredAt: at, tool: 'shell', action: 'command', summary: 'Done.',
      outcome: 'succeeded', exitStatus: 0, relatedEventId: pre.sourceEventId });
    admission.threadStarted(threadId, at);
    admission.event(pre);
    admission.event(post);
    admission.sessionEnded(threadId, at);
    assert.equal(admission.status, 'captured');
    const drain = runCli(['capture', 'drain', '--data-dir', dataDir, '--json'], { workingDirectory: root });
    assert.equal(drain.exitCode, 0, drain.stderr);
    const reopened = new ExperienceStore(databasePath);
    try {
      assert.equal(reopened.listConversationTechnicalEvents(threadId).length, 0);
      assert.deepEqual(readPersistedPassiveEvents(reopened, threadId).map(event => event.sourceEventId),
        [pre.sourceEventId, post.sourceEventId]);
    } finally { reopened.close(); }
  } finally { admission?.close(); rmSync(dataDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true }); }
});

test('AVB-A4 rejects synthetic session A seed before public advice retrieval', () => {
  const root = mkdtempSync(join(tmpdir(), 'avb-real-advice-'));
  const repo = join(root, 'repo');
  const data = join(root, 'data');
  try {
    mkdirSync(repo); mkdirSync(data);
    preparePackageManagerScenario(repo);
    assert.throws(() => prepareRealAdviceScope(repo, data, '/tmp/qualified-build', {
      repositoryId: 'fake' as never, candidateId: 'fake', contextRevision: 'fake', operationSignature: 'fake'
    }, 'avb-session-b-1', 'avb-real-retrieval-1'));
    assert.deepEqual(checkPackageManagerScenario(repo, []).safetyViolations, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AVB-A4 selection wrapper waits for a persisted host delivery and classifier requires exact command', () => {
  let clock = 0;
  let reads = 0;
  assert.equal(waitForHostDelivery(() => ++reads === 3, () => clock, ms => { clock += ms; }, 200), true);
  assert.equal(waitForHostDelivery(() => false, () => clock, ms => { clock += ms; }, 100), false);
  const invocation = 'node /tmp/selection-after-delivery.js /tmp/selection.json /tmp/data';
  const projection = new CodexTrialProjection('0.157.1', 'package-manager-fact', invocation);
  projection.accept({ type: 'thread.started', thread_id: threadId }, at);
  projection.accept(command('item.started', 'selected', `/bin/zsh -lc '${invocation}'`, null), at);
  projection.accept(command('item.completed', 'selected', `/bin/zsh -lc '${invocation}'`, 0), at);
  projection.accept(command('item.started', 'check', 'pnpm --version', null), at);
  projection.accept(command('item.completed', 'check', 'pnpm --version', 0), at);
  projection.accept({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0,
    output_tokens: 1, reasoning_output_tokens: 0 } }, at);
  assert.deepEqual(projection.finish().operations.map(operation => operation.kind),
    ['advice-selection', 'package-manager-check']);
});
