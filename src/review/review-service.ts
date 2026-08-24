import { basename, join } from 'node:path';

import type { AgentSource, LessonKind } from '../domain/types.js';
import { CodexSessionAdapter } from './adapters/codex.js';
import { discoverClaudeCodeArtifacts, normalizeClaudeCodeArtifact } from './adapters/claude-code.js';
import { readCursorMarkdownExport } from './adapters/cursor.js';
import type { NormalizedSession } from './contracts.js';
import { groupReviewFindings, type ReviewFinding as OrchestratorFinding } from './orchestrator.js';
import { createReviewProposals } from './proposals.js';
import { ReviewRuntime, type Reviewer } from './runtime.js';
import { sanitizeForReview } from './sanitizer.js';

export interface ManualReviewInput {
  readonly source: AgentSource;
  readonly root: string;
  readonly session: string;
  readonly project?: string;
  readonly allowExpensiveChecks: boolean;
}

export async function runManualReview(input: ManualReviewInput) {
  const normalized = await loadSession(input);
  const artifact = sanitizeForReview(normalized);
  const reviewers: Reviewer[] = [reviewer('workflow', false), reviewer('privacy', false), reviewer('diagnostics', true)];
  const runtime = new ReviewRuntime({ profiles: [{ id: 'default', version: '1', reviewerIds: reviewers.map(({ id }) => id) }], reviewers });
  const run = await runtime.run({ artifact, profile: { id: 'default', version: '1' }, allowExpensiveChecks: input.allowExpensiveChecks });
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
  return { source: input.source, profile: run.profile, skippedReviewerIds: run.skippedReviewerIds, findings: groups, ...intelligence };
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
    return [{ code: `${id}-finding`, findingId: `${id}-finding`, rootCauseId: 'review-workflow', recommendation: `Apply ${id} review for ${artifact.session.events.length} events` }];
  } };
}

function recommendation(value: { readonly state: 'agreed'; readonly value: string } | { readonly state: 'unresolved-disagreement'; readonly values: readonly string[] }): string {
  return value.state === 'agreed' ? value.value : value.values.join(' | ');
}
