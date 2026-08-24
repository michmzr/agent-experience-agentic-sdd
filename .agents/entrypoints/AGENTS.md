# Agent Experience Layer instructions

This is the canonical cross-agent entrypoint template. When installed at repository root as `AGENTS.md`, read the project guidance from `.agents/` in this order:

1. `.agents/PROJECT.md`
2. `.agents/INSTRUCTIONS.md`
3. `.agents/WORKFLOW.md`
4. `.agents/SDD.md`
5. `.agents/SUPERPOWERS.md`
6. `.agents/QUALITY-GATES.md`

Load specialized files only when relevant:

- `.agents/KNOWLEDGE-LIFECYCLE.md`
- `.agents/SESSION-REVIEW.md`
- `.agents/skills/<skill>/SKILL.md`
- `docs/sdd/specs/`

Do not implement from an unapproved architectural proposal. Do not blindly retry failures. Do not claim completion without fresh verification evidence.
