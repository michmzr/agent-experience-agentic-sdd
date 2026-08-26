import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { runCliAsync, type CliResult } from '../src/cli.js';
import type { SessionId } from '../src/domain/types.js';
import { ExperienceStore } from '../src/storage/experience-store.js';

const startTime = '2026-08-26T08:00:00.000Z';
const eventTime = '2026-08-26T08:01:00.000Z';
const postTime = '2026-08-26T08:01:01.000Z';
const endTime = '2026-08-26T08:02:00.000Z';
const afterEndTime = '2026-08-26T08:03:00.000Z';

function dataDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'ael-milestone-2-5-'));
}

function databasePath(dataDir: string): string {
  return join(dataDir, 'experience.sqlite');
}

async function capture(
  dataDir: string,
  source: 'codex' | 'cursor',
  payload: unknown,
  now: string
): Promise<CliResult> {
  const result = await runCliAsync(
    ['capture', 'hook', '--source', source, '--data-dir', dataDir],
    { hookInput: JSON.stringify(payload), now: () => now }
  );
  assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
  return result;
}

function codexPayload(
  eventName: 'SessionStart' | 'PreToolUse' | 'PostToolUse' | 'SessionEnd',
  sessionId = 'codex-session',
  toolUseId = 'codex-tool'
): Record<string, unknown> {
  return {
    session_id: sessionId,
    cwd: '/work/repo',
    hook_event_name: eventName,
    ...(eventName === 'SessionStart' ? { source: 'startup' } : {}),
    ...(eventName === 'PreToolUse' || eventName === 'PostToolUse' ? {
      tool_name: 'Bash',
      tool_use_id: toolUseId,
      tool_input: { command: 'git status --short' }
    } : {})
  };
}

function cursorPayload(
  eventName: 'sessionStart' | 'preToolUse' | 'postToolUse' | 'sessionEnd',
  sessionId = 'cursor-session',
  toolUseId = 'cursor-tool'
): Record<string, unknown> {
  return {
    conversation_id: sessionId,
    cwd: '/work/repo',
    hook_event_name: eventName,
    ...(eventName === 'preToolUse' || eventName === 'postToolUse' ? {
      tool_name: 'Shell',
      tool_use_id: toolUseId,
      tool_input: { command: 'git status --short' }
    } : {})
  };
}

test('captures both sources end to end with correlation, migration and no learning side effects', async () => {
  const dataDir = dataDirectory();
  try {
    await capture(dataDir, 'codex', codexPayload('SessionStart'), startTime);
    await capture(dataDir, 'codex', codexPayload('PreToolUse'), eventTime);
    await capture(dataDir, 'codex', codexPayload('PostToolUse'), postTime);
    await capture(dataDir, 'cursor', cursorPayload('sessionStart'), startTime);
    await capture(dataDir, 'cursor', cursorPayload('preToolUse'), eventTime);
    await capture(dataDir, 'cursor', cursorPayload('postToolUse'), postTime);
    await capture(dataDir, 'codex', codexPayload('SessionEnd'), endTime);
    await capture(dataDir, 'cursor', cursorPayload('sessionEnd'), endTime);

    const store = new ExperienceStore(databasePath(dataDir));
    try {
      assert.deepEqual(store.listCapturedEventsPage().entries.map((event) => ({
        source: event.source,
        phase: event.phase,
        sessionId: event.sessionId,
        outcome: event.outcome
      })), [
        { source: 'codex', phase: 'pre-action', sessionId: 'codex-session', outcome: undefined },
        { source: 'codex', phase: 'post-result', sessionId: 'codex-session', outcome: 'unknown' },
        { source: 'cursor', phase: 'pre-action', sessionId: 'cursor-session', outcome: undefined },
        { source: 'cursor', phase: 'post-result', sessionId: 'cursor-session', outcome: 'unknown' }
      ]);
      assert.equal(store.loadSession('codex-session' as SessionId)?.endedAt, endTime);
      assert.equal(store.loadSession('cursor-session' as SessionId)?.endedAt, endTime);
      assert.deepEqual(store.listCandidatesPage().entries, []);
      assert.deepEqual(store.listEvidencePage().entries, []);
      assert.deepEqual(store.listKnowledge(), []);
    } finally {
      store.close();
    }

    const database = new DatabaseSync(databasePath(dataDir));
    try {
      const migration = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number };
      assert.equal(migration.version, 11);
      const endedAtColumn = database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
      assert.equal(endedAtColumn.some(({ name }) => name === 'ended_at'), true);
    } finally {
      database.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('keeps duplicate deliveries idempotent and rejects events after immutable session closure', async () => {
  const dataDir = dataDirectory();
  try {
    const start = codexPayload('SessionStart', 'closed-session', 'closed-tool');
    const pre = codexPayload('PreToolUse', 'closed-session', 'closed-tool');
    const post = codexPayload('PostToolUse', 'closed-session', 'closed-tool');
    const end = codexPayload('SessionEnd', 'closed-session', 'closed-tool');

    await capture(dataDir, 'codex', start, startTime);
    await capture(dataDir, 'codex', start, startTime);
    await capture(dataDir, 'codex', pre, eventTime);
    await capture(dataDir, 'codex', pre, eventTime);
    await capture(dataDir, 'codex', post, postTime);
    await capture(dataDir, 'codex', post, postTime);
    await capture(dataDir, 'codex', end, endTime);
    await capture(dataDir, 'codex', end, endTime);

    const afterClose = await runCliAsync(
      ['capture', 'hook', '--source', 'codex', '--data-dir', dataDir],
      {
        hookInput: JSON.stringify(pre),
        now: () => afterEndTime
      }
    );
    assert.deepEqual(afterClose, {
      exitCode: 0,
      stdout: '',
      stderr: 'AEL_CAPTURE_PERSISTENCE_FAILED: Passive capture skipped.\n'
    });

    const store = new ExperienceStore(databasePath(dataDir));
    try {
      assert.equal(store.listCapturedEventsPage().entries.length, 2);
      assert.equal(store.loadSession('closed-session' as SessionId)?.endedAt, endTime);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('excludes raw hook fields and credential markers from SQLite and diagnostics', async () => {
  const dataDir = dataDirectory();
  const rawMarker = 'raw-tool-response-marker-2-5';
  const credentialMarker = 'classified-credential-marker-2-5';
  try {
    await capture(dataDir, 'codex', {
      ...codexPayload('SessionStart', 'privacy-session'),
      transcript_path: `/private/${rawMarker}.jsonl`,
      prompt: rawMarker,
      user_email: `${rawMarker}@example.test`
    }, startTime);
    await capture(dataDir, 'codex', {
      ...codexPayload('PreToolUse', 'privacy-session', 'privacy-tool'),
      tool_response: { output: rawMarker },
      transcript_path: `/private/${rawMarker}.jsonl`,
      prompt: rawMarker,
      user_email: `${rawMarker}@example.test`
    }, eventTime);

    const rejected = await runCliAsync(
      ['capture', 'hook', '--source', 'codex', '--data-dir', dataDir],
      {
        hookInput: JSON.stringify({
          ...codexPayload('PreToolUse', 'privacy-session', 'credential-tool'),
          tool_input: { command: `curl --token=${credentialMarker} https://example.test` }
        }),
        now: () => postTime
      }
    );
    assert.deepEqual(rejected, {
      exitCode: 0,
      stdout: '',
      stderr: 'AEL_CAPTURE_PRIVATE_INPUT: Passive capture skipped.\n'
    });
    assert.equal(rejected.stderr.includes(credentialMarker), false);

    const bytes = readFileSync(databasePath(dataDir));
    for (const marker of [rawMarker, credentialMarker, 'tool_response', 'transcript_path', 'prompt', 'user_email']) {
      assert.equal(bytes.includes(Buffer.from(marker)), false, marker);
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('keeps project configuration passive and fails open when the build wrapper is unavailable', () => {
  const cursor = JSON.parse(readFileSync('.cursor/hooks.json', 'utf8')) as { hooks: Record<string, unknown> };
  const codex = JSON.parse(readFileSync('.codex/hooks.json', 'utf8')) as { hooks: Record<string, unknown> };
  const configuration = JSON.stringify({ cursor, codex });
  for (const forbidden of ['UserPromptSubmit', 'beforeSubmitPrompt', 'PermissionRequest', 'permissionDecision', 'prompt']) {
    assert.equal(configuration.includes(forbidden), false, forbidden);
  }

  const temporaryRepository = mkdtempSync(join(tmpdir(), 'ael-missing-build-'));
  try {
    assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: temporaryRepository }).status, 0);
    const wrapperDirectory = join(temporaryRepository, '.agents', 'hooks');
    mkdirSync(wrapperDirectory, { recursive: true });
    const wrapper = readFileSync('.agents/hooks/ael-passive-capture.sh');
    const wrapperPath = join(wrapperDirectory, 'ael-passive-capture.sh');
    writeFileSync(wrapperPath, wrapper);
    chmodSync(wrapperPath, 0o755);

    const result = spawnSync('/bin/sh', [wrapperPath, 'codex'], {
      cwd: temporaryRepository,
      input: JSON.stringify(codexPayload('SessionStart')),
      encoding: 'utf8'
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'AEL_CAPTURE_UNAVAILABLE: Passive capture skipped.\n');
  } finally {
    rmSync(temporaryRepository, { recursive: true, force: true });
  }
});
