# Cursor setup

As of 2026-08-24, Cursor supports version-controlled project rules under `.cursor/rules` and also supports root `AGENTS.md` as a simpler instruction format. Cursor CLI also reads project instruction files.

This package intentionally does not add `.cursor/` because `.agents/` is the canonical cross-agent source.

## Recommended setup

Use the same root `AGENTS.md` entrypoint as Codex. Add Cursor-specific `.cursor/rules` later only when path-scoped or Cursor-only behavior is required; do not duplicate the entire project instruction set there.

See `docs/research/current-agent-instruction-support.md` for verified references.
