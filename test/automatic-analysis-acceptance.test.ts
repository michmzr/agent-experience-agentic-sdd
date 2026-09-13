import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ExperienceService } from '../src/application/experience-service.js';
import { CaptureSpool } from '../src/capture/spool.js';

test('passive capture produces an analysis candidate without a manual analysis run', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-automatic-analysis-'));
  const root = mkdtempSync(join(tmpdir(), 'ael-automatic-analysis-repository-'));
  try {
    writeFileSync(join(root, 'AGENTS.md'), 'Use pnpm instead of npm\n');
    const workerUrl = new URL('../src/learning/worker.js', import.meta.url).href;
    const repositoryUrl = new URL('../src/learning/repository.js', import.meta.url).href;
    const serviceUrl = new URL('../src/learning/service.js', import.meta.url).href;
    let coordinator: ChildProcess | undefined;
    const application = new ExperienceService({
      dataDir,
      scheduleAnalysis({ dataDirectory, onFailure }) {
        try {
          const source = `
            import { join } from 'node:path';
            import { runAnalysisCoordinator } from ${JSON.stringify(workerUrl)};
            import { OperationalLearningRepository } from ${JSON.stringify(repositoryUrl)};
            import { OperationalLearningService } from ${JSON.stringify(serviceUrl)};
            const dataDirectory = ${JSON.stringify(dataDirectory)};
            const databasePath = join(dataDirectory, 'experience.sqlite');
            const repository = new OperationalLearningRepository(databasePath);
            const service = new OperationalLearningService(databasePath);
            try {
              await runAnalysisCoordinator(dataDirectory, { version: 1, maxProcesses: 1, idleTimeoutMs: 1000 }, repository, {
                now: () => Date.now(),
                delay: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
                spawnChild: async () => service.runNext({ ownerId: 'acceptance-child' }).status === 'completed' ? 0 : 1
              }, 'acceptance-coordinator');
            } finally { repository.close(); }
          `;
          coordinator = spawn(process.execPath, ['--input-type=module', '--eval', source], { detached: true, stdio: 'ignore' });
          coordinator.unref();
        } catch { onFailure?.(); }
      }
    });
    application.initRepository({ id: 'repo-1', root, sources: ['codex'], observedAt: '2026-09-13T10:00:00.000Z' });
    const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
    try {
      spool.admit({
        kind: 'session-start',
        session: { id: 'session-1' as never, source: 'codex', startedAt: '2026-09-13T10:00:00.000Z', repositoryId: 'repo-1' as never }
      }, '2026-09-13T10:00:00.000Z');
    } finally { spool.close(); }

    assert.equal(application.captureDrain(() => '2026-09-13T10:00:01.000Z').committed, 1);
    await waitFor(() => application.operationalAnalysisReport('repo-1').candidates.length === 1);
    assert.equal(application.operationalAnalysisReport('repo-1').candidates[0]?.kind, 'convention');
    await waitFor(() => coordinator?.exitCode !== null && coordinator?.exitCode !== undefined);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('Automatic analysis did not produce a candidate before the deadline.');
}
