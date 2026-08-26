# Codex setup

As of 2026-08-24, Codex supports project instructions through `AGENTS.md` and hierarchical variants. Keep the project root entrypoint short and route detailed guidance to `.agents/`.

## Recommended setup

1. Place or link `.agents/entrypoints/AGENTS.md` as root `AGENTS.md`.
2. Keep canonical project instructions under `.agents/`.
3. Let more specific subdirectory instructions exist only when the repository later needs them.
4. Use Superpowers process skills before implementation work.

## Passive project capture

This repository includes `.codex/hooks.json` for passive session and technical tool-event capture. Its `SessionStart` hook matches `startup` only. Resume, clear and compact lifecycle events do not invoke the wrapper, so only startup creates a captured session. A closed session is never reopened. Run `pnpm build` after installing dependencies and before relying on the project hooks, because the shared wrapper invokes `dist/src/cli.js` from the Git repository top level.

Capture remains local. The SQLite database uses `AEL_DATA_DIR` when set, or the platform default documented in the root README. Only normalized session and technical events are retained. Prompt text, assistant or tool transcripts, raw hook payloads and credential-like values are excluded.

Capture is fail-open: a missing build or persistence failure produces a generic diagnostic and exits successfully, without warning about, asking about, denying or blocking the Codex action. Review and trust project hooks through Codex `/hooks` after adding or changing this configuration. Remove the entries from `.codex/hooks.json` to stop future capture without deleting existing local records.

## Reason

A short root entrypoint reduces instruction duplication while preserving a portable source of truth shared with Cursor and imported by Claude Code.

See `docs/research/current-agent-instruction-support.md` for verified documentation references.
