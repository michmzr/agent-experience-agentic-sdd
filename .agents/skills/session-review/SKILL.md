---
name: session-review
description: Use when a complete Codex, Claude Code, or Cursor coding session should be manually analyzed for reusable lessons, workflow friction, or project improvement opportunities.
---

# Session Review

## Core principle

Analyze the complete session as evidence, not as a narrative to summarize.

## Required inputs

- explicit source tool: codex, claude-code, or cursor;
- selected session;
- review profile or default profile.

## Workflow

1. Locate and normalize the selected session using the source adapter.
2. Sanitize secrets and sensitive configured values before external reviewer analysis.
3. Dispatch independent reviewer perspectives defined by the review profile.
4. Allow read-only repository verification; require explicit permission for expensive checks.
5. Have the orchestrator reconcile shared root problems and disagreements.
6. Separate outputs into findings, candidate lessons, knowledge candidates and improvement proposals.
7. Keep full review artifacts local. Promote only durable outputs through the normal knowledge/SDD lifecycle.

## Guardrails

Do not infer hidden chain-of-thought. Do not treat repeated wording as a durable rule without evidence. Do not automatically implement proposals.
