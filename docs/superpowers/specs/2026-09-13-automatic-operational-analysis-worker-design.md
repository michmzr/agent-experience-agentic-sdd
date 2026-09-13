# Automatic operational analysis worker

## Status

Approved on 2026-09-13. This design completes the architectural decisions required by issue 6. It extends the M6 operational-learning design without changing capture durability, detector semantics, or the knowledge lifecycle.

## Problem

Automatic operational learning currently stops after admission. Capture drain creates a separate job for every observed input high-water mark, but no automatic executor consumes those jobs. Manual execution claims one job and reads the current session instead of the job's declared input range. A growing session can therefore produce many jobs that repeatedly examine the same events, and reported coverage can differ from the input identified by the job.

The implementation must execute admitted work automatically, merge redundant pending work, preserve events committed during analysis, and make retries, delay, and processing cost observable.[^1]

## Goals

- Start analysis from the passive hook path without registering an operating-system service.
- Run one global coordinator for an AEL data directory and up to a configurable number of analysis child processes.
- Default to three concurrent analysis processes and stop after five minutes without work.
- Coalesce pending work by repository, session, and detector-set version.
- Bind every result and coverage record to the input range actually read.
- Avoid reanalysis when both committed input and detector-set version are unchanged.
- Preserve events committed while an earlier range is running.
- Bound retries and expose backlog, failures, delay, and processing cost.

## Non-goals

This change does not register a launch agent, daemon, systemd unit, Windows service, or scheduled task. It does not add distributed execution across machines. It does not change the evidence accepted by M6 detectors, promote candidates automatically, or run external reviewer backends.

## Process model

The existing passive hook command durably admits a record to the capture spool and starts a detached capture drain. After the drain commits a record to the experience database and admits its analysis range, it makes a best-effort request to start the analysis coordinator. Neither coordinator startup nor analysis success affects capture acknowledgement.

The coordinator is a detached `ael analysis worker` process scoped to one global AEL data directory. It acquires a renewable coordinator lease stored in SQLite. If another hook starts a competing coordinator, that process observes the valid lease and exits successfully. No PID file is authoritative because process identifiers can be reused after a crash.

The coordinator maintains up to `maxProcesses` analysis child processes. The default is three. Each child claims and processes one job at a time. Claims use SQLite transactions, so two children cannot own the same job. The coordinator remains alive while work is pending, running, or retryable at the current time. It exits after 300,000 milliseconds without claimable work and releases its lease. A later hook starts a new coordinator.

The hook, capture drain, coordinator, and child processes use the same Node.js executable and resolved CLI entrypoint. Startup is detached with ignored standard streams. Expected launch failures are recorded as bounded diagnostics and never expose captured content.

## Configuration

Worker configuration is global to the AEL data directory. An optional versioned `analysis-worker.json` file contains:

```json
{
  "version": 1,
  "maxProcesses": 3,
  "idleTimeoutMs": 300000
}
```

Missing configuration uses these defaults. `maxProcesses` accepts integers from 1 through 16. `idleTimeoutMs` accepts integers from 1,000 through 3,600,000 milliseconds. Unknown fields, symbolic links, invalid JSON, and out-of-range values are rejected. Invalid worker configuration prevents analysis startup but does not prevent capture. Status reports the configuration error.

Existing per-project `automaticOperationalLearning: false` continues to prevent admission for that project. It does not stop work already admitted by another project or shut down the global coordinator.

## Analysis streams and jobs

An analysis stream is identified by repository ID, session ID, and detector-set version. It stores:

- `committed_high_water`, the greatest committed event ordinal admitted for the stream;
- `processed_high_water`, the greatest ordinal acknowledged after successful analysis;
- the current detector checkpoint and its version;
- timestamps used for backlog reporting.

An analysis job stores its stream identity, exclusive low-water mark, requested high-water mark, actual processed high-water mark, state, attempt count, retry eligibility time, lease owner, lease expiry, timestamps, and terminal failure reason. Detector-set version includes the detector implementation version and any configuration fingerprint that changes detector output.

Admission runs in a short SQLite transaction. It raises `committed_high_water` monotonically. If the stream has a pending or retryable job, admission extends that job's requested high-water mark instead of inserting another job. If a job is running, admission creates or extends one pending successor. A stream can therefore have at most one running job and one coalesced successor.

A new detector-set version creates a separate stream starting at ordinal zero. Existing committed input is analyzed once under that version. Re-admitting an unchanged high-water mark for the same version makes no change.

## Claim, processing, and acknowledgement

A child process atomically claims one eligible job and records a bounded lease. It reads only committed session events after the job's exclusive low-water mark and no later than its requested high-water mark. The existing per-run event limit remains 1,024. If the requested range is larger, acknowledgement advances only through the last event read and leaves the remainder eligible for a successor job.

Each detector receives its persisted checkpoint and the bounded event page. A checkpoint contains only the minimal validated state required to continue an incomplete episode across page or job boundaries. It cannot contain raw private input. The detector returns a new checkpoint, findings, episodes, candidates, coverage, and the highest event ordinal it actually examined.

Acknowledgement is one SQLite transaction. It validates that output scope and detector version match the claim, stores idempotent result records, stores coverage and attempt metrics, advances `processed_high_water` to the actual examined ordinal, persists the checkpoint, and marks the job completed. If `committed_high_water` is still greater than `processed_high_water`, the transaction creates or extends the pending successor.

Events committed while analysis runs only raise `committed_high_water` and update the successor. They do not change the running job's requested range. Coverage therefore describes a stable input snapshot. A crash before acknowledgement leaves the range unacknowledged. After its lease expires, another child reclaims it; stable result identities and transactional acknowledgement prevent duplicate logical results.

## Retry and recovery

Execution failure, timeout, child-process exit, or an expired job lease produces a retryable failure. A job receives at most four total attempts. Retry delay uses a deterministic bounded backoff based on the attempt number. The fourth failed attempt moves the job to `quarantined-input`. Structurally invalid input is quarantined on the first attempt.

Coordinator lease renewal and job lease renewal are separate. Loss of the coordinator does not acknowledge child work. A new coordinator may recover jobs only after their job leases expire. A late child cannot acknowledge a job after ownership has changed because acknowledgement verifies the lease owner and claimed attempt.

Failure of one child reduces available concurrency until the coordinator replaces it. Other claimed jobs continue. Capture never waits for a retry, lease timeout, child replacement, or coordinator shutdown.

## Status and metrics

`analysis status` reports the effective worker configuration, coordinator lease state, active child count, and queue counts for pending, running, retryable, completed, and quarantined jobs. It also reports the age of the oldest outstanding job and the next retry time. Repository and session filters may narrow job data, but the worker state remains global.

Each attempt records detector-set version, requested range, actual examined range, events loaded, findings produced, elapsed milliseconds, outcome, failure category, and timestamps. Aggregated status reports total attempts, retries, events loaded, unique event ordinals acknowledged, and the resulting reread ratio. These values measure local processing cost without storing captured payloads or command text.

The existing manual `analysis run` command remains available for diagnostics. It uses the same claim and acknowledgement path as child processes and cannot bypass leases or create duplicate work.

## Compatibility and migration

Schema changes are additive. Existing jobs are migrated into streams by repository, session, and the legacy detector version. For each group, the greatest completed high-water mark becomes `processed_high_water`, and the greatest known high-water mark becomes `committed_high_water`. Redundant non-running jobs are coalesced into one pending job. A legacy running job is converted to retryable work because it has no valid lease after migration.

Existing reports retain their current fields. Coverage gains range and detector-version provenance through additive fields or a versioned analysis envelope. Existing project settings and the automatic-learning opt-out keep their meaning.

## Verification

Tests use deterministic clocks, injected process launchers, bounded leases, and temporary SQLite databases. They verify:

- passive capture produces an analysis result without manual `analysis run`;
- concurrent hook launches result in one coordinator lease;
- repeated admissions coalesce to the highest pending range;
- admission during a running job preserves a successor range;
- results report the actual examined range rather than the session's later size;
- unchanged input and detector version do not create work;
- a detector version change reprocesses existing committed input once;
- checkpoints preserve an episode across range and page boundaries;
- expired coordinator and job leases recover after a simulated crash;
- no more than the configured number of child processes run concurrently;
- the fourth retry is quarantined and invalid input is quarantined immediately;
- status exposes backlog delay, failure categories, and processing cost;
- disabling automatic learning prevents project admission without affecting capture;
- a load fixture creates many increasing high-water admissions and demonstrates a bounded reread ratio compared with the current one-job-per-high-water behavior.

The focused worker, repository, capture, CLI, migration, and load tests run first. The final acceptance command is `pnpm check`.

[^1]: [GitHub issue 6](https://github.com/michmzr/agent-experience-agentic-sdd/issues/6), created 2026-09-10.
