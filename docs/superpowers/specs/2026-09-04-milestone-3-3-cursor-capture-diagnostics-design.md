# Milestone 3.3 Cursor capture diagnostics design

## Status

Approved in conversation on 2026-09-04. Implemented and verified on 2026-09-05 at source commit `4a7215ed29e3536f86097493cd0e6140c6c4b5e6`.

## Scope

This increment makes passive Cursor capture outcomes diagnosable without adding commands, paths, prompts, credentials, session identifiers or raw hook values to diagnostic storage or reports. Existing accepted technical paths remain in the primary experience store. The increment records fixed-category aggregate counts and exposes the same scope-scoped report through `ael hooks diagnostics` and `ael experience inspect`. A scope is a verified Git repository, a local workspace directory or the fixed global fallback.

True host delivery failures remain outside this increment because AEL cannot observe a hook invocation that Cursor never makes. Missing lifecycle delivery will be inferred from stored session state in the following stale-session reconciliation increment.

## Goals

- Distinguish unsupported tools, invalid working directories, unsafe command shapes and capture persistence failures.
- Persist only category counts in a private local diagnostic store.
- Expose one canonical report through focused hook diagnostics and the broader experience inspection command.
- Keep passive hooks fail-open with their current generic stderr contract.
- Preserve existing capture and privacy behavior for supported technical actions.

## Non-goals

- Recording one diagnostic row per event.
- Recording raw hook input, source event identifiers, session identifiers, commands, arguments, paths, prompts, credentials or user identity in diagnostic storage.
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

`source` is fixed to `cursor` in this increment. `scope_kind` is `repository`, `workspace` or `global`. A repository scope uses the existing canonical repository identifier. A workspace scope uses the readable slug in `.ael/workspace.json`. `ael init` derives the initial slug from the folder name or accepts an explicit `--workspace-id`. The workspace slug is deliberately persisted and returned by diagnostics, so it may disclose a folder-name fragment; it must not include a full path or hook data. Global is a fixed sentinel used only when no directory scope is available. Direct store callers cannot submit arbitrary scope identifiers. `category` is constrained to the four declared values. `count` is a positive safe integer incremented atomically.

The schema contains no timestamps, event identifiers or free-form text. The database file uses the same owner-only permission policy as the primary store. Invalid schema state fails closed for diagnostic reads and fails open for hook execution.

Diagnostic persistence is best effort. If the diagnostic database itself cannot be opened or incremented, the hook result is unchanged and no fallback file, stderr detail or raw value is written. A `persistence-failure` count therefore represents observed and successfully recorded failures, not a proof that every persistence failure was counted.

## Workspace claim registry

Default workspace ID allocation uses a registry at `<AEL data directory>/workspace-scope-claims/`. The registry is private to that selected data directory, so two data directories allocate independently. The registry directory has mode 0700. Each claim is a regular, non-symlink file named with the candidate workspace ID, has mode 0600, and contains the lowercase 64-character SHA-256 hash of the normalized real workspace path followed by a newline. It never stores the path itself.

For a workspace without `.ael/workspace.json`, allocation first slugifies the folder name and atomically creates its claim with exclusive creation. An absent claim gives the workspace the readable slug. An existing claim with the same path hash is idempotently reused. An existing claim with a different hash causes one deterministic disambiguation attempt: the readable prefix is truncated as needed and receives `-` plus the first eight hexadecimal characters of the path hash. The complete ID remains within 64 characters. If that second claim already belongs to a different hash, initialization fails closed instead of selecting another suffix. Concurrent initializers therefore either agree on the same path hash or one follows the collision rule.

An explicit `--workspace-id` does not create or consult a default claim. The caller is responsible for choosing a unique explicit ID. A valid existing `.ael/workspace.json` is authoritative and bypasses registry allocation.

A registry path that is a symlink or not a directory, a claim that is a symlink or not a regular file, and claim content outside the exact path-hash format are treated as corruption. The resolver rejects the operation without overwriting or repairing the corrupt entry. Successful access reapplies mode 0700 to the registry directory and mode 0600 to an existing claim. Hook execution converts resolver failure to its bounded fail-open result; explicit initialization and reporting return their existing bounded errors.

Moving a workspace with its configuration preserves the workspace ID. Its original claim remains bound to the old path hash and continues reserving the readable ID. Copying a workspace with its configuration intentionally copies the same identity, so both copies report the same diagnostic scope until one receives a separately managed configuration. Deleting a workspace or losing its configuration does not garbage-collect or rebind its claim. Such orphan claims remain reserved; a later default initialization at another real path follows the collision rule. Automatic claim cleanup, identity splitting after a copy and changing an existing workspace ID are outside this increment.

## Hook data flow

For a Cursor delivery, ingress resolves the scope before adaptation. It uses a verified Git top level unless `.ael/workspace.json` already exists, in which case that stable workspace scope is retained after Git initialization. Otherwise it uses the normalized real current working directory as a workspace scope. `ael init` creates `.ael/` with mode 0755 and `workspace.json` with mode 0644 on first use. The resolver validates the version and slug format and rejects malformed existing configuration without writing a replacement. The adapter classifies the hook and returns its typed result.

The resolver does not add `.ael/` or `workspace.json` to `.gitignore`. The configuration remains available for Git tracking when a workspace later becomes a repository. Its readable workspace slug is intentionally emitted by diagnostics.

`ael init` is idempotent. When valid workspace configuration already exists, it displays the configured workspace ID and exits successfully without changing it, including when `--workspace-id` is supplied.

Changing an existing workspace ID is outside this increment.

The workspace configuration has a closed version-1 object with exactly `version` and `workspaceId`; unknown fields are rejected in this increment. `workspaceId` is a slug of at most 64 characters containing only lowercase ASCII letters, digits and single hyphens, without leading or trailing hyphens.

An accepted record follows the existing passive-capture path. `ExperienceStore` wraps every database-open or schema-migration exception from its constructor in `ExperienceStoreInitializationError`, tagged with an `open` or `migration` stage. Hook ingress classifies this type directly instead of inspecting exception messages. Once a Cursor scope has resolved, either constructor stage attempts exactly one `persistence-failure` increment in the separate diagnostic store and returns the existing generic fail-open result. A later primary capture failure follows the passive capture service's single degraded path and also attempts one increment.

An unsupported or rejected technical result attempts one increment for its fixed category, then maps to the existing ignored or degraded hook behavior. Unsupported tools remain ignored. Invalid working directories and unsafe command shapes remain degraded with exit zero.

Diagnostic-store failure never changes the adapter result, primary capture result, CLI exit status, stdout or generic stderr.

## Reporting

`ael hooks diagnostics` reads aggregate counts for the scope resolved automatically from the current working directory. An explicit repository option may select another directory. Git directories resolve to their verified top level; non-Git directories resolve to their normalized real path and stable workspace marker as a workspace scope. Text output lists fixed categories in lexical order with integer counts, including zero counts. JSON output uses a versioned closed object containing source, scope kind, scope ID and category counts.

`ael experience inspect` adds the same diagnostic object to its repository inspection result. It does not implement independent aggregation or formatting logic. Both commands call one application-service query and therefore return identical counts for the same repository and data directory.

The focused command exits nonzero for invalid command syntax or unreadable diagnostic storage. An empty or absent diagnostic store returns all categories with zero counts. Passive capture remains fail-open regardless of reporting behavior.

## Privacy and security

The diagnostic write API accepts only a fixed source, a resolver-created repository, workspace or global scope, and a fixed category. It has no parameter for raw hook input, full paths or caller-provided scope IDs.

Tests will scan the diagnostic database bytes and both CLI outputs for commands, working directories, prompts, credentials, session identifiers and supplied marker values. Category names, integer counts and the configured readable workspace slug are the only hook-derived diagnostic information that may leave the ingress boundary.

Scope selection resolves symlinks before classification. Git selection uses the existing verified top-level resolver. A supplied directory without Git is a separate workspace scope rooted at its normalized real path and its stable local marker; it cannot read another directory's counts. Nested Git paths resolve to the Git top level.

## Error handling

Typed adapter classification replaces regex inspection of error messages for the declared Cursor conditions. The typed experience-store initialization boundary separately classifies primary open and migration failures. Programmer errors continue to propagate in direct adapter calls and are mapped to generic fail-open behavior at hook ingress.

Counter overflow, invalid category values, corrupt schema and malformed stored counts are rejected. Hook execution suppresses diagnostic-store failures. Reporting commands surface a bounded generic diagnostic without database paths or stored values.

## Verification

Unit tests will cover each typed classification boundary, including unsupported Cursor tools, empty and malformed working directories, shell metacharacters, excessive arguments and credential-like input.

Storage and resolver tests prove atomic increments, repository and workspace isolation, persisted basename collision disambiguation, workspace identity stability after a directory move, configuration modes, malformed-configuration rejection, global fallback scope, deterministic ordering, safe reopen behavior, overflow rejection and corrupt-schema rejection. They prove full paths, hook values and arbitrary caller-provided IDs cannot reach diagnostic database bytes, while the configured workspace slug is intentionally retained.

Ingress tests prove supported actions still persist, unsupported tools increment once and remain ignored, invalid working directories and unsafe commands increment once and remain fail-open, and primary persistence failures attempt the separate counter. A concrete malformed `schema_migrations` table exercises the migration stage. Separate regressions cover database-open failure, lock contention, invalid and private input codes, and diagnostic-store failure without changing hook behavior.

CLI tests will prove identical category counts in `hooks diagnostics` and `experience inspect`, stable text and JSON output, zero-count behavior, automatic repository and workspace selection, explicit directory selection, symlink normalization and generic reporting failures.

Privacy tests scan the diagnostic SQLite file, JSON, stdout and stderr for representative commands, full paths, prompts, credentials, session identifiers and arbitrary hook marker values. The primary experience store is separately checked for prohibited raw values while retaining the accepted normalized technical path. The configured workspace slug is an explicit diagnostic exception.

The full regression suite must pass with zero failures and zero skipped tests. The existing Milestone 2.5 passive-capture acceptance contract remains unchanged.

## Acceptance criteria

- Supported Cursor shell, MCP and file-edit actions persist as before.
- Unsupported technical tools are counted as `unsupported-tool` and remain intentionally ignored.
- Invalid working directories are counted as `invalid-working-directory` and remain fail-open.
- Unsafe or private command shapes are counted as `unsafe-command-shape` while retaining the current generic ingress code.
- Primary constructor open failures, migration failures and later capture failures each attempt exactly one best-effort `persistence-failure` count in the separate store.
- Repeated deliveries increment counts atomically without recording event identity or payload data.
- Both reporting surfaces return identical scope-scoped counts.
- The diagnostic store and outputs contain no commands, paths, prompts, credentials, session identifiers or raw hook values; the configured readable workspace slug is the declared exception.
- Hook stdout remains empty, exit status remains zero and stderr remains bounded and generic for every diagnostic condition.
- True absent hook invocations and missing session ends are not claimed as observed diagnostics.

## Deferred increment

The next specification will add explicit incomplete-session state, deterministic stale-open detection and reconciliation of missing `sessionEnd` delivery without rewriting historical evidence.
