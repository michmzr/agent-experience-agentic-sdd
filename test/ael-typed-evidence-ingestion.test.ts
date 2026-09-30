import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { runCli } from '../src/cli.js';
import { normalizeMappedCapture } from '../src/capture/normalization.js';
import type { RepositoryId, SessionId } from '../src/domain/types.js';
import { localAnnotationEvidenceCapability, sourceEvidenceCapabilities } from '../src/evidence/capabilities.js';
import { ExperienceStore } from '../src/storage/experience-store.js';

const example = JSON.parse(readFileSync(new URL('../../test/fixtures/ael-typed-evidence-ingestion/cases.json', import.meta.url), 'utf8'));

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'ati-import-'));
  const databasePath = join(dataDir, 'experience.sqlite');
  const store = new ExperienceStore(databasePath);
  store.registerRepository({ id: 'ati-repo' as RepositoryId, root: join(dataDir, 'project'), observedAt: '2026-09-30T10:00:00.000Z' });
  store.appendIncremental({ session: { id: 'ati-session' as SessionId, source: 'codex', startedAt: '2026-09-30T10:00:00.000Z', repositoryId: 'ati-repo' as RepositoryId } });
  store.appendIncremental({ event: normalizeMappedCapture({ source: 'codex', sourceEventId: 'ati-request', sessionId: 'ati-session',
    phase: 'pre-action', occurredAt: '2026-09-30T10:00:01.000Z', tool: 'shell', action: 'test', summary: 'Test.' }) });
  store.close();
  const input = join(dataDir, 'annotation.json');
  const invoke = (artifact: unknown) => {
    writeFileSync(input, JSON.stringify(artifact));
    return runCli(['evidence', 'import', '--repository-id', 'ati-repo', '--input', input, '--data-dir', dataDir, '--json']);
  };
  return { dataDir, databasePath, invoke };
}

test('ATI-A1 public annotation import is bounded, closed, immutable and idempotent after restart', () => {
  const { databasePath, invoke } = fixture();
  const first = invoke(example);
  assert.equal(first.exitCode, 0);
  assert.equal(JSON.parse(first.stdout).retained, 1);
  const second = invoke(example);
  assert.equal(second.exitCode, 0);
  assert.equal(JSON.parse(second.stdout).retained, 0);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM imported_typed_evidence').get() as { count: number }).count, 1);
  db.close();
  assert.equal(invoke({ ...example, records: [{ ...example.records[0], rawOutput: 'private transcript' }] }).exitCode, 1);
  assert.equal(invoke({ ...example, records: [{ ...example.records[0], id: `sk-${'a'.repeat(24)}` }] }).exitCode, 1);
  assert.equal(invoke({ ...example, records: [{ ...example.records[0], state: 'failed' }] }).exitCode, 1);
  assert.equal(invoke({ ...example, records: Array.from({ length: 129 }, (_, i) => ({ ...example.records[0], id: `item-${i}` })) }).exitCode, 1);
  assert.equal(invoke({ ...example, padding: 'x'.repeat(256 * 1024) }).exitCode, 1);
});

test('ATI-A2 user verification retains declared origin and scoped operation; missing references stay pending', () => {
  const { databasePath, invoke } = fixture();
  assert.equal(invoke(example).exitCode, 0);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const verified = db.prepare('SELECT origin, kind, resolution, operation_source_event_id, payload_json FROM imported_typed_evidence')
    .get() as { origin: string; kind: string; resolution: string; operation_source_event_id: string; payload_json: string };
  assert.equal(verified.origin, 'user-declared');
  assert.equal(verified.kind, 'task-verification');
  assert.equal(verified.resolution, 'resolved');
  assert.equal(verified.operation_source_event_id, 'ati-request');
  assert.equal(verified.payload_json.includes('rawOutput'), false);
  db.close();
  assert.equal(invoke({ ...example, records: [{ ...example.records[0], id: 'forged', origin: 'source-observed', kind: 'tool-result' }] }).exitCode, 1);
  const pending = invoke({ ...example, records: [{ ...example.records[0], id: 'future', operation: { source: 'codex', sourceEventId: 'not-yet-retained' } }] });
  assert.equal(pending.exitCode, 0);
  assert.equal(JSON.parse(pending.stdout).pending, 1);
  const pendingDb = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal((pendingDb.prepare('SELECT resolution FROM imported_typed_evidence WHERE evidence_id = ?')
    .get('future') as { resolution: string }).resolution, 'pending');
  pendingDb.close();
  const store = new ExperienceStore(databasePath);
  store.appendIncremental({ event: normalizeMappedCapture({ source: 'codex', sourceEventId: 'not-yet-retained',
    sessionId: 'ati-session', phase: 'pre-action', occurredAt: '2026-09-30T10:00:03.000Z',
    tool: 'shell', action: 'test', summary: 'Later test.' }) });
  store.close();
  assert.equal(invoke({ ...example, records: [{ ...example.records[0], id: 'future',
    operation: { source: 'codex', sourceEventId: 'not-yet-retained' } }] }).exitCode, 0);
  const resolvedDb = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal((resolvedDb.prepare('SELECT resolution FROM imported_typed_evidence WHERE evidence_id = ?')
    .get('future') as { resolution: string }).resolution, 'resolved');
  resolvedDb.close();
  assert.equal(invoke({ ...example, records: [{ ...example.records[0], id: 'agent-verification',
    origin: 'agent-claimed' }] }).exitCode, 1);
  const crossScope = invoke({ ...example, sessionId: 'other-session', records: [{ ...example.records[0], id: 'cross' }] });
  assert.equal(crossScope.exitCode, 1);
});

test('ATI-A2 rejects an unindexed retained operation from another session', () => {
  const { databasePath, invoke } = fixture();
  const store = new ExperienceStore(databasePath);
  store.appendIncremental({ session: { id: 'foreign-session' as SessionId, source: 'codex',
    startedAt: '2026-09-30T10:01:00.000Z', repositoryId: 'ati-repo' as RepositoryId } });
  store.appendIncremental({ event: normalizeMappedCapture({ source: 'codex', sourceEventId: 'foreign-request',
    sessionId: 'foreign-session', phase: 'pre-action', occurredAt: '2026-09-30T10:01:01.000Z',
    tool: 'shell', action: 'test', summary: 'Foreign test.' }) });
  store.close();
  const interrupted = new DatabaseSync(databasePath);
  interrupted.prepare('DELETE FROM logical_evidence WHERE source_event_id = ?').run('foreign-request');
  interrupted.close();
  const forged = { ...example, records: [{ ...example.records[0], id: 'cross-unindexed',
    operation: { source: 'codex', sourceEventId: 'foreign-request' } }] };
  assert.equal(invoke(forged).exitCode, 1);
});

test('ATI-A2 does not treat an unindexed source result as an operation request', () => {
  const { databasePath, invoke } = fixture();
  const store = new ExperienceStore(databasePath);
  store.appendIncremental({ event: normalizeMappedCapture({ source: 'codex', sourceEventId: 'ati-result',
    sessionId: 'ati-session', phase: 'post-result', occurredAt: '2026-09-30T10:00:02.000Z',
    tool: 'shell', action: 'test', summary: 'Result.', outcome: 'unknown', relatedEventId: 'ati-request' }) });
  store.close();
  const interrupted = new DatabaseSync(databasePath);
  interrupted.prepare('DELETE FROM logical_evidence WHERE source_event_id = ?').run('ati-result');
  interrupted.close();
  assert.equal(invoke({ ...example, records: [{ ...example.records[0], id: 'result-reference',
    operation: { source: 'codex', sourceEventId: 'ati-result' } }] }).exitCode, 1);
});

test('ATI-A5 native verification stays unsupported while public annotation import remains auditable', () => {
  assert.equal(sourceEvidenceCapabilities.codex.taskVerification, 'unsupported');
  assert.equal(sourceEvidenceCapabilities.cursor.taskVerification, 'unsupported');
  assert.equal(sourceEvidenceCapabilities['claude-code'].taskVerification, 'unsupported');
  assert.deepEqual(localAnnotationEvidenceCapability, {
    producer: 'local-annotation', taskVerification: 'user-declared', nativeSourceTelemetry: false
  });
  const { dataDir, databasePath, invoke } = fixture();
  const imported = invoke(example);
  assert.equal(imported.exitCode, 0);
  assert.equal(JSON.parse(imported.stdout).retained, 1);
  const session = runCli(['evidence', 'session', 'ati-session', '--data-dir', dataDir, '--json']);
  assert.equal(session.exitCode, 0);
  assert.equal(JSON.parse(session.stdout).capabilities.taskVerification, 'unsupported');
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const row = db.prepare('SELECT origin, kind, resolution FROM imported_typed_evidence WHERE evidence_id = ?')
    .get('verified-criterion') as { origin: string; kind: string; resolution: string };
  assert.equal(row.origin, 'user-declared');
  assert.equal(row.kind, 'task-verification');
  assert.equal(row.resolution, 'resolved');
  db.close();
});
