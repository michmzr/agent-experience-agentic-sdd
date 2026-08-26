import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { adaptCodexCapture } from '../src/capture/adapters/codex.js';
import { createPassiveCaptureService, type PassiveCaptureRecord } from '../src/capture/passive-service.js';
import type { SessionId } from '../src/domain/types.js';
import { ExperienceStore } from '../src/storage/experience-store.js';

const startedAt = '2026-08-26T08:00:00.000Z';
const eventAt = '2026-08-26T08:01:00.000Z';
const endedAt = '2026-08-26T08:02:00.000Z';

function store(): ExperienceStore {
  return new ExperienceStore(join(mkdtempSync(join(tmpdir(), 'ael-passive-')), 'experience.sqlite'));
}

function session() {
  return { id: 'passive-session' as SessionId, source: 'codex' as const, startedAt };
}

function event() {
  return adaptCodexCapture({
    event_id: 'technical-1', session_id: session().id, event_kind: 'pre_action', occurred_at: eventAt,
    tool: 'git', action: 'status', cwd: '/work/repo', summary: 'Run git status.'
  });
}

function postEvent() {
  return adaptCodexCapture({
    event_id: 'technical-2', session_id: session().id, event_kind: 'post_result', occurred_at: eventAt,
    tool: 'git', action: 'status', cwd: '/work/repo', summary: 'Git status completed.', outcome: 'succeeded',
    exit_status: 0, related_event_id: 'technical-1'
  });
}

test('captures a session lifecycle and technical event without learning side effects', () => {
  const target = store();
  const service = createPassiveCaptureService({ store: target });

  assert.equal(service.capture({ kind: 'session-start', session: session() }).status, 'captured');
  assert.equal(service.capture({ kind: 'technical', event: event() }).status, 'captured');
  assert.equal(service.capture({ kind: 'technical', event: postEvent() }).status, 'captured');
  assert.equal(service.capture({ kind: 'session-end', source: 'codex', sessionId: session().id, endedAt }).status, 'captured');
  assert.deepEqual(target.loadSession(session().id), { ...session(), endedAt });
  assert.deepEqual(target.listCapturedEventsPage().entries.map(({ sourceEventId }) => sourceEventId), ['technical-1', 'technical-2']);
  assert.deepEqual(target.listCandidatesPage().entries, []);
  assert.deepEqual(target.listEvidencePage().entries, []);
  assert.deepEqual(target.listKnowledge(), []);
  target.close();
});

test('reports duplicate delivery for each idempotent lifecycle record', () => {
  const target = store();
  const service = createPassiveCaptureService({ store: target });
  const records: PassiveCaptureRecord[] = [
    { kind: 'session-start', session: session() },
    { kind: 'technical', event: event() },
    { kind: 'session-end', source: 'codex', sessionId: session().id, endedAt }
  ];
  for (const record of records) assert.equal(service.capture(record).status, 'captured');
  for (const record of records) assert.equal(service.capture(record).status, 'duplicate');
  target.close();
});

test('degrades with a bounded privacy-safe diagnostic when persistence fails', () => {
  const service = createPassiveCaptureService({
    store: {
      appendIncremental() { throw new Error('Bearer: super-secret-token'); },
      endSession() { throw new Error('Bearer: super-secret-token'); }
    }
  });
  const result = service.capture({ kind: 'session-start', session: session() });
  assert.equal(result.status, 'degraded');
  assert.deepEqual(result.diagnostic, { code: 'PASSIVE_CAPTURE_FAILED', eventClass: 'session-start' });
  assert.equal(JSON.stringify(result).includes('super-secret'), false);
  assert.doesNotThrow(() => service.capture({ kind: 'session-end', source: 'codex', sessionId: session().id, endedAt }));
});
