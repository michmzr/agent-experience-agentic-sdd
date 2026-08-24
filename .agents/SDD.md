# Spec-driven development rules

## Principle

Specifications define desired behavior and boundaries before implementation plans define how to build them.

## Required lifecycle

`finding -> proposal -> specification -> human approval -> implementation plan -> isolated development -> verification -> human review -> merge`

## Specification gate

A specification is required when a proposal changes any of the following:

- runtime behavior;
- persistence or knowledge lifecycle;
- public CLI behavior;
- session ingestion or privacy semantics;
- shared team knowledge rules;
- reviewer or skill behavior;
- build, test or developer workflow;
- architecture or module boundaries.

Small wording corrections in durable knowledge may use a lightweight patch proposal if behavior is unchanged.

## Approved spec requirements

Every spec must state:

- problem and evidence;
- scope and explicit non-goals;
- behavior and user-visible contract;
- data or state transitions where relevant;
- failure behavior;
- privacy and security constraints;
- acceptance criteria;
- benchmark or regression impact;
- rollout and compatibility implications.

## Implementation planning

Implementation plans are generated only after spec approval. Use Superpowers `writing-plans` for executable task decomposition. Plans should be independently testable, TDD-oriented and small enough for fresh review gates.

## Change traceability

Every durable project improvement should preserve the chain:

`session/evidence -> finding -> proposal -> spec -> plan -> implementation -> verification`
