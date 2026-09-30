# AEL typed evidence ingestion and episode continuity implementation plan

> For agentic workers: after approval, use `superpowers:executing-plans` task by task. Use subagents only with explicit authorization. Track the steps below; no step is completed by this document.

Goal: Provide a bounded real ingestion path for typed relations, preserve their actual origin, and derive correction and verification-gap episodes across job boundaries without inferring private prose.

Architecture: extend the existing local capture, evidence and knowledge boundaries identified in the specification. Preserve passive admission, immutable provenance and existing authority rules. Keep new responsibilities in the named modules instead of expanding unrelated runtime policy.

Tech stack: repository TypeScript, Node.js built-in SQLite and node:test, pnpm. No new production dependency is required by this plan.

## Status and inputs

Proposed, 2026-09-29. Specification: [ATI](../specs/2026-09-29-ael-typed-evidence-ingestion-design.md), status Draft. Dependencies: AEC, ARC.

The user explicitly requested specifications and plans together. This is a proposed task decomposition prepared before approval, not an executable authorization. Before execution, record spec approval, review this plan against the then-current source, and prepare an isolated checkout when implementation needs isolation. Do not change live project installations or databases merely to run a test.

Read `.agents/SDD.md`, `.agents/QUALITY-GATES.md`, the linked specification and [delivery index](../../product/ael-value-delivery.md). Ownership of shared files is serialized between plans. No parallel edits to `src/cli.ts`, store, learning or retrieval files.

## File ownership

Create `test/ael-typed-evidence-ingestion.test.ts` for requirement-level regression and public-path acceptance. Create `test/fixtures/ael-typed-evidence-ingestion/cases.json` for sanitized scenario inputs and expected semantic relationships. Source paths below marked Create are proposed modules; Modify paths existed at planning time. Each task adds its own test to the same focused suite.

## Test method

Each task below is a small review unit containing multiple TDD steps. Start from the described fixture, assert the observable acceptance condition, run RED, implement the bounded change, run GREEN, and review its diff before committing that unit. A missing import is not sufficient RED evidence: establish the semantic failure after adding the minimal compiling interface. Test helpers must invoke the real public CLI or real store/service; they must not return prepared findings.

Use `node:test` and `node:assert/strict`. Every test name includes its acceptance ID. For migration/restart cases, close and reopen a temporary SQLite store; never point fixtures at the user database. Serialize returned records to inspect forbidden payload fields. Exact expected values and counterexamples are specified in each acceptance row.

## Task 1: Closed annotation import

Requirement `ATI-R1`. Acceptance `ATI-A1`.

Contract: The public import path admits bounded typed evidence with explicit origin and idempotent identity.

Files:

- Create `src/evidence/import.ts`.
- Modify `src/evidence/contracts.ts`.
- Modify `src/cli.ts`.
- Test `test/ael-typed-evidence-ingestion.test.ts`, case `ATI-A1`; fixture `test/fixtures/ael-typed-evidence-ingestion/cases.json`.

- [ ] Add failing case `ATI-A1`: Import the same valid annotation twice, reject extra raw-text fields, and preserve one evidence record per identity.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ATI-A1 dist/test/ael-typed-evidence-ingestion.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Validate a closed JSON schema capped at 256 KiB and 128 records. Namespace IDs by origin and repository; reject unknown raw-text fields and admit immutable typed facts idempotently.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-typed-evidence-ingestion r1` after GREEN.

## Task 2: Origin and verification boundary

Requirement `ATI-R2`. Acceptance `ATI-A2`.

Contract: Annotations and agent claims cannot impersonate source results or verify a task merely through exit zero.

Files:

- Create `src/evidence/import.ts`.
- Modify `src/evidence/repository.ts`.
- Test `test/ael-typed-evidence-ingestion.test.ts`, case `ATI-A2`; fixture `test/fixtures/ael-typed-evidence-ingestion/cases.json`.

- [ ] Add failing case `ATI-A2`: A forged source result is rejected; a user verification remains user-declared and links to a real retained operation.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ATI-A2 dist/test/ael-typed-evidence-ingestion.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Admit user-declared annotations with scoped operation references. Keep missing references pending and ineligible for verification until resolved; reject cross-scope links and spoofed native origin. Preserve declared versus observed provenance through export.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-typed-evidence-ingestion r2` after GREEN.

## Task 3: Explicit decision relations

Requirement `ATI-R3`. Acceptance `ATI-A3`.

Contract: Correction, closure and repeated acceptance use explicit decision/context relations.

Files:

- Modify `src/learning/detectors.ts`.
- Modify `src/evidence/contracts.ts`.
- Test `test/ael-typed-evidence-ingestion.test.ts`, case `ATI-A3`; fixture `test/fixtures/ael-typed-evidence-ingestion/cases.json`.

- [ ] Add failing case `ATI-A3`: A changed decision yields a correction; closure without a criterion yields a gap; changed scope does not yield redundant acceptance.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ATI-A3 dist/test/ael-typed-evidence-ingestion.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Consume decision/context relation keys for correction and closure. Require a criterion for verified closure; keep task scope changes distinct and decline inferred relations based on similar command text.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-typed-evidence-ingestion r3` after GREEN.

## Task 4: Cross-page relation persistence

Requirement `ATI-R4`. Acceptance `ATI-A4`.

Contract: Relations survive page boundaries, late delivery, restart and bounded lookback.

Files:

- Modify `src/learning/repository.ts`.
- Modify `src/learning/service.ts`.
- Test `test/ael-typed-evidence-ingestion.test.ts`, case `ATI-A4`; fixture `test/fixtures/ael-typed-evidence-ingestion/cases.json`.

- [ ] Add failing case `ATI-A4`: Split original decision, correction and verification across three jobs; compare with one-page analysis and require equivalent logical episodes.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ATI-A4 dist/test/ael-typed-evidence-ingestion.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Checkpoint relation keys and unresolved references in bounded state. Use indexed scoped lookback plus continuation when a budget ends, so restart and page boundaries cannot silently discard relations.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-typed-evidence-ingestion r4` after GREEN.

## Task 5: Capability declarations

Requirement `ATI-R5`. Acceptance `ATI-A5`.

Contract: Native source capabilities are advertised only after a real structured-field fixture is qualified.

Files:

- Modify `src/evidence/capabilities.ts`.
- Create `src/evidence/import.ts`.
- Test `test/ael-typed-evidence-ingestion.test.ts`, case `ATI-A5`; fixture `test/fixtures/ael-typed-evidence-ingestion/cases.json`.

- [ ] Add failing case `ATI-A5`: An unsupported host exposes unsupported verification capability; a controlled public-path annotation still produces an auditable episode.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ATI-A5 dist/test/ael-typed-evidence-ingestion.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Advertise the user annotation producer independently from native host verification. Add native mappings only for actual qualified structured fixtures from AEC; otherwise retain unsupported capability.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-typed-evidence-ingestion r5` after GREEN.

## Task 6: Normal worker admission

Requirement `ATI-R6`. Acceptance `ATI-A6`.

Contract: Imported evidence triggers the normal index/worker path without new passive prompts or network calls.

Files:

- Create `src/evidence/import.ts`.
- Create `src/evidence/logical-index.ts`.
- Modify `src/learning/service.ts`.
- Modify `src/cli.ts`.
- Test `test/ael-typed-evidence-ingestion.test.ts`, case `ATI-A6`; fixture `test/fixtures/ael-typed-evidence-ingestion/cases.json`.

- [ ] Add failing case `ATI-A6`: Import through CLI, wait for the normal worker and inspect the episode after restart; fault injection leaves capture available.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ATI-A6 dist/test/ael-typed-evidence-ingestion.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Commit imported facts and logical-index references atomically, enqueue through the usual worker path, and verify after restart without LearningRunOptions.episodeEvidence injection.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-typed-evidence-ingestion r6` after GREEN.

## Acceptance and rollback

- [ ] Run the focused acceptance and regression suites after the final implementation change:

```sh
rtk pnpm build
rtk proxy node --test dist/test/ael-typed-evidence-ingestion.test.js dist/test/learning-contracts.test.js dist/test/learning-detectors.test.js dist/test/learning-service.test.js
rtk pnpm check
rtk git diff --check
```

Expected: build and all selected/full checks exit 0; record actual test counts and any skipped cases. A host-dependent unsupported case remains explicitly unqualified rather than a passing integration.

- [ ] Exercise the complete user-visible path named in the specification in an isolated workspace, including negative scope, unknown evidence and restart cases. Component success cannot substitute for this path.
- [ ] For new tables or formats, interrupt migration and replay it twice; compare immutable old rows and foreign keys. Keep a pre-migration fixture and demonstrate a compatible rollback reader. Never run an incompatible old writer against an upgraded store.
- [ ] For new configuration or installation changes, restore the saved owned-file generation and verify unrelated hooks/settings are byte-identical. For feature-only changes, disable the feature and verify the passive path still operates.
- [ ] Write `docs/verification/2026-09-29-ael-typed-evidence-ingestion.md` with build identity, exact commands/results, actual fixtures, requirement evidence, exclusions and migration/rollback outcome. Fill the corresponding verification paths in the traceability manifest only after execution.
- [ ] Review the implementation against every requirement and its privacy/authority constraints. Update the delivery status only to the level established by evidence; leave unqualified work open.

## Traceability

| Requirement | Acceptance | Implementation task | Test case |
|---|---|---|---|
| ATI-R1 | ATI-A1 | 1 | ATI-A1 |
| ATI-R2 | ATI-A2 | 2 | ATI-A2 |
| ATI-R3 | ATI-A3 | 3 | ATI-A3 |
| ATI-R4 | ATI-A4 | 4 | ATI-A4 |
| ATI-R5 | ATI-A5 | 5 | ATI-A5 |
| ATI-R6 | ATI-A6 | 6 | ATI-A6 |
