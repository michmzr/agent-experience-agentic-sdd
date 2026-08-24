# Local experience core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Deliver the first usable Agent Experience Layer slice: a local TypeScript CLI that validates, persists, retrieves, and exports normalized experience knowledge.

**Architecture:** The CLI calls a focused application service layer. Private records are held in a transactional SQLite database through Node's `node:sqlite` API; repository knowledge is read and written as a versioned JSON index plus per-entry Markdown. Domain validation is deterministic and runs before every mutation; retrieval is exact metadata matching only.

**Tech Stack:** Node.js 22.17 or later, TypeScript, Node built-in test runner, `node:sqlite`, `pnpm`. No runtime third-party dependencies.

**Source references:** [Node `node:sqlite` API](https://nodejs.org/docs/latest-v22.x/api/sqlite.html), [Node test runner](https://nodejs.org/docs/latest-v22.x/api/test.html).

---

## Execution status

Updated: 2026-08-24. This section is the live execution record; tasks are not treated as accepted until their specified review gates and a fresh full check pass.

| Task | State | Evidence |
| --- | --- | --- |
| 1. Bootstrap | Accepted | `3d82da0`, `b95222a`; specification and quality reviews passed. |
| 2. Domain model | Accepted | `1bdb31b` through `4691fb3`; specification and quality reviews passed. |
| 3. Private SQLite store | Accepted | `c23f51f`, `293753b`; specification and quality reviews passed. |
| 4. Retrieval and retention | Accepted | `59a55fc` through `bba542d`; specification and quality reviews passed. |
| 5. Repository knowledge format | Accepted and merged into this branch | `10b5f9a` through `1605a49`; specification and quality reviews passed. |
| 6. CLI and integration fixtures | Accepted | `fa01006`, `ffa9da4`, `5b31ac5`, `c11538c`; specification and quality reviews passed. Fresh `pnpm check` passed with 52 tests. |
| 7. Verification evidence | In progress | Steps 1-3 completed 2026-08-24 16:16:41 CEST: acceptance matrix records a fresh offline-oriented `pnpm check` with 52 passing tests and a no-match network/LLM static scan; staged review found only the planned verification record and execution-plan update, with no whitespace errors or credentials. Commit gate remains. |

Current full verification: `pnpm check` passed on 2026-08-24 with 52 tests, 0 failures.

Task 6 review state: specification and repeated quality reviews accepted the implementation. Task 7 verification evidence is active.

Milestone 1 work outside this local-core plan remains pending: the three source adapters, sanitizer, manual review runtime, reviewer orchestration, candidate-lesson and proposal generation, and the expanded benchmark fixtures.

---

## File structure

- `package.json` - scripts, package metadata, Node engine constraint, development dependencies.
- `tsconfig.json` and `tsconfig.build.json` - strict TypeScript configuration for source and tests.
- `src/domain/types.ts` - branded identifiers, entities, states, scopes, and normalized record schema.
- `src/domain/validation.ts` - shape, reference, privacy, and lifecycle-transition validation.
- `src/domain/transitions.ts` - state transition table and transition-history construction.
- `src/storage/database.ts` - data-directory resolution, SQLite connection, migrations, and transaction wrapper.
- `src/storage/experience-store.ts` - private-record persistence, exact retrieval, retention, and inspection.
- `src/storage/repository-knowledge.ts` - repository index and Markdown persistence with deterministic serialization.
- `src/application/experience-service.ts` - atomic import and command-facing use cases.
- `src/cli.ts` - argument parser, command routing, JSON diagnostics, and process exit codes.
- `test/*.test.ts` - unit and integration tests that compile to `dist/test/` before execution.
- `test/fixtures/*.json` - deterministic normalized-record fixtures.

### Task 1: Bootstrap the repository and test harness

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `.gitignore`
- Create: `src/cli.ts`
- Create: `test/cli.test.ts`

- [x] **Step 1: Initialize Git before creating the first source commit**

Run: `git init`

Expected: a `.git/` directory is created at the workspace root. Do not stage unrelated existing documentation before reviewing it.

- [x] **Step 2: Write the failing CLI smoke test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli } from '../src/cli.js';

test('reports usage for an unknown command', () => {
  const result = runCli(['unknown']);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Unknown command: unknown/);
});
```

- [x] **Step 3: Run the test to verify it fails**

Run: `pnpm test`

Expected: failure because the project and `runCli` do not yet exist.

- [x] **Step 4: Add the minimal executable foundation**

Create `package.json` with `"type": "module"`, `"engines": { "node": ">=22.17.0" }`, scripts `build`, `test`, `check`, and development dependencies `typescript` and `@types/node`. Set `test` to `pnpm build && node --test dist/test/**/*.test.js`; set `check` to `pnpm build && pnpm test`.

Create strict NodeNext TypeScript configuration that includes `src/**/*.ts` and `test/**/*.ts`, writes JavaScript to `dist/`, and excludes `dist/` from compilation. Create `.gitignore` entries for `node_modules/`, `dist/`, `.DS_Store`, `*.sqlite`, `*.sqlite-shm`, and `*.sqlite-wal`.

Implement this initial CLI contract:

```ts
export interface CliResult { exitCode: number; stdout: string; stderr: string; }

export function runCli(args: string[]): CliResult {
  const [command] = args;
  return {
    exitCode: 2,
    stdout: '',
    stderr: `Unknown command: ${command ?? ''}\n`,
  };
}
```

When invoked as the entrypoint, write `stdout` and `stderr`, then set `process.exitCode` without calling `process.exit()`.

- [x] **Step 5: Run the harness checks**

Run: `pnpm check`

Expected: TypeScript compilation and the smoke test pass.

- [x] **Step 6: Commit the bootstrap**

Run: `git add package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json .gitignore src/cli.ts test/cli.test.ts && git commit -m "chore: bootstrap local experience CLI"`

Expected: one commit containing only the harness files.

### Task 2: Define the domain model and deterministic validation

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/domain/transitions.ts`
- Create: `src/domain/validation.ts`
- Create: `test/domain-validation.test.ts`

- [x] **Step 1: Write failing validation tests**

```ts
test('rejects an observation whose source event is missing', () => {
  const result = validateImport(fixtureWithMissingEventReference());
  assert.deepEqual(result, { ok: false, code: 'MISSING_REFERENCE' });
});

test('moves active knowledge to disputed when contradiction evidence is imported', () => {
  const result = applyTransition(verifiedKnowledge(), contradictionEvidence());
  assert.equal(result.entry.state, 'disputed');
  assert.equal(result.history.at(-1)?.to, 'disputed');
});

test('rejects raw transcript and credential-like text', () => {
  assert.equal(validateImport(rawTranscriptFixture()).ok, false);
  assert.equal(validateImport(pemFixture()).ok, false);
});
```

- [x] **Step 2: Run the domain tests to verify they fail**

Run: `pnpm test -- --test-name-pattern="reference|disputed|transcript"`

Expected: compilation failure because the domain modules do not exist.

- [x] **Step 3: Implement types and validation**

Define opaque string IDs for session, event, observation, cluster, candidate lesson, evidence, knowledge, repository, workspace, and user. Define agent sources `codex`, `claude-code`, `cursor`; the eight lesson kinds; the eight lifecycle states; and evidence polarities `confirms`, `contradicts`, `contextualizes`.

Expose these contracts:

```ts
export type ValidationResult = { ok: true } | { ok: false; code: ValidationCode; message: string };
export function validateImport(record: ExperienceImport): ValidationResult;
export function canTransition(from: KnowledgeState, to: KnowledgeState): boolean;
export function applyTransition(entry: KnowledgeEntry, evidence: Evidence): TransitionResult;
```

Require resolvable references, at least one event per observation, at least one observation per cluster, one cluster per candidate, and at least one evidence item plus candidate per durable entry. Permit `candidate → observed → confirmed → verified`; permit active states to `disputed`, `superseded`, `rejected`, or `expired`; permit `disputed` to an active state only when new revalidation evidence is supplied. Treat `superseded`, `rejected`, and `expired` as terminal.

Reject `rawTranscript`, arbitrary `payload`, PEM private-key headers, AWS access-key identifiers, GitHub personal-access tokens, OpenAI API keys, and bearer-token assignments in all persisted text fields.

- [x] **Step 4: Run the domain tests to verify they pass**

Run: `pnpm test -- --test-name-pattern="reference|disputed|transcript"`

Expected: all selected tests pass.

- [x] **Step 5: Commit the domain contract**

Run: `git add src/domain test/domain-validation.test.ts && git commit -m "feat: add validated experience domain model"`

Expected: one commit with only the model, transitions, and their tests.

### Task 3: Add private SQLite storage with atomic import

**Files:**
- Create: `src/storage/database.ts`
- Create: `src/storage/experience-store.ts`
- Create: `test/experience-store.test.ts`

- [x] **Step 1: Write failing store tests**

```ts
test('persists a valid import and retrieves it after reopening the database', () => {
  const store = createTemporaryStore();
  store.import(validPositiveWorkflow());
  assert.equal(reopen(store.path).inspect('knowledge-1').id, 'knowledge-1');
});

test('does not partially write an invalid import', () => {
  const store = createTemporaryStore();
  assert.throws(() => store.import(fixtureWithMissingEventReference()));
  assert.deepEqual(store.listKnowledge(), []);
});
```

- [x] **Step 2: Run the store tests to verify they fail**

Run: `pnpm test -- --test-name-pattern="reopening|partially write"`

Expected: failure because the store modules do not exist.

- [x] **Step 3: Implement SQLite connection, migration, and store**

Use `DatabaseSync` from `node:sqlite` with `enableForeignKeyConstraints: true` and a finite lock timeout. Resolve private data directories from `AEL_DATA_DIR` when set, otherwise `~/Library/Application Support/AgentExperience` on macOS and `${XDG_DATA_HOME:-~/.local/share}/agent-experience` on Linux. Create the directory with owner-only permissions.

Create a versioned `schema_migrations` table and normalized tables for every domain entity and lifecycle history. Use foreign keys, prepared statements, `BEGIN IMMEDIATE`, `COMMIT`, and `ROLLBACK`. `ExperienceStore.import()` must call domain validation before opening its write transaction, then insert all records in dependency order or roll back the entire transaction.

Expose:

```ts
export interface ExperienceStore {
  import(record: ExperienceImport): void;
  inspect(id: string): InspectableRecord | undefined;
  listKnowledge(filter: KnowledgeFilter): KnowledgeEntry[];
  retrieve(filter: RetrievalFilter): KnowledgeEntry[];
  expireUnprotected(now: Date): ExpiryResult;
}
```

- [x] **Step 4: Run store tests to verify they pass**

Run: `pnpm test -- --test-name-pattern="reopening|partially write"`

Expected: both store tests pass.

- [x] **Step 5: Commit private storage**

Run: `git add src/storage/database.ts src/storage/experience-store.ts test/experience-store.test.ts && git commit -m "feat: persist private experience records atomically"`

Expected: one commit containing private storage and tests.

### Task 4: Implement exact retrieval, promotion controls, and retention

**Files:**
- Modify: `src/storage/experience-store.ts`
- Create: `test/retrieval-and-retention.test.ts`

- [x] **Step 1: Write failing retrieval and retention tests**

```ts
test('orders exact retrieval by matched filters, recency, then identifier', () => {
  const results = store.retrieve({ scope: 'repository', path: 'src/a.ts', tool: 'git', tags: ['safety'] });
  assert.deepEqual(results.map(({ id }) => id), ['knowledge-new', 'knowledge-old']);
});

test('does not expire an observation referenced by disputed knowledge', () => {
  store.import(disputedKnowledgeFixture());
  assert.deepEqual(store.expireUnprotected(new Date('2030-01-01')), { expired: [] });
});

test('does not return unapproved global knowledge as authoritative', () => {
  const [entry] = store.retrieve({ scope: 'global' });
  assert.equal(entry.authoritative, false);
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- --test-name-pattern="orders exact|does not expire|unapproved global"`

Expected: failure because filtering, authority, and retention are incomplete.

- [x] **Step 3: Implement retrieval, authority, and retention closure**

Filter only by requested scope, repository ID, normalized path, tool, tag, and lifecycle state. Score each result by the number of supplied matching filters, sort descending by score then descending creation time then ascending ID, and return no cross-repository records.

Set global authority only when `approvalKind = 'user'` and `approvedAt` is non-null. Set repository team authority only when `activation = 'merged-team-active'` and merged provenance is recorded. Traverse retained knowledge, disputed evidence, and lifecycle history before expiring records. Tombstone first; purge only tombstones with no protected inbound reference.

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- --test-name-pattern="orders exact|does not expire|unapproved global"`

Expected: all selected tests pass.

- [x] **Step 5: Commit lifecycle operations**

Run: `git add src/storage/experience-store.ts test/retrieval-and-retention.test.ts && git commit -m "feat: add exact retrieval and safe retention"`

Expected: one commit containing retrieval, promotion controls, and retention.

### Task 5: Implement repository knowledge documents

**Files:**
- Create: `src/storage/repository-knowledge.ts`
- Create: `test/repository-knowledge.test.ts`

- [x] **Step 1: Write failing repository-format tests**

```ts
test('writes a deterministically ordered repository index and entry Markdown', () => {
  writeRepositoryKnowledge(repoRoot, mergedRepositoryKnowledge());
  assert.equal(readFileSync(indexPath, 'utf8'), expectedIndexJson);
  assert.match(readFileSync(entryPath, 'utf8'), /# Prevent destructive reset/);
});

test('rejects team activation without merged provenance', () => {
  assert.throws(() => writeRepositoryKnowledge(repoRoot, branchLocalKnowledge()), /merged provenance/);
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- --test-name-pattern="repository index|merged provenance"`

Expected: failure because repository persistence is absent.

- [x] **Step 3: Implement the Git-reviewable format**

Write `agent-experience/index.json` and `agent-experience/knowledge/<knowledge-id>.md` beneath the selected repository root. Serialize index entries with identity, kind, state, sorted tags, applicability, last verification metadata, approval metadata, and merged provenance. Serialize Markdown with context, statement, recommended behavior, and a non-raw evidence summary. Sort index entries and object keys deterministically. Reject `merged-team-active` entries that lack merged provenance.

- [x] **Step 4: Run repository-format tests to verify they pass**

Run: `pnpm test -- --test-name-pattern="repository index|merged provenance"`

Expected: both tests pass with byte-stable fixture output.

- [x] **Step 5: Commit repository knowledge persistence**

Run: `git add src/storage/repository-knowledge.ts test/repository-knowledge.test.ts && git commit -m "feat: add reviewable repository knowledge format"`

Expected: one commit containing only the repository format.

### Task 6: Complete CLI commands and end-to-end fixtures

**Files:**
- Modify: `src/cli.ts`
- Create: `src/application/experience-service.ts`
- Create: `test/fixtures/positive-workflow.json`
- Create: `test/fixtures/negative-failure.json`
- Create: `test/fixtures/contradiction.json`
- Create: `test/fixtures/unapproved-global.json`
- Create: `test/cli-integration.test.ts`
- Create: `README.md`

- [x] **Step 1: Write failing CLI integration tests**

```ts
test('imports, validates, lists, inspects, retrieves, and exports a fixture', () => {
  assert.equal(runCli(['experience', 'add', '--input', positiveFixture, '--data-dir', tempDir]).exitCode, 0);
  assert.match(runCli(['lessons', 'list', '--json', '--data-dir', tempDir]).stdout, /successful-workflow/);
  assert.match(runCli(['retrieve', '--path', 'src/a.ts', '--tool', 'git', '--tag', 'safety', '--json', '--data-dir', tempDir]).stdout, /knowledge-1/);
});

test('returns JSON diagnostics and leaves data unchanged for corrupt input', () => {
  const result = runCli(['experience', 'add', '--input', corruptFixture, '--json', '--data-dir', tempDir]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /MISSING_REFERENCE/);
});
```

- [x] **Step 2: Run integration tests to verify they fail**

Run: `pnpm test -- --test-name-pattern="imports, validates|JSON diagnostics"`

Expected: failure because the CLI has no command routing.

- [x] **Step 3: Implement the complete CLI surface**

Route `init`, `experience add`, `validate`, `inspect`, `lessons list`, `retrieve`, and `export` through `ExperienceService`. Support `--data-dir` for tests and explicit local use. Support `--json` for structured success and error output. Return exit code `0` for success, `1` for domain or storage errors, and `2` for invalid command syntax. Keep human-readable diagnostics on stderr and JSON diagnostics on stdout when `--json` is selected.

Add fixtures that demonstrate a successful workflow, non-durable failure, contradiction and dispute, unapproved global entry, retention protection, scope isolation, deterministic ordering, and corrupt reference. Document installation, data-directory override, commands, privacy limits, and the absence of network or LLM requirements in `README.md`.

- [x] **Step 4: Run the full verification suite**

Run: `pnpm check`

Expected: strict compilation plus every unit and integration test pass without network access.

- [x] **Step 5: Commit the complete vertical slice**

Run: `git add src/cli.ts src/application/experience-service.ts test/fixtures test/cli-integration.test.ts README.md && git commit -m "feat: deliver local experience core CLI"`

Expected: one commit containing the CLI and end-to-end fixtures.

### Task 7: Verify acceptance coverage and produce review evidence

**Files:**
- Create: `docs/verification/2026-08-24-local-experience-core.md`

- [x] **Step 1: Write the acceptance evidence matrix**

```md
| Acceptance criterion | Test or command | Result |
| --- | --- | --- |
| Contradictions preserve evidence and dispute knowledge | `test/retrieval-and-retention.test.ts` | pass |
| Retention has no dangling references | `test/retrieval-and-retention.test.ts` | pass |
| Unapproved global knowledge is not authoritative | `test/retrieval-and-retention.test.ts` | pass |
| Corrupt input does not change data | `test/cli-integration.test.ts` | pass |
| No network or LLM dependency | `pnpm check` in offline environment | pass |
```

Completed: 2026-08-24 16:14:53 CEST. Verification: `git diff --check -- docs/verification/2026-08-24-local-experience-core.md` exited 0. Review state: Markdown inspected; Task 7 remains in progress pending fresh checks and staged-diff review. Commit SHA: pending Task 7 Step 4.

- [x] **Step 2: Run fresh checks**

Run: `pnpm check`

Expected: all checks pass from a clean working tree except the new verification evidence file.

Completed: 2026-08-24 16:15:52 CEST. Verification: `npm_config_offline=true HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 NO_PROXY= pnpm check` completed successfully with 52 tests passed and 0 failed; the documented static scan produced no matches. Review state: fresh check accepted; Task 7 remains in progress pending staged-diff review. Commit SHA: pending Task 7 Step 4.

- [x] **Step 3: Inspect the staged diff for scope and secrets**

Run: `git diff --check && git add docs/verification/2026-08-24-local-experience-core.md && git diff --staged --check && git diff --staged | rg -i 'password|secret|api_key|token'`

Expected: no whitespace errors; no credentials; only the planned source, tests, fixtures, documentation, and verification evidence are staged.

Completed: 2026-08-24 16:16:41 CEST. Verification: `git diff --check` and `git diff --staged --check` exited 0. The staged diff contained only `docs/verification/2026-08-24-local-experience-core.md` and this required execution-plan update. The credential-pattern scan matched only the literal search terms in this plan's documented command, not a credential value. Review state: scope and whitespace accepted; no credentials found. Commit SHA: pending Task 7 Step 4.

- [ ] **Step 4: Commit verification evidence**

Run: `git commit -m "docs: record local experience core verification"`

Expected: one documentation-only commit.

## Plan self-review

The plan maps every specification goal to a task: CLI and normalized import in Tasks 1 and 6; private transactional storage in Task 3; lifecycle, exact retrieval, promotion, and retention in Tasks 2 and 4; Git-reviewable repository knowledge in Task 5; privacy constraints in Tasks 2 and 6; deterministic benchmarks and verification evidence in Tasks 6 and 7. It deliberately excludes adapters, review orchestration, enforcement, embeddings, daemons, and encryption at rest. Domain names, state names, CLI commands, and exit codes are used consistently across tasks. The placeholder scan found no unfinished implementation directives.
