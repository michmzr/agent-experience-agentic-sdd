import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { runCliAsync } from '../src/cli.js';
import { ExperienceStore } from '../src/storage/experience-store.js';
import { resolveRepository } from '../src/repository/local-repository.js';

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
    assert.equal(readSession(dataDir, 'session-1')?.source, 'codex');
    assert.equal(readSession(dataDir, 'session-1')?.repositoryId, resolveRepository(process.cwd())?.id);
  } finally {
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
    assert.equal(storedSessionSource(dataDir), 'cursor');
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
    for (const hookInput of [
      '{not-json',
      JSON.stringify({
        session_id: 'session-1', cwd: '/work/repo', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tool-1',
        tool_input: { command: `curl --token=${marker}` }
      }),
      'x'.repeat(65_537)
    ]) {
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
    }
  } finally {
    for (const dataDir of dataDirectories) rmSync(dataDir, { recursive: true, force: true });
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

  assert.deepEqual(await runCliAsync(['unknown'], { hookInput: '{not-json', now }), {
    exitCode: 2,
    stdout: '',
    stderr: 'INVALID_SYNTAX: Unknown command.\n'
  });
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
    assert.deepEqual(result, {
      exitCode: 0,
      stdout: '',
      stderr: 'AEL_CAPTURE_PERSISTENCE_FAILED: Passive capture skipped.\n'
    });
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
      assert.deepEqual(result, {
        exitCode: 0,
        stdout: '',
        stderr: 'AEL_CAPTURE_PERSISTENCE_FAILED: Passive capture skipped.\n'
      });
    }

    const descriptorsAfter = readdirSync('/dev/fd').length;
    assert.ok(descriptorsAfter <= descriptorsBefore + 1, `open descriptors grew from ${descriptorsBefore} to ${descriptorsAfter}`);
  } finally {
    blocker.exec('ROLLBACK');
    blocker.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
