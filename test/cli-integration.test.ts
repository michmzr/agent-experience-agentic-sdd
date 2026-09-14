import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { runCli } from '../src/cli.js';
import { ExperienceService } from '../src/application/experience-service.js';
import type { SessionId } from '../src/domain/types.js';
import { OperationalLearningRepository } from '../src/learning/repository.js';
import { ExperienceStore } from '../src/storage/experience-store.js';
import { initializeDiagnosticWorkspace, resolveDiagnosticScope } from '../src/capture/diagnostic-scope.js';
import { CaptureDiagnosticStore } from '../src/storage/capture-diagnostic-store.js';
import { initializeGitRepository } from './helpers/git-repository.js';

const fixture = (name: string) => join(process.cwd(), 'test', 'fixtures', name);

test('imports, validates, lists, inspects, retrieves, and exports a fixture', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-cli-'));
  const repository = mkdtempSync(join(tmpdir(), 'ael-export-'));
  try {
    assert.equal(runCli(['init', '--scope', 'global', '--data-dir', dataDir]).exitCode, 0);
    assert.equal(runCli(['experience', 'add', '--input', fixture('positive-workflow.json'), '--data-dir', dataDir]).exitCode, 0);
    assert.equal(runCli(['validate', '--json', '--data-dir', dataDir]).exitCode, 0);
    assert.match(runCli(['lessons', 'list', '--json', '--data-dir', dataDir]).stdout, /knowledge-1/);
    assert.match(runCli(['inspect', 'knowledge-1', '--json', '--data-dir', dataDir]).stdout, /knowledge-1/);
    assert.match(runCli(['retrieve', '--scope', 'repo', '--repository-id', 'repo-a', '--path', 'src/a.ts', '--tool', 'git', '--tag', 'safety', '--json', '--data-dir', dataDir]).stdout, /knowledge-1/);
    const exported = runCli(['export', '--scope', 'repo', '--repository-id', 'repo-a', '--json', '--data-dir', dataDir]);
    assert.equal(exported.exitCode, 0);
    assert.match(exported.stdout, /knowledge-1/);
    assert.equal(readFileSync(join(dataDir, 'experience.sqlite')).length > 0, true);
    assert.equal(repository.length > 0, true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test('reports the same path-free workspace diagnostic scope through both CLI forms', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ael-diagnostic-workspace-'));
  const alias = `${workspace}-alias`;
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-diagnostic-data-'));
  try {
    const scope = initializeDiagnosticWorkspace(workspace, 'workspace-diagnostics');
    const store = new CaptureDiagnosticStore(join(dataDir, 'capture-diagnostics.sqlite'));
    store.increment({ source: 'cursor', scope }, 'unsafe-command-shape');
    store.close();
    symlinkSync(workspace, alias, 'dir');

    const automatic = runCli(['hooks', 'diagnostics', '--data-dir', dataDir, '--json'], { workingDirectory: workspace });
    const explicit = runCli(['hooks', 'diagnostics', '--repository', alias, '--data-dir', dataDir, '--json'], { workingDirectory: workspace });
    const inspection = runCli(['experience', 'inspect', '--data-dir', dataDir, '--json'], { workingDirectory: workspace });
    assert.equal(automatic.exitCode, 0, automatic.stderr);
    assert.deepEqual(JSON.parse(explicit.stdout), JSON.parse(automatic.stdout));
    assert.deepEqual(JSON.parse(inspection.stdout), JSON.parse(automatic.stdout));
    assert.deepEqual(JSON.parse(automatic.stdout), {
      version: 1,
      source: 'cursor',
      scope: { kind: 'workspace', id: 'workspace-diagnostics' },
      counts: { 'invalid-working-directory': 0, 'persistence-failure': 0, 'unsafe-command-shape': 1, 'unsupported-tool': 0 }
    });
    assert.equal(automatic.stdout.includes(workspace), false);
    assert.match(runCli(['hooks', 'diagnostics', '--data-dir', dataDir], { workingDirectory: workspace }).stdout, /Scope: workspace workspace-diagnostics/);
    assert.deepEqual(resolveDiagnosticScope(alias), scope);
  } finally {
    rmSync(alias, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('retains an existing nested workspace scope after Git initialization', () => {
  const repository = mkdtempSync(join(tmpdir(), 'ael-diagnostic-repository-'));
  const workspace = join(repository, 'workspace');
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-diagnostic-data-'));
  try {
    mkdirSync(workspace);
    const scope = initializeDiagnosticWorkspace(workspace, 'nested-workspace');
    initializeGitRepository(repository);
    const store = new CaptureDiagnosticStore(join(dataDir, 'capture-diagnostics.sqlite'));
    store.increment({ source: 'cursor', scope }, 'invalid-working-directory');
    store.close();

    const report = runCli(['hooks', 'diagnostics', '--data-dir', dataDir, '--json'], { workingDirectory: workspace });
    assert.equal(report.exitCode, 0, report.stderr);
    assert.deepEqual(JSON.parse(report.stdout).scope, { kind: 'workspace', id: 'nested-workspace' });
  } finally {
    rmSync(repository, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('returns JSON diagnostics and leaves data unchanged for corrupt input', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-cli-'));
  const corrupt = join(dataDir, 'corrupt.json');
  try {
    assert.equal(runCli(['experience', 'add', '--input', fixture('positive-workflow.json'), '--data-dir', dataDir]).exitCode, 0);
    const before = runCli(['lessons', 'list', '--json', '--data-dir', dataDir]).stdout;
    writeFileSync(corrupt, JSON.stringify({ ...JSON.parse(readFileSync(fixture('positive-workflow.json'), 'utf8')), observations: [{ id: 'observation-bad', eventIds: ['missing-event'], statement: 'Broken reference.' }] }));

    const result = runCli(['experience', 'add', '--input', corrupt, '--json', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(JSON.parse(result.stdout), { error: { code: 'MISSING_REFERENCE', message: 'Observation references a missing event.' } });
    assert.equal(runCli(['lessons', 'list', '--json', '--data-dir', dataDir]).stdout, before);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('persists contradictory fixture evidence as a disputed lifecycle transition instead of accepting its claimed verified state', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-cli-'));
  try {
    assert.equal(runCli(['experience', 'add', '--input', fixture('contradiction.json'), '--data-dir', dataDir]).exitCode, 0);

    const persisted = JSON.parse(runCli(['inspect', 'knowledge-contradiction', '--json', '--data-dir', dataDir]).stdout);
    assert.equal(persisted.state, 'disputed');

    const database = new DatabaseSync(join(dataDir, 'experience.sqlite'));
    const history = database.prepare('SELECT from_state, to_state, evidence_id FROM knowledge_transition_history WHERE knowledge_id = ? ORDER BY id').all('knowledge-contradiction').map((row) => ({ ...row }));
    database.close();
    assert.deepEqual(history, [{ from_state: 'verified', to_state: 'disputed', evidence_id: 'evidence-contradiction' }]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('keeps fixture scope, authority, lifecycle, and serialization deterministic', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-cli-'));
  try {
    for (const name of ['positive-workflow.json', 'negative-failure.json', 'contradiction.json', 'unapproved-global.json', 'scope-isolation.json', 'deterministic-order.json']) {
      assert.equal(runCli(['experience', 'add', '--input', fixture(name), '--data-dir', dataDir]).exitCode, 0);
    }
    const repositoryA = JSON.parse(runCli(['retrieve', '--scope', 'repo', '--repository-id', 'repo-a', '--json', '--data-dir', dataDir]).stdout);
    assert.deepEqual(repositoryA.map(({ id }: { id: string }) => id), ['knowledge-1']);
    const global = JSON.parse(runCli(['retrieve', '--scope', 'global', '--json', '--data-dir', dataDir]).stdout);
    assert.equal(global.find(({ id }: { id: string }) => id === 'knowledge-global').authoritative, false);
    assert.equal(runCli(['inspect', 'knowledge-contradiction', '--json', '--data-dir', dataDir]).stdout.includes('"disputed"'), true);
    const first = runCli(['lessons', 'list', '--json', '--data-dir', dataDir]).stdout;
    assert.equal(runCli(['lessons', 'list', '--json', '--data-dir', dataDir]).stdout, first);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('accepts the repo scope contract for init, validate, lessons, retrieve, and export', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-cli-'));
  try {
    assert.equal(runCli(['init', '--scope', 'global', '--data-dir', dataDir]).exitCode, 0);
    assert.equal(runCli(['experience', 'add', '--input', fixture('positive-workflow.json'), '--data-dir', dataDir]).exitCode, 0);
    assert.equal(runCli(['validate', '--scope', 'repo', '--data-dir', dataDir]).exitCode, 0);
    assert.equal(runCli(['lessons', 'list', '--scope', 'repo', '--json', '--data-dir', dataDir]).exitCode, 0);
    assert.equal(runCli(['retrieve', '--scope', 'repo', '--repository-id', 'repo-a', '--json', '--data-dir', dataDir]).exitCode, 0);
    assert.equal(runCli(['export', '--scope', 'repo', '--repository-id', 'repo-a', '--json', '--data-dir', dataDir]).exitCode, 0);
    assert.equal(runCli(['lessons', 'list', '--scope', 'repository', '--data-dir', dataDir]).exitCode, 2);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('exposes the package bin as an executable compiled CLI', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-bin-'));
  try {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    assert.equal(packageJson.bin.ael, './dist/src/cli.js');
    assert.equal(readFileSync(join(process.cwd(), packageJson.bin.ael), 'utf8').startsWith('#!/usr/bin/env node\n'), true);
    const output = execFileSync(process.execPath, [join(process.cwd(), packageJson.bin.ael), 'init', '--scope', 'global', '--data-dir', dataDir], { encoding: 'utf8' });
    assert.match(output, /^Initialized local experience store at /);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('compiled watchdog isolates worker-child and completes a slot-linked analysis claim', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-worker-cli-'));
  const root = mkdtempSync(join(tmpdir(), 'ael-worker-repository-'));
  const databasePath = join(dataDir, 'experience.sqlite');
  try {
    writeFileSync(join(root, 'AGENTS.md'), 'Use pnpm instead of npm.\n');
    const store = new ExperienceStore(databasePath);
    store.registerRepository({ id: 'repo-1', root, observedAt: new Date().toISOString() });
    store.appendIncremental({ session: { id: 'session-1' as SessionId, source: 'codex',
      startedAt: new Date().toISOString(), repositoryId: 'repo-1' as never } });
    store.appendIncremental({ session: { id: 'session-2' as SessionId, source: 'codex',
      startedAt: new Date(Date.now() + 1).toISOString(), repositoryId: 'repo-1' as never } });
    store.close();
    const repository = new OperationalLearningRepository(databasePath);
    repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-1', inputHighWater: 0 });
    repository.enqueue({ repositoryId: 'repo-1', sessionId: 'session-2', inputHighWater: 0 });
    const coordinator = repository.acquireCoordinatorLease({ ownerId: 'coordinator', leaseMs: 60_000 })!;
    const slot = repository.reserveWorkerSlot({ ...coordinator, leaseMs: 45_000, maxProcesses: 1 })!;
    assert.equal(repository.status().activeRunningCount, 1, 'unclaimed live slot is visible in status');
    repository.close();

    const executable = join(process.cwd(), 'dist', 'src', 'cli.js');
    const result = spawnSync(process.execPath, [executable, 'analysis', 'worker-watchdog', '--data-dir', dataDir,
      '--worker-slot-id', slot.slotId, '--worker-slot-owner', slot.ownerId,
      '--worker-slot-attempt', String(slot.attempt)], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(new ExperienceService({ dataDir }).operationalAnalysisReport('repo-1').candidates.length, 1);
    const status = JSON.parse(spawnSync(process.execPath, [executable, 'analysis', 'status', '--data-dir', dataDir, '--json'],
      { encoding: 'utf8' }).stdout);
    assert.equal(status.jobs.completed, 1);
    assert.equal(status.jobs.pending, 1, 'worker-child performs exactly one runNext operation');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('compiled watchdog and worker-child failures are nonzero, quiet, bounded, and private', () => {
  const marker = 'private-worker-owner';
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-worker-failure-'));
  try {
    const executable = join(process.cwd(), 'dist', 'src', 'cli.js');
    for (const command of ['worker-watchdog', 'worker-child']) {
      const result = spawnSync(process.execPath, [executable, 'analysis', command, '--data-dir', dataDir,
        '--worker-slot-id', '00000000-0000-4000-8000-000000000000', '--worker-slot-owner', marker,
        '--worker-slot-attempt', '1'], { encoding: 'utf8', timeout: 5_000 });
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^ANALYSIS_WORKER_(?:FAILED|ERROR): Analysis worker failed\.\n$/);
      assert.equal(result.stderr.includes(marker), false);
    }
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('compiled coordinator loads global settings, waits for idle timeout, and emits no routine output', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-coordinator-cli-'));
  try {
    writeFileSync(join(dataDir, 'analysis-worker.json'), JSON.stringify({ version: 1, maxProcesses: 3, idleTimeoutMs: 1_000 }));
    const executable = join(process.cwd(), 'dist', 'src', 'cli.js');
    const result = spawnSync(process.execPath, [executable, 'analysis', 'worker', '--data-dir', dataDir],
      { encoding: 'utf8', timeout: 5_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('runs the declared development script and an installed package bin', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-development-'));
  const packageDirectory = mkdtempSync(join(tmpdir(), 'ael-package-'));
  const installDirectory = mkdtempSync(join(tmpdir(), 'ael-install-'));
  const repository = mkdtempSync(join(tmpdir(), 'ael-package-repository-'));
  try {
    const developmentOutput = execFileSync('pnpm', ['run', 'ael', '--', 'init', '--scope', 'global', '--data-dir', dataDir], { cwd: process.cwd(), encoding: 'utf8' });
    assert.match(developmentOutput, /^Initialized local experience store at /m);

    execFileSync('pnpm', ['pack', '--pack-destination', packageDirectory], { cwd: process.cwd(), encoding: 'utf8' });
    const tarball = join(packageDirectory, readdirSync(packageDirectory).find((name) => name.endsWith('.tgz'))!);
    writeFileSync(join(installDirectory, 'package.json'), JSON.stringify({ private: true, dependencies: { 'agent-experience-layer': `file:${tarball}` } }));
    execFileSync('pnpm', ['install', '--offline', '--ignore-scripts'], { cwd: installDirectory, encoding: 'utf8' });

    const executable = join(installDirectory, 'node_modules', '.bin', 'ael');
    const help = spawnSync(executable, ['--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /^Usage: ael /);
    const invalid = spawnSync(executable, ['invalid-command'], { encoding: 'utf8' });
    assert.equal(invalid.status, 2, `${invalid.stdout}\n${invalid.stderr}`);
    assert.match(invalid.stderr, /Unknown command/);
    assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: repository }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.email', 'tests@example.invalid'], { cwd: repository }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.name', 'AEL tests'], { cwd: repository }).status, 0);
    assert.equal(spawnSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: repository }).status, 0);
    const initialized = spawnSync(executable, ['init', '--scope', 'repo', '--hooks', 'cursor', '--data-dir', dataDir, '--json'], { cwd: repository, encoding: 'utf8' });
    assert.equal(initialized.status, 0, `${initialized.stdout}\n${initialized.stderr}`);
    const status = spawnSync(executable, ['status', '--data-dir', dataDir, '--json'], { cwd: repository, encoding: 'utf8' });
    assert.equal(status.status, 0, `${status.stdout}\n${status.stderr}`);
    assert.match(status.stdout, /"status":"ready"/);
    const skillInstall = spawnSync(executable, ['skill', 'install', '--scope', 'workspace', '--workspace', repository, '--json'], { encoding: 'utf8' });
    assert.equal(skillInstall.status, 0, `${skillInstall.stdout}\n${skillInstall.stderr}`);
    assert.match(skillInstall.stdout, /"status":"installed"/);
    assert.equal(existsSync(join(repository, '.agents', 'skills', 'ael', 'SKILL.md')), true);
    const skillStatus = spawnSync(executable, ['skill', 'status', '--scope', 'workspace', '--workspace', repository, '--json'], { encoding: 'utf8' });
    assert.equal(skillStatus.status, 0, `${skillStatus.stdout}\n${skillStatus.stderr}`);
    assert.match(skillStatus.stdout, /"status":"current"/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(packageDirectory, { recursive: true, force: true });
    rmSync(installDirectory, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test('renders deterministic command-specific human success output', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-human-'));
  try {
    assert.match(runCli(['init', '--scope', 'global', '--data-dir', dataDir]).stdout, /^Initialized local experience store at /);
    assert.equal(runCli(['experience', 'add', '--input', fixture('positive-workflow.json'), '--data-dir', dataDir]).stdout, 'Imported 1 knowledge entry.\n');
    assert.equal(runCli(['validate', '--data-dir', dataDir]).stdout, 'Validation passed.\n');
    assert.equal(runCli(['inspect', 'knowledge-1', '--data-dir', dataDir]).stdout, 'knowledge-1 [verified]\nUse the reviewed workflow for safety-sensitive changes.\nEvidence: evidence-1\n');
    assert.equal(runCli(['lessons', 'list', '--data-dir', dataDir]).stdout, 'knowledge-1 [verified] [authoritative]\nUse the reviewed workflow for safety-sensitive changes.\n');
    assert.equal(runCli(['retrieve', '--scope', 'repo', '--repository-id', 'repo-a', '--data-dir', dataDir]).stdout, 'knowledge-1 [verified] [authoritative]\nUse the reviewed workflow for safety-sensitive changes.\n');
    assert.equal(runCli(['export', '--scope', 'repo', '--repository-id', 'repo-a', '--data-dir', dataDir]).stdout, 'Exported 1 knowledge entry.\nknowledge-1 [verified] [authoritative]\nUse the reviewed workflow for safety-sensitive changes.\n');
    assert.match(runCli(['inspect', 'knowledge-1', '--json', '--data-dir', dataDir]).stdout, /^\{"id":"knowledge-1"/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
