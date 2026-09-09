import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { installHooks, parseHookSelection, verifyInstalledHooks } from '../src/cli/hook-installation.js';
import { initializeGitRepository } from './helpers/git-repository.js';

function temporaryRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'ael-hook-install-'));
  initializeGitRepository(root);
  return root;
}

test('parses one or both explicit hook selections', () => {
  assert.deepEqual(parseHookSelection('codex'), ['codex']);
  assert.deepEqual(parseHookSelection('cursor,codex'), ['codex', 'cursor']);
  assert.throws(() => parseHookSelection(''), /at least one/i);
  assert.throws(() => parseHookSelection('codex,unknown'), /codex or cursor/i);
});

test('installs selected hooks without changing unrelated configuration', () => {
  const root = temporaryRepository();
  const cliEntrypoint = join(process.cwd(), 'dist', 'src', 'cli.js');
  const codexPath = join(root, '.codex', 'hooks.json');
  try {
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(codexPath, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'existing' }] }] } }));
    const before = readFileSync(codexPath, 'utf8');

    installHooks({ repositoryRoot: root, sources: ['cursor'], cliEntrypoint });

    assert.equal(readFileSync(codexPath, 'utf8'), before);
    const cursor = JSON.parse(readFileSync(join(root, '.cursor', 'hooks.json'), 'utf8')) as { hooks: Record<string, unknown[]> };
    assert.deepEqual(Object.keys(cursor.hooks).sort(), ['postToolUse', 'preToolUse', 'sessionEnd', 'sessionStart']);
    assert.equal(statSync(join(root, '.agents', 'hooks', 'ael-passive-capture.sh')).mode & 0o111, 0o111);
    assert.deepEqual(verifyInstalledHooks({ repositoryRoot: root, sources: ['cursor'], cliEntrypoint }), {
      status: 'ready', sources: [{ source: 'cursor', status: 'ready' }]
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('does not mutate files when an existing hook configuration is malformed', () => {
  const root = temporaryRepository();
  const cursorPath = join(root, '.cursor', 'hooks.json');
  try {
    mkdirSync(join(root, '.cursor'), { recursive: true });
    writeFileSync(cursorPath, '{broken');
    assert.throws(() => installHooks({ repositoryRoot: root, sources: ['cursor'], cliEntrypoint: '/tmp/ael-cli.js' }), /JSON|configuration/i);
    assert.equal(readFileSync(cursorPath, 'utf8'), '{broken');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('updates an existing AEL command without removing its matcher or timeout', () => {
  const root = temporaryRepository();
  const cliEntrypoint = join(process.cwd(), 'dist', 'src', 'cli.js');
  const codexPath = join(root, '.codex', 'hooks.json');
  try {
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(codexPath, JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: '"$(git rev-parse --show-toplevel)/.agents/hooks/ael-passive-capture.sh" codex' }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: '"$(git rev-parse --show-toplevel)/.agents/hooks/ael-passive-capture.sh" codex', timeout: 3 }] }]
      }
    }));

    installHooks({ repositoryRoot: root, sources: ['codex'], cliEntrypoint, repositoryId: 'repo-id' });

    const codex = JSON.parse(readFileSync(codexPath, 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>>;
    };
    assert.equal(codex.hooks.SessionStart?.[0]?.matcher, 'startup');
    assert.equal(codex.hooks.SessionEnd?.[0]?.hooks[0]?.timeout, 3);
    assert.equal(codex.hooks.SessionStart?.[0]?.hooks[0]?.command, `"${join(root, '.agents/hooks/ael-passive-capture.sh')}" codex`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('accepts the canonical Git-root AEL command used by a development checkout', () => {
  const root = temporaryRepository();
  const cliEntrypoint = join(process.cwd(), 'dist', 'src', 'cli.js');
  try {
    installHooks({ repositoryRoot: root, sources: ['codex'], cliEntrypoint });
    const codexPath = join(root, '.codex', 'hooks.json');
    const codex = JSON.parse(readFileSync(codexPath, 'utf8')) as { hooks: Record<string, unknown> };
    const serialized = JSON.stringify(codex).replaceAll(
      `\\"${join(root, '.agents/hooks/ael-passive-capture.sh')}\\" codex`,
      '\\"$(git rev-parse --show-toplevel)/.agents/hooks/ael-passive-capture.sh\\" codex'
    );
    writeFileSync(codexPath, serialized);

    assert.deepEqual(verifyInstalledHooks({ repositoryRoot: root, sources: ['codex'], cliEntrypoint }), {
      status: 'ready', sources: [{ source: 'codex', status: 'ready' }]
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
