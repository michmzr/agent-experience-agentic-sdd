# Spec 005: proposal-driven improvement development

## Status

Approved baseline.

## Goal

Turn recurring agent/developer friction into controlled project improvements.

## Required behavior

- Session review can create evidence-backed proposals.
- Documentation/knowledge-only low-risk proposals may be represented as reviewable patches.
- Code, tooling, skill, workflow and architecture proposals require a specification.
- Human spec approval is mandatory before development.
- After approval, development may proceed autonomously in isolated worktree through planning, implementation and verification until ready-for-review.
- Human review is required before merge.
- Traceability from evidence to merged change is preserved.

## Acceptance

The system can explain why an improvement exists by following session -> finding -> proposal -> spec -> implementation -> verification provenance.
