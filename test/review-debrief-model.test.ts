import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSessionDebrief, type ReviewForDebrief } from '../src/review/debrief-model.js';
import { sanitizeForReview } from '../src/review/sanitizer.js';

const artifact = sanitizeForReview({
  source: 'codex',
  sessionId: 'session-debrief',
  startedAt: '2026-09-01T10:00:00.000Z',
  endedAt: '2026-09-01T10:05:00.000Z',
  events: [
    { id: 'first', kind: 'tool', occurredAt: '2026-09-01T10:01:00.000Z', tool: 'pnpm', outcome: 'failed' },
    { id: 'second', kind: 'message', occurredAt: '2026-09-01T10:02:00.000Z', text: 'private assistant text', outcome: 'unknown' },
    { id: 'third', kind: 'metadata', occurredAt: '2026-09-01T10:03:00.000Z', outcome: 'passed' },
    { id: 'fourth', kind: 'tool', occurredAt: '2026-09-01T10:04:00.000Z', tool: 'git', outcome: 'passed' }
  ]
});

function review(overrides: Partial<ReviewForDebrief> = {}): ReviewForDebrief {
  const eventIds = artifact.session.events.map((event) => event.id);
  return {
    source: 'codex',
    findings: [
      { rootCauseId: 'agreed_workflow', findings: [], recommendation: { state: 'agreed', value: 'Keep the review checklist current.' } },
      { rootCauseId: 'conflicted_workflow', findings: [], recommendation: { state: 'unresolved-disagreement', values: ['A', 'B'] } }
    ],
    projectImprovements: [
      { id: 'project-improvement:developer-experience:zeta', category: 'developer-experience', rootCauseId: 'zeta', recommendation: 'Improve local tooling.', severity: 'high', findingIds: ['z'], evidenceEventIds: [eventIds[3]!, eventIds[0]!, eventIds[2]!, eventIds[1]!] },
      { id: 'project-improvement:architecture:alpha', category: 'architecture', rootCauseId: 'alpha', recommendation: 'Clarify module boundaries.', severity: 'high', findingIds: ['a'], evidenceEventIds: [eventIds[2]!, eventIds[1]!, eventIds[0]!, 'unknown-event'] }
    ],
    projectReviewDiagnostics: [{ code: 'UNRESOLVED_DISAGREEMENT' }],
    serviceDiagnostics: [],
    runtimeDiagnostics: [{ code: 'REVIEWER_FAILED', reviewerId: 'runtime-reviewer' }],
    skippedReviewerIds: ['skipped-reviewer'],
    ...overrides
  };
}

test('builds ordered evidence-backed project insights with a bounded chronological timeline', () => {
  const debrief = buildSessionDebrief(artifact, review());
  assert.deepEqual(debrief.insights.slice(0, 2).map((insight) => insight.id), [
    'project-improvement:architecture:alpha',
    'project-improvement:developer-experience:zeta'
  ]);
  assert.equal(debrief.initialInsightIndex, 0);
  assert.deepEqual(debrief.insights[0]!.evidence.map((evidence) => evidence.summary), [
    'tool pnpm: failed', 'message event: unknown', 'metadata event: passed'
  ]);
  assert.deepEqual(debrief.insights[1]!.timeline.map((entry) => entry.kind), [
    'session-start', 'evidence', 'evidence', 'evidence', 'session-end'
  ]);
  assert.deepEqual(debrief.insights[1]!.timeline.slice(1, 4).map((entry) => entry.occurredAt), [
    '2026-09-01T10:01:00.000Z', '2026-09-01T10:02:00.000Z', '2026-09-01T10:03:00.000Z'
  ]);
  assert.equal(debrief.insights[0]!.evidence.some((evidence) => evidence.id === 'unknown-event'), false);
});

test('represents legacy groups without fabricated evidence or timelines and counts review states', () => {
  const debrief = buildSessionDebrief(artifact, review());
  const legacy = debrief.insights.find((insight) => insight.id === 'legacy:agreed_workflow')!;
  assert.deepEqual(legacy.evidence, []);
  assert.deepEqual(legacy.timeline, []);
  assert.equal(legacy.title, 'agreed workflow');
  assert.deepEqual(debrief.counts, { strengths: 1, improvements: 2, conflicts: 2, diagnostics: 3 });
  assert.equal(Object.isFrozen(debrief), true);
  assert.equal(Object.isFrozen(debrief.insights), true);
  assert.equal(Object.isFrozen(debrief.insights[0]!.evidence), true);
});

test('uses the empty selection and headline when no insight is corroborated', () => {
  const debrief = buildSessionDebrief(artifact, review({ findings: [], projectImprovements: [], projectReviewDiagnostics: [], runtimeDiagnostics: [], skippedReviewerIds: [] }));
  assert.equal(debrief.initialInsightIndex, null);
  assert.deepEqual(debrief.insights, []);
  assert.equal(debrief.headline, 'Review completed with no corroborated insights.');
});

test('replaces unsafe reviewer-provided project and legacy identifiers in insight ids', () => {
  const debrief = buildSessionDebrief(artifact, review({
    findings: [{ rootCauseId: 'Assistant: injected prompt', findings: [], recommendation: { state: 'agreed', value: 'Keep the review checklist current.' } }],
    projectImprovements: [{ ...review().projectImprovements[0]!, id: '/private/reviewer-output' }],
    projectReviewDiagnostics: [],
    runtimeDiagnostics: [],
    skippedReviewerIds: []
  }));
  const ids = debrief.insights.map((insight) => insight.id);
  assert.equal(ids.some((id) => id.includes('/private/reviewer-output')), false);
  assert.equal(ids.some((id) => id.includes('Assistant: injected prompt')), false);
  assert.match(ids[0]!, /^project-insight:/);
  assert.match(ids[1]!, /^legacy:review-insight:/);
});

test('orders unsafe project identifiers by their original stable ids, not their hash replacements', () => {
  const [first] = review().projectImprovements;
  const alpha = 'Assistant: alpha';
  const beta = 'Assistant: beta';
  const safe = (id: string) => `project-insight:${createHash('sha256').update(id).digest('hex')}`;
  assert.ok(safe(alpha) > safe(beta));
  const debrief = buildSessionDebrief(artifact, review({
    findings: [],
    projectImprovements: [
      { ...first!, id: beta },
      { ...first!, id: alpha }
    ],
    projectReviewDiagnostics: [],
    runtimeDiagnostics: [],
    skippedReviewerIds: []
  }));
  assert.deepEqual(debrief.insights.map((insight) => insight.id), [safe(alpha), safe(beta)]);
});

test('sorts unsafe improvement inputs before transforming them into presentation insights', () => {
  const [first] = review().projectImprovements;
  const reads: string[] = [];
  const tracked = (label: string, id: string) => {
    const improvement = { ...first! };
    Object.defineProperty(improvement, 'id', {
      enumerable: true,
      get: () => { reads.push(label); return id; }
    });
    return improvement;
  };
  const debrief = buildSessionDebrief(artifact, review({
    findings: [],
    projectImprovements: [
      tracked('beta', 'Assistant: beta'),
      tracked('alpha', 'Assistant: alpha')
    ],
    projectReviewDiagnostics: [],
    runtimeDiagnostics: [],
    skippedReviewerIds: []
  }));
  assert.deepEqual(reads, ['alpha', 'beta', 'alpha', 'beta']);
  assert.equal(debrief.insights.some((insight) => insight.id.includes('Assistant:')), false);
});
