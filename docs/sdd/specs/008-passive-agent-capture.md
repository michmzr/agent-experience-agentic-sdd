# Spec 008: Milestone 2.5 passive agent capture

## Status

In review.

## Problem

Milestone 2 provides normalized capture adapters and private incremental storage, but it does not connect them to project-level Cursor or Codex lifecycle hooks. Technical actions therefore reach the experience layer only when another caller constructs source-specific records and invokes the TypeScript API.

The persisted session model records `startedAt` but cannot record a completed session. This leaves the lifecycle open even after a source agent reports `sessionEnd` or `SessionEnd`.

## Evidence

- Cursor and Codex adapters normalize action events into the shared `pre-action` and `post-result` contract.
- The capture service stores normalized events without allowing persistence failure to change a synchronous runtime decision.
- The `sessions` table and `Session` domain type contain a start timestamp but no end timestamp.
- Cursor project hooks expose session, shell, MCP and tool lifecycle events.[^1]
- Codex project hooks expose `PreToolUse`, `PostToolUse`, `SessionStart` and `SessionEnd` events.[^2]

## Goals

- Connect project-level Cursor and Codex hooks to passive local capture.
- Record technical tool activity without evaluating, warning about or blocking the activity.
- Record the start and end of each captured session.
- Preserve the Milestone 2 normalized-event, privacy and idempotency boundaries.
- Keep agent execution independent from capture availability.
- Support existing databases and open sessions without destructive migration.

## Non-goals

- Runtime `ALLOW`, `WARN` or `BLOCK` enforcement.
- Prompt, model-response or transcript capture.
- Raw hook-payload storage.
- Automatic lesson promotion or repository-policy changes.
- Remote collection, network transport, telemetry or external reviewer calls.
- Claude Code hook installation.
- Encryption at rest.
- Retroactive reconstruction of end timestamps for existing sessions.

## User-visible behavior

A trusted repository may enable checked-in Cursor and Codex hook configuration. The hooks invoke one passive capture ingress that reads a bounded JSON record from standard input and identifies its source and hook event through explicit CLI options or allowlisted hook metadata.

The integration records:

- session start and session end;
- shell and MCP actions before and after execution;
- other technical tool actions, including file edits, when the source exposes correlated pre-use and post-use events;
- tool name, action name, bounded safe arguments, working directory, timestamp, bounded summary, outcome and exit status when those fields are available.

The integration does not register prompt-submission hooks and does not persist prompt text, assistant output, tool output or a complete command transcript.

Every hook invocation returns a source-compatible allow or success response regardless of capture outcome. It never returns `deny`, `ask`, `BLOCK` or a non-zero status because of a capture validation, migration or persistence failure. Diagnostics are bounded and omit hook payload values.

## Architecture and boundaries

### Passive ingress

The public CLI gains a passive hook-ingress command for Cursor and Codex. It owns bounded standard-input reading, JSON parsing, source-event dispatch and privacy-safe diagnostics. Source adapters translate documented public hook fields into the existing normalized capture contract. Unknown source fields are ignored only at the raw hook boundary; the normalized persistence contract remains closed-world.

The ingress does not call the runtime gate. It supplies no enforcement response to the source agent and cannot affect permission decisions.

### Technical event capture

Pre-action and post-result records retain source event identities and correlation. The persistence path stores normalized events even when there is no runtime enforcement snapshot. A failed post-result may create the existing local observation, candidate and evidence bundle. Contradiction or override evidence requires an actual correlated runtime decision and is not fabricated by passive capture.

An uncorrelated post-result is rejected from persistence with a privacy-safe diagnostic. The hook still succeeds from the source agent's perspective.

### Session lifecycle

The `Session` domain contract gains optional `endedAt`. SQLite `sessions` gains nullable `ended_at`. A dedicated store operation closes a persisted open session without rewriting its identity, source, start time or scope fields.

Session lifecycle storage remains separate from technical capture events. A session start creates or idempotently confirms the session row. A session end closes that row.

### Project configuration

Cursor configuration lives under `.cursor/` and Codex configuration under `.codex/`. Both call the same built project CLI and select a source adapter explicitly. The checked-in configuration registers only technical and session-lifecycle events.

Project hook configuration contains no user-specific absolute paths or credentials. Codex project hooks rely on the existing trusted-project boundary.[^2]

## State and lifecycle

A session has two states:

```text
absent --session start--> open --session end--> closed
```

The following invariants apply:

- `startedAt` and `endedAt` are canonical timestamps.
- `endedAt` is optional only while the session is open.
- `endedAt` is greater than or equal to `startedAt`.
- Repeating the same start record is idempotent.
- Repeating the same end record is idempotent.
- A different end timestamp for an already closed session is a conflict.
- A session end without a persisted matching start is rejected.
- Technical events cannot precede `startedAt` or follow `endedAt`.
- Existing rows migrate as open sessions with `ended_at = NULL`.

Closed sessions are immutable. A corrected end time requires a separate future correction protocol and is outside this milestone.

## Failure behavior

Passive hooks always fail open with respect to Cursor and Codex execution.

Malformed JSON, oversized input, unknown events, credential-like material, missing correlation, invalid timestamps, database contention, migration failure and storage failure produce no source permission change. The CLI may emit a bounded generic diagnostic to standard error and records no rejected raw value.

Atomic storage behavior remains fail-closed for the data itself: an invalid lifecycle or event bundle writes nothing. A partial session, event or candidate bundle is not permitted.

## Privacy and security

Only allowlisted normalized fields enter SQLite. Arguments remain bounded by the existing structured argument classifier. When any field contains credential-like or private material, the complete event is rejected without retaining the detected value.

The integration does not persist standard-input JSON, environment variables, tool output, prompts, responses or transcript locations. It does not send captured data over a network. The database retains owner-only directory permissions and remains unencrypted at rest, consistent with Milestone 2.

Hook commands and project configuration contain no secrets. Diagnostics contain source name, event class and stable error code only.

## Compatibility and rollout

The database migration adds nullable `ended_at` without rewriting existing session records. Old databases remain readable after migration, and existing sessions remain open. Imports and adapters that omit `endedAt` remain valid.

The serialized import format accepts optional `endedAt` on sessions after its schema version is advanced according to the repository's existing compatibility policy. Older supported repository documents remain readable.

Passive project hooks are opt-in through checked-in `.cursor` and `.codex` configuration. Removing those configuration entries disables new capture without deleting existing local records.

## Acceptance criteria

- A Cursor session start followed by correlated technical pre/post events and session end produces one closed session and normalized technical records in private SQLite.
- An equivalent Codex flow produces the same normalized domain state apart from source identity.
- Shell, MCP and correlated file-edit activity is recorded when its public hook payload supplies the required normalized fields.
- No registered hook can deny, ask about, warn about or block a source action.
- Capture succeeds without a runtime snapshot or trusted repository-knowledge snapshot.
- A credential-bearing or oversized event is not stored, its sensitive value is absent from diagnostics, and the source action proceeds.
- Repeated delivery of the same source event and lifecycle timestamp is idempotent.
- A conflicting second `endedAt`, an end before start, an end without start and an event after session close write nothing.
- Migration preserves all existing session and event rows and leaves existing sessions open.
- Prompt text, assistant responses, raw tool output and raw hook payloads are absent from SQLite and CLI output.
- Focused adapter, lifecycle, migration and CLI integration tests pass for both Cursor and Codex.
- The complete offline `pnpm check` suite passes.

## Open decisions

None.

[^1]: [Cursor hooks](https://cursor.com/docs/hooks)
[^2]: [Codex hooks](https://learn.chatgpt.com/docs/hooks)
