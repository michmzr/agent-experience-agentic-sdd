import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import type { CliContextPrompt } from '../src/cli/context-prompt.js';
import { runCliAsync } from '../src/cli.js';
import { removeTemporaryDirectory } from '../src/cli/temporary-directory.js';

const temporaryDirectories: string[] = [];

after(async () => {
  for (const directory of temporaryDirectories.reverse()) await removeTemporaryDirectory(directory);
});

test('prompts once for missing human context and resolves the selected workspace', async () => {
  const workingDirectory = temporaryDirectory('ael-prompt-working-');
  const selectedWorkspace = temporaryDirectory('ael-prompt-selected-');
  const dataDirectory = temporaryDirectory('ael-prompt-data-');
  configureWorkspace(selectedWorkspace, 'selected-workspace');
  const probe = promptProbe(selectedWorkspace);

  const result = await runCliAsync(
    ['unregister', '--data-dir', dataDirectory],
    { workingDirectory, contextPrompt: probe.prompt }
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, 'Repository selected-workspace was not registered.\n');
  assert.deepEqual(probe.requests, ['Repository or workspace path: ']);
});

test('never prompts for JSON or a noninteractive human invocation', async () => {
  const workingDirectory = temporaryDirectory('ael-prompt-bypass-');
  const dataDirectory = temporaryDirectory('ael-prompt-bypass-data-');
  const jsonProbe = promptProbe('/unexpected');
  const plainProbe = promptProbe('/unexpected', false);

  const json = await runCliAsync(
    ['unregister', '--json', '--data-dir', dataDirectory],
    { workingDirectory, contextPrompt: jsonProbe.prompt }
  );
  const plain = await runCliAsync(
    ['unregister', '--data-dir', dataDirectory],
    { workingDirectory, contextPrompt: plainProbe.prompt }
  );

  assert.equal(json.exitCode, 1);
  assert.equal(JSON.parse(json.stdout).error.code, 'CONTEXT_REQUIRED');
  assert.equal(plain.exitCode, 1);
  assert.deepEqual(jsonProbe.requests, []);
  assert.deepEqual(plainProbe.requests, []);
});

test('returns exit 130 when interactive context selection is cancelled', async () => {
  const workingDirectory = temporaryDirectory('ael-prompt-cancel-');
  const probe = promptProbe(undefined);

  const result = await runCliAsync(['unregister'], { workingDirectory, contextPrompt: probe.prompt });

  assert.deepEqual(result, { exitCode: 130, stdout: '', stderr: '' });
  assert.equal(probe.requests.length, 1);
});

test('returns one bounded context error for an unresolved selected path', async () => {
  const workingDirectory = temporaryDirectory('ael-prompt-invalid-');
  const unresolved = temporaryDirectory('ael-prompt-unresolved-');
  const probe = promptProbe(unresolved);

  const result = await runCliAsync(['unregister'], { workingDirectory, contextPrompt: probe.prompt });

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^CONTEXT_REQUIRED: /);
  assert.deepEqual(probe.requests, ['Repository or workspace path: ']);
});

test('does not route passive capture through the context prompt', async () => {
  const dataDirectory = temporaryDirectory('ael-prompt-hook-data-');
  const probe = promptProbe('/unexpected');

  const result = await runCliAsync(
    ['capture', 'hook', '--source', 'codex', '--data-dir', dataDirectory],
    { hookInput: '{invalid', contextPrompt: probe.prompt }
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(probe.requests, []);
});

interface PromptProbe {
  readonly prompt: CliContextPrompt;
  readonly requests: string[];
}

function promptProbe(answer: string | undefined, interactive = true): PromptProbe {
  const requests: string[] = [];
  return {
    requests,
    prompt: {
      interactive,
      async readContextPath(message) {
        requests.push(message);
        return answer;
      }
    }
  };
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function configureWorkspace(root: string, workspaceId: string): void {
  mkdirSync(join(root, '.ael'));
  writeFileSync(join(root, '.ael', 'workspace.json'), `${JSON.stringify({ version: 1, workspaceId })}\n`);
}
