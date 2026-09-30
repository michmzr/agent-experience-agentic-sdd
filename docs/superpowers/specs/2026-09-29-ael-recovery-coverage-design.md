# AEL recovery and scoped analysis coverage

## Status

Approved for implementation on 2026-09-30; drafted 2026-09-29. Change ID: `ARC`. Priority: P0. Dependencies: AEC.

The user authorized implementation on 2026-09-30; the delivery index records this decision. Existing approved behavior remains authoritative until the implementation passes its acceptance gates.

## Problem

The audited spool contains 41 pending records and 988 records classified CORRUPT; one pending record reached 1411 attempts. Some captured sessions have no analysis stream. Global delivery counters cannot explain per-project completeness, and an empty analysis result does not distinguish inapplicable detectors from useful negative evidence.

## Evidence

F04: queue counts and repeated retries. F05: 477 wkregukobiet events and 513 SecondBrain events belong to sessions without analysis streams. These counts describe the audited snapshot and are not a source-level completeness denominator.[^sources]

## Goals

Make delivery gaps diagnosable and recoverable without endless unproductive retries, reconcile retained operations with analysis admission, and report scoped coverage honestly.

## Non-goals

Deleting quarantined evidence to clear counters, blindly replaying all historical data, a mandatory daemon, claiming universal source completeness, or letting analysis failure alter capture acknowledgement.

## User-visible behavior

Proposed maintenance commands:

```text
ael capture recovery plan --repository-id <id> --output <plan.json>
ael capture recovery apply --input <plan.json> --json
ael analysis reconcile --repository-id <id> [--apply] --json
ael status [--repository-id <id>] --schema-version 3 --json
ael status-global --schema-version 3 --json
ael analysis report --repository-id <id> --schema-version 3 --json
```

Reconcile defaults to a non-mutating preview. A recovery plan selects opaque record IDs, reasons, input hashes and the target capability profile. It explicitly lists ineligible records. Apply rechecks eligibility; it cannot silently broaden its selection.

Health v3 separates installation, globally scoped transport, repository/source-scoped receipts, operation evidence and detector execution. Each detector reports `evaluated-with-findings`, `evaluated-no-findings`, `insufficient-evidence`, `unsupported`, `not-run`, `incomplete` or `failed`. `evaluated-no-findings` requires a completed declared range and eligible input. Version 1 and 2 output shapes remain supported.

## Architecture and boundaries

Replace message-text retry classification with typed bounded reason codes: malformed-record, unsupported-schema, missing-session, missing-request, lifecycle-conflict, conflicting-identity, storage-unavailable and unknown-legacy. Keep old CORRUPT rows as historical classifications; new inspection can append a more specific classification without changing the original record.

Use a recovery-state side table so existing spool state constraints need not be destructively rebuilt. Transient errors receive at most four automatic attempts per recovery generation using bounded backoff. Missing dependencies enter waiting-dependency. Exhausted transient attempts enter held. A relevant newly committed dependency or explicit recovery plan can open a new generation; an unrelated hook does not reset the attempt budget. Do not delete the record on exhaustion.

The receipt ledger adds private scope, source, event class and build provenance. Count unique operation identities separately from transport deliveries and retry receipts. Retention exposes its window and makes older accounting unavailable. A trusted source denominator must be explicitly identified; retained request count is named retainedOperations and cannot stand in for it.

Reconciliation scans the AEC logical index in bounded pages, compares actual per-detector watermarks, and idempotently admits missing work. Existing automatic-learning opt-out prevents automatic reconciliation; explicit --apply is a separately requested maintenance operation and reports the override scope.

## State and lifecycle

Delivery states include pending, claimed, waiting-dependency, held, committed and quarantined through the base row plus recovery metadata. Append recovery attempts and outcomes with generation and reason. A recovered record remains auditable. The ledger distinguishes an accepted delivery from committed evidence and from completed analysis.

Never reconstruct source scope for old receipts by guessing from the currently invoking project. Unattributable history remains global/unknown. A completed analysis stream can still have insufficient data for a particular detector.

## Failure behavior

Storage failures preserve durable pending records. Missing recovery metadata makes maintenance unavailable, not successful. A stale recovery plan rejects changed rows before any effect. Interrupted apply resumes idempotently from recorded progress. Capture and ordinary agent work continue with fixed diagnostics.

## Privacy and security

No rejected command text, credentials, source transcript or raw source identifier enters reason codes or public reports. Use private keyed correlation identities. Recovery plans remain local and bounded to 100 selected records per batch; public reports page results rather than expose payloads.

## Compatibility and rollout

Introduce reason codes and diagnostics before enabling maintenance mutation. Qualify replay on cloned snapshots and synthetic fault fixtures first. Require compatible writer capabilities during migration. Rollback preserves recovery metadata and prevents older consumers from taking held rows as ordinary pending work.

## Requirements and acceptance criteria

| Requirement | Contract | Acceptance | Observable check |
|---|---|---|---|
| ARC-R1 | Delivery failures have fixed typed causes and bounded automatic attempts with preserved held/dependency-waiting records. | ARC-A1 | A permanently missing request does not accumulate unbounded retries; its later arrival enables one new eligible generation. |
| ARC-R2 | Recovery plans are bounded, hash-bound, scope-bound and idempotent without erasing original quarantine provenance. | ARC-A2 | Replay a eligible selected record once; repeat apply, inject a conflicting row and interrupt midway without duplicate effects. |
| ARC-R3 | Reconciliation admits missing detector work for retained operations, including pre-upgrade and resumed data. | ARC-A3 | A captured session with no job becomes analyzable through --apply; a second reconcile reports no added work. |
| ARC-R4 | Health counts distinguish transport, operations, scope, retention and trusted source denominators. | ARC-A4 | Mixed repositories and repeated delivery do not inflate unique operations; missing source denominator yields unavailable, not 100%. |
| ARC-R5 | Detector applicability and data sufficiency remain distinct from job completion and empty findings. | ARC-A5 | An all-unknown result set yields insufficient-evidence for repairs even after its job completes. |
| ARC-R6 | Legacy reports, opt-out behavior and fail-open capture remain compatible through faults and migration. | ARC-A6 | Run v1/v2 golden outputs, disabled automatic learning, lease recovery and full store-unavailability cases. |

## Benchmark and regression impact

AVB records the pre-change case and the post-change behavior. The matching plan names focused tests and its full acceptance path. Capture remains passive and fail-open; SQLite migrations, replay, scope isolation and privacy assertions are mandatory when affected. Successful component tests do not replace the listed public-path acceptance criteria.

## Open decisions

The stated limits, initial paths and exclusions are approved for implementation. Source capability qualification remains an implementation task with explicit unsupported outcomes, not permission to guess a host contract. Acceptance and rollout require their own evidence.

## Related artifacts

- [Execution plan](../plans/2026-09-29-ael-recovery-coverage.md)
- [Delivery index](../../product/ael-value-delivery.md)
- [Proposal](../../sdd/proposals/2026-09-29-ael-value-delivery.md)

[^sources]: [spool.ts](../../../src/capture/spool.ts), [spool-drain.ts](../../../src/capture/spool-drain.ts), [experience-service.ts](../../../src/application/experience-service.ts), [2026-09-13-automatic-operational-analysis-worker-design.md](2026-09-13-automatic-operational-analysis-worker-design.md). Audited production counts are historical observations; proposed behavior and limits are not claims about the current installation.
