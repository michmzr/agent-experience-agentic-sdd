import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { CapturedEventRecord } from '../src/capture/contracts.js';
import { detectOperationalEpisodes, type CorrectionEpisode, type VerificationGapEpisode } from '../src/learning/detectors.js';
import { readProjectToolConventions } from '../src/learning/project-conventions.js';
import type { EpisodeEvidence } from '../src/learning/contracts.js';

const at = (second: number) => `2026-09-08T10:00:${String(second).padStart(2, '0')}.000Z`;

function event(input: {
  readonly id: string;
  readonly phase: 'pre-action' | 'post-result';
  readonly action: string;
  readonly arguments?: readonly string[];
  readonly outcome?: 'succeeded' | 'failed' | 'unknown';
  readonly relatedEventId?: string;
  readonly second: number;
}): CapturedEventRecord {
  return {
    id: input.id,
    source: 'codex',
    sourceEventId: input.id,
    sessionId: 'session-1' as never,
    phase: input.phase,
    occurredAt: at(input.second),
    signature: { kind: 'action', tool: 'shell', action: input.action, ...(input.arguments === undefined ? {} : { arguments: input.arguments }) },
    summary: 'Sanitized capture.',
    ...(input.phase === 'post-result' ? { outcome: input.outcome!, relatedEventId: input.relatedEventId!, exitStatus: input.outcome === 'succeeded' ? 0 : 1 } : {})
  };
}

function evidence(input: Omit<EpisodeEvidence, 'evidenceIds'> & { readonly evidenceIds?: readonly string[] }): EpisodeEvidence {
  return { ...input, evidenceIds: input.evidenceIds ?? ['capture-1'] };
}

test('reads only explicit root-scoped pnpm and uv conventions', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-learning-conventions-'));
  writeFileSync(join(root, 'AGENTS.md'), 'Use pnpm instead of npm.\nUse uv instead of pip.\n');
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested', 'AGENTS.md'), 'Use npm instead of pnpm.\n');

  assert.deepEqual(readProjectToolConventions(root).map(({ tool, replaces, source }) => ({ tool, replaces, source })), [
    { tool: 'pnpm', replaces: 'npm', source: 'AGENTS.md:1' },
    { tool: 'uv', replaces: 'pip', source: 'AGENTS.md:2' }
  ]);
});

test('creates a repository-scoped convention candidate from explicit project evidence', () => {
  const result = detectOperationalEpisodes({
    repositoryId: 'repo-1', sessionId: 'session-1', events: [],
    conventions: [{ tool: 'pnpm', replaces: 'npm', source: 'AGENTS.md:1', digest: 'a'.repeat(64) }]
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.kind, 'convention');
  assert.deepEqual(result.candidates[0]?.conditions, ['repository:repo-1', 'when a Node package command is required']);
  assert.equal(result.episodes[0]?.repositoryId, 'repo-1');
});

test('records a repaired command as outcome-observed without source-declared task verification', () => {
  const result = detectOperationalEpisodes({
    repositoryId: 'repo-1', sessionId: 'session-1', conventions: [], events: [
      event({ id: 'npm-request', phase: 'pre-action', action: 'npm', arguments: ['install'], second: 1 }),
      event({ id: 'npm-result', phase: 'post-result', action: 'npm', outcome: 'failed', relatedEventId: 'npm-request', second: 2 }),
      event({ id: 'pnpm-request', phase: 'pre-action', action: 'pnpm', arguments: ['install'], second: 3 }),
      event({ id: 'pnpm-result', phase: 'post-result', action: 'pnpm', outcome: 'succeeded', relatedEventId: 'pnpm-request', second: 4 }),
      event({ id: 'test-request', phase: 'pre-action', action: 'pnpm', arguments: ['test'], second: 5 }),
      event({ id: 'test-result', phase: 'post-result', action: 'pnpm', outcome: 'succeeded', relatedEventId: 'test-request', second: 6 })
    ]
  });

  assert.equal(result.episodes[0]?.state, 'outcome-observed');
  assert.equal(result.candidates.length, 0);
  assert.equal(result.findings.some(({ kind }) => kind === 'ambiguous-repair'), true);
});

test('records ambiguity rather than a repair for unknown, unrelated or privilege-changing commands', () => {
  const result = detectOperationalEpisodes({
    repositoryId: 'repo-1', sessionId: 'session-1', conventions: [], events: [
      event({ id: 'failed-request', phase: 'pre-action', action: 'npm', arguments: ['install'], second: 1 }),
      event({ id: 'failed-result', phase: 'post-result', action: 'npm', outcome: 'failed', relatedEventId: 'failed-request', second: 2 }),
      event({ id: 'unsafe-request', phase: 'pre-action', action: 'sudo', arguments: ['install'], second: 3 }),
      event({ id: 'unsafe-result', phase: 'post-result', action: 'sudo', outcome: 'succeeded', relatedEventId: 'unsafe-request', second: 4 }),
      event({ id: 'unrelated-request', phase: 'pre-action', action: 'git', arguments: ['status'], second: 5 }),
      event({ id: 'unrelated-result', phase: 'post-result', action: 'git', outcome: 'succeeded', relatedEventId: 'unrelated-request', second: 6 })
    ]
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.findings.some(({ kind }) => kind === 'ambiguous-repair'), true);
});

test('derives a linked changed decision as a correction without inventing a reason', () => {
  const result = detectOperationalEpisodes({
    repositoryId: 'repo-1', sessionId: 'session-1', conventions: [], events: [],
    episodeEvidence: [
      evidence({ id: 'liquibase-decision', kind: 'tool-request', state: 'observed', decisionKey: 'schema-update', scopeKey: 'repository' }),
      evidence({ id: 'sql-decision', kind: 'tool-request', state: 'succeeded', decisionKey: 'schema-update', scopeKey: 'repository', evidenceIds: ['liquibase-decision'] })
    ]
  });

  const episode = result.episodes.find((item): item is CorrectionEpisode => item.kind === 'correction');
  assert.equal(episode?.kind, 'correction');
  assert.equal(episode?.originalDecisionEvidenceId, 'liquibase-decision');
  assert.equal(episode?.changedDecisionEvidenceId, 'sql-decision');
  assert.equal(episode?.reasonEvidenceId, undefined);
  assert.equal(result.findings.some(({ kind }) => kind === 'insufficient-evidence'), false);
  assert.equal(result.candidates.length, 0);
});

test('reports insufficient evidence when a changed decision is not linked to its original decision', () => {
  const result = detectOperationalEpisodes({
    repositoryId: 'repo-1', sessionId: 'session-1', conventions: [], events: [],
    episodeEvidence: [
      evidence({ id: 'original-decision', kind: 'tool-request', state: 'observed', decisionKey: 'schema-update', scopeKey: 'repository' }),
      evidence({ id: 'changed-decision', kind: 'tool-request', state: 'succeeded', decisionKey: 'schema-update', scopeKey: 'repository', evidenceIds: ['capture-2'] })
    ]
  });

  assert.equal(result.episodes.some((item) => item.kind === 'correction'), false);
  assert.equal(result.episodes.length, 0);
  assert.equal(result.findings.some(({ kind }) => kind === 'insufficient-evidence'), true);
  assert.equal(result.candidates.length, 0);
});

test('abstains when correction evidence has an incompatible scope', () => {
  const result = detectOperationalEpisodes({
    repositoryId: 'repo-1', sessionId: 'session-1', conventions: [], events: [],
    episodeEvidence: [
      evidence({ id: 'original', kind: 'tool-request', state: 'observed', decisionKey: 'schema-update', scopeKey: 'repository' }),
      evidence({ id: 'changed', kind: 'tool-request', state: 'succeeded', decisionKey: 'schema-update', scopeKey: 'other-repository', evidenceIds: ['original'] })
    ]
  });

  assert.equal(result.episodes.length, 0);
  assert.equal(result.findings.some(({ kind }) => kind === 'insufficient-evidence'), true);
});

test('abstains when a linked correction reason has an incompatible scope', () => {
  const result = detectOperationalEpisodes({
    repositoryId: 'repo-1', sessionId: 'session-1', conventions: [], events: [],
    episodeEvidence: [
      evidence({ id: 'original', kind: 'tool-request', state: 'observed', decisionKey: 'schema-update', scopeKey: 'repository' }),
      evidence({ id: 'changed', kind: 'tool-request', state: 'succeeded', decisionKey: 'schema-update', scopeKey: 'repository', evidenceIds: ['original'] }),
      evidence({ id: 'reason', kind: 'agent-claim', state: 'observed', decisionKey: 'schema-update', scopeKey: 'other-repository', reasonClass: 'superseded', evidenceIds: ['changed'] })
    ]
  });

  assert.equal(result.episodes.length, 0);
  assert.equal(result.findings.some(({ kind }) => kind === 'insufficient-evidence'), true);
});

test('uses a typed-evidence detector version without changing legacy detector records', () => {
  const result = detectOperationalEpisodes({
    repositoryId: 'repo-1', sessionId: 'session-1', conventions: [], events: [],
    episodeEvidence: [evidence({ id: 'closed', kind: 'task-transition', state: 'closed', decisionKey: 'issue-9', scopeKey: 'repository' })]
  });

  assert.equal(result.episodes[0]?.detector, 'm9-typed-evidence@1');
});

test('derives a verification gap for closure with no recorded criterion', () => {
  const result = detectOperationalEpisodes({
    repositoryId: 'repo-1', sessionId: 'session-1', conventions: [], events: [],
    episodeEvidence: [evidence({ id: 'issue-closed', kind: 'task-transition', state: 'closed', decisionKey: 'issue-9', scopeKey: 'repository' })]
  });

  const episode = result.episodes.find((item): item is VerificationGapEpisode => item.kind === 'verification-gap');
  assert.equal(episode?.kind, 'verification-gap');
  assert.equal(episode?.closureEvidenceId, 'issue-closed');
  assert.equal(episode?.criterionState, 'unknown');
});

test('derives repeated acceptance only for a matching decision in the same scope', () => {
  const sameScope = detectOperationalEpisodes({
    repositoryId: 'repo-1', sessionId: 'session-1', conventions: [], events: [],
    episodeEvidence: [
      evidence({ id: 'acceptance-1', kind: 'agent-claim', state: 'succeeded', decisionKey: 'deploy', scopeKey: 'production' }),
      evidence({ id: 'acceptance-2', kind: 'agent-claim', state: 'succeeded', decisionKey: 'deploy', scopeKey: 'production' })
    ]
  });
  const changedScope = detectOperationalEpisodes({
    repositoryId: 'repo-1', sessionId: 'session-1', conventions: [], events: [],
    episodeEvidence: [
      evidence({ id: 'acceptance-a', kind: 'agent-claim', state: 'succeeded', decisionKey: 'deploy', scopeKey: 'staging' }),
      evidence({ id: 'acceptance-b', kind: 'agent-claim', state: 'succeeded', decisionKey: 'deploy', scopeKey: 'production' })
    ]
  });

  assert.equal(sameScope.episodes.some((item) => item.kind === 'repeated-acceptance'), true);
  assert.equal(changedScope.episodes.some((item) => item.kind === 'repeated-acceptance'), false);
});
