import assert from 'node:assert/strict';
import test from 'node:test';

import { createCrossSessionRealProtocol } from '../src/benchmark/paired.js';
import { crossSessionFixtureDigest, crossSessionFixtureDigestV2 } from '../src/benchmark/cross-session-scenario.js';
import { assessCrossSessionRealSeries, crossSessionTrialPrompt, prepareCrossSessionRealSeries,
  runCrossSessionRealTrial,
  summarizeSession, qualifiesAdviceOperationOrder, remainingCrossSessionWallBudget,
  withinCrossSessionBudget } from '../src/benchmark/cross-session-runner.js';

const protocol = createCrossSessionRealProtocol({ corpusVersion: 'b2-2',
  baselineBuildId: 'a'.repeat(64), candidateBuildId: 'b'.repeat(64),
  sourceVersions: { runnerCorpus: 'b2-2', aap: 'codex-exposure-v1' },
  environment: { nodeMajor: Number(process.versions.node.split('.')[0]),
    platform: process.platform, arch: process.arch }, seed: 7,
  scenarios: [{ id: 'cross-session-package-manager', revision: 1 }],
  budgets: { wallMilliseconds: 240000, aelOverheadMilliseconds: 10000, tokens: null },
  agent: { model: 'gpt-6-sol', cliVersion: '0.157.1',
    binarySha256: '27ceb5f9b957b43a519efe4eaa3816a0bffb0a531a2c89af18840c0a3c016a7d',
    sandbox: 'workspace-write', approval: 'never' }, fixtureDigest: crossSessionFixtureDigest,
  seedStoreDigest: 'c'.repeat(64) });

const { schemaVersion: _schemaVersion, pairs: _pairs, order: _order,
  protocolDigest: _protocolDigest, ...protocolInput } = protocol;
const protocolV2 = createCrossSessionRealProtocol({
  ...protocolInput, corpusVersion: 'b2-3', sourceVersions: { ...protocol.sourceVersions,
    runnerCorpus: 'b2-3' }, scenarios: [{ id: 'cross-session-package-manager', revision: 2 }],
  fixtureDigest: crossSessionFixtureDigestV2
});

test('AVB-A4 cross-session B1 has no advice and B2 advice is separately scoped', () => {
  const retrieval = 'node /tmp/retrieve';
  const selection = 'node /tmp/select';
  const first = crossSessionTrialPrompt(1, 'advice', retrieval, selection);
  const second = crossSessionTrialPrompt(2, 'advice', retrieval, selection);
  assert.equal(first.includes(retrieval), false);
  assert.equal(first.includes('answer-b1.txt'), true);
  assert.equal(second.includes(retrieval), true);
  assert.equal(second.includes(selection), true);
  assert.equal(second.includes('answer-b2.txt'), true);
  assert.equal(crossSessionTrialPrompt(2, 'disabled', retrieval, selection).includes(retrieval), false);
  assert.equal(crossSessionTrialPrompt(2, 'passive', retrieval, selection).includes(selection), false);
});

test('AVB-A4 cross-session summaries expose separate check and safe exact-read count', () => {
  const summary = summarizeSession({ sessionId: 'host-b1', facts: [
    { sessionId: 'host-b1', operationId: `cli-${'a'.repeat(64)}-start`, commandClass: 'exact-manifest-read',
      outcome: 'succeeded', sourceDigest: 'a'.repeat(64), outputDigest: 'b'.repeat(64) },
    { sessionId: 'host-b1', operationId: `cli-${'b'.repeat(64)}-start`, commandClass: 'package-manager-check',
      outcome: 'succeeded', sourceDigest: null, outputDigest: null }
  ] }, { taskCorrect: true, answerCorrect: true, checkObserved: true, safetyViolations: [] });
  assert.deepEqual(summary, { sessionId: 'host-b1', taskCorrect: true, separateCheck: true,
    exactReadCount: 1, safetyViolations: [] });
  assert.equal(JSON.stringify(summary).includes('pnpm'), false);
});

test('AVB-A4 B2 advice order rejects a read before selection and a check before delivery', () => {
  const base = { sessionId: 'host-b2', outcome: 'succeeded' as const,
    sourceDigest: null, outputDigest: null };
  const retrieval = { ...base, operationId: `cli-${'e'.repeat(64)}-start`, commandClass: 'other' as const };
  const echo = { ...base, operationId: `cli-${'a'.repeat(64)}-start`, commandClass: 'other' as const };
  const selected = { ...base, operationId: `cli-${'b'.repeat(64)}-start`, commandClass: 'advice-selection' as const };
  const check = { ...base, operationId: `cli-${'c'.repeat(64)}-start`, commandClass: 'package-manager-check' as const };
  const read = { ...base, operationId: `cli-${'d'.repeat(64)}-start`, commandClass: 'exact-manifest-read' as const };
  const other = { ...base, operationId: `cli-${'f'.repeat(64)}-start`, commandClass: 'other' as const };
  assert.equal(qualifiesAdviceOperationOrder([retrieval, echo, selected, read, check],
    retrieval.operationId, echo.operationId), true);
  assert.equal(qualifiesAdviceOperationOrder([other, retrieval, echo, selected, check],
    retrieval.operationId, echo.operationId), false, 'pre-retrieval source acquisition');
  assert.equal(qualifiesAdviceOperationOrder([retrieval, other, echo, selected, check],
    retrieval.operationId, echo.operationId), false, 'extra command before echo');
  assert.equal(qualifiesAdviceOperationOrder([retrieval, echo, other, selected, check],
    retrieval.operationId, echo.operationId), false, 'extra command before selection');
  assert.equal(qualifiesAdviceOperationOrder([retrieval, echo, read, selected, check],
    retrieval.operationId, echo.operationId), false);
  assert.equal(qualifiesAdviceOperationOrder([check, retrieval, echo, selected],
    retrieval.operationId, echo.operationId), false);
  assert.equal(qualifiesAdviceOperationOrder([retrieval, echo, selected, selected, check],
    retrieval.operationId, echo.operationId), false);
});

test('AVB-A4 cross-session assessor and runner reject imported trial/context objects before host launch', async () => {
  assert.equal(assessCrossSessionRealSeries(protocol, []).status, 'incomplete');
  assert.equal(assessCrossSessionRealSeries(protocolV2, []).status, 'incomplete');
  assert.throws(() => assessCrossSessionRealSeries(protocol, [{ slotIndex: 0, pilot: {} }] as never), /direct runner/i);
  await assert.rejects(runCrossSessionRealTrial(protocol, 0, '/tmp/fake', '/tmp/fake', {} as never),
    /seed is unavailable/i);
  await assert.rejects(prepareCrossSessionRealSeries('/tmp/fake', 3 as never), /revision/i);
});

test('AVB-A4 B1 failure still obeys the frozen token and wall budgets', () => {
  assert.equal(withinCrossSessionBudget(protocol.budgets, 1000, 100), true);
  assert.equal(withinCrossSessionBudget({ ...protocol.budgets, tokens: 10 }, 1000, 11), false);
  assert.equal(withinCrossSessionBudget({ ...protocol.budgets, tokens: 10 }, 1000, null), false);
  assert.equal(withinCrossSessionBudget(protocol.budgets, protocol.budgets.wallMilliseconds + 1, 1), false);
});

test('AVB-A4 B2 receives only the wall budget remaining after B1 and processing', () => {
  assert.equal(remainingCrossSessionWallBudget(120000, 0), 120000);
  assert.equal(remainingCrossSessionWallBudget(120000, 70000), 50000);
  assert.equal(remainingCrossSessionWallBudget(120000, 120000), 0);
  assert.equal(remainingCrossSessionWallBudget(120000, 120001), 0);
});
