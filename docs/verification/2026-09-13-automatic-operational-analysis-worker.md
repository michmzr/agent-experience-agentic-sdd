# Automatic operational analysis worker verification

Date: 2026-09-13

Tested implementation commit: `b1051b6`.

## Load fixture

The deterministic load fixture submitted 565 nondecreasing high-water admissions for one session. The first 559 admissions appended distinct capture events and advanced the high-water from 1 through 559. The final six admissions repeated high-water 559 to represent duplicate wakeups. The repository retained one logical analysis stream and one coalesced job before execution.

The coordinator used `maxProcesses: 3`. One stream supplied one claimable job, so observed child concurrency was 1 and did not exceed the configured limit. The completed stream had committed and processed high-water 559. All 559 source-event ordinals were present in insertion order. `uniqueAcknowledgedEvents` was 559, `eventsLoaded` was 559 and the measured reread ratio was 1.0. Pending, running, retryable and quarantined job counts were zero. Episode, finding and candidate table counts matched their distinct identity counts.

## Restart fixture

The restart fixture started three session streams and held three slot-linked jobs concurrently. A second event was appended and admitted to every stream while all three jobs were active. The coordinator generation was fenced, then the coordinator, job and worker-slot leases were expired. Recovery coalesced each active range with its queued successor.

The restarted coordinator observed three claimable streams and reached child concurrency 3 with `maxProcesses: 3`. Each stream finished at committed and processed high-water 2. The six captured source-event ordinals remained present, `uniqueAcknowledgedEvents` was 6, and no pending, running, retryable or quarantined work remained. Result tables contained no duplicate identity.

The two load fixtures use injected process hosts and real SQLite repositories, range reads, analysis services and detectors. Their clocks, child completion and lease loss are deterministic. `test/automatic-analysis-acceptance.test.ts` starts the coordinator in a real detached Node.js process. `test/cli-integration.test.ts` separately executes the compiled coordinator and the compiled watchdog to Worker thread to worker-child chain. No load fixture starts a real child process.

## Commands

Focused acceptance command:

```text
rtk pnpm build && node --test dist/test/analysis-worker-settings.test.js dist/test/learning-repository.test.js dist/test/learning-detectors.test.js dist/test/learning-service.test.js dist/test/analysis-worker.test.js dist/test/capture-spool.test.js dist/test/automatic-analysis-acceptance.test.js dist/test/analysis-load.test.js dist/test/cli.test.js dist/test/cli-integration.test.js
```

Result: 147 tests passed, 0 failed, in 4.314 seconds.

Full project check:

```text
rtk pnpm check
```

Result: 785 tests passed, 0 failed, in 15.822 seconds. Two preceding full runs reported temporary-directory cleanup races in existing hook tests. The directly affected `hook-readiness` file passed 2 tests with 0 failures in isolation before the final full pass.

Patch validation:

```text
rtk git diff --check
```

Result: exit status 0 with no diagnostics.
