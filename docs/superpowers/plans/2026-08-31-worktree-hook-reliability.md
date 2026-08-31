# Worktree hook reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make passive Cursor and Codex capture executable and locally verifiable in `main` and every linked AEL worktree.

**Architecture:** Keep `.agents/hooks/ael-passive-capture.sh` as the sole agent-facing boundary. Add deterministic Node discovery to the wrapper, then add a non-hook CLI verifier that runs the checked-in configuration through the wrapper using static envelopes and an isolated SQLite directory. The verifier reports readiness per source while real hooks retain exit-zero fail-open behavior.

**Tech Stack:** Node.js 22+, TypeScript, `node:sqlite`, `node:test`, POSIX shell, pnpm, Git worktrees, Cursor and Codex project hooks.

---

## File structure

- Modify: `.agents/hooks/ael-passive-capture.sh` - resolve a supported Node executable without relying on the agent's `PATH`, then forward stdin unchanged to `dist/src/cli.js`.
- Modify: `src/cli.ts` - expose `ael hooks verify --worktree <path>` as an additive, non-hook command.
- Create: `src/capture/hook-readiness.ts` - validate a worktree, run source wrappers with static payloads in an isolated data directory and return a closed result union.
- Modify: `test/project-hook-configuration.test.ts` - prove wrapper persistence, constrained-PATH Node discovery and checked-in configuration coverage.
- Create: `test/hook-readiness.test.ts` - specify verifier output, failure paths, cleanup and linked-worktree behavior.
- Modify: `docs/sdd/specs/009-worktree-hook-reliability.md` - change status to Approved after implementation is accepted and verified.
- Create: `docs/verification/2026-08-31-worktree-hook-reliability.md` - record commands, results and manual Codex/Cursor validation.

### Task 1: Define readiness contracts and failing tests

**Files:**

- Create: `src/capture/hook-readiness.ts`
- Create: `test/hook-readiness.test.ts`

- [ ] **Step 1: Write failing readiness tests**

Create `test/hook-readiness.test.ts`. Define a temporary Git repository helper, a `builtWorktree()` fixture copying the tracked hook files and `dist/src/cli.js`, and these tests:

```ts
test('verifies Codex and Cursor wrappers in an isolated database', () => {
  const result = verifyHookReadiness({ worktreePath: builtWorktree() });
  assert.deepEqual(result, {
    status: 'ready',
    sources: [
      { source: 'codex', status: 'ready' },
      { source: 'cursor', status: 'ready' }
    ]
  });
});

test('reports missing build without creating a default database', () => {
  const root = builtWorktree();
  rmSync(join(root, 'dist'), { recursive: true, force: true });
  assert.deepEqual(verifyHookReadiness({ worktreePath: root }), {
    status: 'not-ready', code: 'BUILD_MISSING', sources: []
  });
});

test('reports a missing source hook file and removes temporary verification data', () => {
  const root = builtWorktree();
  rmSync(join(root, '.cursor', 'hooks.json'));
  const result = verifyHookReadiness({ worktreePath: root });
  assert.equal(result.status, 'not-ready');
  assert.equal(result.code, 'CURSOR_CONFIG_MISSING');
  assert.deepEqual(readdirSync(tempRoot), []);
});
```

Add a linked-worktree fixture using `git worktree add` from a temporary source repository. Assert that the same verifier passes in the primary checkout and linked worktree when both contain the hook files and build output.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
pnpm build && node --test dist/test/hook-readiness.test.js
```

Expected: TypeScript fails because `verifyHookReadiness` does not exist.

- [ ] **Step 3: Define the minimal result contract**

Create `src/capture/hook-readiness.ts` with only exported types and a temporary placeholder implementation that makes the first test compile:

```ts
export type HookReadinessSource = 'codex' | 'cursor';

export type HookReadinessResult =
  | { readonly status: 'ready'; readonly sources: readonly { readonly source: HookReadinessSource; readonly status: 'ready' }[] }
  | { readonly status: 'not-ready'; readonly code: string; readonly sources: readonly { readonly source: HookReadinessSource; readonly status: 'ready' }[] };

export interface HookReadinessOptions {
  readonly worktreePath: string;
}

export function verifyHookReadiness(_options: HookReadinessOptions): HookReadinessResult {
  return { status: 'not-ready', code: 'NOT_IMPLEMENTED', sources: [] };
}
```

- [ ] **Step 4: Re-run the focused test**

Run:

```bash
pnpm build && node --test dist/test/hook-readiness.test.js
```

Expected: tests run and fail on the readiness assertions, not on an undefined symbol.

- [ ] **Step 5: Commit the contract and RED tests**

```bash
git add src/capture/hook-readiness.ts test/hook-readiness.test.ts
git commit -m "test: define worktree hook readiness contract"
```

### Task 2: Make the wrapper's Node resolution deterministic

**Files:**

- Modify: `.agents/hooks/ael-passive-capture.sh`
- Modify: `test/project-hook-configuration.test.ts`

- [ ] **Step 1: Add failing wrapper tests for a restricted PATH**

Extend `test/project-hook-configuration.test.ts` with an isolated fake old Node executable that exits non-zero for the version probe. Run the wrapper with `PATH` set only to that fixture and a valid Codex start payload. Assert it still executes the actual supported Node, writes the session in `AEL_DATA_DIR`, and produces empty stdout and stderr.

Also change the existing subdirectory test to reopen `experience.sqlite` and assert:

```ts
assert.equal(
  store.loadSession('configuration-probe' as SessionId)?.source,
  'codex'
);
```

- [ ] **Step 2: Run the wrapper test to verify RED**

Run:

```bash
pnpm build && node --test dist/test/project-hook-configuration.test.js
```

Expected: the restricted-PATH case returns `AEL_CAPTURE_UNAVAILABLE` or the session assertion fails because the wrapper uses only `node` from `PATH`.

- [ ] **Step 3: Replace direct `node` use with an allowlisted resolver**

In `.agents/hooks/ael-passive-capture.sh`, add this logic before invoking the CLI:

```sh
node_is_compatible() {
  "$1" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 17) ? 0 : 1)' >/dev/null 2>&1
}

node_command=$(command -v node 2>/dev/null || true)
if [ -n "$node_command" ] && ! node_is_compatible "$node_command"; then node_command=; fi
if [ -z "$node_command" ]; then
  for candidate in "${NVM_BIN:-}/node" "${VOLTA_HOME:-}/bin/node" "${HOME:-}/.knode/bin/node" "${HOME:-}/.volta/bin/node" "/opt/homebrew/bin/node" "/usr/local/bin/node"; do
    if [ -x "$candidate" ] && node_is_compatible "$candidate"; then node_command="$candidate"; break; fi
  done
fi
if [ -z "$node_command" ]; then
  printf '%s\n' 'AEL_CAPTURE_UNAVAILABLE: Passive capture skipped.' >&2
  exit 0
fi
```

Replace `node "$cli" capture hook ...` with `"$node_command" "$cli" capture hook ...`. Keep stdin unredirected and keep the existing fail-open fallback around that exact command.

- [ ] **Step 4: Run the wrapper test to verify GREEN**

Run:

```bash
pnpm build && node --test dist/test/project-hook-configuration.test.js
```

Expected: all project-hook configuration tests pass, including persisted session and restricted-PATH cases.

- [ ] **Step 5: Commit wrapper reliability**

```bash
git add .agents/hooks/ael-passive-capture.sh test/project-hook-configuration.test.ts
git commit -m "fix: resolve compatible Node for passive hooks"
```

### Task 3: Implement isolated readiness verification

**Files:**

- Modify: `src/capture/hook-readiness.ts`
- Modify: `test/hook-readiness.test.ts`

- [ ] **Step 1: Add failing tests for static source envelopes**

Add assertions that the verifier sends, for each source, session start, correlated pre-tool, correlated post-tool and session end. Reopen the verifier's isolated database through `ExperienceStore` and assert one closed session and two captured technical events per source. Assert the database is under a verifier-created temporary directory rather than the default AEL data directory.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
pnpm build && node --test dist/test/hook-readiness.test.js
```

Expected: the tests fail with `NOT_IMPLEMENTED`.

- [ ] **Step 3: Implement worktree validation and wrapper execution**

Implement `verifyHookReadiness` with these ordered checks:

1. Resolve `worktreePath` with `realpathSync` and require `git rev-parse --show-toplevel` to equal it.
2. Require `.codex/hooks.json`, `.cursor/hooks.json`, `.agents/hooks/ael-passive-capture.sh` and `dist/src/cli.js` to exist; map each absence to a stable `*_MISSING` code.
3. Parse both JSON files and require the four existing passive lifecycle/tool event keys.
4. Create one `mkdtempSync(join(tmpdir(), 'ael-hook-readiness-'))` directory.
5. Invoke the wrapper through `/bin/sh` with `spawnSync`, `cwd` set to the verified worktree, `AEL_DATA_DIR` set to that temporary directory, and one static JSON payload on stdin for every documented event.
6. Require wrapper status `0`, empty stdout and empty stderr for every accepted payload.
7. Reopen the isolated SQLite database and assert the source session is closed and each correlated pre/post event exists.
8. Remove the temporary directory in `finally`; return `CLEANUP_FAILED` if removal cannot be confirmed.

Use these fixed envelope shapes, with distinct `session_id` and `tool_use_id` values per source:

```ts
const codexStart = { session_id: 'readiness-codex', cwd: root, hook_event_name: 'SessionStart', source: 'startup' };
const cursorStart = { conversation_id: 'readiness-cursor', cwd: root, hook_event_name: 'sessionStart' };
const codexPre = { session_id: 'readiness-codex', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'readiness-codex-tool', tool_input: { command: 'git status --short' } };
const cursorPre = { conversation_id: 'readiness-cursor', cwd: root, hook_event_name: 'preToolUse', tool_name: 'Shell', tool_use_id: 'readiness-cursor-tool', tool_input: { command: 'git status --short' } };
```

Use matching `PostToolUse` or `postToolUse` records and `SessionEnd` or `sessionEnd` records. Do not read any real transcript or source-agent data.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run:

```bash
pnpm build && node --test dist/test/hook-readiness.test.js
```

Expected: all readiness tests pass for primary and linked worktrees, and the temporary verifier directories are removed.

- [ ] **Step 5: Commit the verifier**

```bash
git add src/capture/hook-readiness.ts test/hook-readiness.test.ts
git commit -m "feat: verify passive hook readiness per worktree"
```

### Task 4: Expose the verifier through the CLI

**Files:**

- Modify: `src/cli.ts`
- Modify: `test/hook-readiness.test.ts`

- [ ] **Step 1: Add failing public CLI tests**

Add tests using `runCli` for:

```ts
assert.deepEqual(runCli(['hooks', 'verify', '--worktree', root]), {
  exitCode: 0,
  stdout: 'Hook readiness passed for codex, cursor.\n',
  stderr: ''
});
assert.deepEqual(runCli(['hooks', 'verify', '--worktree', missingBuildRoot]), {
  exitCode: 1,
  stdout: '',
  stderr: 'HOOK_READINESS_ERROR: BUILD_MISSING\n'
});
```

Add a syntax case that rejects a missing `--worktree` option with exit code `2`.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
pnpm build && node --test dist/test/hook-readiness.test.js
```

Expected: `hooks verify` is an unknown command.

- [ ] **Step 3: Add additive CLI routing and output**

Import `verifyHookReadiness` in `src/cli.ts`, add `hooks` to `knownCommands`, and add this `execute` branch before the fallback:

```ts
if (command === 'hooks' && subcommand === 'verify' && rest.length === 0) {
  assertNoUnknownOptions(parsed.options, ['worktree', 'json']);
  return verifyHookReadiness({ worktreePath: requiredString(parsed.options, 'worktree') });
}
```

Update `success` so a `not-ready` verifier result has exit code `1`. Add `humanOutput` formatting for the ready result shown in the test. For the not-ready result, throw `new DomainError('HOOK_READINESS_ERROR', result.code)` so non-JSON output remains a stable one-line diagnostic. Extend `usage()` with `hooks verify --worktree <path>`.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run:

```bash
pnpm build && node --test dist/test/hook-readiness.test.js
```

Expected: valid worktrees return zero and a concise source list; invalid worktrees return one with a stable diagnostic; syntax remains exit two.

- [ ] **Step 5: Commit the CLI command**

```bash
git add src/cli.ts test/hook-readiness.test.ts
git commit -m "feat: expose worktree hook readiness verification"
```

### Task 5: Run regression verification and record evidence

**Files:**

- Modify: `docs/sdd/specs/009-worktree-hook-reliability.md`
- Create: `docs/verification/2026-08-31-worktree-hook-reliability.md`

- [ ] **Step 1: Run project hook and readiness regressions**

Run:

```bash
pnpm build && node --test dist/test/project-hook-configuration.test.js dist/test/hook-readiness.test.js dist/test/milestone-2-5-acceptance.test.js
```

Expected: all selected tests pass with zero failures.

- [ ] **Step 2: Verify both checked-out worktrees**

Run from each worktree:

```bash
pnpm build
node dist/src/cli.js hooks verify --worktree "$(git rev-parse --show-toplevel)"
```

Expected: `Hook readiness passed for codex, cursor.` and exit `0` in `main` and `codex/milestone-3-project-improvements`.

- [ ] **Step 3: Run the full offline suite**

Run:

```bash
pnpm check
```

Expected: build and every repository test pass.

- [ ] **Step 4: Record verification evidence and approve the spec**

Create `docs/verification/2026-08-31-worktree-hook-reliability.md` with the exact commands, pass/fail counts, worktree paths and the fact that the verifier used an isolated database. Change Spec 009 status from `In review.` to `Approved.` only after those checks pass.

- [ ] **Step 5: Commit verification evidence**

```bash
git add docs/sdd/specs/009-worktree-hook-reliability.md docs/verification/2026-08-31-worktree-hook-reliability.md
git commit -m "docs: verify worktree hook reliability"
```

## Plan self-review

Spec coverage: Task 2 covers deterministic Node selection and fail-open wrapper behavior. Task 3 covers isolated source-by-source persistence, worktree validation, cleanup and no default-database mutation. Task 4 defines the additive public verifier interface and failure status. Task 5 covers both existing worktrees, regression tests, privacy-preserving evidence and full-suite verification.

Placeholder scan: no implementation placeholders remain. The only stable failure-code family intentionally uses `*_MISSING` and `HOOK_READINESS_ERROR`, with each concrete expected code named in the relevant task.

Type consistency: `HookReadinessSource`, `HookReadinessResult`, `HookReadinessOptions` and `verifyHookReadiness` are introduced in Task 1, implemented in Task 3 and consumed by Task 4. The CLI subcommand is consistently `hooks verify --worktree <path>`.
