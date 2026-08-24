# Manual deep session review

## Trigger

Deep review is always explicitly started by a user or agent workflow. It is not automatically run after every coding session.

The source tool is mandatory: `codex`, `claude-code` or `cursor`.

## Inputs

Review may inspect available session artifacts including prompts, responses, tool calls, shell commands, temporary scripts, temporary files, edits, build/test results, retries, review feedback, git changes and timing metadata when available.

Raw session material stays local. Reviewers receive sanitized normalized session data.

## Parallel reviewer perspectives

Default profile:

- prompt effectiveness;
- tools and workflow;
- failures and learning;
- temporary artifacts;
- code/change behavior;
- architecture;
- developer experience;
- project management.

Review profiles may add or remove perspectives. Custom reviewers are allowed.

## Reviewer permissions

Reviewers may inspect repository state read-only. Diagnostic checks may run in isolation. Expensive build or test operations require explicit permission such as an `allow-expensive-checks` mode.

## Orchestrator responsibilities

The orchestrator should reconcile evidence across reviewers and look for shared root problems. It must not simply concatenate reports.

Outputs are separated into:

- findings;
- candidate lessons;
- shared-knowledge candidates;
- skill/workflow candidates;
- architecture/DX/PM improvement proposals;
- unresolved disagreements.

## Proposal behavior

Review may prepare auditable change proposals. It may automatically prepare durable knowledge changes allowed by policy, but executable behavior changes move through the SDD approval lifecycle.
