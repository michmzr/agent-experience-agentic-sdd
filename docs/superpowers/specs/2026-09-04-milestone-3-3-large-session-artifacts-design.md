# Milestone 3.3 large session artifacts design

## Status

Approved in conversation on 2026-09-04. Written specification awaiting review.

## Scope

This increment allows manual review of Codex, Claude Code and Cursor session artifacts up to 64 MiB. It replaces complete-file parsing with incremental parsing and retains the latest bounded review evidence. It preserves the current privacy boundary, source-path protections and reviewer contracts.

This is the first of three Milestone 3.3 increments. Privacy-safe Cursor capture diagnostics and stale-session reconciliation will receive separate specifications and implementation plans after this increment.

## Goals

- Complete manual review for valid Codex, Claude Code and Cursor artifacts no larger than 64 MiB.
- Retain the latest 1,024 supported events in source order.
- Preserve stable event provenance when earlier events are not retained.
- Bound retained unsanitized text to 256 KiB while favoring the newest evidence.
- Validate every scanned record, including records outside the retained tail.
- Preserve sanitization before reviewer-visible text truncation.
- Record duration and peak-memory measurements without using them as release thresholds.

## Non-goals

- Removing the artifact-size, line-size, event-count or retained-text limits.
- Defining a maximum review duration or peak-memory acceptance threshold.
- Adding ChatGPT export ingestion.
- Changing reviewer profiles, proposal generation or debrief behavior.
- Changing passive hook capture, Cursor diagnostic categories or session lifecycle storage.
- Retaining a partial prefix or suffix of an event whose complete text cannot fit the retained-text budget.

## Selected approach

Each source adapter will read its artifact incrementally and send supported records to a shared bounded session accumulator. The accumulator will keep event metadata for the latest 1,024 supported records and a maximum of 256 KiB of complete text. Newer text has priority. When adding a new record would exceed the text budget, the accumulator will remove complete text values from the oldest retained records until the budget is satisfied. Event metadata remains retained.

The alternatives were a shared complete-file parser with a larger byte limit and a source-specific Codex streaming reader. Complete-file parsing did not provide a useful resource boundary. A Codex-only reader would leave the same size failure in Claude Code and Cursor, contrary to the accepted scope.

## Public contracts and limits

`MAX_SESSION_ARTIFACT_BYTES` will be 64 MiB for Codex, Claude Code and Cursor artifacts. A separate 4 MiB line limit will apply to JSONL records and Markdown lines. Existing `MAX_NORMALIZED_SESSION_EVENTS`, `MAX_SESSION_REVIEW_TEXT_LENGTH` and `MAX_SESSION_EVENT_TEXT_LENGTH` values remain 1,024 events, 256 KiB aggregate retained text and 4 KiB reviewer-visible text per event.

`LocalSessionRecord` will carry an optional non-negative source ordinal. Adapters that select a tail will set this ordinal from the original supported-record position. `normalizeSession` will use the source ordinal when constructing an event identifier and will use the array index only for callers that omit it. This preserves compatibility for existing direct callers.

`NormalizeSessionInput` will accept optional `startedAt` and `endedAt` boundaries. They must be supplied together as canonical timestamps, `endedAt` must not precede `startedAt`, and every retained event must fall within the supplied interval. When the boundaries are absent, `normalizeSession` retains its current first-event and last-event behavior.

The Cursor Markdown reader will become asynchronous because it will consume a file stream. Its repository callers and tests will await it. It is an internal module interface and no CLI syntax or serialized contract changes.

## Shared accumulator

The shared accumulator owns evidence selection and session boundaries. It accepts one validated `LocalSessionRecord` and its source ordinal at a time. It tracks:

- the timestamp of the first supported record in the complete artifact;
- the timestamp of the last supported record in the complete artifact;
- a ring containing the latest 1,024 supported records;
- the retained UTF-8 byte length of complete text values; and
- the next source ordinal.

When the event ring exceeds 1,024 records, the oldest record is removed. When retained text exceeds 256 KiB, complete text is removed from the oldest text-bearing retained record. This repeats until the retained text is within the limit. If one record contains more than 256 KiB of text, its text is omitted immediately and its metadata remains eligible for the event ring.

Text limits use UTF-8 byte length rather than JavaScript string length. This makes the retained limit consistent with artifact and line byte limits. The existing reviewer-visible 4 KiB truncation remains character-based for compatibility.

Finalization fails if no supported records were accepted. It returns retained records in chronological source order plus the first and last complete-artifact timestamps. `normalizeSession` uses those supplied boundaries rather than deriving the session boundaries from the retained tail.

## JSONL processing

Codex and Claude Code will share an incremental JSONL line reader. Before opening the stream, each adapter will retain its existing regular-file, symlink and root-containment checks and reject a file whose reported size exceeds 64 MiB. The reader will also count bytes consumed and reject the stream if it crosses 64 MiB, covering growth after the initial file check.

The reader will accept LF and CRLF line endings, ignore empty lines as the current adapters do, and reject a non-empty line larger than 4 MiB. Each non-empty line is parsed and passed to the existing source-specific record validator. Invalid JSON, an unsupported record kind or an invalid field remains a hard failure even when that record would fall outside the retained tail.

Codex retains the current observed and synthetic record formats. Claude Code retains the current message, metadata and tool record formats and sidecar exclusions. No additional source fields cross the adapter boundary.

## Cursor Markdown processing

Cursor will stream the verified regular Markdown export line by line. A line matching an existing `## User` or `## Assistant` heading starts a supported message record. Lines before the first supported heading are ignored. A later supported heading finalizes the preceding record.

The parser will collect a complete message only while its UTF-8 byte length remains within 256 KiB. If the message crosses that value, its buffered text is discarded and the remaining lines are scanned without retaining message content until the next supported heading. The message metadata is still submitted to the accumulator. This avoids retaining a partial unsanitized message.

The supplied Cursor occurrence time continues to apply to every exported message because the Markdown export has no per-message timestamp. Source ordinals follow supported heading order. A file with no supported message heading remains invalid.

## Sanitization boundary

Adapters continue to return a `NormalizedSession`. They exclude raw payload fields and text that the accumulator omitted. They do not redact or partially truncate retained text.

`sanitizeForReview` continues to validate and sanitize every complete retained text value. Only after sanitization may it truncate reviewer-visible event text to 4 KiB. The sanitized artifact remains the only input accepted by review runtimes.

No discarded text is copied into diagnostics, metrics, event metadata or identifiers.

## Error handling

The adapters fail closed for:

- artifacts larger than 64 MiB before or during reading;
- non-empty JSONL or Markdown lines larger than 4 MiB;
- malformed JSONL;
- unsupported or invalid source records;
- invalid timestamps;
- artifacts without a supported record or heading;
- symlinked files, symlinked roots and paths outside the configured root; and
- file read and stream failures.

Errors remain bounded and generic. They identify the failed contract but do not include a source path, line contents, command, prompt, credential or raw session value. Streams and file handles are closed on success and failure.

## Data flow

For Codex and Claude Code, the adapter verifies the artifact, streams JSONL lines, validates each source record, adds it to the accumulator, finalizes the retained tail, normalizes the session and passes it to the existing sanitizer and review pipeline.

For Cursor, the adapter verifies the artifact, streams Markdown lines, finalizes each supported message at the next heading or end of file, adds it to the accumulator, finalizes the retained tail, normalizes the session and passes it to the same sanitizer and review pipeline.

The source adapter remains responsible for source syntax and allowlisted fields. The accumulator is responsible only for source-independent ordering, evidence retention and session boundary tracking. The sanitizer remains responsible only for redaction, residual scanning and reviewer-visible truncation.

## Verification

Unit tests will prove accumulator behavior at the event and UTF-8 text boundaries, including stable ordinals, newest-first text retention, metadata preservation and complete text omission.

Adapter tests will cover:

- valid large artifacts for Codex, Claude Code and Cursor;
- the 64 MiB boundary and a file one byte over it;
- the 4 MiB line boundary and a line one byte over it;
- retention of the latest 1,024 supported records;
- complete-artifact first and last timestamps;
- malformed or unsupported early records outside the retained tail;
- LF and CRLF handling;
- read failures and stream closure;
- unchanged symlink and root-containment checks; and
- unchanged exclusion of non-allowlisted payload fields.

Privacy tests will place credential markers and paths in retained, omitted and rejected input. They will prove that retained values are sanitized, omitted values do not cross the adapter boundary, and diagnostics expose none of them.

An end-to-end manual-review test will use a deterministic 7.97 MiB fixture for each source and assert successful review, no more than 1,024 sanitized events and no more than 256 KiB of retained pre-truncation text.

A benchmark will record source, artifact byte size, scanned supported-record count, retained event count, retained text bytes, wall-clock duration and peak resident memory. Duration and memory are observations only. They cannot fail the Milestone 3.3 gate until representative real-session data establishes thresholds.

## Acceptance criteria

- Manual review completes for valid 7.97 MiB Codex, Claude Code and Cursor artifacts.
- All three adapters accept valid artifacts at 64 MiB and reject larger artifacts with a generic resource-limit error.
- All three adapters retain the latest 1,024 supported events and preserve original source ordinals in event identifiers.
- Session start and end timestamps reflect the complete scanned artifact rather than only the retained tail.
- Retained complete text does not exceed 256 KiB and favors the newest retained events.
- Text that cannot fit the budget is omitted completely while its event metadata remains available.
- Every scanned source record is validated before review, including discarded earlier records.
- Retained text is sanitized before reviewer-visible truncation.
- Existing path, symlink, privacy, reviewer and CLI behavior remains compatible except for the internal asynchronous Cursor reader.
- The full test suite passes with zero failures and zero skipped tests.

## Deferred increments

The next Milestone 3.3 specification will distinguish unsupported Cursor tools, invalid working directories, unsafe command shapes and host delivery failures using privacy-safe categories and counts. A later specification will add explicit incomplete-session state plus deterministic stale-session detection and reconciliation without rewriting historical events.
