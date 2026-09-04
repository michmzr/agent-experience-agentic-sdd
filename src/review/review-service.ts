import { basename, dirname, join } from 'node:path';

import type { AgentSource, LessonKind } from '../domain/types.js';
import { CodexSessionAdapter } from './adapters/codex.js';
import { discoverClaudeCodeArtifacts, normalizeClaudeCodeArtifact } from './adapters/claude-code.js';
import { discoverCursorExports, readCursorMarkdownExport } from './adapters/cursor.js';
import type { NormalizedSession } from './contracts.js';
import { createDefaultReviewRuntime, defaultReviewProfile } from './default-reviewers.js';
import { groupReviewFindings, type ReviewFinding as OrchestratorFinding, type ReviewFindingGroup } from './orchestrator.js';
import {
  consolidateProjectReviewFindings,
  isProjectReviewFinding,
  type ProjectReviewFinding, type ProjectImprovement, type ProjectReviewDiagnostic
} from './project-improvements.js';
import { createReviewProposals, type CandidateLesson, type ImprovementProposal, type ReviewFindingForProposal } from './proposals.js';
import { type ReviewRuntime, type ReviewProfile, type ReviewRuntimeDiagnostic } from './runtime.js';
import { sanitizeForReview, type SanitizedReviewArtifact } from './sanitizer.js';
import { buildSessionDebrief, type SessionDebrief } from './debrief-model.js';
import { isWithinRepository, resolveRepositoryIdentity, type RepositoryIdentityResolver } from './repository-identity.js';
import { selectRepositorySession, type ReviewSelectionPrompt } from './selection.js';

export interface ManualReviewInput {
  readonly source: AgentSource;
  readonly root: string;
  readonly session?: string;
  readonly project?: string;
  readonly allowExpensiveChecks: boolean;
  readonly profile?: Pick<ReviewProfile, 'id' | 'version'>;
  readonly interactive?: boolean;
  readonly repository?: string;
}

export interface ManualReviewDependencies {
  readonly runtime?: Pick<ReviewRuntime, 'run'>;
  readonly discover?: (input: Pick<ManualReviewInput, 'source' | 'root' | 'project'>) => Promise<readonly ReviewSessionDescriptor[]>;
  readonly prompt?: ReviewSelectionPrompt;
  readonly repositoryIdentityResolver?: RepositoryIdentityResolver;
}

export interface ReviewServiceDiagnostic {
  readonly code: 'DUPLICATE_REVIEWER_FINDING_ID' | 'PROPOSAL_ID_COLLISION' | 'PROJECT_REVIEWER_INVALID' | 'REVIEWER_RESULT_INVALID';
  readonly findingId?: string;
  readonly reviewerId?: string;
}

export interface ManualReviewResult {
  readonly source: AgentSource; readonly selectedSession: string; readonly profile: Pick<ReviewProfile, 'id' | 'version'>; readonly skippedReviewerIds: readonly string[]; readonly runtimeDiagnostics: readonly ReviewRuntimeDiagnostic[]; readonly findings: readonly ReviewFindingGroup[]; readonly projectImprovements: readonly ProjectImprovement[]; readonly projectReviewDiagnostics: readonly ProjectReviewDiagnostic[]; readonly serviceDiagnostics: readonly ReviewServiceDiagnostic[]; readonly candidates: readonly CandidateLesson[]; readonly proposals: readonly ImprovementProposal[];
}
export interface ManualReviewExecution { readonly result: ManualReviewResult; readonly debrief: SessionDebrief; }
interface ManualReviewPipelineExecution { readonly result: ManualReviewResult; readonly artifact: SanitizedReviewArtifact; }

export interface ReviewSessionDescriptor {
  readonly source: AgentSource;
  readonly id: string;
  readonly location: string;
  readonly repositoryHint?: string;
  readonly repositoryHintVerified?: boolean;
  readonly repositoryIdentity?: string;
  readonly updatedAt?: string;
}

export async function runManualReview(input: ManualReviewInput, dependencies: ManualReviewDependencies = {}): Promise<ManualReviewResult> {
  return (await executeManualReviewPipeline(input, dependencies)).result;
}

export async function runManualReviewExecution(input: ManualReviewInput, dependencies: ManualReviewDependencies = {}): Promise<ManualReviewExecution> {
  const execution = await executeManualReviewPipeline(input, dependencies);
  return { result: execution.result, debrief: buildSessionDebrief(execution.artifact, execution.result) };
}

async function executeManualReviewPipeline(input: ManualReviewInput, dependencies: ManualReviewDependencies = {}): Promise<ManualReviewPipelineExecution> {
  const session = await resolveSelectedSession(input, dependencies);
  const normalized = await loadSession({ ...input, session });
  const artifact = sanitizeForReview(normalized);
  const runtime = dependencies.runtime ?? createDefaultReviewRuntime();
  const run = await runtime.run({ artifact, profile: input.profile ?? defaultReviewProfile, allowExpensiveChecks: input.allowExpensiveChecks });
  const knownEventIds = new Set(artifact.session.events.map((event) => event.id));
  const duplicateReviewerIds = crossReviewerDuplicateReviewerIds(run.results);
  const reviewerReviews = run.results.map((result) => duplicateReviewerIds.has(result.reviewerId)
    ? invalidReviewerResult(result.reviewerId, 'DUPLICATE_REVIEWER_FINDING_ID')
    : validateReviewerResult(result.reviewerId, result.findings, knownEventIds));
  const projectFindings = reviewerReviews.flatMap((review) => review.projectFindings);
  const projectReview = consolidateProjectReviewFindings(
    projectFindings,
    knownEventIds
  );
  const findings = reviewerReviews.flatMap((review) => review.legacyFindings);
  const groups = groupReviewFindings(findings);
  const legacyProposalFindings: readonly ReviewFindingForProposal[] = groups.map((group) => ({
    id: group.rootCauseId,
    statement: `Review finding ${group.rootCauseId}`,
    lessonKind: 'successful-workflow' as LessonKind,
    proposal: { category: 'workflow' as const, title: recommendation(group.recommendation) }
  }));
  const projectProposalFindings: readonly ReviewFindingForProposal[] = projectReview.improvements.map((improvement) => ({
      id: improvement.id,
      statement: `Project improvement ${improvement.rootCauseId}`,
      lessonKind: 'heuristic' as LessonKind,
      proposal: { category: improvement.category, title: improvement.recommendation },
      severity: improvement.severity,
      evidenceEventIds: improvement.evidenceEventIds,
      findingIds: improvement.findingIds
  }));
  const legacyFindingIds = new Set(legacyProposalFindings.map((finding) => finding.id));
  const collisionDiagnostics: readonly ReviewServiceDiagnostic[] = projectProposalFindings
    .filter((finding) => legacyFindingIds.has(finding.id))
    .map((finding) => ({ code: 'PROPOSAL_ID_COLLISION' as const, findingId: finding.id }));
  const serviceDiagnostics: readonly ReviewServiceDiagnostic[] = [
    ...reviewerReviews.flatMap((review) => review.diagnostic ? [review.diagnostic] : []),
    ...collisionDiagnostics
  ].sort(compareServiceDiagnostics);
  const intelligence = createReviewProposals({
    sessionId: artifact.session.sessionId,
    findings: [...legacyProposalFindings, ...projectProposalFindings.filter((finding) => !legacyFindingIds.has(finding.id))]
  });
  const result: ManualReviewResult = {
    source: input.source,
    selectedSession: artifact.session.sessionId,
    profile: run.profile,
    skippedReviewerIds: run.skippedReviewerIds,
    runtimeDiagnostics: run.diagnostics,
    findings: groups,
    projectImprovements: projectReview.improvements,
    projectReviewDiagnostics: projectReview.diagnostics,
    serviceDiagnostics,
    candidates: intelligence.candidates,
    proposals: intelligence.proposals
  };
  return { result, artifact };
}

async function resolveSelectedSession(input: ManualReviewInput, dependencies: ManualReviewDependencies): Promise<string> {
  if (input.session && input.session !== 'latest') return input.session;
  if (!input.interactive || !input.repository) throw new SyntaxError('Interactive repository scope is required for session selection.');
  const identityResolver = dependencies.repositoryIdentityResolver ?? resolveRepositoryIdentity;
  const repository = identityResolver(input.repository);
  if (!repository) throw new Error('Repository identity could not be verified.');
  const discover = dependencies.discover ?? discoverReviewSessions;
  const sessions = await discover(input);
  const selectable = sessions.map(({ id, location, repositoryHintVerified, repositoryIdentity, updatedAt }) => {
    const artifactRepository = identityResolver(dirname(location));
    const verified = repositoryHintVerified === true
      && repositoryIdentity === repository.canonicalTopLevel
      && artifactRepository?.canonicalTopLevel === repository.canonicalTopLevel
      && isWithinRepository(repository, location);
    return {
      id,
      updatedAt,
      ...(verified ? { repositoryHintVerified: true, repositoryIdentity: repository.canonicalTopLevel } : {})
    };
  });
  return selectRepositorySession(selectable, { session: input.session, interactive: true, repositoryIdentity: repository.canonicalTopLevel }, dependencies.prompt);
}

export async function discoverReviewSessions(input: Pick<ManualReviewInput, 'source' | 'root' | 'project'>): Promise<readonly ReviewSessionDescriptor[]> {
  if (input.source === 'codex') return (await new CodexSessionAdapter(input.root).discover()).map(({ id, location, repositoryHint, repositoryHintVerified, repositoryIdentity, updatedAt }) => ({ source: input.source, id, location, repositoryHint, repositoryHintVerified, repositoryIdentity, updatedAt }));
  if (input.source === 'claude-code') {
    if (!input.project) throw new SyntaxError('Option is required: --project.');
    return (await discoverClaudeCodeArtifacts({ configDir: input.root, project: input.project })).map(({ id, location, repositoryHint, repositoryHintVerified, repositoryIdentity, updatedAt }) => ({ source: input.source, id, location, repositoryHint, repositoryHintVerified, repositoryIdentity, updatedAt }));
  }
  return discoverCursorExports(input.root).map(({ id, location, repositoryHint, repositoryHintVerified, repositoryIdentity, updatedAt }) => ({ source: input.source, id: `${id}.md`, location, repositoryHint, repositoryHintVerified, repositoryIdentity, updatedAt }));
}

async function loadSession(input: ManualReviewInput): Promise<NormalizedSession> {
  if (!input.session) throw new SyntaxError('An explicit session artifact is required in non-interactive mode.');
  if (input.source === 'codex') return new CodexSessionAdapter(input.root).read(input.session);
  if (input.source === 'claude-code') {
    if (!input.project) throw new SyntaxError('Option is required: --project.');
    const artifacts = await discoverClaudeCodeArtifacts({ configDir: input.root, project: input.project });
    const artifact = artifacts.find(({ id }) => id === input.session);
    if (!artifact) throw new Error('Selected Claude Code session artifact was not found.');
    return normalizeClaudeCodeArtifact(artifact);
  }
  const location = join(input.root, input.session);
  return await readCursorMarkdownExport({ source: 'cursor', id: basename(input.session, '.md'), location, format: 'markdown-export' }, input.root, new Date(0).toISOString());
}

function recommendation(value: { readonly state: 'agreed'; readonly value: string } | { readonly state: 'unresolved-disagreement'; readonly values: readonly string[] }): string {
  return value.state === 'agreed' ? value.value : value.values.join(' | ');
}

interface ValidatedReviewerResult {
  readonly reviewerId: string;
  readonly projectFindings: readonly ProjectReviewFinding[];
  readonly legacyFindings: readonly OrchestratorFinding[];
  readonly diagnostic?: ReviewServiceDiagnostic;
}

type ReviewerResultDiagnosticCode = Exclude<ReviewServiceDiagnostic['code'], 'PROPOSAL_ID_COLLISION'>;

function validateReviewerResult(
  reviewerId: string,
  findings: readonly unknown[],
  knownEventIds: ReadonlySet<string>
): ValidatedReviewerResult {
  const findingIds = new Set<string>();

  for (const finding of findings) {
    if (isProjectOutput(finding)) {
      if (!isProjectReviewFinding(finding)
        || finding.evidenceEventIds.some((eventId) => !knownEventIds.has(eventId))) {
        return invalidReviewerResult(reviewerId, 'PROJECT_REVIEWER_INVALID');
      }
    } else if (!isLegacyFinding(finding)) {
      return invalidReviewerResult(reviewerId, 'REVIEWER_RESULT_INVALID');
    }
    if (findingIds.has(finding.findingId)) return invalidReviewerResult(reviewerId, 'DUPLICATE_REVIEWER_FINDING_ID');
    findingIds.add(finding.findingId);
  }

  const projectFindings = findings.filter(isProjectOutput).filter(isProjectReviewFinding);
  const legacyFindings = findings
    .filter((finding): finding is Omit<OrchestratorFinding, 'reviewerId'> => !isProjectOutput(finding) && isLegacyFinding(finding))
    .map((finding) => ({
      reviewerId,
      findingId: finding.findingId,
      rootCauseId: finding.rootCauseId,
      recommendation: finding.recommendation
  }));

  return { reviewerId, projectFindings, legacyFindings };
}

function invalidReviewerResult(
  reviewerId: string,
  code: ReviewerResultDiagnosticCode
): ValidatedReviewerResult {
  return { reviewerId, projectFindings: [], legacyFindings: [], diagnostic: { code, reviewerId } };
}

function crossReviewerDuplicateReviewerIds(results: readonly { readonly reviewerId: string; readonly findings: readonly unknown[] }[]): ReadonlySet<string> {
  const reviewersByFindingId = new Map<string, Set<string>>();
  for (const result of results) {
    for (const finding of result.findings) {
      if (!isRecord(finding) || !hasText(finding.findingId)) continue;
      const reviewers = reviewersByFindingId.get(finding.findingId);
      if (reviewers) reviewers.add(result.reviewerId);
      else reviewersByFindingId.set(finding.findingId, new Set([result.reviewerId]));
    }
  }
  return new Set(
    [...reviewersByFindingId.values()]
      .filter((reviewers) => reviewers.size > 1)
      .flatMap((reviewers) => [...reviewers])
  );
}

function isProjectOutput(value: unknown): value is { readonly code: 'project-improvement' } {
  return isRecord(value) && value.code === 'project-improvement';
}

function isLegacyFinding(value: unknown): value is Omit<OrchestratorFinding, 'reviewerId'> {
  return isRecord(value)
    && hasText(value.findingId)
    && hasText(value.rootCauseId)
    && hasText(value.recommendation);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function compareServiceDiagnostics(left: ReviewServiceDiagnostic, right: ReviewServiceDiagnostic): number {
  return compareText(left.code, right.code)
    || compareText(left.reviewerId ?? '', right.reviewerId ?? '')
    || compareText(left.findingId ?? '', right.findingId ?? '');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
