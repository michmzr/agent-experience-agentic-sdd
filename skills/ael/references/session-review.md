# Session review

Discover eligible sessions with `ael review sessions --source codex|claude-code|cursor --root <path> --json`. Review a selected session with `ael review session --source <source> --root <path> [--session <id>] --json`.

Use interactive review only when the request explicitly calls for guided selection or debrief. For deterministic automation, retain `--json` and inspect findings, candidates, proposals, and skipped reviewers before taking another action.

This reference covers AEL review of agent sessions. It does not cover general pull-request or source-code review. Run `ael --help` before using an unlisted review option.
