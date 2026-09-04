import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { runCli, runCliAsync, type CliResult } from '../src/cli.js';
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
      const captured = store.listCapturedEventsPage().entries;
      assert.deepEqual(captured.map((event) => ({
        source: event.source,
        phase: event.phase,
        outcome: event.outcome
      })), [
        { source: 'codex', phase: 'pre-action', outcome: undefined },
        { source: 'codex', phase: 'post-result', outcome: 'unknown' },
        { source: 'cursor', phase: 'pre-action', outcome: undefined },
        { source: 'cursor', phase: 'post-result', outcome: 'unknown' }
      ]);
      const cursorSessionIds = captured.filter(({ source }) => source === 'cursor').map(({ sessionId }) => sessionId);
      assert.equal(new Set(cursorSessionIds).size, 1);
      assert.match(cursorSessionIds[0]!, /^[a-f0-9]{64}$/);
      assert.notEqual(cursorSessionIds[0], 'cursor-session');
      assert.equal(store.loadSession('codex-session' as SessionId)?.endedAt, endTime);
      assert.equal(store.loadSession(cursorSessionIds[0]!)?.endedAt, endTime);
      assert.deepEqual(store.listCandidatesPage().entries, []);
      assert.deepEqual(store.listEvidencePage().entries, []);
      assert.deepEqual(store.listKnowledge(), []);
    } finally {
      store.close();
    }

    const database = new DatabaseSync(databasePath(dataDir));
    try {
      const migration = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number };
      assert.equal(migration.version, 13);
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

test('keeps non-Git workspace capture diagnostics scope-scoped and private', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ael-workspace-acceptance-'));
  const dataDir = dataDirectory();
  const rawCommand = 'git status --short';
  const promptMarker = 'workspace-prompt-marker-acceptance';
  const credentialMarker = 'classified-credential-marker-acceptance';
  const acceptedSessionMarker = 'workspace-accepted-session-marker-acceptance';
  const rejectedSessionMarker = 'workspace-rejected-session-marker-acceptance';
  try {
    const started = await runCliAsync(
      ['capture', 'hook', '--source', 'cursor', '--data-dir', dataDir],
      {
        workingDirectory: workspace,
        now: () => startTime,
        hookInput: JSON.stringify({
          conversation_id: acceptedSessionMarker,
          cwd: workspace,
          hook_event_name: 'sessionStart'
        })
      }
    );
    assert.deepEqual(started, { exitCode: 0, stdout: '', stderr: '' });

    const supported = await runCliAsync(
      ['capture', 'hook', '--source', 'cursor', '--data-dir', dataDir],
      {
        workingDirectory: workspace,
        now: () => eventTime,
        hookInput: JSON.stringify({
          conversation_id: acceptedSessionMarker,
          cwd: workspace,
          hook_event_name: 'preToolUse',
          tool_name: 'Shell',
          tool_use_id: 'workspace-supported-tool',
          tool_input: { command: rawCommand },
          prompt: promptMarker
        })
      }
    );
    assert.deepEqual(supported, { exitCode: 0, stdout: '', stderr: '' });

    const rejected = await runCliAsync(
      ['capture', 'hook', '--source', 'cursor', '--data-dir', dataDir],
      {
        workingDirectory: workspace,
        now: () => postTime,
        hookInput: JSON.stringify({
          conversation_id: rejectedSessionMarker,
          cwd: workspace,
          hook_event_name: 'preToolUse',
          tool_name: 'Shell',
          tool_use_id: 'workspace-rejected-tool',
          tool_input: { command: `curl --token=${credentialMarker}` },
          prompt: promptMarker
        })
      }
    );
    assert.deepEqual(rejected, {
      exitCode: 0,
      stdout: '',
      stderr: 'AEL_CAPTURE_PRIVATE_INPUT: Passive capture skipped.\n'
    });

    const hooks = runCli(['hooks', 'diagnostics', '--data-dir', dataDir, '--json'], { workingDirectory: workspace });
    const inspection = runCli(['experience', 'inspect', '--data-dir', dataDir, '--json'], { workingDirectory: workspace });
    assert.equal(hooks.exitCode, 0, hooks.stderr);
    assert.equal(inspection.exitCode, 0, inspection.stderr);
    assert.deepEqual(JSON.parse(hooks.stdout), JSON.parse(inspection.stdout));

    const report = JSON.parse(hooks.stdout) as {
      readonly scope: { readonly kind: string; readonly id: string };
      readonly counts: Record<string, number>;
    };
    const workspaceId = JSON.parse(readFileSync(join(workspace, '.ael', 'workspace.json'), 'utf8')).workspaceId;
    assert.deepEqual(report.scope, { kind: 'workspace', id: workspaceId });
    assert.deepEqual(report.counts, {
      'invalid-working-directory': 0,
      'persistence-failure': 0,
      'unsafe-command-shape': 1,
      'unsupported-tool': 0
    });

    const store = new ExperienceStore(databasePath(dataDir));
    try {
      const captured = store.listCapturedEventsPage().entries;
      assert.equal(captured.length, 1);
      assert.equal(captured[0]?.signature.path, workspace);
    } finally {
      store.close();
    }

    const markers = [rawCommand, promptMarker, credentialMarker, acceptedSessionMarker, rejectedSessionMarker];
    const outputs = [started.stdout, started.stderr, supported.stdout, supported.stderr, rejected.stdout, rejected.stderr, hooks.stdout, hooks.stderr, inspection.stdout, inspection.stderr];
    for (const marker of markers) {
      assert.equal(readFileSync(databasePath(dataDir)).includes(Buffer.from(marker)), false, `experience SQLite contains ${marker}`);
      assert.equal(readFileSync(join(dataDir, 'capture-diagnostics.sqlite')).includes(Buffer.from(marker)), false, `diagnostic SQLite contains ${marker}`);
      for (const output of outputs) assert.equal(output.includes(marker), false, `CLI output contains ${marker}`);
    }
    for (const output of outputs) assert.equal(output.includes(workspace), false, 'CLI output contains the technical event path');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
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
