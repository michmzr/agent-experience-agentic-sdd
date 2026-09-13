# Reliable session observation and evidence-based learning design

## Status

Approved on 2026-09-12 for implementation in one pull request. This design covers epic #1 and child issues #2 through #9. Delivery follows dependency order: measurement fixture, P0 foundations, P0 reporting, then P1 context and evidence episodes.

## Problem

Current capture can report a ready installation and completed analysis while operation results remain unknown, later resumed activity is rejected, skipped operations are not fully accounted for, and unchanged session content is analyzed repeatedly. Existing learning records do not preserve the historical instruction context or distinguish tool facts, agent claims, task closure, and analyzer interpretation.

The implementation must preserve passive fail-open capture, local privacy boundaries, existing SQLite records, and existing version 1 JSON fields. Process completion cannot stand in for data completeness or task success.

## Goals

- Provide deterministic, anonymized regression scenarios and a before/after quality report.
- Preserve conversation continuity across capture runs and resumes without inventing historical runs.
- Account for durably admitted operation receipts and explain skips with privacy-safe fixed reasons.
- Preserve source result facts, result provenance, explicit unknown reasons, and separate task verification.
- Execute bounded operational analysis automatically while coalescing unchanged work.
- Report installation, delivery, data quality, and analysis independently.
- Preserve immutable instruction, agent, repository, and worktree context when the source provides it.
- Detect corrections and verification gaps as evidence-backed episodes that abstain when evidence is insufficient.

## Non-goals

- Reconstructing missing historical run boundaries from current records.
- Treating a source file's presence as proof that an agent received or read it.
- Persisting raw prompts, transcripts, command output, credentials, or rejected command text.
- Treating a nonzero exit status as agent fault or treating exit status zero as task completion.
- Automatically promoting candidates into repository or global policy.
- Adding an external model, network service, or daemon requirement.

## Delivery structure

One feature branch and pull request contain eight verified increments. Each child issue is implemented test-first, committed atomically, checked against its acceptance criteria, and reported on epic #1 before the next dependent increment begins.

1. #2 adds the regression corpus and baseline evaluator.
2. #3 introduces additive conversation and capture-run lifecycle records.
3. #4 adds capture receipt accounting and completeness availability.
4. #5 adds result facts, provenance, unknown reasons, and bounded classification.
5. #6 replaces per-high-water jobs with coalesced analysis streams and automatic execution.
6. #7 exposes the versioned multidimensional health report.
7. #8 adds immutable instruction and execution-context snapshots.
8. #9 adds typed correction and verification-gap episodes.

## Regression corpus and evaluator

The repository gains synthetic fixtures derived from the semantic structure of the reviewed sessions. Fixtures contain replaced identifiers, synthetic paths, allowlisted structured event fields, expected relationships, expected skips, and explicit evidence gaps. They do not contain original transcript fragments or private source paths.

The corpus covers startup followed by resume, a delayed result, a missing result, duplicate lifecycle signals, nested tool identity, worktree identity, quoted and piped shell shapes, privacy rejection, asynchronous completion, `rg` exit status 1, interruption, environment restriction, expected RED with and without verification evidence, a Liquibase-to-SQL correction, and task closure with an unmet verification condition.

A deterministic evaluator reports transport records, unique admitted operation receipts, linked results, skip dispositions, unknown reasons, analysis execution state, findings, abstentions, and processing cost. Percent completeness is emitted only when a trusted source denominator is present. The same fixtures and evaluator produce the stored baseline and final comparison.

## Conversation and capture-run lifecycle

Version 1 `sessions` rows and evidence reports retain their current meaning. Additive version 2 tables introduce conversations, capture runs, and lifecycle signals. Existing rows remain readable and have unknown version 2 run history unless directly supported by retained evidence.

A conversation stores source identity, first observed receipt time, and identifier provenance. A capture run belongs to one conversation and stores optional source run identity, start and end facts, receipt times, and lifecycle state. Lifecycle signals are append-only facts with a stable source identity when available, signal kind, source time when supplied, receipt time, and an optional resolved run.

New technical records link to a conversation and optionally a capture run. Source occurrence time, hook receipt time, spool admission time, and database commit time remain separate. Receipt order can break transport ties but cannot fabricate source order.

A start received after a resolved run end opens a new run. An exact repeated start or end is idempotent. A start while a run is open, an end without sufficient run identity, or reordered signals without source ordering remain explicitly unresolved when deterministic assignment is impossible. Run end does not end the conversation. Later admitted events remain recordable after a previous run end.

The Codex hook configuration admits `SessionStart` signals whose source is `startup` or `resume`. Compact and clear signals remain unsupported until their source semantics are represented by fixtures. Legacy spool version 1 records drain through the legacy path without relabeling receipt timestamps as source timestamps.

## Capture receipt accounting

A privacy-bounded receipt ledger records the minimal envelope before detailed signature normalization. Each durable receipt contains source, diagnostic scope, phase or event class, receipt time, disposition, fixed reason, and optional locally keyed correlation references. It excludes raw commands, arguments, output, paths, prompts, user identifiers, and source identifiers.

Correlation keys use a private local secret-backed construction so low-entropy source identifiers are not exposed through plain hashes. The ledger has owner-only storage, bounded fields, explicit retention, and byte-level privacy tests.

Disposition values cover accepted, duplicate, unsupported tool, privacy redaction, unsafe normalization, malformed envelope, admission failure, delivery retry, quarantine, and legacy unknown. Every operation with a durably admitted minimal receipt is either linked to stored normalized evidence or has a countable disposition. If receipt or diagnostic persistence fails, accounting and denominator availability become `unavailable`; fail-open capture does not claim universal completeness during storage failure.

Source-relative completeness is emitted only when a trusted source denominator accompanies the fixture or supported artifact. Otherwise the report exposes admitted totals and gaps without a percentage.

## Result facts and interpretation

Result handling separates retained source facts from derived interpretation. A result fact stores an optional exit code or structured source status, source-field provenance, observation time, execution identity when supplied, and the related operation identity. An asynchronous terminal result can attach to the starting operation only through a stable identifier.

A versioned interpreter derives process status and a bounded semantic class. Initial classes include no-match, interrupted, environment-limited, failed-test, expected-red, unclassified-nonzero, and unknown. Unknown reasons include source-field-absent, result-not-delivered, awaiting-async-completion, correlation-missing, unsupported-result-shape, privacy-redacted, and legacy-record.

Task verification remains a separate evidence relation. Exit status zero confirms only process execution. Expected RED requires explicit test-cycle context. A repair detector consumes interpretation and verification eligibility, not a raw nonzero exit status.

## Coalesced automatic analysis

One durable analysis stream exists per repository, conversation or legacy session, and detector-set version. It records desired high-water, completed high-water, state, lease owner and expiry, bounded retry state, and next eligible attempt time. Admission atomically raises desired high-water instead of creating a job for every event count.

Each claim creates an immutable analysis run containing the actual input range, input digest, detector and configuration versions, context snapshot identity, start and finish times, examined event count, and bounded cost counters. The runner reads stable SQLite sequence ranges through the claimed boundary. Events arriving during execution raise desired high-water and leave the stream pending after the current range commits.

Expired leases return work to the queue. Execution failures use bounded backoff and a fixed retry limit before quarantine. Detector checkpoints and coverage are independent so one detector cannot mark the entire input fully analyzed after partial failure.

After capture acknowledgement, the detached worker drains a bounded amount of analysis work. Analysis never runs before durable capture acknowledgement and never changes hook exit behavior. Manual `analysis run` remains available. The worker exposes a condition that tests and callers can use to observe completion instead of inferring idleness from queue counts while a detached process still holds resources.

## Health and quality reporting

The version 2 health contract exposes independent dimensions:

- installation: ready, not-ready, or unknown;
- delivery: healthy, backlogged, degraded, or unknown;
- data quality: sufficient, degraded, unknown, or not-applicable;
- analysis: not-run, pending, running, completed, incomplete, failed, or quarantined.

Data quality includes admitted operation counts, linked results, skips by disposition, unknown results by reason, known-denominator state, observed time range, and run coverage. Analysis includes detector-set version, desired and completed high-water, backlog, retries, cost, coverage, and a result state of findings, no-findings, or unavailable.

Existing status fields retain their version 1 meaning. New JSON is additive under an explicit versioned object. Human output presents the dimensions separately. Global status applies the same definitions to every registered repository or workspace and does not expose private paths.

An empty finding list is reported as no-findings only after applicable detectors completed the declared input range. Missing or incomplete analysis reports unavailable or incomplete instead.

## Historical instruction and execution context

Instruction locations are configurable and include root `AGENTS.md`, root `CLAUDE.md`, `.agents/AGENTS.md`, and `.ael/instructions.md` by default. Regular non-symlinked files are read through the existing size and privacy limits.

An immutable context snapshot records a relative location, scope, digest, and independent found, delivered, and explicitly-read states. Each positive state requires evidence provenance; absence of such evidence remains unknown. Snapshot creation occurs at session start or first retained event. Later analysis uses the recorded snapshot rather than current file content.

Optional source fields can add conversation, run, agent, parent-agent, and worktree identities. Unknown values remain absent. Existing repository identifiers remain compatible. A new locally keyed repository-family identity derives from the canonical Git common directory, while a separate locally keyed worktree identity derives from the canonical worktree root. Public reports expose bounded states, not private paths or raw instruction digests.

Instruction parsing recognizes bounded directive forms rather than only two exact sentences. Recognized conventions remain candidates with source provenance and do not become policy automatically.

## Evidence-backed correction episodes

The versioned episode contract uses discriminated kinds for correction, verification-gap, and repeated-acceptance. Evidence references carry typed provenance: tool request, source result fact, task verification, user instruction, agent claim, task transition, instruction context, or analyzer inference.

A correction episode connects the original decision, correction, available reason, changed operation, and available outcome. A verification-gap episode records implementation observation, checks executed, check results, criterion evidence, and administrative closure as separate facts. Issue closure never implies criterion satisfaction.

A repeated-acceptance candidate requires equivalent decision and unchanged scope and context. A scope change prevents automatic classification as redundant. Analyzer conclusions include applicability, limitations, detector version, and supporting evidence. Insufficient evidence produces an abstention with missing evidence categories instead of an inferred finding.

Episodes and candidates remain local observations. Candidate promotion continues through the existing approval and Git authority lifecycle.

## Storage and compatibility

All version 2 schema changes are additive. Existing `capture_events` uniqueness and version 1 queries remain unchanged. New version 2 operation and result tables use source, conversation identity, and source event identity in their correlation key, avoiding a rebuild of the legacy table. Migration fixtures verify foreign keys, effect bundles, sequence ordering, and repeated migration.

Existing `sessions.ended_at` values are not extended. Existing evidence version 1 reports, learning records, candidates, status fields, and spool records remain readable. Derived version 2 interpretations are versioned and do not rewrite historical source facts. Disabling version 2 analysis stops new derivation without deleting capture or prior evidence.

Existing status and analysis commands return their current version 1 JSON shapes by default. `--schema-version 2` explicitly selects the multidimensional report and its namespaced version 2 contracts. Human output uses version 1 unless the same option is supplied. Documentation records field stability and state semantics.

## Failure and privacy behavior

Capture remains fail-open after bounded durable admission. Analysis, context reading, interpretation, and health aggregation cannot block agent actions. Unsupported input produces fixed diagnostics without raw values. Storage failure makes the affected accounting unavailable rather than successful.

Every new table and report has count, text, nesting, and byte bounds. Private stores retain owner-only permissions. Fixture scanning rejects credentials, private paths, raw transcript fragments, and unexpected fields. Commands from evidence remain inert data and are never executed by analyzers.

## Verification

Each increment follows RED, GREEN, and refactor with focused tests before its commit. Required suites cover adapter equivalence, lifecycle ordering, duplicate delivery, migrations, spool recovery, diagnostic privacy, result correlation, interpretation abstention, analysis concurrency, lease recovery, instruction history, worktree isolation, report compatibility, and episode false positives.

The final gate runs the corpus comparison on identical fixtures, all affected acceptance suites, `pnpm check`, staged-diff validation, secret scanning, and an independent code review. The verification report records exact test totals, baseline and final quality measures, unresolved gaps, and observed analysis cost. Lesson count is not used as a standalone quality measure.

## Issue traceability

- #2: regression corpus and evaluator.
- #3: conversation and capture-run lifecycle.
- #4: receipt accounting and completeness availability.
- #5: result facts and interpretation.
- #6: coalesced automatic analysis.
- #7: health and quality reporting.
- #8: historical instruction and execution context.
- #9: evidence-backed correction episodes.

[^1]: The current lifecycle limitation is implemented in `src/capture/hook-adapters/codex.ts` and `src/storage/experience-store.ts`.
[^2]: Existing session evidence contracts are defined in `src/evidence/contracts.ts` and `src/evidence/reconstructor.ts`.
[^3]: Current operational analysis admission and execution are defined in `src/learning/service.ts`, `src/learning/repository.ts`, and `src/capture/spool-drain.ts`.
