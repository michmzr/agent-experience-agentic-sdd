# Spec-driven development setup

SDD is the governance mechanism for turning session evidence into project changes without letting an agent silently convert observations into implementation.

## Lifecycle

1. Evidence is collected.
2. Reviewers produce findings.
3. Findings become improvement proposals.
4. A specification is written for behavior-changing proposals.
5. A human approves the specification.
6. Superpowers `writing-plans` creates an implementation plan.
7. Development runs in isolation using TDD and systematic debugging.
8. Verification produces evidence.
9. A human reviews the final diff before merge.

## Artifact locations

- Approved subsystem specifications: `docs/sdd/specs/`
- New change specifications: recommended `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
- Implementation plans: recommended `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`
- Architectural decisions: create ADRs using `adr-template.md` when a decision changes long-lived system boundaries.

## Operational memory delivery

The [M4–M9 milestone index](../product/operational-memory-milestones.md) organizes the 2026-09-06 Draft change specifications under `docs/superpowers/specs/`. It is the canonical replacement for the earlier working labels P0–P5. M4–M7 deliver passive observation and learning; M8 separately enables advice; M9 evaluates effectiveness using measurements collected from M4/M5 onward.

Proposed architectural decisions live in `docs/decisions/`, beginning with [ADR 001](../decisions/001-asynchronous-passive-observation.md). Draft change specifications preserve baseline spec IDs and explicitly list dependencies and amendments. Each requires approval before a matching executable plan is created under `docs/superpowers/plans/`.

## No code in this package

The included specs and templates are intentionally implementation-neutral. Code-level plans should be generated only when implementation starts and only after the relevant spec is approved.
