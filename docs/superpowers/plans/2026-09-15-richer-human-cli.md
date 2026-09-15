# Richer human CLI implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every public AEL command a consistent human-readable presentation and derive omitted repository or workspace context from the nearest `.ael/workspace.json` or current Git checkout.

**Architecture:** Add a read-only context resolver and an async prompt preflight ahead of the existing dispatcher. Move human presentation into pure CLI modules that render deterministic plain text or optional ANSI styling while leaving JSON and protocol commands unchanged.

**Tech stack:** TypeScript 5.9, Node.js 22 built-in APIs, `node:test`, SQLite-backed CLI integration tests, pnpm.

---

The approved design is `docs/superpowers/specs/2026-09-15-richer-human-cli-design.md`.[^1] The worktree baseline was stabilized in commit `cd5c5dc`; `rtk pnpm check` passed 865 tests before feature implementation.

## File map

- Create `src/cli/context.ts`: discover configured workspace and Git context without mutation.
- Create `src/cli/context-prompt.ts`: describe command context requirements and obtain a missing path only from an interactive terminal.
- Create `src/cli/human-renderer.ts`: pure document, field, table, error, ANSI, width, and control-character rendering.
- Create `src/cli/human-presentations.ts`: map typed command results to renderer documents.
- Modify `src/capture/diagnostic-scope.ts`: expose nearest configured workspace discovery while preserving exact-root initialization behavior.
- Modify `src/cli.ts`: use context defaults, prompt preflight, richer renderer, and grouped help without changing protocol routes.
- Create `test/cli-context.test.ts`: context precedence, ancestor discovery, Git fallback, invalid metadata, and command defaults.
- Create `test/cli-context-prompt.test.ts`: terminal-only prompt, cancellation, validation, JSON bypass, and redirected-output behavior.
- Create `test/human-renderer.test.ts`: deterministic plain output, ANSI output, narrow fallback, empty states, and control characters.
- Modify `test/cli.test.ts`: human errors, health/status presentation, exit codes, context defaults, and protocol compatibility.
- Modify `test/cli-integration.test.ts`: representative command-family output and packed CLI behavior.
- Modify `test/passive-hook-cli.test.ts`: byte-stable passive capture assertions remain explicit.
- Modify `README.md`: document automatic context, prompt boundaries, `NO_COLOR`, and human versus JSON contracts.
- Modify `skills/ael/references/command-reference.md`: make contextual flags optional and explain resolution precedence.
- Update `agent-experience-layer-0.0.0.tgz`: rebuild the distributable package after all source and skill documentation changes.

### Task 1: Discover the nearest AEL context

**Files:**

- Modify: `src/capture/diagnostic-scope.ts`
- Create: `src/cli/context.ts`
- Create: `test/cli-context.test.ts`

- [ ] **Step 1: Write failing ancestor and precedence tests**

Create `test/cli-context.test.ts` with fixtures that do not touch the default AEL data directory:

```ts
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize, realpathSync } from 'node:path';
import test from 'node:test';

import { resolveCliContext } from '../src/cli/context.js';
import { initializeGitRepository } from './helpers/git-repository.js';

test('uses the nearest configured workspace from a nested directory before Git', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-cli-context-'));
  const nested = join(root, 'packages', 'app');
  initializeGitRepository(root);
  mkdirSync(join(root, '.ael'));
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(root, '.ael', 'workspace.json'), '{"version":1,"workspaceId":"configured-workspace"}\n');

  assert.deepEqual(resolveCliContext(nested), {
    scope: 'workspace',
    id: 'configured-workspace',
    root: normalize(realpathSync(root))
  });
});

test('falls back to the canonical Git context when no workspace is configured', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-cli-git-context-'));
  const nested = join(root, 'src');
  initializeGitRepository(root);
  mkdirSync(nested);

  const context = resolveCliContext(nested);
  assert.equal(context?.scope, 'repository');
  assert.equal(context?.root, normalize(realpathSync(root)));
  assert.match(context?.id ?? '', /^[a-f0-9]{64}$/);
});

test('returns undefined outside configured workspace and Git without creating metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-cli-no-context-'));
  assert.equal(resolveCliContext(root), undefined);
});
```

Add cases for a nearer nested workspace overriding a parent workspace, malformed nearest metadata throwing `Diagnostic workspace configuration is invalid.`, and a symlinked `.ael` directory being rejected.

- [ ] **Step 2: Run the focused build to verify RED**

Run: `rtk pnpm build`

Expected: FAIL because `src/cli/context.ts` and the new exported workspace discovery function do not exist.

- [ ] **Step 3: Implement read-only ancestor discovery**

In `src/capture/diagnostic-scope.ts`, add a new export without changing `resolveConfiguredWorkspaceRoot`, which must continue to inspect only its exact argument for initialization:

```ts
export function findConfiguredWorkspaceRoot(directory: string): ConfiguredWorkspace | undefined {
  let current = normalizeRealDirectory(directory);
  while (true) {
    const configuration = readWorkspaceConfiguration(current);
    if (configuration !== undefined) return Object.freeze({ id: configuration.workspaceId, root: current });
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
```

Add `dirname` to the existing `node:path` import.

Create `src/cli/context.ts`:

```ts
import { findConfiguredWorkspaceRoot } from '../capture/diagnostic-scope.js';
import { resolveRepository } from '../repository/local-repository.js';

export interface CliContext {
  readonly scope: 'workspace' | 'repository';
  readonly id: string;
  readonly root: string;
}

export function resolveCliContext(directory: string): CliContext | undefined {
  const workspace = findConfiguredWorkspaceRoot(directory);
  if (workspace !== undefined) {
    return Object.freeze({ scope: 'workspace', id: workspace.id, root: workspace.root });
  }
  const repository = resolveRepository(directory);
  if (repository === undefined) return undefined;
  return Object.freeze({ scope: 'repository', id: repository.id, root: repository.root });
}
```

- [ ] **Step 4: Run context tests and the existing diagnostic-scope tests**

Run: `rtk pnpm build`

Expected: PASS.

Run: `rtk node --test dist/test/cli-context.test.js dist/test/diagnostic-scope.test.js`

Expected: all context and diagnostic-scope tests PASS.

- [ ] **Step 5: Commit context discovery**

```bash
rtk git add src/capture/diagnostic-scope.ts src/cli/context.ts test/cli-context.test.ts
rtk git commit -m "feat: discover nearest AEL CLI context"
```

### Task 2: Apply automatic context to synchronous commands

**Files:**

- Modify: `src/cli.ts`
- Modify: `test/cli-context.test.ts`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Write failing command-default tests**

Extend `test/cli-context.test.ts` with a configured workspace fixture and an empty private data directory. Assert these calls no longer report a missing option:

```ts
const unregister = runCli(['unregister', '--json', '--data-dir', dataDirectory], { workingDirectory: nested });
assert.deepEqual(JSON.parse(unregister.stdout), { repositoryId: 'configured-workspace', removed: false });

const explanation = runCli(['runtime', 'config', 'explain', '--json', '--data-dir', dataDirectory], {
  workingDirectory: nested
});
assert.equal(explanation.exitCode, 0, explanation.stderr);

const repoLessons = runCli(['lessons', 'list', '--scope', 'repo', '--json', '--data-dir', dataDirectory], {
  workingDirectory: nested
});
assert.equal(repoLessons.exitCode, 0, repoLessons.stderr);
```

Add Git fixtures for `analysis run`, `analysis report`, `knowledge validate`, `knowledge promote`, and `knowledge refresh-runtime`. Supply only arguments unrelated to context, such as `--input` and `--trusted-ref`, and assert failures are service-domain failures rather than `Option is required: --repository` or `--repository-id`.

Add an explicit-precedence case where `--repository-id explicit-id` remains selected inside a configured workspace. Add byte-equality assertions showing existing JSON output is unchanged when the same context is passed explicitly.

- [ ] **Step 2: Run the focused tests to verify RED**

Run: `rtk pnpm build`

Expected: PASS compilation.

Run: `rtk node --test dist/test/cli-context.test.js dist/test/cli.test.js`

Expected: FAIL on commands that still call `requiredString` for context.

- [ ] **Step 3: Add command-scoped context helpers**

Import `resolveCliContext` in `src/cli.ts` and add helpers with stable domain errors:

```ts
function contextualRepositoryId(options: Map<string, string | true>, workingDirectory?: string): string {
  return optionalString(options, 'repository-id')
    ?? resolveCliContext(workingDirectory ?? process.cwd())?.id
    ?? requiredContext('repository or workspace', '--repository-id');
}

function contextualRoot(options: Map<string, string | true>, option: 'repository' | 'workspace', workingDirectory?: string): string {
  return optionalString(options, option)
    ?? resolveCliContext(workingDirectory ?? process.cwd())?.root
    ?? requiredContext('repository or workspace', `--${option}`);
}

function requiredContext(kind: string, option: string): never {
  throw new DomainError('CONTEXT_REQUIRED', `A ${kind} is required. Pass ${option} or run the command inside a configured AEL workspace.`);
}
```

Keep `optionalRepositoryId` conflict validation. Update `repositorySelection` to use `resolveCliContext` after explicit options. Update `filterOptions` to accept `workingDirectory` and derive an ID only when `optionalScope(options) === 'repository'`.

- [ ] **Step 4: Replace only context-required calls**

Use the helpers for this exact mapping:

```text
unregister                         repository-id
analysis run                      repository-id
analysis report                   repository-id
lessons list --scope repo         repository-id
retrieve --scope repo             repository-id
runtime config explain            workspace root
knowledge validate                repository root
knowledge promote                 repository root
knowledge refresh-runtime         repository root and repository-id
hooks verify                      remains explicitly --worktree
review                            retains its source-root and repository rules
skill workspace operations        retain current working-directory default
```

Do not alter passive capture, internal worker, global status, global skill mutation, or review session discovery.

- [ ] **Step 5: Verify automatic context and compatibility**

Run: `rtk pnpm build`

Expected: PASS.

Run: `rtk node --test dist/test/cli-context.test.js dist/test/cli.test.js dist/test/cli-integration.test.js`

Expected: all focused tests PASS, including explicit versus inferred JSON equality.

- [ ] **Step 6: Commit synchronous defaults**

```bash
rtk git add src/cli.ts test/cli-context.test.ts test/cli.test.ts
rtk git commit -m "feat: default CLI commands to local context"
```

### Task 3: Prompt only in an interactive human terminal

**Files:**

- Create: `src/cli/context-prompt.ts`
- Modify: `src/cli.ts`
- Create: `test/cli-context-prompt.test.ts`

- [ ] **Step 1: Write failing prompt-boundary tests**

Create `test/cli-context-prompt.test.ts` using a fake prompt:

```ts
import type { CliContextPrompt } from '../src/cli/context-prompt.js';

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
```

Test that human `unregister` outside any context prompts once, resolves a selected configured workspace, and executes. Test that `--json`, `interactive: false`, and passive capture never call the prompt. Test that `undefined` returns `{ exitCode: 130, stdout: '', stderr: '' }`. Test that a malformed or unresolvable answer returns one bounded `CONTEXT_REQUIRED` error without a second prompt.

- [ ] **Step 2: Run the prompt test to verify RED**

Run: `rtk pnpm build`

Expected: FAIL because `CliContextPrompt` and the new `RunCliAsyncOptions` field do not exist.

- [ ] **Step 3: Implement the prompt interface and process adapter**

Create `src/cli/context-prompt.ts`:

```ts
import { createInterface } from 'node:readline';

export interface CliContextPrompt {
  readonly interactive: boolean;
  readContextPath(message: string): Promise<string | undefined>;
}

export function createProcessContextPrompt(): CliContextPrompt {
  return {
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    async readContextPath(message) {
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      return await new Promise<string | undefined>((resolve) => {
        let settled = false;
        const finish = (value: string | undefined): void => {
          if (settled) return;
          settled = true;
          terminal.close();
          resolve(value);
        };
        terminal.once('SIGINT', () => finish(undefined));
        terminal.question(message, (answer) => finish(answer.trim() || undefined));
      });
    }
  };
}
```

- [ ] **Step 4: Add asynchronous context preflight**

Extend `RunCliAsyncOptions` with `readonly contextPrompt?: CliContextPrompt`. Before delegating non-review public commands to `runCli`, inspect the parsed command and determine whether its declared requirement is unresolved. If `--json` is present or `contextPrompt?.interactive !== true`, delegate unchanged so `runCli` returns `CONTEXT_REQUIRED`.

For an interactive missing context, call `readContextPath('Repository or workspace path: ')` exactly once. Resolve the answer with `resolveCliContext`. Append the correct explicit options before delegating:

```ts
type ContextRequirement = 'repository-id' | 'repository-root' | 'workspace-root' | 'repository-root-and-id';

function contextArguments(requirement: ContextRequirement, context: CliContext): string[] {
  if (requirement === 'repository-id') return ['--repository-id', context.id];
  if (requirement === 'workspace-root') return ['--workspace', context.root];
  if (requirement === 'repository-root') return ['--repository', context.root];
  return ['--repository', context.root, '--repository-id', context.id];
}
```

For `knowledge refresh-runtime`, append only each missing option. Cancellation returns exit code 130. Invalid input returns a human `CONTEXT_REQUIRED` result. In the process entrypoint, pass `createProcessContextPrompt()` to `runCliAsync`.

- [ ] **Step 5: Verify prompt isolation**

Run: `rtk pnpm build`

Expected: PASS.

Run: `rtk node --test dist/test/cli-context-prompt.test.js dist/test/passive-hook-cli.test.js dist/test/review-cli-terminal.test.js`

Expected: all tests PASS; protocol and review prompts remain independent.

- [ ] **Step 6: Commit interactive context selection**

```bash
rtk git add src/cli/context-prompt.ts src/cli.ts test/cli-context-prompt.test.ts
rtk git commit -m "feat: prompt for unresolved CLI context"
```

### Task 4: Build the human renderer

**Files:**

- Create: `src/cli/human-renderer.ts`
- Create: `test/human-renderer.test.ts`

- [ ] **Step 1: Write exact rendering tests**

Create `test/human-renderer.test.ts` around this public contract:

```ts
export interface HumanRenderOptions {
  readonly color?: boolean;
  readonly width?: number;
}

export type HumanBlock =
  | { readonly kind: 'fields'; readonly rows: readonly { readonly label: string; readonly value: string }[] }
  | { readonly kind: 'table'; readonly columns: readonly string[]; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'empty'; readonly value: string };

export interface HumanDocument {
  readonly title: string;
  readonly status?: { readonly tone: 'success' | 'warning' | 'failure' | 'neutral'; readonly text: string };
  readonly sections: readonly { readonly heading?: string; readonly blocks: readonly HumanBlock[] }[];
}
```

Assert this plain output exactly:

```text
AEL status  [ready]

Installation
CLI       available
Database  available
```

Assert color mode contains ANSI only around trusted labels and status text. Assert a data value containing `\u001b[31m` renders as the literal escaped text `\\u001b[31m`. Assert width 40 stacks a table row as labeled fields, and width 100 renders aligned columns. Assert an empty block keeps an actionable sentence.

- [ ] **Step 2: Run renderer tests to verify RED**

Run: `rtk pnpm build`

Expected: FAIL because `human-renderer.ts` does not exist.

- [ ] **Step 3: Implement deterministic rendering primitives**

Implement `renderHumanDocument(document, options)` and `renderHumanError(diagnostic, nextStep, options)`. Use only local ANSI constants:

```ts
const ANSI = Object.freeze({
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m'
});

function safeValue(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u001b]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
```

Alignment uses visible plain-text length before ANSI decoration. Tables fall back to one labeled line per column when the computed row width exceeds `options.width ?? 80`. Omit empty sections and end the returned document without a newline; `CliResult` remains responsible for one trailing newline.

- [ ] **Step 4: Run renderer tests**

Run: `rtk pnpm build`

Expected: PASS.

Run: `rtk node --test dist/test/human-renderer.test.js`

Expected: all renderer cases PASS.

- [ ] **Step 5: Commit the renderer**

```bash
rtk git add src/cli/human-renderer.ts test/human-renderer.test.ts
rtk git commit -m "feat: add deterministic human CLI renderer"
```

### Task 5: Migrate public command presentations and errors

**Files:**

- Create: `src/cli/human-presentations.ts`
- Modify: `src/cli.ts`
- Modify: `test/cli.test.ts`
- Modify: `test/cli-integration.test.ts`

- [ ] **Step 1: Write failing command-family presentation tests**

Replace the single flat-output integration test with explicit cases for these presentation families:

```text
init; unregister; experience add; validate
inspect; lessons list; retrieve; export
list records; stats; evidence session
status v1; status v2; status-global v1; status-global v2
hooks verify; hooks diagnostics
capture drain; capture status
analysis run; analysis report v1; analysis report v2; analysis status
review session fallback; review sessions
runtime evaluate; runtime status; runtime config explain
knowledge validate; knowledge refresh-runtime; knowledge promote
skill install; skill update; skill status; skill validate; skill uninstall
```

Each expected output must contain a title, a blank line before details, textual status where applicable, and aligned fields or a table. Retain exact `--json` assertions from the old test. Add a human error assertion:

```text
Error

Message    A repository or workspace is required. Pass --repository-id or run the command inside a configured AEL workspace.
Code       CONTEXT_REQUIRED
Next step  Run `ael init` in the workspace or pass --repository-id.
```

Add an injected `humanOutput: { color: true, width: 100 }` case and a default plain-output case.

- [ ] **Step 2: Run focused CLI tests to verify RED**

Run: `rtk pnpm build`

Expected: PASS compilation.

Run: `rtk node --test dist/test/cli.test.js dist/test/cli-integration.test.js`

Expected: FAIL because the current output is flat.

- [ ] **Step 3: Create typed command presentations**

Move `Version2HealthReport`, `KnowledgeRecord`, `RuntimeConfigurationExplanation`, `formatVersion2Health`, `formatRecords`, `formatStatistics`, `formatRepositoryStatus`, `formatCaptureDiagnostics`, `formatAnalysisStatus`, `formatKnowledgeList`, and `formatRuntimeConfiguration` out of `src/cli.ts` into `src/cli/human-presentations.ts`.

Export one entrypoint:

```ts
export function renderCommandResult(
  value: unknown,
  positionals: readonly string[],
  options: HumanRenderOptions = {}
): string
```

Each branch constructs a `HumanDocument` and calls `renderHumanDocument`. Preserve every fact currently emitted. Collections use tables when homogeneous and detail sections when records contain nested events. Empty values use command-specific sentences such as `No sessions found.` and `No registered repositories.`.

- [ ] **Step 4: Wire human capabilities and human errors**

Extend the options accepted by `runCli` and `runCliAsync`:

```ts
readonly humanOutput?: HumanRenderOptions;
```

Change `success` to call `renderCommandResult(value, positionals, humanOutput)`. Replace non-JSON catch output with `renderHumanError`. Add a closed mapping from diagnostic codes to next steps; unknown codes omit the next-step row. Do not change JSON catches, exit-code derivation, hook diagnostics, worker diagnostics, or ingestion JSONL diagnostics.

At the process entrypoint pass:

```ts
humanOutput: {
  color: Boolean(process.stdout.isTTY && process.env.NO_COLOR === undefined),
  width: process.stdout.columns
}
```

- [ ] **Step 5: Verify all public presentation families**

Run: `rtk pnpm build`

Expected: PASS.

Run: `rtk node --test dist/test/human-renderer.test.js dist/test/cli.test.js dist/test/cli-integration.test.js dist/test/review-cli-terminal.test.js`

Expected: all focused tests PASS.

- [ ] **Step 6: Commit command presentations**

```bash
rtk git add src/cli/human-presentations.ts src/cli.ts test/cli.test.ts test/cli-integration.test.ts
rtk git commit -m "feat: render richer human CLI output"
```

### Task 6: Group help and protect protocol output

**Files:**

- Modify: `src/cli.ts`
- Modify: `test/cli.test.ts`
- Modify: `test/passive-hook-cli.test.ts`

- [ ] **Step 1: Write failing help and protocol tests**

Assert `ael --help` starts with `Usage: ael <command> [options]`, then contains command-family headings `Setup`, `Observation`, `Review`, `Runtime`, `Knowledge`, and `Skills`. Assert contextual options are shown in brackets. Assert the help contains `Context: explicit option > nearest .ael/workspace.json > Git root > interactive prompt.`

Keep exact passive hook expectations:

```ts
assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
assert.equal(privateFailure.stderr, 'AEL_CAPTURE_PRIVATE_INPUT: Passive capture skipped.\n');
```

Add exact internal worker assertions for empty success output and one-line bounded failure output. Run those commands with `humanOutput.color: true` to prove the protocol bypass ignores styling.

- [ ] **Step 2: Run tests to verify RED**

Run: `rtk pnpm build`

Expected: PASS compilation.

Run: `rtk node --test dist/test/cli.test.js dist/test/passive-hook-cli.test.js`

Expected: help assertions FAIL; protocol assertions remain green.

- [ ] **Step 3: Replace the one-line usage string**

Implement `usage()` as a static joined array. Keep all existing commands and options, mark inferable context flags optional, and do not list internal worker-child or capture-hook protocol details as ordinary interactive commands. The first line remains concise for syntax errors and documentation.

- [ ] **Step 4: Verify help and protocol isolation**

Run: `rtk pnpm build`

Expected: PASS.

Run: `rtk node --test dist/test/cli.test.js dist/test/passive-hook-cli.test.js dist/test/analysis-worker.test.js`

Expected: all tests PASS.

- [ ] **Step 5: Commit help and protocol locks**

```bash
rtk git add src/cli.ts test/cli.test.ts test/passive-hook-cli.test.ts
rtk git commit -m "docs: expose context-aware CLI help"
```

### Task 7: Update user and skill documentation

**Files:**

- Modify: `README.md`
- Modify: `skills/ael/references/command-reference.md`
- Modify: `skills/ael/references/setup-and-health.md`

- [ ] **Step 1: Update command forms and precedence**

In `README.md`, change context flags to optional for the commands mapped in Task 2. Add this exact behavioral contract after the command block:

```text
For commands that need a repository or workspace, an explicit option wins. Otherwise AEL uses the nearest ancestor `.ael/workspace.json`, then the current Git root. An interactive terminal asks for a path only when neither source resolves context. JSON and redirected execution never prompt. Use `NO_COLOR=1` to disable ANSI styling while retaining the human-readable layout.
```

In `skills/ael/references/command-reference.md`, list every public contextual form and the same precedence. In `skills/ael/references/setup-and-health.md`, state that `.ael/workspace.json` is discovered from nested directories and overrides Git context.

- [ ] **Step 2: Validate documentation and skill packaging**

Run: `rtk rg -n 'T[B]D|T[O]DO|F[I]XME|\x{2014}' README.md skills/ael/references`

Expected: no matches introduced by this change.

Run: `rtk pnpm build`

Expected: PASS.

Run: `rtk node --test dist/test/ael-skill.test.js dist/test/cli-integration.test.js`

Expected: skill routing and packed-package integration tests PASS.

- [ ] **Step 3: Commit documentation**

```bash
rtk git add README.md skills/ael/references/command-reference.md skills/ael/references/setup-and-health.md
rtk git commit -m "docs: explain automatic AEL CLI context"
```

### Task 8: Run acceptance, smoke tests, and package the release

**Files:**

- Update: `agent-experience-layer-0.0.0.tgz`
- Modify only if verification exposes a defect: files already named in Tasks 1 through 7

- [ ] **Step 1: Run the full acceptance suite**

Run: `rtk pnpm check`

Expected: build PASS; 865 existing tests plus all new tests PASS; 0 failures, 0 skipped, 0 cancelled.

- [ ] **Step 2: Run plain and contextual smoke tests**

Run: `rtk node dist/src/cli.js --help`

Expected: grouped plain help, no ANSI escapes.

Run from `test/`: `rtk node ../dist/src/cli.js status --json --data-dir /tmp/ael-cli-smoke-data`

Expected: context is inferred from the Git root and JSON parses successfully.

Run: `rtk node --input-type=module -e "import { removeTemporaryDirectory } from './dist/src/cli/temporary-directory.js'; await removeTemporaryDirectory('/tmp/ael-cli-smoke-data')"`

Expected: only the explicit smoke-test data directory is removed.

Run: `NO_COLOR=1 rtk node dist/src/cli.js analysis status --data-dir /tmp/ael-cli-smoke-analysis`

Expected: sectioned human output with no ANSI escape sequences.

- [ ] **Step 3: Rebuild the tracked package archive**

Run: `rtk pnpm pack`

Expected: `agent-experience-layer-0.0.0.tgz` is recreated and contains `dist`, `skills`, and the executable CLI.

Run: `rtk tar -tzf agent-experience-layer-0.0.0.tgz`

Expected: archive includes `package/dist/src/cli.js`, the new CLI modules, and `package/skills/ael/references/command-reference.md`; it excludes workspace data and test fixtures.

- [ ] **Step 4: Validate the packaged executable**

Run `rtk mktemp -d /tmp/ael-package-prefix-XXXXXX` and retain the returned absolute path as the task-specific `AEL_PACKAGE_PREFIX` value for the following commands.

Run: `rtk pnpm add --dir "$AEL_PACKAGE_PREFIX" ./agent-experience-layer-0.0.0.tgz`

Run: `rtk "$AEL_PACKAGE_PREFIX/node_modules/.bin/ael" --help`

Run: `rtk node --input-type=module -e 'import { mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path"; const root=process.argv[1]; mkdirSync(join(root,"workspace",".ael"),{recursive:true}); mkdirSync(join(root,"workspace","nested"),{recursive:true}); writeFileSync(join(root,"workspace",".ael","workspace.json"),JSON.stringify({version:1,workspaceId:"package-smoke"})+"\n")' "$AEL_PACKAGE_PREFIX"`

Run the packaged `unregister --json` from `$AEL_PACKAGE_PREFIX/workspace/nested` with `--data-dir $AEL_PACKAGE_PREFIX/data`. Expected: packaged behavior matches the checkout, reports repository ID `package-smoke`, and no path from the development worktree appears in output.

Run: `rtk node --input-type=module -e "import { removeTemporaryDirectory } from './dist/src/cli/temporary-directory.js'; await removeTemporaryDirectory(process.argv[1])" "$AEL_PACKAGE_PREFIX"`

Expected: only the explicit package-test prefix is removed.

- [ ] **Step 5: Refresh the installed AEL skill**

Run the built CLI with `ael skill update --scope global --yes --json`, using the worktree build as the source. This writes outside the repository and therefore requires explicit sandbox approval. Expected: status `updated` or `current`. Then run `ael skill status --scope global --json` and expect `current`.

- [ ] **Step 6: Inspect and commit the package archive**

Run: `rtk git diff --check`

Expected: PASS.

Run: `rtk git status --short`

Expected: only `agent-experience-layer-0.0.0.tgz` remains after prior commits.

```bash
rtk git add agent-experience-layer-0.0.0.tgz
rtk git commit -m "chore: package richer AEL CLI"
```

- [ ] **Step 7: Perform final verification after the last change**

Run: `rtk pnpm check`

Expected: every test PASS with 0 failures, 0 skipped, and 0 cancelled.

Run: `rtk git status -sb`

Expected: clean `codex/richer-human-cli` worktree.

[^1]: The approved design fixes JSON and protocol compatibility, context precedence, terminal prompt boundaries, presentation behavior, and the acceptance path.
