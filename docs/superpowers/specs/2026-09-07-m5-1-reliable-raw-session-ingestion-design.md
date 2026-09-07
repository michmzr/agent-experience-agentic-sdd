# M5.1: reliable raw session ingestion

## Status

Approved, 2026-09-07. Extends the completed M5 session-evidence work and the completed M3.3 bounded-artifact work. It precedes M6 operational learning and does not absorb M6 scope.

## Problem

`ael review session` cannot review a current, explicitly selected Codex session when the artifact contains valid source records outside the adapter's fixed envelope allowlist or a single JSONL record above 4 MiB. The observed session `01a07b11-0435-7a83-b162-f1770c90b072` fails for both reasons:

- 43 `token_usage_record` envelopes are rejected as unsupported records;
- one `custom_tool_call_output` line is 6,953,534 bytes and contains an array of 13 objects.

Manual preprocessing makes the session reviewable, but it changes the selected artifact, creates another private copy and hides ingestion loss from the review result. M5 reconstructs stored normalized capture evidence through `ael evidence session <id>`; it does not parse raw Codex JSONL for `ael review session`.[^1]

## Decision

Add Codex-specific, bounded projection for observed JSONL records. The ingestion path will validate the complete JSON stream while materializing only fields allowed by the review contract. Large strings and structured output remain unreadable to reviewers after their bounded projection has been produced.

The global 64 MiB artifact limit remains. The existing 4 MiB buffered-line limit remains the fast path and remains unchanged for Cursor, Claude Code and synthetic Codex records. A Codex observed record that exceeds 4 MiB switches to the streaming projector instead of failing solely because of its line length.

The result will include aggregate ingestion coverage. Reviewers receive only normalized events. They do not receive raw skipped records, token snapshots or omitted structured output.

## Goals

- Review current Codex session artifacts without making a transformed copy.
- Accept known non-review technical envelopes without converting them into reviewer evidence.
- Preserve useful message and tool-event structure while bounding retained text.
- Make every omission and truncation visible through aggregate coverage.
- Make unknown record classes visible through bounded structured logs.
- Keep malformed input, privacy boundaries and total resource use fail-closed.

## Non-goals

- Semantic interpretation of prompts, responses or tool output by an external model.
- Improving candidate specificity, candidate persistence or lesson promotion. M6 owns those behaviors.
- Treating token usage as review text or using it to infer session quality.
- Removing the total artifact limit.
- Changing Cursor or Claude Code ingestion.
- Persisting raw prompts, raw output or an intermediate sanitized session copy.

## User-visible behavior

The existing `ael review session` command and selection rules remain unchanged. A successful text result includes a compact ingestion note when coverage is incomplete. JSON output adds an `ingestionCoverage` object:

```json
{
  "totalRecords": 392,
  "normalizedRecords": 349,
  "skippedTechnicalRecords": 43,
  "unsupportedRecords": 0,
  "truncatedTextFields": 0,
  "omittedStructuredOutputs": 1,
  "usedStreamingProjection": true
}
```

The numbers above describe the observed acceptance artifact and are not universal defaults. Coverage counts contain no source text, paths, record-type values or payload fragments.

A well-formed `token_usage_record` increments `skippedTechnicalRecords`. It produces no normalized event and no reviewer-visible text. A structured tool result produces a tool event. If its `output` is not a string, the result retains no output text and increments `omittedStructuredOutputs`.

Well-formed but unknown envelope types are skipped, counted in `unsupportedRecords` and reported through a structured warning log. They do not abort review. Malformed records still abort review with a bounded generic diagnostic.

Every unknown record emits one structured warning when the adapter encounters it. A log entry contains the code `UNSUPPORTED_CODEX_RECORD`, the classification level, a validated bounded type and the zero-based source ordinal. Text and JSON command modes write these warnings to stderr, while JSON stdout remains one valid result document. A programmatic review caller can supply a diagnostic sink that receives the same warning during ingestion.

```json
{
  "code": "UNSUPPORTED_CODEX_RECORD",
  "level": "envelope",
  "recordType": "new_record_type",
  "sourceOrdinal": 217
}
```

## Architecture and boundaries

### JSONL framing

Refactor bounded JSONL framing so a source adapter can select one of two per-record paths:

- buffer a record up to the existing 4 MiB line limit and parse it with the existing validator;
- after the buffered prefix crosses 4 MiB, transfer that prefix to a Codex observed-record projector and stream the remainder of the record into it.

The framing layer continues to enforce the 64 MiB artifact limit, LF and CRLF boundaries and complete-record termination. It does not interpret source fields.

### Codex streaming projector

Implement a repository-owned, single-pass JSON tokenizer for oversized Codex observed records. It validates strings, escapes, literals, arrays, objects and nesting while retaining only these paths:

- `timestamp`;
- top-level `type`;
- `payload.type`;
- `payload.name` for tool calls;
- bounded text from supported message and tool-input fields.

Other values are consumed without materialization. Retained keys, scalar values, nesting depth and reviewer-visible text use explicit limits. Invalid UTF-8, invalid JSON, excessive nesting, invalid required fields or an unfinished record fail with the existing generic review error and do not expose input.

The projector produces the same internal record shape as the normal buffered parser. Downstream sanitization and reviewers cannot tell which parsing path supplied the record.

### Envelope classification

Replace the single envelope allowlist with an explicit disposition table:

| Envelope class | Disposition |
|---|---|
| `session_meta`, `turn_context`, `compacted`, `inter_agent_communication_metadata`, `world_state` | Normalize as metadata under current behavior |
| `event_msg` | Normalize supported user and agent messages |
| `response_item` | Normalize supported messages and tool records |
| `token_usage_record` | Skip as known technical data and count |
| Unknown, well-formed envelope | Skip and count as unsupported |
| Malformed envelope or malformed required payload | Reject without source-value disclosure |

Known response-item subtypes retain their current meaning. Unknown, well-formed response-item subtypes are omitted and counted as unsupported rather than terminating the entire session. A malformed supported subtype remains a hard failure.

### Coverage contract

Add an immutable `SessionIngestionCoverage` value to `NormalizedSession`, `SanitizedReviewArtifact` and `ManualReviewResult`. The sanitizer copies only aggregate counters and a boolean streaming flag. It cannot copy record names, payload values or filesystem locations into coverage.

Coverage is derived during one read and is not persisted as a transcript. Counter addition is checked for safe integers. The following invariant must hold:

```text
totalRecords = normalizedRecords + skippedTechnicalRecords + unsupportedRecords
```

Text truncation and structured-output omission are properties of normalized records, so their counters do not participate in that partition.

### Unknown-record diagnostics

Add an immutable `SessionIngestionDiagnostic` value and a `SessionIngestionDiagnosticSink` callback. The adapter invokes the sink exactly once for every unknown envelope or response-item subtype, in source order. The CLI supplies a sink that writes one bounded line to stderr. Programmatic callers may supply their own sink; omission selects a no-op sink. Diagnostics are not accumulated in `NormalizedSession` or `ManualReviewResult`.

An exposed type must match `[A-Za-z0-9_.:/-]{1,128}`. A well-formed record with a type outside that display-safe grammar is logged as `unprintable` and counted without copying the value. `sourceOrdinal` identifies the record's position without exposing its byte offset or contents. No diagnostic contains payload fields, timestamps, session identifiers, artifact paths or reviewer-visible text.

Diagnostic writes honor stream backpressure before ingestion continues. There is no grouping, sampling or suppression. The 64 MiB artifact limit remains the outer bound on how many warnings one selected artifact can generate, while every individual warning has a fixed schema and bounded fields.

## Error handling

Review succeeds when omitted data is not required to form a safe normalized event. It reports incomplete coverage rather than presenting the analysis as complete.

Review fails when:

- the artifact exceeds 64 MiB;
- JSON syntax, UTF-8 or nesting is invalid;
- a supported envelope lacks its required timestamp, payload or safe tool name;
- retained counter or text budgets cannot be represented safely;
- the input contains no supported normalized event after classification.

All CLI failures retain the generic `REVIEW_ERROR` boundary. Error messages, diagnostics and tests must not echo source lines, paths, prompts, tool arguments or outputs. Successful reviews emit the bounded unknown-record warnings defined above.

## Privacy and security

Streaming projection is an ingestion boundary, not permission to retain more source data. The implementation must not create a normalized copy beside the source artifact or in a temporary directory. Omitted bytes are consumed and discarded.

Logging an unknown record means logging its safe classification and source ordinal, not its serialized representation. Tests must treat unknown-record payloads as secret-bearing input and prove that unique markers do not reach stdout, stderr, structured results or persisted data.

Token snapshots are not reviewer evidence. Structured tool output is retained only when it is already a bounded string accepted by the existing contract. Arrays and objects are omitted in full, even when individual leaves contain strings. This prevents accidental flattening of credentials, environment data or large command results.

Existing repository-scope and symlink checks remain unchanged. The selected local source file remains the only artifact read.

## Compatibility

The public command syntax does not change. Existing valid artifacts produce the same normalized events and review findings. New `ingestionCoverage` data is additive in programmatic and JSON results.

The M3.3 4 MiB line limit remains the default cross-source contract. M5.1 adds a narrow Codex observed-record projection path rather than raising that limit for every source.[^2]

Synthetic Codex fixtures retain their hard 4 MiB line limit. This prevents the testing input format from becoming an undocumented large-record compatibility surface.

## Rejected approaches

Raising the line limit to 8 or 16 MiB was rejected because it moves the failure threshold without addressing future large tool outputs. It would also require materializing the complete line before discarding most of it.

Creating a preprocessing command was rejected because it duplicates adapter rules, creates another sensitive artifact and makes omissions invisible to the canonical review result.

Using M5 stored-evidence reconstruction was rejected as a substitute because it intentionally excludes prompts and unrestricted output and requires captured normalized records. It cannot represent a manually selected raw Codex transcript after the fact.[^1]

## Acceptance criteria

- M5.1-A1: the unchanged local artifact for session `01a07b11-0435-7a83-b162-f1770c90b072` completes `ael review session` without a preprocessed copy; verification records only bounded structural counts.
- M5.1-A2: a generated fixture containing 43 valid `token_usage_record` envelopes completes review, exposes `skippedTechnicalRecords: 43` and exposes none of their payload values to reviewers.
- M5.1-A3: a generated Codex observed fixture containing a `custom_tool_call_output` line of at least 6,953,534 bytes completes review under the 64 MiB artifact limit, creates a tool event without output text and reports one omitted structured output.
- M5.1-A4: buffered and streaming paths produce identical normalized events for the same supported record represented below the 4 MiB threshold.
- M5.1-A5: malformed oversized JSON, invalid UTF-8, excessive nesting and malformed supported envelopes fail without leaking a unique marker from the source.
- M5.1-A6: unknown well-formed envelopes and response-item subtypes are counted and omitted while later supported records remain reviewable. Text and JSON modes write exactly one warning per occurrence to stderr; a supplied programmatic sink receives the equivalent sequence.
- M5.1-A7: the coverage partition invariant holds for buffered, streaming, skipped and unsupported records; counter overflow fails closed.
- M5.1-A8: existing Codex, Cursor, Claude Code, sanitizer, resource-limit and reviewer tests retain their previous normalized evidence and findings.
- M5.1-A9: no test or runtime path writes a transformed session artifact, and a scan of generated diagnostics contains no prompt, argument, output, token payload or absolute source path.
- M5.1-A10: `pnpm check` passes with zero failed and zero skipped tests. A manual verification record identifies the source session by ID only and records no transcript content.
- M5.1-A11: repeated unknown records produce separate deterministic logs with their exact ordinals in source order and no grouping, sampling or suppression; unsafe type strings are represented as `unprintable`, and a unique payload marker is absent from all output channels.

## Delivery boundary

Completion of M5.1 means raw-session ingestion is robust enough to deliver bounded evidence and honest coverage to the existing reviewers. It does not mean that those reviewers produce specific or durable lessons. M6 remains the acceptance owner for evidence-backed episodes, candidate specificity and persistence.

[^1]: [M5 verification](../../verification/2026-09-06-milestone-5-session-evidence.md), [M5 design](2026-09-06-m5-session-evidence-design.md).
[^2]: [M3.3 bounded artifact design](2026-09-04-milestone-3-3-large-session-artifacts-design.md).
