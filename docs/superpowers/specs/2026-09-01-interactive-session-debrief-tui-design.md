# Interactive session debrief TUI design

## Status

Approved by the user on 2026-09-01.

## Goal

Give an individual developer a readable post-session debrief in the console after a manually selected review. The debrief must make the most actionable finding understandable without requiring the developer to inspect JSON or raw session records.

## Scope

This increment adds an interactive terminal presentation to the existing repository-scoped session review flow. It does not change session discovery, normalization, sanitization, reviewer execution, finding consolidation, candidate generation, or proposal generation.

The TUI starts only after `ael review session --interactive` selects and confirms a session. Review remains manually initiated. Automatic end-of-session analysis, HTML output, embeddings, RAG, remote reviewer runtimes, mouse input, and runtime rule enforcement are outside this increment.

## User workflow

The developer runs the existing interactive review command and selects a repository-scoped session. After review completes, an interactive debrief opens in the same console when standard input and standard output are terminals and `--json` is absent.

The initial view contains:

- source, sanitizer-produced session pseudonym, duration, and action count;
- one concise review headline;
- the selected insight and its recommendation;
- a compact timeline explaining the evidence for that insight;
- counts of available strengths, improvements, conflicts, and diagnostics; and
- a key reference for navigation and exit.

Arrow keys and `j` or `k` change the selected insight. `Enter` opens its detail view. `d` toggles linked evidence inside that view. `Escape` returns from detail view and closes the debrief when already on the overview. `q` closes from either view. `Ctrl+C` restores the terminal and exits with status 130.

## Presentation decision

The accepted visual direction combines an insight card with a compact evidence timeline. The selected insight and recommended action remain the primary content. The timeline is supporting evidence, not a transcript or complete event log.

The TUI uses an alternate screen buffer, colors where supported, and responsive terminal-width rendering. It hides the cursor only while the TUI is active and restores it during cleanup. It does not require a browser. A monochrome rendering remains usable when `NO_COLOR` is set.

## Architecture

### Debrief model

A pure presentation builder converts the completed manual review and the sanitized review artifact into an immutable debrief model. The model contains only fields required for presentation:

- sanitized session metadata;
- deterministic insight identity, category, severity, statement, and recommendation;
- linked sanitized evidence events;
- review counts and privacy-safe diagnostics; and
- stable display ordering.

Project improvements with validated `evidenceEventIds` provide evidence-linked insights. The builder resolves those identifiers only against the sanitized artifact. A finding without linked evidence may appear in the insight list, but the TUI states that no event timeline is available. It must not infer or fabricate evidence.

The initial selection is the highest-severity evidence-linked project improvement. Ties are ordered by stable improvement identifier. If no project improvement exists, the first deterministically ordered legacy finding is selected. If no finding exists, the debrief presents the completed review state without inventing an improvement.

### Timeline

The timeline contains at most five entries. It starts with sanitized session start metadata, includes up to three distinct linked evidence events in chronological order, and ends with sanitized session completion metadata. When the selected insight has more linked evidence, the TUI reports the complete count and exposes the remaining sanitized entries through the evidence-detail view.

Event timestamps, tool names, outcomes, and summaries come from the sanitized normalized session. Raw transcripts, raw hook payloads, local paths, opaque private identifiers, credentials, prompts, assistant messages, and tool output never enter the debrief model.

### State and rendering

The TUI state is independent from review business logic. It contains the selected insight index, evidence expansion state, viewport dimensions, color capability, and exit state. A pure reducer handles navigation, evidence toggling, resize events, and exit actions. A pure renderer converts the debrief model and TUI state into terminal rows.

The renderer supports a normal layout and a compact layout. The compact layout is used when the terminal is narrower than 80 columns or shorter than 24 rows. Text is truncated or wrapped within the viewport. Rendering must not emit a line wider than the known terminal width.

### Terminal host

A terminal host owns raw keyboard input, resize events, alternate-screen entry, cursor visibility, frame writes, and cleanup. Process streams and signal handlers remain outside the model builder, reducer, and renderer. Tests use an injected terminal host.

The host uses the Node.js standard library and ANSI control sequences. This increment adds no terminal UI framework dependency. The interface must permit replacing the host implementation without changing the debrief model or state reducer.

## Mode selection and compatibility

The TUI runs only when all of these conditions are true:

- the request uses the existing `--interactive` session-selection mode;
- `--json` is absent; and
- both input and output provide terminal capabilities.

Interactive selection combined with `--json` continues to return the existing deterministic JSON result. Non-terminal output and explicit non-interactive session review continue to use the existing human-readable result. Existing command syntax, exit codes, reviewer profiles, expensive-check controls, and JSON field ordering remain compatible.

## Error handling

Review failures before TUI startup retain the existing privacy-safe `REVIEW_ERROR` behavior. A TUI initialization or rendering failure restores terminal state before any fallback output. The command then emits a generic `REVIEW_TUI_UNAVAILABLE` diagnostic and prints the existing non-interactive review result without ANSI formatting. A successfully rendered fallback returns exit code 0 because the manual review itself completed.

Normal exit, interrupted exit, unexpected input end, render failure, and input failure all restore raw mode, the cursor, signal handlers, and the previous screen exactly once. Cleanup errors must not expose terminal contents or session values.

## Verification

Tests will cover:

- deterministic debrief-model construction and insight ordering;
- evidence identifiers resolving only to sanitized events;
- no fabricated timeline for legacy findings without evidence;
- five-entry timeline bounds and chronological ordering;
- reducer navigation, evidence toggling, resize, exit, and empty states;
- normal, compact, monochrome, wrapped, and truncated rendering;
- terminal-width bounds for every emitted row;
- terminal cleanup after success, interruption, input failure, and render failure;
- static fallback when terminal capabilities are absent or TUI startup fails;
- unchanged interactive JSON output and non-interactive human output; and
- absence of raw transcripts, private paths, credentials, prompts, assistant messages, and tool output from frames and diagnostics.

The full offline `pnpm check` suite remains the release gate. TUI tests use injected streams and deterministic terminal dimensions. They do not require a real terminal, browser, network service, or language-model call.

## Out of scope

HTML dashboards, report persistence, report sharing, mouse navigation, automatic review at session end, semantic retrieval, new reviewer backends, reviewer-quality scoring, and changes to runtime enforcement are excluded.
