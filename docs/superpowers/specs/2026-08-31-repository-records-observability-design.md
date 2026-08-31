# Repository records observability design

## Status

Approved with initialization amendments on 2026-08-31.

## Scope

This increment adds read-only CLI commands for inspecting raw captured records, aggregate statistics, local repository status, and global AEL installation status. Each command supports repository filtering. It does not add remote telemetry, filesystem-wide discovery, or retention changes.

## Decision

AEL will keep a private local registry of repositories with at least one installed and statically verified AEL hook, or that have written passive-capture data. Each entry records the canonical Git top-level path and uses that same path as the repository identifier. The registry gives `status-global` a bounded and truthful source for previously configured repositories without scanning user directories.

Existing imported records with a repository identifier but no registry entry remain visible through an explicit `--repository-id` filter. Their location is unavailable until the repository is registered by repository-scope `ael init` or a future passive capture from that repository.

## Command contract

```text
ael list records [--repository-id <id>|--repository <path>] [--json]
ael stats [--repository-id <id>|--repository <path>] [--json]
ael status [--repository-id <id>|--repository <path>] [--json]
ael status-global [--repository-id <id>|--repository <path>] [--json]
ael init [--scope global|repo] [--hooks codex,cursor] [--json]
```

For every command, `--repository <path>` resolves a canonical Git top level and its deterministic repository identifier. `--repository-id <id>` selects an already known identifier. The two options are mutually exclusive. Without either option, `list records`, `stats`, and `status` resolve the canonical Git top level of the current working directory. A non-Git directory returns a typed repository-required diagnostic.

`ael init` defaults to repository scope. `ael init --scope global` only initializes the private data store and does not prompt for, install, or verify project hooks.

`status-global` has no current-directory requirement. Without a repository filter it returns the local CLI installation, the selected database location, and every registered repository. With `--repository-id`, it returns the matching registered repository or a typed not-found diagnostic.

All commands preserve the existing `--data-dir` and `--json` behavior. Human-readable output is the default. JSON output is deterministic and contains the same facts without terminal formatting.

## Records and statistics

`list records` returns raw passive-capture sessions and their technical events, grouped by session and ordered by session start time followed by event time. The human-readable form includes repository identifier, source, session identifiers and lifecycle timestamps, event phase, normalized signature, safe summary, outcome, and exit status. It must not restore raw hook payloads, prompts, transcripts, or credential-like material.

`stats` returns, for the selected repository, counts of sessions, technical events, and knowledge entries; earliest and latest record timestamps; counts by agent source; and counts by event phase. Empty repositories return zero counts with absent date bounds.

## Repository registration and capture

Repository initialization requires one or more installed AEL hooks. In an interactive terminal, `ael init` resolves the current Git top level and presents a keyboard-operable multi-select list with `Codex` and `Cursor`. The user selects one or both hook targets and confirms the selection. AEL installs only the selected integration files and does not remove an existing unselected integration.

Outside an interactive terminal, repository initialization requires `--hooks codex`, `--hooks cursor`, or `--hooks codex,cursor`. Omitting the option is a syntax error. An empty hook selection is invalid in every mode.

Installation creates or updates the selected agent hook configuration and the shared executable wrapper. It preserves unrelated entries in existing JSON hook files and fails before mutation if that JSON cannot be safely parsed or merged. The wrapper is generated from a packaged template, invokes the effective AEL CLI entrypoint determined at initialization, resolves the Git top level, and retains the current Node-version fallback and fail-open behavior.

Repeated repository initialization merges the new selection with hook sources already recorded for that repository. It never removes an existing hook configuration or removes a source from the status requirements.

After writing files, `ael init` runs static verification for every selected hook: configuration registration, wrapper presence and executability, and reachable CLI entrypoint. It reports a typed failure and does not register the repository when any selected hook cannot be verified. A successful repository initialization writes or refreshes the registry entry. Global initialization continues to initialize only the selected local data store and cannot install project hooks.

Passive-hook ingestion resolves the repository root supplied by the project wrapper and records it on newly created sessions. The wrapper already resolves the Git top level before invoking the CLI. The capture path must remain fail-open and preserve its current bounded, generic diagnostics. A repository-resolution failure must not make a hook block or warn the agent.

## Status reporting

`status` reports the canonical repository root and identifier, the effective AEL CLI entrypoint, the selected private database path and availability, and static status for every hook source selected during repository initialization. Each hook result states whether its configuration file, shared wrapper, and generated CLI entrypoint exist. A missing or invalid selected hook makes `status` return a non-zero exit code. An unselected hook is not an error. Status inspection must not execute a hook or write an event.

`status-global` reports the same CLI and database facts once, then reports every registry entry with its canonical path, repository identifier, selected hook sources, last observed time, and static hook status. It reads only registered paths. Missing, moved, or no-longer-Git directories are reported as unavailable rather than removed from the registry. It always returns a report exit code, even when an individual repository has an unavailable required hook.

## Storage and compatibility

The schema gains a versioned repository registry table with the selected hook sources. The registry is additive and does not rewrite existing sessions or records. Query methods return repository-scoped sessions, events, and aggregates with deterministic ordering. Existing storage migrations remain valid.

## Error handling

Repository resolution errors, malformed explicit identifiers, unknown registry entries, unavailable database paths, unreadable configuration files, and invalid command options return deterministic CLI diagnostics. Status results distinguish unavailable components from a command failure when their remaining facts can still be read.

## Verification

Tests will cover the interactive multi-select flow, required non-interactive `--hooks` selection, invalid empty selection, safe configuration merge, rejection of malformed existing configuration, static post-install verification, registry creation only after verified installation or passive capture, explicit and current-directory repository selection, precedence of the explicit filter, raw-record ordering and redaction-safe formatting, aggregate counts and date bounds, empty results, static Codex and Cursor hook statuses, moved repositories, global status filtering, JSON determinism, and unchanged fail-open hook behavior.

## Out of scope

Recursive scanning of the filesystem, probing other package managers for installations, executing hooks during status checks, automatic removal of unselected hooks, remote synchronization, and changing the capture privacy model are outside this increment.
