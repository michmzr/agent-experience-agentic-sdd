# Command reference

## Context resolution

Commands that require a repository or workspace accept these contextual forms:

```text
ael unregister [--repository-id <id>]
ael list records [--repository-id <id>|--repository <git-root>] [--json]
ael stats [--repository-id <id>|--repository <git-root>] [--json]
ael status [--repository-id <id>|--repository <git-root>] [--schema-version 2] [--json]
ael experience inspect [--repository <path>] [--json]
ael hooks diagnostics [--repository <path>] [--json]
ael analysis run [--repository-id <id>] [--json]
ael analysis report [--repository-id <id>] [--session <id>] [--schema-version 2] [--json]
ael lessons list --scope repo [--repository-id <id>] [--state <state>] [--tag <tag>] [--json]
ael retrieve --scope repo [--repository-id <id>] [--path <path>] [--tool <tool>] [--tag <tag>] [--json]
ael export --scope repo [--repository-id <id>] [--format json]
ael runtime config explain [--workspace <path>] [--remote <url>] [--json]
ael knowledge validate [--repository <path>] [--trusted-ref <ref>] [--json]
ael knowledge refresh-runtime [--repository <path>] [--repository-id <id>] --trusted-ref <ref> [--json]
ael knowledge promote [--repository <path>] --input <document.json> [--json]
```

An explicit option has precedence. Without one, AEL uses the nearest ancestor `.ael/workspace.json`, then the current Git root. An interactive human invocation asks for a path only when neither source resolves context. JSON and redirected invocations return a bounded context error without prompting. `ael hooks verify`, review commands, and workspace skill commands retain their documented explicit or working-directory rules.

## Skill lifecycle

The skill bundle lifecycle uses these forms:

```text
ael skill install --scope workspace [--workspace <directory>] [--json]
ael skill install --scope global --yes [--json]
ael skill update --scope workspace [--workspace <directory>] [--json]
ael skill update --scope global --yes [--json]
ael skill status --scope workspace|global [--workspace <directory>] [--json]
ael skill validate <skill-directory> [--json]
ael skill uninstall --scope workspace [--workspace <directory>] [--json]
ael skill uninstall --scope global --yes [--json]
```

Workspace scope installs to `.agents/skills/ael` below the resolved workspace root. Global scope installs to `$HOME/.agents/skills/ael` and always requires `--yes` for mutation. Status and validation never mutate files. Installation and updates refuse unmanaged, modified, malformed, or unexpected destination contents.

`current` means the installed bundle matches this local AEL release and its documentation snapshot, not an Internet-latest claim. Run `ael --help` before relying on a command not listed here.
