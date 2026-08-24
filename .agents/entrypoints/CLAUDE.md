# Claude Code entrypoint template

Use the repository root `AGENTS.md` as the canonical shared instructions source. Add Claude-specific guidance only when the behavior cannot be expressed portably.

Claude-specific rules:

- Use hooks only as adapters into shared project policy, not as a second source of truth.
- Keep runtime guards deterministic; do not place LLM reasoning in a blocking hook path.
- Use Claude auto-memory as supplementary personal/repository context, not as a replacement for reviewed shared knowledge.
- For project-specific reusable procedures, prefer the skills under `.agents/skills/`.
