# ADR 001: durable asynchronous passive observation

## Status

Proposed, 2026-09-06. Not an implementation authorization.

## Context

The user requires passive capture to preserve events while keeping database ingestion and analysis off the agent's execution path. The existing passive service writes through the experience store in its call path. Existing constraints require local operation, fail-open capture, no compulsory always-running daemon and privacy protection before persistence.[^1]

## Decision

Propose three separate stages: bounded sanitized admission to a private durable local spool; an on-demand consumer that commits events idempotently to the main store; separately budgeted analysis of committed evidence. Main-store contention or analysis failure leaves admitted events recoverable in the spool.

A source-compatible hook success is not a durability acknowledgment. Durable acknowledgment follows the documented persistence boundary. A worker launched in the background does not by itself provide durable delivery.

The on-demand consumer drains recoverable work without requiring a permanent service. New ingress or an explicit maintenance invocation retries starting a missing consumer. Following an OS restart with no subsequent invocation, records remain pending; this design does not promise spontaneous recovery without an execution trigger. An optional OS-managed service would be a separate deployment choice.

## Consequences

An additional private persistence surface needs retention, ownership, corruption handling and upgrade rules. Delivery is at least once; sink effects must be idempotent. Session finalization must handle delayed and reordered records. Admission still incurs bounded local work and cannot promise zero overhead or guaranteed preservation when storage is unavailable.

The physical spool format, fsync policy and measured admission budget are open in M4. Raw payload storage is not allowed as a shortcut. Analysis is neither an admission dependency nor an implicit permission to call external models.

## Alternatives considered

- Direct main-database writes in the hook retain the current store coupling and contention exposure.
- Memory-only delivery or fire-and-forget child processes cannot establish the required durable admission boundary.
- A mandatory network queue or permanent broker violates the product's local and deployment constraints.
- Analysis within the hook makes model/tool latency part of the agent's operation path.

## Related specifications

- [M4 asynchronous capture](../superpowers/specs/2026-09-06-m4-asynchronous-passive-capture-design.md)
- [M5 session evidence](../superpowers/specs/2026-09-06-m5-session-evidence-design.md)
- [M6 operational learning](../superpowers/specs/2026-09-06-m6-operational-learning-design.md)
- [Baseline passive capture](../sdd/specs/008-passive-agent-capture.md)

[^1]: [Current passive service](../../src/capture/passive-service.ts), [product requirements](../product/requirements.md).
