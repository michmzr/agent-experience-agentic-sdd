import type { NormalizedSessionEvent } from './contracts.js';
import type { ProjectReviewFinding } from './project-improvements.js';
import { ReviewRuntime, type ReviewFinding, type ReviewProfile, type Reviewer } from './runtime.js';

export const defaultReviewProfile: Pick<ReviewProfile, 'id' | 'version'> = Object.freeze({ id: 'default', version: '1' });

const defaultReviewers: readonly Reviewer[] = [
  keywordReviewer('prompt-effectiveness', ['prompt', 'instruction', 'acceptance', 'ambig'], 'prompt-effectiveness'),
  workflowReviewer(),
  failedEventReviewer('failures-learning', 'failure-learning'),
  keywordReviewer('temporary-artifacts', ['temporary', 'artifact', 'scratch', 'workaround'], 'temporary-artifact'),
  keywordReviewer('code-changes', ['code', 'changed', 'patch', 'diff'], 'code-change'),
  projectReviewer('architecture', 'architecture', [['module-boundary', ['architecture', 'boundary', 'dependency', 'module'], 'Separate the affected module boundary']]),
  projectReviewer('developer-experience', 'developer-experience', [['developer-workflow-friction', ['developer experience', 'developer-experience', 'dx', 'friction'], 'Remove the recurring developer workflow friction']]),
  projectReviewer('project-management', 'project-management', [['milestone-ownership', ['project', 'milestone', 'plan', 'ownership'], 'Clarify milestone ownership and delivery scope']]),
  privacyReviewer(),
  failedEventReviewer('diagnostics', 'diagnostic-failure', true, false)
];

export function createDefaultReviewRuntime(): ReviewRuntime {
  return new ReviewRuntime({
    profiles: [{ ...defaultReviewProfile, reviewerIds: defaultReviewers.map(({ id }) => id) }],
    reviewers: defaultReviewers
  });
}

function keywordReviewer(id: string, keywords: readonly string[], code: string): Reviewer {
  return {
    id,
    expensive: false,
    async review(artifact) {
      return artifact.session.events
        .filter((event) => includesKeyword(event, keywords))
        .map((event) => finding(code, id, event));
    }
  };
}

function projectReviewer(
  id: string,
  category: ProjectReviewFinding['category'],
  rules: readonly (readonly [rootCauseId: string, keywords: readonly string[], recommendation: string])[]
): Reviewer {
  return {
    id,
    expensive: false,
    async review(artifact) {
      const findings: Array<ProjectReviewFinding & ReviewFinding> = [];
      for (const event of artifact.session.events) {
        const rule = rules.find(([, keywords]) => includesKeyword(event, keywords));
        if (!rule) continue;
        const [rootCauseId, , recommendation] = rule;
        findings.push({
          code: 'project-improvement',
          findingId: `${id}:${event.id}`,
          rootCauseId,
          recommendation,
          category,
          severity: event.outcome === 'failed' ? 'high' : 'medium',
          evidenceEventIds: [event.id]
        });
      }
      return findings;
    }
  };
}

function failedEventReviewer(id: string, code: string, expensive = false, includeEventId = true): Reviewer {
  return {
    id,
    expensive,
    async review(artifact) {
      return artifact.session.events
        .filter((event) => event.outcome === 'failed')
        .map((event) => includeEventId ? finding(code, id, event) : {
          code,
          findingId: `${id}:${event.id}`,
          rootCauseId: `diagnostic:${event.tool ?? event.kind}`,
          recommendation: `Run explicit diagnostics for ${event.tool ?? event.kind}`
        });
    }
  };
}

function workflowReviewer(): Reviewer {
  return {
    id: 'workflow',
    expensive: false,
    async review(artifact) {
      return artifact.session.events
        .filter((event) => event.kind === 'tool')
        .map((event) => ({
          code: `workflow-${event.outcome}`,
          findingId: `workflow:${event.id}`,
          rootCauseId: `${event.outcome}-tool:${event.tool ?? 'unknown'}`,
          recommendation: event.outcome === 'failed'
            ? `Investigate failed ${event.tool ?? 'unknown'} workflow`
            : `Reuse ${event.tool ?? 'unknown'} workflow with outcome ${event.outcome}`
        }));
    }
  };
}

function privacyReviewer(): Reviewer {
  return {
    id: 'privacy',
    expensive: false,
    async review(artifact) {
      return artifact.session.events
        .filter((event) => event.kind === 'message' || event.kind === 'metadata')
        .map((event) => ({
          code: `review-${event.kind}`,
          findingId: `privacy:${event.id}`,
          rootCauseId: `review-evidence:${event.kind}`,
          recommendation: `Preserve sanitized ${event.kind} evidence for review`
        }));
    }
  };
}

function includesKeyword(event: NormalizedSessionEvent, keywords: readonly string[]): boolean {
  const evidence = `${event.tool ?? ''}\n${event.text ?? ''}`.toLowerCase();
  return keywords.some((keyword) => evidence.includes(keyword));
}

function finding(code: string, reviewerId: string, event: NormalizedSessionEvent) {
  return {
    code: `${code}:${event.id}`,
    findingId: `${reviewerId}:${event.id}`,
    rootCauseId: `${code}:${event.kind}`,
    recommendation: `Review ${code.replaceAll('-', ' ')} evidence from ${event.kind}`
  };
}
