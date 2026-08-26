# Cursor setup

As of 2026-08-24, Cursor supports version-controlled project rules under `.cursor/rules` and also supports root `AGENTS.md` as a simpler instruction format. Cursor CLI also reads project instruction files.

The checked-in `.cursor/hooks.json` adds passive session and technical tool-event capture while `.agents/` remains the canonical cross-agent source.

## Recommended setup

Use the same root `AGENTS.md` entrypoint as Codex. Add Cursor-specific `.cursor/rules` later only when path-scoped or Cursor-only behavior is required; do not duplicate the entire project instruction set there.

## Passive project capture

Run `pnpm build` after installing dependencies and before relying on the project hooks. The shared wrapper resolves the Git repository top level and invokes `dist/src/cli.js`; without that build it emits a generic diagnostic and exits successfully.

Capture data stays in the local SQLite database under `AEL_DATA_DIR` when set, or under the platform default documented in the root README. The configuration registers session and technical tool events only. Prompt text, assistant or tool transcripts, raw hook payloads and credential-like values are excluded.

Capture failures are fail-open and cannot warn about, ask about, deny or block a Cursor action. Remove the entries from `.cursor/hooks.json` to stop future capture without deleting existing local records.

See `docs/research/current-agent-instruction-support.md` for verified references.
