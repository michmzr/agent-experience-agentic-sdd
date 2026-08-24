import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { runCli } from '../src/cli.js';

const fixture = (name: string) => join(process.cwd(), 'test', 'fixtures', name);

test('imports, validates, lists, inspects, retrieves, and exports a fixture', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-cli-'));
  const repository = mkdtempSync(join(tmpdir(), 'ael-export-'));
  try {
    assert.equal(runCli(['init', '--data-dir', dataDir]).exitCode, 0);
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
    assert.equal(runCli(['init', '--scope', 'repo', '--data-dir', dataDir]).exitCode, 0);
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
    const output = execFileSync(process.execPath, [join(process.cwd(), packageJson.bin.ael), 'init', '--data-dir', dataDir], { encoding: 'utf8' });
    assert.match(output, /^Initialized local experience store at /);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('runs the declared development script and an installed package bin', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-development-'));
  const packageDirectory = mkdtempSync(join(tmpdir(), 'ael-package-'));
  const installDirectory = mkdtempSync(join(tmpdir(), 'ael-install-'));
  try {
    const developmentOutput = execFileSync('pnpm', ['run', 'ael', '--', 'init', '--data-dir', dataDir], { cwd: process.cwd(), encoding: 'utf8' });
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
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(packageDirectory, { recursive: true, force: true });
    rmSync(installDirectory, { recursive: true, force: true });
  }
});

test('renders deterministic command-specific human success output', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ael-human-'));
  try {
    assert.match(runCli(['init', '--data-dir', dataDir]).stdout, /^Initialized local experience store at /);
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
