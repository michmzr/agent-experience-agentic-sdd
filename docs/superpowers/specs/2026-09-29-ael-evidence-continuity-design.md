# AEL result facts and continuous operation evidence

## Status

Approved for implementation on 2026-09-30; drafted 2026-09-29. Change ID: `AEC`. Priority: P0. Dependencies: ABI.

The user authorized implementation on 2026-09-30; the delivery index records this decision. Existing approved behavior remains authoritative until the implementation passes its acceptance gates.

## Problem

All 2503 technical results in the audited snapshot have unknown outcomes. Current resumed events can be preserved in capture_run_events while learning and repository quality read only legacy capture_events. Result interpretation exists in reconstruction but is not the input consumed by the repair detector.

## Evidence

F02: 2503 unknown results and no retained exit status. F03: an isolated current-source reproduction retained two resumed events but returned zero events to the learning range reader and zero operations to repository quality. A nested result-shape probe was synthetic and does not establish the actual host envelope.[^sources]

## Goals

Provide one versioned, complete local operation stream for learning and reporting, with immutable source facts, explicit missing data and task verification separate from process status.

## Non-goals

Inferring success from prose or command names, inventing historical run boundaries, changing version 1 session end values, storing raw output, generic support for unqualified host formats, or making a repair automatically verified.

## User-visible behavior

Existing version 1 commands retain their meaning. Add `ael evidence session <id> --schema-version 2 --json` for continuous operation evidence. Its envelope identifies the repository/workspace, conversation or legacy session, input watermark, result facts, interpretation version, task-verification references and coverage limitations. Version 2 evidence is distinct from version 2 health reporting.

An operation can have `succeeded`, `failed` or `unknown` process status, independently of task status. A result reports a fixed reason when unknown: source-field-absent, result-not-delivered, awaiting-async-completion, correlation-missing, unsupported-result-shape, privacy-redacted or legacy-record. A successfully edited file or MCP result uses a qualified structured source status; absence of a shell exit code alone is not a failure.

## Architecture and boundaries

Add a private append-only logical evidence index with a monotonic committed sequence. Its identity includes source, repository scope, conversation or legacy session, and source event identity. Each index entry references an immutable legacy event, run event, result fact or typed evidence record. Allocate the sequence transactionally. Reader pages use keyset cursors with a fixed high-water mark, not current row counts or source timestamps.

Backfill existing capture and run-event references idempotently in bounded pages. A record present in both paths has one logical identity; conflicting duplicates remain quarantined with provenance. Preserve separate source occurrence, receipt, admission and commit times. New late facts get new sequence entries and supersession relations rather than rewriting facts already analyzed.

Source-specific extractors are qualified against sanitized observations from the actual installed host. They accept only documented/observed allowlisted structured fields. Stable operation/execution identifiers correlate asynchronous results; temporal proximity alone cannot attach a result. An interpretation module provides no-match, interrupted, environment-limited, failed-test, expected-red, unclassified-nonzero or unknown only when its required facts exist. Expected RED requires explicit test-cycle context. Learning consumes this operation evidence and verification eligibility rather than testing a raw nonzero exit code.

## State and lifecycle

An operation may progress from request-observed to awaiting-result and then result-observed; a missing or incompatible relation stays unresolved. Task verification is a separate linked event. Run end closes a run, not the conversation. A new resolved resume run can contain further indexed operations while the legacy session remains closed.

Detector progress refers to the logical index version and actual processed sequence. Backfill under a new input contract creates a new detector stream, preserving old coverage. Old records cannot be relabeled as host-qualified result facts without additional evidence.

## Failure behavior

Unsupported shapes produce bounded unknown reasons. Missing correlation cannot become a successful result. Index or interpretation failure is visible and retryable after durable capture acknowledgement; it never runs in the admission hot path. A partial backfill reports its watermark and cannot claim complete coverage.

## Privacy and security

Extract only bounded factual fields and opaque correlation keys. Raw output and original result envelopes remain outside durable AEL stores. Qualified fixture publication replaces private identifiers. Facts declared by an agent or a user retain that origin; they cannot masquerade as source tool facts.

## Compatibility and rollout

Add tables and readers without rewriting v1 records. Default new reader pages to at most 1024 entries and preserve configured worker budgets. Freeze a source capability profile only after a real controlled success, failure and asynchronous case is observed. If a host cannot provide a class, publish it as unsupported and complete only the qualified subset.

## Requirements and acceptance criteria

| Requirement | Contract | Acceptance | Observable check |
|---|---|---|---|
| AEC-R1 | Result extraction has an explicit host/version capability profile and retains field provenance without raw output. | AEC-A1 | Qualify real sanitized success/failure envelopes; unsupported and missing fields remain unknown. Do not use the illustrative nested probe as a production fixture. |
| AEC-R2 | Every eligible legacy or resumed event is exposed once through the logical operation reader. | AEC-A2 | Startup/end/resume with two resumed events yields both events to learning and quality; replay does not duplicate them. |
| AEC-R3 | The logical index has stable bounded pagination under concurrent and late arrivals. | AEC-A3 | Append during a fixed-high-water read; no omission or duplicate occurs, and the next range contains only later entries. |
| AEC-R4 | Process interpretation and task verification remain separate, and repairs consume the qualified interpretation. | AEC-A4 | rg no-match, interruption, environment restriction, expected RED and a genuine failed test have distinct outcomes; exit zero alone never verifies the task. |
| AEC-R5 | Asynchronous completion attaches only through a stable qualified execution relation. | AEC-A5 | A delayed terminal result links across page boundaries; unrelated and conflicting execution identities remain unresolved. |
| AEC-R6 | Additive migration, replay and compatibility preserve old facts and expose incomplete backfill. | AEC-A6 | Migrate a v1 fixture twice, interrupt backfill, resume and compare v1 rows and foreign keys; old output remains unchanged. |

## Benchmark and regression impact

AVB records the pre-change case and the post-change behavior. The matching plan names focused tests and its full acceptance path. Capture remains passive and fail-open; SQLite migrations, replay, scope isolation and privacy assertions are mandatory when affected. Successful component tests do not replace the listed public-path acceptance criteria.

## Open decisions

The stated limits, initial paths and exclusions are approved for implementation. Source capability qualification remains an implementation task with explicit unsupported outcomes, not permission to guess a host contract. Acceptance and rollout require their own evidence.

## Related artifacts

- [Execution plan](../plans/2026-09-29-ael-evidence-continuity.md)
- [Delivery index](../../product/ael-value-delivery.md)
- [Proposal](../../sdd/proposals/2026-09-29-ael-value-delivery.md)

[^sources]: [experience-store.ts](../../../src/storage/experience-store.ts), [reconstructor.ts](../../../src/evidence/reconstructor.ts), [service.ts](../../../src/learning/service.ts), [2026-09-12-reliable-session-observation-design.md](2026-09-12-reliable-session-observation-design.md). Audited production counts are historical observations; proposed behavior and limits are not claims about the current installation.
