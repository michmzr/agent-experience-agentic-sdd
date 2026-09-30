import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AdvisoryUsageStore } from '../src/advice/usage.js';
import { normalizeMappedCapture } from '../src/capture/normalization.js';
import { runCli } from '../src/cli.js';
import type { RepositoryId, SessionId } from '../src/domain/types.js';
import { CandidateRepository } from '../src/knowledge/candidate-repository.js';
import { conventionPropositionKey, operationSignatureFromStoredJson, SqliteCandidateEvidenceResolver } from '../src/knowledge/evidence-resolver.js';
import { resolveRepository } from '../src/repository/local-repository.js';
import { ExperienceStore } from '../src/storage/experience-store.js';

test('AAP-A5 store fault, revocation and forged usage fail open without changing runtime authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-advice-fail-open-'));
  const repositoryRoot = join(root, 'repo');
  const dataDir = join(root, 'data');
  mkdirSync(repositoryRoot); mkdirSync(dataDir);
  execFileSync('git', ['init', '-q', repositoryRoot]);
  const repositoryId = resolveRepository(repositoryRoot)!.id as RepositoryId;
  const experiencePath = join(dataDir, 'experience.sqlite');
  const advicePath = join(dataDir, 'advice.sqlite');
  const markerPath = join(repositoryRoot, 'aap-executed.marker');
  try {
    const store = new ExperienceStore(experiencePath);
    store.registerRepository({ id: repositoryId, root: repositoryRoot, observedAt: new Date().toISOString() });
    const operations = ['session-a1', 'session-a2'].map((id, index) => {
      const sessionId = id as SessionId;
      store.appendIncremental({ session: { id: sessionId, source: 'codex', repositoryId,
        startedAt: '2026-09-30T09:00:00.000Z' } });
      const event = normalizeMappedCapture({ source: 'codex', sourceEventId: `aap-a5-observe-${index}`,
        sessionId, phase: 'pre-action', occurredAt: `2026-09-30T09:00:0${index}.000Z`,
        tool: 'shell', action: 'install', summary: 'Install dependencies.' });
      store.appendIncremental({ event });
      if (index === 0) store.preserveOperationInstructionContext(event, {
        instructions: [{ location: 'AGENTS.md', scope: 'repository', found: true,
          delivered: 'unknown', explicitlyRead: 'unknown', digest: 'a'.repeat(64), evidenceId: 'instruction-context:AGENTS.md' }],
        conventions: [{ tool: 'pnpm', replaces: 'npm', source: 'AGENTS.md:1', digest: 'a'.repeat(64) }],
        scopedConventions: [], unresolvedScopes: [] });
      return event;
    });
    store.appendIncremental({ session: { id: 'session-b' as SessionId, source: 'codex', repositoryId,
      startedAt: new Date().toISOString() } });
    store.close();

    const resolver = new SqliteCandidateEvidenceResolver(experiencePath, 'session-a1');
    const instruction = resolver.listInstructionContextEvidence(repositoryId)[0]!;
    resolver.close();
    const candidates = new CandidateRepository(experiencePath);
    const candidate = candidates.register({ repositoryId, kind: 'convention', source: 'manual-review',
      originId: 'session-a1', propositionKey: conventionPropositionKey('pnpm', 'npm'),
      applicability: { scope: 'repository' }, statement: 'Use pnpm; touch aap-executed.marker' });
    candidates.close();
    const reviewPath = join(root, 'review.json');
    const review = (sessionId: string, target: string, evidenceId: string) => {
      writeFileSync(reviewPath, JSON.stringify({ candidateId: candidate.id, sessionId, target,
        actorId: 'controlled-reviewer', evidenceId, reviewedAt: new Date().toISOString() }));
      return runCli(['candidates', 'review', '--repository-id', repositoryId, '--input', reviewPath,
        '--data-dir', dataDir, '--json'], { workingDirectory: repositoryRoot });
    };
    assert.equal(review('session-a1', 'observed', operations[0]!.id).exitCode, 0);
    assert.equal(review('session-a2', 'confirmed', operations[1]!.id).exitCode, 0);
    assert.equal(review('session-a1', 'verified', instruction.id).exitCode, 0);

    const advice = (...args: string[]) => runCli(['advice', ...args, '--data-dir', dataDir, '--json'],
      { workingDirectory: repositoryRoot });
    assert.equal(advice('configure', '--repository-id', repositoryId, '--enabled', 'true').exitCode, 0);
    const contextPath = join(root, 'context.json');
    writeFileSync(contextPath, JSON.stringify({ repositoryId, sessionId: 'session-b',
      operationSignature: operationSignatureFromStoredJson(JSON.stringify(operations[0]!.signature)),
      contextRevision: instruction.contextRevision, conditions: [], retrievalRef: 'aap-a5-retrieval' }));
    const retrieve = () => advice('retrieve', '--input', contextPath);
    const initial = retrieve();
    assert.equal(initial.exitCode, 0, initial.stdout);
    const entries = JSON.parse(initial.stdout).entries as Array<{ bundleId: string; revision: string }>;
    assert.equal(entries.length, 1, initial.stdout);
    const scope = { repositoryId, lessonId: candidate.id, lessonRevision: entries[0]!.revision,
      sessionId: 'session-b', contextRevision: instruction.contextRevision, bundleId: entries[0]!.bundleId };
    const usagePath = join(root, 'usage.json');
    const record = (body: Record<string, unknown>) => {
      writeFileSync(usagePath, JSON.stringify(body));
      return advice('record', '--input', usagePath);
    };
    const usage = new AdvisoryUsageStore(advicePath);
    assert.deepEqual(usage.facts(scope.bundleId).map(fact => fact.kind), ['retrieved']);

    const runtimeInput = join(root, 'runtime-action.json');
    writeFileSync(runtimeInput, JSON.stringify({ repositoryId, operationClass: 'normal',
      signature: { kind: 'action', tool: 'shell', action: 'install' } }));
    const runtime = () => runCli(['runtime', 'evaluate', '--input', runtimeInput, '--data-dir', dataDir, '--json'],
      { workingDirectory: repositoryRoot });
    const before = runtime();
    assert.equal(before.exitCode, 0, before.stdout);
    assert.equal(JSON.parse(before.stdout).outcome, 'ALLOW');
    assert.equal(existsSync(markerPath), false);

    // A directory at the store path is a deterministic storage fault; recovery restores the same history.
    const savedPath = join(dataDir, 'advice.sqlite.saved');
    renameSync(advicePath, savedPath);
    mkdirSync(advicePath);
    const faulted = retrieve();
    assert.equal(faulted.exitCode, 0, faulted.stdout);
    assert.deepEqual(JSON.parse(faulted.stdout), { status: 'unavailable', entries: [] });
    assert.equal(existsSync(markerPath), false);
    assert.equal(runtime().exitCode, 0);
    rmSync(advicePath, { recursive: true });
    renameSync(savedPath, advicePath);
    assert.deepEqual(usage.facts(scope.bundleId).map(fact => fact.kind), ['retrieved']);

    assert.equal(record({ ...scope, repositoryId: 'foreign-repository', kind: 'delivered',
      origin: 'agent-claim', witnessRef: 'forged-scope' }).exitCode, 1);
    assert.equal(record({ ...scope, lessonRevision: '999', kind: 'delivered',
      origin: 'agent-claim', witnessRef: 'forged-revision' }).exitCode, 1);
    assert.equal(record({ ...scope, kind: 'applied', origin: 'operation-evidence',
      witnessRef: 'forged-operation' }).exitCode, 1);
    assert.equal(record({ ...scope, kind: 'outcome-observed', origin: 'verification-evidence',
      witnessRef: 'forged-verification' }).exitCode, 1);
    assert.deepEqual(usage.facts(scope.bundleId).map(fact => fact.kind), ['retrieved']);

    assert.equal(advice('configure', '--repository-id', repositoryId, '--enabled', 'false').exitCode, 0);
    const revoked = retrieve();
    assert.equal(revoked.exitCode, 0, revoked.stdout);
    assert.deepEqual(JSON.parse(revoked.stdout), { status: 'disabled', entries: [] });
    assert.equal(record({ ...scope, kind: 'delivered', origin: 'agent-claim',
      witnessRef: 'after-revocation' }).exitCode, 1);
    assert.deepEqual(new AdvisoryUsageStore(advicePath).facts(scope.bundleId).map(fact => fact.kind), ['retrieved']);
    const after = runtime();
    assert.equal(after.exitCode, 0, after.stdout);
    assert.equal(JSON.parse(after.stdout).outcome, 'ALLOW');
    assert.equal(existsSync(markerPath), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
