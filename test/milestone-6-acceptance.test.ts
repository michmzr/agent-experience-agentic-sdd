import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ExperienceService } from '../src/application/experience-service.js';
import { runCli } from '../src/cli.js';
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
    assert.deepEqual(Object.keys(parsed).sort(), ['candidates', 'coverage', 'findings', 'hypotheses', 'unverifiedRepairs', 'verifiedKnowledge', 'version']);
    assert.equal((parsed.candidates as unknown[]).length, 1);
    assert.equal((parsed.unverifiedRepairs as unknown[]).length, 0);
    assert.deepEqual(parsed.coverage, [{
      detector: 'm6-deterministic@1', detectorSetVersion: 'm6-deterministic@1', status: 'completed',
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
  const result = runCli(['analysis', 'report', '--json']);
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout.includes('credential-like-marker'), false);
});
