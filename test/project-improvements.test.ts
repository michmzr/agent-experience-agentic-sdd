import assert from 'node:assert/strict';
import test from 'node:test';

import {
  consolidateProjectReviewFindings,
  isProjectReviewFinding
} from '../src/review/project-improvements.js';

const finding = (eventId: string, recommendation = 'Split the module boundary') => ({
  code: 'project-improvement' as const,
  findingId: `architecture:${eventId}`,
  rootCauseId: 'module-boundary',
  recommendation,
  category: 'architecture' as const,
  severity: 'high' as const,
  evidenceEventIds: [eventId]
});

test('consolidates two distinct supporting events into a sorted high-severity improvement', () => {
  const result = consolidateProjectReviewFindings(
    [finding('event-2'), finding('event-1')],
    ['event-2', 'event-1']
  );

  assert.deepEqual(result, {
    improvements: [{
      id: 'project-improvement:architecture:module-boundary',
      category: 'architecture',
      rootCauseId: 'module-boundary',
      recommendation: 'Split the module boundary',
      severity: 'high',
      findingIds: ['architecture:event-1', 'architecture:event-2'],
      evidenceEventIds: ['event-1', 'event-2']
    }],
    diagnostics: []
  });
});

test('does not create an improvement from one supporting finding', () => {
  const result = consolidateProjectReviewFindings([finding('event-1')], ['event-1']);

  assert.deepEqual(result, { improvements: [], diagnostics: [] });
});

test('does not treat duplicate evidence from the same event as corroboration', () => {
  const result = consolidateProjectReviewFindings(
    [finding('event-1'), { ...finding('event-1'), findingId: 'architecture:event-1-duplicate' }],
    ['event-1']
  );

  assert.deepEqual(result, { improvements: [], diagnostics: [] });
});

test('preserves root-cause identifiers that contain a colon', () => {
  const result = consolidateProjectReviewFindings(
    [
      { ...finding('event-1'), rootCauseId: 'module:boundary' },
      { ...finding('event-2'), rootCauseId: 'module:boundary' }
    ],
    ['event-1', 'event-2']
  );

  assert.equal(result.improvements[0]?.id, 'project-improvement:architecture:module:boundary');
  assert.equal(result.improvements[0]?.rootCauseId, 'module:boundary');
});

test('reports a recommendation disagreement and withholds the improvement', () => {
  const result = consolidateProjectReviewFindings(
    [finding('event-1'), finding('event-2', 'Adopt a module ownership policy')],
    ['event-1', 'event-2']
  );

  assert.deepEqual(result, {
    improvements: [],
    diagnostics: [{ code: 'UNRESOLVED_DISAGREEMENT', findingId: 'architecture:event-1' }]
  });
});

test('reports invalid findings with unknown or empty evidence', () => {
  const result = consolidateProjectReviewFindings(
    [
      finding('event-missing'),
      { ...finding('event-1'), findingId: 'architecture:empty-evidence', evidenceEventIds: [] }
    ],
    ['event-1']
  );

  assert.deepEqual(result, {
    improvements: [],
    diagnostics: [
      { code: 'INVALID_PROJECT_FINDING', findingId: 'architecture:empty-evidence' },
      { code: 'INVALID_PROJECT_FINDING', findingId: 'architecture:event-missing' }
    ]
  });
});

test('recognizes only structurally valid project findings', () => {
  assert.equal(isProjectReviewFinding(finding('event-1')), true);
  assert.equal(isProjectReviewFinding({ ...finding('event-1'), severity: 'critical' }), false);
});
