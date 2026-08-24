# Superpowers project setup

## Goal

Make the project process-driven rather than prompt-driven.

## Usage rule

At the start of a task, the agent checks for applicable Superpowers skills before acting. For architectural work, design/spec approval precedes implementation. For failures, systematic debugging precedes fixes. For code changes, TDD precedes production implementation. For completion claims, fresh verification evidence is mandatory.

## Project integration

- `.agents/SUPERPOWERS.md` contains project-level selection rules.
- `docs/superpowers/` maps common project situations to process skills.
- `.agents/skills/` contains only Agent Experience Layer workflows.
- `docs/sdd/` defines when those workflows produce specs, proposals and plans.

## Skills location

For agent runtimes that support cross-runtime skills directories, project-specific skills may later be linked/copied from `.agents/skills/` into the runtime's recognized skill path. Preserve `.agents/skills/` as the canonical version-controlled source.
