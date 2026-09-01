# Spec 002: session ingestion and review

## Status

Approved baseline.

## Goal

Normalize and manually analyze complete Codex, Claude Code and Cursor sessions while protecting sensitive data.

## Required behavior

- Source tool is mandatory.
- Session selection supports interactive repository-scoped discovery, explicit ID and latest-for-current-repository.
- Raw source remains local.
- External reviewer models receive sanitized normalized data.
- Reviewer backend is independent from source tool.
- Reviewer sets are profile-driven and extensible.
- Independent perspectives can run in parallel.
- Orchestrator consolidates common root problems rather than concatenating outputs.
- Full review details remain local; durable findings can be promoted separately.
- Expensive diagnostics require explicit enablement.
- Interactive repository-scoped review presents a console TUI after session selection when input and output are terminals and JSON output is not requested.
- The TUI derives insight cards and a bounded evidence timeline only from sanitized review data.
- Interactive JSON output and non-terminal human output remain deterministic and non-interactive.
- Every TUI exit and failure restores terminal input mode, cursor visibility, signal handlers and the previous screen.

## Acceptance

A real session can produce traceable findings, reusable lesson candidates and SDD improvement proposals without persisting raw private transcript into Git. A developer can manually select that session and inspect its sanitized findings, recommendations and linked evidence in the console without reading JSON.
