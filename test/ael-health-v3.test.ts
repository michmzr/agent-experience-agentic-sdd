import assert from 'node:assert/strict';
import test from 'node:test';

import { scopedReceiptHealth } from '../src/application/health-v3.js';

test('ARC-A4 scoped receipt accounting separates deliveries from unique operations', () => {
  const reports = [
    { repositoryId: 'repo-a', source: 'codex', eventClass: 'technical', operationKey: 'operation-a', disposition: 'accepted' },
    { repositoryId: 'repo-a', source: 'codex', eventClass: 'technical', operationKey: 'operation-a', disposition: 'duplicate' },
    { repositoryId: 'repo-b', source: 'cursor', eventClass: 'technical', operationKey: 'operation-b', disposition: 'accepted' },
    { source: 'codex', disposition: 'malformed-envelope' }
  ] as const;
  const a = scopedReceiptHealth(reports, 'repo-a', 'available');
  assert.equal(a.accounting, 'available');
  assert.equal(a.deliveries, 2);
  assert.equal(a.uniqueOperations, 1);
  assert.deepEqual(a.sourceDenominator, { state: 'unavailable' });
  const b = scopedReceiptHealth(reports, 'repo-b', 'available');
  assert.equal(b.deliveries, 1);
  assert.equal(b.uniqueOperations, 1);
});
