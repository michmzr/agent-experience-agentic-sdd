# Setup and health

Initialize shared local data with `ael init --scope global`. Initialize a Git repository and its selected capture hooks with `ael init --scope repo --hooks codex,cursor`. For a directory that must remain outside Git, use `ael init --scope workspace --hooks codex,cursor` and optionally assign `--workspace-id <slug>`.

Inspect the workspace integration with `ael status --json` and hook readiness with `ael hooks verify --worktree <path> --json`. A non-ready status is diagnostic evidence, not permission to overwrite configuration. Preserve unrelated hook configuration.

Use `ael status --schema-version 2 --json` for the multidimensional health contract. It reports installation, delivery, retained-data quality, and analysis independently. `ael status-global --schema-version 2 --json` applies the same dimensions to registered integrations without exposing local paths. `ael analysis report --repository-id <id> --schema-version 2 --json` returns the versioned analysis dimension. Omitting `--schema-version 2` keeps the version 1 output contract unchanged.

Remove a stale status registration with `ael unregister --repository-id <id>`. This removes registry metadata and preserves captured session records.

Passive capture is intentionally fail-open. Its command form is `ael capture hook --source codex|cursor`; agents should not invoke it manually unless testing a hook adapter. Run `ael --help` before relying on a setup option not listed here.
