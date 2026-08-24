# SDD lifecycle and gates

## Discovery

Agent/session evidence is gathered without changing project policy.

## Analysis

Reviewers produce evidence-backed findings. Similar findings may be consolidated.

## Proposal

A concrete improvement outcome is proposed.

## Specification

Behavior-changing work receives a design/specification. The spec is reviewed for scope, ambiguity, contradictions and acceptance criteria.

## Human approval

Implementation cannot begin before explicit approval of the intended design.

## Planning

Generate the executable plan using Superpowers `writing-plans`.

## Development

Use isolated worktree when appropriate, TDD for behavior changes and systematic debugging for failures.

## Verification

Run fresh complete checks. Verify requirements coverage, not just tests.

## Review and merge

Human review remains the final governance boundary for executable changes and shared durable project knowledge.
