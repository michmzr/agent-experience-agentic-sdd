# Project bootstrap

This ZIP intentionally contains only `.agents/` and `docs/`.

## Canonical source

Keep `.agents/` version-controlled as the single source of agent guidance. Avoid maintaining independent full instruction copies for Codex, Claude Code and Cursor.

## Tool entrypoints

Because current coding agents do not all auto-load `.agents/` directly, use the templates under `.agents/entrypoints/` to create the minimal root entrypoints expected by each tool.

Recommended model:

- root `AGENTS.md`: points to canonical `.agents/` guidance and is used by Codex and Cursor;
- root `CLAUDE.md`: imports or points to the shared `AGENTS.md` and contains only Claude-specific additions.

The ZIP does not include these root files because the requested package is limited to `.agents/` and `docs/`.

## First agent task

Before implementation work, ask the agent to read `.agents/PROJECT.md`, `.agents/INSTRUCTIONS.md`, `.agents/SDD.md`, the relevant approved spec and the applicable Superpowers workflow.
