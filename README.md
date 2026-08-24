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
```

Pass `--data-dir <directory>` to every command to select a private local data directory. The default is `~/Library/Application Support/AgentExperience` on macOS and `$XDG_DATA_HOME/agent-experience` or `~/.local/share/agent-experience` on Linux. Use `--json` for structured results and diagnostics. Successful commands return exit code 0, domain or storage failures return 1, and invalid command syntax returns 2.

Explicit session IDs run without a prompt and may read an injected external artifact store. Interactive selection and `latest` require `--repository` to name a directory inside a Git repository. The command resolves its canonical Git top level and accepts only artifacts whose real paths resolve inside that same top level. The prompt exposes only session IDs and recency, then requires confirmation before reading the selected artifact. Non-Git stores and different or nested repositories cannot qualify for interactive selection.

## Privacy limits

The import format accepts normalized sessions, events, observations, clusters, candidates, evidence, and knowledge. It rejects raw transcripts, arbitrary payloads, and credential-like text before writing to SQLite. The local database directory is created with owner-only permissions. This release does not claim encryption at rest.

Repository knowledge is written through the repository-knowledge storage boundary in later promotion workflows. The CLI export command returns deterministic JSON only and does not turn local records into shared policy.
