# Local experience core

`ael` records normalized agent experience locally. It uses Node.js 22.17 or later, SQLite through Node's built-in `node:sqlite` module, and no network service or language-model call.

## Installation

Install dependencies and run the verification suite:

```sh
pnpm install --frozen-lockfile
pnpm check
```

Run the compiled CLI with Node:

```sh
node dist/src/cli.js init
```

## Commands

```text
ael init [--scope global|repository]
ael experience add --input record.json
ael validate [--scope global|repository] [--json]
ael inspect <id>
ael lessons list [--scope global|repository] [--state <state>] [--tag <tag>]
ael retrieve [--scope global|repository] [--repository-id <id>] [--path <path>] [--tool <tool>] [--tag <tag>]
ael export [--scope global|repository] [--repository-id <id>] [--format json]
```

Pass `--data-dir <directory>` to every command to select a private local data directory. The default is `~/Library/Application Support/AgentExperience` on macOS and `$XDG_DATA_HOME/agent-experience` or `~/.local/share/agent-experience` on Linux. Use `--json` for structured results and diagnostics. Successful commands return exit code 0, domain or storage failures return 1, and invalid command syntax returns 2.

## Privacy limits

The import format accepts normalized sessions, events, observations, clusters, candidates, evidence, and knowledge. It rejects raw transcripts, arbitrary payloads, and credential-like text before writing to SQLite. The local database directory is created with owner-only permissions. This release does not claim encryption at rest.

Repository knowledge is written through the repository-knowledge storage boundary in later promotion workflows. The CLI export command returns deterministic JSON only and does not turn local records into shared policy.
