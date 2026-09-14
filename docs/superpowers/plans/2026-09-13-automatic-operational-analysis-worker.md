# Automatic operational analysis worker implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically process coalesced operational-learning ranges from passive hooks with three configurable child processes, restart-safe leases, bounded retries, truthful coverage, and measurable cost.

**Architecture:** The existing hook continues to admit capture and start a detached drain. After durable capture and analysis admission, the drain starts a singleton SQLite-leased coordinator that runs one-shot analysis child processes up to a global limit. Per-session detector-version streams track committed and processed high-water marks; transactional claim and acknowledgement preserve later arrivals and checkpoints.

**Tech Stack:** Node.js 22.17+, TypeScript 5.9, `node:sqlite`, `node:child_process`, `node:test`, pnpm.

**Baseline:** `rtk pnpm test` passed on 2026-09-13 with 675 tests and 0 failures in the isolated worktree.

---

## File structure

- Create `src/learning/worker-settings.ts` for strict global worker configuration.
- Create `src/learning/worker-launcher.ts` for best-effort detached coordinator startup.
- Create `src/learning/worker.ts` for the coordinator lease, child-process pool, idle timeout, and injected process/timer host.
- Modify `src/storage/experience-store.ts` to read a stable insertion-ordered session range and its actual high-water mark.
- Modify `src/learning/contracts.ts` to add range-aware coverage and validated detector checkpoint contracts.
- Modify `src/learning/detectors.ts` to consume and return bounded incremental checkpoints.
- Modify `src/learning/repository.ts` to migrate legacy jobs, coalesce streams, lease work, acknowledge actual ranges, recover failures, and report metrics.
- Modify `src/learning/service.ts` to analyze a claimed immutable range through the shared claim/ack path.
- Modify `src/capture/spool-drain.ts` and `src/application/experience-service.ts` to schedule the worker after durable admission and expose status.
- Modify `src/cli.ts` to run the coordinator and one-shot child asynchronously and expose `analysis status`.
- Create `test/analysis-worker-settings.test.ts`, `test/analysis-worker.test.ts`, `test/automatic-analysis-acceptance.test.ts`, and `test/analysis-load.test.ts`.
- Modify `test/learning-repository.test.ts`, `test/learning-service.test.ts`, `test/learning-detectors.test.ts`, `test/capture-spool.test.ts`, `test/cli.test.ts`, and `test/milestone-6-acceptance.test.ts`.
- Create `docs/verification/2026-09-13-automatic-operational-analysis-worker.md` with executed acceptance evidence.

### Task 1: Add strict global worker settings

**Files:**

- Create: `src/learning/worker-settings.ts`
- Create: `test/analysis-worker-settings.test.ts`

- [ ] **Step 1: Write failing settings tests**

```ts
test('uses three processes and five minutes by default', () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'ael-worker-settings-'));
  assert.deepEqual(loadAnalysisWorkerSettings(dataDirectory), {
    version: 1, maxProcesses: 3, idleTimeoutMs: 300_000
  });
});

test('accepts bounded settings and rejects unknown fields and symlinks', () => {
  writeFileSync(join(dataDirectory, 'analysis-worker.json'), '{"version":1,"maxProcesses":6,"idleTimeoutMs":60000}\n');
  assert.equal(loadAnalysisWorkerSettings(dataDirectory).maxProcesses, 6);
  writeFileSync(join(dataDirectory, 'analysis-worker.json'), '{"version":1,"maxProcesses":17,"idleTimeoutMs":60000}\n');
  assert.throws(() => loadAnalysisWorkerSettings(dataDirectory), /process limit/i);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `rtk pnpm build && rtk node --test dist/test/analysis-worker-settings.test.js`

Expected: build fails because `worker-settings.ts` does not exist.

- [ ] **Step 3: Implement the settings loader**

```ts
export interface AnalysisWorkerSettings {
  readonly version: 1;
  readonly maxProcesses: number;
  readonly idleTimeoutMs: number;
}

export function loadAnalysisWorkerSettings(dataDirectory: string): AnalysisWorkerSettings {
  const path = join(dataDirectory, 'analysis-worker.json');
  if (!existsSync(path)) return Object.freeze({ version: 1, maxProcesses: 3, idleTimeoutMs: 300_000 });
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new TypeError('Analysis worker settings must be a regular file.');
  const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'idleTimeoutMs,maxProcesses,version' || value.version !== 1) throw new TypeError('Analysis worker settings are invalid.');
  if (!Number.isSafeInteger(value.maxProcesses) || Number(value.maxProcesses) < 1 || Number(value.maxProcesses) > 16) throw new TypeError('Analysis worker process limit must be between 1 and 16.');
  if (!Number.isSafeInteger(value.idleTimeoutMs) || Number(value.idleTimeoutMs) < 1_000 || Number(value.idleTimeoutMs) > 3_600_000) throw new TypeError('Analysis worker idle timeout must be between 1000 and 3600000 milliseconds.');
  return Object.freeze({ version: 1, maxProcesses: Number(value.maxProcesses), idleTimeoutMs: Number(value.idleTimeoutMs) });
}
```

- [ ] **Step 4: Verify GREEN and commit**

Run: `rtk pnpm build && rtk node --test dist/test/analysis-worker-settings.test.js`

Expected: both settings tests pass.

```bash
rtk git add src/learning/worker-settings.ts test/analysis-worker-settings.test.ts
rtk git commit -m "feat: configure automatic analysis worker"
```

### Task 2: Read stable bounded session ranges

**Files:**

- Modify: `src/storage/experience-store.ts`
- Modify: `test/incremental-evidence.test.ts`

- [ ] **Step 1: Write a failing insertion-order range test**

Append three events whose timestamps are not insertion ordered. Assert that `loadCapturedSessionRange(sessionId, { after: 1, through: 3, limit: 1 })` returns the second inserted event, `actualHighWater: 2`, and `availableHighWater: 3`. Append a fourth event after the read and assert the earlier `through: 3` snapshot still excludes it.

```ts
const page = target.loadCapturedSessionRange(session.id, { after: 1, through: 3, limit: 1 });
assert.deepEqual(page.events.map(({ sourceEventId }) => sourceEventId), ['inserted-second']);
assert.deepEqual({ actual: page.actualHighWater, available: page.availableHighWater }, { actual: 2, available: 3 });
```

- [ ] **Step 2: Verify RED**

Run: `rtk pnpm build && rtk node --test dist/test/incremental-evidence.test.js`

Expected: TypeScript reports that `loadCapturedSessionRange` does not exist.

- [ ] **Step 3: Add the range contract and query**

```ts
export interface CapturedSessionRange {
  readonly events: readonly CapturedEventRecord[];
  readonly requestedHighWater: number;
  readonly actualHighWater: number;
  readonly availableHighWater: number;
}

loadCapturedSessionRange(id: SessionId, input: { readonly after: number; readonly through: number; readonly limit: number }): CapturedSessionRange {
  for (const value of [input.after, input.through, input.limit]) if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Captured session range is invalid.');
  if (input.limit < 1 || input.after > input.through) throw new TypeError('Captured session range is invalid.');
  const available = Number((this.database.prepare('SELECT COUNT(*) AS count FROM capture_events ce JOIN events e ON e.id = ce.event_id WHERE e.session_id = ?').get(id) as { count: number }).count);
  const count = Math.min(input.limit, Math.max(0, input.through - input.after));
  const rows = this.database.prepare(`SELECT ce.rowid AS sequence, ce.event_id, ce.source, ce.source_event_id, ce.phase, ce.signature_json, ce.summary, ce.capture_outcome, ce.related_event_id, e.session_id, e.occurred_at, e.exit_status FROM capture_events ce JOIN events e ON e.id = ce.event_id WHERE e.session_id = ? ORDER BY ce.rowid LIMIT ? OFFSET ?`).all(id, count, input.after) as unknown as CaptureRow[];
  return Object.freeze({ events: Object.freeze(rows.map(captureFromRow)), requestedHighWater: input.through, actualHighWater: input.after + rows.length, availableHighWater: available });
}
```

- [ ] **Step 4: Verify GREEN and commit**

Run: `rtk pnpm build && rtk node --test dist/test/incremental-evidence.test.js`

Expected: the stable range and existing pagination tests pass.

```bash
rtk git add src/storage/experience-store.ts test/incremental-evidence.test.ts
rtk git commit -m "feat: read stable captured session ranges"
```

### Task 3: Migrate jobs into coalesced analysis streams

**Files:**

- Modify: `src/learning/repository.ts`
- Modify: `test/learning-repository.test.ts`

- [ ] **Step 1: Write failing coalescing and migration tests**

Seed legacy jobs at high-water marks 2, 4, and 8. Reopen the repository and assert one stream with `committedHighWater: 8`, `processedHighWater` equal to the greatest completed legacy range, and one outstanding job. Add admissions at 9, 10, and 11 and assert they extend the same pending job. Claim it, admit 12 and 13, and assert exactly one pending successor exists behind the running job.

```ts
assert.deepEqual(repository.stream('repo-1', 'session-1', DETECTOR_SET_VERSION), {
  repositoryId: 'repo-1', sessionId: 'session-1', detectorSetVersion: DETECTOR_SET_VERSION,
  committedHighWater: 13, processedHighWater: 4, checkpoint: { version: 1, pendingEvents: [] }
});
assert.equal(repository.jobsForStream('repo-1', 'session-1', DETECTOR_SET_VERSION).filter(({ state }) => state === 'pending').length, 1);
```

- [ ] **Step 2: Verify RED**

Run: `rtk pnpm build && rtk node --test dist/test/learning-repository.test.js`

Expected: the stream APIs and detector version fields are absent.

- [ ] **Step 3: Add the stream schema and legacy migration**

Add `operational_analysis_streams` keyed by `(repository_id, session_id, detector_set_version)`. Extend or rebuild `operational_analysis_jobs` with `input_low_water`, `processed_high_water`, `detector_set_version`, `retry_after`, `lease_owner`, `lease_expires_at`, and `failure_reason`. Add partial unique indexes allowing at most one running and one pending/retryable job per stream.

```sql
CREATE TABLE IF NOT EXISTS operational_analysis_streams (
  repository_id TEXT NOT NULL, session_id TEXT NOT NULL, detector_set_version TEXT NOT NULL,
  committed_high_water INTEGER NOT NULL, processed_high_water INTEGER NOT NULL DEFAULT 0,
  checkpoint_json TEXT NOT NULL DEFAULT '{"version":1,"pendingEvents":[]}', next_generation INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(repository_id, session_id, detector_set_version)
);
CREATE UNIQUE INDEX IF NOT EXISTS operational_analysis_one_pending
ON operational_analysis_jobs(repository_id, session_id, detector_set_version)
WHERE state IN ('pending', 'retryable-failure');
CREATE UNIQUE INDEX IF NOT EXISTS operational_analysis_one_running
ON operational_analysis_jobs(repository_id, session_id, detector_set_version)
WHERE state = 'running';
CREATE TABLE IF NOT EXISTS operational_analysis_diagnostics (
  code TEXT PRIMARY KEY, occurrences INTEGER NOT NULL, last_at TEXT NOT NULL
);
```

Run migration inside `BEGIN IMMEDIATE`. Map completed legacy high-water counts to `processed_high_water`, convert legacy running work to retryable, retain completed result rows, and coalesce all remaining work. Record the migration in a learning-local `operational_analysis_schema(version)` table so it runs once.

- [ ] **Step 4: Implement monotonic admission**

```ts
enqueue(input: AnalysisAdmission): AnalysisJob | undefined {
  assertAnalysisAdmission(input);
  const timestamp = this.now();
  this.database.exec('BEGIN IMMEDIATE');
  try {
    this.database.prepare(`INSERT INTO operational_analysis_streams
      (repository_id, session_id, detector_set_version, committed_high_water, processed_high_water, checkpoint_json, next_generation, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, ?, 1, ?, ?)
      ON CONFLICT(repository_id, session_id, detector_set_version) DO UPDATE SET
        committed_high_water = MAX(committed_high_water, excluded.committed_high_water), updated_at = excluded.updated_at`)
      .run(input.repositoryId, input.sessionId, input.detectorSetVersion, input.inputHighWater, JSON.stringify(emptyDetectorCheckpoint()), timestamp, timestamp);
    const stream = this.streamRow(input.repositoryId, input.sessionId, input.detectorSetVersion);
    const pending = this.database.prepare(`SELECT id FROM operational_analysis_jobs
      WHERE repository_id = ? AND session_id = ? AND detector_set_version = ?
        AND state IN ('pending', 'retryable-failure')`).get(input.repositoryId, input.sessionId, input.detectorSetVersion) as { id: string } | undefined;
    if (pending !== undefined) {
      this.database.prepare('UPDATE operational_analysis_jobs SET input_high_water = MAX(input_high_water, ?), updated_at = ? WHERE id = ?')
        .run(stream.committedHighWater, timestamp, pending.id);
      const job = this.jobByIdWithinTransaction(pending.id);
      this.database.exec('COMMIT');
      return job;
    }
    const running = this.database.prepare(`SELECT 1 AS found FROM operational_analysis_jobs
      WHERE repository_id = ? AND session_id = ? AND detector_set_version = ? AND state = 'running'`)
      .get(input.repositoryId, input.sessionId, input.detectorSetVersion);
    if (running === undefined && stream.committedHighWater <= stream.processedHighWater) {
      this.database.exec('COMMIT');
      return undefined;
    }
    const job = this.insertPendingJob(stream, timestamp);
    this.database.exec('COMMIT');
    return job;
  } catch (error) {
    this.database.exec('ROLLBACK');
    throw error;
  }
}
```

Implement `assertAnalysisAdmission`, `streamRow`, `jobByIdWithinTransaction`, and `insertPendingJob` in the same module. `insertPendingJob` consumes and increments `next_generation`, sets low-water to the stream's processed high-water, and derives the job ID with SHA-256 over repository, session, detector-set version, and generation. The ID never contains mutable high-water. A new detector-set version starts with `processed_high_water = 0`, causing one complete analysis of current committed input.

- [ ] **Step 5: Verify GREEN and commit**

Run: `rtk pnpm build && rtk node --test dist/test/learning-repository.test.js`

Expected: legacy migration, unchanged admission, pending coalescing, running successor, and detector-version tests pass.

```bash
rtk git add src/learning/repository.ts test/learning-repository.test.ts
rtk git commit -m "feat: coalesce operational analysis streams"
```

### Task 4: Add leased claim, acknowledgement, retries, and metrics

**Files:**

- Modify: `src/learning/repository.ts`
- Modify: `src/learning/contracts.ts`
- Modify: `test/learning-repository.test.ts`

- [ ] **Step 1: Write failing lease and acknowledgement tests**

Assert that two owners cannot claim the same stream concurrently; a late owner cannot acknowledge after lease recovery; actual high-water 6 on a requested range through 10 advances the stream only to 6 and creates a successor through 10. Assert delays of 1, 5, and 30 seconds, quarantine on attempt four, immediate invalid-input quarantine, and persisted attempt cost fields.

```ts
const claimed = repository.claim({ ownerId: 'owner-a', leaseMs: 30_000 });
repository.acknowledge(claimed!.id, {
  ownerId: 'owner-a', attempt: claimed!.attempts, processedHighWater: 6,
  checkpoint: { version: 1, pendingEvents: [] }, result: emptyResult,
  metrics: { eventsLoaded: 6, findings: 0, elapsedMs: 12 }
});
assert.equal(repository.stream('repo-1', 'session-1', DETECTOR_SET_VERSION)?.processedHighWater, 6);
```

- [ ] **Step 2: Verify RED**

Run: `rtk pnpm build && rtk node --test dist/test/learning-repository.test.js`

Expected: claim and acknowledgement signatures do not accept leases or actual ranges.

- [ ] **Step 3: Implement ownership-safe transactions**

Export these exact repository operations:

```ts
claim(input: { readonly ownerId: string; readonly leaseMs: number; readonly repositoryId?: string }): AnalysisJob | undefined;
acknowledge(jobId: string, input: AnalysisAcknowledgement): void;
retry(jobId: string, input: { readonly ownerId: string; readonly attempt: number; readonly reason: AnalysisFailureReason }): void;
recoverExpiredJobs(): number;
tryAcquireCoordinatorLease(ownerId: string, leaseMs: number): boolean;
renewCoordinatorLease(ownerId: string, leaseMs: number): boolean;
releaseCoordinatorLease(ownerId: string): void;
recordDiagnostic(code: 'coordinator-launch-failed' | 'child-process-failed'): void;
status(filter?: { readonly repositoryId?: string; readonly sessionId?: string }): OperationalAnalysisStatus;
```

Every mutation uses `BEGIN IMMEDIATE`. `acknowledge` verifies owner, attempt, running state, range bounds, detector version, and checkpoint before saving results. It then advances the stream and creates or extends a successor in the same transaction. Store attempt rows with requested and actual ranges, events loaded, findings, elapsed time, outcome, bounded failure category, and timestamps.

Extend coverage without an ambiguous envelope choice:

```ts
export interface AnalysisCoverage {
  readonly detector: string;
  readonly detectorSetVersion: string;
  readonly status: 'completed' | 'incomplete' | 'failed';
  readonly inputLowWater: number;
  readonly requestedHighWater: number;
  readonly processedHighWater: number;
  readonly examinedEvents: number;
  readonly findings: number;
}
```

- [ ] **Step 4: Verify GREEN and commit**

Run: `rtk pnpm build && rtk node --test dist/test/learning-repository.test.js`

Expected: lease fencing, recovery, partial acknowledgement, retries, and metrics tests pass.

```bash
rtk git add src/learning/contracts.ts src/learning/repository.ts test/learning-repository.test.ts
rtk git commit -m "feat: lease and measure analysis jobs"
```

### Task 5: Make detectors checkpoint-aware

**Files:**

- Modify: `src/learning/contracts.ts`
- Modify: `src/learning/detectors.ts`
- Modify: `test/learning-detectors.test.ts`

- [ ] **Step 1: Write failing cross-page detector tests**

Analyze a failed request/result in page one, then its changed request/result in page two. Assert page one emits no episode and returns a checkpoint; page two emits the same episode that full-input analysis emits. Test an unmatched pre-action whose result arrives on the next page. Reject duplicate IDs, private text, more than 128 pending events, and an unsupported checkpoint version.

```ts
const first = detectOperationalEpisodes({ ...scope, events: firstPage, checkpoint: emptyDetectorCheckpoint() });
const second = detectOperationalEpisodes({ ...scope, events: secondPage, checkpoint: first.checkpoint });
const complete = detectOperationalEpisodes({ ...scope, events: [...firstPage, ...secondPage], checkpoint: emptyDetectorCheckpoint() });
assert.deepEqual(second.episodes, complete.episodes);
```

- [ ] **Step 2: Verify RED**

Run: `rtk pnpm build && rtk node --test dist/test/learning-detectors.test.js`

Expected: detector input and output have no checkpoint.

- [ ] **Step 3: Add bounded checkpoint contracts and incremental detection**

```ts
export interface DetectorCheckpoint {
  readonly version: 1;
  readonly pendingEvents: readonly CapturedEventRecord[];
}
export function emptyDetectorCheckpoint(): DetectorCheckpoint {
  return Object.freeze({ version: 1, pendingEvents: Object.freeze([]) });
}
```

Validate checkpoint events through `validateNormalizedCaptureEvent`, require the same session, freeze nested arrays, reject duplicates, and cap the list at 128. In `detectOperationalEpisodes`, combine validated pending events with only the new page. Return as the next checkpoint only unresolved pre-actions and failed operations without a later replacement. Sort retained checkpoint events by occurrence time and stable ID, then keep the newest 128. Convention candidates remain stable and idempotent across pages.

- [ ] **Step 4: Verify GREEN and commit**

Run: `rtk pnpm build && rtk node --test dist/test/learning-detectors.test.js dist/test/learning-contracts.test.js`

Expected: cross-page equivalence, bounds, privacy, and existing detector tests pass.

```bash
rtk git add src/learning/contracts.ts src/learning/detectors.ts test/learning-contracts.test.ts test/learning-detectors.test.ts
rtk git commit -m "feat: checkpoint incremental analysis"
```

### Task 6: Process the exact claimed range

**Files:**

- Modify: `src/learning/service.ts`
- Modify: `test/learning-service.test.ts`
- Modify: `test/milestone-6-acceptance.test.ts`

- [ ] **Step 1: Write failing truthful-range tests**

Claim through high-water 4, append two later events, and assert the run loads only the first four. With `maxEvents: 2`, assert coverage reports low-water 0, requested high-water 4, processed high-water 2, detector version, and incomplete status. Re-admit unchanged input after completion and assert `idle`. Keep the existing manual CLI behavior through this shared path.

- [ ] **Step 2: Verify RED**

Run: `rtk pnpm build && rtk node --test dist/test/learning-service.test.js dist/test/milestone-6-acceptance.test.js`

Expected: the current service reads the latest complete session and coverage lacks ranges.

- [ ] **Step 3: Replace the runner with claim/read/detect/ack**

```ts
runNext(options: { readonly ownerId?: string; readonly maxEvents?: number; readonly deadlineMs?: number; readonly repositoryId?: string } = {}): LearningRunResult {
  const ownerId = options.ownerId ?? randomUUID();
  const job = repository.claim({ ownerId, leaseMs: 30_000, repositoryId: options.repositoryId });
  if (!job) return Object.freeze({ status: 'idle' });
  const page = store.loadCapturedSessionRange(job.sessionId as SessionId, { after: job.inputLowWater, through: job.inputHighWater, limit: maxEvents });
  const detected = detectOperationalEpisodes({ repositoryId: job.repositoryId, sessionId: job.sessionId, events: page.events, conventions, checkpoint: job.checkpoint });
  repository.acknowledge(job.id, { ownerId, attempt: job.attempts, processedHighWater: page.actualHighWater, checkpoint: detected.checkpoint, result: { ...detected, coverage }, metrics });
}
```

Calculate `elapsedMs` once, use `page.actualHighWater` for acknowledgement, and set coverage status from actual versus requested high-water. Convert invalid session/registration to immediate quarantine. Convert deadline and execution failures through the leased retry API.

- [ ] **Step 4: Verify GREEN and commit**

Run: `rtk pnpm build && rtk node --test dist/test/learning-service.test.js dist/test/milestone-6-acceptance.test.js`

Expected: range, partial page, no-op replay, failure, and legacy manual-run tests pass.

```bash
rtk git add src/learning/service.ts test/learning-service.test.ts test/milestone-6-acceptance.test.ts
rtk git commit -m "feat: bind analysis results to claimed ranges"
```

### Task 7: Implement the leased coordinator and child pool

**Files:**

- Create: `src/learning/worker.ts`
- Create: `test/analysis-worker.test.ts`

- [ ] **Step 1: Write failing coordinator tests**

Use an injected clock, delay function, and child host. Assert one valid coordinator lease rejects a competitor, no more than `maxProcesses` child promises are active, completed children are replaced while work remains, failed children do not stop siblings, the lease renews, and five simulated idle minutes release the lease and return `idle-timeout`.

```ts
const result = await runAnalysisCoordinator({ dataDirectory, settings: { version: 1, maxProcesses: 3, idleTimeoutMs: 300_000 }, host, repository });
assert.equal(host.maximumConcurrentChildren, 3);
assert.equal(result.status, 'idle-timeout');
```

- [ ] **Step 2: Verify RED**

Run: `rtk pnpm build && rtk node --test dist/test/analysis-worker.test.js`

Expected: `worker.ts` does not exist.

- [ ] **Step 3: Implement a testable coordinator**

```ts
export interface AnalysisWorkerHost {
  readonly now: () => number;
  readonly delay: (milliseconds: number) => Promise<void>;
  readonly spawnChild: (dataDirectory: string) => Promise<number>;
}

export async function runAnalysisCoordinator(input: AnalysisCoordinatorInput): Promise<{ readonly status: 'lease-held' | 'idle-timeout' }> {
  const ownerId = input.ownerId ?? randomUUID();
  if (!input.repository.tryAcquireCoordinatorLease(ownerId, 10_000)) return { status: 'lease-held' };
  const active = new Set<Promise<number>>();
  let idleSince = input.host.now();
  try {
    while (input.host.now() - idleSince < input.settings.idleTimeoutMs) {
      input.repository.recoverExpiredJobs();
      const spawnCount = Math.min(input.settings.maxProcesses - active.size, input.repository.claimableCount());
      for (let index = 0; index < spawnCount; index += 1) {
        const child = input.host.spawnChild(input.dataDirectory)
          .then((code) => { if (code !== 0) input.repository.recordDiagnostic('child-process-failed'); return code; })
          .finally(() => active.delete(child));
        active.add(child);
      }
      if (active.size || input.repository.hasActiveOrClaimableWork()) idleSince = input.host.now();
      if (!input.repository.renewCoordinatorLease(ownerId, 10_000)) return { status: 'lease-held' };
      await input.host.delay(100);
    }
    return { status: 'idle-timeout' };
  } finally {
    await Promise.allSettled(active);
    input.repository.releaseCoordinatorLease(ownerId);
  }
}
```

The production host uses `spawn(process.execPath, [entrypoint, 'analysis', 'worker-child', '--data-dir', dataDirectory], { stdio: 'ignore' })` and resolves on exit. `hasActiveOrClaimableWork` includes pending, running, and currently eligible retryable jobs, but excludes completed and quarantined work. The longest retry backoff is 30 seconds, so retryable work becomes eligible before the five-minute idle timeout. Clamp polling so the injected clock controls tests and real polling never busy-waits.

- [ ] **Step 4: Verify GREEN and commit**

Run: `rtk pnpm build && rtk node --test dist/test/analysis-worker.test.js`

Expected: singleton, pool, replacement, lease, crash, and idle tests pass.

```bash
rtk git add src/learning/worker.ts test/analysis-worker.test.ts
rtk git commit -m "feat: coordinate bounded analysis processes"
```

### Task 8: Start the coordinator after durable capture admission

**Files:**

- Create: `src/learning/worker-launcher.ts`
- Modify: `src/capture/spool-drain.ts`
- Modify: `src/application/experience-service.ts`
- Modify: `test/capture-spool.test.ts`
- Create: `test/automatic-analysis-acceptance.test.ts`

- [ ] **Step 1: Write failing launch-boundary tests**

Inject `scheduleAnalysis`. Assert it runs once after a drain batch creates or extends analysis work, never before capture persistence, and not when automatic learning is disabled or admission fails. Make scheduling throw and assert capture remains acknowledged. In the acceptance test, inject a real child launcher with a short idle timeout and wait until a convention candidate appears without calling `analysis run`.

- [ ] **Step 2: Verify RED**

Run: `rtk pnpm build && rtk node --test dist/test/capture-spool.test.js dist/test/automatic-analysis-acceptance.test.js`

Expected: drain has no analysis scheduler and automatic results remain absent.

- [ ] **Step 3: Add the launcher and post-admission scheduling**

```ts
export function startAnalysisWorker(input: { readonly dataDirectory: string; readonly onFailure?: () => void }): void {
  try {
    const entrypoint = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
    spawn(process.execPath, [entrypoint, 'analysis', 'worker', '--data-dir', input.dataDirectory], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    input.onFailure?.();
  }
}
```

Change `LearningAdmission.enqueueCommittedSession` to return `boolean`, where `true` means the stream gained outstanding work. Accumulate this result across the drain batch. After capture acknowledgement and outside the per-record failure path, invoke injected `scheduleAnalysis ?? startAnalysisWorker` once when work exists. Pass an `onFailure` callback that records only `coordinator-launch-failed` and its timestamp through the learning repository. Do not launch from `enqueue` itself because manual imports and tests must control process creation.

- [ ] **Step 4: Verify GREEN and commit**

Run: `rtk pnpm build && rtk node --test dist/test/capture-spool.test.js dist/test/automatic-analysis-acceptance.test.js`

Expected: automatic execution works, launch is once per batch, opt-out works, and capture remains fail-open.

```bash
rtk git add src/learning/worker-launcher.ts src/capture/spool-drain.ts src/application/experience-service.ts test/capture-spool.test.ts test/automatic-analysis-acceptance.test.ts
rtk git commit -m "feat: start analysis worker from passive hooks"
```

### Task 9: Add worker commands and operational status

**Files:**

- Modify: `src/application/experience-service.ts`
- Modify: `src/cli.ts`
- Modify: `test/cli.test.ts`
- Modify: `test/cli-integration.test.ts`

- [ ] **Step 1: Write failing CLI and status tests**

Assert `analysis status --json` returns configuration, coordinator state, active children, counts by state, oldest outstanding age, next retry, attempts, events loaded, unique acknowledged events, and reread ratio. Assert repository/session filters only narrow queue metrics. Exercise `runCliAsync(['analysis', 'worker'])` with injected coordinator dependencies and `analysis worker-child` with an injected service. Invalid settings must return a bounded configuration error without breaking `capture hook`.

- [ ] **Step 2: Verify RED**

Run: `rtk pnpm build && rtk node --test dist/test/cli.test.js dist/test/cli-integration.test.js`

Expected: CLI rejects `analysis status`, `analysis worker`, and `analysis worker-child`.

- [ ] **Step 3: Wire asynchronous worker commands and human output**

Handle worker commands in `runCliAsync` before its review fallback:

```ts
if (args[0] === 'analysis' && args[1] === 'worker') return runAnalysisWorkerCli(args, options);
if (args[0] === 'analysis' && args[1] === 'worker-child') return runAnalysisWorkerChildCli(args, options);
```

Add synchronous `analysis status [--repository-id id] [--session id] [--json]` through `ExperienceService.operationalAnalysisStatus`. The coordinator command loads global settings and awaits `runAnalysisCoordinator`; the child command calls exactly one `runNext`. Neither internal command writes routine output. Add a compact human formatter for status and update `usage()`.

- [ ] **Step 4: Verify GREEN and commit**

Run: `rtk pnpm build && rtk node --test dist/test/cli.test.js dist/test/cli-integration.test.js`

Expected: status JSON/human output, internal commands, validation, and existing CLI tests pass.

```bash
rtk git add src/application/experience-service.ts src/cli.ts test/cli.test.ts test/cli-integration.test.ts
rtk git commit -m "feat: expose operational analysis status"
```

### Task 10: Prove concurrency safety and reread reduction

**Files:**

- Create: `test/analysis-load.test.ts`
- Modify: `test/automatic-analysis-acceptance.test.ts`
- Create: `docs/verification/2026-09-13-automatic-operational-analysis-worker.md`

- [ ] **Step 1: Add the load and restart fixtures**

Admit one session at 565 increasing high-water marks with 559 unique events, mirroring the issue evidence. Run the coordinator with three child slots and assert one logical stream, no lost event ordinal, and no duplicate result identity. Assert `eventsLoaded / uniqueAcknowledgedEvents <= 1.05` without injected failures. Add arrivals while three jobs are active, terminate the coordinator host, expire leases, restart, and assert every stream reaches its committed high-water.

```ts
assert.equal(status.metrics.uniqueAcknowledgedEvents, 559);
assert.ok(status.metrics.rereadRatio <= 1.05, `reread ratio was ${status.metrics.rereadRatio}`);
assert.equal(status.counts.pending + status.counts.running + status.counts.retryableFailure, 0);
```

- [ ] **Step 2: Run the focused acceptance path**

Run: `rtk pnpm build && rtk node --test dist/test/analysis-worker-settings.test.js dist/test/learning-repository.test.js dist/test/learning-detectors.test.js dist/test/learning-service.test.js dist/test/analysis-worker.test.js dist/test/capture-spool.test.js dist/test/automatic-analysis-acceptance.test.js dist/test/analysis-load.test.js dist/test/cli.test.js dist/test/cli-integration.test.js`

Expected: all focused tests pass with no leaked child processes.

- [ ] **Step 3: Run the full acceptance command**

Run: `rtk pnpm check`

Expected: TypeScript build, full test suite, and all prior milestone tests pass with 0 failures.

- [ ] **Step 4: Record reproducible evidence**

Write the verification document with the exact commit, commands, test counts, load fixture counts, maximum observed child concurrency, reread ratio, restart result, and `git diff --check` result. Do not copy captured session payloads into the document.

- [ ] **Step 5: Commit verification evidence**

```bash
rtk git add test/analysis-load.test.ts test/automatic-analysis-acceptance.test.ts docs/verification/2026-09-13-automatic-operational-analysis-worker.md
rtk git diff --cached --check
rtk git commit -m "test: verify automatic analysis worker"
```

### Task 11: Review the completed branch

**Files:**

- Review every file changed since `bdab520`.

- [ ] **Step 1: Inspect scope and secrets**

Run: `rtk git diff --check bdab520..HEAD`

Expected: no whitespace errors.

Run: `rtk git status --short`

Expected: empty output.

- [ ] **Step 2: Run the required review skill**

Use `superpowers:requesting-code-review` against the approved design and this plan. Resolve every correctness, privacy, concurrency, migration, or acceptance finding before completion. Repeat focused tests after each correction and `rtk pnpm check` after the final correction.

- [ ] **Step 3: Confirm issue acceptance criteria**

Verify that automatic execution requires no manual run; unchanged input/version is idle; arrivals during work survive; coverage uses the actual range; retries, backlog, and cost are visible; and the load test demonstrates bounded rereading. Do not close issue 6 until all six conditions have direct test or verification-document evidence.
