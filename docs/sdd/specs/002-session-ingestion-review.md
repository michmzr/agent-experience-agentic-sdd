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

## Acceptance

A real session can produce traceable findings, reusable lesson candidates and SDD improvement proposals without persisting raw private transcript into Git.
