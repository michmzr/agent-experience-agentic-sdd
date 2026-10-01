import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { classifyCrossSessionDiscovery, checkCrossSessionTask, crossSessionTask,
  crossSessionFixtureDigest, crossSessionFixtureDigestV2, prepareCrossSessionScenario,
  prepareCrossSessionScenarioV2, projectCrossSessionCommandCandidate,
  projectCrossSessionCommandCandidateV2,
  resetCrossSessionWorkspace, resetCrossSessionAfterSecond } from '../src/benchmark/cross-session-scenario.js';

const id = (letter: string) => `cli-${letter.repeat(64)}-start`;
const digest = (letter: string) => letter.repeat(64);
const check = (sessionId: string, letter: string) => ({ sessionId, operationId: id(letter),
  commandClass: 'package-manager-check' as const, outcome: 'succeeded' as const,
  sourceDigest: null, outputDigest: null });

test('AVB-A5 two independent B sessions preserve repository and source identity through reset', () => {
  const root = mkdtempSync(join(tmpdir(), 'avb-cross-session-'));
  try {
    const fixture = prepareCrossSessionScenario(root);
    assert.notEqual(crossSessionTask(1), crossSessionTask(2));
    assert.equal(crossSessionTask(1).includes('again'), false);
    assert.match(crossSessionTask(1), /--version.*separate shell command/);
    assert.equal(crossSessionTask(1).includes('after writing'), false);
    assert.equal(crossSessionTask(1).includes('pnpm'), false);
    writeFileSync(join(root, 'packages/app/answer-b1.txt'), 'pnpm\n');
    assert.equal(checkCrossSessionTask(root, fixture, 1).taskCorrect, false);
    assert.equal(checkCrossSessionTask(root, fixture, 1, check('session-b1', 'c')).taskCorrect, true);
    resetCrossSessionWorkspace(root, fixture, check('session-b1', 'c'));
    assert.equal(readFileSync(join(root, 'packages/app/package.json'), 'utf8'), fixture.manifestBytes);
    assert.equal(checkCrossSessionTask(root, fixture, 1).taskCorrect, false);
    writeFileSync(join(root, 'packages/app/answer-b2.txt'), 'pnpm\n');
    assert.equal(checkCrossSessionTask(root, fixture, 2, check('session-b2', 'd')).taskCorrect, true);
    resetCrossSessionAfterSecond(root, fixture, check('session-b2', 'd'));
    assert.equal(readFileSync(join(root, 'packages/app/package.json'), 'utf8'), fixture.manifestBytes);
    assert.equal(checkCrossSessionTask(root, fixture, 2).taskCorrect, false);
    assert.throws(() => prepareCrossSessionScenario(root), /empty/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AVB-A5 checker rejects wrong answer, source mutation, other files and Git mutation', () => {
  const root = mkdtempSync(join(tmpdir(), 'avb-cross-check-'));
  try {
    const fixture = prepareCrossSessionScenario(root);
    writeFileSync(join(root, 'packages/app/answer-b1.txt'), 'npm\n');
    assert.equal(checkCrossSessionTask(root, fixture, 1).taskCorrect, false);
    writeFileSync(join(root, 'packages/app/answer-b1.txt'), 'x'.repeat(5000));
    assert.equal(checkCrossSessionTask(root, fixture, 1, check('session-b1', 'c')).answerCorrect, false);
    writeFileSync(join(root, 'packages/app/answer-b1.txt'), 'pnpm\n');
    writeFileSync(join(root, 'packages/app/other.txt'), 'x');
    assert.deepEqual(checkCrossSessionTask(root, fixture, 1).safetyViolations, ['unexpected-file-change']);
    rmSync(join(root, 'packages/app/other.txt'));
    writeFileSync(join(root, 'packages/app/package.json'), '{"packageManager":"npm@1"}\n');
    assert.deepEqual(checkCrossSessionTask(root, fixture, 1).safetyViolations, ['fixture-modified']);
    assert.throws(() => resetCrossSessionWorkspace(root, fixture), /source|fixture/i);
    writeFileSync(join(root, 'packages/app/package.json'), fixture.manifestBytes);
    appendFileSync(join(root, '.git/config'), '\n[avb-test]\nchanged = true\n');
    assert.deepEqual(checkCrossSessionTask(root, fixture, 1).safetyViolations, ['git-metadata-changed']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AVB-A5 candidate classifier counts only second-session identical source discovery', () => {
  const first = { sessionId: 'session-b1', operationId: id('a'), commandClass: 'exact-manifest-read' as const,
    outcome: 'succeeded' as const, sourceDigest: digest('b'), outputDigest: digest('c') };
  const second = { ...first, sessionId: 'session-b2', operationId: id('d') };
  assert.deepEqual(classifyCrossSessionDiscovery([first], [second]), { candidateRedundantOperationIds: [id('d')] });
  assert.deepEqual(classifyCrossSessionDiscovery([first], [{ ...second, sourceDigest: digest('e') }]),
    { candidateRedundantOperationIds: [] });
  assert.deepEqual(classifyCrossSessionDiscovery([first], [{ ...second, commandClass: 'required-validation' }]),
    { candidateRedundantOperationIds: [] });
  assert.deepEqual(classifyCrossSessionDiscovery([first], [{ ...second, outputDigest: digest('f') }]),
    { candidateRedundantOperationIds: [] });
});

test('AVB-A5 exact source read projects only bounded digests and rejects validation-only reads', () => {
  const root = mkdtempSync(join(tmpdir(), 'avb-cross-fact-'));
  try {
    const fixture = prepareCrossSessionScenario(root);
    const raw = { root, fixture, sessionId: 'session-b1', operationId: id('a'),
      command: 'cat packages/app/package.json', outcome: 'succeeded' as const,
      aggregatedOutput: fixture.manifestBytes };
    const projected = projectCrossSessionCommandCandidate(raw);
    assert.equal(projected.commandClass, 'exact-manifest-read');
    assert.equal(projected.sourceDigest, fixture.sourceDigest);
    assert.equal(JSON.stringify(projected).includes('packageManager'), false);
    assert.equal(projectCrossSessionCommandCandidate({ ...raw, aggregatedOutput: 'x'.repeat(4097) }).commandClass, 'other');
    assert.equal(projectCrossSessionCommandCandidate({ ...raw, command: 'echo cat packages/app/package.json' }).commandClass, 'other');
    assert.equal(projectCrossSessionCommandCandidate({ ...raw, validationOnly: true }).commandClass, 'required-validation');
    assert.equal(projectCrossSessionCommandCandidate({ ...raw, command: 'pnpm --version', aggregatedOutput: '12.6.0\n' }).commandClass,
      'package-manager-check');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AVB-A5 classifier rejects forged stream-shaped data and ambiguous session identities', () => {
  const first = { sessionId: 'session-b1', operationId: id('a'), commandClass: 'exact-manifest-read' as const,
    outcome: 'succeeded' as const, sourceDigest: digest('b'), outputDigest: digest('c') };
  assert.throws(() => classifyCrossSessionDiscovery([first],
    [{ source: 'codex', sourceEventId: id('d'), phase: 'pre-action' }] as never), /fact/i);
  assert.throws(() => classifyCrossSessionDiscovery([first], [{ ...first, operationId: id('d') }]), /session/i);
  assert.throws(() => classifyCrossSessionDiscovery([first], [{ ...first, sessionId: 'session-b2',
    operationId: id('d'), rawCommand: 'cat packages/app/package.json' }] as never), /fact/i);
});

test('AVB-A5 revision 2 is a distinct frozen fixture with closed direct and host-wrapper commands', () => {
  const root = mkdtempSync(join(tmpdir(), 'avb-cross-v2-'));
  try {
    const fixture = prepareCrossSessionScenarioV2(root);
    assert.equal(fixture.revision, 2);
    assert.notEqual(crossSessionFixtureDigestV2, crossSessionFixtureDigest);
    const raw = { root, fixture, sessionId: 'session-b1', operationId: id('a'),
      command: 'cat packages/app/package.json', outcome: 'succeeded' as const,
      aggregatedOutput: fixture.manifestBytes };
    for (const command of [raw.command, "/bin/zsh -lc 'cat packages/app/package.json'"]) {
      assert.equal(projectCrossSessionCommandCandidateV2({ ...raw, command }).commandClass,
        'exact-manifest-read');
    }
    for (const command of ['pnpm --version', "/bin/zsh -lc 'pnpm --version'"]) {
      assert.equal(projectCrossSessionCommandCandidateV2({ ...raw, command,
        aggregatedOutput: '12.6.0\n' }).commandClass, 'package-manager-check');
    }
    assert.throws(() => projectCrossSessionCommandCandidate(raw), /revision/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AVB-A5 revision 2 rejects shell syntax, fake executables and same-output fabrications', () => {
  const root = mkdtempSync(join(tmpdir(), 'avb-cross-v2-negative-'));
  try {
    const fixture = prepareCrossSessionScenarioV2(root);
    const raw = { root, fixture, sessionId: 'session-b1', operationId: id('a'),
      command: 'cat packages/app/package.json', outcome: 'succeeded' as const,
      aggregatedOutput: fixture.manifestBytes };
    for (const command of [
      'cat packages/app/package.json # read',
      'printf \'%s\' \'{"packageManager":"pnpm@12.6.0"}\'',
      'cat packages/app/package.json | cat',
      'cat packages/app/package.json > /tmp/out',
      'cat packages/app/package.json extra',
      "cat 'packages/app/package.json'",
      'cat $(echo packages/app/package.json)',
      "/bin/zsh -lc 'cat packages/app/package.json; echo done'"
    ]) {
      assert.equal(projectCrossSessionCommandCandidateV2({ ...raw, command }).commandClass,
        'other', command);
    }
    for (const command of ['./pnpm --version', '/tmp/pnpm --version', 'command pnpm --version',
      'pnpm --version # check', 'pnpm --version; echo done']) {
      assert.equal(projectCrossSessionCommandCandidateV2({ ...raw, command,
        aggregatedOutput: '12.6.0\n' }).commandClass, 'other', command);
    }
    assert.equal(projectCrossSessionCommandCandidateV2({ ...raw, command: 'pnpm --version',
      aggregatedOutput: '12.6.0' }).commandClass, 'other');
    assert.equal(projectCrossSessionCommandCandidateV2({ ...raw,
      aggregatedOutput: `${fixture.manifestBytes}extra` }).commandClass, 'other');
    assert.equal(projectCrossSessionCommandCandidateV2({ ...raw, outcome: 'failed' }).commandClass, 'other');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
