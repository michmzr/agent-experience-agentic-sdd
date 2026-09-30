# Documentation map

This directory contains the product, architecture, SDD and setup documentation for Agent Experience Layer.

## Start here

- `product/requirements.md` - what the product must do.
- `architecture/system-overview.md` - system boundaries and main components.
- `sdd/README.md` - how specifications control implementation.
- `setup/01-project-bootstrap.md` - how to connect the canonical `.agents/` guidance to Codex, Claude Code and Cursor.
- `superpowers/README.md` - how Superpowers process skills fit the project.

## Operational memory pivot

- [AEL value delivery](product/ael-value-delivery.md) - audit-based Draft specifications, proposed execution plans, dependencies and requirement traceability dated 2026-09-29.
- [Milestone index M4–M9](product/operational-memory-milestones.md) - original scope, order and dependencies; consult the roadmap and verification reports for delivered status.
- [Delivery roadmap](product/roadmap.md) - existing milestone history and the proposed next deliveries.
- [ADR 001](decisions/001-asynchronous-passive-observation.md) - proposed durable queue, on-demand ingestion and separate analysis boundary.

The 2026-09-29 specifications are drafts. Their presence does not approve implementation or replace existing approved specifications.

## Important rule

Implementation source exists under `src/`. Approved specifications govern implementation; documentation status alone does not establish that behavior is implemented or verified.
