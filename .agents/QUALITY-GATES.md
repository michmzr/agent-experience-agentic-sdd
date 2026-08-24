# Quality gates

## Evidence over confidence

The project does not use model-generated numeric confidence as a source of truth. Decisions are based on lifecycle state, evidence and match type.

## Knowledge gate

A durable lesson must have:

- a reusable scope;
- enough context to know when it applies;
- concrete evidence;
- no unresolved contradiction that would make it unsafe;
- a lifecycle state consistent with its enforcement level.

## Runtime gate

Default policy:

- verified + exact match: BLOCK unless learning mode disables blocking;
- verified + strong contextual match: WARN, or BLOCK only when the policy explicitly allows it;
- confirmed: WARN;
- observed: context only;
- disputed: context only;
- superseded/rejected/expired: ignore for enforcement.

## Session review gate

A deep review must:

- use a declared source tool;
- analyze sanitized data only through external reviewer models;
- keep reviewer scopes independent where possible;
- distinguish session evidence from repo verification;
- separate findings, lessons and improvement proposals;
- record disagreements between reviewers rather than hiding them.

## Proposal gate

A proposal affecting executable behavior must not move to development until its specification is approved.

## Completion gate

Before marking any implementation ready for review, obtain fresh evidence for all applicable checks: tests, build, lint/static checks, benchmark cases and requirements coverage.
