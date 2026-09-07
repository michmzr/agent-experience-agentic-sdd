# M4 durable asynchronous capture implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve sanitized passive-hook events in a private durable spool without waiting for main-store ingestion.

**Architecture:** Add a focused `CaptureSpool` SQLite repository for transactional admission, leases, retry state, quarantine and aggregate counters. Hook ingress adapts and sanitizes input before spool admission, starts a bounded detached drain process after admission, and keeps the source-facing response fail-open. The drain process persists queued records through the existing idempotent `ExperienceStore` interface.

**Tech Stack:** Node.js 22 `node:sqlite` `DatabaseSync`, TypeScript, Node test runner, pnpm.

---

## File structure

- `src/capture/spool.ts`: versioned private spool schema, admission, claims, acknowledgement, retry, quarantine and status.
- `src/capture/spool-drain.ts`: ordering and bounded drain loop against the existing passive capture service.
- `src/capture/hook-ingress.ts`: sanitized admission, deadline and best-effort detached drain start.
- `src/application/experience-service.ts`: explicit drain/status service operations.
- `src/cli.ts`: `capture drain` and `capture status` contracts.
- `src/storage/experience-store.ts`: permits late but in-bound technical records after an immutable close.
- `test/capture-spool.test.ts`: storage durability, recovery, capacity, privacy and quarantine tests.
- `test/milestone-4-acceptance.test.ts`: hook, lock, ordering, lifecycle, CLI and benchmark acceptance tests.
- `docs/verification/2026-09-07-milestone-4-asynchronous-capture.md`: commands, hardware, p50/p95/p99, throughput and acceptance evidence.

### Task 1: Define the private spool contract

**Files:**

- Create: `src/capture/spool.ts`
- Test: `test/capture-spool.test.ts`

- [x] **Step 1: Write failing tests for durable admission, idempotency and status.**

```ts
const spool = new CaptureSpool(join(dataDir, 'capture-spool.sqlite'));
assert.equal(spool.admit(record).status, 'admitted');
assert.equal(spool.admit(record).status, 'duplicate');
assert.deepEqual(spool.status(), {
  version: 1, admitted: 1, pending: 1, claimed: 0, committed: 0,
  quarantined: 0, failedAdmission: 0
});
```

- [x] **Step 2: Run the focused test and confirm it fails because `CaptureSpool` does not exist.**

Run: `pnpm build && node --test dist/test/capture-spool.test.js`

Expected: failing import or missing constructor.

- [x] **Step 3: Implement the minimal spool.**

```ts
export class CaptureSpool {
  admit(record: PassiveCaptureRecord): SpoolAdmission;
  claim(now: string, limit: number): readonly ClaimedSpoolRecord[];
  acknowledge(deliveryId: string): void;
  retry(deliveryId: string, now: string): void;
  quarantine(deliveryId: string, code: 'CORRUPT' | 'UNSUPPORTED'): void;
  status(): CaptureSpoolStatus;
  close(): void;
}
```

Open the database with `timeout: 250`, apply `PRAGMA journal_mode = WAL`, `PRAGMA synchronous = FULL`, `PRAGMA foreign_keys = ON`, create strict `records`, `quarantine` and `counters` tables, and bind every value through prepared statements. Serialize only `PassiveCaptureRecord` after the adapters have produced it. Use a deterministic SHA-256 delivery ID over schema version plus canonical serialized record. In an immediate transaction, reject capacity beyond 50,000 active records or 32 MiB, insert only if the delivery ID is absent, and increment `admitted` only after the transaction commits.

- [x] **Step 4: Run the focused test and confirm it passes.**

Run: `pnpm build && node --test dist/test/capture-spool.test.js`

Expected: all spool admission and status tests pass.

- [x] **Step 5: Commit the slice.**

```bash
git add src/capture/spool.ts test/capture-spool.test.ts
git commit -m "feat: add durable capture spool admission"
```

### Task 2: Add recovery, privacy and bounded resource tests

**Files:**

- Modify: `src/capture/spool.ts`
- Modify: `test/capture-spool.test.ts`

- [x] **Step 1: Write failing tests for expired leases, post-commit replay, full queues, corrupt records and secret absence.**

```ts
const [claimed] = spool.claim('2026-09-07T08:00:00.000Z', 1);
assert.equal(spool.claim('2026-09-07T08:00:31.000Z', 1)[0]?.deliveryId, claimed?.deliveryId);
spool.quarantine(claimed!.deliveryId, 'CORRUPT');
assert.equal(readFileSync(spoolPath).includes(Buffer.from(secretMarker)), false);
```

- [x] **Step 2: Run the focused test and confirm the new cases fail.**

Run: `pnpm build && node --test dist/test/capture-spool.test.js`

Expected: lease, capacity or quarantine assertions fail.

- [x] **Step 3: Implement recoverable claims and bounded quarantine.**

```ts
claim(now, limit) {
  this.database.exec('BEGIN IMMEDIATE');
  // Reclaim leases where lease_until <= now, then claim due pending rows.
  // Persist lease_until = now + 30 seconds and increment attempts.
  this.database.exec('COMMIT');
}
```

Use `next_retry_at` with exponential delay from 100 ms to 30 seconds. A successful acknowledgement deletes the record and increments `committed` in one transaction. Quarantine only stores the normalized serialized record and a fixed code, with a fixed bound of 1,000 rows. Invalid stored JSON and unknown schema versions move to quarantine. Admission errors update `failedAdmission` only when that counter transaction itself succeeds; no raw input is logged or written.

- [x] **Step 4: Run the focused test and confirm it passes.**

Run: `pnpm build && node --test dist/test/capture-spool.test.js`

Expected: all spool recovery, capacity and privacy tests pass.

- [x] **Step 5: Commit the slice.**

```bash
git add src/capture/spool.ts test/capture-spool.test.ts
git commit -m "feat: recover and quarantine durable capture records"
```

### Task 3: Drain queued records independently from hooks

**Files:**

- Create: `src/capture/spool-drain.ts`
- Modify: `src/capture/hook-ingress.ts`
- Modify: `src/application/experience-service.ts`
- Test: `test/milestone-4-acceptance.test.ts`

- [x] **Step 1: Write failing recovery and locked-main-store tests.**

```ts
const admitted = ingestPassiveHook({ source: 'codex', input, databasePath, now });
assert.deepEqual(admitted, { status: 'captured' });
assert.equal(new ExperienceStore(databasePath).loadSession(sessionId), undefined);
await drainCaptureSpool({ databasePath, now });
assert.deepEqual(new ExperienceStore(databasePath).loadSession(sessionId), expectedSession);
```

- [x] **Step 2: Run the focused acceptance test and confirm it fails.**

Run: `pnpm build && node --test dist/test/milestone-4-acceptance.test.js`

Expected: missing drain entrypoint or synchronous main-store write assertion failure.

- [x] **Step 3: Implement the bounded drain loop and ingress handoff.**

```ts
export function drainCaptureSpool(input: DrainCaptureSpoolInput): CaptureSpoolStatus {
  for (const record of spool.claim(input.now(), 100)) {
    try { persistOrdered(input.store, record); spool.acknowledge(record.deliveryId); }
    catch (error) { isPermanent(error) ? spool.quarantine(record.deliveryId, 'CORRUPT') : spool.retry(record.deliveryId, input.now()); }
  }
  return spool.status();
}
```

Adapt and sanitize before calling `spool.admit`. Never open `ExperienceStore` in the hook admission path. Invoke an injected scheduler after successful admission; production uses `spawn(process.execPath, [cliEntrypoint, 'capture', 'drain', '--data-dir', dataDir], { detached: true, stdio: 'ignore' }).unref()`. Scheduler failure leaves the record pending. The explicit service drain opens the main store only while processing claims.

- [x] **Step 4: Run the focused acceptance test and confirm it passes.**

Run: `pnpm build && node --test dist/test/milestone-4-acceptance.test.js`

Expected: admitted events survive a locked main store and later drain once.

- [x] **Step 5: Commit the slice.**

```bash
git add src/capture/spool-drain.ts src/capture/hook-ingress.ts src/application/experience-service.ts test/milestone-4-acceptance.test.ts
git commit -m "feat: drain passive capture asynchronously"
```

### Task 4: Preserve valid late records and expose operations

**Files:**

- Modify: `src/storage/experience-store.ts`
- Modify: `src/cli.ts`
- Modify: `test/session-lifecycle.test.ts`
- Modify: `test/milestone-4-acceptance.test.ts`

- [x] **Step 1: Write failing late-record and CLI contract tests.**

```ts
store.endSession('codex', session.id, endedAt);
assert.equal(store.appendIncremental({ event: inBoundLateEvent }).inserted, true);
assert.throws(() => store.appendIncremental({ event: afterEndEvent }), /lifetime/i);
assert.deepEqual(runCli(['capture', 'status', '--data-dir', dataDir, '--json']), {
  exitCode: 0, stdout: `${JSON.stringify(expectedStatus)}\n`, stderr: ''
});
```

- [x] **Step 2: Run the focused tests and confirm the new cases fail.**

Run: `pnpm build && node --test dist/test/session-lifecycle.test.js dist/test/milestone-4-acceptance.test.js`

Expected: in-bound late event is rejected and capture subcommands are unknown.

- [x] **Step 3: Implement the compatibility amendment and CLI.**

```ts
if (persistedSession.endedAt !== undefined && Date.parse(event.occurredAt) > Date.parse(persistedSession.endedAt)) {
  throw new TypeError('Capture event exceeds the session lifetime.');
}
```

Retain existing start and correlation validation. Add `capture drain` and `capture status` to `knownCommands`, argument validation, usage text and `ExperienceService`. `capture status` returns only versioned aggregate counts. Both commands use ordinary CLI failure semantics; only `capture hook` is source-facing fail-open.

- [x] **Step 4: Run the focused tests and confirm they pass.**

Run: `pnpm build && node --test dist/test/session-lifecycle.test.js dist/test/milestone-4-acceptance.test.js`

Expected: in-bound late events persist, out-of-bound events reject, and JSON status has no payload fields.

- [x] **Step 5: Commit the slice.**

```bash
git add src/storage/experience-store.ts src/cli.ts test/session-lifecycle.test.ts test/milestone-4-acceptance.test.ts
git commit -m "feat: recover ordered capture records"
```

### Task 5: Verify benchmarks and delivery evidence

**Files:**

- Create: `docs/verification/2026-09-07-milestone-4-asynchronous-capture.md`
- Modify: `test/milestone-4-acceptance.test.ts`

- [x] **Step 1: Write a benchmark test that records hook and admission duration for disabled, enabled and locked-main-store modes.**

```ts
const measurements = Array.from({ length: 100 }, () => measure(() => runHook()));
assert.ok(percentile(measurements, 99) < 250);
```

- [x] **Step 2: Run the focused acceptance suite and confirm the benchmark assertion is evaluated.**

Run: `pnpm build && node --test dist/test/milestone-4-acceptance.test.js`

Expected: benchmark output identifies p50, p95, p99 and throughput for each mode.

- [x] **Step 3: Record environment and acceptance evidence.**

Document Node version, operating system, CPU, integration mode, command output, p50/p95/p99, burst throughput, elapsed locked-main-store hook time, and an M4-A1 through M4-A7 evidence map. Do not claim an unmeasured performance result.

- [x] **Step 4: Run the full verification command.**

Run: `pnpm check`

Expected: exit code 0 with all test files passing.

- [x] **Step 5: Commit the verification evidence.**

```bash
git add test/milestone-4-acceptance.test.ts docs/verification/2026-09-07-milestone-4-asynchronous-capture.md
git commit -m "docs: verify milestone 4 asynchronous capture"
```

## Plan self-review

M4-A1 is covered by Tasks 1 and 3. M4-A2 is covered by Tasks 2 and 3. M4-A3 is covered by Task 3. M4-A4 is covered by Tasks 3 and 4. M4-A5 and M4-A6 are covered by Tasks 1 and 2. M4-A7 is covered by Task 5. The plan contains no unresolved implementation choice, and the types introduced in Task 1 are the types used by subsequent tasks.
