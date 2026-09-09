# Local experience core

`ael` records normalized agent experience locally. It uses Node.js 22.17 or later, SQLite through Node's built-in `node:sqlite` module, and no network service or language-model call.

## Installation

Install dependencies and run the verification suite:

```sh
pnpm install --frozen-lockfile
pnpm check
```

For development in this checkout, build and run the declared script:

```sh
pnpm build
pnpm run ael -- init
```

For an installed user, pack the built project and install that tarball globally:

```sh
pnpm pack
pnpm add --global ./agent-experience-layer-0.0.0.tgz
ael init
```

## AEL agent skill

The package contains one open Agent Skills artifact for agents that operate or diagnose AEL. It routes AEL setup, capture health, session review, knowledge lifecycle, runtime profiles, diagnostics, and the AEL CLI. It does not apply to generic code review, conflict resolution, or unrelated runtime work.

Install it for the current workspace or an explicit workspace:

```sh
ael skill install --scope workspace
ael skill install --scope workspace --workspace <directory>
```

Install it for the local user only after explicit confirmation:

```sh
ael skill install --scope global --yes
```

Use `ael skill status --scope workspace|global`, `ael skill validate <skill-directory>`, and `ael skill update` to inspect and refresh an installation. `ael skill uninstall` removes only a validated managed installation. Installation, update, and removal refuse directories that are modified, malformed, or not owned by AEL. `current` means the installed bundle matches the local AEL release and its documentation snapshot.

## Project hook capture

The checked-in `.cursor/hooks.json` and `.codex/hooks.json` files connect session and technical tool events to the shared passive-capture wrapper. Build the CLI before a hook can capture anything:

```sh
pnpm build
```

The wrapper invokes the installed AEL CLI with the identifier assigned during initialization. Repository scope requires a Git top level. Workspace scope supports an ordinary directory with a managed `.ael/workspace.json` identifier. Capture data stays in the local SQLite database under `AEL_DATA_DIR` when it is set, or under the platform default described below. Hook capture stores normalized session and technical event records only. It excludes prompts, assistant or tool transcripts, raw hook payloads and credential-like values.

Capture is fail-open. Accepted normalized records are committed first to the private `capture-spool.sqlite` queue, then a detached local worker transfers them to the main experience database. A missing build or failed admission writes only a generic diagnostic to standard error and exits successfully, so it cannot warn about, ask about, deny or block an agent action. Codex users must review and trust project hooks through `/hooks` after adding or changing the checked-in configuration. Remove the project hook entries to stop future capture; existing queued and committed local records remain available.

The delivery-readiness deadline defaults to 2000 milliseconds. A project may configure a value from 100 through 60000 milliseconds in `.ael/settings.json`:

```json
{"version":1,"captureDeliveryDeadlineMs":2000}
```

`ael capture status --json` reports aggregate pending, committed, quarantined, failed-admission and delayed-delivery counts. Its delayed-delivery entry includes the latest admission, deadline, detection and eventual-commit timestamps, without hook payload data. `ael capture drain` performs an explicit bounded drain.

## Commands

```text
ael init --scope global
ael init --scope repo --hooks codex|cursor|codex,cursor
ael init --scope workspace --hooks codex|cursor|codex,cursor [--workspace-id <slug>]
ael unregister --repository-id <id>
ael list records [--repository-id <id>|--repository <git-root>] [--json]
ael stats [--repository-id <id>|--repository <git-root>] [--json]
ael status [--repository-id <id>|--repository <git-root>] [--json]
ael status-global [--repository-id <id>|--repository <git-root>] [--json]
ael experience add --input record.json
ael capture drain [--json]
ael capture status [--json]
ael validate [--scope global|repo] [--json]
ael inspect <id>
ael lessons list [--scope global|repo] [--state <state>] [--tag <tag>]
ael retrieve [--scope global|repo] [--repository-id <id>] [--path <path>] [--tool <tool>] [--tag <tag>]
ael export [--scope global|repo] [--repository-id <id>] [--format json]
ael review sessions --source codex|claude-code|cursor --root <directory> [--project <claude-project>] [--json]
ael review session --source codex|claude-code|cursor --root <directory> --session <id> [--project <claude-project>] [--profile <id@version>] [--allow-expensive-checks] [--json]
ael review session --source codex|claude-code|cursor --root <directory> --interactive --repository <repository-directory> [--session latest] [--project <claude-project>] [--profile <id@version>] [--allow-expensive-checks] [--json]
ael runtime evaluate --input action.json [--profile normal|learning|observe-only] [--refresh] [--json]
ael runtime status [--json]
ael runtime config explain --workspace <path> [--remote <url>] [--json]
ael knowledge validate --repository <path> [--trusted-ref <ref>] [--json]
ael knowledge refresh-runtime --repository <path> --repository-id <id> --trusted-ref <ref> [--json]
ael knowledge promote --repository <path> --input document.json [--json]
ael skill install --scope workspace [--workspace <directory>] [--json]
ael skill install --scope global --yes [--json]
ael skill update --scope workspace [--workspace <directory>] [--json]
ael skill update --scope global --yes [--json]
ael skill status --scope workspace|global [--workspace <directory>] [--json]
ael skill validate <skill-directory> [--json]
ael skill uninstall --scope workspace [--workspace <directory>] [--json]
ael skill uninstall --scope global --yes [--json]
```

Pass `--data-dir <directory>` to every command to select a private local data directory. The default is `~/Library/Application Support/AgentExperience` on macOS and `$XDG_DATA_HOME/agent-experience` or `~/.local/share/agent-experience` on Linux. Use `--json` for deterministic structured results and diagnostics. Runtime ALLOW and WARN decisions return exit code 0. Runtime BLOCK decisions, domain failures, and storage failures return 1. Invalid command syntax returns 2.

`ael init` without an explicit scope initializes diagnostic workspace identity only. Hook installation requires either `--scope repo --hooks` at a Git top level or `--scope workspace --hooks` in an ordinary directory. A repeated initialization keeps previously required hook sources and adds the selected sources. `ael unregister` removes the selected entry from the status registry while preserving captured records. `status` returns exit code 1 if a required hook is unavailable. `status-global` lists every registered repository and workspace and always returns a report. `--repository` must name the Git top-level directory; `--repository-id` and `--repository` cannot be combined.

Explicit session IDs run without a prompt and may read an injected external artifact store. Interactive selection and `latest` require `--repository` to name a directory inside a Git repository. The command resolves its canonical Git top level and accepts only artifacts whose real paths resolve inside that same top level. The prompt exposes only session IDs and recency, then requires confirmation before reading the selected artifact. Non-Git stores and different or nested repositories cannot qualify for interactive selection.

### Interactive session debrief

Run a repository-scoped review manually:

```bash
ael review session --source codex --root <session-root> --interactive --repository <repository-path> --session latest
```

When standard input and output are terminals, the command opens a keyboard-driven debrief after session confirmation. Use Up/Down or `j`/`k` to select an insight, Enter for details, `d` for linked evidence, Escape to go back or exit, and `q` to exit. Ctrl+C restores the terminal and exits with status 130.

`--json` returns the existing JSON result and does not start the debrief. Redirected output and terminals without interactive capabilities use the existing text result. Set `NO_COLOR=1` for monochrome rendering.

## Runtime evaluation

Runtime input is a structured action or intent JSON object. Evaluation loads a validated immutable snapshot before constructing the gate. The gate itself is synchronous and reads only the in-memory snapshot. It does not read SQLite, Git, repository files, the network, or a language model. A missing snapshot is initialized for the input repository. An existing snapshot is refreshed only when `--refresh` is supplied. Corrupt or unavailable existing state follows the fallback policy instead of being overwritten automatically.

The `normal` profile permits verified authoritative exact conflicts to BLOCK. The `learning` profile downgrades a would-be BLOCK to WARN while retaining retrieval, explanations, and capture. The `observe-only` profile returns ALLOW while retaining explanations and capture. `runtime config explain` returns the source selected for every resolved profile field without returning the supplied workspace or remote URL.

`runtime status` reports health, profile ID, hard-blocking state, retrieval mode, fallback source, and circuit state. Fallback order is the current in-memory index, the current local snapshot, the last-known-good snapshot, then configured degraded policy. Ordinary degraded actions allow. Protected degraded actions block only when the effective profile configures fail-closed behavior.

Runtime overrides have rule, action, or task-session scope. Authorization and completion are separate immutable audit records. A successful override may contribute contradiction evidence for revalidation, but it does not silently delete or reverify policy.

## Shared repository knowledge

`knowledge promote` writes a branch-local review artifact. Promotion cannot assert merged activation. `knowledge validate` treats branch-local content as non-authoritative context unless `--trusted-ref` names an explicit local Git ref or commit containing the validated knowledge generation. The resolved trusted commit supplies provenance, and only its entries are authoritative.

`knowledge refresh-runtime` is the explicit bridge from repository knowledge to runtime decisions. It requires a trusted local Git ref and an exact runtime repository identifier. Active authoritative entries from that commit with a validated structured `runtimeDirective` may enforce. Active same-repository branch-local structured directives are compiled as non-authoritative context and always remain non-enforcing. Markdown prose never creates runtime rules. The target-specific snapshot is published atomically and later `runtime evaluate` invocations load it without Git, network, or language-model access.

The local Git adapter resolves commits and reads bounded NUL-delimited tree metadata containing mode, type, object ID, and path. It rejects symlinks, gitlinks, trees, non-blob objects, unexpected executable knowledge files, duplicate paths, unsafe paths, and excess entries before blob materialization. It then checks each validated object size with `git cat-file -s` and reads the blob within the supplied byte budget. Any injected Git or content adapter must enforce `maxBytes` and maximum path count before returning content. A production adapter must have tests demonstrating those limits before it becomes a trusted activation source.

Repository knowledge private state must be on the same filesystem as the repository publication target so atomic rename can be verified. Cross-device publication is rejected before mutation. The runtime snapshot writer lock and its recovery protocol are internal storage details, not a user-facing compatibility contract.

## Privacy limits

The import format accepts normalized sessions, events, observations, clusters, candidates, evidence, and knowledge. It rejects raw transcripts, arbitrary payloads, and credential-like text before writing to SQLite. The local database directory is created with owner-only permissions. This release does not claim encryption at rest.

Repository knowledge is written through the repository-knowledge storage boundary. Capture normalization and structured repository runtime directives use the same credential-aware argument classifier. Split, attached, assignment, environment, authorization-header, single-dash named, double-dash named, and tool-specific credential forms are rejected without retaining their values. Ambiguous one-character flags remain tool-specific. The CLI export command returns deterministic JSON only and does not turn local records into shared policy.

Automatic runtime capture stores normalized events, observations, candidates, evidence, and lifecycle transitions in the private local SQLite database. Capture does not store raw transcripts or arbitrary payloads and does not change the synchronous decision when capture fails. Evidence cursors retain their high-water and filter fields as opaque adapter state so incremental capture does not reinterpret source-specific cursor semantics.
