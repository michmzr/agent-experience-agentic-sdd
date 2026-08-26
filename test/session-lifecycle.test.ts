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
  assert.deepEqual(store.loadSession(session.id), { ...session, endedAt });
  assert.throws(
    () => store.endSession('codex', session.id, '2026-08-26T08:31:00.000Z'),
    /conflicting.*session end/i
  );
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

test('migrates a version 10 session row as open without rewriting it', () => {
  const path = databasePath();
  const seed = new ExperienceStore(path);
  seed.appendIncremental({ session: { id: 'legacy' as SessionId, source: 'codex', startedAt } });
  seed.close();

  const legacy = new DatabaseSync(path);
  legacy.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE sessions RENAME TO sessions_with_end;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at TEXT NOT NULL,
      repository_id TEXT, workspace_id TEXT, user_id TEXT
    );
    INSERT INTO sessions (id, source, started_at, repository_id, workspace_id, user_id)
      SELECT id, source, started_at, repository_id, workspace_id, user_id FROM sessions_with_end;
    DROP TABLE sessions_with_end;
    DELETE FROM schema_migrations WHERE version = 11;
  `);
  legacy.close();

  const store = new ExperienceStore(path);
  assert.deepEqual(store.loadSession('legacy' as SessionId), {
    id: 'legacy', source: 'codex', startedAt
  });
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
