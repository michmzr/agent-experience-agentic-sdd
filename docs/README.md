# Documentation map

This directory contains the product, architecture, SDD and setup documentation for Agent Experience Layer.

## Start here

- `product/requirements.md` - what the product must do.
- `architecture/system-overview.md` - system boundaries and main components.
- `sdd/README.md` - how specifications control implementation.
- `setup/01-project-bootstrap.md` - how to connect the canonical `.agents/` guidance to Codex, Claude Code and Cursor.
- `superpowers/README.md` - how Superpowers process skills fit the project.

## Operational memory pivot

- [Milestone index M4–M9](product/operational-memory-milestones.md) - canonical scope, order, dependencies and links to seven Draft specifications.
- [Delivery roadmap](product/roadmap.md) - existing milestone history and the proposed next deliveries.
- [ADR 001](decisions/001-asynchronous-passive-observation.md) - proposed durable queue, on-demand ingestion and separate analysis boundary.

The new specifications are drafts. Their presence does not approve implementation or replace existing baseline specifications.

## Important rule

The documentation package contains no implementation source code. Approved specifications are inputs to later implementation plans; they are not executable implementation instructions by themselves.
