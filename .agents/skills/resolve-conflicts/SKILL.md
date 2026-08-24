---
name: resolve-conflicts
description: Use when two knowledge entries, policies, or new evidence disagree about the same action, workflow, project fact, or architectural rule.
---

# Resolve Conflicts

## Core principle

Conflicting knowledge is a state to investigate, not a reason to arbitrarily choose the newest statement.

## Workflow

Compare scope, applicability context, lifecycle state, evidence and repository state. Prefer more specific valid context over a broader rule when both can coexist. If both claims target the same context and conflict materially, mark the relevant knowledge disputed and trigger revalidation.

## Enforcement

A disputed entry cannot hard-block. Preserve both evidence chains until the conflict is resolved.
