# Milestone 2.5 passive agent capture implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect Cursor and Codex project hooks to private local technical-action and session-lifecycle capture without changing agent permissions or execution.

**Architecture:** A source-specific hook boundary converts bounded public hook JSON into a closed normalized passive-capture union. A passive service persists session lifecycle and correlated technical events through `ExperienceStore` without calling the runtime gate. Project hook commands call a fail-open CLI ingress whose output cannot deny, ask about, warn about or block an agent action.

**Tech stack:** Node.js 22, TypeScript, `node:sqlite`, `node:test`, pnpm, Cursor project hooks and Codex lifecycle hooks.

---

## Scope map

The implementation changes these units:

- `src/domain/types.ts` defines the optional immutable session end.
- `src/domain/validation.ts` validates closed-session timestamps and event bounds.
- `src/storage/experience-store.ts` owns SQLite migration 11 and atomic session closure.
- `src/capture/passive-service.ts` persists passive records without a runtime decision.
- `src/capture/hook-adapters/` owns raw Cursor and Codex hook parsing.
- `src/capture/hook-ingress.ts` owns bounded input, adapter dispatch and generic diagnostics.
- `src/cli.ts` exposes the fail-open `ael capture hook` process boundary.
- `.agents/hooks/ael-passive-capture.sh` protects both agents from a missing build or process failure.
- `.cursor/hooks.json` and `.codex/hooks.json` register only session and technical lifecycle events.

No runtime policy, shared knowledge, prompt ingestion or reviewer code changes belong in this milestone.

### Task 1: Add the closed-session domain contract

**Files:**

- Modify: `src/domain/types.ts`
- Modify: `src/domain/validation.ts`
- Modify: `test/domain-validation.test.ts`

- [ ] **Step 1: Write failing validation tests**

Add these cases to `test/domain-validation.test.ts`:

```ts
test('accepts an optional canonical session end at or after session start', () => {
  const record = validImport();
  record.sessions[0] = {
    ...record.sessions[0],
    endedAt: '2026-08-24T10:02:00.000Z'
  };

  assert.deepEqual(validateImport(record), { ok: true });
});

test('rejects invalid, non-canonical, and pre-start session ends', () => {
  for (const endedAt of [
    'not-a-time',
    '2026-08-24T12:02:00+02:00',
    '2026-08-24T09:59:59.999Z'
  ]) {
    const record = validImport();
    record.sessions[0] = { ...record.sessions[0], endedAt };
    assert.equal(validateImport(record).ok, false, endedAt);
  }
});

test('rejects events outside their session lifetime', () => {
  for (const occurredAt of [
    '2026-08-24T09:59:59.999Z',
    '2026-08-24T10:02:00.001Z'
  ]) {
    const record = validImport();
    record.sessions[0] = {
      ...record.sessions[0],
      endedAt: '2026-08-24T10:02:00.000Z'
    };
    record.events[0] = { ...record.events[0], occurredAt };
    assert.equal(validateImport(record).ok, false, occurredAt);
  }
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm build && node --test dist/test/domain-validation.test.js
```

Expected: TypeScript reports that `endedAt` does not exist on `Session`, or the new validation assertions fail.

- [ ] **Step 3: Extend the domain type and validation**

Add the optional field to `Session` in `src/domain/types.ts`:

```ts
export interface Session {
  id: SessionId;
  source: AgentSource;
  startedAt: string;
  endedAt?: string;
  repositoryId?: RepositoryId;
  workspaceId?: WorkspaceId;
  userId?: UserId;
}
```

In `src/domain/validation.ts`, add `endedAt` to the session key allowlist and optional string fields. Replace the permissive timestamp helper with canonical validation for session and event lifecycle fields:

```ts
function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validSessionLifetime(session: ExperienceImport['sessions'][number]): boolean {
  return isCanonicalTimestamp(session.startedAt)
    && (session.endedAt === undefined
      || (isCanonicalTimestamp(session.endedAt) && session.endedAt >= session.startedAt));
}
```

After reference validation, validate event bounds against the referenced session:

```ts
const sessionsById = new Map(record.sessions.map((session) => [session.id, session]));
if (record.sessions.some((session) => !validSessionLifetime(session))) {
  return invalid('INVALID_RELATIONSHIP', 'Session lifetime is invalid.');
}
if (record.events.some((event) => {
  const session = sessionsById.get(event.sessionId);
  return !isCanonicalTimestamp(event.occurredAt)
    || session === undefined
    || event.occurredAt < session.startedAt
    || (session.endedAt !== undefined && event.occurredAt > session.endedAt);
})) {
  return invalid('INVALID_RELATIONSHIP', 'Event occurs outside its session lifetime.');
}
```

Keep the existing metadata timestamp validation behavior unchanged.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm build && node --test dist/test/domain-validation.test.js
```

Expected: all domain validation tests pass.

- [ ] **Step 5: Commit the domain increment**

```bash
git add src/domain/types.ts src/domain/validation.ts test/domain-validation.test.ts
git commit -m "feat: define closed session lifecycle"
```

### Task 2: Migrate and persist session closure

**Files:**

- Modify: `src/storage/experience-store.ts`
- Create: `test/session-lifecycle.test.ts`

- [ ] **Step 1: Write failing storage and migration tests**

Create `test/session-lifecycle.test.ts` with focused cases for new databases, legacy databases and immutable closure:

```ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import type { SessionId } from '../src/domain/types.js';
import { ExperienceStore } from '../src/storage/experience-store.js';

const startedAt = '2026-08-26T08:00:00.000Z';
const endedAt = '2026-08-26T08:30:00.000Z';

function databasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'ael-session-life-')), 'experience.sqlite');
}

test('closes a session once and treats the same close as idempotent', () => {
  const store = new ExperienceStore(databasePath());
  const session = { id: 'session-1' as SessionId, source: 'codex' as const, startedAt };

  assert.equal(store.appendIncremental({ session }).inserted, true);
  assert.equal(store.endSession('codex', session.id, endedAt).inserted, true);
  assert.equal(store.endSession('codex', session.id, endedAt).inserted, false);
  assert.deepEqual(store.loadSession(session.id), { ...session, endedAt });
  assert.throws(
    () => store.endSession('codex', session.id, '2026-08-26T08:31:00.000Z'),
    /conflicting.*session end/i
  );
  store.close();
});

test('rejects missing, mismatched, and pre-start session ends atomically', () => {
  const store = new ExperienceStore(databasePath());
  const session = { id: 'session-1' as SessionId, source: 'cursor' as const, startedAt };
  store.appendIncremental({ session });

  assert.throws(() => store.endSession('codex', session.id, endedAt), /source/i);
  assert.throws(() => store.endSession('cursor', 'missing' as SessionId, endedAt), /missing/i);
  assert.throws(() => store.endSession('cursor', session.id, '2026-08-26T07:59:59.999Z'), /precede/i);
  assert.equal(store.loadSession(session.id)?.endedAt, undefined);
  store.close();
});

test('migrates a version 10 session row as open without rewriting it', () => {
  const path = databasePath();
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at TEXT NOT NULL,
      repository_id TEXT, workspace_id TEXT, user_id TEXT
    );
    INSERT INTO sessions (id, source, started_at) VALUES ('legacy', 'codex', '${startedAt}');
  `);
  const migration = legacy.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  for (let version = 1; version <= 10; version += 1) migration.run(version, startedAt);
  legacy.close();

  const store = new ExperienceStore(path);
  assert.deepEqual(store.loadSession('legacy' as SessionId), {
    id: 'legacy', source: 'codex', startedAt
  });
  store.close();
});
```

Add a case that creates a pre-action, closes the session and proves a later event is rejected without adding a `capture_events` row.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm build && node --test dist/test/session-lifecycle.test.js
```

Expected: compilation fails because `endSession` and `loadSession` do not exist.

- [ ] **Step 3: Add migration 11 and lifecycle persistence**

In `src/storage/experience-store.ts`, extend `SessionRow` with `ended_at: string | null` and add:

```ts
const sessionEndMigration = `
  ALTER TABLE sessions ADD COLUMN ended_at TEXT;
`;
```

Apply it after migration 10:

```ts
if (!applied.has(11)) {
  this.database.exec(sessionEndMigration);
  this.database.prepare(
    'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
  ).run(11, new Date().toISOString());
}
```

Update every session `SELECT`, `INSERT`, row mapper and bulk import statement to include `ended_at`. Add public read and close operations:

```ts
loadSession(id: SessionId): Session | undefined {
  const row = this.database.prepare(`
    SELECT id, source, started_at, ended_at, repository_id, workspace_id, user_id
    FROM sessions WHERE id = ?
  `).get(id) as unknown as SessionRow | undefined;
  return row === undefined ? undefined : sessionFromRow(row);
}

endSession(source: Session['source'], id: SessionId, endedAt: string): IncrementalAppendResult {
  assertCanonicalTimestamp(endedAt);
  this.database.exec('BEGIN IMMEDIATE');
  try {
    const current = this.loadSession(id);
    if (current === undefined) throw new TypeError('Cannot end a missing session.');
    if (current.source !== source) throw new TypeError('Session end source conflicts with the stored session.');
    if (endedAt < current.startedAt) throw new TypeError('Session end cannot precede its start.');
    if (current.endedAt !== undefined) {
      if (current.endedAt !== endedAt) throw new TypeError('Conflicting duplicate session end.');
      this.database.exec('COMMIT');
      return Object.freeze({ inserted: false });
    }
    this.database.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(endedAt, id);
    this.database.exec('COMMIT');
    return Object.freeze({ inserted: true });
  } catch (error) {
    this.database.exec('ROLLBACK');
    throw error;
  }
}
```

Extend `assertSameSession`, `assertIncrementalSession`, `insertSession` and `insertCaptureEvent` so an event after `endedAt` is rejected. Bulk import inserts `item.endedAt ?? null` and validation remains the single import boundary.

- [ ] **Step 4: Run lifecycle and storage regression tests**

Run:

```bash
pnpm build && node --test dist/test/session-lifecycle.test.js dist/test/experience-store.test.js dist/test/automatic-capture.test.js
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit the storage increment**

```bash
git add src/storage/experience-store.ts test/session-lifecycle.test.ts
git commit -m "feat: persist immutable session ends"
```

### Task 3: Add a runtime-independent passive capture service

**Files:**

- Create: `src/capture/passive-service.ts`
- Create: `test/passive-capture.test.ts`

- [ ] **Step 1: Write failing passive-service tests**

Create `test/passive-capture.test.ts`. Use a real temporary `ExperienceStore` and normalized adapter events. Cover start, pre-action, post-result, end, duplicate delivery and degraded persistence:

```ts
test('records a complete passive lifecycle without a runtime decision', () => {
  const store = temporaryStore();
  const service = createPassiveCaptureService({ store });
  const session = {
    id: 'passive-session' as SessionId,
    source: 'codex' as const,
    startedAt: '2026-08-26T08:00:00.000Z'
  };

  assert.equal(service.capture({ kind: 'session-start', session }).status, 'captured');
  assert.equal(service.capture({ kind: 'technical', event: preEvent() }).status, 'captured');
  assert.equal(service.capture({ kind: 'technical', event: postEvent() }).status, 'captured');
  assert.equal(service.capture({
    kind: 'session-end', source: 'codex', sessionId: session.id,
    endedAt: '2026-08-26T08:01:00.000Z'
  }).status, 'captured');

  assert.deepEqual(store.listCapturedEventsPage().entries.map(({ phase }) => phase), [
    'pre-action', 'post-result'
  ]);
  assert.equal(store.loadSession(session.id)?.endedAt, '2026-08-26T08:01:00.000Z');
  store.close();
});

test('degrades without throwing or changing an external action outcome', () => {
  const service = createPassiveCaptureService({
    store: {
      appendIncremental() { throw new Error('Bearer: value-that-must-not-leak'); },
      endSession() { throw new Error('database unavailable'); }
    }
  });

  assert.deepEqual(service.capture({ kind: 'technical', event: preEvent() }), {
    status: 'degraded', diagnostic: { code: 'PASSIVE_CAPTURE_FAILED', eventClass: 'technical' }
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
pnpm build && node --test dist/test/passive-capture.test.js
```

Expected: compilation fails because the passive service does not exist.

- [ ] **Step 3: Implement the passive union and service**

Create `src/capture/passive-service.ts` with this public contract:

```ts
import type { AgentSource, Session, SessionId } from '../domain/types.js';
import type { IncrementalAppendResult, IncrementalCaptureAppend, NormalizedCaptureEvent } from './contracts.js';

export type PassiveCaptureRecord =
  | { readonly kind: 'session-start'; readonly session: Session }
  | { readonly kind: 'session-end'; readonly source: AgentSource; readonly sessionId: SessionId; readonly endedAt: string }
  | { readonly kind: 'technical'; readonly event: NormalizedCaptureEvent; readonly session?: Session };

export interface PassiveCaptureStore {
  appendIncremental(input: IncrementalCaptureAppend): IncrementalAppendResult;
  endSession(source: AgentSource, id: SessionId, endedAt: string): IncrementalAppendResult;
}

export type PassiveCaptureResult =
  | { readonly status: 'captured' | 'duplicate' }
  | { readonly status: 'degraded'; readonly diagnostic: {
      readonly code: 'PASSIVE_CAPTURE_FAILED';
      readonly eventClass: PassiveCaptureRecord['kind'];
    } };

export function createPassiveCaptureService(options: { readonly store: PassiveCaptureStore }) {
  return Object.freeze({
    capture(record: PassiveCaptureRecord): PassiveCaptureResult {
      try {
        const result = record.kind === 'session-start'
          ? options.store.appendIncremental({ session: record.session })
          : record.kind === 'session-end'
            ? options.store.endSession(record.source, record.sessionId, record.endedAt)
            : options.store.appendIncremental({
                ...(record.session === undefined ? {} : { session: record.session }),
                event: record.event
              });
        return Object.freeze({ status: result.inserted ? 'captured' : 'duplicate' });
      } catch {
        return Object.freeze({
          status: 'degraded',
          diagnostic: Object.freeze({ code: 'PASSIVE_CAPTURE_FAILED', eventClass: record.kind })
        });
      }
    }
  });
}
```

Do not create a synthetic `GateDecision`, enforcement snapshot, contradiction or override evidence.

- [ ] **Step 4: Run passive and existing capture tests**

```bash
pnpm build && node --test dist/test/passive-capture.test.js dist/test/automatic-capture.test.js dist/test/incremental-evidence.test.js
```

Expected: all selected tests pass and the existing decision-bound capture behavior is unchanged.

- [ ] **Step 5: Commit the passive service**

```bash
git add src/capture/passive-service.ts test/passive-capture.test.ts
git commit -m "feat: add runtime-independent passive capture"
```

### Task 4: Normalize public Cursor and Codex hook events

**Files:**

- Create: `src/capture/hook-adapters/contracts.ts`
- Create: `src/capture/hook-adapters/technical-signature.ts`
- Create: `src/capture/hook-adapters/codex.ts`
- Create: `src/capture/hook-adapters/cursor.ts`
- Create: `src/capture/hook-adapters/index.ts`
- Create: `test/passive-hook-adapters.test.ts`

- [ ] **Step 1: Write failing cross-source adapter tests**

Create equivalent Cursor and Codex fixtures using only documented public hook fields. The test clock returns `2026-08-26T08:00:00.000Z` for pre-use and `2026-08-26T08:00:01.000Z` for post-use.

```ts
test('normalizes equivalent public shell hooks without raw output', () => {
  const codexPre = adaptPassiveHook('codex', {
    session_id: 'session-1', cwd: '/work/repo', hook_event_name: 'PreToolUse',
    tool_name: 'Bash', tool_use_id: 'tool-1',
    tool_input: { command: 'git status --short' }
  }, preTime);
  const cursorPre = adaptPassiveHook('cursor', {
    conversation_id: 'session-1', hook_event_name: 'preToolUse', cwd: '/work/repo',
    tool_name: 'Shell', tool_use_id: 'tool-1',
    tool_input: { command: 'git status --short' }
  }, preTime);

  assert.deepEqual(comparableTechnical(cursorPre), comparableTechnical(codexPre));
  assert.equal(JSON.stringify(codexPre).includes('tool_response'), false);
});

test('maps session start and end without transcript or user identity fields', () => {
  assert.deepEqual(adaptPassiveHook('codex', {
    session_id: 'session-1', cwd: '/work/repo', hook_event_name: 'SessionStart',
    source: 'startup', transcript_path: '/private/transcript.jsonl'
  }, preTime), {
    kind: 'session-start',
    session: { id: 'session-1', source: 'codex', startedAt: preTime }
  });

  assert.deepEqual(adaptPassiveHook('cursor', {
    conversation_id: 'session-1', hook_event_name: 'sessionEnd',
    reason: 'completed', user_email: 'private@example.test'
  }, postTime), {
    kind: 'session-end', source: 'cursor', sessionId: 'session-1', endedAt: postTime
  });
});

test('rejects credential-bearing technical input without returning its value', () => {
  const marker = 'classified-private-value';
  assert.throws(
    () => adaptPassiveHook('codex', {
      session_id: 'session-1', cwd: '/work/repo', hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_use_id: 'tool-secret',
      tool_input: { command: `curl --header Authorization:Bearer=${marker} https://example.test` }
    }, preTime),
    (error: unknown) => error instanceof Error
      && /private|credential/i.test(error.message)
      && !error.message.includes(marker)
  );
});
```

Also test MCP calls, `apply_patch` or file-edit metadata, post/pre correlation, unsupported prompt events, oversized standard fields, complex shell syntax and duplicate source identities.

- [ ] **Step 2: Run adapter tests and verify RED**

```bash
pnpm build && node --test dist/test/passive-hook-adapters.test.js
```

Expected: compilation fails because `adaptPassiveHook` does not exist.

- [ ] **Step 3: Define the raw-hook boundary**

Create `src/capture/hook-adapters/contracts.ts`:

```ts
import type { AgentSource } from '../../domain/types.js';
import type { PassiveCaptureRecord } from '../passive-service.js';

export type PassiveHookSource = Extract<AgentSource, 'codex' | 'cursor'>;
export const MAX_HOOK_INPUT_BYTES = 65_536;

export interface PassiveHookAdapter {
  adapt(payload: unknown, receivedAt: string): PassiveCaptureRecord | undefined;
}
```

`undefined` means the documented hook is outside the configured technical and session scope. It is not a persistence error.

- [ ] **Step 4: Implement conservative technical-signature extraction**

In `technical-signature.ts`, expose a function that returns the mapped fields expected by `normalizeMappedCapture`:

```ts
export interface TechnicalSignatureInput {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly cwd?: string;
}

export interface TechnicalSignature {
  readonly tool: string;
  readonly action: string;
  readonly arguments?: readonly string[];
  readonly path?: string;
  readonly summary: string;
}

export function technicalSignature(input: TechnicalSignatureInput): TechnicalSignature;
```

Apply these closed rules:

- `Bash` and `Shell` accept only a single simple command token sequence. Reject control operators, substitutions, newlines and tokens that cannot pass the existing bounded argument classifier. Map the executable to `action`, use `tool: "shell"`, and retain only the safe remaining tokens.
- MCP names beginning with `mcp__` map to `tool: "mcp"`, the normalized MCP name as `action`, and bounded top-level scalar `key=value` arguments. Reject nested objects, arrays and sensitive key names.
- `apply_patch`, `Edit` and `Write` map to `tool: "file"`, `action: "edit"`, no patch content and an allowlisted path only when the public input provides one separately.
- Other local function tools are outside this milestone and return `undefined`.
- Run credential classification over every candidate persisted token before returning. Never include a rejected token in an error.

Do not persist `tool_response`, `agent_message`, `transcript_path`, `user_email`, environment values or model metadata.

- [ ] **Step 5: Implement source adapters and dispatch**

In `codex.ts`, accept `SessionStart`, `SessionEnd`, `PreToolUse` and `PostToolUse`. Use `session_id`, `tool_use_id`, `tool_name`, `tool_input` and `cwd`. Build stable source identities as `${tool_use_id}:pre` and `${tool_use_id}:post`; post records relate to `${tool_use_id}:pre`. A post result is `unknown` unless a documented scalar exit status is present.

In `cursor.ts`, accept `sessionStart`, `sessionEnd`, `preToolUse` and `postToolUse`. Prefer `conversation_id` for the session identity and allow documented `session_id` only for lifecycle payloads that omit it. Use the same source-event suffixes and technical signature rules as Codex.

Export a closed dispatcher from `index.ts`:

```ts
const adapters: Readonly<Record<PassiveHookSource, PassiveHookAdapter>> = Object.freeze({
  codex: Object.freeze({ adapt: adaptCodexPassiveHook }),
  cursor: Object.freeze({ adapt: adaptCursorPassiveHook })
});

export function adaptPassiveHook(
  source: PassiveHookSource,
  payload: unknown,
  receivedAt: string
): PassiveCaptureRecord | undefined {
  return adapters[source].adapt(payload, receivedAt);
}
```

Both adapters must validate `receivedAt` as canonical UTC and use generic errors that contain no caller-controlled values.

- [ ] **Step 6: Run cross-source and privacy tests**

```bash
pnpm build && node --test dist/test/passive-hook-adapters.test.js dist/test/capture-adapter-equivalence.test.js dist/test/milestone-2-acceptance.test.js
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit hook normalization**

```bash
git add src/capture/hook-adapters test/passive-hook-adapters.test.ts
git commit -m "feat: normalize Cursor and Codex passive hooks"
```

### Task 5: Expose a bounded fail-open hook CLI

**Files:**

- Create: `src/capture/hook-ingress.ts`
- Modify: `src/application/experience-service.ts`
- Modify: `src/cli.ts`
- Create: `test/passive-hook-cli.test.ts`

- [ ] **Step 1: Write failing CLI boundary tests**

Create `test/passive-hook-cli.test.ts` and inject input plus clock through `RunCliAsyncOptions`:

```ts
test('captures a hook with empty stdout and exit zero', async () => {
  const dataDir = temporaryDataDirectory();
  const result = await runCliAsync(
    ['capture', 'hook', '--source', 'codex', '--data-dir', dataDir],
    {
      hookInput: JSON.stringify({
        session_id: 'session-1', cwd: '/work/repo', hook_event_name: 'SessionStart',
        source: 'startup'
      }),
      now: () => '2026-08-26T08:00:00.000Z'
    }
  );

  assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
  assert.equal(readSession(dataDir, 'session-1')?.source, 'codex');
});

test('fails open with a bounded generic diagnostic for invalid and private input', async () => {
  const marker = 'classified-private-value';
  for (const hookInput of [
    '{not-json',
    JSON.stringify({
      session_id: 'session-1', cwd: '/work/repo', hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_use_id: 'tool-1',
      tool_input: { command: `curl --token=${marker}` }
    }),
    'x'.repeat(65_537)
  ]) {
    const result = await runCliAsync(
      ['capture', 'hook', '--source', 'codex', '--data-dir', temporaryDataDirectory()],
      { hookInput, now: () => '2026-08-26T08:00:00.000Z' }
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^AEL_CAPTURE_[A-Z_]+: Passive capture skipped\.\n$/);
    assert.equal(result.stderr.includes(marker), false);
  }
});
```

Test Cursor dispatch, ignored nontechnical events, absent `--source`, unsupported sources and database failure. Every recognized `capture hook` invocation exits zero.

- [ ] **Step 2: Run CLI tests and verify RED**

```bash
pnpm build && node --test dist/test/passive-hook-cli.test.js
```

Expected: assertions fail because the CLI does not recognize `capture hook`.

- [ ] **Step 3: Implement bounded ingress**

Create `src/capture/hook-ingress.ts`:

```ts
import { adaptPassiveHook } from './hook-adapters/index.js';
import { MAX_HOOK_INPUT_BYTES, type PassiveHookSource } from './hook-adapters/contracts.js';
import { createPassiveCaptureService } from './passive-service.js';
import { ExperienceStore } from '../storage/experience-store.js';

export interface HookIngressOptions {
  readonly source: PassiveHookSource;
  readonly input: string;
  readonly databasePath: string;
  readonly now: () => string;
}

export type HookIngressResult =
  | { readonly status: 'captured' | 'duplicate' | 'ignored' }
  | { readonly status: 'degraded'; readonly code: 'INVALID_INPUT' | 'PRIVATE_INPUT' | 'PERSISTENCE_FAILED' };

export function ingestPassiveHook(options: HookIngressOptions): HookIngressResult;
```

The implementation checks UTF-8 byte length before `JSON.parse`, dispatches the adapter, opens the store only for a supported record, invokes the passive service and closes the store in `finally`. It maps all internal errors to the three stable codes without returning error messages or input values.

- [ ] **Step 4: Wire the service and asynchronous CLI path**

Add an `ExperienceService.captureHook` method that supplies its private database path to `ingestPassiveHook`.

Extend `RunCliAsyncOptions` in `src/cli.ts`:

```ts
export interface RunCliAsyncOptions {
  readonly terminal?: TerminalHost;
  readonly reviewDependencies?: ManualReviewDependencies;
  readonly hookInput?: string;
  readonly now?: () => string;
}
```

Route `capture hook` before the review branch. Parse only `--source` and `--data-dir`. The command returns:

```ts
function hookCliResult(result: HookIngressResult): CliResult {
  if (result.status !== 'degraded') return { exitCode: 0, stdout: '', stderr: '' };
  return {
    exitCode: 0,
    stdout: '',
    stderr: `AEL_CAPTURE_${result.code}: Passive capture skipped.\n`
  };
}
```

When called as the executable, read standard input with an asynchronous bounded reader that stops after `MAX_HOOK_INPUT_BYTES + 1`. Do not read stdin for any other command. Add `capture hook` to help output without changing ordinary syntax-error exit codes.

- [ ] **Step 5: Run CLI, privacy and package tests**

```bash
pnpm build && node --test dist/test/passive-hook-cli.test.js dist/test/cli.test.js dist/test/cli-integration.test.js dist/test/review-privacy-contract.test.js
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit the CLI ingress**

```bash
git add src/capture/hook-ingress.ts src/application/experience-service.ts src/cli.ts test/passive-hook-cli.test.ts
git commit -m "feat: expose fail-open passive hook ingress"
```

### Task 6: Register project hooks for Cursor and Codex

**Files:**

- Create: `.agents/hooks/ael-passive-capture.sh`
- Create: `.cursor/hooks.json`
- Create: `.codex/hooks.json`
- Modify: `docs/setup/02-codex.md`
- Modify: `docs/setup/04-cursor.md`
- Modify: `README.md`
- Create: `test/project-hook-configuration.test.ts`

- [ ] **Step 1: Write failing project-configuration tests**

Create `test/project-hook-configuration.test.ts`:

```ts
test('registers only passive technical and session hooks', () => {
  const cursor = JSON.parse(readFileSync('.cursor/hooks.json', 'utf8'));
  const codex = JSON.parse(readFileSync('.codex/hooks.json', 'utf8'));

  assert.deepEqual(Object.keys(cursor.hooks).sort(), [
    'postToolUse', 'preToolUse', 'sessionEnd', 'sessionStart'
  ]);
  assert.deepEqual(Object.keys(codex.hooks).sort(), [
    'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart'
  ]);
  assert.equal(JSON.stringify({ cursor, codex }).includes('Prompt'), false);
  assert.equal(JSON.stringify({ cursor, codex }).includes('beforeSubmitPrompt'), false);
});

test('uses one fail-open wrapper without permission output', () => {
  const wrapper = readFileSync('.agents/hooks/ael-passive-capture.sh', 'utf8');
  assert.match(wrapper, /^#!\/bin\/sh\n/);
  assert.match(wrapper, /capture hook --source/);
  assert.doesNotMatch(wrapper, /deny|ask|BLOCK|permissionDecision/);
  assert.equal(statSync('.agents/hooks/ael-passive-capture.sh').mode & 0o111, 0o111);
});
```

- [ ] **Step 2: Run configuration tests and verify RED**

```bash
pnpm build && node --test dist/test/project-hook-configuration.test.js
```

Expected: the hook files do not exist.

- [ ] **Step 3: Add the shared fail-open wrapper**

Create executable `.agents/hooks/ael-passive-capture.sh`:

```sh
#!/bin/sh

source_name="$1"
repository_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cli="$repository_root/dist/src/cli.js"

if [ ! -f "$cli" ]; then
  printf '%s\n' 'AEL_CAPTURE_UNAVAILABLE: Passive capture skipped.' >&2
  exit 0
fi

node "$cli" capture hook --source "$source_name" || {
  printf '%s\n' 'AEL_CAPTURE_UNAVAILABLE: Passive capture skipped.' >&2
  exit 0
}

exit 0
```

Mark it executable with `chmod 755 .agents/hooks/ael-passive-capture.sh`. The wrapper preserves stdin for the Node process and never prints hook JSON.

- [ ] **Step 4: Add Cursor hook configuration**

Create `.cursor/hooks.json` using the current version 1 project format:

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      { "command": ".agents/hooks/ael-passive-capture.sh cursor" }
    ],
    "sessionEnd": [
      { "command": ".agents/hooks/ael-passive-capture.sh cursor" }
    ],
    "preToolUse": [
      { "command": ".agents/hooks/ael-passive-capture.sh cursor" }
    ],
    "postToolUse": [
      { "command": ".agents/hooks/ael-passive-capture.sh cursor" }
    ]
  }
}
```

If implementation-time validation against the installed Cursor version rejects generic `preToolUse` or `postToolUse`, stop and amend Spec 008 before substituting event families. Do not silently use uncorrelated `afterFileEdit` as a post-result.

- [ ] **Step 5: Add Codex hook configuration**

Create `.codex/hooks.json`:

```json
{
  "description": "Passive local technical-action and session capture.",
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": ".agents/hooks/ael-passive-capture.sh codex" }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": ".agents/hooks/ael-passive-capture.sh codex", "timeout": 3 }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash|apply_patch|mcp__.*",
        "hooks": [
          { "type": "command", "command": ".agents/hooks/ael-passive-capture.sh codex" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash|apply_patch|mcp__.*",
        "hooks": [
          { "type": "command", "command": ".agents/hooks/ael-passive-capture.sh codex" }
        ]
      }
    ]
  }
}
```

Codex users must review and trust the project hooks through `/hooks`. Do not use `--dangerously-bypass-hook-trust` in project configuration.

- [ ] **Step 6: Document setup and operational boundaries**

Update `README.md`, `docs/setup/02-codex.md` and `docs/setup/04-cursor.md` with:

- `pnpm build` is required before the checked-in wrapper can invoke the CLI.
- the local database remains under `AEL_DATA_DIR` or the platform default;
- only session and technical events are registered;
- prompt and transcript content is excluded;
- capture failures produce a generic diagnostic and never block an action;
- Codex hook trust must be reviewed after hook changes;
- removing the project hook entries stops future capture without deleting data.

- [ ] **Step 7: Run configuration and CLI tests**

```bash
pnpm build && node --test dist/test/project-hook-configuration.test.js dist/test/passive-hook-cli.test.js
```

Expected: all selected tests pass.

- [ ] **Step 8: Commit project integration**

```bash
git add .agents/hooks/ael-passive-capture.sh .cursor/hooks.json .codex/hooks.json README.md docs/setup/02-codex.md docs/setup/04-cursor.md test/project-hook-configuration.test.ts
git commit -m "feat: register passive Cursor and Codex hooks"
```

### Task 7: Prove Milestone 2.5 acceptance and update delivery evidence

**Files:**

- Create: `test/milestone-2-5-acceptance.test.ts`
- Create: `docs/verification/2026-08-26-milestone-2-5-passive-agent-capture.md`
- Modify: `docs/product/roadmap.md`

- [ ] **Step 1: Write the end-to-end acceptance test**

Create `test/milestone-2-5-acceptance.test.ts`. Drive `runCliAsync` with Cursor and Codex session start, correlated pre/post technical events and session end. Reopen the real SQLite store and assert:

```ts
assert.deepEqual(store.listCapturedEventsPage().entries.map((event) => ({
  source: event.source,
  phase: event.phase,
  sessionId: event.sessionId,
  outcome: event.outcome
})), [
  { source: 'codex', phase: 'pre-action', sessionId: 'codex-session', outcome: undefined },
  { source: 'codex', phase: 'post-result', sessionId: 'codex-session', outcome: 'unknown' },
  { source: 'cursor', phase: 'pre-action', sessionId: 'cursor-session', outcome: undefined },
  { source: 'cursor', phase: 'post-result', sessionId: 'cursor-session', outcome: 'unknown' }
]);
assert.equal(store.loadSession('codex-session' as SessionId)?.endedAt, endTime);
assert.equal(store.loadSession('cursor-session' as SessionId)?.endedAt, endTime);
```

Add acceptance cases proving:

- every hook response has exit code zero and empty stdout;
- duplicate deliveries do not add rows;
- credential markers are absent from the SQLite file and diagnostics;
- raw tool response, transcript path, prompt and user email markers are absent from SQLite;
- a missing build makes the shell wrapper exit zero;
- events after session closure are not written;
- neither configuration registers prompt events or permission decisions.

- [ ] **Step 2: Run the acceptance test and fix only requirement gaps**

```bash
pnpm build && node --test dist/test/milestone-2-5-acceptance.test.js
```

Expected: all Milestone 2.5 acceptance cases pass. If a failure reveals a specification ambiguity, stop and amend Spec 008 before changing behavior.

- [ ] **Step 3: Run the complete offline verification**

```bash
pnpm check
```

Expected: the complete test suite passes with zero failures and zero skipped tests.

- [ ] **Step 4: Run privacy, dependency and diff checks**

```bash
rg -n "fetch\(|https?://|node:https|node:http|child_process" src/capture src/domain src/storage
git diff --check
git status --short
```

Expected: no new capture-path network or LLM client appears; `child_process` is absent from the passive capture path; the diff has no whitespace errors; status contains only Milestone 2.5 files.

Search the staged diff for credential assignments without printing any local environment values:

```bash
git diff --cached | rg -n -i "password[[:space:]]*[:=]|api[_-]?key[[:space:]]*[:=]|bearer[[:space:]]+[A-Za-z0-9]"
```

Expected: no credential value is present. Literal privacy-test patterns are reviewed as test data and must use obvious non-secret markers.

- [ ] **Step 5: Record verification evidence and close the roadmap item**

Create `docs/verification/2026-08-26-milestone-2-5-passive-agent-capture.md` with the commit under test, exact commands, pass counts, migration result, cross-source acceptance result, privacy scan result and known non-goals.

Update the Milestone 2.5 status in `docs/product/roadmap.md` only after the full verification passes. State the observed test runner count explicitly, followed by `0 failed and 0 skipped`. Do not estimate or copy the Milestone 2 count.

- [ ] **Step 6: Commit final acceptance evidence**

```bash
git add test/milestone-2-5-acceptance.test.ts docs/verification/2026-08-26-milestone-2-5-passive-agent-capture.md docs/product/roadmap.md
git diff --cached --check
git commit -m "docs: verify milestone 2.5 passive capture"
```

- [ ] **Step 7: Inspect final history and worktree state**

```bash
git log --oneline -8
git status --short
```

Expected: the seven Milestone 2.5 increments are visible as focused commits and the worktree is clean.
