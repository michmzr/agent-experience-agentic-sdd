# Superpowers setup

Superpowers supplies the process discipline used by this project. The project-specific `.agents/skills/` directory contains domain workflows, while Superpowers controls how work is designed, debugged, planned, executed and verified.

## Recommended sequence for a new feature

1. `brainstorming` - clarify and approve the design.
2. Write or update the SDD specification.
3. `writing-plans` - produce an executable implementation plan from the approved spec.
4. `using-git-worktrees` - isolate implementation when appropriate.
5. `test-driven-development` - implement behavior changes.
6. `systematic-debugging` - investigate unexpected failures before fixes.
7. `verification-before-completion` - obtain fresh evidence before completion claims.
8. `requesting-code-review` or project review process before merge.

## Parallel work

Use `dispatching-parallel-agents` only for genuinely independent problem domains. The session-review architecture deliberately assigns separate reviewer perspectives so they can be parallelized safely.

## Skills

When creating or modifying files under `.agents/skills/`, use Superpowers `writing-skills`. Skill descriptions should say when to load the skill, not summarize its complete procedure.
