# Implementation plan handoff template

Use only after the corresponding specification is approved.

## Inputs

- Approved specification path.
- Relevant ADRs.
- Applicable benchmark cases.
- Project-wide constraints from `.agents/`.

## Required process

Use Superpowers `writing-plans` to create a task-by-task plan. The generated plan should identify exact files only after repository inspection, use TDD, define verification evidence and keep each task independently reviewable.

## Handoff gates

- Spec approved before planning.
- Plan reviewed before execution when risk is medium/high.
- Implementation isolated in a worktree where appropriate.
- Fresh verification before ready-for-review.

This template intentionally contains no implementation tasks because repository code does not exist in this documentation package.
