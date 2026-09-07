# Milestone 4 asynchronous capture verification

Implementation commit: `17403c60ed3fdf575e2dcbf29da0f808eaaacc28`.

## Verification environment

The focused benchmark ran on Node.js v26.8.1 under Darwin 25.6.0 on an arm64 MacBook Pro with an Apple M1 Pro, 10 CPU cores and 32 GB memory. The integration used the production SQLite spool configuration with WAL and `synchronous=FULL`; the scheduler was injected as a no-op so measurements covered hook adaptation and durable admission without detached-process startup noise. Each benchmark mode contained 100 operations.

## Commands and results

| Command | Result |
| --- | --- |
| `pnpm build && node --test dist/test/milestone-4-acceptance.test.js` | Passed: 6 tests, 0 failed, 0 skipped. |
| `pnpm build && node --test dist/test/milestone-2-5-acceptance.test.js dist/test/milestone-4-acceptance.test.js dist/test/capture-spool.test.js dist/test/project-settings.test.js dist/test/hook-readiness.test.js dist/test/project-hook-configuration.test.js` | Passed: 23 tests, 0 failed, 0 skipped before the final reordered-delivery case was added. |
| `pnpm check` | Passed: 613 tests, 0 failed, 0 skipped. |

## Benchmark observations

| Mode | p50 | p95 | p99 | Throughput |
| --- | ---: | ---: | ---: | ---: |
| Capture disabled | 0.000 ms | 0.000 ms | 0.001 ms | 1,536,499.5 operations/s |
| Durable admission enabled | 18.860 ms | 26.338 ms | 35.573 ms | 49.3 operations/s |
| Main store locked | 18.321 ms | 22.126 ms | 25.761 ms | 53.3 operations/s |

The direct busy-spool acceptance case completed in 155.851 ms and returned the generic fail-open persistence diagnostic. Both enabled admission p99 values remained below the 250 ms source-facing deadline. These are local fixture observations, not release thresholds for other hardware.

## Acceptance evidence

| Criterion | Evidence |
| --- | --- |
| M4-A1 | `milestone-4-acceptance` admits while the primary database holds an immediate transaction, then drains the acknowledged record after release. |
| M4-A2 | `capture-spool` reclaims expired claims; duplicate sink persistence is idempotent and acknowledgment removes only a claimed record. |
| M4-A3 | Injected scheduler failure leaves one pending record; a later explicit drain commits it. The drain lock permits one owner and recovers after lease expiry. |
| M4-A4 | Reordered session end, technical event and session start records retry dependency failures, then commit the in-bound late event with the immutable end time. Cross-source and duplicate lifecycle acceptance remains green. |
| M4-A5 | Capacity exhaustion increments `failedAdmission` without eviction. Locked-spool admission fails open within 250 ms. Existing permission and invalid-input tests retain generic source-facing diagnostics. |
| M4-A6 | Privacy tests scan spool, quarantine, diagnostics and the main database for excluded raw fields and credential markers. Stored spool content is normalized before admission. |
| M4-A7 | The focused test emits p50, p95, p99 and throughput for disabled, enabled and locked-main-store modes and asserts enabled p99 below 250 ms. |

## Operational contract

`.ael/settings.json` accepts the closed version 1 shape `{"version":1,"captureDeliveryDeadlineMs":2000}`. The deadline defaults to 2000 ms and accepts values from 100 through 60000 ms. Readiness polls for committed lifecycle evidence until that deadline. The drain records a delayed-delivery count plus the latest `admittedAt`, `deadlineAt`, `detectedAt` and optional `committedAt` timestamps. `ael capture status --json` exposes those aggregates without normalized records or raw hook input.
