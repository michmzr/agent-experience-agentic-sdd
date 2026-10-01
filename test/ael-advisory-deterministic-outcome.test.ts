import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AdvisoryUsageStore } from '../src/advice/usage.js';
import { qualifiesRealOutcome, observeRealOutcome } from '../src/benchmark/real-outcome.js';
import { gitMetadataDigest, preparePackageManagerScenario } from '../src/benchmark/real-scenario.js';

test('public and forged deterministic checker outcomes cannot create usage facts', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-outcome-'));
  try {
    const usage = new AdvisoryUsageStore(join(root, 'advice.sqlite'));
    const scope = { repositoryId: 'repo-a', lessonId: 'lesson-a', lessonRevision: '1',
      sessionId: 'session-b', contextRevision: 'package-json:v1:context' };
    const bundle = usage.retrieved({ ...scope, operationSignature: 'operation:v1:signature', retrievalRef: 'retrieve-b' });
    usage.record({ ...scope, bundleId: bundle.id, kind: 'delivered', origin: 'agent-claim', witnessRef: 'claim-b' });
    usage.record({ ...scope, bundleId: bundle.id, kind: 'selected', origin: 'agent-selection', witnessRef: 'select-b' });
    usage.record({ ...scope, bundleId: bundle.id, kind: 'applied', origin: 'operation-evidence', witnessRef: 'check-b' });
    assert.throws(() => usage.record({ ...scope, bundleId: bundle.id, kind: 'outcome-observed',
      origin: 'deterministic-check', witnessRef: `avb-check:v1:${'a'.repeat(64)}` }), /trusted checker/i);
    assert.throws(() => usage.recordObservedDeterministicOutcome({ ...scope, bundleId: bundle.id,
      appliedEventId: 'check-b', witnessRef: `avb-check:v1:${'a'.repeat(64)}` } as never,
      { sessionId: 'session-b', events: [], childExitCode: 0 } as never), /trusted checker/i);
    assert.equal(usage.facts(bundle.id).some(fact => fact.kind === 'outcome-observed'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fixed checker requires the same session, exact applied check and correct safe result', () => {
  const root = mkdtempSync(join(tmpdir(), 'avb-outcome-fixture-'));
  try {
    preparePackageManagerScenario(root);
    const gitDigest = gitMetadataDigest(root);
    writeFileSync(join(root, 'packages/app/answer.txt'), 'pnpm\n');
    const bundle = { id: 'bundle-b', repositoryId: 'repo-a', lessonId: 'lesson-a', lessonRevision: '1',
      sessionId: 'session-b', contextRevision: 'context-b', operationSignature: 'signature-b',
      retrievedAt: '2026-10-01T10:00:00.000Z' };
    const operations = [{ id: 'check-a', kind: 'package-manager-check', outcome: 'succeeded' },
      { id: 'check-b', kind: 'package-manager-check', outcome: 'succeeded' }] as const;
    const stream = { sessionId: 'session-b', childExitCode: 0 as const,
      events: [{ phase: 'pre-action', sourceEventId: 'check-a', sessionId: 'session-b' },
        { phase: 'post-result', sourceEventId: 'result-a', relatedEventId: 'check-a', sessionId: 'session-b',
          outcome: 'succeeded', exitStatus: 0 }] };
    const input = { root, expectedGitDigest: gitDigest, bundle, appliedEventId: 'check-a',
      operations, stream: stream as never };
    assert.equal(qualifiesRealOutcome(input), true);
    assert.equal(observeRealOutcome({ ...input, protocolDigest: 'a'.repeat(64) }), null,
      'pure fixture cannot mint a trusted witness');
    assert.equal(qualifiesRealOutcome({ ...input, bundle: { ...bundle, sessionId: 'session-c' } }), false);
    assert.equal(qualifiesRealOutcome({ ...input, appliedEventId: 'check-b' }), false);
    writeFileSync(join(root, 'packages/app/answer.txt'), 'npm\n');
    assert.equal(qualifiesRealOutcome(input), false);
    writeFileSync(join(root, 'packages/app/answer.txt'), 'pnpm\n');
    writeFileSync(join(root, 'unexpected.txt'), 'unsafe\n');
    assert.equal(qualifiesRealOutcome(input), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
