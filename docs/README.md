# Documentation map

This directory contains the product, architecture, SDD and setup documentation for Agent Experience Layer.

## Start here

- `product/requirements.md` - what the product must do.
- `architecture/system-overview.md` - system boundaries and main components.
- `sdd/README.md` - how specifications control implementation.
- `setup/01-project-bootstrap.md` - how to connect the canonical `.agents/` guidance to Codex, Claude Code and Cursor.
- `superpowers/README.md` - how Superpowers process skills fit the project.

## Operational memory pivot

- [AEL value delivery](product/ael-value-delivery.md) - eight specifications authorized for implementation, their dependency order, execution status and requirement traceability.
- [Milestone index M4–M9](product/operational-memory-milestones.md) - original scope, order and dependencies; consult the roadmap and verification reports for delivered status.
- [Delivery roadmap](product/roadmap.md) - existing milestone history and current delivery links.
- [ADR 001](decisions/001-asynchronous-passive-observation.md) - proposed durable queue, on-demand ingestion and separate analysis boundary.

The AEL value specifications were authorized on 2026-09-30. The delivery index distinguishes implementation, acceptance and live-host qualification.

## Important rule

Implementation source exists under `src/`. Approved specifications govern implementation; documentation status alone does not establish that behavior is implemented or verified.
