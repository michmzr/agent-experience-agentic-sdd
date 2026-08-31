import assert from 'node:assert/strict';
import test from 'node:test';

import { createReviewProposals } from '../src/review/proposals.js';

test('keeps generated lessons as candidates and preserves session to finding to proposal provenance', () => {
  const result = createReviewProposals({
    sessionId: 'session-9',
    findings: [
      {
        id: 'finding-b',
        statement: 'The command output obscures the failed verification.',
        lessonKind: 'failure',
        proposal: { category: 'code', title: 'Expose verification failure' },
        severity: 'high',
        evidenceEventIds: ['event-2', 'event-3'],
        findingIds: ['reviewer:event-2', 'reviewer:event-3']
      },
      {
        id: 'finding-a',
        statement: 'The review command needs a documented usage example.',
        lessonKind: 'convention',
        proposal: { category: 'documentation', title: 'Document manual review' }
      }
    ]
  });

  assert.deepEqual(result.candidates, [
    {
      id: 'candidate:session-9:finding-a',
      sessionId: 'session-9',
      findingId: 'finding-a',
      state: 'candidate',
      kind: 'convention',
      statement: 'The review command needs a documented usage example.'
    },
    {
      id: 'candidate:session-9:finding-b',
      sessionId: 'session-9',
      findingId: 'finding-b',
      state: 'candidate',
      kind: 'failure',
      statement: 'The command output obscures the failed verification.'
    }
  ]);
  assert.deepEqual(result.proposals, [
    {
      id: 'proposal:session-9:finding-a',
      sessionId: 'session-9',
      findingId: 'finding-a',
      candidateId: 'candidate:session-9:finding-a',
      category: 'documentation',
      title: 'Document manual review',
      requiresSpecification: false
    },
    {
      id: 'proposal:session-9:finding-b',
      sessionId: 'session-9',
      findingId: 'finding-b',
      candidateId: 'candidate:session-9:finding-b',
      category: 'code',
      title: 'Expose verification failure',
      requiresSpecification: true,
      severity: 'high',
      evidenceEventIds: ['event-2', 'event-3'],
      findingIds: ['reviewer:event-2', 'reviewer:event-3']
    }
  ]);
});

test('requires a specification declaration for code, tooling, skill, workflow, and architecture proposals', () => {
  const result = createReviewProposals({
    sessionId: 'session-1',
    findings: (['code', 'tooling', 'skill', 'workflow', 'architecture'] as const).map((category) => ({
      id: `finding-${category}`,
      statement: `Improve ${category}.`,
      lessonKind: 'heuristic' as const,
      proposal: { category, title: `Improve ${category}` }
    }))
  });

  assert.equal(result.proposals.every((proposal) => proposal.requiresSpecification), true);
});

test('keeps developer-experience and project-management proposals out of specification by default', () => {
  const result = createReviewProposals({
    sessionId: 'session-1',
    findings: (['developer-experience', 'project-management'] as const).map((category) => ({
      id: `finding-${category}`,
      statement: `Improve ${category}.`,
      lessonKind: 'heuristic' as const,
      proposal: { category, title: `Improve ${category}` }
    }))
  });

  assert.equal(result.proposals.every((proposal) => !proposal.requiresSpecification), true);
});

test('rejects incomplete and ambiguous proposal input', () => {
  assert.throws(() => createReviewProposals({ sessionId: '', findings: [] }), /session id/i);
  assert.throws(() => createReviewProposals({
    sessionId: 'session-1',
    findings: [{ id: 'finding-1', statement: 'A finding.', lessonKind: 'heuristic', proposal: { category: 'documentation', title: 'Good' }, severity: 'critical' as never }]
  }), /severity/i);
  assert.throws(() => createReviewProposals({
    sessionId: 'session-1',
    findings: [{ id: 'finding-1', statement: 'A finding.', lessonKind: 'heuristic', proposal: { category: 'documentation', title: 'Good' }, evidenceEventIds: [] }]
  }), /evidence/i);
  assert.throws(() => createReviewProposals({
    sessionId: 'session-1',
    findings: [{ id: 'finding-1', statement: 'A finding.', lessonKind: 'heuristic', proposal: { category: 'documentation', title: 'Good' }, findingIds: [] }]
  }), /finding ids/i);
  assert.throws(() => createReviewProposals({
    sessionId: 'session-1',
    findings: [{ id: 'finding-1', statement: 'A finding.', lessonKind: 'heuristic', proposal: { category: 'documentation', title: 'Good' }, findingIds: ['reviewer:1', 'reviewer:1'] }]
  }), /finding ids/i);
  assert.throws(() => createReviewProposals({
    sessionId: 'session-1',
    findings: [{ id: 'finding-1', statement: 'A finding.', lessonKind: 'heuristic', proposal: { category: 'documentation', title: 'Good' }, findingIds: ['  '] }]
  }), /finding ids/i);
  assert.throws(() => createReviewProposals({
    sessionId: 'session-1',
    findings: [{ id: 'finding-1', statement: 'A finding.', lessonKind: 'heuristic', proposal: { category: 'documentation', title: 'Good' }, findingIds: [1] as never }]
  }), /finding ids/i);
  assert.throws(() => createReviewProposals({
    sessionId: 'session-1',
    findings: [{ id: 'finding-1', statement: 'A finding.', lessonKind: 'heuristic', proposal: { category: 'documentation', title: 'Good' }, evidenceEventIds: ['event-1', ' event-1 '] }]
  }), /evidence/i);
  assert.throws(() => createReviewProposals({
    sessionId: 'session-1',
    findings: [{ id: 'finding-1', statement: 'A finding.', lessonKind: 'heuristic', proposal: { category: 'documentation', title: 'Good' }, evidenceEventIds: ['   '] }]
  }), /evidence/i);
  assert.throws(() => createReviewProposals({
    sessionId: 'session-1',
    findings: [
      { id: 'finding-1', statement: 'A finding.', lessonKind: 'heuristic', proposal: { category: 'unsupported' as never, title: 'Bad' } }
    ]
  }), /category/i);
  assert.throws(() => createReviewProposals({
    sessionId: 'session-1',
    findings: [
      { id: 'same', statement: 'One.', lessonKind: 'heuristic', proposal: { category: 'documentation', title: 'One' } },
      { id: 'same', statement: 'Two.', lessonKind: 'heuristic', proposal: { category: 'documentation', title: 'Two' } }
    ]
  }), /duplicate finding/i);
});
