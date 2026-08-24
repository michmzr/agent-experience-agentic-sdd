import { basename, join } from 'node:path';

import type { AgentSource, LessonKind } from '../domain/types.js';
import { CodexSessionAdapter } from './adapters/codex.js';
import { discoverClaudeCodeArtifacts, normalizeClaudeCodeArtifact } from './adapters/claude-code.js';
import { discoverCursorExports, readCursorMarkdownExport } from './adapters/cursor.js';
import type { NormalizedSession } from './contracts.js';
import { groupReviewFindings, type ReviewFinding as OrchestratorFinding } from './orchestrator.js';
import { createReviewProposals } from './proposals.js';
import { ReviewRuntime, type Reviewer, type ReviewProfile } from './runtime.js';
import { sanitizeForReview } from './sanitizer.js';

export interface ManualReviewInput {
  readonly source: AgentSource;
  readonly root: string;
  readonly session: string;
  readonly project?: string;
  readonly allowExpensiveChecks: boolean;
  readonly profile?: Pick<ReviewProfile, 'id' | 'version'>;
}

export interface ManualReviewDependencies {
  readonly runtime?: Pick<ReviewRuntime, 'run'>;
}

export interface ReviewSessionDescriptor { readonly source: AgentSource; readonly id: string; readonly location: string; }

export async function runManualReview(input: ManualReviewInput, dependencies: ManualReviewDependencies = {}) {
  const normalized = await loadSession(input);
  const artifact = sanitizeForReview(normalized);
  const runtime = dependencies.runtime ?? createDefaultReviewRuntime();
  const run = await runtime.run({ artifact, profile: input.profile ?? defaultReviewProfile, allowExpensiveChecks: input.allowExpensiveChecks });
  const findings = run.results.flatMap((result) => result.findings.map((finding) => ({
    reviewerId: result.reviewerId,
    findingId: finding.findingId,
    rootCauseId: finding.rootCauseId,
    recommendation: finding.recommendation
  }))) as OrchestratorFinding[];
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
  return { source: input.source, selectedSession: artifact.session.sessionId, profile: run.profile, skippedReviewerIds: run.skippedReviewerIds, findings: groups, ...intelligence };
}

export const defaultReviewProfile: Pick<ReviewProfile, 'id' | 'version'> = Object.freeze({ id: 'default', version: '1' });

export function createDefaultReviewRuntime(): ReviewRuntime {
  const reviewers: Reviewer[] = [reviewer('workflow', false), reviewer('privacy', false), reviewer('diagnostics', true)];
  return new ReviewRuntime({ profiles: [{ ...defaultReviewProfile, reviewerIds: reviewers.map(({ id }) => id) }], reviewers });
}

export async function discoverReviewSessions(input: Pick<ManualReviewInput, 'source' | 'root' | 'project'>): Promise<readonly ReviewSessionDescriptor[]> {
  if (input.source === 'codex') return (await new CodexSessionAdapter(input.root).discover()).map(({ id, location }) => ({ source: input.source, id, location }));
  if (input.source === 'claude-code') {
    if (!input.project) throw new SyntaxError('Option is required: --project.');
    return (await discoverClaudeCodeArtifacts({ configDir: input.root, project: input.project })).map(({ id, location }) => ({ source: input.source, id, location }));
  }
  return discoverCursorExports(input.root).map(({ id, location }) => ({ source: input.source, id: `${id}.md`, location }));
}

async function loadSession(input: ManualReviewInput): Promise<NormalizedSession> {
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

function reviewer(id: string, expensive: boolean): Reviewer {
  return { id, expensive, async review(artifact) {
    const toolEvents = artifact.session.events.filter((event) => event.kind === 'tool');
    if (id === 'workflow') return toolEvents.map((event) => ({ code: `workflow-${event.outcome}`, findingId: `${id}:${event.id}`, rootCauseId: `${event.outcome}-tool:${event.tool ?? 'unknown'}`, recommendation: event.outcome === 'failed' ? `Investigate failed ${event.tool ?? 'unknown'} workflow` : `Reuse ${event.tool ?? 'unknown'} workflow with outcome ${event.outcome}` }));
    if (id === 'privacy') return artifact.session.events.filter((event) => event.kind === 'message' || event.kind === 'metadata').map((event) => ({ code: `review-${event.kind}`, findingId: `${id}:${event.id}`, rootCauseId: `review-evidence:${event.kind}`, recommendation: `Preserve sanitized ${event.kind} evidence for review` }));
    return artifact.session.events.filter((event) => event.outcome === 'failed').map((event) => ({ code: 'diagnostic-failure', findingId: `${id}:${event.id}`, rootCauseId: `diagnostic:${event.tool ?? event.kind}`, recommendation: `Run explicit diagnostics for ${event.tool ?? event.kind}` }));
  } };
}

function recommendation(value: { readonly state: 'agreed'; readonly value: string } | { readonly state: 'unresolved-disagreement'; readonly values: readonly string[] }): string {
  return value.state === 'agreed' ? value.value : value.values.join(' | ');
}
