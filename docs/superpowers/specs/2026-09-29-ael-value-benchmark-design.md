# AEL end-to-end value benchmark

## Status

Approved for implementation on 2026-09-30; drafted 2026-09-29. Change ID: `AVB`. Priority: P0 baseline; P1 comparison. Dependencies: None for the baseline stage.

The user authorized implementation on 2026-09-30; the delivery index records this decision. Existing approved behavior remains authoritative until the implementation passes its acceptance gates.

Implementation checkpoint 2026-09-30: synthetic B0 baseline, public-path B1 tests and a five-pair B2 protocol are present. Real-host trials, token telemetry and measured improvement remain unsupported. See the [requirement manifest](../../verification/2026-09-30-ael-requirement-traceability.json).

## Problem

The reliable-observation evaluator counts supplied fixture facts, while component success and increasing lesson counts do not demonstrate useful behavior across the capture-to-reuse path. No comparable production baseline supports savings claims.

## Evidence

F11: evaluator reads fixture findings, analysis states and costUnits directly. The prior audit and four reproductions provide regression leads, not a controlled value benchmark. Existing detached-worker acceptance remains useful and must be retained.[^sources]

## Goals

Begin baseline measurement before behavior changes, test the actual local pipeline, and compare disabled, passive and opt-in advice conditions using reproducible behavioral and cost evidence.

## Non-goals

Invented savings percentages, event-count token estimates, causal claims from unrelated sessions, live cloud mutations, or replacing component tests with a small benchmark.

## User-visible behavior

Provide a local benchmark runner with an explicit run manifest and isolated data directory. Proposed interface:

```text
ael benchmark run --manifest <run.json> --output <report.json>
ael benchmark compare --baseline <report.json> --candidate <report.json> --output <comparison.json>
```

The manifest pins corpus version, build IDs, scenario and source/integration versions, environment, order/seed, budgets and telemetry availability. A comparison rejects incompatible contexts. Reports separate synthetic replay, controlled agent runs and observational data. A functional pass with missing token or time telemetry cannot become a cost/speed improvement claim.

Baseline and candidate builds are distinct pinned identities. Reject an unrecorded replacement of either identity, not the intentional difference between those builds. Compare only shared scenario revisions when the corpus is expanded. Each scenario declares redundant-operation criteria before the trial: repeated discovery or a repeated failed attempt with no new evidence, excluding required validation and deliberate fault injection. Retain the operation IDs supporting each count for review.

## Architecture and boundaries

Use real public CLI admission, spool drain, operation indexing, analysis, candidate review and advisory retrieval in isolated stores. Golden assertions describe expected relationships and behavior; expected output records are not supplied as the analyzer input. Keep transport failure injection, privacy sentinels, resume, late result and cross-page fixtures.

Baseline stage B0 has no implementation dependency and runs the current artifact on the initial supported cases. Integration stage B1 follows ABI/AEC/ARC/ASC/ATI/ACL and checks the passive path. Comparative stage B2 follows AAP and measures actual session A/B delivery and use. These staged dependencies avoid making AAP and AVB cyclic.

Instrument actual hook admission, drain, analysis, retrieval and delivery cost separately. Count unique operation identities and exclude retries, cumulative/cache/parent-child double counting from token arithmetic. Human waiting is separate from processing time. Capture the cost of admission history scans; optimize those scans only if the measured case exceeds the declared budget or demonstrates avoidable history-proportional work.

For controlled paired runs, use five runs per condition per scenario with fixed task/environment and recorded order. This is a proposed minimum pilot protocol, not evidence of statistical significance. Freeze the run manifest and agreed budgets before candidate runs; changed thresholds require a new comparison series.

## State and lifecycle

Runs are planned, running, complete, incomplete or invalid-comparison. Results distinguish correctness-pass, safety-fail, performance-not-established and measured-improvement. Missing measurements are unavailable, never zero. A failed safety assertion prevents a successful pilot report even if a task finishes faster.

## Failure behavior

A crashed or partially instrumented run remains incomplete and retains bounded diagnostics. It does not modify the production knowledge store. If an actual integration cannot observe delivery/use, report that capability as unsupported and do not replace it with a synthetic pass.

## Privacy and security

Fixtures use synthetic identifiers and sanitized shape-preserving source examples. Reports contain no raw transcripts, credentials or private absolute paths. Agent/model configuration is explicit; no benchmark silently invokes a paid or external provider. Controlled real-agent runs require the already selected integration and operator authorization for that run.

## Compatibility and rollout

Create baseline artifacts before changes, expand the same corpus with each spec, then perform the local pilot. Measured acceptance of the broader M9 release still needs its full cloud/SSO/cross-agent scenarios. This package qualifies only the declared local subset.

## Requirements and acceptance criteria

| Requirement | Contract | Acceptance | Observable check |
|---|---|---|---|
| AVB-R1 | Baseline is immutable, versioned and clearly separates synthetic from actual integration observations. | AVB-A1 | Record current failing behaviors before changes; reject unrecorded build substitution and incompatible scenario/environment revisions while allowing the declared baseline/candidate build difference. |
| AVB-R2 | Golden scenarios traverse the actual public pipeline and fault boundaries rather than returning prepared findings. | AVB-A2 | Exercise resume, unknown result, recovery, scoped convention and typed verification through CLI and reopened SQLite stores. |
| AVB-R3 | Quality gates check correct scope, evidence and authority, not lesson count. | AVB-A3 | Wrong-scope advice, secret persistence, passive intervention and unapproved promotion each fail the run regardless of task success. |
| AVB-R4 | Paired pilot measurements include AEL overhead and unavailable telemetry, with budgets fixed before the comparison. | AVB-A4 | Run five paired cases per condition; report distributions and net metrics when available, otherwise performance-not-established. |
| AVB-R5 | The local value pilot demonstrates reduced redundant work in its declared scenarios without false improvement claims. | AVB-A5 | Require correct task outcome and at least one fewer redundant operation in the median advice run versus its matched disabled baseline; no wrong-scope or authority violation is permitted. |
| AVB-R6 | Every accepted requirement links to a real verification artifact and documentation status matches qualified capability. | AVB-A6 | Generate a requirement-to-test/run manifest, retain exclusions, and do not label this local pilot as full M7/M8/M9 completion. |

## Benchmark and regression impact

AVB records the pre-change case and the post-change behavior. The matching plan names focused tests and its full acceptance path. Capture remains passive and fail-open; SQLite migrations, replay, scope isolation and privacy assertions are mandatory when affected. Successful component tests do not replace the listed public-path acceptance criteria.

## Open decisions

The stated limits, initial paths and exclusions are approved for implementation. Source capability qualification remains an implementation task with explicit unsupported outcomes, not permission to guess a host contract. Acceptance and rollout require their own evidence.

## Related artifacts

- [Execution plan](../plans/2026-09-29-ael-value-benchmark.md)
- [Delivery index](../../product/ael-value-delivery.md)
- [Proposal](../../sdd/proposals/2026-09-29-ael-value-delivery.md)

[^sources]: [reliable-observation.test.ts](../../../test/reliable-observation.test.ts), [acceptance-criteria.md](../../../docs/product/acceptance-criteria.md), [2026-09-06-m9-effectiveness-benchmark-design.md](2026-09-06-m9-effectiveness-benchmark-design.md), [2026-09-13-automatic-operational-analysis-worker.md](../../../docs/verification/2026-09-13-automatic-operational-analysis-worker.md). Audited production counts are historical observations; proposed behavior and limits are not claims about the current installation.
