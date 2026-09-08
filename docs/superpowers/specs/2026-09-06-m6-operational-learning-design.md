# M6: passive operational episodes and local lessons

## Status

In progress, 2026-09-08. Approved on 2026-09-08. Depends on [M5](2026-09-06-m5-session-evidence-design.md) and [M5.1](2026-09-07-m5-1-reliable-raw-session-ingestion-design.md). Extends specs 001/002/006. Guidance is deferred to M8.

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

Initial scenarios are tool selection (`npm` versus project-required `pnpm`, environment setup versus project-required `uv`) and a command corrected after a confirmed error. Existing project instructions may directly establish a convention; deliberately executing a wrong tool is never required to learn it. Broader tool-preference inference from ambiguous sessions is outside M6.

## Architecture and boundaries

A separate bounded analysis job consumes committed M5 evidence. Deterministic detectors select candidate episodes; keyword matches are leads, not proof. M6 ships two detectors: repository tool conventions and confirmed command repairs. Version the analysis input range, detector and detector configuration. Persist jobs, episodes, findings, evidence and candidates through validated transactions with stable identities. An interrupted job resumes without duplicate candidates.

Committed ingestion enqueues local analysis by default. Admission coalesces pending work by repository and session, records the highest committed evidence ordinal and returns without waiting for analysis. A configuration switch can disable automatic admission without disabling capture or manual analysis. The worker claims one bounded job, checkpoints detector progress and applies configured limits for events, elapsed time and retry attempts. Starting, stopping or retrying analysis does not hold the capture consumer. Manual deep review remains separately invoked. External reviewer backends require explicit configuration and budget; this milestone does not require one for its initial deterministic scenarios.

## Records and identity

An analysis job records repository, session, input range, detector-set version, state, attempts, checkpoint, coverage and timestamps. Job states are `pending`, `running`, `completed`, `retryable-failure` and `quarantined-input`.

An episode records its detector, repository and session scope, ordered evidence event IDs, state, intended operation when observable, attempted operation, changed approach, confirming result and optional hypothesis. Episode states are `unresolved`, `outcome-observed` and `solution-supported`. Missing fields remain absent rather than inferred.

A finding records a typed detector conclusion and its supporting event IDs. A candidate lesson records its lesson kind, statement, applicability conditions, recommended procedure, supporting evidence, last verification and invalidation conditions. Candidates enter the existing knowledge lifecycle in `candidate` state. Reports read verified knowledge from the existing knowledge store instead of treating episode completion as verification.

Stable identities are hashes over record type, repository scope, session, canonical evidence range and detector version. Reprocessing the same range updates provenance and coverage in one transaction. A later conflicting result creates contradictory evidence linked to the same logical candidate and allows the lifecycle to mark it `disputed`; it does not replace earlier evidence.

## Detector requirements

The tool-convention detector reads only regular, non-symlinked `AGENTS.md`, `CLAUDE.md` and `.ael/instructions.md` files at the repository root, each capped at 128 KiB. It records the basename, SHA-256 digest and matching line number, not the full instruction text. The detector requires an explicit supported-tool directive such as `Use pnpm instead of npm` or `Use uv instead of pip`. Task-only instructions remain session-scoped and cannot create reusable repository knowledge. The initial detector recognizes explicit `pnpm` and `uv` conventions. It can emit a positive candidate without observing a deliberately wrong command.

The command-repair detector requires a failed command, a later materially changed command for the same intended operation and a confirming task-relevant result. It compares parsed executable and argument structure rather than text similarity alone. A plain zero exit status confirms command execution but does not establish resource access. Unrelated later successes, unknown outcomes and transient external outages cannot produce a durable repair candidate. Changes to target, privilege or destructive effect remain findings or hypotheses and cannot become transparent repair recommendations.

## State and lifecycle

Analysis jobs track pending, running, completed, retryable failure or quarantined input. Episode states distinguish unresolved, outcome-observed and solution-supported. Candidate/observed/confirmed/verified/disputed states reuse the existing knowledge lifecycle; episode completion does not promote a lesson to verified.

One failure does not establish a permanent invalid-command rule. A successful correction must be connected to the same intended operation and supported by a task-relevant check. A plain exit 0 may confirm syntax execution but not successful resource access. Contradictory evidence is attached rather than silently replacing history.

## Failure behavior

Resource exhaustion, detector failure and ambiguous causality yield incomplete analysis or a hypothesis. Capture continues. Retryable failures use a bounded attempt count; exhausted retries and invalid input become visible quarantined jobs. Coverage is recorded per detector, so failure of one detector does not falsely mark the whole session fully reviewed.

## Privacy and security

Use sanitized evidence only. Distinguish source text from executable instructions. Candidate commands are data and are never run by analysis. A command fix that changes target, privilege or destructive effect requires separate consideration and cannot be a transparent substitution. Task-only corrections do not become shared policy; user preferences retain approval requirements.

## Compatibility and rollout

Store new records additively with provenance and detector versions. Existing `review session` JSON fields retain their meaning; M6 adds a versioned `analysis` object containing coverage, findings, hypotheses, candidate lessons and verified knowledge. Persisting deterministic M6 analysis is explicit in the review request or occurs through the automatic post-ingestion job. Legacy mistyped candidates are not silently rewritten into verified lessons. Disabling new analysis does not remove capture or existing knowledge.

## Acceptance criteria

- M6-A1: project-supported tool convention produces a correctly scoped candidate; another repository and a task-only instruction do not inherit it.
- M6-A2: failed command, changed command and confirming result produce a linked repair episode; unrelated later success and transient outages do not create a durable repair rule.
- M6-A3: successful discovery without an earlier failure can produce a positive candidate; unknown outcomes cannot be recommended as confirmed successes.
- M6-A4: restart/reprocessing produces one logical episode/candidate with retained provenance; a conflicting later result is preserved.
- M6-A5: report findings, hypotheses, candidate lessons and verified knowledge separately, including analysis coverage.
- M6-A6: interrupted/expensive analysis cannot delay ingestion, ask the agent or send it guidance; the passive deliverable is usable with M8 disabled.
- M6-A7: stored candidates survive restart; their type is not unconditionally `successful-workflow`.

Verify positive/negative episode fixtures, lifecycle, replay, privacy and report compatibility, followed by `pnpm check`. Include human labeling of candidate usefulness rather than accepting fluent recommendation wording as evidence.

## Chosen rollout boundary

M6 proves the local passive learning loop for explicit `pnpm` and `uv` conventions plus confirmed command repairs. It does not infer general tool preferences, deliver advice to an agent, execute candidate commands or promote candidates automatically. Those boundaries preserve the evidence, privacy and non-intervention requirements while leaving broader reuse to M7 and M8.

[^1]: [Default reviewers](../../../src/review/default-reviewers.ts), [review service](../../../src/review/review-service.ts), [workflow reviewer instructions](../../../.agents/reviewers/workflow-tools.md).
