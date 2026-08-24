# Project: Agent Experience Layer

## Purpose

Build a local-first experience layer for coding agents that allows Codex, Claude Code and Cursor to learn from previous work without fine-tuning model weights.

The system captures useful experience, preserves context, retrieves relevant knowledge before actions, warns or blocks known bad actions when configured, supports team-shared repository knowledge, and can manually review complete agent sessions to identify reusable lessons and project improvements.

## Product boundaries

The first product targets macOS and Linux. It is a local developer tool, distributed as a standalone TypeScript-based executable in the implementation phase. This documentation package contains no implementation code.

The system must not require a central server, Redis, Postgres, Kubernetes, a mandatory vector database, a mandatory embedding model or an always-running daemon.

Embeddings and RAG are optional. Runtime gating must work without LLM calls and without network access.

## Primary users

- Individual software engineers using multiple coding agents.
- Development teams that want lessons learned by one person to help other agents working in the same repository.
- Technical leads reviewing recurring architecture and developer-experience friction.

## Main capabilities

- Local episodic observations and reusable lessons.
- Global user memory plus repository-scoped memory.
- Team-shared knowledge versioned through Git.
- Evidence-based lifecycle: candidate, observed, confirmed, verified, disputed, superseded, rejected, expired.
- Intent and tool-call action gate with ALLOW, WARN and BLOCK decisions.
- Per-repository and per-workspace runtime profiles, including learning mode where hard blocking is disabled but evidence collection remains active.
- Manual deep session review for Codex, Claude Code and Cursor.
- Parallel specialist reviewers followed by an orchestrator.
- Proposal generation that can lead to spec-driven improvements after human approval.
- Benchmarking to measure retrieval quality, lesson precision and false blocking.

## Human gates

1. User-derived preferences and new reusable skills require explicit approval before becoming durable shared policy.
2. Improvement proposals that affect code, tooling, architecture or skills require an approved specification before implementation.
3. Final implementation changes require normal human review before merge.
