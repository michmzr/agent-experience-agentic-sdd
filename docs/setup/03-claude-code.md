# Claude Code setup

As of 2026-08-24, Claude Code reads `CLAUDE.md`, not `AGENTS.md` directly as its primary project memory file. Its documentation recommends importing an existing `AGENTS.md` when a repository already uses one for other coding agents.

## Recommended setup

1. Create root `AGENTS.md` from `.agents/entrypoints/AGENTS.md`.
2. Create root `CLAUDE.md` from `.agents/entrypoints/CLAUDE.md` and have it use the shared root instructions.
3. Keep Claude-specific additions small.
4. Use hooks as adapters for runtime policy, not as a separate knowledge system.
5. Keep reusable procedures in skills rather than growing a monolithic CLAUDE.md.

See `docs/research/current-agent-instruction-support.md` for verified references.
