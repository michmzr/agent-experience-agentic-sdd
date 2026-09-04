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

Status: In progress. Evidence-backed architecture, developer-experience and project-management review, the interactive session debrief and the installable AEL agent skill are implemented. Optional semantic retrieval, additional reviewer runtimes and real-session reliability work remain deferred.

Deliverables:

- architecture/DX/PM improvement review, complete;
- interactive session debrief, complete;
- routed and installable AEL agent skill, complete;
- optional embeddings/RAG;
- additional reviewer runtimes;
- expanded benchmarks and tuning.

## Milestone 3.1: interactive session debrief

Status: Complete on 2026-09-01. The implementation plan records completion of the presentation model, terminal UI, terminal lifecycle, CLI fallback, privacy checks and release gate. Subsequent terminal-width fixes are present on `main`.

Goal: help an individual developer understand and act on a completed manual session review through a readable console TUI.

Deliverables:

- interactive debrief after repository-scoped session selection;
- insight-first layout with a compact evidence timeline;
- keyboard navigation and evidence expansion;
- responsive and monochrome terminal rendering;
- deterministic non-terminal and JSON compatibility;
- idempotent terminal restoration on every exit and failure path; and
- privacy and regression verification using injected terminal hosts.

## Milestone 3.2: installable AEL agent skill

Status: Complete on 2026-09-03. Commits `262b5a4` through `84e1869` add the routed artifact, safe lifecycle operations, public CLI commands, documentation and symlink-boundary hardening. Current release gate: 512 tests passed, 0 failed and 0 skipped.

Goal: give agents one product-specific skill for operating AEL without exposing generic workflow triggers or replacing deterministic CLI behavior with instructions.

Deliverables:

- one routed `ael` skill with focused setup, review, knowledge, runtime, diagnostics and command references;
- workspace and confirmed global install, update, status, validation and uninstall commands;
- deterministic manifest, compatibility state and managed-content ownership boundary;
- atomic publication and refusal to overwrite unmanaged, modified or symlinked destinations;
- packaged-artifact, routing, lifecycle and CLI verification.

## Milestone 3.3: real-session capture and review reliability

Status: The large-session-artifact review and Cursor capture diagnostics increments are complete on 2026-09-04. Stale-session reconciliation remains deferred. ChatGPT export ingestion remains outside the product scope.

Goal: make passive capture failures diagnosable and allow bounded analysis of representative real sessions without weakening privacy or fail-open behavior.

Observed evidence:

- Cursor persisted `sessionStart`, but passive capture intentionally ignored `Grep` and `Read` because technical capture currently supports shell, MCP and file-edit actions;
- Cursor Shell events with an empty working directory or shell metacharacters were rejected under the generic `AEL_CAPTURE_INVALID_INPUT` diagnostic;
- a Cursor `sessionEnd` delivery failed in the host, leaving an open stored session with no explicit incomplete state;
- Codex Desktop artifacts of 2.68 MiB and 7.97 MiB exceeded the previous artifact-size limit and failed before normalization;
- manual review accepts `codex`, `claude-code` and `cursor` as its complete supported source set.

Deliverables:

- bounded streaming or selective normalization for large session artifacts, with limits applied to sanitized events and retained evidence, complete;
- privacy-safe capture diagnostics for verified Git repositories and automatically selected non-Git workspaces that distinguish unsupported tools, invalid working directories, unsafe command shapes and primary persistence failures, complete;
- explicit incomplete-session state plus deterministic detection and reconciliation of stale open sessions, deferred;
- real-session fixtures and benchmarks covering large Codex artifacts, complete; interrupted Cursor lifecycle delivery remains deferred.

Acceptance gates:

- a representative 7.97 MiB Codex Desktop artifact completes manual review within documented memory, event and evidence bounds;
- supported Cursor technical actions are persisted, intentionally unsupported actions are counted by reason, and diagnostics do not claim to detect a hook or `sessionEnd` delivery that Cursor did not invoke;
- diagnostics expose categories and counts without including commands, paths, prompts, credentials or raw session values;
- the existing fail-open hook contract and manual-review sanitization boundary remain unchanged.

Out of scope:

- ChatGPT export discovery, normalization, import and review adapters.

## Release and distribution backlog

Status: Deferred. The package remains private and is currently distributed through a local `pnpm pack` tarball.

- Define `0.1.0` as the first released version and apply Semantic Versioning from that release. The package version and AEL skill manifest must use one release-version source so compatibility status cannot drift.
- Publish a tarball created from a clean checkout as an artifact of the repository release. Attach its SHA-256 checksum, supported Node.js version, and the passing `pnpm check` result.
- Keep release artifacts as the first distribution channel. Consider npm publication only after selecting the package owner and name, removing `private: true`, and defining registry credentials and provenance requirements.

## Sequencing principle

Each milestone must produce independently useful behavior. Do not postpone validation until all subsystems exist. Before planning the next milestone, reconcile this roadmap with completed plans, commits and verification records, then record the accepted scope before implementation starts.
