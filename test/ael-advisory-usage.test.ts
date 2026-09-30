import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
