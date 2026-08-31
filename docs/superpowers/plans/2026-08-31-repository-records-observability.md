# Repository records observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add repository-scoped raw record listing, statistics, local and global AEL status, plus verified interactive hook installation.

**Architecture:** A repository module resolves canonical Git roots and provides static hook status. The SQLite store owns repository registration and repository-scoped read models. The CLI uses a hook-selection dependency for interactive initialization, an installer that safely merges configuration, and an application service that coordinates storage and status without executing hooks.

**Tech Stack:** Node.js 22.17+, TypeScript, `node:sqlite`, `node:test`, POSIX shell, pnpm, Git, Codex and Cursor hook JSON.

---

## File structure

- Create: `src/repository/local-repository.ts` - canonical Git-root resolution and static repository probing.
- Create: `src/cli/hook-installation.ts` - hook choice contract, configuration merge, wrapper generation and static verification.
- Create: `src/application/repository-observability.ts` - read-only status projection and human-readable record/statistics view models.
- Modify: `src/storage/experience-store.ts` - repository registry migration and repository-scoped session, event, knowledge and aggregate queries.
- Modify: `src/application/experience-service.ts` - expose initialization, record, statistics and status services.
- Modify: `src/capture/hook-ingress.ts` and `src/capture/hook-adapters/*.ts` - attach the canonical repository identifier to newly captured sessions without changing fail-open results.
- Modify: `src/cli.ts` - parse and execute the commands, noninteractive hook-selection requirement and deterministic output.
- Modify: `package.json` - ship hook template assets in the packed package.
- Create: `test/repository-observability.test.ts` - storage, resolution, records, aggregate and status behavior.
- Create: `test/hook-installation.test.ts` - selection, safe config merge, installation and verification behavior.
- Modify: `test/cli-integration.test.ts` and `test/passive-hook-cli.test.ts` - command and capture integration coverage.
- Modify: `README.md` - publish the supported command and initialization syntax.

### Task 1: Repository resolution and registry storage

**Files:**

- Create: `src/repository/local-repository.ts`
- Modify: `src/storage/experience-store.ts`
- Create: `test/repository-observability.test.ts`

- [ ] **Step 1: Write the failing storage and resolver tests**

Create temporary Git repositories with `initializeGitRepository` and add tests for these contracts:

```ts
assert.deepEqual(resolveRepository(join(root, 'nested')), {
  id: realpathSync(root), root: realpathSync(root)
});
assert.equal(resolveRepository(nonGitDirectory), undefined);

store.registerRepository({ id: root, root, observedAt: '2026-08-31T10:00:00.000Z' });
assert.deepEqual(store.listRepositories(), [{
  id: root, root, observedAt: '2026-08-31T10:00:00.000Z'
}]);
```

Add a second registration with a later timestamp and assert it updates rather than duplicates the entry. Assert that a pre-existing database opens and migrates before its first registration.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
pnpm build && node --test dist/test/repository-observability.test.js
```

Expected: TypeScript fails because `resolveRepository`, `registerRepository`, and `listRepositories` do not exist.

- [ ] **Step 3: Add the minimal repository and storage contracts**

In `src/repository/local-repository.ts`, export:

```ts
export interface LocalRepository { readonly id: string; readonly root: string; }
export function resolveRepository(directory: string): LocalRepository | undefined;
```

Resolve `realpathSync(directory)`, invoke `git rev-parse --show-toplevel` with `spawnSync`, and require its canonical real path. Return the canonical root for both `id` and `root`; catch process and filesystem failures and return `undefined`.

In `src/storage/experience-store.ts`, add migration 12:

```sql
CREATE TABLE IF NOT EXISTS repositories (
  repository_id TEXT PRIMARY KEY,
  repository_root TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
```

Add `RepositoryRegistration`, `registerRepository`, and `listRepositories`. Use `INSERT ... ON CONFLICT(repository_id) DO UPDATE SET repository_root = excluded.repository_root, observed_at = excluded.observed_at`, validate non-empty canonical timestamps, and order listing by `repository_root`.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run:

```bash
pnpm build && node --test dist/test/repository-observability.test.js
```

Expected: the resolver handles a nested working directory, the registry is upserted deterministically, and old databases migrate.

- [ ] **Step 5: Commit the storage foundation**

```bash
git add src/repository/local-repository.ts src/storage/experience-store.ts test/repository-observability.test.ts
git commit -m "feat: register AEL repositories"
```

### Task 2: Safe hook selection, installation and verification

**Files:**

- Create: `src/cli/hook-installation.ts`
- Modify: `package.json`
- Create: `test/hook-installation.test.ts`

- [ ] **Step 1: Write failing hook-installation tests**

Define `HookSource = 'codex' | 'cursor'` and an injected `HookSelectionPrompt`. Test all of the following:

```ts
const selection = await chooseHooks(promptReturning(['codex', 'cursor']));
assert.deepEqual(selection, ['codex', 'cursor']);
assert.throws(() => parseHookSelection(''), /at least one/i);
assert.throws(() => parseHookSelection('codex,unknown'), /codex or cursor/i);
```

Use a temporary Git repository with an unrelated `PreToolUse` Codex hook. After installing Cursor, assert the Codex JSON is byte-for-byte unchanged, Cursor gets exactly the four documented lifecycle/technical entries, `.agents/hooks/ael-passive-capture.sh` is executable, and `verifyInstalledHooks` returns `ready` for Cursor. Add a malformed existing JSON test that asserts installation throws before creating or replacing any file.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
pnpm build && node --test dist/test/hook-installation.test.js
```

Expected: TypeScript fails because the installer module and its contracts do not exist.

- [ ] **Step 3: Implement the installer without destructive merging**

Export these contracts:

```ts
export type HookSource = 'codex' | 'cursor';
export interface HookSelectionPrompt { choose(): Promise<readonly HookSource[]>; }
export function parseHookSelection(value: string): readonly HookSource[];
export function installHooks(input: { repositoryRoot: string; sources: readonly HookSource[]; cliEntrypoint: string }): void;
export function verifyInstalledHooks(input: { repositoryRoot: string; sources: readonly HookSource[]; cliEntrypoint: string }): HookInstallationStatus;
```

Use `readFileSync` plus `JSON.parse` only when the target exists. Validate the expected root object shape before merging. Add AEL's documented lifecycle entries only for selected sources and retain every pre-existing array entry. Write JSON through a same-directory temporary file, `chmodSync` the wrapper to `0o755`, then rename atomically. Generate the wrapper from a bundled TypeScript string constant with the existing compatible-Node resolver, the canonical repository-root lookup, the fixed absolute `cliEntrypoint`, and the existing exit-zero generic fallback. Add the template asset to `package.json` `files` if it is stored outside `dist`.

`verifyInstalledHooks` must inspect only files: selected JSON entries must point at the wrapper for the matching source, the wrapper must be executable, and `cliEntrypoint` must be a readable file. It returns per-source `ready` or a stable unavailable code and never invokes the wrapper.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run:

```bash
pnpm build && node --test dist/test/hook-installation.test.js
```

Expected: both selections install and verify, unrelated configuration remains present, and malformed JSON is non-mutating.

- [ ] **Step 5: Commit the installer**

```bash
git add src/cli/hook-installation.ts package.json test/hook-installation.test.ts
git commit -m "feat: install verified agent hooks"
```

### Task 3: Repository-aware capture and raw aggregate queries

**Files:**

- Modify: `src/capture/hook-ingress.ts`
- Modify: `src/capture/hook-adapters/codex.ts`
- Modify: `src/capture/hook-adapters/cursor.ts`
- Modify: `src/storage/experience-store.ts`
- Modify: `test/passive-hook-cli.test.ts`
- Modify: `test/repository-observability.test.ts`

- [ ] **Step 1: Add failing repository capture, record and statistics tests**

Invoke the Codex hook CLI from a temporary Git repository for a start, pre-action, post-result and end sequence. Assert the stored session has `repositoryId === realpathSync(repository)`. Seed a second repository and assert `listRepositoryRecords(firstRoot)` returns only the first session and its events.

Assert the aggregate projection exactly includes:

```ts
{
  sessions: 1,
  events: 2,
  knowledge: 0,
  firstRecordedAt: now,
  lastRecordedAt: now,
  sources: { codex: 1, cursor: 0, 'claude-code': 0 },
  phases: { 'pre-intent': 0, 'pre-action': 1, 'post-result': 1 }
}
```

Add an empty registered repository assertion with zero counts and `firstRecordedAt` and `lastRecordedAt` omitted.

- [ ] **Step 2: Run the focused tests to verify RED**

Run:

```bash
pnpm build && node --test dist/test/passive-hook-cli.test.js dist/test/repository-observability.test.js
```

Expected: assertions fail because captured sessions do not receive a repository identifier and scoped query methods do not exist.

- [ ] **Step 3: Preserve repository identity through capture and query only sanitized data**

Resolve the current Git repository in `ingestPassiveHook` before adapter dispatch. Pass `repositoryId` into both passive adapters and set it only on new `session-start` and technical fallback session objects. If resolution fails, retain current adapter behavior and fail-open output. After an inserted session or event with an identifier, upsert the registry using the injected clock timestamp.

In `ExperienceStore`, add `listRepositoryRecords(repositoryId)` that joins `sessions`, `events`, and `capture_events`, groups events under sessions, and orders by `sessions.started_at`, `events.occurred_at`, and event row ID. Reuse `captureFromRow` for event content; do not expose hook payloads. Add `repositoryStats(repositoryId)` using explicit count queries for sessions, captured events, repository-scoped knowledge metadata, source counts, phase counts, and `MIN`/`MAX` over session starts and event timestamps.

- [ ] **Step 4: Run the focused tests to verify GREEN**

Run:

```bash
pnpm build && node --test dist/test/passive-hook-cli.test.js dist/test/repository-observability.test.js
```

Expected: capture retains the canonical repository ID, cross-repository records are isolated, and aggregates include deterministic zero values.

- [ ] **Step 5: Commit repository-scoped data**

```bash
git add src/capture/hook-ingress.ts src/capture/hook-adapters/codex.ts src/capture/hook-adapters/cursor.ts src/storage/experience-store.ts test/passive-hook-cli.test.ts test/repository-observability.test.ts
git commit -m "feat: expose repository capture records and stats"
```

### Task 4: Initialization flow and status projection

**Files:**

- Create: `src/application/repository-observability.ts`
- Modify: `src/application/experience-service.ts`
- Modify: `src/cli.ts`
- Modify: `test/hook-installation.test.ts`
- Modify: `test/cli-integration.test.ts`

- [ ] **Step 1: Write failing initialization and status tests**

Extend `RunCliAsyncOptions` with an injectable `hookSelectionPrompt`, `workingDirectory`, and `cliEntrypoint`. Specify:

```ts
const init = await runCliAsync(['init', '--data-dir', dataDir], {
  workingDirectory: repository,
  hookSelectionPrompt: promptReturning(['cursor']),
  cliEntrypoint: compiledCli
});
assert.equal(init.exitCode, 0);
assert.match(init.stdout, /Installed and verified Cursor hook/);

assert.deepEqual(JSON.parse(runCli(['status', '--repository-id', repository, '--json', '--data-dir', dataDir]).stdout), {
  repository: { id: repository, root: repository },
  hooks: [{ source: 'codex', status: 'unavailable' }, { source: 'cursor', status: 'ready' }],
  cli: { entrypoint: compiledCli, available: true },
  database: { path: join(dataDir, 'experience.sqlite'), available: true }
});
```

Assert that `runCli(['init', '--data-dir', dataDir])` returns syntax exit 2 outside a TTY without `--hooks`; `runCli(['init', '--scope', 'global', '--data-dir', dataDir])` still initializes the store; and `status-global --json` returns the registered repository only once. Assert a moved registered root returns `unavailable` and remains in `status-global`.

- [ ] **Step 2: Run the focused tests to verify RED**

Run:

```bash
pnpm build && node --test dist/test/hook-installation.test.js dist/test/cli-integration.test.js dist/test/repository-observability.test.js
```

Expected: the new command forms and injected initialization dependencies are unsupported.

- [ ] **Step 3: Add application coordination and command execution**

In `repository-observability.ts`, define `RepositoryStatus`, `GlobalStatus`, `RepositoryRecord`, and `RepositoryStatistics`. Construct status from `resolveRepository`, `verifyInstalledHooks`, the selected database path, and `existsSync(cliEntrypoint)`. Inspect both Codex and Cursor in stable source order. A missing or moved registered root becomes `unavailable`; status reading does not create a registry entry.

In `ExperienceService`, add methods named `initRepository`, `listRecords`, `stats`, `status`, and `statusGlobal`. `initRepository` calls installation, verifies every selected source, and registers only on success. Keep global initialization as the current database open/close operation.

In `cli.ts`, add `list`, `stats`, `status`, and `status-global` to `knownCommands`; permit `data-dir`, `json`, and `repository-id` for each. Resolve a missing identifier from the command's working directory for all except `status-global`. Reject missing noninteractive `--hooks` with `INVALID_SYNTAX`; support `--hooks` on repository initialization only. Route interactive init through `runCliAsync` and the injected terminal prompt. Add deterministic plain-text renderers for records, statistics, local status, and global status; omit absent values rather than printing `undefined`. Keep `--json` as a single JSON object or array line.

- [ ] **Step 4: Run the focused tests to verify GREEN**

Run:

```bash
pnpm build && node --test dist/test/hook-installation.test.js dist/test/cli-integration.test.js dist/test/repository-observability.test.js
```

Expected: repository initialization installs and verifies selected hooks, noninteractive initialization requires an explicit selection, and all status forms are deterministic and read-only.

- [ ] **Step 5: Commit commands and status**

```bash
git add src/application/repository-observability.ts src/application/experience-service.ts src/cli.ts test/hook-installation.test.ts test/cli-integration.test.ts test/repository-observability.test.ts
git commit -m "feat: add repository status commands"
```

### Task 5: Documentation, compatibility regressions and full verification

**Files:**

- Modify: `README.md`
- Modify: `test/cli-integration.test.ts`
- Modify: `test/project-hook-configuration.test.ts`

- [ ] **Step 1: Add failing compatibility and packaging tests**

Extend the packed-package integration test to run noninteractive initialization in a temporary Git repository with `--hooks cursor`, assert the packed package includes every template asset required by the installer, and assert `ael status --json` reports the generated entrypoint. Retain the existing project hook configuration assertions and add a no-write assertion around `status` by comparing the SQLite file mtime before and after the command.

- [ ] **Step 2: Run the relevant regression tests to verify RED**

Run:

```bash
pnpm build && node --test dist/test/cli-integration.test.js dist/test/project-hook-configuration.test.js
```

Expected: the package test fails until required installation assets are included and documented command behavior is complete.

- [ ] **Step 3: Update user documentation and package contents**

Add to `README.md` the four new command forms, their `--repository-id` semantics, default current-repository behavior, `status-global` scope, the interactive multi-select flow, and mandatory `--hooks` selections outside a TTY. State that status is static and never executes hooks. Ensure `package.json` ships only the required compiled installer/template assets and continues to expose `bin.ael` as `./dist/src/cli.js`.

- [ ] **Step 4: Run focused verification to verify GREEN**

Run:

```bash
pnpm build && node --test dist/test/cli-integration.test.js dist/test/project-hook-configuration.test.js
```

Expected: packed and local installation paths work, status performs no capture write, and existing hook configuration continues to pass.

- [ ] **Step 5: Run the complete verification suite**

Run:

```bash
pnpm check
```

Expected: build succeeds and every compiled `node:test` case passes.

- [ ] **Step 6: Commit documentation and final verification changes**

```bash
git add README.md package.json test/cli-integration.test.ts test/project-hook-configuration.test.ts
git commit -m "docs: document repository observability"
```
