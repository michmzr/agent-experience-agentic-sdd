import assert from 'node:assert/strict';
import test from 'node:test';

import { groupReviewFindings, type ReviewFinding } from '../src/review/orchestrator.js';

const findings: readonly ReviewFinding[] = [
  { reviewerId: 'security', findingId: 'security-1', rootCauseId: 'missing-validation', recommendation: 'validate inputs' },
  { reviewerId: 'maintainability', findingId: 'maint-1', rootCauseId: 'naming', recommendation: 'rename field' },
  { reviewerId: 'correctness', findingId: 'correct-1', rootCauseId: 'missing-validation', recommendation: 'validate inputs' }
];

test('groups findings by their explicit root cause in deterministic key order', () => {
  const result = groupReviewFindings([...findings].reverse());

  assert.deepEqual(result.map((group) => group.rootCauseId), ['missing-validation', 'naming']);
  assert.deepEqual(result[0]?.findings.map((finding) => finding.findingId), ['correct-1', 'security-1']);
  assert.deepEqual(result[0]?.recommendation, { state: 'agreed', value: 'validate inputs' });
});

test('preserves divergent recommendations as an unresolved disagreement', () => {
  const result = groupReviewFindings([
    { reviewerId: 'security', findingId: 'security-1', rootCauseId: 'credential-handling', recommendation: 'block export' },
    { reviewerId: 'ux', findingId: 'ux-1', rootCauseId: 'credential-handling', recommendation: 'warn before export' }
  ]);

  assert.deepEqual(result, [{
    rootCauseId: 'credential-handling',
    findings: [
      { reviewerId: 'security', findingId: 'security-1', rootCauseId: 'credential-handling', recommendation: 'block export' },
      { reviewerId: 'ux', findingId: 'ux-1', rootCauseId: 'credential-handling', recommendation: 'warn before export' }
    ],
    recommendation: { state: 'unresolved-disagreement', values: ['block export', 'warn before export'] }
  }]);
});

test('rejects findings without an explicit root cause identifier', () => {
  assert.throws(
    () => groupReviewFindings([{ reviewerId: 'security', findingId: 'security-1', rootCauseId: '', recommendation: 'block export' }]),
    /rootCauseId/i
  );
});
