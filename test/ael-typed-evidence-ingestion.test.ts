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
import { annotationEvidenceId } from '../src/evidence/import.js';
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
  assert.throws(() => legacyWriter.prepare(`INSERT INTO logical_annotation_evidence
    (session_id, ordinal, producer_namespace, repository_id, evidence_id) VALUES (?, ?, ?, ?, ?)`)
    .run('ati-session', native.ordinal + 2, 'controlled-test', 'ati-repo', 'old-annotation-writer'));
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

test('ATI-A4 indexed lookback resolves a decision older than 128 annotations after restart', () => {
  const { dataDir, databasePath, invoke } = fixture();
  const base = example.records[0];
  const original = { ...base, id: 'old-decision', kind: 'user-instruction', state: 'observed', reasonClass: 'instruction' };
  const filler = Array.from({ length: 127 }, (_, index) => ({ ...original,
    id: `filler-${index}`, decisionKey: `filler-decision-${index}` }));
  const first = invoke({ ...example, records: [original, ...filler] });
  assert.equal(first.exitCode, 0, first.stdout);
  const firstRun = runCli(['analysis', 'run', '--repository-id', 'ati-repo', '--data-dir', dataDir, '--json']);
  assert.equal(JSON.parse(firstRun.stdout).status, 'completed', firstRun.stdout);
  const overflow = invoke({ ...example, records: [{ ...original, id: 'filler-128', decisionKey: 'filler-decision-128' }] });
  assert.equal(overflow.exitCode, 0, overflow.stdout);
  const overflowRun = runCli(['analysis', 'run', '--repository-id', 'ati-repo', '--data-dir', dataDir, '--json']);
  assert.equal(JSON.parse(overflowRun.stdout).status, 'completed', overflowRun.stdout);
  const checkpointDb = new DatabaseSync(databasePath, { readOnly: true });
  const checkpoint = JSON.parse((checkpointDb.prepare('SELECT checkpoint_json FROM operational_analysis_streams WHERE session_id = ?')
    .get('ati-session') as { checkpoint_json: string }).checkpoint_json) as { typedEvidence: Array<{ id: string }> };
  checkpointDb.close();
  assert.equal(checkpoint.typedEvidence.length, 128);
  assert.equal(checkpoint.typedEvidence.some(({ id }) => id === annotationEvidenceId('controlled-test', 'ati-repo', 'ati-session', 'old-decision')), false);
  const reopened = new ExperienceStore(databasePath);
  assert.equal(reopened.logicalEvidenceHighWater('ati-session' as SessionId), 130);
  reopened.close();
  const changed = { ...original, id: 'new-decision', reasonClass: 'superseded', relatedEvidenceIds: ['old-decision'] };
  const second = invoke({ ...example, records: [changed] });
  assert.equal(second.exitCode, 0, second.stdout);
  const secondRun = runCli(['analysis', 'run', '--repository-id', 'ati-repo', '--data-dir', dataDir, '--json']);
  assert.equal(JSON.parse(secondRun.stdout).status, 'completed', secondRun.stdout);
  const reported = runCli(['analysis', 'report', '--repository-id', 'ati-repo', '--schema-version', '2', '--data-dir', dataDir, '--json']);
  assert.equal(reported.exitCode, 0, reported.stdout);
  assert.equal((JSON.parse(reported.stdout).typed.episodes as Array<{ kind: string }>).some(({ kind }) => kind === 'correction'), true);
});

test('ATI-A4 relation lookup persists an incomplete page cursor and resumes without retry failure', () => {
  const { dataDir, databasePath, invoke } = fixture();
  const base = example.records[0];
  const original = (index: number) => ({ ...base, id: `old-${String(index).padStart(3, '0')}`,
    kind: 'user-instruction', state: 'observed', reasonClass: 'instruction' });
  for (const [start, count] of [[0, 128], [128, 128], [256, 1]]) {
    const imported = invoke({ ...example, records: Array.from({ length: count }, (_, offset) => original(start + offset)) });
    assert.equal(imported.exitCode, 0, imported.stdout);
    const run = runCli(['analysis', 'run', '--repository-id', 'ati-repo', '--data-dir', dataDir, '--json']);
    assert.equal(JSON.parse(run.stdout).status, 'completed', run.stdout);
  }
  const paged = new ExperienceStore(databasePath);
  const firstPage = paged.loadCapturedSessionRange('ati-session' as SessionId, {
    after: 1, through: paged.logicalEvidenceHighWater('ati-session' as SessionId), limit: 128 });
  assert.equal(firstPage.annotations.length, 128);
  assert.equal(firstPage.actualHighWater, 129);
  paged.appendIncremental({ event: normalizeMappedCapture({ source: 'codex', sourceEventId: 'continuation-request',
    sessionId: 'ati-session', phase: 'pre-action', occurredAt: '2026-09-30T10:00:05.000Z',
    tool: 'shell', action: 'test', summary: 'Continuation request.' }) });
  paged.close();
  const changed = Array.from({ length: 9 }, (_, index) => ({ ...original(300 + index), reasonClass: 'superseded',
    relatedEvidenceIds: Array.from({ length: index === 8 ? 1 : 16 }, (_, offset) =>
      `old-${String(index * 16 + offset).padStart(3, '0')}`) }));
  const imported = invoke({ ...example, records: changed });
  assert.equal(imported.exitCode, 0, imported.stdout);
  const first = runCli(['analysis', 'run', '--repository-id', 'ati-repo', '--data-dir', dataDir, '--json']);
  assert.equal(JSON.parse(first.stdout).status, 'completed', first.stdout);
  const interim = new DatabaseSync(databasePath, { readOnly: true });
  const stream = interim.prepare('SELECT processed_high_water, committed_high_water, checkpoint_json FROM operational_analysis_streams WHERE session_id = ?')
    .get('ati-session') as { processed_high_water: number; committed_high_water: number; checkpoint_json: string };
  assert.equal(stream.processed_high_water < stream.committed_high_water, true);
  assert.equal(JSON.parse(stream.checkpoint_json).relationCursor, 128);
  assert.equal((JSON.parse(stream.checkpoint_json).pendingEvents as Array<{ sourceEventId: string }>).
    some(({ sourceEventId }) => sourceEventId === 'continuation-request'), false);
  assert.equal((interim.prepare("SELECT status FROM operational_analysis_coverage ORDER BY rowid DESC LIMIT 1")
    .get() as { status: string }).status, 'incomplete');
  interim.close();
  const restarted = new ExperienceStore(databasePath);
  assert.equal(restarted.logicalEvidenceHighWater('ati-session' as SessionId), stream.committed_high_water);
  restarted.close();
  const second = runCli(['analysis', 'run', '--repository-id', 'ati-repo', '--data-dir', dataDir, '--json']);
  assert.equal(JSON.parse(second.stdout).status, 'completed', second.stdout);
  const finalDb = new DatabaseSync(databasePath, { readOnly: true });
  const completed = finalDb.prepare('SELECT processed_high_water, committed_high_water, checkpoint_json FROM operational_analysis_streams WHERE session_id = ?')
    .get('ati-session') as { processed_high_water: number; committed_high_water: number; checkpoint_json: string };
  assert.equal(completed.processed_high_water, completed.committed_high_water);
  assert.equal(JSON.parse(completed.checkpoint_json).relationCursor, undefined);
  finalDb.close();
  const reported = runCli(['analysis', 'report', '--repository-id', 'ati-repo', '--schema-version', '2', '--data-dir', dataDir, '--json']);
  assert.equal(reported.exitCode, 0, reported.stdout);
  assert.equal((JSON.parse(reported.stdout).typed.episodes as Array<{ kind: string }>).some(({ kind }) => kind === 'correction'), true);
});

test('ATI-A4 scoped lookback cannot resolve a pending or foreign-session relation', () => {
  const { databasePath, invoke } = fixture();
  const base = example.records[0];
  const pending = { ...base, id: 'pending-change', kind: 'user-instruction', state: 'observed',
    reasonClass: 'superseded', relatedEvidenceIds: ['absent-original'] };
  assert.equal(JSON.parse(invoke({ ...example, records: [pending] }).stdout).pending, 1);
  const store = new ExperienceStore(databasePath);
  assert.equal(store.loadIndexedAnnotationByIdentity('ati-repo', 'ati-session' as SessionId,
    'controlled-test', 'pending-change', 100), undefined);
  store.appendIncremental({ session: { id: 'other-session' as SessionId, source: 'codex',
    startedAt: '2026-09-30T10:00:02.000Z', repositoryId: 'ati-repo' as RepositoryId } });
  store.appendIncremental({ event: normalizeMappedCapture({ source: 'codex', sourceEventId: 'other-request',
    sessionId: 'other-session', phase: 'pre-action', occurredAt: '2026-09-30T10:00:03.000Z',
    tool: 'shell', action: 'test', summary: 'Test.' }) });
  store.close();
  const foreign = { ...base, id: 'foreign-original', kind: 'user-instruction', state: 'observed',
    reasonClass: 'instruction', operation: { source: 'codex', sourceEventId: 'other-request' } };
  assert.equal(invoke({ ...example, sessionId: 'other-session', records: [foreign] }).exitCode, 0);
  const scoped = new ExperienceStore(databasePath);
  assert.equal(scoped.loadIndexedAnnotationByIdentity('ati-repo', 'ati-session' as SessionId,
    'controlled-test', 'foreign-original', 100), undefined);
  assert.equal(scoped.loadIndexedAnnotationByIdentity('other-repo', 'other-session' as SessionId,
    'controlled-test', 'foreign-original', 100), undefined);
  assert.notEqual(scoped.loadIndexedAnnotationByIdentity('ati-repo', 'other-session' as SessionId,
    'controlled-test', 'foreign-original', 100), undefined);
  scoped.close();
});

test('ATI-A4 repeated acceptance finds a scoped claim older than the checkpoint', () => {
  const { dataDir, databasePath, invoke } = fixture();
  const base = example.records[0];
  const claim = { ...base, id: 'first-claim', origin: 'agent-claimed', kind: 'agent-claim',
    state: 'succeeded', reasonClass: 'verification' };
  assert.equal(invoke({ ...example, records: [claim] }).exitCode, 0);
  assert.equal(JSON.parse(runCli(['analysis', 'run', '--repository-id', 'ati-repo', '--data-dir', dataDir, '--json']).stdout).status, 'completed');
  const filler = (index: number) => ({ ...base, id: `claim-filler-${index}`, kind: 'user-instruction',
    state: 'observed', reasonClass: 'instruction', decisionKey: `other-${index}` });
  for (const [start, count] of [[0, 128], [128, 1]]) {
    const imported = invoke({ ...example, records: Array.from({ length: count }, (_, offset) => filler(start + offset)) });
    assert.equal(imported.exitCode, 0, imported.stdout);
    const run = runCli(['analysis', 'run', '--repository-id', 'ati-repo', '--data-dir', dataDir, '--json']);
    assert.equal(JSON.parse(run.stdout).status, 'completed', run.stdout);
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const checkpoint = JSON.parse((db.prepare('SELECT checkpoint_json FROM operational_analysis_streams WHERE session_id = ?')
    .get('ati-session') as { checkpoint_json: string }).checkpoint_json) as { typedEvidence: Array<{ id: string }> };
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT ordinal FROM logical_annotation_evidence
    WHERE repository_id = ? AND session_id = ? AND producer_namespace = ? AND context_revision = ?
      AND kind = 'agent-claim' AND decision_key = ? AND scope_key = ? AND ordinal <= ?
    ORDER BY ordinal LIMIT 1`).all('ati-repo', 'ati-session', 'controlled-test', 'rev-1', 'decision-1', 'task-1', 1000) as Array<{ detail: string }>;
  assert.equal(plan.some(({ detail }) => detail.includes('logical_annotation_relation_scope')), true, JSON.stringify(plan));
  db.close();
  assert.equal(checkpoint.typedEvidence.some(({ id }) => id === annotationEvidenceId('controlled-test', 'ati-repo', 'ati-session', 'first-claim')), false);
  assert.equal(invoke({ ...example, records: [{ ...claim, id: 'second-claim' }] }).exitCode, 0);
  const run = runCli(['analysis', 'run', '--repository-id', 'ati-repo', '--data-dir', dataDir, '--json']);
  assert.equal(JSON.parse(run.stdout).status, 'completed', run.stdout);
  const reported = runCli(['analysis', 'report', '--repository-id', 'ati-repo', '--schema-version', '2', '--data-dir', dataDir, '--json']);
  assert.equal(reported.exitCode, 0, reported.stdout);
  assert.equal((JSON.parse(reported.stdout).typed.episodes as Array<{ kind: string }>).some(({ kind }) => kind === 'repeated-acceptance'), true);
});

test('ATI-A4 paged claim lookback preserves every earlier matching acceptance', () => {
  const { dataDir, invoke } = fixture();
  const base = example.records[0];
  const claim = { ...base, origin: 'agent-claimed', kind: 'agent-claim', state: 'succeeded',
    reasonClass: 'verification' };
  assert.equal(invoke({ ...example, records: [{ ...claim, id: 'first-claim' }, { ...claim, id: 'second-claim' }] }).exitCode, 0);
  assert.equal(JSON.parse(runCli(['analysis', 'run', '--repository-id', 'ati-repo', '--data-dir', dataDir, '--json']).stdout).status, 'completed');
  const filler = (index: number) => ({ ...base, id: `pair-filler-${index}`, kind: 'user-instruction',
    state: 'observed', reasonClass: 'instruction', decisionKey: `other-${index}` });
  for (const [start, count] of [[0, 128], [128, 1]]) {
    assert.equal(invoke({ ...example, records: Array.from({ length: count }, (_, offset) => filler(start + offset)) }).exitCode, 0);
    assert.equal(JSON.parse(runCli(['analysis', 'run', '--repository-id', 'ati-repo', '--data-dir', dataDir, '--json']).stdout).status, 'completed');
  }
  assert.equal(invoke({ ...example, records: [{ ...claim, id: 'third-claim' }] }).exitCode, 0);
  assert.equal(JSON.parse(runCli(['analysis', 'run', '--repository-id', 'ati-repo', '--data-dir', dataDir, '--json']).stdout).status, 'completed');
  const reported = runCli(['analysis', 'report', '--repository-id', 'ati-repo', '--schema-version', '2', '--data-dir', dataDir, '--json']);
  assert.equal(reported.exitCode, 0, reported.stdout);
  const matches = (JSON.parse(reported.stdout).typed.episodes as Array<{ kind: string }>)
    .filter(({ kind }) => kind === 'repeated-acceptance');
  assert.equal(matches.length, 3);
});

test('ATI-A4 more than 128 matching claims resume from an indexed ordinal cursor', () => {
  const { dataDir, databasePath, invoke } = fixture();
  const base = example.records[0];
  const claim = (index: number) => ({ ...base, id: `claim-${String(index).padStart(3, '0')}`,
    origin: 'agent-claimed', kind: 'agent-claim', state: 'succeeded', reasonClass: 'verification' });
  assert.equal(invoke({ ...example, records: [claim(0)] }).exitCode, 0);
  assert.equal(JSON.parse(runCli(['analysis', 'run', '--repository-id', 'ati-repo', '--data-dir', dataDir, '--json']).stdout).status, 'completed');
  assert.equal(invoke({ ...example, records: Array.from({ length: 127 }, (_, index) => claim(index + 1)) }).exitCode, 0);
  assert.equal(invoke({ ...example, records: [claim(128)] }).exitCode, 0);
  const seeded = new DatabaseSync(databasePath);
  const priorHighWater = (seeded.prepare('SELECT MAX(ordinal) AS ordinal FROM logical_annotation_evidence WHERE session_id = ?')
    .get('ati-session') as { ordinal: number }).ordinal;
  seeded.prepare("DELETE FROM operational_analysis_jobs WHERE session_id = ? AND state = 'pending'").run('ati-session');
  seeded.prepare('UPDATE operational_analysis_streams SET processed_high_water = committed_high_water WHERE session_id = ?')
    .run('ati-session');
  seeded.close();
  assert.equal(invoke({ ...example, records: [claim(129)] }).exitCode, 0);
  const first = runCli(['analysis', 'run', '--repository-id', 'ati-repo', '--data-dir', dataDir, '--json']);
  assert.equal(JSON.parse(first.stdout).status, 'completed', first.stdout);
  const interim = new DatabaseSync(databasePath, { readOnly: true });
  const stream = interim.prepare('SELECT processed_high_water, checkpoint_json FROM operational_analysis_streams WHERE session_id = ?')
    .get('ati-session') as { processed_high_water: number; checkpoint_json: string };
  const checkpoint = JSON.parse(stream.checkpoint_json) as { relationCursor?: number; claimCursor?: number };
  assert.equal(stream.processed_high_water, priorHighWater);
  assert.equal(checkpoint.relationCursor, 0);
  assert.equal(typeof checkpoint.claimCursor, 'number');
  interim.close();
  const second = runCli(['analysis', 'run', '--repository-id', 'ati-repo', '--data-dir', dataDir, '--json']);
  assert.equal(JSON.parse(second.stdout).status, 'completed', second.stdout);
  const finalDb = new DatabaseSync(databasePath, { readOnly: true });
  const finalStream = finalDb.prepare('SELECT processed_high_water, committed_high_water, checkpoint_json FROM operational_analysis_streams WHERE session_id = ?')
    .get('ati-session') as { processed_high_water: number; committed_high_water: number; checkpoint_json: string };
  assert.equal(finalStream.processed_high_water, finalStream.committed_high_water);
  assert.equal(JSON.parse(finalStream.checkpoint_json).claimCursor, undefined);
  assert.equal((finalDb.prepare("SELECT COUNT(*) AS count FROM operational_episodes WHERE json_extract(payload_json, '$.kind') = 'repeated-acceptance'")
    .get() as { count: number }).count, 129);
  finalDb.close();
});

test('ATI-A4 migration 21 backfills indexed decision scope for retained version 20 annotations', () => {
  const { databasePath, invoke } = fixture();
  const claim = { ...example.records[0], id: 'upgrade-claim', origin: 'agent-claimed',
    kind: 'agent-claim', state: 'succeeded' };
  assert.equal(invoke({ ...example, records: [claim] }).exitCode, 0);
  const old = new DatabaseSync(databasePath);
  old.exec('DROP TRIGGER logical_annotation_scope_writer_fence');
  old.exec('DROP INDEX logical_annotation_relation_scope');
  for (const column of ['context_revision', 'kind', 'decision_key', 'scope_key']) {
    old.exec(`ALTER TABLE logical_annotation_evidence DROP COLUMN ${column}`);
  }
  old.prepare('DELETE FROM schema_migrations WHERE version = ?').run(21);
  old.close();
  const reopened = new ExperienceStore(databasePath);
  const found = reopened.loadPriorScopedClaimsPage('ati-repo', 'ati-session' as SessionId, 'controlled-test',
    'rev-1', 'decision-1', 'task-1', 0, 100, 128);
  assert.equal(found.annotations[0]?.evidenceId, 'upgrade-claim');
  reopened.close();
  const db = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal((db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version, 21);
  db.close();
});
