import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { NORMAL_PROFILE } from '../src/config/runtime-profile.js';
import type { DecisionOutcome, RuntimeInput, RuntimeRule } from '../src/runtime/contracts.js';
import { createRuntimeGate } from '../src/runtime/gate.js';
import { createRuleIndex } from '../src/runtime/rule-index.js';
import { compileRuntimeSnapshot } from '../src/runtime/snapshot.js';

const now = '2026-08-25T10:00:00.000Z';

interface BenchmarkCase {
  readonly id: string;
  readonly input: RuntimeInput;
  readonly rules: readonly RuntimeRule[];
  readonly expectedOutcome: DecisionOutcome;
  readonly relevantKnowledgeIds: readonly string[];
}

test('records deterministic milestone two fixture metrics without release thresholds', (context) => {
  const invalid = loadFixture('repeated-invalid-command.json');
  const stale = loadFixture('stale-verified-rule.json');
  const degraded = loadFixture('degraded-runtime.json');
  const cases: readonly BenchmarkCase[] = [
    { id: 'repeated-invalid-command', input: invalid.input, rules: [invalid.rule], expectedOutcome: 'BLOCK', relevantKnowledgeIds: [invalid.rule.reference.knowledgeId] },
    { id: 'stale-rule-after-dispute', input: stale.input, rules: [{ ...stale.rule, state: 'disputed', effect: 'context' }], expectedOutcome: 'ALLOW', relevantKnowledgeIds: [stale.rule.reference.knowledgeId] },
    { id: 'ordinary-degraded-context', input: degraded.input, rules: [{ ...degraded.rule, state: 'disputed', effect: 'context' }], expectedOutcome: 'ALLOW', relevantKnowledgeIds: [degraded.rule.reference.knowledgeId] },
    {
      id: 'reusable-workflow',
      input: { repositoryId: 'repo-acceptance', operationClass: 'normal', signature: { kind: 'intent', verb: 'prepare', target: 'release', tool: 'pnpm' } },
      rules: [{
        id: 'workflow-context', state: 'verified', authoritative: true, effect: 'context',
        signature: { kind: 'intent', verb: 'prepare', target: 'release', tool: 'pnpm' },
        applicability: { scope: 'repository', repositoryId: 'repo-acceptance' },
        reference: { knowledgeId: 'workflow-knowledge', evidenceIds: ['workflow-evidence'] }
      }],
      expectedOutcome: 'ALLOW', relevantKnowledgeIds: ['workflow-knowledge']
    }
  ];

  let retrieved = 0;
  let relevant = 0;
  let falseWarnings = 0;
  let falseHardBlocks = 0;
  const gates = cases.map((item) => {
    const snapshot = compileRuntimeSnapshot({
      repositoryId: item.input.repositoryId ?? 'global', generatedAt: now,
      repositoryRules: item.rules.filter(({ applicability, authoritative, state, effect }) => applicability.scope === 'repository' && authoritative && state !== 'disputed' && effect === 'conflict'),
      globalRules: item.rules.filter(({ applicability, authoritative, state, effect }) => applicability.scope === 'global' && authoritative && state !== 'disputed' && effect === 'conflict'),
      contextRules: item.rules.filter(({ authoritative, state, effect }) => !authoritative || state === 'disputed' || effect === 'context')
    });
    return createRuntimeGate({
      index: createRuleIndex(snapshot), profile: NORMAL_PROFILE,
      status: { health: 'healthy', profileId: 'normal', hardBlocking: true, retrievalMode: 'deterministic', fallbackSource: 'memory', circuitState: 'closed' }
    });
  });

  for (const [index, item] of cases.entries()) {
    const decision = gates[index]!.evaluate(item.input);
    const returned = new Set(decision.references.map(({ knowledgeId }) => knowledgeId));
    relevant += item.relevantKnowledgeIds.length;
    retrieved += item.relevantKnowledgeIds.filter((id) => returned.has(id)).length;
    if (decision.outcome === 'WARN' && item.expectedOutcome !== 'WARN') falseWarnings += 1;
    if (decision.outcome === 'BLOCK' && item.expectedOutcome !== 'BLOCK') falseHardBlocks += 1;
    assert.equal(decision.outcome, item.expectedOutcome, item.id);
  }

  const iterations = 20_000;
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) gates[index % gates.length]!.evaluate(cases[index % cases.length]!.input);
  const elapsedMs = performance.now() - started;
  const metrics = {
    fixtureCount: cases.length,
    retrievalRecall: retrieved / relevant,
    falseWarnings,
    falseHardBlocks,
    decisionCount: iterations,
    synchronousGateLatencyMs: elapsedMs,
    meanSynchronousGateLatencyMicroseconds: elapsedMs * 1_000 / iterations,
    releaseThresholdsEstablished: false
  };
  assert.equal(metrics.retrievalRecall, 1);
  assert.equal(metrics.falseWarnings, 0);
  assert.equal(metrics.falseHardBlocks, 0);
  assert.equal(Number.isFinite(metrics.synchronousGateLatencyMs), true);
  assert.equal(metrics.synchronousGateLatencyMs >= 0, true);
  assert.equal(metrics.releaseThresholdsEstablished, false);
  context.diagnostic(JSON.stringify(metrics));
});

function loadFixture(name: string): { readonly input: RuntimeInput; readonly rule: RuntimeRule } {
  return JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/runtime', name), 'utf8')) as { input: RuntimeInput; rule: RuntimeRule };
}
