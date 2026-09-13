# Automatic operational analysis worker verification

Date: 2026-09-13

Tested implementation commit: `4388139`.

## Load fixture

The deterministic load fixture submitted 565 nondecreasing high-water admissions for one session. The first 559 admissions appended distinct capture events and advanced the high-water from 1 through 559. The final six admissions repeated high-water 559 to represent duplicate wakeups. The repository retained one logical analysis stream and one coalesced job before execution.

The coordinator used `maxProcesses: 3`. One stream supplied one claimable job, so observed child concurrency was 1 and did not exceed the configured limit. The completed stream had committed and processed high-water 559. All 559 source-event ordinals were present in insertion order. `uniqueAcknowledgedEvents` was exactly 559, `eventsLoaded` was exactly 559 and the measured reread ratio was exactly 1.0. Pending, running, retryable and quarantined job counts were zero. Episode, finding and candidate results were grouped by their canonical scope, payload and evidence fields without using record IDs. Every semantic group contained one result.

## Restart fixture

The restart fixture started three session streams and held three slot-linked jobs concurrently. A second event was appended and admitted to every stream while all three jobs were active. The coordinator generation was fenced, then the coordinator, job and worker-slot leases were expired. Recovery coalesced each active range with its queued successor.

The restarted coordinator observed three claimable streams and reached child concurrency 3 with `maxProcesses: 3`. Each stream finished at committed and processed high-water 2. The six captured source-event ordinals remained present, `uniqueAcknowledgedEvents` was 6, and no pending, running, retryable or quarantined work remained. Result tables contained no duplicate identity.

The two load fixtures use injected process hosts and real SQLite repositories, range reads, analysis services and detectors. Their clocks, child completion and lease loss are deterministic. `test/automatic-analysis-acceptance.test.ts` starts the coordinator in a real detached Node.js process. `test/cli-integration.test.ts` separately executes the compiled coordinator and the compiled watchdog to Worker thread to worker-child chain. No load fixture starts a real child process.

Mixed-repository capture tests drain enabled and disabled repositories in both input orders and from both invoking settings. Only records whose registered repository root enables automatic learning are admitted. A disabled hook and an empty drain both wake durable work already admitted for another repository, after the capture batch acknowledgment boundary. A separate end-to-end case passes a relative `--data-dir` to the public CLI and observes automatic completion through the detached coordinator without exposing the path marker.

## Commands

Load stability commands:

```text
rtk pnpm build && node --test dist/test/analysis-load.test.js
node --test dist/test/analysis-load.test.js
node --test dist/test/analysis-load.test.js
```

Result: each run passed 2 tests with 0 failures. Durations were 1.071, 1.058 and 1.505 seconds.

Focused acceptance command:

```text
rtk pnpm build && node --test dist/test/analysis-worker-settings.test.js dist/test/learning-repository.test.js dist/test/learning-detectors.test.js dist/test/learning-service.test.js dist/test/analysis-worker.test.js dist/test/capture-spool.test.js dist/test/automatic-analysis-acceptance.test.js dist/test/analysis-load.test.js dist/test/cli.test.js dist/test/cli-integration.test.js
```

Result: 150 tests passed, 0 failed, in 4.654 seconds.

Full project check:

```text
rtk pnpm check
```

Result: 788 tests passed, 0 failed, in 17.129 seconds. The preceding full run passed 787 of 788 tests and reported an `ENOTEMPTY` temporary-directory cleanup race in the existing Milestone 2.5 hook acceptance test. That file then passed 5 tests with 0 failures in isolation before the complete rerun passed.

Patch validation:

```text
rtk git diff --check
```

Result: exit status 0 with no diagnostics.
