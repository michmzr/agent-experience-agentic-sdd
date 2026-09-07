# M6: passive operational episodes and local lessons

## Status

Draft, 2026-09-06. Depends on [M5](2026-09-06-m5-session-evidence-design.md). Extends specs 001/002/006. Guidance is deferred to M8.

## Problem

Keyword matches and isolated tool outcomes do not explain why an agent got stuck or which correction worked. Review-generated candidates must become inspectable local records without turning observations into automatic policy.

## Evidence

Default reviewers rely on keywords or outcomes; the workflow reviewer emits generic recommendations. The review service labels legacy proposal findings `successful-workflow` regardless of their source. The user requested learning from wrong tools and corrected commands.[^1]

## Goals

Derive evidence-backed episodes and persist candidate lessons in passive mode. Support both successful discoveries and recovery after failure. Distinguish verified facts from hypotheses and classify lesson kinds correctly.

## Non-goals

Injecting advice, executing corrections, modifying repository instructions, automatic shared/global promotion, autonomous deep external-model review and proving causality from chronology alone.

## User-visible behavior

On request, show the goal when observable, applicable context, attempted operations, errors, changed approach, confirming result and candidate lesson. Missing intent remains unknown. A lesson provides when-to-use conditions, recommended procedure, evidence, last verification and invalidation conditions. A hypothetical cause is labeled and cannot become confirmed guidance.

Initial scenarios are tool selection (`npm` versus project-required `pnpm`, environment setup versus project-required `uv`) and a command corrected after a confirmed error. Existing project instructions may directly establish a convention; deliberately executing a wrong tool is never required to learn it.

## Architecture and boundaries

A separate bounded analysis job consumes committed M5 evidence. Deterministic detectors select candidate episodes; keyword matches are leads, not proof. Version analysis input/evidence ranges and detector version. Persist episodes, findings and candidates through validated transactions with stable identities. An interrupted job resumes without duplicate candidates.

If automatic local analysis is enabled, ingestion completion can enqueue one coalesced bounded job; starting/stopping analysis does not hold the capture consumer. Manual deep review remains separately invoked. External reviewer backends require explicit configuration and budget; this milestone does not require one for its initial deterministic scenarios.

## State and lifecycle

Analysis jobs track pending, running, completed, retryable failure or quarantined input. Episode states distinguish unresolved, outcome-observed and solution-supported. Candidate/observed/confirmed/verified/disputed states reuse the existing knowledge lifecycle; episode completion does not promote a lesson to verified.

One failure does not establish a permanent invalid-command rule. A successful correction must be connected to the same intended operation and supported by a task-relevant check. A plain exit 0 may confirm syntax execution but not successful resource access. Contradictory evidence is attached rather than silently replacing history.

## Failure behavior

Resource exhaustion, detector failure and ambiguous causality yield incomplete analysis or a hypothesis. Capture continues. Repeated analysis failures are bounded and visible on demand. Failure of one detector does not falsely mark the whole session fully reviewed.

## Privacy and security

Use sanitized evidence only. Distinguish source text from executable instructions. Candidate commands are data and are never run by analysis. A command fix that changes target, privilege or destructive effect requires separate consideration and cannot be a transparent substitution. Task-only corrections do not become shared policy; user preferences retain approval requirements.

## Compatibility and rollout

Store new records additively with provenance and detector versions. Existing `review session` JSON behavior must retain compatibility through a declared version strategy; optional persistence must be explicit. Legacy mistyped candidates are not silently rewritten into verified lessons. Disable new analysis without losing capture or existing knowledge.

## Acceptance criteria

- M6-A1: project-supported tool convention produces a correctly scoped candidate; another repository and a task-only instruction do not inherit it.
- M6-A2: failed command, changed command and confirming result produce a linked repair episode; unrelated later success and transient outages do not create a durable repair rule.
- M6-A3: successful discovery without an earlier failure can produce a positive candidate; unknown outcomes cannot be recommended as confirmed successes.
- M6-A4: restart/reprocessing produces one logical episode/candidate with retained provenance; a conflicting later result is preserved.
- M6-A5: report findings, hypotheses, candidate lessons and verified knowledge separately, including analysis coverage.
- M6-A6: interrupted/expensive analysis cannot delay ingestion, ask the agent or send it guidance; the passive deliverable is usable with M8 disabled.
- M6-A7: stored candidates survive restart; their type is not unconditionally `successful-workflow`.

Verify positive/negative episode fixtures, lifecycle, replay, privacy and report compatibility, followed by `pnpm check`. Include human labeling of candidate usefulness rather than accepting fluent recommendation wording as evidence.

## Open decisions

Before approval: finalize episode schema, causal-evidence requirements per detector, local analysis trigger/coalescing/resource limits and persistence CLI/version contract. Resolve which records are observations versus candidates without weakening the existing lifecycle.

[^1]: [Default reviewers](../../../src/review/default-reviewers.ts), [review service](../../../src/review/review-service.ts), [workflow reviewer instructions](../../../.agents/reviewers/workflow-tools.md).
