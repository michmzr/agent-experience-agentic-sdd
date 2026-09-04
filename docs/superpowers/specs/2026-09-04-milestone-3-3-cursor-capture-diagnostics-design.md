# Milestone 3.3 Cursor capture diagnostics design

## Status

Approved in conversation on 2026-09-04. Written specification awaiting review.

## Scope

This increment makes passive Cursor capture outcomes diagnosable without storing commands, paths, prompts, credentials, session identifiers or raw hook values. It records fixed-category aggregate counts and exposes the same scope-scoped report through `ael hooks diagnostics` and `ael experience inspect`. A scope is either a verified Git repository or a local workspace directory without Git.

True host delivery failures remain outside this increment because AEL cannot observe a hook invocation that Cursor never makes. Missing lifecycle delivery will be inferred from stored session state in the following stale-session reconciliation increment.

## Goals

- Distinguish unsupported tools, invalid working directories, unsafe command shapes and capture persistence failures.
- Persist only category counts in a private local diagnostic store.
- Expose one canonical report through focused hook diagnostics and the broader experience inspection command.
- Keep passive hooks fail-open with their current generic stderr contract.
- Preserve existing capture and privacy behavior for supported technical actions.

## Non-goals

- Recording one diagnostic row per event.
- Recording raw hook input, source event identifiers, session identifiers, commands, arguments, paths, prompts, credentials or user identity.
- Claiming detection of a hook that Cursor did not invoke.
- Detecting or reconciling missing `sessionEnd` deliveries.
- Adding remote telemetry, timestamps, samples or diagnostic retention policies.
- Changing Codex passive-hook classification in this increment.

## Categories

The durable category set is closed:

- `unsupported-tool`: Cursor delivered a technical hook for a tool outside shell, MCP and file-edit capture support.
- `invalid-working-directory`: the supplied working directory is absent where required, empty, malformed or outside the accepted structured path contract.
- `unsafe-command-shape`: a shell or technical input cannot be reduced to the bounded structured signature, including metacharacters, invalid argument structure, excessive values and credential-like material.
- `persistence-failure`: a valid passive record reached capture persistence but the primary experience store could not accept it.

The existing ingress result remains `INVALID_INPUT`, `PRIVATE_INPUT` or `PERSISTENCE_FAILED` as appropriate. Durable diagnostic categories do not replace the generic hook-facing codes.

## Classification contract

Cursor classification will use typed results rather than exception-message matching. The Cursor adapter returns one of:

- an accepted `PassiveCaptureRecord`;
- an ignored nontechnical hook;
- an ignored technical hook with `unsupported-tool`; or
- a rejected technical hook with `invalid-working-directory` or `unsafe-command-shape` plus the existing generic ingress code.

The technical-signature boundary will expose fixed internal reason codes. It will not attach the rejected value or an error message derived from that value. Codex may continue using its current adapter contract until a separate cross-source diagnostic increment is approved.

Unknown hook event kinds, prompt hooks and ordinary nontechnical Cursor events remain silently ignored and do not increment `unsupported-tool`.

## Diagnostic storage

A separate owner-only SQLite file named `capture-diagnostics.sqlite` will live in the configured AEL data directory. Separating it from `experience.sqlite` allows a diagnostic count to be attempted when the primary store is busy or constrained.

The store contains one aggregate row per source, scope and category:

```text
source | scope_kind | scope_id | category | count
```

`source` is fixed to `cursor` in this increment. `scope_kind` is `repository`, `workspace` or `global`. A repository scope uses the existing canonical repository identifier. A workspace scope uses a SHA-256 identifier derived inside the resolver from the normalized real path of an automatically selected non-Git directory; the path is never persisted. Global is a fixed sentinel used only when no directory scope is available. Direct store callers cannot submit arbitrary scope identifiers. `category` is constrained to the four declared values. `count` is a positive safe integer incremented atomically.

The schema contains no timestamps, event identifiers or free-form text. The database file uses the same owner-only permission policy as the primary store. Invalid schema state fails closed for diagnostic reads and fails open for hook execution.

Diagnostic persistence is best effort. If the diagnostic database itself cannot be opened or incremented, the hook result is unchanged and no fallback file, stderr detail or raw value is written. A `persistence-failure` count therefore represents observed and successfully recorded failures, not a proof that every persistence failure was counted.

## Hook data flow

For a Cursor delivery, ingress resolves the scope before adaptation. It uses a verified Git top level when present, otherwise the normalized real current working directory as a workspace scope. The adapter classifies the hook and returns its typed result.

An accepted record follows the existing passive-capture path. If primary persistence fails, ingress attempts one `persistence-failure` increment in the separate diagnostic store and returns the existing generic fail-open result.

An unsupported or rejected technical result attempts one increment for its fixed category, then maps to the existing ignored or degraded hook behavior. Unsupported tools remain ignored. Invalid working directories and unsafe command shapes remain degraded with exit zero.

Diagnostic-store failure never changes the adapter result, primary capture result, CLI exit status, stdout or generic stderr.

## Reporting

`ael hooks diagnostics` reads aggregate counts for the scope resolved automatically from the current working directory. An explicit repository option may select another directory. Git directories resolve to their verified top level; non-Git directories resolve to their normalized real path as a workspace scope. Text output lists fixed categories in lexical order with integer counts, including zero counts. JSON output uses a versioned closed object containing source, scope kind, scope ID and category counts.

`ael experience inspect` adds the same diagnostic object to its repository inspection result. It does not implement independent aggregation or formatting logic. Both commands call one application-service query and therefore return identical counts for the same repository and data directory.

The focused command exits nonzero for invalid command syntax or unreadable diagnostic storage. An empty or absent diagnostic store returns all categories with zero counts. Passive capture remains fail-open regardless of reporting behavior.

## Privacy and security

The diagnostic write API accepts only a fixed source, a resolver-created repository, workspace or global scope, and a fixed category. It has no parameter for raw hook input, paths, descriptive text or caller-provided scope IDs.

Tests will scan the diagnostic database bytes and both CLI outputs for commands, working directories, prompts, credentials, session identifiers and supplied marker values. Category names and integer counts are the only hook-derived diagnostic information that may leave the ingress boundary.

Scope selection resolves symlinks before classification. Git selection uses the existing verified top-level resolver. A supplied directory without Git is a separate workspace scope derived from its normalized real path; it cannot read another directory's counts. Nested Git paths resolve to the Git top level.

## Error handling

Typed adapter classification replaces regex inspection of error messages for the declared Cursor conditions. Programmer errors continue to propagate in direct adapter calls and are mapped to generic fail-open behavior at hook ingress.

Counter overflow, invalid category values, corrupt schema and malformed stored counts are rejected. Hook execution suppresses diagnostic-store failures. Reporting commands surface a bounded generic diagnostic without database paths or stored values.

## Verification

Unit tests will cover each typed classification boundary, including unsupported Cursor tools, empty and malformed working directories, shell metacharacters, excessive arguments and credential-like input.

Storage tests will prove atomic increments, repository and workspace isolation, global fallback scope, deterministic ordering, owner-only permissions, safe reopen behavior, overflow rejection and corrupt-schema rejection. They will prove direct caller-provided paths and arbitrary IDs cannot reach database bytes.

Ingress tests will prove supported actions still persist, unsupported tools increment once and remain ignored, invalid working directories and unsafe commands increment once and remain fail-open, primary persistence failures attempt the separate counter, and diagnostic-store failure cannot affect hook behavior.

CLI tests will prove identical category counts in `hooks diagnostics` and `experience inspect`, stable text and JSON output, zero-count behavior, automatic repository and workspace selection, explicit directory selection, symlink normalization and generic reporting failures.

Privacy tests will scan SQLite files, JSON, stdout and stderr for representative commands, paths, prompts, credentials, session identifiers and arbitrary marker values.

The full regression suite must pass with zero failures and zero skipped tests. The existing Milestone 2.5 passive-capture acceptance contract remains unchanged.

## Acceptance criteria

- Supported Cursor shell, MCP and file-edit actions persist as before.
- Unsupported technical tools are counted as `unsupported-tool` and remain intentionally ignored.
- Invalid working directories are counted as `invalid-working-directory` and remain fail-open.
- Unsafe or private command shapes are counted as `unsafe-command-shape` while retaining the current generic ingress code.
- Primary capture persistence failures attempt one best-effort `persistence-failure` count in the separate store.
- Repeated deliveries increment counts atomically without recording event identity or payload data.
- Both reporting surfaces return identical scope-scoped counts.
- The diagnostic store and outputs contain no commands, paths, prompts, credentials, session identifiers or raw hook values.
- Hook stdout remains empty, exit status remains zero and stderr remains bounded and generic for every diagnostic condition.
- True absent hook invocations and missing session ends are not claimed as observed diagnostics.

## Deferred increment

The next specification will add explicit incomplete-session state, deterministic stale-open detection and reconciliation of missing `sessionEnd` delivery without rewriting historical evidence.
