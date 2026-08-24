# Superpowers integration

Superpowers is the default process framework for design, debugging, planning, implementation and verification.

## Skill selection

- New subsystem or behavioral design: use `brainstorming` before implementation.
- Multi-step approved specification: use `writing-plans` before code changes.
- Feature or bugfix implementation: use `test-driven-development`.
- Unexpected failure: use `systematic-debugging` before proposing a fix.
- Independent review domains: use `dispatching-parallel-agents`.
- Isolated implementation: use `using-git-worktrees`.
- Execution of a written plan: prefer `subagent-driven-development`; use `executing-plans` when working inline.
- Before claiming completion: use `verification-before-completion`.
- Creating or changing reusable skills: use `writing-skills`.

## Project-specific skills

The `.agents/skills/` directory contains workflows specific to Agent Experience Layer. Project-specific skills do not replace Superpowers process skills. Use the relevant process skill first, then the project skill.

## Approval rule

When a Superpowers workflow requires human approval, do not combine presenting the decision with silently starting implementation. Approval is a real gate.
