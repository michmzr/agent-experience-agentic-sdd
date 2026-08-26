import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { adaptCodexCapture } from '../src/capture/adapters/codex.js';
import type { SessionId } from '../src/domain/types.js';
import { ExperienceStore } from '../src/storage/experience-store.js';

const startedAt = '2026-08-26T08:00:00.000Z';
const endedAt = '2026-08-26T08:30:00.000Z';

function databasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'ael-session-life-')), 'experience.sqlite');
}

test('closes a session once and treats the same close as idempotent', () => {
  const store = new ExperienceStore(databasePath());
  const session = { id: 'session-1' as SessionId, source: 'codex' as const, startedAt };

  assert.equal(store.appendIncremental({ session }).inserted, true);
  assert.equal(store.endSession('codex', session.id, endedAt).inserted, true);
  assert.equal(store.endSession('codex', session.id, endedAt).inserted, false);
  assert.equal(store.appendIncremental({ session }).inserted, false);
  assert.equal(store.appendIncremental({ session: { ...session, endedAt } }).inserted, false);
  assert.throws(
    () => store.appendIncremental({ session: { ...session, endedAt: '2026-08-26T08:31:00.000Z' } }),
    /conflicting.*session end/i
  );
  assert.throws(() => store.appendIncremental({ session: { ...session, startedAt: '2026-08-26T08:01:00.000Z' } }), /conflicting.*session identity/i);
  assert.deepEqual(store.loadSession(session.id), { ...session, endedAt });
  assert.throws(
    () => store.endSession('codex', session.id, '2026-08-26T08:31:00.000Z'),
    /conflicting.*session end/i
  );
  store.close();
});

test('rejects a session end before the latest persisted event', () => {
  const store = new ExperienceStore(databasePath());
  const session = { id: 'session-1' as SessionId, source: 'codex' as const, startedAt };
  const event = adaptCodexCapture({
    event_id: 'latest-event', session_id: session.id, event_kind: 'pre_action',
    occurred_at: '2026-08-26T08:20:00.000Z', tool: 'git', action: 'status',
    cwd: '/work/repo', summary: 'Run git status.'
  });
  store.appendIncremental({ session, event });

  assert.throws(() => store.endSession('codex', session.id, '2026-08-26T08:10:00.000Z'), /event|end/i);
  assert.equal(store.loadSession(session.id)?.endedAt, undefined);
  store.close();
});

test('rejects missing, mismatched, and pre-start session ends atomically', () => {
  const store = new ExperienceStore(databasePath());
  const session = { id: 'session-1' as SessionId, source: 'cursor' as const, startedAt };
  store.appendIncremental({ session });

  assert.throws(() => store.endSession('cursor', session.id, 'not-a-time'), /canonical/i);
  assert.throws(() => store.endSession('codex', session.id, endedAt), /source/i);
  assert.throws(() => store.endSession('cursor', 'missing' as SessionId, endedAt), /missing/i);
  assert.throws(() => store.endSession('cursor', session.id, '2026-08-26T07:59:59.999Z'), /precede/i);
  assert.equal(store.loadSession(session.id)?.endedAt, undefined);
  store.close();
});

test('rejects an orphan closed session append without writing a row', () => {
  const store = new ExperienceStore(databasePath());
  const session = {
    id: 'orphan-closed' as SessionId, source: 'codex' as const, startedAt, endedAt
  };

  assert.throws(() => store.appendIncremental({ session }), /open|session end/i);
  assert.equal(store.loadSession(session.id), undefined);
  store.close();
});

test('migrates a version 10 session row as open without rewriting it', () => {
  const path = databasePath();
  const seed = new ExperienceStore(path);
  const legacySession = { id: 'legacy' as SessionId, source: 'codex' as const, startedAt };
  const legacyEvent = adaptCodexCapture({
    event_id: 'legacy-event', session_id: legacySession.id, event_kind: 'pre_action',
    occurred_at: '2026-08-26T08:01:00.000Z', tool: 'git', action: 'status',
    cwd: '/work/repo', summary: 'Run git status.'
  });
  seed.appendIncremental({ session: legacySession, event: legacyEvent });
  seed.close();

  const legacy = new DatabaseSync(path);
  legacy.exec(`
    ALTER TABLE sessions DROP COLUMN ended_at;
    DELETE FROM schema_migrations WHERE version = 11;
  `);
  legacy.close();

  const store = new ExperienceStore(path);
  assert.deepEqual(store.loadSession('legacy' as SessionId), {
    id: 'legacy', source: 'codex', startedAt
  });
  assert.deepEqual(store.listCapturedEventsPage().entries.map(({ sourceEventId }) => sourceEventId), ['legacy-event']);
  const postMigrationEvent = adaptCodexCapture({
    event_id: 'post-migration-event', session_id: legacySession.id, event_kind: 'pre_action',
    occurred_at: '2026-08-26T08:02:00.000Z', tool: 'git', action: 'diff',
    cwd: '/work/repo', summary: 'Run git diff.'
  });
  assert.equal(store.appendIncremental({ event: postMigrationEvent }).inserted, true);
  assert.deepEqual(store.listCapturedEventsPage().entries.map(({ sourceEventId }) => sourceEventId), ['legacy-event', 'post-migration-event']);
  store.close();
});

test('rejects technical events after session closure without adding a capture row', () => {
  const store = new ExperienceStore(databasePath());
  const session = { id: 'session-1' as SessionId, source: 'codex' as const, startedAt };
  store.appendIncremental({ session });
  store.endSession('codex', session.id, endedAt);

  const event = adaptCodexCapture({
    event_id: 'after-close', session_id: session.id, event_kind: 'pre_action',
    occurred_at: '2026-08-26T08:30:00.001Z', tool: 'git', action: 'status',
    cwd: '/work/repo', summary: 'Run git status.'
  });
  assert.throws(() => store.appendIncremental({ event }), /session end|lifetime/i);
  assert.deepEqual(store.listCapturedEventsPage().entries, []);
  store.close();
});

test('accepts a technical event after its session start across expanded years', () => {
  const store = new ExperienceStore(databasePath());
  const session = { id: 'expanded-session' as SessionId, source: 'codex' as const, startedAt: '9999-01-01T00:00:00.000Z' };
  const event = adaptCodexCapture({
    event_id: 'expanded-event', session_id: session.id, event_kind: 'pre_action',
    occurred_at: '+010000-01-01T00:00:00.000Z', tool: 'git', action: 'status',
    cwd: '/work/repo', summary: 'Run git status.'
  });

  assert.doesNotThrow(() => store.appendIncremental({ session, event }));
  store.close();
});

test('accepts a post-result after its related pre-action across expanded years', () => {
  const store = new ExperienceStore(databasePath());
  const session = { id: 'expanded-related-session' as SessionId, source: 'codex' as const, startedAt: '9999-01-01T00:00:00.000Z' };
  const pre = adaptCodexCapture({
    event_id: 'expanded-pre', session_id: session.id, event_kind: 'pre_action',
    occurred_at: '9999-01-01T00:00:00.000Z', tool: 'git', action: 'status',
    cwd: '/work/repo', summary: 'Run git status.'
  });
  const post = adaptCodexCapture({
    event_id: 'expanded-post', session_id: session.id, event_kind: 'post_result',
    occurred_at: '+010000-01-01T00:00:00.000Z', tool: 'git', action: 'status',
    cwd: '/work/repo', summary: 'Git status completed.', outcome: 'succeeded',
    exit_status: 0, related_event_id: 'expanded-pre'
  });

  store.appendIncremental({ session, event: pre });
  assert.doesNotThrow(() => store.appendIncremental({ event: post }));
  store.close();
});
