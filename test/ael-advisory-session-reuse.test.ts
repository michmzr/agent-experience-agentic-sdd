import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AdvisoryUsageStore } from '../src/advice/usage.js';
import { normalizeMappedCapture } from '../src/capture/normalization.js';
import { runCli } from '../src/cli.js';
import type { RepositoryId, SessionId } from '../src/domain/types.js';
import { annotationEvidenceId, importTypedEvidence } from '../src/evidence/import.js';
import { CandidateRepository } from '../src/knowledge/candidate-repository.js';
import { conventionPropositionKey, operationSignatureFromStoredJson, SqliteCandidateEvidenceResolver } from '../src/knowledge/evidence-resolver.js';
import { recordPackageManagerFact } from '../src/knowledge/package-manager-fact.js';
import { resolveRepository } from '../src/repository/local-repository.js';
import { ExperienceStore } from '../src/storage/experience-store.js';

for (const scenario of ['instruction-context convention', 'Git-tracked packageManager fact'] as const) {
  test(`AAP-A4 public session A to B reuse: ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'ael-advice-reuse-'));
    const repositoryRoot = join(root, 'repo');
    const dataDir = join(root, 'data');
    mkdirSync(repositoryRoot); mkdirSync(dataDir);
    execFileSync('git', ['init', '-q', repositoryRoot]);
    const repositoryId = resolveRepository(repositoryRoot)!.id as RepositoryId;
    const databasePath = join(dataDir, 'experience.sqlite');
    const advicePath = join(dataDir, 'advice.sqlite');
    const applicability = scenario === 'instruction-context convention'
      ? { scope: 'repository' as const } : { scope: 'subproject' as const, path: 'mobile' };
    const instructionContext = {
      instructions: [{ location: 'AGENTS.md', scope: 'repository' as const, found: true,
        delivered: 'unknown' as const, explicitlyRead: 'unknown' as const,
        digest: 'a'.repeat(64), evidenceId: 'instruction-context:AGENTS.md' }],
      conventions: [{ tool: 'pnpm' as const, replaces: 'npm' as const,
        source: 'AGENTS.md:1', digest: 'a'.repeat(64) }],
      scopedConventions: [], unresolvedScopes: []
    };
    try {
      if (scenario === 'Git-tracked packageManager fact') {
        mkdirSync(join(repositoryRoot, 'mobile'));
        writeFileSync(join(repositoryRoot, 'mobile', 'package.json'),
          JSON.stringify({ name: 'mobile-app', packageManager: 'pnpm@10.0.0' }));
        execFileSync('git', ['-C', repositoryRoot, 'add', 'mobile/package.json']);
      }
      const store = new ExperienceStore(databasePath);
      store.registerRepository({ id: repositoryId, root: repositoryRoot, observedAt: new Date().toISOString() });
      const observations = ['session-a1', 'session-a2'].map((id, index) => {
        const sessionId = id as SessionId;
        store.appendIncremental({ session: { id: sessionId, source: 'codex', repositoryId,
          startedAt: '2026-09-30T09:00:00.000Z' } });
        const operation = normalizeMappedCapture({ source: 'codex', sourceEventId: `observe-${scenario === 'instruction-context convention' ? 'instruction' : 'fact'}-${index}`,
          sessionId, phase: 'pre-action', occurredAt: `2026-09-30T09:00:0${index}.000Z`,
          tool: 'shell', action: 'install', summary: 'Install dependencies.' });
        store.appendIncremental({ event: operation });
        if (index === 0 && scenario === 'instruction-context convention') {
          store.preserveOperationInstructionContext(operation, instructionContext);
        }
        return operation;
      });
      const sessionB = 'session-b' as SessionId;
      store.appendIncremental({ session: { id: sessionB, source: 'codex', repositoryId,
        startedAt: new Date().toISOString() } });
      store.close();

      const fact = scenario === 'Git-tracked packageManager fact'
        ? recordPackageManagerFact(databasePath, repositoryId, 'session-a1', applicability) : undefined;
      const resolver = new SqliteCandidateEvidenceResolver(databasePath, 'session-a1');
      const instruction = scenario === 'instruction-context convention'
        ? resolver.listInstructionContextEvidence(repositoryId)[0] : undefined;
      const evidenceId = fact?.evidenceId ?? instruction!.id;
      const contextRevision = fact?.contextRevision ?? instruction!.contextRevision;
      assert.equal(resolver.resolve(repositoryId, evidenceId)?.kind,
        fact ? 'deterministic-fact' : 'instruction-context');
      resolver.close();

      const candidates = new CandidateRepository(databasePath);
      const candidate = candidates.register({ repositoryId,
        kind: fact ? 'project-fact' : 'convention', source: 'manual-review', originId: 'session-a1',
        propositionKey: fact?.factKey ?? conventionPropositionKey('pnpm', 'npm'), applicability,
        statement: fact ? 'mobile uses pnpm@10.0.0.' : 'Use pnpm instead of npm.' });
      candidates.close();
      const reviewPath = join(root, 'review.json');
      const review = (sessionId: string, target: string, witness: string) => {
        writeFileSync(reviewPath, JSON.stringify({ candidateId: candidate.id, sessionId, target,
          actorId: 'controlled-reviewer', evidenceId: witness, reviewedAt: new Date().toISOString() }));
        return runCli(['candidates', 'review', '--repository-id', repositoryId, '--input', reviewPath,
          '--data-dir', dataDir, '--json'], { workingDirectory: repositoryRoot });
      };
      assert.equal(review('session-a1', 'observed', observations[0]!.id).exitCode, 0);
      assert.equal(review('session-a2', 'confirmed', observations[1]!.id).exitCode, 0);
      assert.equal(review('session-a1', 'verified', evidenceId).exitCode, 0);

      const operationSignature = operationSignatureFromStoredJson(JSON.stringify(observations[0]!.signature));
      const configure = runCli(['advice', 'configure', '--repository-id', repositoryId, '--enabled', 'true',
        '--data-dir', dataDir, '--json'], { workingDirectory: repositoryRoot });
      assert.equal(configure.exitCode, 0);
      const retrievalPath = join(root, 'retrieval.json');
      writeFileSync(retrievalPath, JSON.stringify({ repositoryId, sessionId: sessionB,
        ...(fact ? { subproject: 'mobile' } : {}), operationSignature, contextRevision,
        conditions: [], retrievalRef: `controlled-${scenario === 'instruction-context convention' ? 'instruction' : 'fact'}` }));
      const retrieved = runCli(['advice', 'retrieve', '--input', retrievalPath, '--data-dir', dataDir, '--json'],
        { workingDirectory: repositoryRoot });
      assert.equal(retrieved.exitCode, 0, retrieved.stdout);
      const entries = JSON.parse(retrieved.stdout).entries as Array<{ bundleId: string; candidateId: string; revision: string }>;
      assert.equal(entries.length, 1, retrieved.stdout);
      assert.equal(entries[0]!.candidateId, candidate.id);
      const bundle = entries[0]!;
      const scope = { repositoryId, lessonId: candidate.id, lessonRevision: bundle.revision,
        sessionId: sessionB, contextRevision, bundleId: bundle.bundleId };
      const usage = new AdvisoryUsageStore(advicePath);
      assert.deepEqual(usage.facts(bundle.bundleId).map(f => f.kind), ['retrieved']);

      const usagePath = join(root, 'usage.json');
      const record = (kind: string, origin: string, witnessRef: string) => {
        writeFileSync(usagePath, JSON.stringify({ ...scope, kind, origin, witnessRef }));
        return runCli(['advice', 'record', '--input', usagePath, '--data-dir', dataDir, '--json'],
          { workingDirectory: repositoryRoot });
      };
      assert.equal(record('delivered', 'agent-claim', 'controlled-agent-declaration').exitCode, 0);
      assert.equal(record('selected', 'agent-selection', 'controlled-choice').exitCode, 0);
      assert.deepEqual(usage.facts(bundle.bundleId).map(f => [f.kind, f.origin]), [
        ['retrieved', 'cli-retrieval'], ['delivered', 'agent-claim'], ['selected', 'agent-selection']]);

      // The captured B operation is created only after the public selection.
      await new Promise(resolve => setTimeout(resolve, 5));
      const operationB = normalizeMappedCapture({ source: 'codex', sourceEventId: `apply-${fact ? 'fact' : 'instruction'}`,
        sessionId: sessionB, phase: 'pre-action', occurredAt: new Date().toISOString(),
        tool: 'shell', action: 'install', summary: 'Install dependencies with pnpm.' });
      const resultB = normalizeMappedCapture({ source: 'codex', sourceEventId: `result-${fact ? 'fact' : 'instruction'}`,
        sessionId: sessionB, phase: 'post-result', relatedEventId: operationB.sourceEventId,
        occurredAt: new Date(Date.parse(operationB.occurredAt) + 1_000).toISOString(),
        tool: 'shell', action: 'install', outcome: 'succeeded', exitStatus: 0, summary: 'Installation succeeded.' });
      const laterStore = new ExperienceStore(databasePath);
      laterStore.appendIncremental({ event: operationB });
      laterStore.appendIncremental({ event: resultB });
      laterStore.preserveOperationInstructionContext(operationB, fact
        ? { instructions: [], conventions: [], scopedConventions: [], unresolvedScopes: [] }
        : instructionContext);
      laterStore.close();
      assert.equal(record('applied', 'operation-evidence', operationB.id).exitCode, 0);
      const annotationPath = join(root, 'verification.json');
      writeFileSync(annotationPath, JSON.stringify({ version: 1,
        producer: { kind: 'local-annotation', version: '1', namespace: 'aap-controlled' },
        repositoryId, sessionId: sessionB, contextRevision,
        records: [{ id: 'verification-b', origin: 'user-declared', kind: 'task-verification', state: 'succeeded',
          decisionKey: 'install', scopeKey: 'repo', reasonClass: 'verification',
          operation: { source: 'codex', sourceEventId: operationB.sourceEventId } }] }));
      importTypedEvidence(databasePath, repositoryId, annotationPath);
      const verificationId = annotationEvidenceId('aap-controlled', repositoryId, sessionB, 'verification-b');
      const outcome = record('outcome-observed', 'verification-evidence', verificationId);
      assert.equal(outcome.exitCode, 0, outcome.stdout);
      assert.deepEqual(usage.facts(bundle.bundleId).map(f => f.kind),
        ['retrieved', 'delivered', 'selected', 'applied', 'outcome-observed']);
      assert.equal(usage.facts(bundle.bundleId).find(f => f.kind === 'delivered')?.origin, 'agent-claim');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
