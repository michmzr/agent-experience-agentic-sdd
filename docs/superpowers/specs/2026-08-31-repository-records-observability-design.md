# Repository records observability design

## Status

Approved on 2026-08-31.

## Scope

This increment adds read-only CLI commands for inspecting raw captured records, aggregate statistics, local repository status, and global AEL installation status. Each command supports repository filtering. It does not add remote telemetry, filesystem-wide discovery, or retention changes.

## Decision

AEL will keep a private local registry of repositories that have been initialized for repository scope or have written passive-capture data. Each entry records the canonical Git top-level path and uses that same path as the repository identifier. The registry gives `status-global` a bounded and truthful source for previously configured repositories without scanning user directories.

Existing imported records with a repository identifier but no registry entry remain visible through an explicit `--repository-id` filter. Their location is unavailable until the repository is registered by `ael init --scope repo` or a future passive capture from that repository.

## Command contract

```text
ael list records [--repository-id <id>] [--json]
ael stats [--repository-id <id>] [--json]
ael status [--repository-id <id>] [--json]
ael status-global [--repository-id <id>] [--json]
```

For `list records`, `stats`, and `status`, an explicit `--repository-id` has precedence. Without it, the command resolves the canonical Git top level of the current working directory and uses that path as the repository identifier. A non-Git working directory without an explicit identifier returns a typed repository-required diagnostic.

`status-global` has no current-directory requirement. Without a repository filter it returns the local CLI installation, the selected database location, and every registered repository. With `--repository-id`, it returns the matching registered repository or a typed not-found diagnostic.

All commands preserve the existing `--data-dir` and `--json` behavior. Human-readable output is the default. JSON output is deterministic and contains the same facts without terminal formatting.

## Records and statistics

`list records` returns raw passive-capture sessions and their technical events, grouped by session and ordered by session start time followed by event time. The human-readable form includes repository identifier, source, session identifiers and lifecycle timestamps, event phase, normalized signature, safe summary, outcome, and exit status. It must not restore raw hook payloads, prompts, transcripts, or credential-like material.

`stats` returns, for the selected repository, counts of sessions, technical events, and knowledge entries; earliest and latest record timestamps; counts by agent source; and counts by event phase. Empty repositories return zero counts with absent date bounds.

## Repository registration and capture

`ael init --scope repo` resolves the current Git top level and writes or refreshes its registry entry. A global initialization continues to initialize only the selected local data store.

Passive-hook ingestion resolves the repository root supplied by the project wrapper and records it on newly created sessions. The wrapper already resolves the Git top level before invoking the CLI. The capture path must remain fail-open and preserve its current bounded, generic diagnostics. A repository-resolution failure must not make a hook block or warn the agent.

## Status reporting

`status` reports the canonical repository root and identifier, the effective AEL CLI entrypoint, the selected private database path and availability, and static status for Codex and Cursor hook configuration. Each hook result states whether its configuration file, shared wrapper, and built project CLI exist. Status inspection must not execute a hook or write an event.

`status-global` reports the same CLI and database facts once, then reports every registry entry with its canonical path, repository identifier, last observed time, and static Codex and Cursor hook status. It reads only registered paths. Missing, moved, or no-longer-Git directories are reported as unavailable rather than removed from the registry.

## Storage and compatibility

The schema gains a versioned repository registry table. The registry is additive and does not rewrite existing sessions or records. Query methods return repository-scoped sessions, events, and aggregates with deterministic ordering. Existing storage migrations remain valid.

## Error handling

Repository resolution errors, malformed explicit identifiers, unknown registry entries, unavailable database paths, unreadable configuration files, and invalid command options return deterministic CLI diagnostics. Status results distinguish unavailable components from a command failure when their remaining facts can still be read.

## Verification

Tests will cover explicit and current-directory repository selection, precedence of the explicit filter, registry creation by repository initialization and passive capture, raw-record ordering and redaction-safe formatting, aggregate counts and date bounds, empty results, static Codex and Cursor hook statuses, moved repositories, global status filtering, JSON determinism, and unchanged fail-open hook behavior.

## Out of scope

Recursive scanning of the filesystem, probing other package managers for installations, executing hooks during status checks, remote synchronization, and changing the capture privacy model are outside this increment.
