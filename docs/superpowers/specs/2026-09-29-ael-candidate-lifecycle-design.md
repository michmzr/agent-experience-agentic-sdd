# AEL candidate review and knowledge lifecycle integration

## Status

Approved for implementation on 2026-09-30; drafted 2026-09-29. Change ID: `ACL`. Priority: P1. Dependencies: ASC, ATI.

The user authorized implementation on 2026-09-30; the delivery index records this decision. Existing approved behavior remains authoritative until the implementation passes its acceptance gates.

## Problem

Operational candidates, manual-review candidates and retrievable knowledge use separate paths. A reproduced convention candidate appears in analysis but not lessons list. Legacy manual-review findings are all typed successful-workflow, independent of their actual evidence.

## Evidence

F08: isolated analysis persisted one candidate while the public lesson listing returned zero. F09: review-service maps legacy findings to successful-workflow. This separation is not permission to promote observations automatically.[^sources]

## Goals

Create one inspectable local candidate review path, attach repeat evidence to stable logical candidates and make accepted knowledge retrievable under the existing lifecycle and authority boundaries.

## Non-goals

Automatic verified state, new enforcement, automatic Git/shared/global promotion, fuzzy merging of similar prose, executing proposed procedures, or rewriting historical review results without provenance.

## User-visible behavior

Proposed commands:

```text
ael candidates list --repository-id <id> [--state <state>] --json
ael candidates inspect <id> --json
ael candidates review <id> --input <review.json> --json
```

Candidates expose origin, kind, applicability, supporting/contradicting evidence, missing verification and review history. A review document requests a lifecycle transition, identifies actor provenance and cites new qualifying evidence. Repeating the same review is idempotent. A review cannot skip candidate → observed → confirmed → verified or clear a dispute without explicit revalidation evidence.

After the first accepted transition to observed, the canonical local knowledge entry becomes visible to existing lessons/retrieve with its actual state. Candidate listing remains the entrypoint for unreviewed records. Actionable pilot advice requires verified state and compatible fresh context; weaker states remain inspectable context.

## Architecture and boundaries

Introduce a canonical candidate identity and provenance bridge within the same private SQLite transaction boundary. Identity includes repository, lesson kind, structured applicability, normalized proposition/procedure key and identity schema version. Episode/session IDs remain evidence references, not the logical identity. If a producer cannot supply a stable semantic key, preserve separate candidates rather than merge by text similarity.

Operational and manual-review producers register candidate origins through one service. The bridge stores typed evidence references to instructions, operations, reviews and task verification without inventing legacy technical events. An additive metadata relation connects these references to the existing candidate/evidence/knowledge graph. Existing lifecycle functions remain the authority for allowed transitions; an eligibility layer checks evidence origin, independence and task relevance before invoking them.

For conventions, preserved authoritative scoped instructions support the fact of the convention. A repaired procedure needs a linked same-intent correction and task-relevant verification before verified eligibility. Project facts require explicit deterministic or user-confirmed evidence of that fact. Duplicate delivery and repeated claims do not count as independent confirmation. Conflicting evidence sets disputed; terminal states remain terminal unless baseline policy already permits otherwise.

Manual review retains the originating finding kind. Ambiguous old outputs become unclassified for review and cannot enter the canonical knowledge graph until a supported LessonKind is justified. No new unconstrained LessonKind is added to the existing domain enum.

## State and lifecycle

Keep knowledge lifecycle candidate, observed, confirmed, verified, disputed, superseded, rejected and expired. Candidate inbox workflow and lifecycle state are distinct. Shared activation still requires the existing promotion and Git merge boundary. Candidate registration and review never refresh enforcing runtime directives.

Updating applicability or a procedure creates a new candidate revision with explicit supersession links. Evidence history and old applicability remain auditable. Two sessions supporting the same unchanged proposition add two origin references to one logical candidate.

## Failure behavior

An invalid transition, unsupported kind, unresolved scope or insufficient evidence rejects the review with fixed reasons and leaves the graph unchanged. Interrupted registration/review either commits the complete graph or no part of it. Existing retrieval remains available if the candidate inbox is unavailable.

## Privacy and security

The bridge stores sanitized bounded statements and evidence summaries under existing limits. Procedures remain inert data. Global preferences and workflow/skill proposals preserve user-approval requirements. Public candidate reports omit private raw paths and source payloads.

## Compatibility and rollout

Backfill origin links for existing operational candidates through a previewed idempotent migration. Do not promote them. Existing knowledge IDs and filters retain meaning. Version manual-review export additions and preserve legacy outputs; activation of the new candidate sink is explicit for manual review.

## Requirements and acceptance criteria

| Requirement | Contract | Acceptance | Observable check |
|---|---|---|---|
| ACL-R1 | Operational and opted-in manual-review candidates are inspectable through one inbox with provenance. | ACL-A1 | A convention and a review finding appear with their different origins after restart. |
| ACL-R2 | Logical candidate identity deduplicates unchanged propositions across sessions without merging incompatible scope. | ACL-A2 | Two equivalent scoped episodes create one candidate with two origins; a changed subproject or procedure remains separate. |
| ACL-R3 | Review validates lifecycle, evidence independence and verification eligibility without automatic promotion. | ACL-A3 | Reject a direct candidate-to-verified request, duplicate confirmations and a repair without task verification; preserve valid staged transitions. |
| ACL-R4 | Accepted local knowledge is retrievable with its actual lifecycle and structured applicability. | ACL-A4 | After accepted observed transition, lessons/retrieve exposes the same canonical entry; wrong-scope and terminal entries are excluded from actionable use. |
| ACL-R5 | Contradictions and freshness changes preserve audit history and suppress actionable stale knowledge. | ACL-A5 | Attach contradiction, inspect disputed state, and require explicit qualifying revalidation before renewed eligibility. |
| ACL-R6 | Manual-review lesson kinds reflect their source findings and ambiguous history is not relabeled successful. | ACL-A6 | Failure and project-fact cases retain their kinds; a legacy ambiguous record remains review-required. |
| ACL-R7 | Migration and transactions preserve existing knowledge, privacy and the Git authority boundary. | ACL-A7 | Interrupt candidate backfill/review, retry without duplicates, and verify no runtime directive or shared file was created. |

## Benchmark and regression impact

AVB records the pre-change case and the post-change behavior. The matching plan names focused tests and its full acceptance path. Capture remains passive and fail-open; SQLite migrations, replay, scope isolation and privacy assertions are mandatory when affected. Successful component tests do not replace the listed public-path acceptance criteria.

## Open decisions

The stated limits, initial paths and exclusions are approved for implementation. Source capability qualification remains an implementation task with explicit unsupported outcomes, not permission to guess a host contract. Acceptance and rollout require their own evidence.

## Related artifacts

- [Execution plan](../plans/2026-09-29-ael-candidate-lifecycle.md)
- [Delivery index](../../product/ael-value-delivery.md)
- [Proposal](../../sdd/proposals/2026-09-29-ael-value-delivery.md)

[^sources]: [transitions.ts](../../../src/domain/transitions.ts), [repository.ts](../../../src/learning/repository.ts), [review-service.ts](../../../src/review/review-service.ts), [promotion-policy.ts](../../../src/shared-knowledge/promotion-policy.ts). Audited production counts are historical observations; proposed behavior and limits are not claims about the current installation.
