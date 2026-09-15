import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';

import { createProcessContextPrompt, type CliContextPrompt } from '../src/cli/context-prompt.js';
import { runCli, runCliAsync } from '../src/cli.js';
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
  assert.match(result.stdout, /^Repository registration  \[not registered\]/);
  assert.match(result.stdout, /^Repository\s+selected-workspace$/m);
  assert.deepEqual(probe.requests, [`Repository or workspace path [${workingDirectory}]: `]);
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
  assert.match(result.stderr, /^Error  \[failed\]$/m);
  assert.match(result.stderr, /^Code\s+CONTEXT_REQUIRED$/m);
  assert.deepEqual(probe.requests, [`Repository or workspace path [${workingDirectory}]: `]);
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

test('parses option-first commands before deciding whether to prompt', async () => {
  const workingDirectory = temporaryDirectory('ael-prompt-option-first-');
  const selectedWorkspace = temporaryDirectory('ael-prompt-option-first-selected-');
  const dataDirectory = temporaryDirectory('ael-prompt-option-first-data-');
  configureWorkspace(selectedWorkspace, 'option-first-workspace');
  const probe = promptProbe(selectedWorkspace);

  const result = await runCliAsync(
    ['--data-dir', dataDirectory, 'unregister'],
    { workingDirectory, contextPrompt: probe.prompt }
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /^Repository\s+option-first-workspace$/m);
  assert.equal(probe.requests.length, 1);
});

test('escapes terminal control characters in the displayed working directory', async () => {
  const workingDirectory = temporaryDirectory('ael-prompt-control-\u001b\u009b\nspoofed-');
  const probe = promptProbe(undefined);

  const result = await runCliAsync(['unregister'], { workingDirectory, contextPrompt: probe.prompt });

  assert.equal(result.exitCode, 130);
  assert.deepEqual(probe.requests, [
    `Repository or workspace path [${workingDirectory.replace('\u001b', '\\u001b').replace('\u009b', '\\u009b').replace('\n', '\\u000a')}]: `
  ]);
  assert.equal(probe.requests[0]?.includes('\u001b'), false);
  assert.equal(probe.requests[0]?.includes('\u009b'), false);
  assert.equal(probe.requests[0]?.includes('\n'), false);
});

test('validates the command form before prompting for context', async () => {
  const workingDirectory = temporaryDirectory('ael-prompt-invalid-command-');
  const probe = promptProbe(undefined);

  const result = await runCliAsync(['unregister', 'extra'], { workingDirectory, contextPrompt: probe.prompt });

  assert.equal(result.exitCode, 2);
  assert.deepEqual(probe.requests, []);
});

test('validates non-context options before prompting', async () => {
  const workingDirectory = temporaryDirectory('ael-prompt-invalid-options-');
  for (const args of [
    ['knowledge', 'promote'],
    ['knowledge', 'refresh-runtime'],
    ['status', '--schema-version', '1'],
    ['export', '--scope', 'repo', '--format', 'xml']
  ]) {
    const probe = promptProbe(undefined);
    const result = await runCliAsync(args, { workingDirectory, contextPrompt: probe.prompt });

    assert.equal(result.exitCode, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.deepEqual(probe.requests, []);
  }
});

test('treats terminal EOF as prompt cancellation', async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  const output = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = true;
  output.isTTY = true;
  const prompt = createProcessContextPrompt({ input, output });

  const answer = prompt.readContextPath('Repository or workspace path: ');
  input.end();

  assert.equal(await answer, undefined);
});

test('recommends the context option accepted by the failing command', () => {
  const workingDirectory = temporaryDirectory('ael-prompt-next-step-');

  const result = runCli(['runtime', 'config', 'explain'], { workingDirectory });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /^Next step\s+Run `ael init` in the workspace or pass --workspace\.$/m);
  assert.equal(result.stderr.includes('--repository-id'), false);
});

test('recommends a valid recovery path for repository initialization outside Git', () => {
  const workingDirectory = temporaryDirectory('ael-prompt-init-outside-git-');

  const result = runCli(['init', '--scope', 'repo', '--hooks', 'cursor'], { workingDirectory });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /^Code\s+REPOSITORY_ROOT_REQUIRED$/m);
  assert.match(result.stderr, /^Next step\s+Change to a Git top-level directory or use `ael init --scope workspace --hooks <sources>`\.$/m);
  assert.equal(result.stderr.includes('--repository-id'), false);
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
