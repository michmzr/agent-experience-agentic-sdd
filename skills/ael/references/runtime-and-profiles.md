# Runtime and profiles

Evaluate a runtime decision with `ael runtime evaluate --input <path> [--profile normal|learning|observe-only] --json`. Inspect active runtime state with `ael runtime status --json` and configuration provenance with `ael runtime config explain --workspace <path> [--remote <name>] --json`.

Use `--refresh` only when the caller requires a fresh evaluation. Preserve the selected profile and its gate behavior in reports. A degraded or blocked outcome must be reported as returned by AEL rather than reinterpreted.

This reference is for AEL runtime profiles and snapshots, not unrelated application-runtime troubleshooting. Run `ael --help` before using an unlisted runtime form.
