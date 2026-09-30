# ADR 002: staged local knowledge reuse

## Status

Accepted for the local AAP implementation slice on 2026-09-30, following the user's authorization of all eight AEL specifications. This decision does not activate advice or accept the implementation.

## Context

The current M8 Draft depends on both M7 resource discovery and SSO. The audit found earlier integration gaps in result evidence, resumed capture, typed evidence production and candidate retrieval. A narrow local scenario can qualify those boundaries without requiring cloud credentials or SSO support. Its result would not establish full M8 or cross-agent M9 acceptance.[^context]

## Decision

Permit the authorized local advisory pilot after evidence continuity, recovery, scoped conventions, typed evidence ingestion and candidate lifecycle integration pass their acceptance gates. Freeze a baseline before those changes. Start with explicit agent-invoked CLI retrieval in Codex, per-repository opt-in and existing authority rules.

Keep passive observation default and independent. Require verified, fresh, scoped knowledge for actionable advice. Record retrieval, delivery, selection, application and task outcome as distinct facts with declared witnesses. Use both a tooling convention and a newly acquired project fact in paired trials.

The full cloud/SSO specifications and cross-agent benchmark remain separate commitments. This ADR amends the dependency for this local slice only; it does not remove the M7 prerequisites from full M8 acceptance.

## Consequences

The local loop can be evaluated before cloud expansion. It needs a public evidence producer, candidate review bridge, usage provenance and an actual delivery channel. Explicit annotations remain user-declared evidence; an agent's claim of application cannot become a native tool observation.

The package must report narrow qualified scope and unsupported source capabilities. A positive local trial cannot support general savings, cross-agent effectiveness or full milestone completion. Missing cost telemetry prevents a net-cost claim.

## Alternatives considered

Retaining the full M7 gate keeps one sequence but delays qualification of the local learning/reuse path. Adding detectors or semantic retrieval first increases output without repairing missing evidence or joining candidate retrieval. Automatically promoting candidates would make them visible sooner but violate the existing lifecycle and provenance contract. The proposal retains reviewed promotion and tests the narrower path first.

## Acceptance of the decision

Record this decision in the delivery index before implementing AAP. Verify default-off behavior, wrong-scope exclusion, witnessed use in session B, revocation and fail-open behavior. Compare with frozen disabled/passive conditions using AVB. If the pilot fails, retain the evidence and disable delivery without deleting history or changing passive capture.

[^context]: [Findings](../analysis/2026-09-29-ael-value-findings.md), [M8](../superpowers/specs/2026-09-06-m8-advisory-reuse-design.md), [delivery index](../product/ael-value-delivery.md).
