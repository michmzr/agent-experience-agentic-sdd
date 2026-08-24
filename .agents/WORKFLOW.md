# Default agent workflow

## 1. Understand

Read project instructions, the relevant specification and existing durable knowledge. Determine whether the work is exploratory, bounded or architectural.

## 2. Check prior experience

Before a non-trivial plan or action, inspect relevant lessons, workflows, architecture facts, conventions and active disputes.

## 3. Plan under SDD

For changes that alter behavior, architecture, developer workflow, tooling or skills, require an approved specification before implementation planning.

## 4. Execute scientifically

For failures: reproduce, inspect evidence, identify root cause, state one hypothesis, run the smallest useful experiment, then fix the verified cause.

## 5. Verify

Use fresh verification evidence. A successful tool call is not sufficient if the change requires tests, build, lint, benchmark or review.

## 6. Learn

Capture reusable positive and negative experience with context. Do not directly create durable rules from raw events.

## 7. Review when requested

Deep session review is manual. The user must provide the source tool: `codex`, `claude-code` or `cursor`.

## 8. Improve the system

Repeated lessons may indicate project friction. Convert recurring evidence into an improvement proposal, then use SDD to decide whether to implement it.
