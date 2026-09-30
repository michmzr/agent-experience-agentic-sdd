import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AdvisoryConfigurationStore } from '../src/advice/configuration.js';
import { AdvisoryUsageStore } from '../src/advice/usage.js';
import { runCli } from '../src/cli.js';
import { CandidateRepository } from '../src/knowledge/candidate-repository.js';
import { resolveRepository } from '../src/repository/local-repository.js';
import { initializeGitRepository } from './helpers/git-repository.js';

test('AAP-A1 advice is default-off and explicit repository revocation survives restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-advice-config-'));
  const path = join(root, 'advice.sqlite');
  try {
    const first = new AdvisoryConfigurationStore(path);
    assert.deepEqual(first.status('repo-a'), { enabled: false });
    assert.equal(existsSync(path), false);
    assert.deepEqual(first.setEnabled('repo-a', true), { enabled: true });
    assert.deepEqual(first.status('repo-b'), { enabled: false });
    const reopened = new AdvisoryConfigurationStore(path);
    assert.deepEqual(reopened.status('repo-a'), { enabled: true });
    assert.deepEqual(reopened.setEnabled('repo-a', false), { enabled: false });
    assert.deepEqual(new AdvisoryConfigurationStore(path).status('repo-a'), { enabled: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AAP-A2 public retrieval reads only verified fresh knowledge in its actual repository scope', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-advice-retrieve-'));
  const repositoryRoot = join(root, 'repo');
  const dataDir = join(root, 'data');
  mkdirSync(repositoryRoot); mkdirSync(dataDir); initializeGitRepository(repositoryRoot);
  const repositoryId = resolveRepository(repositoryRoot)!.id;
  const database = new CandidateRepository(join(dataDir, 'experience.sqlite'));
  try {
    const candidate = database.register({ repositoryId, kind: 'convention', statement: 'Run the scoped search command first.',
      applicability: { scope: 'subproject', path: 'packages/app', conditions: ['task:change'] },
      propositionKey: 'search-first', procedureKey: 'search', originId: 'session-a', source: 'manual-review' });
    const review = { repositoryId, candidateId: candidate.id, actorId: 'reviewer', reviewedAt: '2026-09-30T10:00:00.000Z' };
    database.review({ ...review, target: 'observed', evidenceId: 'observed-a' },
      { id: 'observed-a', repositoryId, originId: 'session-a', kind: 'observation' });
    database.review({ ...review, target: 'confirmed', evidenceId: 'confirmed-b' },
      { id: 'confirmed-b', repositoryId, originId: 'session-b', kind: 'observation' });
    database.review({ ...review, target: 'verified', evidenceId: 'verified-c' },
      { id: 'verified-c', repositoryId, originId: 'session-c', kind: 'instruction-context',
        contextRevision: 'agents-sha256:abc', operationSignature: 'operation:v1:search' });
    assert.equal(runCli(['advice', 'configure', '--repository-id', repositoryId, '--enabled', 'true',
      '--data-dir', dataDir, '--json']).exitCode, 0);
    const inputPath = join(root, 'context.json');
    const context = { repositoryId, sessionId: 'session-b', subproject: 'packages/app',
      operationSignature: 'operation:v1:search', contextRevision: 'agents-sha256:abc',
      conditions: ['task:change'], retrievalRef: 'cli-call-b' };
    const retrieve = (value: typeof context) => {
      writeFileSync(inputPath, JSON.stringify(value));
      return runCli(['advice', 'retrieve', '--input', inputPath, '--data-dir', dataDir, '--json'],
        { workingDirectory: repositoryRoot });
    };
    const first = JSON.parse(retrieve(context).stdout);
    assert.equal(first.entries.length, 1);
    const bundleId = first.entries[0].bundleId as string;
    assert.deepEqual(new AdvisoryUsageStore(join(dataDir, 'advice.sqlite')).facts(bundleId).map(fact => fact.kind), ['retrieved']);
    assert.equal(JSON.parse(retrieve({ ...context, subproject: 'packages/other' }).stdout).entries.length, 0);
    assert.equal(JSON.parse(retrieve({ ...context, contextRevision: 'agents-sha256:old' }).stdout).entries.length, 0);
    assert.equal(JSON.parse(retrieve({ ...context, repositoryId: 'other-repo' }).stdout).entries.length, 0);
    assert.equal(runCli(['advice', 'configure', '--repository-id', repositoryId, '--enabled', 'false',
      '--data-dir', dataDir, '--json']).exitCode, 0);
    assert.equal(JSON.parse(retrieve(context).stdout).entries.length, 0);
    assert.deepEqual(new AdvisoryUsageStore(join(dataDir, 'advice.sqlite')).facts(bundleId).map(fact => fact.kind), ['retrieved']);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test('AAP-A1 public CLI configures only explicit repository advice and revokes after restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-advice-cli-'));
  try {
    const invoke = (...args: string[]) => runCli(['advice', ...args, '--data-dir', root, '--json']);
    assert.equal(JSON.parse(invoke('status', '--repository-id', 'repo-a').stdout).enabled, false);
    assert.equal(JSON.parse(invoke('configure', '--repository-id', 'repo-a', '--enabled', 'true').stdout).enabled, true);
    assert.equal(JSON.parse(invoke('status', '--repository-id', 'repo-b').stdout).enabled, false);
    assert.equal(JSON.parse(invoke('configure', '--repository-id', 'repo-a', '--enabled', 'false').stdout).enabled, false);
    assert.equal(JSON.parse(invoke('status', '--repository-id', 'repo-a').stdout).enabled, false);
    assert.equal(invoke('configure', '--repository-id', 'repo-a', '--enabled', 'yes').exitCode, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
