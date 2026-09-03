# Setup and health

Initialize shared local data with `ael init --scope global`. Initialize a Git workspace and its selected capture hooks with `ael init --scope repo --hooks codex,cursor`.

Inspect the workspace integration with `ael status --json` and hook readiness with `ael hooks verify --worktree <path> --json`. A non-ready status is diagnostic evidence, not permission to overwrite configuration. Preserve unrelated hook configuration.

Passive capture is intentionally fail-open. Its command form is `ael capture hook --source codex|cursor`; agents should not invoke it manually unless testing a hook adapter. Run `ael --help` before relying on a setup option not listed here.
