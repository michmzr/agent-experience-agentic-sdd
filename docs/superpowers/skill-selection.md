# Project skill selection

## AEL

Use the `ael` skill when the request concerns Agent Experience Layer setup, capture health, manual session review, knowledge lifecycle, runtime profiles, diagnostics, repository integration, or the AEL command contract.

Read `skills/ael/SKILL.md` first and select the linked reference that matches the AEL task. For a published installation, use `ael skill status --scope workspace|global` to verify the managed artifact before updating it.

The project does not provide generic skills for session review, conflict resolution, knowledge promotion, or specification work. Those workflows fall outside the AEL-only skill scope unless the request explicitly concerns AEL.

## promote-lessons

Use when local confirmed knowledge may deserve promotion to shared repository or global user scope.

## revalidate-knowledge

Use when existing knowledge is stale, contradicted, repeatedly overridden or otherwise requires evidence-based revalidation.

## resolve-conflicts

Use when two active knowledge entries or new evidence conflict and policy needs a deterministic resolution path.

## experience-review

Use when accumulated lessons should be converted into a prioritized improvement backlog from architecture, developer-experience and project-management perspectives.

## spec-driven-change

Use when an accepted proposal must be turned into an approved specification before implementation planning.
