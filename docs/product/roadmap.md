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

## Milestone 3: richer optimization

Deliverables:

- complete project skill set;
- architecture/DX/PM improvement review;
- optional embeddings/RAG;
- additional reviewer runtimes;
- expanded benchmarks and tuning.

## Sequencing principle

Each milestone must produce independently useful behavior. Do not postpone validation until all subsystems exist.
