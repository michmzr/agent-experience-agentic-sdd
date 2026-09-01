import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { SessionId } from '../src/domain/types.js';
import { ExperienceStore } from '../src/storage/experience-store.js';

test('registers only passive technical and session hooks', () => {
  const cursor = JSON.parse(readFileSync('.cursor/hooks.json', 'utf8')) as { version: number; hooks: Record<string, Array<{ command: string }>> };
  const codex = JSON.parse(readFileSync('.codex/hooks.json', 'utf8')) as {
    description: string;
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
  };

  assert.equal(cursor.version, 1);
  assert.deepEqual(Object.keys(cursor.hooks).sort(), [
    'postToolUse', 'preToolUse', 'sessionEnd', 'sessionStart'
  ]);
  assert.deepEqual(Object.keys(codex.hooks).sort(), [
    'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart'
  ]);
  assert.equal(codex.hooks.SessionStart?.[0]?.matcher, 'startup');
  assert.equal(codex.hooks.PreToolUse?.[0]?.matcher, 'Bash|apply_patch|mcp__.*');
  assert.equal(codex.hooks.PostToolUse?.[0]?.matcher, 'Bash|apply_patch|mcp__.*');
  assert.equal(JSON.stringify({ cursor, codex }).includes('Prompt'), false);
  assert.equal(JSON.stringify({ cursor, codex }).includes('beforeSubmitPrompt'), false);

  const codexCommand = '"$(git rev-parse --show-toplevel)/.agents/hooks/ael-passive-capture.sh" codex';
  assert.deepEqual(
    Object.values(codex.hooks).flatMap((groups) => groups.flatMap(({ hooks }) => hooks.map(({ command }) => command))),
    Array.from({ length: 4 }, () => codexCommand)
  );
  assert.deepEqual(
    Object.values(cursor.hooks).flatMap((groups) => groups.map(({ command }) => command)),
    Array.from({ length: 4 }, () => '.agents/hooks/ael-passive-capture.sh cursor')
  );
});

test('uses one fail-open wrapper without permission output', () => {
  const wrapper = readFileSync('.agents/hooks/ael-passive-capture.sh', 'utf8');
  assert.match(wrapper, /^#!\/bin\/sh\n/);
  assert.match(wrapper, /git rev-parse --show-toplevel/);
  assert.match(wrapper, /cli="\$repository_root\/dist\/src\/cli\.js"/);
  assert.match(wrapper, /capture hook --source/);
  assert.doesNotMatch(wrapper.toLowerCase(), /deny|ask|block|permissiondecision/);
  assert.equal(statSync('.agents/hooks/ael-passive-capture.sh').mode & 0o111, 0o111);
});

test('resolves the Codex wrapper from a repository subdirectory', () => {
  const codex = JSON.parse(readFileSync('.codex/hooks.json', 'utf8')) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
  const command = codex.hooks.SessionStart?.[0]?.hooks[0]?.command;
  assert.equal(typeof command, 'string');

  const dataDirectory = mkdtempSync(join(tmpdir(), 'ael-project-hook-'));
  try {
    const probe = spawnSync('/bin/sh', ['-c', command!], {
      cwd: join(process.cwd(), 'test'),
      env: { ...process.env, AEL_DATA_DIR: dataDirectory },
      input: JSON.stringify({ session_id: 'configuration-probe', hook_event_name: 'SessionStart', source: 'startup' }),
      encoding: 'utf8'
    });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout, '');
    assert.equal(probe.stderr, '');
    const store = new ExperienceStore(join(dataDirectory, 'experience.sqlite'));
    try {
      assert.equal(store.loadSession('configuration-probe' as SessionId)?.source, 'codex');
    } finally { store.close(); }
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('uses a supported Node when hook PATH only contains git', () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'ael-project-hook-node-'));
  try {
    const probe = spawnSync('/bin/sh', ['.agents/hooks/ael-passive-capture.sh', 'codex'], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: '/usr/bin', AEL_DATA_DIR: dataDirectory },
      input: JSON.stringify({ session_id: 'node-path-probe', hook_event_name: 'SessionStart', source: 'startup' }),
      encoding: 'utf8'
    });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout, '');
    assert.equal(probe.stderr, '');
    const store = new ExperienceStore(join(dataDirectory, 'experience.sqlite'));
    try {
      assert.equal(store.loadSession('node-path-probe' as SessionId)?.source, 'codex');
    } finally { store.close(); }
  } finally { rmSync(dataDirectory, { recursive: true, force: true }); }
});
