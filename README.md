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

## Commands

```text
ael init [--scope global|repo]
ael experience add --input record.json
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
```

Pass `--data-dir <directory>` to every command to select a private local data directory. The default is `~/Library/Application Support/AgentExperience` on macOS and `$XDG_DATA_HOME/agent-experience` or `~/.local/share/agent-experience` on Linux. Use `--json` for deterministic structured results and diagnostics. Runtime ALLOW and WARN decisions return exit code 0. Runtime BLOCK decisions, domain failures, and storage failures return 1. Invalid command syntax returns 2.

Explicit session IDs run without a prompt and may read an injected external artifact store. Interactive selection and `latest` require `--repository` to name a directory inside a Git repository. The command resolves its canonical Git top level and accepts only artifacts whose real paths resolve inside that same top level. The prompt exposes only session IDs and recency, then requires confirmation before reading the selected artifact. Non-Git stores and different or nested repositories cannot qualify for interactive selection.

## Runtime evaluation

Runtime input is a structured action or intent JSON object. Evaluation loads a validated immutable snapshot before constructing the gate. The gate itself is synchronous and reads only the in-memory snapshot. It does not read SQLite, Git, repository files, the network, or a language model. A missing snapshot is initialized for the input repository. An existing snapshot is refreshed only when `--refresh` is supplied. Corrupt or unavailable existing state follows the fallback policy instead of being overwritten automatically.

The `normal` profile permits verified authoritative exact conflicts to BLOCK. The `learning` profile downgrades a would-be BLOCK to WARN while retaining retrieval, explanations, and capture. The `observe-only` profile returns ALLOW while retaining explanations and capture. `runtime config explain` returns the source selected for every resolved profile field without returning the supplied workspace or remote URL.

`runtime status` reports health, profile ID, hard-blocking state, retrieval mode, fallback source, and circuit state. Fallback order is the current in-memory index, the current local snapshot, the last-known-good snapshot, then configured degraded policy. Ordinary degraded actions allow. Protected degraded actions block only when the effective profile configures fail-closed behavior.

Runtime overrides have rule, action, or task-session scope. Authorization and completion are separate immutable audit records. A successful override may contribute contradiction evidence for revalidation, but it does not silently delete or reverify policy.

## Shared repository knowledge

`knowledge promote` writes a branch-local review artifact. Promotion cannot assert merged activation. `knowledge validate` treats branch-local content as non-authoritative context unless `--trusted-ref` names an explicit local Git ref or commit containing the validated knowledge generation. The resolved trusted commit supplies provenance, and only its entries are authoritative.

`knowledge refresh-runtime` is the explicit bridge from repository knowledge to enforcement. It requires a trusted local Git ref and an exact runtime repository identifier. Only active authoritative entries from that commit with a validated structured `runtimeDirective` are compiled. Markdown prose and branch-local changes never create runtime rules. The target-specific snapshot is published atomically and later `runtime evaluate` invocations load it without Git, network, or language-model access.

The local Git adapter resolves commits, bounds tree output, enforces a path-count budget, checks each blob size with `git cat-file -s`, then reads blobs within the supplied byte budget. Any injected Git or content adapter must enforce `maxBytes` and maximum path count before returning content. A production adapter must have tests demonstrating those limits before it becomes a trusted activation source.

Repository knowledge private state must be on the same filesystem as the repository publication target so atomic rename can be verified. Cross-device publication is rejected before mutation. The runtime snapshot writer lock and its recovery protocol are internal storage details, not a user-facing compatibility contract.

## Privacy limits

The import format accepts normalized sessions, events, observations, clusters, candidates, evidence, and knowledge. It rejects raw transcripts, arbitrary payloads, and credential-like text before writing to SQLite. The local database directory is created with owner-only permissions. This release does not claim encryption at rest.

Repository knowledge is written through the repository-knowledge storage boundary. The CLI export command returns deterministic JSON only and does not turn local records into shared policy.

Automatic runtime capture stores normalized events, observations, candidates, evidence, and lifecycle transitions in the private local SQLite database. Capture does not store raw transcripts or arbitrary payloads and does not change the synchronous decision when capture fails. Evidence cursors retain their high-water and filter fields as opaque adapter state so incremental capture does not reinterpret source-specific cursor semantics.
