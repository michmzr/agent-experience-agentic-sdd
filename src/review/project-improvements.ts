export const projectImprovementCategories = ['architecture', 'developer-experience', 'project-management'] as const;
export const projectFindingSeverities = ['low', 'medium', 'high'] as const;

export interface ProjectReviewFinding {
  readonly code: 'project-improvement';
  readonly findingId: string;
  readonly rootCauseId: string;
  readonly recommendation: string;
  readonly category: (typeof projectImprovementCategories)[number];
  readonly severity: (typeof projectFindingSeverities)[number];
  readonly evidenceEventIds: readonly string[];
}

export interface ProjectImprovement {
  readonly id: string;
  readonly category: ProjectReviewFinding['category'];
  readonly rootCauseId: string;
  readonly recommendation: string;
  readonly severity: ProjectReviewFinding['severity'];
  readonly findingIds: readonly string[];
  readonly evidenceEventIds: readonly string[];
}

export interface ProjectReviewDiagnostic {
  readonly code: 'INVALID_PROJECT_FINDING' | 'UNRESOLVED_DISAGREEMENT';
  readonly findingId?: string;
}

export function isProjectReviewFinding(value: unknown): value is ProjectReviewFinding {
  if (!isRecord(value)) return false;
  return value.code === 'project-improvement'
    && hasText(value.findingId)
    && hasText(value.rootCauseId)
    && hasText(value.recommendation)
    && projectImprovementCategories.includes(value.category as ProjectReviewFinding['category'])
    && projectFindingSeverities.includes(value.severity as ProjectReviewFinding['severity'])
    && Array.isArray(value.evidenceEventIds)
    && value.evidenceEventIds.length > 0
    && value.evidenceEventIds.every(hasText);
}

export function consolidateProjectReviewFindings(
  findings: readonly unknown[],
  eventIds: readonly string[]
): { readonly improvements: readonly ProjectImprovement[]; readonly diagnostics: readonly ProjectReviewDiagnostic[] } {
  const knownEventIds = new Set(eventIds);
  const validFindings: ProjectReviewFinding[] = [];
  const diagnostics: ProjectReviewDiagnostic[] = [];

  for (const value of findings) {
    if (!isProjectReviewFinding(value) || value.evidenceEventIds.some((eventId) => !knownEventIds.has(eventId))) {
      diagnostics.push(invalidFindingDiagnostic(value));
      continue;
    }
    validFindings.push(value);
  }

  const grouped = new Map<string, ProjectReviewFinding[]>();
  for (const finding of validFindings) {
    const key = `${finding.category}:${finding.rootCauseId}`;
    const group = grouped.get(key);
    if (group) group.push(finding);
    else grouped.set(key, [finding]);
  }

  const improvements: ProjectImprovement[] = [];
  for (const [key, group] of [...grouped.entries()].sort(([left], [right]) => compareText(left, right))) {
    const orderedFindings = [...group].sort((left, right) => compareText(left.findingId, right.findingId));
    const recommendations = [...new Set(orderedFindings.map((finding) => finding.recommendation))];
    if (recommendations.length !== 1) {
      diagnostics.push({ code: 'UNRESOLVED_DISAGREEMENT', findingId: orderedFindings[0].findingId });
      continue;
    }

    const evidenceEventIds = [...new Set(orderedFindings.flatMap((finding) => finding.evidenceEventIds))]
      .sort(compareText);
    if (evidenceEventIds.length < 2) continue;

    const { category, rootCauseId } = orderedFindings[0];
    improvements.push({
      id: `project-improvement:${category}:${rootCauseId}`,
      category,
      rootCauseId,
      recommendation: recommendations[0],
      severity: highestSeverity(orderedFindings),
      findingIds: orderedFindings.map((finding) => finding.findingId),
      evidenceEventIds
    });
  }

  return {
    improvements,
    diagnostics: diagnostics.sort(compareDiagnostics)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalidFindingDiagnostic(value: unknown): ProjectReviewDiagnostic {
  const findingId = isRecord(value) && hasText(value.findingId) ? value.findingId : undefined;
  return findingId ? { code: 'INVALID_PROJECT_FINDING', findingId } : { code: 'INVALID_PROJECT_FINDING' };
}

function highestSeverity(findings: readonly ProjectReviewFinding[]): ProjectReviewFinding['severity'] {
  return findings.reduce(
    (highest, finding) => projectFindingSeverities.indexOf(finding.severity) > projectFindingSeverities.indexOf(highest)
      ? finding.severity
      : highest,
    'low' as ProjectReviewFinding['severity']
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDiagnostics(left: ProjectReviewDiagnostic, right: ProjectReviewDiagnostic): number {
  return compareText(left.code, right.code) || compareText(left.findingId ?? '', right.findingId ?? '');
}
