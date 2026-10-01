import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { codexCliJsonSourceEventId } from '../src/capture/adapters/codex-cli-json.js';
import { CrossSessionCommandObserver, matchCrossSessionCommandFacts } from '../src/benchmark/cross-session-observer.js';
import { prepareCrossSessionScenario, prepareCrossSessionScenarioV2 } from '../src/benchmark/cross-session-scenario.js';
import { createCrossSessionRealProtocol, createRealPairedProtocol } from '../src/benchmark/paired.js';
import { crossSessionFixtureDigest } from '../src/benchmark/cross-session-scenario.js';

const thread = '0199a400-0000-7000-8000-000000000001';
const at = '2026-10-01T10:00:00.000Z';
const start = (id: string, command: string) => ({ type: 'item.started', item: {
  type: 'command_execution', id, command, status: 'in_progress' } });
const end = (id: string, command: string, output: string, exitCode = 0) => ({ type: 'item.completed', item: {
  type: 'command_execution', id, command, status: exitCode === 0 ? 'completed' : 'failed',
  exit_code: exitCode, aggregated_output: output } });
const result = (id: string, outcome: 'succeeded' | 'failed' = 'succeeded') => ({
  sourceEventId: codexCliJsonSourceEventId(thread, id, 'result'),
  relatedEventId: codexCliJsonSourceEventId(thread, id, 'start'),
  phase: 'post-result', outcome, sessionId: thread
});
const request = (id: string) => ({ sourceEventId: codexCliJsonSourceEventId(thread, id, 'start'),
  phase: 'pre-action', sessionId: thread });

test('AVB-A5 cross-session observer matches only exact one-to-one command candidates', () => {
  const root = mkdtempSync(join(tmpdir(), 'avb-cross-observer-'));
  try {
    const fixture = prepareCrossSessionScenario(root);
    const observer = new CrossSessionCommandObserver(root, fixture);
    observer.accept({ type: 'thread.started', thread_id: thread }, at);
    observer.accept(start('read', 'cat packages/app/package.json'), at);
    observer.accept(end('read', 'cat packages/app/package.json', fixture.manifestBytes), at);
    observer.accept(start('check', 'pnpm --version'), at);
    observer.accept(end('check', 'pnpm --version', '12.6.0\n'), at);
    observer.accept({ type: 'turn.completed', usage: { input_tokens: 2, cached_input_tokens: 0,
      output_tokens: 1, reasoning_output_tokens: 0 } }, at);
    const candidate = observer.finish();
    assert.equal(candidate.status, 'observed');
    const events = [request('read'), result('read'), request('check'), result('check')];
    assert.equal(matchCrossSessionCommandFacts(candidate, { sessionId: thread, events } as never).length, 2);
    assert.equal(matchCrossSessionCommandFacts(candidate, { sessionId: thread, events: [...events, request('extra')] } as never).length, 0);
    assert.equal(matchCrossSessionCommandFacts(candidate, { sessionId: thread, events: [request('read'),
      result('read'), request('check'), { ...result('check'), outcome: 'failed' }] } as never).length, 0);
    assert.equal(matchCrossSessionCommandFacts(candidate, { sessionId: 'other', events } as never).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AVB-A5 revision 2 observer projects an exact wrapper only for its own fixture', () => {
  const root = mkdtempSync(join(tmpdir(), 'avb-cross-observer-v2-'));
  try {
    const fixture = prepareCrossSessionScenarioV2(root);
    const observer = new CrossSessionCommandObserver(root, fixture);
    observer.accept({ type: 'thread.started', thread_id: thread }, at);
    const read = "/bin/zsh -lc 'cat packages/app/package.json'";
    observer.accept(start('read', read), at);
    observer.accept(end('read', read, fixture.manifestBytes), at);
    const check = "/bin/zsh -lc 'pnpm --version'";
    observer.accept(start('check', check), at);
    observer.accept(end('check', check, '12.6.0\n'), at);
    observer.accept({ type: 'turn.completed' }, at);
    const candidate = observer.finish();
    assert.deepEqual(candidate.facts.map(fact => fact.commandClass),
      ['exact-manifest-read', 'package-manager-check']);
    assert.equal(matchCrossSessionCommandFacts(candidate, { sessionId: thread,
      events: [request('read'), result('read'), request('check'), result('check')] } as never).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AVB-A4 completed command turn may have unavailable token telemetry', () => {
  const root = mkdtempSync(join(tmpdir(), 'avb-cross-observer-'));
  try {
    const fixture = prepareCrossSessionScenario(root);
    const absent = new CrossSessionCommandObserver(root, fixture);
    absent.accept({ type: 'thread.started', thread_id: thread }, at);
    absent.accept(start('check', 'pnpm --version'), at);
    absent.accept(end('check', 'pnpm --version', '12.6.0\n'), at);
    absent.accept({ type: 'turn.completed' }, at);
    const candidate = absent.finish();
    assert.equal(candidate.status, 'observed');
    assert.equal(candidate.tokens, null);
    const malformed = new CrossSessionCommandObserver(root, fixture);
    malformed.accept({ type: 'thread.started', thread_id: thread }, at);
    assert.throws(() => malformed.accept({ type: 'turn.completed', usage: {} }, at), /token count/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AVB-A5 cross-session observer rejects incomplete or altered item result', () => {
  const root = mkdtempSync(join(tmpdir(), 'avb-cross-observer-'));
  try {
    const fixture = prepareCrossSessionScenario(root);
    const incomplete = new CrossSessionCommandObserver(root, fixture);
    incomplete.accept({ type: 'thread.started', thread_id: thread }, at);
    incomplete.accept(start('read', 'cat packages/app/package.json'), at);
    assert.equal(incomplete.finish().status, 'unsupported');
    const altered = new CrossSessionCommandObserver(root, fixture);
    altered.accept({ type: 'thread.started', thread_id: thread }, at);
    altered.accept(start('read', 'cat packages/app/package.json'), at);
    assert.throws(() => altered.accept(end('read', 'echo changed', fixture.manifestBytes), at));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AVB-A4/A5 cross-session protocol revision cannot be substituted for legacy slots', () => {
  const common = { baselineBuildId: 'a'.repeat(64), candidateBuildId: 'b'.repeat(64),
    environment: { nodeMajor: Number(process.versions.node.split('.')[0]), platform: process.platform,
      arch: process.arch }, seed: 17,
    budgets: { wallMilliseconds: 120000, aelOverheadMilliseconds: 10000, tokens: null },
    agent: { model: 'gpt-6-sol', cliVersion: '0.157.1',
      binarySha256: '27ceb5f9b957b43a519efe4eaa3816a0bffb0a531a2c89af18840c0a3c016a7d',
      sandbox: 'workspace-write', approval: 'never' }, seedStoreDigest: 'c'.repeat(64) };
  const protocol = createCrossSessionRealProtocol({ ...common, corpusVersion: 'b2-2',
    sourceVersions: { runnerCorpus: 'b2-2', aap: 'codex-exposure-v1' },
    scenarios: [{ id: 'cross-session-package-manager', revision: 1 }],
    fixtureDigest: crossSessionFixtureDigest });
  assert.equal(protocol.schemaVersion, 3);
  assert.equal(protocol.order.length, 15);
  assert.throws(() => createCrossSessionRealProtocol({ ...common, corpusVersion: 'b2-1',
    sourceVersions: { runnerCorpus: 'b2-1', aap: 'codex-exposure-v1' },
    scenarios: [{ id: 'package-manager-fact', revision: 1 }],
    fixtureDigest: crossSessionFixtureDigest }), /protocol/i);
  assert.throws(() => createRealPairedProtocol({ ...common, corpusVersion: 'b2-2',
    sourceVersions: { runnerCorpus: 'b2-2', aap: 'codex-exposure-v1' },
    scenarios: [{ id: 'cross-session-package-manager', revision: 1 }],
    fixtureDigest: crossSessionFixtureDigest }), /protocol/i);
});
