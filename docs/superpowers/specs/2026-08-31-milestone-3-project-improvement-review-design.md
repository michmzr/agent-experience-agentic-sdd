# Milestone 3 project-improvement review design

## Status

Approved through delegated user approval on 2026-08-31.

## Scope

This increment adds deterministic architecture, developer-experience, and project-management review. It converts corroborated sanitized session evidence into project-improvement proposals. It does not add embeddings, RAG, remote model calls, or new external reviewer runtimes.

## Decision

The review pipeline will remain local and deterministic. Existing keyword-only reviewers are insufficient because a single matching event can create an ungrounded recommendation. The new reviewers must emit structured evidence-backed findings. A consolidation stage will produce a project improvement only when related findings corroborate the same root cause.

The implementation will preserve the current source adapter, sanitizer, runtime profile, and proposal provenance boundaries. Reviewer input remains a sanitized artifact. No raw session value, local path, credential, or opaque identifier may appear in a finding or proposal.

## Review contract

Each specialist reviewer emits findings with:

- a stable reviewer and finding identifier;
- one of `architecture`, `developer-experience`, or `project-management` categories;
- a bounded severity value;
- a root-cause identifier;
- a recommendation; and
- one or more source event identifiers.

The finding is valid only when its evidence identifiers resolve to events in the sanitized artifact. The reviewer may report an individual observation. The system must not create a project-improvement proposal from an uncorroborated observation.

## Consolidation

The orchestrator groups findings by category and root cause, using stable ordering. It creates a consolidated project improvement only when two or more distinct evidence events support the group. The resulting proposal preserves all finding and event identifiers, states its category and severity, and uses one deterministic recommendation. Conflicting recommendations remain an unresolved disagreement and create no proposal.

Review results continue to create candidate lessons and proposals only. Architecture, workflow, tooling, skill, and code proposals require a separately approved specification before implementation.

## Error handling

Malformed reviewer output, unknown event references, invalid categories, invalid severity, duplicate identifiers, and unsupported recommendations cause that review to fail with a typed diagnostic. Other independent reviewers may still complete. Sanitizer failure remains a hard stop before any reviewer runs.

## Verification

Regression tests will cover valid findings, source-evidence validation, deterministic ordering, cross-reviewer consolidation, duplicate evidence exclusion, unresolved disagreement, single-observation non-promotion, invalid output isolation, and proposal provenance. Benchmark fixtures will exercise architecture, DX, and project-management friction using recurring evidence.

## Out of scope

Embedding generation, vector storage, semantic retrieval, model-backed reviewer execution, and benchmark thresholds from real sessions are deferred. The current exact and metadata retrieval path remains unchanged.
