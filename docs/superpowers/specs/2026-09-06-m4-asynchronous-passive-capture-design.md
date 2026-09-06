# M4: durable asynchronous passive capture

## Status

Approved, 2026-09-06. Depends on the existing capture implementation. Extends baseline specs 008/009 and follows [ADR 001](../../decisions/001-asynchronous-passive-observation.md). Delivery index: [operational memory milestones](../../product/operational-memory-milestones.md).

## Problem

Passive observation must preserve events without waiting for main-database ingestion or analysis. Direct persistence from the hook couples collection to storage availability; merely starting a background process does not guarantee event survival.

## Evidence

The passive service delegates technical records directly to `appendIncremental`. The user explicitly requested asynchronous preservation without agent intervention or material slowdown.[^1]

## Goals

M4-G1: accepted events survive consumer interruption. M4-G2: main-store and analysis delays do not become hook wait time. M4-G3: delivery and capture gaps remain diagnosable without agent-facing messages.

## Non-goals

Lesson analysis, advisory injection, enforcement, an always-running broker, external transport and unlimited preservation during disk failure are outside this milestone. No new source capability is assumed.

## User-visible behavior

The opt-in passive integration validates and sanitizes an eligible event, attempts bounded durable local admission and returns the source-compatible continuation response. It never emits ask, WARN, BLOCK or advice. Status inspection distinguishes admitted, pending, committed, quarantined and failed-admission counts where actually observable; hook exit success alone never increments durable-admission counts.

Main-store unavailability retains accepted events for later ingestion. Restarted consumers recover pending work. A stopped consumer is restarted by subsequent ingress or `ael capture drain`; without such a trigger after OS restart, records remain pending rather than being described as processed. `ael capture status` reports observable queue state and cumulative counters without exposing event payloads.

## Architecture and boundaries

Use `capture-spool.sqlite` beside the main database as a private durable spool and a bounded on-demand consumer. The spool uses WAL mode and `synchronous=FULL`. Its directory and database files are owner-only, existing paths must not be symlinks, and the default limits are 32 MiB and 50,000 pending or claimed records. Capacity is checked transactionally and admitted records are never evicted to admit newer records.

One consumer owns each record through a recoverable lease. Concurrent source deliveries remain safe. The consumer is a detached process independent of hook process lifetime, and ingress attempts to start it only after durable admission. A process-level start lock prevents one worker per event. The worker drains batches of at most 100 records, leases each claim for 30 seconds, applies exponential retry capped at 30 seconds, and exits after the queue becomes idle. Main-store writes and analysis have separate progress and failure boundaries.

Admission does only bounded local parsing, sanitization and spool persistence. No network, LLM, Git scan, main-store migration or analysis is allowed there. Raw hook input remains limited to 64 KiB. The complete hook path has a 250 ms deadline; an admission transaction that cannot commit within that deadline fails open for the acting agent and is not acknowledged as durable. The spool stores a deterministic delivery ID, schema version, normalized record, source/session/event identities, source order when available, admission time, state, attempt count, next retry time and recoverable lease. It never stores the raw hook payload.

## State and lifecycle

`eligible -> admitted -> pending/claimed -> committed -> reclaimable`.

Claims are recoverable. A crash after sink commit but before acknowledgment causes replay, not loss or duplicate effects. The spool record is reclaimed only after a confirmed sink commit; aggregate counters preserve the committed count after reclamation. Corrupt or permanently unsupported records move to bounded private quarantine without poisoning later work or being called successful. Quarantine retains only the already-sanitized normalized record and bounded error metadata. Delivery is at least once, not an exactly-once transport claim.

The consumer orders ready records by session dependency, event time, source order when available and admission sequence. A session start precedes its technical events, correlated pre-action precedes post-result, and session end follows currently available technical events. Missing dependencies remain pending and retry when new ingress or maintenance runs.

Baseline spec 008's immutable-session contract is amended narrowly: a technical event received after session closure may be added when its canonical timestamp is within the unchanged session bounds and all correlation constraints pass. Session identity, start time and end time remain immutable. An event after `endedAt` remains invalid. This permits a delayed pre-action or post-result to be committed without inventing a new session or changing source time.

## Failure behavior

Main-database contention delays the consumer, not admission. Retries use the bounded lease and backoff policy above. Queue capacity, spool contention and disk failure can prevent admission; ordinary agent work still continues within the 250 ms capture deadline. Previously admitted records are not silently evicted to make room. Diagnostic failure must not start a recursion of capture attempts. Full queues, corrupt records and admission timeouts are visible on later inspection when there is recorded evidence. Failure to start a consumer never rolls back an admitted record.

## Privacy and security

Sanitize before spool persistence; no raw transcripts, tool output, credentials or private arbitrary payloads. Queue and quarantine are private and bounded. Validate path ownership and prevent symlink substitution. The passive process never broadens agent permissions or alters independent runtime policies.

## Compatibility and rollout

Use a versioned spool contract; unsupported versions remain recoverable or quarantined. Pilot through explicit integration configuration. Disabling new admission leaves queued records available for `ael capture drain` and inspection through `ael capture status`. Do not silently discard backlog on rollback or force older consumers to read newer formats. Existing SQLite records remain intact.

## Acceptance criteria

- M4-A1: paused or locked main storage does not prevent durable admission while spool capacity is available; draining later preserves all acknowledged records.
- M4-A2: injected crashes before admission acknowledgment, after admission, after sink commit and before queue acknowledgment yield the documented durability/replay outcomes without duplicate sink records.
- M4-A3: consumer startup failure leaves pending records recoverable; later ingress/maintenance resumes them; idle workers release resources.
- M4-A4: concurrent deliveries and source ordering variations retain identities and correlate correctly at the storage boundary, including session-end before earlier events arrive.
- M4-A5: full disk/queue, permission failure and corrupt input cannot produce an AEL permission prompt or exceed the specified agent-facing deadline; failed admission is not reported as durable.
- M4-A6: secret-bearing test input is absent from spool, quarantine, diagnostics and database.
- M4-A7: benchmark hook p50/p95/p99, admission latency, burst throughput and CPU/I/O interference against capture disabled; main-store/analysis stalls remain independent. Record hardware and integration mode.

Focused capture, hook readiness and session-lifecycle suites plus `pnpm check` are required for implementation acceptance. The verification record must include p50, p95 and p99 hook and admission latency, burst throughput, CPU time and bytes written with capture disabled, with capture enabled, and with the main store locked. Every hook invocation must remain below 250 ms. The measured environment and integration mode are part of the result; no unmeasured comparative claim is permitted.

## Open decisions

None.

[^1]: [Passive service](../../../src/capture/passive-service.ts), [baseline capture specification](../../sdd/specs/008-passive-agent-capture.md).
