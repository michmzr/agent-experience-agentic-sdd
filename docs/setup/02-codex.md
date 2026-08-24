# Codex setup

As of 2026-08-24, Codex supports project instructions through `AGENTS.md` and hierarchical variants. Keep the project root entrypoint short and route detailed guidance to `.agents/`.

## Recommended setup

1. Place or link `.agents/entrypoints/AGENTS.md` as root `AGENTS.md`.
2. Keep canonical project instructions under `.agents/`.
3. Let more specific subdirectory instructions exist only when the repository later needs them.
4. Use Superpowers process skills before implementation work.

## Reason

A short root entrypoint reduces instruction duplication while preserving a portable source of truth shared with Cursor and imported by Claude Code.

See `docs/research/current-agent-instruction-support.md` for verified documentation references.
