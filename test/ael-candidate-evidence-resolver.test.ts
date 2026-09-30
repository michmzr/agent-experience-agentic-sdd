import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { normalizeMappedCapture } from '../src/capture/normalization.js';
import type { RepositoryId, SessionId } from '../src/domain/types.js';
import { annotationEvidenceId } from '../src/evidence/import.js';
import { importTypedEvidence } from '../src/evidence/import.js';
import { operationSignatureFromStoredJson, SqliteCandidateEvidenceResolver } from '../src/knowledge/evidence-resolver.js';
import { ExperienceStore } from '../src/storage/experience-store.js';

test('ACL evidence resolver uses persisted scoped capture and user-declared verification after restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'acl-witness-'));
  try {
    const databasePath = join(root, 'experience.sqlite');
    const repositoryId = 'repo-1' as RepositoryId; const sessionId = 'session-1' as SessionId;
    const store = new ExperienceStore(databasePath);
    store.registerRepository({ id: repositoryId, root, observedAt: '2026-09-30T10:00:00.000Z' });
    store.appendIncremental({ session: { id: sessionId, source: 'codex', repositoryId, startedAt: '2026-09-30T10:00:00.000Z' } });
    const request = normalizeMappedCapture({ source: 'codex', sourceEventId: 'operation-1', sessionId,
      phase: 'pre-action', occurredAt: '2026-09-30T10:00:01.000Z', tool: 'shell', action: 'install', summary: 'Install dependencies.' });
    const result = normalizeMappedCapture({ source: 'codex', sourceEventId: 'result-1', sessionId,
      phase: 'post-result', relatedEventId: 'operation-1', occurredAt: '2026-09-30T10:00:02.000Z',
      tool: 'shell', action: 'install', outcome: 'succeeded', exitStatus: 0, summary: 'Install completed.' });
    store.appendIncremental({ event: request });
    store.appendIncremental({ event: result });
    store.preserveOperationInstructionContext(request, { instructions: [], conventions: [], scopedConventions: [], unresolvedScopes: [] });
    store.close();
    const artifactPath = join(root, 'annotation.json');
    writeFileSync(artifactPath, JSON.stringify({ version: 1, producer: { kind: 'local-annotation', version: '1', namespace: 'user-notes' },
      repositoryId, sessionId, contextRevision: 'declared-revision', records: [
        { id: 'verification-1', origin: 'user-declared', kind: 'task-verification', state: 'succeeded',
          decisionKey: 'pnpm-install', scopeKey: 'mobile', reasonClass: 'verification',
          operation: { source: 'codex', sourceEventId: 'operation-1' } },
        { id: 'claim-1', origin: 'agent-claimed', kind: 'agent-claim', state: 'succeeded',
          decisionKey: 'pnpm-install', scopeKey: 'mobile', reasonClass: 'verification',
          operation: { source: 'codex', sourceEventId: 'operation-1' } }
      ] }));
    importTypedEvidence(databasePath, repositoryId, artifactPath);
    const resolver = new SqliteCandidateEvidenceResolver(databasePath, sessionId);
    assert.equal(resolver.resolve(repositoryId, request.id)?.kind, 'observation');
    assert.equal(resolver.resolve('other-repo', request.id), undefined);
    const otherSession = new SqliteCandidateEvidenceResolver(databasePath, 'session-2');
    assert.equal(otherSession.resolve(repositoryId, request.id), undefined);
    otherSession.close();
    assert.equal(resolver.resolve(repositoryId, result.id), undefined);
    const verificationId = annotationEvidenceId('user-notes', repositoryId, sessionId, 'verification-1');
    const witness = resolver.resolve(repositoryId, verificationId);
    assert.equal(witness?.kind, 'task-verification');
    assert.equal(witness?.procedureKey, 'pnpm-install');
    assert.match(witness?.contextRevision ?? '', /^instruction:v1:[a-f0-9]{64}$/);
    assert.match(witness?.operationSignature ?? '', /^operation:v1:[a-f0-9]{64}$/);
    assert.notEqual(witness?.contextRevision, 'declared-revision');
    assert.equal(resolver.resolve(repositoryId, annotationEvidenceId('user-notes', repositoryId, sessionId, 'claim-1')), undefined);
    assert.equal(resolver.capabilities().projectFact, 'conditional');
    assert.equal(resolver.listInstructionContextEvidence(repositoryId).length, 0);
    resolver.close();

    const database = new DatabaseSync(databasePath);
    try {
      const persisted = database.prepare('SELECT signature_json FROM capture_events WHERE event_id = ?')
        .get(request.id) as { signature_json: string };
      const exactSignature = `operation:v1:${createHash('sha256').update(persisted.signature_json).digest('hex')}`;
      assert.equal(operationSignatureFromStoredJson(persisted.signature_json), exactSignature);
      assert.equal(witness?.operationSignature, exactSignature);

      database.prepare("UPDATE imported_typed_evidence SET resolution = 'pending' WHERE evidence_id = 'verification-1'").run();
      const unresolved = new SqliteCandidateEvidenceResolver(databasePath, sessionId);
      assert.equal(unresolved.resolve(repositoryId, verificationId), undefined);
      unresolved.close();
      database.prepare("UPDATE imported_typed_evidence SET resolution = 'resolved' WHERE evidence_id = 'verification-1'").run();

      database.prepare('UPDATE capture_instruction_contexts SET payload_json = ? WHERE source_event_id = ?')
        .run('{invalid-json', 'operation-1');
      const corrupt = new SqliteCandidateEvidenceResolver(databasePath, sessionId);
      assert.equal(corrupt.resolve(repositoryId, verificationId), undefined);
      corrupt.close();
      database.prepare('UPDATE capture_instruction_contexts SET payload_json = ? WHERE source_event_id = ?')
        .run(JSON.stringify({ instructions: [], conventions: [], scopedConventions: [], unresolvedScopes: [] }), 'operation-1');

      database.prepare("UPDATE capture_events SET capture_outcome = 'failed' WHERE event_id = ?").run(result.id);
      const failed = new SqliteCandidateEvidenceResolver(databasePath, sessionId);
      assert.equal(failed.resolve(repositoryId, verificationId), undefined);
      failed.close();
    } finally { database.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
