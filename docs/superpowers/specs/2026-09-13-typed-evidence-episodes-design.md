# Typed evidence episodes design

## Status

Approved for issue #9 implementation on 2026-09-13. This document narrows the epic-level episode design to deterministic, typed local evidence. It does not interpret free text or use external services.

## Observable outcome

The learning report can return a correction, verification-gap, or repeated-acceptance episode only when its typed evidence relations support that result. Each episode exposes its evidence identifiers, state, detector version, and missing-evidence limitations. The verifier runs deterministic fixtures that distinguish tool facts, agent claims, task transitions, and analyzer interpretation.

## Contract

Add a versioned `EpisodeEvidence` record with a stable local identifier, episode scope, and one of these provenance kinds:

- `tool-request`
- `tool-result`
- `task-verification`
- `agent-claim`
- `user-instruction`
- `task-transition`
- `instruction-context`
- `analyzer-inference`

The record includes only bounded, sanitized fields necessary for linking: correlation identifiers, normalized decision or scope key, state, and optional reason class. It never contains transcript text, command output, raw paths, credentials, or a claim that a tool result is an agent statement.

An episode has a discriminated kind and explicit fields rather than one overloaded hypothesis:

- A `correction` links an original decision, a changed decision, optional reason, and optional outcome.
- A `verification-gap` stores implementation, check execution, check result, criterion evidence, and administrative closure independently. Its criterion state is `met`, `unmet`, or `unknown`.
- A `repeated-acceptance` links two approval records and their scope keys. It is emitted only when both scope keys are equal. A changed scope produces no redundancy finding.

All candidates remain `candidate` observations. This feature neither creates global rules nor changes knowledge state.

## Detection

The detector receives typed evidence from the retained local analysis input. It may create an `analyzer-inference` evidence record only to identify a deterministic relation between other evidence records. An inference carries the detector version and the identifiers on which it depends.

A correction requires distinct decision and correction records with a common decision identity. A reason and outcome are included only when present. A verification gap requires administrative closure and a missing or non-met criterion; closure alone cannot establish implementation, check execution, or criterion completion. Repeated acceptance requires equivalent decision identity and identical normalized scope identity.

When a required relation is missing, the detector emits an `insufficient-evidence` finding that names the missing evidence categories. It does not create an episode or candidate from conjecture.

## Persistence and compatibility

Persist episode evidence separately from existing operational episodes and candidates. New tables reference episode identifiers and store typed, bounded payloads. Existing convention and command-repair episodes remain readable and retain their current contract. New episode records use a new detector version and a new discriminated payload, avoiding reinterpretation of older results.

The report returns typed evidence references and limitations. It does not reveal source identifiers or payload text. Snapshot, repository, conversation, and worktree provenance stay local and are used only as bounded linkage keys.

## Tests

Fixtures cover a Liquibase-to-SQL correction with a tool result, a correction with no reason, an issue closure with a missing verification criterion, a tool result that contradicts an agent claim, repeated acceptance with unchanged scope, and repeated acceptance after a scope change. Negative cases prove that a closure does not imply criterion satisfaction, an agent claim is not a tool result, and insufficient evidence does not generate a candidate.

The focused acceptance path builds the project and runs learning contract, detector, repository, and service tests. The final gate runs `pnpm check`, the serial suite if parallel cleanup races recur, diff validation, and code review.

## Non-goals

- Parsing sanitized prose to infer decisions, reasons, acceptance, or task completion.
- Calling an LLM, network service, or external issue tracker.
- Backfilling typed evidence from legacy capture records.
- Promoting an episode directly to local, repository, or global policy.
