# M9: cross-agent reuse and measured effectiveness

## Status

Draft, 2026-09-06. Depends on M4–M8. Extends spec 007 and product acceptance criteria. Baseline measurements start in M4/M5 and are inputs to this milestone.

## Problem

More events, candidates or persuasive reports do not demonstrate better agent behavior. Passive overhead, lesson quality and the additional effect of advice require separate evaluation.

## Evidence

Spec 007 explicitly requires behavioral improvement and stable regression cases. Existing product criteria defer thresholds until real-session measurements exist. The user identified token economy, speed, security and reliability as evaluation dimensions.[^1]

## Goals

Produce reproducible evidence for all five operational scenarios and cross-agent reuse. Measure net cost and time including AEL's own work. Publish versioned thresholds and explain coverage limits before release approval.

## Non-goals

Invented savings percentages, deriving cost from event counts, comparing unrelated sessions as causal evidence, claiming universal cloud/provider coverage, or treating passive observation as if it delivered advice.

## User-visible behavior

An on-demand report shows collection coverage, reconstructed episodes, candidate usefulness, advice delivery/use and observed results. Separate three conditions: AEL disabled, passive observation, and explicitly enabled advice. For each, report supported token/time metrics and resource overhead with unavailable values kept explicit.

The report links a result to scenario, source/model/tool versions, environment, evidence and lesson version. Separate synthetic replay, controlled agent runs and observational production results. A correctness result can be accepted with missing token telemetry, but token savings cannot be claimed for that run.

## Architecture and boundaries

Use a versioned local fixture/harness and golden behavioral assertions. Keep five scenarios: cloud connection discovery, SSO intervention, Kubernetes scope search, corrected command and project tool choice. Include alternate environments, stale lessons, conflicting evidence, incomplete sessions and malicious/secret-bearing content.

Cross-agent evaluation initially covers Codex→Cursor and Cursor→Codex using each integration's actual supported channel. Claude Code artifact ingestion or adapter tests do not establish automatic hook support. A claimed supported path needs its own end-to-end evidence.

## State and lifecycle

Each benchmark run records configuration, corpus version, expected behavior, observed outcomes and exclusions. Threshold changes are reviewed and versioned; do not retroactively change thresholds to pass a release. Lessons learned from evaluation remain isolated from the production knowledge store unless explicitly promoted.

## Failure behavior

Incomplete runs report incomplete. Missing evidence cannot become a pass. Provider or environmental failure is distinguished from product failure with observed reasons. Benchmark tooling does not alter live cloud resources by default and does not block passive capture.

## Privacy and security

Sanitize fixtures and keep sensitive identifiers local. No raw transcripts or credentials enter shared reports. Safety assertions include no cross-scope actionable advice, no new unapproved privilege, no secret persistence and no new passive interference. Preserve the existing authority/Git boundary.

## Compatibility and rollout

Add versioned reports and scenario data without changing existing counters. Publish release evidence under `docs/verification/` with source coverage and adopted thresholds. Rollback of advice preserves passive records. Baseline model, cache, environment and tool changes require a new comparable run, not reuse of incompatible totals.

## Acceptance criteria

- M9-A1: each scenario has a deterministic regression fixture and a declared representative end-to-end evaluation; expected actions and states, not prose fluency, determine correctness.
- M9-A2: passive mode adds no guidance, permission changes or human prompts; its hook and CPU/I/O overhead are within pre-approved measured budgets.
- M9-A3: admitted-event recovery, replay idempotency and coverage reporting satisfy M4/M5 under fault injection.
- M9-A4: label candidate relevance, applicability and evidence quality; distinguish false findings from useful reusable lessons.
- M9-A5: advice reduces repeated invalid actions or unnecessary discovery in the relevant comparable scenarios without wrong-scope execution; saved time/tokens include capture, retrieval, delivery and analysis overhead.
- M9-A6: token accounting excludes cumulative/cache/parent-child double counting; unavailable costs remain unavailable. Human waiting is separate from agent detection/operation latency.
- M9-A7: knowledge from one supported agent is delivered and used by another with correct lifecycle and provenance; adapter-only tests are not claimed as end-to-end reuse.
- M9-A8: disputed/expired knowledge, malicious evidence, scope mismatch and provider failure regressions pass without secret exposure or unapproved changes to permissions.

Run the complete `pnpm check`, scenario regressions, fault-injection and comparative performance checks. The release report maps every acceptance ID across M4–M9 to evidence, or explicitly excludes an unshipped capability.

## Open decisions

Before approval: establish representative corpus/hardware/integration coverage, baseline conditions, reviewer-labeling procedure and concrete release thresholds from M4/M5 data. Approving this draft without those values is not a benchmark acceptance gate.

[^1]: [Quality benchmark baseline](../../sdd/specs/007-quality-benchmark.md), [product acceptance](../../product/acceptance-criteria.md), [roadmap](../../product/roadmap.md).
