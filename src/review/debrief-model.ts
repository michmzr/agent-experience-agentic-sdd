import type { AgentSource } from '../domain/types.js';
import type { NormalizedSessionEvent } from './contracts.js';
import type { ReviewFindingGroup } from './orchestrator.js';
import type { ProjectImprovement, ProjectReviewDiagnostic } from './project-improvements.js';
import type { ReviewRuntimeDiagnostic } from './runtime.js';
import { assertDurableTextSafe, assertSanitizedReviewArtifact, type SanitizedReviewArtifact } from './sanitizer.js';
import type { ReviewServiceDiagnostic } from './review-service.js';

export type DebriefSeverity = 'neutral' | 'low' | 'medium' | 'high';

export interface DebriefEvidence { readonly id: string; readonly occurredAt: string; readonly kind: NormalizedSessionEvent['kind']; readonly outcome: NormalizedSessionEvent['outcome']; readonly tool?: string; readonly summary: string; }
export interface DebriefTimelineEntry { readonly kind: 'session-start' | 'evidence' | 'session-end'; readonly occurredAt: string; readonly evidence?: DebriefEvidence; }
export interface DebriefInsight { readonly id: string; readonly kind: 'project-improvement' | 'legacy-finding'; readonly category: string; readonly severity: DebriefSeverity; readonly title: string; readonly recommendation: string; readonly evidence: readonly DebriefEvidence[]; readonly timeline: readonly DebriefTimelineEntry[]; }
export interface SessionDebriefCounts { readonly strengths: number; readonly improvements: number; readonly conflicts: number; readonly diagnostics: number; }
export interface SessionDebrief { readonly source: AgentSource; readonly sessionPseudonym: string; readonly startedAt: string; readonly endedAt: string; readonly durationMs: number; readonly actionCount: number; readonly headline: string; readonly insights: readonly DebriefInsight[]; readonly initialInsightIndex: number | null; readonly counts: SessionDebriefCounts; }
export interface ReviewForDebrief { readonly source: AgentSource; readonly findings: readonly ReviewFindingGroup[]; readonly projectImprovements: readonly ProjectImprovement[]; readonly projectReviewDiagnostics: readonly ProjectReviewDiagnostic[]; readonly serviceDiagnostics: readonly ReviewServiceDiagnostic[]; readonly runtimeDiagnostics: readonly ReviewRuntimeDiagnostic[]; readonly skippedReviewerIds: readonly string[]; }

export function buildSessionDebrief(artifact: SanitizedReviewArtifact, review: ReviewForDebrief): SessionDebrief {
  assertSanitizedReviewArtifact(artifact);
  const events = new Map(artifact.session.events.map((event) => [event.id, event]));
  const projects = review.projectImprovements
    .map((improvement) => projectInsight(improvement, events, artifact.session.startedAt, artifact.session.endedAt))
    .filter((insight): insight is DebriefInsight => insight !== null)
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity) || compareText(left.id, right.id));
  const legacy = [...review.findings]
    .sort((left, right) => compareText(left.rootCauseId, right.rootCauseId))
    .map(legacyInsight);
  const insights = Object.freeze([...projects, ...legacy]);
  const conflicts = review.findings.filter((finding) => finding.recommendation.state === 'unresolved-disagreement').length
    + review.projectReviewDiagnostics.filter((diagnostic) => diagnostic.code === 'UNRESOLVED_DISAGREEMENT').length;
  const counts = Object.freeze({
    strengths: review.findings.filter((finding) => finding.recommendation.state === 'agreed').length,
    improvements: projects.length,
    conflicts,
    diagnostics: review.runtimeDiagnostics.length + review.projectReviewDiagnostics.length + review.serviceDiagnostics.length + review.skippedReviewerIds.length
  });
  const headline = projects.length > 0
    ? `Review completed with ${projects.length} evidence-backed improvements.`
    : legacy.length > 0 ? `Review completed with ${legacy.length} workflow findings.` : 'Review completed with no corroborated insights.';
  return Object.freeze({
    source: review.source,
    sessionPseudonym: artifact.session.sessionId,
    startedAt: artifact.session.startedAt,
    endedAt: artifact.session.endedAt,
    durationMs: Math.max(0, Date.parse(artifact.session.endedAt) - Date.parse(artifact.session.startedAt)),
    actionCount: artifact.session.events.length,
    headline,
    insights,
    initialInsightIndex: insights.length ? 0 : null,
    counts
  });
}

function projectInsight(improvement: ProjectImprovement, events: ReadonlyMap<string, NormalizedSessionEvent>, startedAt: string, endedAt: string): DebriefInsight | null {
  const evidence = Object.freeze([...new Set(improvement.evidenceEventIds)]
    .map((id) => events.get(id)).filter((event): event is NormalizedSessionEvent => event !== undefined)
    .sort((left, right) => compareText(left.occurredAt, right.occurredAt) || compareText(left.id, right.id))
    .map(toEvidence));
  if (evidence.length === 0) return null;
  const timeline = Object.freeze([
    Object.freeze({ kind: 'session-start' as const, occurredAt: startedAt }),
    ...evidence.slice(0, 3).map((item) => Object.freeze({ kind: 'evidence' as const, occurredAt: item.occurredAt, evidence: item })),
    Object.freeze({ kind: 'session-end' as const, occurredAt: endedAt })
  ]);
  return Object.freeze({ id: improvement.id, kind: 'project-improvement', category: improvement.category, severity: improvement.severity, title: safeTitle(improvement.rootCauseId), recommendation: safeRecommendation(improvement.recommendation), evidence, timeline });
}

function legacyInsight(group: ReviewFindingGroup): DebriefInsight {
  const recommendation = group.recommendation.state === 'agreed' ? safeRecommendation(group.recommendation.value) : 'Reviewer recommendations disagree.';
  return Object.freeze({ id: `legacy:${group.rootCauseId}`, kind: 'legacy-finding', category: 'workflow', severity: 'neutral', title: safeTitle(group.rootCauseId), recommendation, evidence: Object.freeze([]), timeline: Object.freeze([]) });
}

function toEvidence(event: NormalizedSessionEvent): DebriefEvidence {
  const subject = event.kind === 'tool' && event.tool ? `tool ${event.tool}` : `${event.kind} event`;
  return Object.freeze({ id: event.id, occurredAt: event.occurredAt, kind: event.kind, outcome: event.outcome, ...(event.tool ? { tool: event.tool } : {}), summary: `${subject}: ${event.outcome}` });
}

function safeTitle(value: string): string { try { assertDurableTextSafe(value); return value.replace(/[-_]/g, ' '); } catch { return 'Review insight'; } }
function safeRecommendation(value: string): string { try { assertDurableTextSafe(value); return value; } catch { return 'Review recommendation is unavailable in this view.'; } }
function severityRank(value: DebriefSeverity): number { return value === 'high' ? 3 : value === 'medium' ? 2 : value === 'low' ? 1 : 0; }
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
