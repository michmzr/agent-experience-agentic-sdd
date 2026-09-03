# Diagnostics

Prefer machine-readable output with `--json` when diagnosing AEL. Capture adapters emit `AEL_CAPTURE_INVALID_INPUT` or `AEL_CAPTURE_PERSISTENCE_FAILED` and remain fail-open: document the degradation, then inspect configuration and storage rather than blocking the host tool.

CLI syntax failures use exit code 2; AEL domain errors have stable codes in their JSON diagnostic. Record the command, scope, and returned code without exposing credentials, complete transcripts, or private paths.

Check `ael status --json`, `ael status-global --json`, and `ael hooks verify --worktree <path> --json` before changing integration state. Run `ael --help` before relying on a diagnostic command not listed here.
