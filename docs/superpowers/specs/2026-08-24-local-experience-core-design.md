# Local experience core

## Status

In review.

## Problem

Milestone 1 needs an independently usable foundation for recorded experience before source-tool adapters, deep session review, or runtime enforcement are added. The current workspace defines the required vocabulary and lifecycle, but contains no executable implementation or local persistence boundary.

## Evidence

- `docs/product/roadmap.md` defines the first milestone as a session-intelligence vertical slice, beginning with canonical vocabulary and local storage.
- `docs/sdd/specs/001-experience-core.md` requires evidence-backed lessons, explicit lifecycle states, preserved contradictions, global-approval controls, and retention without dangling references.
- `docs/architecture/shared-knowledge.md` requires a Git-tracked machine-readable index and per-entry Markdown for team-shared repository knowledge.
- `docs/product/requirements.md` requires local-first operation, macOS and Linux support, no mandatory daemon, and no network or LLM dependency on the normal path.

## Goals

- Provide a standalone TypeScript CLI named `ael` for creating, validating, inspecting, listing, retrieving, and exporting normalized experience records.
- Store private experience records locally with transactional updates, referential-integrity validation, deterministic output, and recoverable storage failures.
- Model sessions, events, observations, clusters, candidate lessons, evidence, and durable knowledge with stable identifiers and explicit lifecycle state.
- Keep repository-shared knowledge human-reviewable and activate it as team policy only after Git merge.
- Support exact retrieval by scope, path, tool, tag, lifecycle state, and deterministic recency ordering.

## Non-goals

- Source-session discovery or live Codex, Claude Code, and Cursor adapters.
- Privacy-scrubber implementation, external model calls, reviewer orchestration, proposal generation, and action or intent gating.
- Semantic search, embeddings, a daemon, cross-device synchronization, full-text indexing, and encryption at rest.
- Automatic promotion to global or team-shared policy.
- Inferring Git merge state from a local checkout.

## User-visible behavior

The first release provides these commands:

```text
ael init [--scope global|repo]
ael experience add --input record.json
ael validate [--scope global|repo] [--json]
ael inspect <id>
ael lessons list [--scope global|repo] [--state <state>] [--tag <tag>]
ael retrieve --path <path> --tool <tool> --tag <tag> [--scope global|repo]
ael export [--scope global|repo] [--format json]
```

`experience add` accepts already-normalized, non-secret-bearing input and rejects raw session transcripts or unsupported payloads. Events carry only typed metadata: source identity, kind, timestamp, tool name, path, outcome, and exit status. Arbitrary event payloads and `rawTranscript` fields are not part of the input schema. It validates the complete input and applies it atomically, so an invalid record cannot partially change the store.

`retrieve` returns only exact metadata matches. Its ordering is deterministic: more matching supplied filters first, then newer applicable knowledge, then ascending identifier. It does not perform semantic ranking.

Global durable knowledge requires recorded explicit user approval. Repository knowledge is team-active only when an explicit import or promotion record identifies it as merged; branch-local entries remain local context.

## Architecture and boundaries

The CLI, validation library, and local store form the private experience core. A private SQLite database holds sessions, normalized events, observations, clusters, candidate lessons, evidence, lifecycle history, and local global-user knowledge. SQLite uses foreign keys and transactional migrations. Mutations that affect lifecycle or retention use a write transaction.

Repository knowledge is not authoritative in SQLite. It is stored under the repository in a machine-readable index and separate Markdown documents. SQLite may cache parsed repository knowledge, but cache contents are rebuildable and cannot create shared policy.

The core accepts normalized records only. Future source adapters own source-specific discovery and normalization. Future privacy work owns sanitized review artifacts and any external-model submission. Future runtime work consumes a compiled immutable snapshot rather than querying SQLite per decision.

## State and lifecycle

Each record has an opaque stable identifier. References must resolve within the applicable store snapshot: events reference an existing session; observations reference at least one event; clusters reference at least one observation; candidates reference one cluster; durable knowledge references at least one evidence item and one candidate.

Events are append-only factual records. Observations preserve factual context. Candidate lessons generalize clustered observations and must not copy an event payload as their statement. Durable knowledge is a separate promotion record, preserving the local candidate and its evidence provenance.

Evidence is immutable and has one polarity: `confirms`, `contradicts`, or `contextualizes`. In this slice, a contradiction is credible when an explicitly submitted `contradicts` evidence record passes schema and reference-integrity validation; later review can revalidate the resulting state. The normal lifecycle is `candidate` to `observed` to `confirmed` to `verified`. An active state can move to `disputed`, `superseded`, `rejected`, or `expired`. A disputed entry may return only to `observed`, `confirmed`, or `verified` through an explicit revalidation transition with new evidence; it cannot return to the untrusted `candidate` state. `superseded`, `rejected`, and `expired` are terminal in this slice. Every transition is recorded in lifecycle history.

Credible contradictory evidence moves affected active knowledge to `disputed`; it does not remove the knowledge or its evidence. Retention calculates the references reachable from active knowledge, disputes, and lifecycle history. It may tombstone and later purge events or observations only when no retained record references them. Otherwise it preserves them or retains a redacted immutable evidence snapshot.

## Failure behavior

The CLI validates schema, reference integrity, and permitted lifecycle transitions before each mutation. Invalid input or corrupt storage produces a clear diagnostic and exits without modifying the last valid state.

Private storage is written transactionally. Future runtime snapshots are outside this slice; this implementation therefore does not make runtime availability depend on SQLite. A later snapshot build must retain the last-known-good snapshot if a rebuild fails.

## Privacy and security

Private data directories use owner-only permissions. The core does not export raw session transcripts, secret-bearing event payloads, or private review detail. `experience add` rejects raw transcript fields and text containing a PEM private-key header, an AWS access key identifier, a GitHub personal-access token, an OpenAI API key, or a bearer-token assignment before persistence.

No encryption-at-rest claim is made. The privacy-scrubber stage must create a separately identified sanitized artifact before external analysis can be implemented.

## Compatibility and rollout

The CLI targets macOS and Linux with Node.js and `pnpm`. SQLite schema migrations are versioned and run transactionally. Repository knowledge uses a versioned index and per-entry Markdown from the first release. The initial schema contains no adapter-specific fields beyond declared source identity, so later adapters can be added without altering the core contracts.

## Acceptance criteria

- A valid positive observation can be clustered into a candidate lesson while preserving source evidence and applicability context.
- A failed observation can be stored without becoming durable or enforcement-ready knowledge.
- Contradictory evidence remains attached, changes active knowledge to `disputed`, and does not delete history.
- A disputed entry retains its evidence and is excluded from any future enforcement-ready export.
- An unapproved global entry cannot be presented as authoritative.
- A repository entry cannot be marked team-active without explicit merged provenance.
- Retention never creates dangling references.
- Repeated write, list, validate, and export operations serialize records in the same order.
- Scope-specific retrieval cannot return repository knowledge from another repository.
- Corrupt or invalid input fails with a diagnostic and leaves the preceding valid data intact.
- The CLI and its tests require neither a network service nor an LLM call.

## Benchmark and regression impact

This slice adds deterministic fixtures for a successful workflow, a negative failure, contradiction and dispute, global-approval protection, repository merge authority, retention integrity, scope isolation, deterministic serialization, and corrupt-storage recovery. These establish the storage and lifecycle cases required by the later quality benchmark.
