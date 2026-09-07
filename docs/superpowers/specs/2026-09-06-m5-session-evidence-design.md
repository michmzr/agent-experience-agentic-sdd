# M5: session reconstruction and measurement

## Status

Draft, 2026-09-06. Depends on [M4](2026-09-06-m4-asynchronous-passive-capture-design.md). Extends specs 001/002/007/008 and the deferred incomplete-session work in milestone 3.3.

## Problem

Event totals cannot explain attempted operations, failures or successful recovery. Missing results and delayed delivery must not become fabricated outcomes. Timings and token usage need source provenance and separate measures for waiting and active execution.

## Evidence

Current review events hold tool, timestamp, optional exit status/text and outcome; they do not define structured token usage. Passive capture excludes some source event classes. The earlier inspected records contained unknown outcomes, which cannot establish successful or failed work.[^1]

## Goals

Produce a traceable session timeline with correlation, outcomes and coverage. Start cost/speed baselines before introducing advice. Make partial or truncated sessions analyzable without presenting them as complete.

## Non-goals

Inference of missing tokens, hidden reasoning, global collection of unrelated sessions, automatic resource access, lesson promotion and advice delivery.

## User-visible behavior

A local report distinguishes operations from events, attempts from retries, process exit from task success and observed human waiting from unexplained gaps. Each derived value references retained evidence or is marked unavailable. Report session coverage, skipped source classes, truncation and unknown results. Read-only inspection must not silently import unrelated histories.

Supported local artifacts can supplement passive records under an explicitly selected source/root and privacy policy. Report transport identity separately from artifact identity, join only on validated correspondence, and avoid counting the same operation twice.

## Architecture and boundaries

Normalize allowlisted structured observations outside the hook from source-supported fields and configured local artifacts. Preserve request/result IDs, parent/session relations and provenance. Retain categorized error evidence rather than unrestricted output. Source capability tables state what is measurable for each adapter; absent information remains absent.

Metrics include hook overhead, spool age/lag, operation latency, session elapsed time, observed waiting, source-provided input/output/cache usage and analysis cost. Do not sum cumulative token snapshots or parent/child totals twice. Cached-token subsets must not be added as additional input tokens. Currency estimates require model/provider/date/rate provenance and cannot masquerade as actual billing.

## State and lifecycle

Reconstruction distinguishes open, source-ended, reconciled-complete and incomplete views. A source end and ingestion completion are different facts. Reconciliation uses declared source sequence/bounds when available; an empty queue or elapsed timeout alone cannot prove complete capture. Mark late corrections with a new reconstruction version and evidence, preserving original timestamps and immutable raw normalized records.

Correlation uses identifiers and source semantics, not adjacent timestamps. Unmatched records remain pending/unmatched with bounded retention. Interrupted sessions never receive an invented source end time. The M4 storage amendment and this projection must have one consistent policy.

## Failure behavior

Unsupported artifacts, resource limits or malformed usage degrade only the relevant report fields. Reprocessing is idempotent. Partial ingestion remains visible, and analysis cannot block capture. Evidence referenced by active lessons survives normal cleanup.

## Privacy and security

Use explicit artifact roots and sanitized data. Persist no credentials, raw prompts or unrestricted output as an incidental consequence of richer metrics. Local resource identifiers have controlled exposure; aggregate diagnostics do not reveal command values. Source capability gaps are not permission to inspect unrelated user data.

## Compatibility and rollout

Add versioned derived records and optional metrics. Old records remain valid with unknown/missing fields. Opt-in local reprocessing preserves originals and is reversible by disabling derived-view use. Retention cannot delete referenced provenance. Existing raw-event counters retain their meaning; new operation counts are separately named.

## Acceptance criteria

- M5-A1: request/result reordering, duplicates, missing results and repeated timestamps reconstruct without false pairing or double counting.
- M5-A2: source-end before queue drain and absent session-end yield distinct accurate states; an elapsed timeout is not presented as a true end.
- M5-A3: fixtures distinguish command failure, process success with failed task verification, unknown outcome and human waiting.
- M5-A4: source counters reconcile to input/output/cache totals without cumulative or subagent duplication; missing usage displays unavailable, never zero.
- M5-A5: five user scenarios have labeled evidence fixtures plus changed-environment, missing-data and secret-bearing variants. Synthetic fixtures are labeled synthetic.
- M5-A6: repeat ingestion/reconstruction preserves identities, references and historical views; unsupported classes and truncation are reported.
- M5-A7: the report supports a baseline with overhead/time/token provenance and explicit uncertainty about attribution.

Verify adapter equivalence, privacy, reconstruction, lifecycle and bounded-artifact suites, then `pnpm check`. A manually checked representative source session is required in addition to deterministic fixtures.

## Open decisions

Before approval: choose supported source fields and coverage matrix, retained error categories and local-artifact opt-in contract; specify time attribution and usage accounting per source; reconcile late-event retention/finalization with M4.

[^1]: [Review contracts](../../../src/review/contracts.ts), [capture scope and observed gaps](../../product/roadmap.md), [baseline domain model](../../architecture/domain-model.md).
