# Richer human CLI output and automatic context

## Status

Approved in conversation on 2026-09-15. The design applies to the complete public AEL CLI. Machine-readable JSON, passive capture, and internal analysis worker protocols remain compatible.

## Problem

Human-readable AEL output is currently assembled by command-specific functions in `src/cli.ts`. Most commands emit flat `key: value` lines, collections are difficult to scan, and status or error information lacks a consistent visual hierarchy. The `--json` path is deterministic, but there is no equivalent presentation contract for terminal users.

Repository and workspace discovery is inconsistent. `list records`, `stats`, and `status` can derive a Git repository from the working directory, while commands such as `analysis run`, `analysis report`, `runtime config explain`, and the knowledge commands still require explicit context flags. A configured non-Git workspace already stores its identity in `.ael/workspace.json`, but commands do not share one context-resolution policy.[^1]

## Goals

- Give all public commands a consistent, scannable human-readable presentation.
- Preserve the existing `--json` schemas, field order, exit codes, and newline behavior.
- Resolve repository IDs, repository roots, and workspace roots automatically when the current directory supplies enough evidence.
- Prompt only when a required context is still missing and the command is running in an interactive terminal.
- Keep non-interactive execution deterministic and free of prompts.
- Preserve passive-hook and internal-worker output exactly because those streams are protocol boundaries.
- Make rendering and context selection independently testable.

## Non-goals

This change does not rename `.ael/workspace.json`, introduce a second workspace file format, change stored repository identities, or add Internet-based repository discovery. It does not redesign the interactive review TUI. It does not alter service-layer result objects or the JSON API.

## Command modes

Every invocation has one of three output modes.

`json` is selected by `--json`. It never emits ANSI sequences, never prompts, and keeps the current serialized contract byte-stable except where an existing command already documents otherwise.

`human-terminal` is selected when standard output is a terminal and `--json` is absent. It uses the richer renderer and may use ANSI styling. Styling is disabled when `NO_COLOR` is present. Meaning cannot depend on color alone.

`human-plain` is used for redirected human output and direct `runCli` calls without terminal capabilities. It uses the same hierarchy and wording as terminal output without ANSI sequences or cursor control. It never prompts.

Passive capture commands and internal worker commands bypass these modes and retain their bounded protocol output.

## Human presentation contract

A dedicated presentation module owns human output. `src/cli.ts` selects a named presentation for a command result instead of inspecting arbitrary values in one generic fallback.

The renderer supports these primitives:

- a title with an optional status label;
- sections separated by one blank line;
- aligned key-value rows for scalar facts;
- compact tables for homogeneous collections;
- indented detail blocks for records, diagnostics, and evidence;
- actionable empty states;
- warnings and errors containing a stable diagnostic code and a next step when one is known.

Terminal styling may distinguish titles, labels, success, warning, failure, and muted metadata. Plain output preserves the same words and ordering. Statuses also include textual markers such as `ready`, `degraded`, and `not ready`, so redirected output remains understandable.

Column widths are derived from the rendered content and an injected terminal width. Narrow terminals fall back to stacked rows rather than truncating identifiers or paths. Data values are never interpreted as ANSI control sequences. Existing privacy constraints continue to determine which paths or content may be rendered.

Help output is grouped by command family and shows context defaults. The concise top-level usage line remains available at the start of help output, followed by grouped commands and common options.

## Context model

One resolver returns a validated `CliContext` containing any available workspace root, workspace ID, repository root, and repository ID. Resolution follows a fixed precedence:

1. An explicit command option wins for the field it supplies.
2. Starting at the working directory, AEL searches ancestors for the nearest valid `.ael/workspace.json`.
3. If no configured workspace supplies the requested field, AEL resolves the current Git top-level directory and its existing stable repository ID.
4. If required context remains absent, interactive human execution prompts for it.
5. JSON and non-interactive execution return `CONTEXT_REQUIRED` with the missing option and do not prompt.

The nearest configured workspace is authoritative even when it is inside a Git checkout. A workspace configuration supplies its root and workspace ID. For commands requiring a repository-scoped storage identity, that workspace ID is used in the same way it is during workspace hook initialization. For commands requiring a filesystem path, the configured workspace root is used.

Ancestor discovery validates directory and file types, rejects symbolic-link workspace metadata using the current safety rules, and reports malformed configuration rather than silently falling through to Git. Search ends at the filesystem root. Explicit paths are canonicalized before use.

## Command integration

Commands declare their context need instead of implementing local fallback logic. Supported needs are `none`, `repository-id`, `repository-root`, and `workspace-root`. A command may request more than one field, as in runtime refresh operations.

Repository-observability commands retain their existing explicit `--repository-id` and `--repository` forms. Analysis commands and unregister can use the resolved repository identity when the relevant option is omitted. Lessons and retrieval use it only when `--scope repo` is selected without `--repository-id`. Runtime configuration explanation defaults `--workspace` to the resolved workspace or repository root. Knowledge validation and promotion default `--repository` to that root. Knowledge runtime refresh defaults both the repository path and repository ID when both can be derived.

Explicit options remain available for scripts and cross-repository inspection. Automatic resolution never overwrites an explicitly supplied value.

## Interaction model

`runCli` remains synchronous and deterministic. It performs automatic filesystem and Git resolution but never prompts. This preserves its use in tests and embedded callers.

`runCliAsync` owns optional prompting before dispatch. The process entrypoint already uses this asynchronous path. An injected terminal prompt interface makes prompt behavior testable without reading real standard input.

When one value is missing, the prompt requests a repository or workspace path and displays the current directory as context. The answer is canonicalized and resolved through the same validator as automatic discovery. Empty, missing, or invalid answers do not trigger an unbounded retry loop. Cancellation returns exit code 130. A prompt is never opened for `--json`, redirected input/output, passive hooks, internal workers, or commands whose operation may mutate global state.

## Errors and diagnostics

Syntax errors keep exit code 2. Operational errors keep exit code 1 unless an existing command defines a different code. JSON errors keep their current `{ "error": { "code", "message" } }` envelope.

Human errors are rendered as a short block containing `Error`, `Code`, and, when the code has a deterministic remedy, `Next step`. Error messages must not expose paths that existing privacy boundaries hide. Invalid `.ael/workspace.json` is reported as configuration failure and is not treated as absent context.

## Architecture

The implementation introduces three boundaries.

The context resolver reads workspace configuration and Git facts and returns a validated immutable model. Existing repository and diagnostic-scope functions remain the source of identity algorithms; shared discovery logic is extracted rather than duplicated.

The command descriptor maps a parsed command form to its context requirements and human presentation. This keeps command-specific policy visible without putting formatting logic back into the dispatcher.

The human renderer converts typed presentation models into plain or ANSI-decorated text. It has no filesystem, Git, database, or process dependencies. JSON serialization continues to operate directly on service results.

The initial implementation may keep descriptors close to `src/cli.ts` if extracting them would create an abstraction with only one consumer. Renderers and context resolution remain separate modules because both have independent contracts and tests.

## Compatibility

`--json` is the machine interface and is covered by byte-level regression tests. Human output is intentionally changed and becomes a documented presentation contract, but no human wording is treated as a parseable API. Existing flags continue to work.

No new runtime dependency is required. ANSI sequences are small constants emitted by the renderer, which avoids adding a formatting package for the limited styling surface.

Workspace configuration continues to use `.ael/workspace.json` with version 1. Existing files require no migration.

## Verification

Development follows a red-green-refactor cycle. Focused tests first demonstrate the missing behavior against the current implementation.

Renderer tests cover plain and colored output, status text independent of color, narrow-width fallback, tables, empty states, escaped control sequences, and error blocks. Context tests cover explicit precedence, nearest workspace discovery from a nested directory, Git fallback, workspace precedence over Git, malformed configuration, canonical paths, non-interactive failure, interactive prompting, cancellation, and absence of prompts under `--json`.

CLI integration tests cover representative commands from observability, analysis, runtime, knowledge, skill management, review fallback, and help. Existing JSON contract tests are retained and expanded for commands that gain defaults. Passive capture and internal worker tests assert byte-for-byte unchanged output.

Each implementation slice runs its focused tests and the TypeScript build. The final acceptance path is `pnpm check`, followed by direct terminal smoke tests for help, status, analysis status, and one context-requiring command from a nested directory.

[^1]: Current workspace configuration and repository resolution are implemented in `src/capture/diagnostic-scope.ts` and `src/repository/local-repository.ts`; command-specific requirements are in `src/cli.ts`.
