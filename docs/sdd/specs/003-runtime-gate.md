# Spec 003: runtime gate

## Status

Approved baseline.

## Goal

Prevent repeated known mistakes while keeping normal development responsive and resilient.

## Required behavior

- Evaluate technical intent and tool actions when adapters expose them.
- Runtime path requires no LLM and no network.
- Exact and deterministic retrieval is always available.
- Embeddings/RAG are optional enrichment.
- Verified exact conflicts may BLOCK.
- Confirmed conflicts WARN.
- Disputed knowledge never BLOCKs.
- Human override is auditable and scoped.
- Learning profile downgrades BLOCK to WARN while learning remains active.
- Normal actions fail open when the experience layer is degraded.
- Protected operations may fail closed.
- Runtime uses in-memory/last-known-good fallback before heavier dependencies.

## Acceptance

Known invalid actions are prevented under normal profile, remain experimentable in learning profile and do not make ordinary development dependent on a daemon or external API.
