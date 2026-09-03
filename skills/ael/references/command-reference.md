# Command reference

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
