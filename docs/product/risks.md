# Risk register

## R1 False hard blocks

Impact: high. Mitigation: no numeric LLM confidence, evidence-based lifecycle, disputed rules never block, learning mode, auditable overrides and benchmarks for false blocking.

## R2 Memory pollution

Impact: high. Mitigation: observation layer, clustering, conservative promotion, value-aware retention and distinction between task-specific constraints and durable knowledge.

## R3 Stale knowledge

Impact: high. Mitigation: contradiction evidence, disputed state, explicit revalidation proposals, last-verified metadata and superseded history.

## R4 Experience layer becomes a single point of failure

Impact: critical. Mitigation: default embedded/in-memory decisions, no mandatory daemon, last-known-good snapshot, fail-open for normal actions, circuit breaker and short timeouts.

## R5 Privacy leakage from session review

Impact: critical. Mitigation: raw local storage, mandatory secret/privacy scrubber before external review, configurable retention and clear provenance of sanitized artifacts.

## R6 Reviewer cost and noise

Impact: medium. Mitigation: deep review is manual, review profiles are configurable, expensive checks require explicit enablement, reviewers have narrow perspectives.

## R7 Cross-agent integration drift

Impact: medium. Mitigation: canonical `.agents/` guidance, thin tool-specific entrypoints, adapter contracts and compatibility checks against current tool documentation.

## R8 Shared knowledge churn in Git

Impact: medium. Mitigation: only generalized durable knowledge enters shared files; raw reviews and observations remain local.
