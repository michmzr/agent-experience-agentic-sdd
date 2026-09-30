import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AdvisoryConfigurationStore } from '../src/advice/configuration.js';
import { AdvisoryUsageStore } from '../src/advice/usage.js';
import { runCli } from '../src/cli.js';
import { CandidateRepository } from '../src/knowledge/candidate-repository.js';
import { SqliteCandidateEvidenceResolver } from '../src/knowledge/evidence-resolver.js';
import { normalizeMappedCapture } from '../src/capture/normalization.js';
import { annotationEvidenceId, importTypedEvidence } from '../src/evidence/import.js';
import { ExperienceStore } from '../src/storage/experience-store.js';
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

test('AAP-A3 public record distinguishes agent delivery claim from verified application', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-advice-record-'));
  const repositoryRoot = join(root, 'repo');
  const dataDir = join(root, 'data');
  mkdirSync(repositoryRoot); mkdirSync(dataDir); initializeGitRepository(repositoryRoot);
  const repositoryId = resolveRepository(repositoryRoot)!.id;
  const usage = new AdvisoryUsageStore(join(dataDir, 'advice.sqlite'));
  const scope = { repositoryId, lessonId: 'candidate-1', lessonRevision: '1',
    sessionId: 'session-b', contextRevision: 'agents-sha256:abc' };
  try {
    new AdvisoryConfigurationStore(join(dataDir, 'advice.sqlite')).setEnabled(repositoryId, true);
    const bundle = usage.retrieved({ ...scope, operationSignature: 'operation:v1:search', retrievalRef: 'cli-call-b' });
    const inputPath = join(root, 'usage.json');
    const record = (body: Record<string, unknown>) => {
      writeFileSync(inputPath, JSON.stringify(body));
      return runCli(['advice', 'record', '--input', inputPath, '--data-dir', dataDir, '--json'],
        { workingDirectory: repositoryRoot });
    };
    assert.equal(record({ ...scope, bundleId: bundle.id, kind: 'delivered', origin: 'agent-claim', witnessRef: 'claim-b' }).exitCode, 0);
    assert.equal(record({ ...scope, bundleId: bundle.id, kind: 'selected', origin: 'agent-selection', witnessRef: 'selection-b' }).exitCode, 0);
    assert.deepEqual(usage.facts(bundle.id).map(fact => [fact.kind, fact.origin]), [
      ['retrieved', 'cli-retrieval'], ['delivered', 'agent-claim'], ['selected', 'agent-selection']
    ]);
    assert.equal(record({ ...scope, repositoryId: 'repo-other', bundleId: bundle.id,
      kind: 'applied', origin: 'operation-evidence', witnessRef: 'op-forged' }).exitCode, 1);
    assert.equal(record({ ...scope, bundleId: bundle.id,
      kind: 'applied', origin: 'operation-evidence', witnessRef: 'op-forged' }).exitCode, 1);
    assert.equal(usage.facts(bundle.id).some(fact => fact.kind === 'applied'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AAP-A3 public application and outcome link captured operation to resolved task verification', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-advice-witness-'));
  const repositoryRoot = join(root, 'repo');
  const dataDir = join(root, 'data');
  mkdirSync(repositoryRoot); mkdirSync(dataDir); initializeGitRepository(repositoryRoot);
  const repositoryId = resolveRepository(repositoryRoot)!.id;
  const sessionId = 'session-b' as never;
  const databasePath = join(dataDir, 'experience.sqlite');
  try {
    const store = new ExperienceStore(databasePath);
    store.registerRepository({ id: repositoryId as never, root: repositoryRoot, observedAt: '2026-09-30T10:00:00.000Z' });
    store.appendIncremental({ session: { id: sessionId, source: 'codex', repositoryId: repositoryId as never,
      startedAt: '2026-09-30T10:00:00.000Z' } });
    const request = normalizeMappedCapture({ source: 'codex', sourceEventId: 'operation-b',
      sessionId, phase: 'pre-action', occurredAt: '2026-09-30T10:00:01.000Z',
      tool: 'shell', action: 'install', summary: 'Install dependencies.' });
    const result = normalizeMappedCapture({ source: 'codex', sourceEventId: 'result-b',
      sessionId, phase: 'post-result', relatedEventId: 'operation-b', occurredAt: '2026-09-30T10:00:02.000Z',
      tool: 'shell', action: 'install', outcome: 'succeeded', exitStatus: 0, summary: 'Installation succeeded.' });
    store.appendIncremental({ event: request });
    store.appendIncremental({ event: result });
    store.preserveOperationInstructionContext(request,
      { instructions: [], conventions: [], scopedConventions: [], unresolvedScopes: [] });
    store.close();
    const artifactPath = join(root, 'annotation.json');
    writeFileSync(artifactPath, JSON.stringify({ version: 1, producer: { kind: 'local-annotation', version: '1', namespace: 'pilot' },
      repositoryId, sessionId, contextRevision: 'declared-context', records: [
        { id: 'verification-b', origin: 'user-declared', kind: 'task-verification', state: 'succeeded',
          decisionKey: 'install', scopeKey: 'repo', reasonClass: 'verification',
          operation: { source: 'codex', sourceEventId: 'operation-b' } }
      ] }));
    importTypedEvidence(databasePath, repositoryId, artifactPath);
    const resolver = new SqliteCandidateEvidenceResolver(databasePath, sessionId);
    const evidenceId = annotationEvidenceId('pilot', repositoryId, sessionId, 'verification-b');
    const witness = resolver.resolve(repositoryId, evidenceId)!;
    resolver.close();
    assert.equal(witness.kind, 'task-verification');
    const advicePath = join(dataDir, 'advice.sqlite');
    new AdvisoryConfigurationStore(advicePath).setEnabled(repositoryId, true);
    const usage = new AdvisoryUsageStore(advicePath, () => '2026-09-30T09:00:00.000Z');
    const scope = { repositoryId, lessonId: 'candidate-b', lessonRevision: '1',
      sessionId, contextRevision: witness.contextRevision! };
    const bundle = usage.retrieved({ ...scope, operationSignature: witness.operationSignature!, retrievalRef: 'cli-call-b' });
    const inputPath = join(root, 'usage.json');
    const record = (kind: string, origin: string, witnessRef: string) => {
      writeFileSync(inputPath, JSON.stringify({ ...scope, bundleId: bundle.id, kind, origin, witnessRef }));
      return runCli(['advice', 'record', '--input', inputPath, '--data-dir', dataDir, '--json'],
        { workingDirectory: repositoryRoot });
    };
    assert.equal(record('delivered', 'agent-claim', 'delivery-b').exitCode, 0);
    assert.equal(record('selected', 'agent-selection', 'selection-b').exitCode, 0);
    assert.equal(record('applied', 'operation-evidence', request.id).exitCode, 0);
    assert.equal(record('outcome-observed', 'verification-evidence', evidenceId).exitCode, 0);
    assert.deepEqual(usage.facts(bundle.id).map(fact => fact.kind),
      ['retrieved', 'delivered', 'selected', 'applied', 'outcome-observed']);
    assert.equal(record('outcome-observed', 'verification-evidence', 'unknown-evidence').exitCode, 1);
    const lateScope = { ...scope, lessonRevision: '2' };
    const lateUsage = new AdvisoryUsageStore(advicePath, () => '2026-09-30T11:00:00.000Z');
    const lateBundle = lateUsage.retrieved({ ...lateScope, operationSignature: witness.operationSignature!, retrievalRef: 'late-cli-call' });
    writeFileSync(inputPath, JSON.stringify({ ...lateScope, bundleId: lateBundle.id,
      kind: 'delivered', origin: 'agent-claim', witnessRef: 'late-delivery' }));
    assert.equal(runCli(['advice', 'record', '--input', inputPath, '--data-dir', dataDir, '--json'],
      { workingDirectory: repositoryRoot }).exitCode, 0);
    writeFileSync(inputPath, JSON.stringify({ ...lateScope, bundleId: lateBundle.id,
      kind: 'selected', origin: 'agent-selection', witnessRef: 'late-selection' }));
    assert.equal(runCli(['advice', 'record', '--input', inputPath, '--data-dir', dataDir, '--json'],
      { workingDirectory: repositoryRoot }).exitCode, 0);
    writeFileSync(inputPath, JSON.stringify({ ...lateScope, bundleId: lateBundle.id,
      kind: 'applied', origin: 'operation-evidence', witnessRef: request.id }));
    assert.equal(runCli(['advice', 'record', '--input', inputPath, '--data-dir', dataDir, '--json'],
      { workingDirectory: repositoryRoot }).exitCode, 1);
    assert.equal(lateUsage.facts(lateBundle.id).some(fact => fact.kind === 'applied'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
