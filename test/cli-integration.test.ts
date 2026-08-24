import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
