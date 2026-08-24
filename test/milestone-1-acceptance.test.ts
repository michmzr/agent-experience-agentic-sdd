import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CodexSessionAdapter } from '../src/review/adapters/codex.js';
import { groupReviewFindings, type ReviewFinding as OrchestratorFinding } from '../src/review/orchestrator.js';
import { createReviewProposals, type ReviewFindingForProposal } from '../src/review/proposals.js';
import { ReviewRuntime, type Reviewer } from '../src/review/runtime.js';
import { sanitizeForReview } from '../src/review/sanitizer.js';

const rawSecrets = [
  'milestone-one-private-token',
  'sk-live-milestone-one',
  'correct-horse-battery-staple'
] as const;

test('preserves deterministic end-to-end review provenance without leaking raw source secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ael-milestone-1-'));
  const fixture = await readFile(join(process.cwd(), 'test/fixtures/session-review/milestone-1-codex.jsonl'), 'utf8');
  await writeFile(join(root, 'session.jsonl'), fixture);

  const normalized = await new CodexSessionAdapter(root).read('session.jsonl');
  const sanitized = sanitizeForReview(normalized);
  const reviewedArtifacts: string[] = [];
  let expensiveCalls = 0;

  const reviewers: readonly Reviewer[] = [
    fixtureReviewer('security', {
      code: 'credential-export',
      findingId: 'security-credential-export',
      rootCauseId: 'credential-handling',
      recommendation: 'block export',
      statement: 'Credential-bearing output must not leave the local review boundary.',
      lessonKind: 'failure',
      proposalCategory: 'code',
      proposalTitle: 'Block unsafe review export'
    }, reviewedArtifacts),
    fixtureReviewer('usability', {
      code: 'credential-warning',
      findingId: 'usability-credential-warning',
      rootCauseId: 'credential-handling',
      recommendation: 'warn before export',
      statement: 'Manual review should explain why an export was blocked.',
      lessonKind: 'convention',
      proposalCategory: 'documentation',
      proposalTitle: 'Document blocked review exports'
    }, reviewedArtifacts),
    {
      id: 'remote-deep-review',
      expensive: true,
      async review() {
        expensiveCalls += 1;
        return [{ code: 'remote-deep-review' }];
      }
    }
  ];
  const runtime = new ReviewRuntime({
    profiles: [{ id: 'milestone-1', version: '1', reviewerIds: reviewers.map((reviewer) => reviewer.id) }],
    reviewers
  });

  const review = await runtime.run({
    artifact: sanitized,
    profile: { id: 'milestone-1', version: '1' },
    allowExpensiveChecks: false
  });
  const findings = review.results.flatMap(({ reviewerId, findings }) => findings.map((finding) => ({ reviewerId, ...finding })));
  const groups = groupReviewFindings(findings.map(toOrchestratorFinding));
  const proposals = createReviewProposals({
    sessionId: sanitized.session.sessionId,
    findings: findings.map(toProposalFinding)
  });

  assert.equal(normalized.source, 'codex');
  assert.deepEqual(normalized.events.map(({ kind, outcome }) => ({ kind, outcome })), [
    { kind: 'metadata', outcome: 'unknown' },
    { kind: 'tool', outcome: 'failed' },
    { kind: 'message', outcome: 'unknown' }
  ]);
  assert.equal(reviewedArtifacts.length, 2);
  assert.equal(reviewedArtifacts.every((artifact) => artifact === JSON.stringify(sanitized)), true);
  assert.equal(rawSecrets.some((secret) => fixture.includes(secret)), true);
  assert.equal(rawSecrets.some((secret) => JSON.stringify({ normalized, sanitized, review, groups, proposals }).includes(secret)), false);
  assert.deepEqual(review.skippedReviewerIds, ['remote-deep-review']);
  assert.equal(expensiveCalls, 0);
  assert.deepEqual(groups.map(({ rootCauseId, recommendation }) => ({ rootCauseId, recommendation })), [{
    rootCauseId: 'credential-handling',
    recommendation: { state: 'unresolved-disagreement', values: ['block export', 'warn before export'] }
  }]);
  assert.equal(proposals.candidates.every((candidate) => candidate.state === 'candidate'), true);
  assert.deepEqual(
    proposals.proposals.map(({ findingId, candidateId, requiresSpecification }) => ({ findingId, candidateId, requiresSpecification })),
    [
      {
        findingId: 'security-credential-export',
        candidateId: `candidate:${sanitized.session.sessionId}:security-credential-export`,
        requiresSpecification: true
      },
      {
        findingId: 'usability-credential-warning',
        candidateId: `candidate:${sanitized.session.sessionId}:usability-credential-warning`,
        requiresSpecification: false
      }
    ]
  );

  const explicitlyAllowed = await runtime.run({
    artifact: sanitized,
    profile: { id: 'milestone-1', version: '1' },
    allowExpensiveChecks: true
  });
  assert.equal(expensiveCalls, 1);
  assert.deepEqual(explicitlyAllowed.skippedReviewerIds, []);
  assert.deepEqual(explicitlyAllowed.results.map(({ reviewerId }) => reviewerId), [
    'security',
    'usability',
    'remote-deep-review'
  ]);
});

function fixtureReviewer(
  id: string,
  finding: Readonly<Record<string, string>>,
  reviewedArtifacts: string[]
): Reviewer {
  return {
    id,
    expensive: false,
    async review(artifact) {
      reviewedArtifacts.push(JSON.stringify(artifact));
      return [finding as { readonly code: string; readonly [attribute: string]: string }];
    }
  };
}

function toOrchestratorFinding(finding: Readonly<Record<string, string>>): OrchestratorFinding {
  return {
    reviewerId: finding.reviewerId!,
    findingId: finding.findingId!,
    rootCauseId: finding.rootCauseId!,
    recommendation: finding.recommendation!
  };
}

function toProposalFinding(finding: Readonly<Record<string, string>>): ReviewFindingForProposal {
  return {
    id: finding.findingId!,
    statement: finding.statement!,
    lessonKind: finding.lessonKind as ReviewFindingForProposal['lessonKind'],
    proposal: {
      category: finding.proposalCategory as ReviewFindingForProposal['proposal']['category'],
      title: finding.proposalTitle!
    }
  };
}
