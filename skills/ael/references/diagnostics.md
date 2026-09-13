# Diagnostics

Prefer machine-readable output with `--json` when diagnosing AEL. Capture adapters emit `AEL_CAPTURE_INVALID_INPUT` or `AEL_CAPTURE_PERSISTENCE_FAILED` and remain fail-open: document the degradation, then inspect configuration and storage rather than blocking the host tool.

CLI syntax failures use exit code 2; AEL domain errors have stable codes in their JSON diagnostic. Record the command, scope, and returned code without exposing credentials, complete transcripts, or private paths.

Check `ael status --schema-version 2 --json`, `ael status-global --schema-version 2 --json`, and `ael hooks verify --worktree <path> --json` before changing integration state. The version 2 report separates installation readiness from delivery backlog, data-quality gaps, and analysis execution. A missing denominator is reported as unavailable, never as a percentage. Run `ael --help` before relying on a diagnostic command not listed here.
