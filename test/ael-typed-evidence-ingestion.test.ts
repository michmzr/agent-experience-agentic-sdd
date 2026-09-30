import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  mkdirSync(join(dataDir, 'project'));
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

test('ATI-A6 public import admits a resolved closure to the normal worker after restart', () => {
  const { dataDir, databasePath, invoke } = fixture();
  const artifact = { ...example, records: [{ ...example.records[0], id: 'task-closed', kind: 'task-transition', state: 'closed' }] };
  const imported = invoke(artifact);
  assert.equal(imported.exitCode, 0, imported.stdout);
  const indexed = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal((indexed.prepare('SELECT COUNT(*) AS count FROM logical_annotation_evidence WHERE session_id = ?')
    .get('ati-session') as { count: number }).count, 1);
  indexed.close();
  const reopened = new ExperienceStore(databasePath);
  const range = reopened.loadCapturedSessionRange('ati-session' as SessionId, { after: 0,
    through: reopened.logicalEvidenceHighWater('ati-session' as SessionId), limit: 10 });
  assert.equal(range.annotations.length, 1);
  reopened.close();
  const run = runCli(['analysis', 'run', '--repository-id', 'ati-repo', '--data-dir', dataDir, '--json']);
  assert.equal(run.exitCode, 0, run.stdout);
  const checked = new DatabaseSync(databasePath, { readOnly: true });
  const jobs = checked.prepare('SELECT state, failure_reason FROM operational_analysis_jobs').all();
  checked.close();
  assert.equal(JSON.parse(run.stdout).status, 'completed', JSON.stringify(jobs));
  const reported = runCli(['analysis', 'report', '--repository-id', 'ati-repo', '--schema-version', '2', '--data-dir', dataDir, '--json']);
  assert.equal(reported.exitCode, 0, reported.stdout);
  assert.equal(JSON.parse(reported.stdout).typed.episodes.some((episode: { kind?: string }) => episode.kind === 'verification-gap'), true);
});

test('ATI-A6 migration fences a native writer that allocates ordinals without the annotation sidecar', () => {
  const { databasePath, invoke } = fixture();
  const artifact = { ...example, records: [{ ...example.records[0], id: 'writer-fence', kind: 'task-transition', state: 'closed' }] };
  assert.equal(invoke(artifact).exitCode, 0);
  const legacyWriter = new DatabaseSync(databasePath);
  const native = legacyWriter.prepare('SELECT MAX(ordinal) AS ordinal FROM logical_evidence WHERE session_id = ?')
    .get('ati-session') as { ordinal: number };
  assert.throws(() => legacyWriter.prepare(`INSERT INTO logical_evidence
    (ordinal, source, source_event_id, session_id, path, event_id) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(native.ordinal + 1, 'codex', 'old-writer-event', 'ati-session', 'legacy', 'old-writer-event'));
  legacyWriter.close();
});

test('ATI-A6 pending annotation waits for its source and reconciliation restores interrupted admission', () => {
  const { dataDir, databasePath, invoke } = fixture();
  const artifact = { ...example, records: [{ ...example.records[0], id: 'late-closure', kind: 'task-transition',
    state: 'closed', operation: { source: 'codex', sourceEventId: 'later-operation' } }] };
  assert.equal(JSON.parse(invoke(artifact).stdout).pending, 1);
  const before = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal((before.prepare('SELECT COUNT(*) AS count FROM logical_annotation_evidence').get() as { count: number }).count, 0);
  assert.equal((before.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'operational_analysis_jobs'").get() as { count: number }).count, 0);
  before.close();
  const store = new ExperienceStore(databasePath);
  store.appendIncremental({ event: normalizeMappedCapture({ source: 'codex', sourceEventId: 'later-operation',
    sessionId: 'ati-session', phase: 'pre-action', occurredAt: '2026-09-30T10:00:04.000Z',
    tool: 'shell', action: 'test', summary: 'Late operation.' }) });
  store.close();
  assert.equal(JSON.parse(invoke(artifact).stdout).indexed, 1);
  const interrupted = new DatabaseSync(databasePath);
  const native = interrupted.prepare('SELECT MAX(ordinal) AS high_water FROM logical_evidence WHERE session_id = ?')
    .get('ati-session') as { high_water: number };
  const annotation = interrupted.prepare('SELECT ordinal FROM logical_annotation_evidence WHERE session_id = ?')
    .get('ati-session') as { ordinal: number };
  assert.equal(annotation.ordinal, native.high_water + 1);
  interrupted.prepare("DELETE FROM operational_analysis_jobs WHERE session_id = ? AND state = 'pending'").run('ati-session');
  interrupted.prepare('UPDATE operational_analysis_streams SET committed_high_water = ?, processed_high_water = ? WHERE session_id = ?')
    .run(native.high_water, native.high_water, 'ati-session');
  interrupted.close();
  const preview = runCli(['analysis', 'reconcile', '--repository-id', 'ati-repo', '--data-dir', dataDir, '--json']);
  assert.equal(preview.exitCode, 0, preview.stdout);
  assert.equal(JSON.parse(preview.stdout).missing, 1);
  const apply = runCli(['analysis', 'reconcile', '--repository-id', 'ati-repo', '--apply', '--data-dir', dataDir, '--json']);
  assert.equal(apply.exitCode, 0, apply.stdout);
  assert.equal(JSON.parse(apply.stdout).added, 1);
  assert.equal(JSON.parse(runCli(['analysis', 'reconcile', '--repository-id', 'ati-repo', '--apply', '--data-dir', dataDir, '--json']).stdout).added, 0);
});

test('ATI-A3 explicit decision relation produces correction while changed context prevents repeated acceptance', () => {
  const { dataDir, invoke } = fixture();
  const base = example.records[0];
  const records = [
    { ...base, id: 'original', kind: 'user-instruction', state: 'observed', reasonClass: 'instruction' },
    { ...base, id: 'changed', kind: 'user-instruction', state: 'observed', reasonClass: 'superseded', relatedEvidenceIds: ['original'] },
    { ...base, id: 'closure', kind: 'task-transition', state: 'closed', reasonClass: 'verification' }
  ];
  const imported = invoke({ ...example, records });
  assert.equal(imported.exitCode, 0, imported.stdout);
  assert.equal(runCli(['analysis', 'run', '--repository-id', 'ati-repo', '--data-dir', dataDir, '--json']).exitCode, 0);
  const reported = runCli(['analysis', 'report', '--repository-id', 'ati-repo', '--schema-version', '2', '--data-dir', dataDir, '--json']);
  assert.equal(reported.exitCode, 0, reported.stdout);
  const episodes = JSON.parse(reported.stdout).typed.episodes as Array<{ kind: string; criterionState?: string }>;
  assert.equal(episodes.some(({ kind }) => kind === 'correction'), true);
  assert.equal(episodes.some(({ kind, criterionState }) => kind === 'verification-gap' && criterionState === 'unknown'), true);

  const claim = { ...base, origin: 'agent-claimed', kind: 'agent-claim', state: 'succeeded', reasonClass: 'verification' };
  assert.equal(invoke({ ...example, records: [{ ...claim, id: 'accept-one' }] }).exitCode, 0);
  assert.equal(invoke({ ...example, contextRevision: 'new-context', records: [{ ...claim, id: 'accept-two' }] }).exitCode, 0);
  assert.equal(runCli(['analysis', 'run', '--repository-id', 'ati-repo', '--data-dir', dataDir, '--json']).exitCode, 0);
  const after = runCli(['analysis', 'report', '--repository-id', 'ati-repo', '--schema-version', '2', '--data-dir', dataDir, '--json']);
  assert.equal(after.exitCode, 0, after.stdout);
  assert.equal((JSON.parse(after.stdout).typed.episodes as Array<{ kind: string }>).some(({ kind }) => kind === 'repeated-acceptance'), false);
});

test('ATI-A4 bounded decision relation survives three worker jobs and a reopened store', () => {
  const { dataDir, databasePath, invoke } = fixture();
  const base = example.records[0];
  const records = [
    { ...base, id: 'first-decision', kind: 'user-instruction', state: 'observed', reasonClass: 'instruction' },
    { ...base, id: 'second-decision', kind: 'user-instruction', state: 'observed', reasonClass: 'superseded', relatedEvidenceIds: ['first-decision'] },
    { ...base, id: 'late-closure', kind: 'task-transition', state: 'closed', reasonClass: 'verification' }
  ];
  for (const record of records) {
    const imported = invoke({ ...example, records: [record] });
    assert.equal(imported.exitCode, 0, imported.stdout);
    const run = runCli(['analysis', 'run', '--repository-id', 'ati-repo', '--data-dir', dataDir, '--json']);
    assert.equal(run.exitCode, 0, run.stdout);
  }
  const reopened = new ExperienceStore(databasePath);
  assert.equal(reopened.logicalEvidenceHighWater('ati-session' as SessionId), 4);
  reopened.close();
  const reported = runCli(['analysis', 'report', '--repository-id', 'ati-repo', '--schema-version', '2', '--data-dir', dataDir, '--json']);
  assert.equal(reported.exitCode, 0, reported.stdout);
  const episodes = JSON.parse(reported.stdout).typed.episodes as Array<{ kind: string }>;
  assert.equal(episodes.some(({ kind }) => kind === 'correction'), true);
  assert.equal(episodes.some(({ kind }) => kind === 'verification-gap'), true);
});

test('ATI-A3 unresolved decision links stay pending and cross-session links are rejected', () => {
  const { databasePath, invoke } = fixture();
  const base = example.records[0];
  const changed = { ...base, id: 'linked-change', kind: 'user-instruction', state: 'observed',
    reasonClass: 'superseded', relatedEvidenceIds: ['linked-original'] };
  assert.equal(JSON.parse(invoke({ ...example, records: [changed] }).stdout).pending, 1);
  const first = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal((first.prepare('SELECT COUNT(*) AS count FROM logical_annotation_evidence').get() as { count: number }).count, 0);
  first.close();
  const original = { ...base, id: 'linked-original', kind: 'user-instruction', state: 'observed', reasonClass: 'instruction' };
  assert.equal(invoke({ ...example, records: [original] }).exitCode, 0);
  assert.equal(JSON.parse(invoke({ ...example, records: [changed] }).stdout).indexed, 1);

  const store = new ExperienceStore(databasePath);
  store.appendIncremental({ session: { id: 'other-session' as SessionId, source: 'codex',
    startedAt: '2026-09-30T10:00:02.000Z', repositoryId: 'ati-repo' as RepositoryId } });
  store.appendIncremental({ event: normalizeMappedCapture({ source: 'codex', sourceEventId: 'other-request',
    sessionId: 'other-session', phase: 'pre-action', occurredAt: '2026-09-30T10:00:03.000Z',
    tool: 'shell', action: 'test', summary: 'Test.' }) });
  store.close();
  const foreign = invoke({ ...example, sessionId: 'other-session', records: [{ ...changed, id: 'foreign-change',
    operation: { source: 'codex', sourceEventId: 'other-request' } }] });
  assert.equal(foreign.exitCode, 1);
  const last = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal((last.prepare("SELECT COUNT(*) AS count FROM imported_typed_evidence WHERE evidence_id = 'foreign-change'")
    .get() as { count: number }).count, 0);
  last.close();
  const cycle = invoke({ ...example, records: [
    { ...original, id: 'cycle-one', relatedEvidenceIds: ['cycle-two'] },
    { ...original, id: 'cycle-two', relatedEvidenceIds: ['cycle-one'] }
  ] });
  assert.equal(cycle.exitCode, 1);
});
