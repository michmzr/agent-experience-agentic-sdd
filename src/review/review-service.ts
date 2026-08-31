import { basename, dirname, join } from 'node:path';

import type { AgentSource, LessonKind } from '../domain/types.js';
import { CodexSessionAdapter } from './adapters/codex.js';
import { discoverClaudeCodeArtifacts, normalizeClaudeCodeArtifact } from './adapters/claude-code.js';
import { discoverCursorExports, readCursorMarkdownExport } from './adapters/cursor.js';
import type { NormalizedSession } from './contracts.js';
import { createDefaultReviewRuntime, defaultReviewProfile } from './default-reviewers.js';
import { groupReviewFindings, type ReviewFinding as OrchestratorFinding } from './orchestrator.js';
import {
  consolidateProjectReviewFindings,
  isProjectReviewFinding,
  type ProjectReviewDiagnostic
} from './project-improvements.js';
import { createReviewProposals } from './proposals.js';
import { type ReviewRuntime, type ReviewProfile } from './runtime.js';
import { sanitizeForReview } from './sanitizer.js';
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

export interface ReviewSessionDescriptor {
  readonly source: AgentSource;
  readonly id: string;
  readonly location: string;
  readonly repositoryHint?: string;
  readonly repositoryHintVerified?: boolean;
  readonly repositoryIdentity?: string;
  readonly updatedAt?: string;
}

export async function runManualReview(input: ManualReviewInput, dependencies: ManualReviewDependencies = {}) {
  const session = await resolveSelectedSession(input, dependencies);
  const normalized = await loadSession({ ...input, session });
  const artifact = sanitizeForReview(normalized);
  const runtime = dependencies.runtime ?? createDefaultReviewRuntime();
  const run = await runtime.run({ artifact, profile: input.profile ?? defaultReviewProfile, allowExpensiveChecks: input.allowExpensiveChecks });
  const rawFindings = run.results.flatMap((result) => result.findings.map((finding) => ({ reviewerId: result.reviewerId, finding })));
  const projectOutputFindings = rawFindings
    .map(({ finding }) => finding)
    .filter((finding) => finding.code === 'project-improvement');
  const projectFindings = projectOutputFindings.filter(isProjectReviewFinding);
  const malformedProjectDiagnostics = projectOutputFindings
    .filter((finding) => !isProjectReviewFinding(finding))
    .map(invalidProjectFindingDiagnostic);
  const projectReview = consolidateProjectReviewFindings(
    projectFindings,
    new Set(artifact.session.events.map((event) => event.id))
  );
  const projectReviewDiagnostics = [...projectReview.diagnostics, ...malformedProjectDiagnostics].sort(compareProjectReviewDiagnostics);
  const findings = rawFindings.filter(({ finding }) => finding.code !== 'project-improvement').map(({ reviewerId, finding }) => ({
    reviewerId,
    findingId: finding.findingId,
    rootCauseId: finding.rootCauseId,
    recommendation: finding.recommendation
  })) as OrchestratorFinding[];
  const groups = groupReviewFindings(findings);
  const intelligence = createReviewProposals({
    sessionId: artifact.session.sessionId,
    findings: groups.map((group) => ({
      id: group.rootCauseId,
      statement: `Review finding ${group.rootCauseId}`,
      lessonKind: 'successful-workflow' as LessonKind,
      proposal: { category: 'workflow' as const, title: recommendation(group.recommendation) }
    }))
  });
  const projectIntelligence = createReviewProposals({
    sessionId: artifact.session.sessionId,
    findings: projectReview.improvements.map((improvement) => ({
      id: improvement.id,
      statement: `Project improvement ${improvement.rootCauseId}`,
      lessonKind: 'heuristic' as LessonKind,
      proposal: { category: improvement.category, title: improvement.recommendation },
      severity: improvement.severity,
      evidenceEventIds: improvement.evidenceEventIds
    }))
  });
  return {
    source: input.source,
    selectedSession: artifact.session.sessionId,
    profile: run.profile,
    skippedReviewerIds: run.skippedReviewerIds,
    runtimeDiagnostics: run.diagnostics,
    findings: groups,
    projectImprovements: projectReview.improvements,
    projectReviewDiagnostics,
    candidates: [...intelligence.candidates, ...projectIntelligence.candidates],
    proposals: [...intelligence.proposals, ...projectIntelligence.proposals]
  };
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
  return readCursorMarkdownExport({ source: 'cursor', id: basename(input.session, '.md'), location, format: 'markdown-export' }, input.root, new Date(0).toISOString());
}

function recommendation(value: { readonly state: 'agreed'; readonly value: string } | { readonly state: 'unresolved-disagreement'; readonly values: readonly string[] }): string {
  return value.state === 'agreed' ? value.value : value.values.join(' | ');
}

function invalidProjectFindingDiagnostic(value: unknown): ProjectReviewDiagnostic {
  const findingId = isRecord(value) && hasText(value.findingId) ? value.findingId : undefined;
  return findingId ? { code: 'INVALID_PROJECT_FINDING', findingId } : { code: 'INVALID_PROJECT_FINDING' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function compareProjectReviewDiagnostics(left: ProjectReviewDiagnostic, right: ProjectReviewDiagnostic): number {
  return compareText(left.code, right.code) || compareText(left.findingId ?? '', right.findingId ?? '');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
