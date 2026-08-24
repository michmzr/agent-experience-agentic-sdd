# Session intelligence delivery design

## Status

Approved through delegated user approval on 2026-08-24.

## Scope

This design completes the remaining Milestone 1 vertical slice: source-specific session ingestion, deterministic sanitization, manual review, parallel reviewer execution, stable orchestration, candidate lessons, proposals, and regression fixtures. It builds on the local experience core without changing its imported-knowledge lifecycle.

## Source boundary

Every adapter implements one local contract: enumerate explicit session artifacts, resolve a selected artifact, and normalize only known event forms into a `NormalizedSession`. Raw records, raw paths, prompts, responses, command arguments, tool output, environment values, and identifiers never enter SQLite or review output.

Supported ingestion is artifact-led. The caller supplies a root or artifact path, which makes discovery deterministic and testable. A source may expose a supported command for listing and exporting sessions; the adapter may use that command only if it has no network side effect. Local formats without published compatibility guarantees are labelled `observed` and require an explicit root. The Codex JSONL location observed on this machine is therefore not a stable default. Cursor GUI SQLite is not parsed. Cursor CLI session listing and explicit markdown export are the supported boundary. Remote or background-agent sessions are rejected because they violate the local-first requirement.

The normalized model preserves only source, opaque local session reference, repository hint, start/end time, event kind, tool name, exit status, outcome, and bounded text fields that will be sanitized before review. An unknown source record fails closed with a typed diagnostic.

## Privacy boundary

`sanitizeForReview` is the sole route from normalized local data to reviewer input. It redacts secrets, private keys, credential-bearing URLs, passwords, tokens, configuration values, absolute local paths, opaque IDs, and configured patterns. The sanitizer produces a new `SanitizedReviewArtifact`, a versioned policy hash, and counts by redaction category. It stores no replacement values or raw-to-sanitized lookup map in review output.

Any parse uncertainty, unsupported content type, sanitizer error, or remaining sensitive match blocks reviewer invocation. Review artifacts remain local and are excluded from Git and the experience SQLite store.

## Manual review and orchestration

The CLI requires `review session --source <codex|claude-code|cursor>` plus exactly one explicit session artifact or ID. Latest-for-repository selection is allowed only when descriptors carry a repository hint and the selection is interactive. The command accepts `--allow-expensive-checks` separately from ordinary read-only repository inspection.

A profile resolves named, versioned reviewer definitions. Reviewers receive only the sanitized artifact and optional read-only repository evidence. Independent reviewers run concurrently. The orchestrator sorts by a stable key, groups findings by supported root cause, preserves credible disagreement as `unresolvedDisagreement`, and never promotes a candidate merely because reviewers agree.

Candidate lessons remain `candidate`. Proposals retain `session -> finding -> proposal` provenance. Proposals in code, tooling, skill, workflow, or architecture categories declare that a separate approved specification is required before implementation.

## Verification

Fixtures cover one normalized equivalent session per source, observed-format rejection, source selection, secret and path redaction, sanitizer failure blocking, variable reviewer completion order, stable consolidation, unresolved disagreement, expensive-check gating, candidate non-promotion, and proposal provenance. Assertions target data and state transitions, not generated prose.

## Out of scope

Automatic capture, runtime enforcement, retrieval, lifecycle promotion, remote session ingestion, actual model API calls, and parsing undocumented private SQLite schemas remain outside Milestone 1.
