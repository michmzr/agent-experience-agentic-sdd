# Delivery roadmap

## Milestone 1: session intelligence vertical slice

Status: Complete on 2026-08-24. Final verification: 131 tests passed, 0 failed; two independent implementation reviews approved.

Goal: derive useful lessons and proposals from existing Codex, Claude Code and Cursor sessions before building full runtime enforcement.

Deliverables:

- canonical domain vocabulary and local storage model;
- source-tool session discovery and normalization;
- privacy scrubber contract;
- manual deep review;
- parallel reviewer profiles and orchestrator output;
- candidate lessons and improvement proposals;
- basic quality fixtures for session review.

## Milestone 2: runtime learning and enforcement

Status: Complete on 2026-08-25. Milestone acceptance passed at `535c3f31b4800947d0f4862d176b87ccc3308490`: 382 tests passed and 0 failed; independent specification and quality reviews approved the implementation. Real-session benchmark thresholds remain deferred until real project-session measurements exist. Their absence is not an incomplete milestone acceptance item.

Deliverables:

- automatic experience capture;
- exact and metadata retrieval;
- intent/tool action gate;
- WARN/BLOCK policies;
- learning profile;
- evidence lifecycle and contradiction handling;
- shared repository knowledge promotion;
- graceful degradation and last-known-good runtime snapshot.

## Milestone 2.5: passive agent capture

Status: Complete on 2026-08-26. Acceptance passed: 426 tests passed, 0 failed and 0 skipped; migration 11, cross-source lifecycle capture, duplicate delivery, privacy exclusion and fail-open wrapper checks passed. Verification: `docs/verification/2026-08-26-milestone-2-5-passive-agent-capture.md`.

Goal: connect Cursor and Codex project hooks to private local capture without warning about, asking about or blocking agent actions.

Deliverables:

- passive Cursor and Codex technical-action hook ingress;
- session start and immutable session end persistence;
- backward-compatible SQLite and import-schema migration;
- fail-open hook behavior with privacy-safe diagnostics;
- project-local `.cursor` and `.codex` hook configuration;
- cross-source lifecycle, privacy and integration verification.

## Milestone 3: richer optimization

Status: In progress. Evidence-backed architecture, developer-experience and project-management review is implemented. Optional semantic retrieval and additional reviewer runtimes remain deferred.

Deliverables:

- complete project skill set;
- architecture/DX/PM improvement review;
- optional embeddings/RAG;
- additional reviewer runtimes;
- expanded benchmarks and tuning.

## Milestone 3.1: interactive session debrief

Status: Approved for implementation planning on 2026-09-01.

Goal: help an individual developer understand and act on a completed manual session review through a readable console TUI.

Deliverables:

- interactive debrief after repository-scoped session selection;
- insight-first layout with a compact evidence timeline;
- keyboard navigation and evidence expansion;
- responsive and monochrome terminal rendering;
- deterministic non-terminal and JSON compatibility;
- idempotent terminal restoration on every exit and failure path; and
- privacy and regression verification using injected terminal hosts.

## Sequencing principle

Each milestone must produce independently useful behavior. Do not postpone validation until all subsystems exist.
