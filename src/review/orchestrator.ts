export interface ReviewFinding {
  readonly reviewerId: string;
  readonly findingId: string;
  readonly rootCauseId: string;
  readonly recommendation: string;
}

export interface AgreedRecommendation {
  readonly state: 'agreed';
  readonly value: string;
}

export interface UnresolvedDisagreement {
  readonly state: 'unresolved-disagreement';
  readonly values: readonly string[];
}

export interface ReviewFindingGroup {
  readonly rootCauseId: string;
  readonly findings: readonly ReviewFinding[];
  readonly recommendation: AgreedRecommendation | UnresolvedDisagreement;
}

export function groupReviewFindings(findings: readonly ReviewFinding[]): readonly ReviewFindingGroup[] {
  const byRootCause = new Map<string, ReviewFinding[]>();
  for (const finding of findings) {
    validateFinding(finding);
    const group = byRootCause.get(finding.rootCauseId) ?? [];
    group.push(finding);
    byRootCause.set(finding.rootCauseId, group);
  }

  return [...byRootCause.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([rootCauseId, group]) => {
      const orderedFindings = [...group].sort(compareFindings);
      const recommendations = [...new Set(orderedFindings.map((finding) => finding.recommendation))].sort((left, right) => left.localeCompare(right));
      return {
        rootCauseId,
        findings: orderedFindings,
        recommendation: recommendations.length === 1
          ? { state: 'agreed' as const, value: recommendations[0]! }
          : { state: 'unresolved-disagreement' as const, values: recommendations }
      };
    });
}

function validateFinding(finding: ReviewFinding): void {
  for (const [name, value] of Object.entries(finding)) {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`Review finding ${name} must be a non-empty string.`);
  }
}

function compareFindings(left: ReviewFinding, right: ReviewFinding): number {
  return left.reviewerId.localeCompare(right.reviewerId)
    || left.findingId.localeCompare(right.findingId)
    || left.recommendation.localeCompare(right.recommendation);
}
