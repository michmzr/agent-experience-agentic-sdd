import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { hasQualifiedCodexExecArguments, spawnVerifiedCodexExec } from '../src/host/codex-cli-launcher.js';

function qualifiedArgs(cwd: string): string[] {
  return ['-a', 'never', 'exec', '--json', '--ephemeral', '--ignore-user-config',
    '-m', 'gpt-6-sol', '-C', cwd, '-s', 'workspace-write', 'Run the controlled task.'];
}

test('AAP-A4 only explicit never approval with JSON ephemeral exec qualifies', () => {
  const args = qualifiedArgs('/private/tmp/aap-task');
  assert.equal(hasQualifiedCodexExecArguments(args), true);
  assert.equal(hasQualifiedCodexExecArguments(args.slice(2)), false);
  assert.equal(hasQualifiedCodexExecArguments(['-a', 'on-request', ...args.slice(2)]), false);
  assert.equal(hasQualifiedCodexExecArguments([...args.slice(0, -1), '-c', 'approval_policy="on-request"', args.at(-1)!]), false);
  assert.equal(hasQualifiedCodexExecArguments([...args.slice(0, -1), '--config', 'approval_policy="on-request"', args.at(-1)!]), false);
  assert.equal(hasQualifiedCodexExecArguments([...args.slice(0, -1), '--json', args.at(-1)!]), false);
  assert.equal(hasQualifiedCodexExecArguments([...args.slice(0, -1), '-s', 'read-only', args.at(-1)!]), false);
  assert.equal(hasQualifiedCodexExecArguments([...args.slice(0, -1), '--skip-git-repo-check', args.at(-1)!]), false);
  assert.equal(hasQualifiedCodexExecArguments([...args.slice(0, -1), '--dangerously-bypass-approvals-and-sandbox', args.at(-1)!]), false);
});

test('AAP-A4 fake codex binary with a matching name cannot launch or mint provenance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-fake-codex-'));
  const fake = join(root, 'codex');
  const marker = join(root, 'executed');
  try {
    writeFileSync(fake, `#!/bin/sh\nprintf invoked > '${marker}'\nprintf 'codex-cli 0.157.1\\n'\n`);
    chmodSync(fake, 0o700);
    await assert.rejects(spawnVerifiedCodexExec({ binaryPath: fake, cwd: root,
      args: qualifiedArgs(root) }), /digest mismatch/i);
    await assert.rejects(spawnVerifiedCodexExec({ binaryPath: fake, cwd: root,
      args: qualifiedArgs(join(root, 'other')) }), /arguments are invalid/i);
    await assert.rejects(spawnVerifiedCodexExec({ binaryPath: fake, cwd: root,
      args: ['-a', 'on-request', ...qualifiedArgs(root).slice(2)] }), /arguments are invalid/i);
    await assert.rejects(spawnVerifiedCodexExec({ binaryPath: fake, cwd: root,
      args: qualifiedArgs(root).slice(2) }), /arguments are invalid/i);
    assert.equal(existsSync(marker), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
