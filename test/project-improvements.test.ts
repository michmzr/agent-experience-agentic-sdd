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

test('reports invalid category and blank or missing required fields', () => {
  const result = consolidateProjectReviewFindings([
    { ...finding('event-1'), category: 'unrecognized-category' },
    { ...finding('event-2'), findingId: '' },
    {
      code: 'project-improvement',
      rootCauseId: 'module-boundary',
      recommendation: 'Split the module boundary',
      category: 'architecture',
      severity: 'high',
      evidenceEventIds: ['event-3']
    },
    { ...finding('event-4'), rootCauseId: ' ' },
    {
      code: 'project-improvement',
      findingId: 'architecture:missing-root-cause',
      recommendation: 'Split the module boundary',
      category: 'architecture',
      severity: 'high',
      evidenceEventIds: ['event-5']
    },
    { ...finding('event-6'), recommendation: '' },
    {
      code: 'project-improvement',
      findingId: 'architecture:missing-recommendation',
      rootCauseId: 'module-boundary',
      category: 'architecture',
      severity: 'high',
      evidenceEventIds: ['event-7']
    }
  ], ['event-1', 'event-2', 'event-3', 'event-4', 'event-5', 'event-6', 'event-7']);

  assert.deepEqual(result, {
    improvements: [],
    diagnostics: [
      { code: 'INVALID_PROJECT_FINDING' },
      { code: 'INVALID_PROJECT_FINDING' },
      { code: 'INVALID_PROJECT_FINDING', findingId: 'architecture:event-1' },
      { code: 'INVALID_PROJECT_FINDING', findingId: 'architecture:event-4' },
      { code: 'INVALID_PROJECT_FINDING', findingId: 'architecture:event-6' },
      { code: 'INVALID_PROJECT_FINDING', findingId: 'architecture:missing-recommendation' },
      { code: 'INVALID_PROJECT_FINDING', findingId: 'architecture:missing-root-cause' }
    ]
  });
});

test('selects the highest severity from mixed corroborating findings', () => {
  const result = consolidateProjectReviewFindings([
    { ...finding('event-low'), severity: 'low' as const },
    { ...finding('event-high'), severity: 'high' as const },
    { ...finding('event-medium'), severity: 'medium' as const }
  ], ['event-low', 'event-high', 'event-medium']);

  assert.equal(result.improvements[0]?.severity, 'high');
});

test('returns multiple improvements in deterministic lexical order', () => {
  const result = consolidateProjectReviewFindings([
    { ...finding('event-zeta-2'), rootCauseId: 'zeta' },
    {
      ...finding('event-dx-1'),
      findingId: 'developer-experience:event-dx-1',
      category: 'developer-experience' as const,
      rootCauseId: 'alpha'
    },
    { ...finding('event-alpha-2'), rootCauseId: 'alpha' },
    { ...finding('event-zeta-1'), rootCauseId: 'zeta' },
    { ...finding('event-alpha-1'), rootCauseId: 'alpha' },
    {
      ...finding('event-dx-2'),
      findingId: 'developer-experience:event-dx-2',
      category: 'developer-experience' as const,
      rootCauseId: 'alpha'
    }
  ], ['event-zeta-2', 'event-dx-1', 'event-alpha-2', 'event-zeta-1', 'event-alpha-1', 'event-dx-2']);

  assert.deepEqual(result.improvements.map((improvement) => improvement.id), [
    'project-improvement:architecture:alpha',
    'project-improvement:architecture:zeta',
    'project-improvement:developer-experience:alpha'
  ]);
});

test('orders diagnostics by code and then finding ID', () => {
  const result = consolidateProjectReviewFindings([
    finding('missing-z'),
    { ...finding('event-conflict-b'), rootCauseId: 'conflict', findingId: 'architecture:conflict-b' },
    finding('missing-a'),
    {
      ...finding('event-conflict-a'),
      rootCauseId: 'conflict',
      findingId: 'architecture:conflict-a',
      recommendation: 'Adopt a module ownership policy'
    }
  ], ['event-conflict-a', 'event-conflict-b']);

  assert.deepEqual(result.diagnostics, [
    { code: 'INVALID_PROJECT_FINDING', findingId: 'architecture:missing-a' },
    { code: 'INVALID_PROJECT_FINDING', findingId: 'architecture:missing-z' },
    { code: 'UNRESOLVED_DISAGREEMENT', findingId: 'architecture:conflict-a' }
  ]);
});

test('recognizes only structurally valid project findings', () => {
  assert.equal(isProjectReviewFinding(finding('event-1')), true);
  assert.equal(isProjectReviewFinding({ ...finding('event-1'), severity: 'critical' }), false);
});
