import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ExperienceService } from '../src/application/experience-service.js';
import { runCli } from '../src/cli.js';
import { DETECTOR_SET_VERSION, OperationalLearningRepository } from '../src/learning/repository.js';
import { OperationalLearningService } from '../src/learning/service.js';
import { ExperienceStore } from '../src/storage/experience-store.js';

test('reports scoped convention candidates and a privacy-bounded analysis shape', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-m6-acceptance-'));
  const root = mkdtempSync(join(tmpdir(), 'ael-m6-repository-'));
  try {
    writeFileSync(join(root, 'AGENTS.md'), 'Use pnpm instead of npm\ncredential-like-marker=never-persist\n');
    const application = new ExperienceService({ dataDir });
    application.initRepository({ id: 'repo-1', root, sources: ['codex'], observedAt: '2026-09-08T10:00:00.000Z' });
    const databasePath = join(dataDir, 'experience.sqlite');
    const store = new ExperienceStore(databasePath);
    try {
      store.appendIncremental({ session: { id: 'session-1' as never, source: 'codex', startedAt: '2026-09-08T10:00:00.000Z', repositoryId: 'repo-1' as never } });
    } finally { store.close(); }
    const learning = new OperationalLearningService(databasePath);
    learning.enqueueCommittedSession('repo-1', 'session-1');

    const run = runCli(['analysis', 'run', '--repository-id', 'repo-1', '--data-dir', dataDir, '--json']);
    assert.equal(run.exitCode, 0);
    assert.equal(JSON.parse(run.stdout).status, 'completed');

    const report = runCli(['analysis', 'report', '--repository-id', 'repo-1', '--data-dir', dataDir, '--json']);
    assert.equal(report.exitCode, 0);
    const parsed = JSON.parse(report.stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed).sort(), ['candidates', 'cost', 'coverage', 'findings', 'hypotheses', 'unverifiedRepairs', 'verifiedKnowledge', 'version']);
    assert.deepEqual(parsed.cost, { completedRuns: 1, total: 0 });
    assert.equal((parsed.candidates as unknown[]).length, 1);
    assert.equal((parsed.unverifiedRepairs as unknown[]).length, 0);
    assert.deepEqual(parsed.coverage, [{
      detector: DETECTOR_SET_VERSION, detectorSetVersion: DETECTOR_SET_VERSION, status: 'completed',
      inputLowWater: 0, requestedHighWater: 0, processedHighWater: 0, examinedEvents: 0, findings: 0
    }]);
    assert.equal(report.stdout.includes('credential-like-marker'), false);

    const isolated = runCli(['analysis', 'report', '--repository-id', 'repo-2', '--data-dir', dataDir, '--json']);
    assert.equal(isolated.exitCode, 0);
    assert.equal((JSON.parse(isolated.stdout) as { candidates: unknown[] }).candidates.length, 0);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects an analysis command without repository selection', () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'ael-m6-no-context-'));
  try {
    const result = runCli(['analysis', 'report', '--json'], { workingDirectory });
    assert.equal(result.exitCode, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'CONTEXT_REQUIRED');
    assert.equal(result.stdout.includes('credential-like-marker'), false);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test('exposes report-safe typed evidence and episodes through the versioned analysis report', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-typed-analysis-report-'));
  try {
    const learning = new OperationalLearningRepository(join(dataDir, 'experience.sqlite'));
    learning.enqueue({ repositoryId: 'repo-typed', sessionId: 'session-typed', inputHighWater: 1 });
    const job = learning.claim({ ownerId: 'typed-report', leaseMs: 60_000 })!;
    learning.acknowledge(job.id, { ownerId: 'typed-report', attempt: job.attempts,
      processedHighWater: job.inputHighWater, checkpoint: { version: 1, pendingEvents: [] },
      metrics: { eventsLoaded: 1, findings: 0, elapsedMs: 0 }, result: {
      episodeEvidence: [{ id: 'semantic-closure', kind: 'task-transition', state: 'closed', decisionKey: 'release-approval', scopeKey: 'production-rollout', evidenceIds: ['semantic-closure'] }],
      episodes: [{ id: 'semantic-gap', kind: 'verification-gap', repositoryId: 'repo-typed', sessionId: 'session-typed', detector: 'm9-typed-evidence@1', state: 'unresolved', evidenceEventIds: ['semantic-closure'], closureEvidenceId: 'semantic-closure', criterionState: 'unknown' }],
      findings: [], candidates: []
    } });
    learning.close();

    const result = runCli(['analysis', 'report', '--repository-id', 'repo-typed', '--schema-version', '2', '--data-dir', dataDir, '--json']);
    assert.equal(result.exitCode, 0);
    const report = JSON.parse(result.stdout) as { typed: { evidence: Array<{ id: string }>; episodes: Array<{ kind: string; closureEvidenceId?: string }> } };
    assert.equal(report.typed.episodes[0]?.kind, 'verification-gap');
    assert.equal(report.typed.episodes[0]?.closureEvidenceId, report.typed.evidence[0]?.id);
    assert.equal(result.stdout.includes('semantic-closure'), false);
    assert.equal(result.stdout.includes('release-approval'), false);
    assert.equal(result.stdout.includes('production-rollout'), false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('keeps the schema-v1 analysis report unchanged when typed rows are present', () => {
  const legacyDataDir = mkdtempSync(join(tmpdir(), 'ael-v1-legacy-report-'));
  const typedDataDir = mkdtempSync(join(tmpdir(), 'ael-v1-typed-report-'));
  try {
    const baseline = seedSchemaV1Report(legacyDataDir, false);
    const withTypedRows = seedSchemaV1Report(typedDataDir, true);
    assert.equal(withTypedRows, baseline);
  } finally {
    rmSync(legacyDataDir, { recursive: true, force: true });
    rmSync(typedDataDir, { recursive: true, force: true });
  }
});

function seedSchemaV1Report(dataDir: string, includeTypedRows: boolean): string {
  const learning = new OperationalLearningRepository(join(dataDir, 'experience.sqlite'));
  try {
    learning.enqueue({ repositoryId: 'repo-v1', sessionId: 'session-v1', inputHighWater: 1 });
    const job = learning.claim({ ownerId: 'schema-v1-report', leaseMs: 60_000 })!;
    learning.acknowledge(job.id, { ownerId: 'schema-v1-report', attempt: job.attempts,
      processedHighWater: job.inputHighWater, checkpoint: { version: 1, pendingEvents: [] },
      metrics: { eventsLoaded: 1, findings: 0, elapsedMs: 0 }, result: {
      episodes: [{ id: 'legacy-episode', repositoryId: 'repo-v1', sessionId: 'session-v1', detector: 'm6-deterministic@1', state: 'outcome-observed', evidenceEventIds: ['legacy-event'], hypothesis: 'Legacy hypothesis.' }, ...(includeTypedRows ? [{ id: 'typed-correction', kind: 'correction' as const, repositoryId: 'repo-v1', sessionId: 'session-v1', detector: 'm9-typed-evidence@1', state: 'outcome-observed' as const, evidenceEventIds: ['typed-original', 'typed-changed', 'typed-outcome'], originalDecisionEvidenceId: 'typed-original', changedDecisionEvidenceId: 'typed-changed', outcomeEvidenceId: 'typed-outcome' }] : [])],
      episodeEvidence: includeTypedRows ? [
        { id: 'typed-original', kind: 'tool-request' as const, state: 'observed' as const, decisionKey: 'typed-decision', scopeKey: 'typed-scope', evidenceIds: ['typed-original'] },
        { id: 'typed-changed', kind: 'tool-request' as const, state: 'succeeded' as const, decisionKey: 'typed-decision', scopeKey: 'typed-scope', evidenceIds: ['typed-original'] },
        { id: 'typed-outcome', kind: 'tool-result' as const, state: 'succeeded' as const, decisionKey: 'typed-decision', scopeKey: 'typed-scope', evidenceIds: ['typed-changed'] }
      ] : [],
      findings: [], candidates: []
    } });
  } finally { learning.close(); }
  const report = runCli(['analysis', 'report', '--repository-id', 'repo-v1', '--data-dir', dataDir, '--json']);
  assert.equal(report.exitCode, 0);
  return report.stdout;
}
