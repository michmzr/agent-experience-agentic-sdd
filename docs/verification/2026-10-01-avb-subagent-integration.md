# AVB subagent integration, 2026-10-01

## Scope and acceptance state

Three isolated worktrees examined AEC host results, AAP advice exposure and AVB-A6 traceability. The current AVB manifest maps R1–R6 to tests and run artifacts, but keeps AVB-A4/A5 unsupported. No five-pair disabled/passive/advice series was run. A staged operator declaration still counts as zero observed trials.[^manifest]

Controlled Codex CLI probes in a temporary repository observed three `command_execution` start/completion pairs with exit codes 0, 1 and 0. A later run with explicit project trust also produced zero temporary hook events. The CLI event stream therefore does not qualify the project's hook adapter or AEC's asynchronous relation. The external model calls and token counts are recorded in the AEC probe note; they are source qualification work, not AVB benchmark runs.[^aec]

The AAP audit found no independent observation that a specific advice response reached the agent. `PostToolUse` occurs before the next model continuation, and the available public scenario cannot place a response-only marker in a verified lesson without making it available through another source. Delivery remains `agent-claim`; no observed-delivery origin or benchmark-only response field was added.[^aap]

## Verification

The first integrated `rtk pnpm check` passed 1043/1044 tests; the existing M4 enabled-hook p99 was 256.726 ms against a 250 ms gate. Isolated `rtk proxy node --test dist/test/milestone-4-acceptance.test.js` passed 6/6 with enabled-hook p99 111.426 ms. A second full run failed the hook-readiness temporary-directory assertion, which passed 4/4 in isolation. A third full run again failed those two timing-sensitive cases. An initial direct four-worker test run under the default sandbox failed with filesystem `EPERM`; the same `rtk proxy node --test --test-concurrency=4 dist/test/**/*.test.js` command outside the sandbox passed 1044/1044, with enabled-hook p99 104.898 ms.

The repository test script now sets `--test-concurrency=4` to bound contention for timing and detached-hook tests. After that change, `rtk pnpm check` exited 0 with 1044/1044 tests passed, 0 failed and 0 skipped; enabled-hook p99 was 99.379 ms. This is a test-runner setting only. No production hook, advice, benchmark, database schema or installed user configuration was changed in this integration.

## Remaining gate

AVB-A4/A5 require actual paired trials with independently qualified host operation and advice-delivery witnesses, task correctness and safety checks. The present Codex hook and advice sources do not meet those conditions. An external CLI JSON command status is not interchangeable with a hook result or a final model-visible advice response. Missing token telemetry remains unavailable rather than zero.[^spec]

[^manifest]: [Current AVB requirement evidence](2026-10-01-avb-requirement-evidence.json), [B2 development verification](2026-10-01-avb-b2-development.md).
[^aec]: [AEC installed-host probe](2026-10-01-aec-real-host-probe.md).
[^aap]: [AAP live exposure audit](2026-10-01-aap-live-exposure-qualification.md).
[^spec]: [AVB specification](../superpowers/specs/2026-09-29-ael-value-benchmark-design.md).
