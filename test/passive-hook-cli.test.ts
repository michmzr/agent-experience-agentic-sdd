import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { runCliAsync } from '../src/cli.js';
import { loadProjectSettings } from '../src/config/project-settings.js';
import { ExperienceStore } from '../src/storage/experience-store.js';
import { resolveRepository } from '../src/repository/local-repository.js';
import { CaptureSpool } from '../src/capture/spool.js';

const now = () => '2026-08-26T08:00:00.000Z';

function temporaryDataDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'ael-hook-cli-'));
}

function readSession(dataDir: string, id: string) {
  const store = new ExperienceStore(join(dataDir, 'experience.sqlite'));
  try {
    return store.loadSession(id as never);
  } finally {
    store.close();
  }
}

function storedSessionSource(dataDir: string): string | undefined {
  const database = new DatabaseSync(join(dataDir, 'experience.sqlite'));
  try {
    return (database.prepare('SELECT source FROM sessions').get() as { source?: string } | undefined)?.source;
  } finally {
    database.close();
  }
}

async function waitFor<T>(dataDir: string, read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + loadProjectSettings(process.cwd()).captureDeliveryDeadlineMs;
  do {
    try {
      const value = read();
      if (value !== undefined && captureDrainIsIdle(dataDir)) return value;
    } catch {
      // A detached drain may briefly hold the primary database migration lock.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() <= deadline);
  assert.fail('Capture was not delivered before the configured deadline.');
}

function captureDrainIsIdle(dataDir: string): boolean {
  const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
  try {
    const status = spool.status();
    return status.pending === 0 && status.claimed === 0;
  } finally { spool.close(); }
}

test('captures a Codex hook with empty stdout and exit zero', async () => {
  const dataDir = temporaryDataDirectory();
  try {
    const result = await runCliAsync(
      ['capture', 'hook', '--source', 'codex', '--data-dir', dataDir],
      {
        hookInput: JSON.stringify({
          session_id: 'session-1', cwd: '/work/repo', hook_event_name: 'SessionStart', source: 'startup'
        }),
        now
      }
    );

    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    const session = await waitFor(dataDir, () => readSession(dataDir, 'session-1'));
    assert.equal(session.source, 'codex');
    assert.equal(session.repositoryId, resolveRepository(process.cwd())?.id);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('keeps the passive hook protocol when options precede the command', async () => {
  const dataDir = temporaryDataDirectory();
  try {
    const result = await runCliAsync(
      ['--data-dir', dataDir, 'capture', 'hook', '--source', 'codex'],
      {
        hookInput: JSON.stringify({
          session_id: 'option-first-session', cwd: '/work/repo', hook_event_name: 'SessionStart', source: 'startup'
        }),
        now
      }
    );

    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    const session = await waitFor(dataDir, () => readSession(dataDir, 'option-first-session'));
    assert.equal(session.source, 'codex');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('attributes a non-Git workspace hook to the identifier supplied by its wrapper', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ael-hook-workspace-'));
  const dataDir = temporaryDataDirectory();
  try {
    const result = await runCliAsync(
      ['capture', 'hook', '--source', 'codex', '--repository-id', 'secondbrain', '--data-dir', dataDir],
      {
        workingDirectory: workspace,
        hookInput: JSON.stringify({
          session_id: 'workspace-session', cwd: workspace, hook_event_name: 'SessionStart', source: 'startup'
        }),
        now
      }
    );

    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    const session = await waitFor(dataDir, () => readSession(dataDir, 'workspace-session'));
    assert.equal(session.repositoryId, 'secondbrain');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('dispatches Cursor hooks and ignores nontechnical events', async () => {
  const dataDir = temporaryDataDirectory();
  try {
    const ignored = await runCliAsync(
      ['capture', 'hook', '--source', 'cursor', '--data-dir', dataDir],
      { hookInput: JSON.stringify({ conversation_id: 'session-1', hook_event_name: 'beforeSubmitPrompt', prompt: 'private' }), now }
    );
    assert.deepEqual(ignored, { exitCode: 0, stdout: '', stderr: '' });

    const captured = await runCliAsync(
      ['capture', 'hook', '--source', 'cursor', '--data-dir', dataDir],
      { hookInput: JSON.stringify({ conversation_id: 'session-1', hook_event_name: 'sessionStart' }), now }
    );
    assert.deepEqual(captured, { exitCode: 0, stdout: '', stderr: '' });
    assert.equal(await waitFor(dataDir, () => storedSessionSource(dataDir)), 'cursor');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('keeps Cursor hooks fail-open when workspace scope resolution fails', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ael-hook-invalid-workspace-'));
  const dataDir = temporaryDataDirectory();
  try {
    mkdirSync(join(workspace, '.ael'));
    writeFileSync(join(workspace, '.ael', 'workspace.json'), '{broken');
    const result = await runCliAsync(
      ['capture', 'hook', '--source', 'cursor', '--data-dir', dataDir],
      { workingDirectory: workspace, hookInput: JSON.stringify({ conversation_id: 'session-1', hook_event_name: 'sessionStart' }), now }
    );
    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: 'AEL_CAPTURE_INVALID_INPUT: Passive capture skipped.\n' });
    assert.equal(result.stderr.includes(workspace), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('fails open with bounded generic diagnostics for invalid and private input', async () => {
  const marker = 'classified-private-value';
  const dataDirectories: string[] = [];
  try {
    for (const [hookInput, disposition] of [
      ['{not-json', 'malformed-envelope'],
      [JSON.stringify({
        session_id: 'session-1', cwd: '/work/repo', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tool-1',
        tool_input: { command: `curl --token=${marker}` }
      }), 'privacy-redaction'],
      ['x'.repeat(65_537), 'malformed-envelope']
    ] as const) {
      const dataDir = temporaryDataDirectory();
      dataDirectories.push(dataDir);
      const result = await runCliAsync(
        ['capture', 'hook', '--source', 'codex', '--data-dir', dataDir],
        { hookInput, now }
      );
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^AEL_CAPTURE_[A-Z_]+: Passive capture skipped\.\n$/);
      assert.equal(result.stderr.includes(marker), false);
      const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
      try {
        assert.equal(spool.receiptReport().byDisposition[disposition], 1);
        assert.equal(JSON.stringify(spool.receiptReport()).includes(marker), false);
      } finally { spool.close(); }
    }
  } finally {
    for (const dataDir of dataDirectories) rmSync(dataDir, { recursive: true, force: true });
  }
});

test('retains generic private-error and persistence-error fallback classification', async () => {
  const dataDir = temporaryDataDirectory();
  const workspace = mkdtempSync(join(tmpdir(), 'ael-hook-fallback-workspace-'));
  const regularFile = join(workspace, 'not-a-directory');
  writeFileSync(regularFile, 'fixture');
  try {
    const privateFailure = await runCliAsync(
      ['capture', 'hook', '--source', 'cursor', '--data-dir', dataDir],
      {
        workingDirectory: workspace,
        hookInput: JSON.stringify({ conversation_id: 'private-fallback-session', hook_event_name: 'sessionStart' }),
        now: () => { throw new Error('credential lookup failed'); },
        humanOutput: { color: true }
      }
    );
    assert.deepEqual(privateFailure, {
      exitCode: 0,
      stdout: '',
      stderr: 'AEL_CAPTURE_PRIVATE_INPUT: Passive capture skipped.\n'
    });

    const persistenceFailure = await runCliAsync(
      ['capture', 'hook', '--source', 'cursor', '--data-dir', dataDir],
      {
        workingDirectory: regularFile,
        hookInput: JSON.stringify({ conversation_id: 'file-fallback-session', hook_event_name: 'sessionStart' }),
        now
      }
    );
    assert.deepEqual(persistenceFailure, {
      exitCode: 0,
      stdout: '',
      stderr: 'AEL_CAPTURE_PERSISTENCE_FAILED: Passive capture skipped.\n'
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('fails open for missing or unsupported sources while preserving ordinary syntax errors', async () => {
  const dataDirectories = [temporaryDataDirectory(), temporaryDataDirectory()];
  try {
    for (const args of [
      ['capture', 'hook', '--data-dir', dataDirectories[0]!],
      ['capture', 'hook', '--source', 'claude-code', '--data-dir', dataDirectories[1]!]
    ]) {
      const result = await runCliAsync(args, { hookInput: '{}', now });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^AEL_CAPTURE_INVALID_INPUT: Passive capture skipped\.\n$/);
    }
  } finally {
    for (const dataDir of dataDirectories) rmSync(dataDir, { recursive: true, force: true });
  }

  const ordinary = await runCliAsync(['unknown'], { hookInput: '{not-json', now });
  assert.equal(ordinary.exitCode, 2);
  assert.equal(ordinary.stdout, '');
  assert.match(ordinary.stderr, /^Error  \[failed\]$/m);
  assert.match(ordinary.stderr, /^Code\s+INVALID_SYNTAX$/m);
});

test('maps persistence failures to a generic fail-open diagnostic', async () => {
  const dataDir = temporaryDataDirectory();
  const notDirectory = join(dataDir, 'not-a-directory');
  writeFileSync(notDirectory, 'file');
  const result = await runCliAsync(
    ['capture', 'hook', '--source', 'codex', '--data-dir', notDirectory],
    {
      hookInput: JSON.stringify({ session_id: 'session-1', hook_event_name: 'SessionStart', source: 'startup' }),
      now
    }
  );
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: '',
    stderr: 'AEL_CAPTURE_PERSISTENCE_FAILED: Passive capture skipped.\n'
  });
  rmSync(dataDir, { recursive: true, force: true });
});

test('fails open promptly when the hook database is busy', async () => {
  const dataDir = temporaryDataDirectory();
  const databasePath = join(dataDir, 'experience.sqlite');
  const initialized = new ExperienceStore(databasePath);
  initialized.close();
  const blocker = new DatabaseSync(databasePath);
  blocker.exec('BEGIN IMMEDIATE');
  const startedAt = Date.now();
  try {
    const result = await runCliAsync(
      ['capture', 'hook', '--source', 'codex', '--data-dir', dataDir],
      {
        hookInput: JSON.stringify({ session_id: 'locked-session', hook_event_name: 'SessionStart', source: 'startup' }),
        now
      }
    );
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs < 1_000, `hook lock handling took ${elapsedMs}ms`);
    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
  } finally {
    blocker.exec('ROLLBACK');
    blocker.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('closes failed hook store migrations instead of leaking database connections', async () => {
  const dataDir = temporaryDataDirectory();
  const databasePath = join(dataDir, 'experience.sqlite');
  const initialized = new ExperienceStore(databasePath);
  initialized.close();
  const blocker = new DatabaseSync(databasePath);
  blocker.exec('BEGIN IMMEDIATE');
  const descriptorsBefore = readdirSync('/dev/fd').length;
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = await runCliAsync(
        ['capture', 'hook', '--source', 'codex', '--data-dir', dataDir],
        {
          hookInput: JSON.stringify({ session_id: `locked-session-${attempt}`, hook_event_name: 'SessionStart', source: 'startup' }),
          now
        }
      );
      assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    }

    const descriptorsAfter = readdirSync('/dev/fd').length;
    assert.ok(descriptorsAfter <= descriptorsBefore + 1, `open descriptors grew from ${descriptorsBefore} to ${descriptorsAfter}`);
  } finally {
    blocker.exec('ROLLBACK');
    blocker.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
