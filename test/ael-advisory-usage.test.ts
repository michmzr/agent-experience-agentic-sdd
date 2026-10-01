import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { AdvisoryUsageStore } from '../src/advice/usage.js';

test('AAP-A3 retrieval, delivery, selection, application and outcome require distinct witnesses', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-advice-usage-'));
  try {
    const path = join(root, 'usage.sqlite');
    const usage = new AdvisoryUsageStore(path);
    const scope = { repositoryId: 'repo-a', lessonId: 'lesson-1', lessonRevision: 'rev-1', sessionId: 'session-b', contextRevision: 'context-1' };
    const bundle = usage.retrieved({ ...scope, operationSignature: 'tool:search', retrievalRef: 'cli-call-1' });
    assert.deepEqual(usage.facts(bundle.id).map(fact => fact.kind), ['retrieved']);
    assert.equal(usage.retrieved({ ...scope, operationSignature: 'tool:search', retrievalRef: 'cli-call-1' }).id, bundle.id);
    assert.equal(usage.retrieved({ ...scope, operationSignature: 'tool:search', retrievalRef: 'cli-call-2' }).id, bundle.id);
    assert.deepEqual(usage.facts(bundle.id).map(fact => fact.kind), ['retrieved']);
    assert.throws(() => usage.record({ ...scope, bundleId: bundle.id, kind: 'delivered',
      origin: 'cli-output', witnessRef: 'cli-call-1' }), /Unsupported usage fact or origin/);
    assert.deepEqual(usage.facts(bundle.id).map(fact => fact.kind), ['retrieved']);
    assert.throws(() => usage.record({ ...scope, repositoryId: 'repo-b', bundleId: bundle.id, kind: 'delivered', origin: 'cli-output', witnessRef: 'cli-call-1' }));
    assert.throws(() => usage.record({ ...scope, bundleId: bundle.id, kind: 'applied', origin: 'operation-evidence', witnessRef: 'op-1' }));
    usage.record({ ...scope, bundleId: bundle.id, kind: 'delivered', origin: 'agent-claim', witnessRef: 'claim-1' });
    assert.equal(usage.facts(bundle.id).find(fact => fact.kind === 'delivered')?.origin, 'agent-claim');
    usage.record({ ...scope, bundleId: bundle.id, kind: 'selected', origin: 'agent-selection', witnessRef: 'selection-1' });
    usage.record({ ...scope, bundleId: bundle.id, kind: 'applied', origin: 'operation-evidence', witnessRef: 'op-1' });
    usage.record({ ...scope, bundleId: bundle.id, kind: 'outcome-observed', origin: 'verification-evidence', witnessRef: 'verify-1' });
    assert.deepEqual(new AdvisoryUsageStore(path).facts(bundle.id).map(fact => fact.kind),
      ['retrieved', 'delivered', 'selected', 'applied', 'outcome-observed']);
    assert.throws(() => usage.record({ ...scope, lessonRevision: 'rev-2', bundleId: bundle.id, kind: 'rejected', origin: 'agent-selection', witnessRef: 'reject-1' }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AAP-A3 legacy CLI output cannot authorize later usage facts', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-advice-legacy-'));
  try {
    const path = join(root, 'usage.sqlite');
    const usage = new AdvisoryUsageStore(path);
    const scope = { repositoryId: 'repo-a', lessonId: 'lesson-1', lessonRevision: 'rev-1',
      sessionId: 'session-b', contextRevision: 'context-1' };
    const bundle = usage.retrieved({ ...scope, operationSignature: 'tool:search', retrievalRef: 'cli-call-1' });
    const database = new DatabaseSync(path);
    try {
      const insert = database.prepare(`INSERT INTO advice_usage_facts (bundle_id, kind, origin, witness_ref)
        VALUES (?, ?, ?, ?)`);
      insert.run(bundle.id, 'delivered', 'cli-output', 'legacy-output');
      assert.throws(() => usage.record({ ...scope, bundleId: bundle.id, kind: 'selected',
        origin: 'agent-selection', witnessRef: 'selection-1' }), /requires delivered witness/);
      insert.run(bundle.id, 'selected', 'agent-selection', 'legacy-selection');
      assert.throws(() => usage.record({ ...scope, bundleId: bundle.id, kind: 'applied',
        origin: 'operation-evidence', witnessRef: 'operation-1' }), /requires selected witness/);
      insert.run(bundle.id, 'applied', 'operation-evidence', 'legacy-operation');
      assert.throws(() => usage.record({ ...scope, bundleId: bundle.id, kind: 'outcome-observed',
        origin: 'verification-evidence', witnessRef: 'verification-1' }), /requires applied witness/);
      usage.record({ ...scope, bundleId: bundle.id, kind: 'delivered',
        origin: 'agent-claim', witnessRef: 'claim-1' });
      assert.throws(() => usage.record({ ...scope, bundleId: bundle.id, kind: 'applied',
        origin: 'operation-evidence', witnessRef: 'operation-2' }), /requires selected witness/);
      usage.record({ ...scope, bundleId: bundle.id, kind: 'selected',
        origin: 'agent-selection', witnessRef: 'selection-2' });
      usage.record({ ...scope, bundleId: bundle.id, kind: 'applied',
        origin: 'operation-evidence', witnessRef: 'operation-2' });
      usage.record({ ...scope, bundleId: bundle.id, kind: 'outcome-observed',
        origin: 'verification-evidence', witnessRef: 'verification-2' });
      assert.deepEqual(usage.qualifiedProgress(bundle.id).appliedRefs, ['operation-2']);
      assert.equal(usage.facts(bundle.id).find(fact => fact.witnessRef === 'legacy-output')?.origin, 'cli-output');
    } finally { database.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AAP-A4 direct usage record cannot forge observed host delivery', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-advice-host-origin-'));
  try {
    const usage = new AdvisoryUsageStore(join(root, 'usage.sqlite'));
    const scope = { repositoryId: 'repo-a', lessonId: 'lesson-1', lessonRevision: '1',
      sessionId: 'session-b', contextRevision: 'context-1' };
    const bundle = usage.retrieved({ ...scope, operationSignature: 'tool:search', retrievalRef: 'retrieval-b' });
    assert.throws(() => usage.record({ ...scope, bundleId: bundle.id, kind: 'delivered', origin: 'host-challenge',
      witnessRef: `codex-exposure:v1:${'a'.repeat(64)}` }), /host challenge.*trusted child/i);
    assert.deepEqual(usage.facts(bundle.id).map(fact => [fact.kind, fact.origin]), [['retrieved', 'cli-retrieval']]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
