# AEL result facts and continuous operation evidence implementation plan

> For agentic workers: after approval, use `superpowers:executing-plans` task by task. Use subagents only with explicit authorization. Track the steps below; no step is completed by this document.

Goal: Provide one versioned, complete local operation stream for learning and reporting, with immutable source facts, explicit missing data and task verification separate from process status.

Architecture: extend the existing local capture, evidence and knowledge boundaries identified in the specification. Preserve passive admission, immutable provenance and existing authority rules. Keep new responsibilities in the named modules instead of expanding unrelated runtime policy.

Tech stack: repository TypeScript, Node.js built-in SQLite and node:test, pnpm. No new production dependency is required by this plan.

## Status and inputs

Execution authorized 2026-09-30; drafted 2026-09-29. Specification: [AEC](../specs/2026-09-29-ael-evidence-continuity-design.md), status Approved for implementation. Dependencies: ABI.

On 2026-09-30 the user authorized implementation of all eight AEL specifications and requested subagents. Before each task, review this plan against current source and work in an isolated checkout with explicit file ownership. Do not change live project installations or databases merely to run a test.

Read `.agents/SDD.md`, `.agents/QUALITY-GATES.md`, the linked specification and [delivery index](../../product/ael-value-delivery.md). Ownership of shared files is serialized between plans. No parallel edits to `src/cli.ts`, store, learning or retrieval files.

## File ownership

Create `test/ael-evidence-continuity.test.ts` for requirement-level regression and public-path acceptance. Create `test/fixtures/ael-evidence-continuity/cases.json` for sanitized scenario inputs and expected semantic relationships. Source paths below marked Create are proposed modules; Modify paths existed at planning time. Each task adds its own test to the same focused suite.

## Test method

Each task below is a small review unit containing multiple TDD steps. Start from the described fixture, assert the observable acceptance condition, run RED, implement the bounded change, run GREEN, and review its diff before committing that unit. A missing import is not sufficient RED evidence: establish the semantic failure after adding the minimal compiling interface. Test helpers must invoke the real public CLI or real store/service; they must not return prepared findings.

Use `node:test` and `node:assert/strict`. Every test name includes its acceptance ID. For migration/restart cases, close and reopen a temporary SQLite store; never point fixtures at the user database. Serialize returned records to inspect forbidden payload fields. Exact expected values and counterexamples are specified in each acceptance row.

## Task 1: Qualify actual result envelopes

Requirement `AEC-R1`. Acceptance `AEC-A1`.

Contract: Result extraction has an explicit host/version capability profile and retains field provenance without raw output.

Files:

- Modify `src/capture/hook-adapters/codex.ts`.
- Modify `src/evidence/contracts.ts`.
- Modify `src/evidence/capabilities.ts`.
- Test `test/ael-evidence-continuity.test.ts`, case `AEC-A1`; fixture `test/fixtures/ael-evidence-continuity/cases.json`.

- [ ] Add failing case `AEC-A1`: Qualify real sanitized success/failure envelopes; unsupported and missing fields remain unknown. Do not use the illustrative nested probe as a production fixture.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=AEC-A1 dist/test/ael-evidence-continuity.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: First observe controlled success, failure and asynchronous completion through the installed host. Sanitize these observations into fixtures with host/build identity. Allowlist only witnessed structured fields; retain an explicit unsupported profile for unavailable classes.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-evidence-continuity r1` after GREEN.

## Task 2: Unified logical evidence reader

Requirement `AEC-R2`. Acceptance `AEC-A2`.

Contract: Every eligible legacy or resumed event is exposed once through the logical operation reader.

Files:

- Modify `src/storage/experience-store.ts`.
- Create `src/evidence/logical-index.ts`.
- Modify `src/learning/service.ts`.
- Modify `src/application/experience-service.ts`.
- Test `test/ael-evidence-continuity.test.ts`, case `AEC-A2`; fixture `test/fixtures/ael-evidence-continuity/cases.json`.

- [ ] Add failing case `AEC-A2`: Startup/end/resume with two resumed events yields both events to learning and quality; replay does not duplicate them.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=AEC-A2 dist/test/ael-evidence-continuity.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Add an append-only sequence/reference index and transactionally index both legacy and resumed events. Switch learning and repository quality to this reader, preserving v1 session closure and output contracts.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-evidence-continuity r2` after GREEN.

## Task 3: Stable bounded pages

Requirement `AEC-R3`. Acceptance `AEC-A3`.

Contract: The logical index has stable bounded pagination under concurrent and late arrivals.

Files:

- Create `src/evidence/logical-index.ts`.
- Modify `src/learning/repository.ts`.
- Test `test/ael-evidence-continuity.test.ts`, case `AEC-A3`; fixture `test/fixtures/ael-evidence-continuity/cases.json`.

- [ ] Add failing case `AEC-A3`: Append during a fixed-high-water read; no omission or duplicate occurs, and the next range contains only later entries.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=AEC-A3 dist/test/ael-evidence-continuity.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Capture one high-water sequence per range, then query sequence greater than cursor and at most the watermark. Limit pages to 1024; next-range discovery admits later facts without shifting an existing page.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-evidence-continuity r3` after GREEN.

## Task 4: Process and task interpretation

Requirement `AEC-R4`. Acceptance `AEC-A4`.

Contract: Process interpretation and task verification remain separate, and repairs consume the qualified interpretation.

Files:

- Modify `src/evidence/reconstructor.ts`.
- Modify `src/evidence/capture-projection.ts`.
- Modify `src/learning/detectors.ts`.
- Test `test/ael-evidence-continuity.test.ts`, case `AEC-A4`; fixture `test/fixtures/ael-evidence-continuity/cases.json`.

- [ ] Add failing case `AEC-A4`: rg no-match, interruption, environment restriction, expected RED and a genuine failed test have distinct outcomes; exit zero alone never verifies the task.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=AEC-A4 dist/test/ael-evidence-continuity.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Interpret allowlisted result facts with explicit context requirements. Route repairs through interpretation and linked task evidence. Preserve unknown when no-match, expected RED or task relevance cannot be established.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-evidence-continuity r4` after GREEN.

## Task 5: Delayed execution correlation

Requirement `AEC-R5`. Acceptance `AEC-A5`.

Contract: Asynchronous completion attaches only through a stable qualified execution relation.

Files:

- Create `src/evidence/logical-index.ts`.
- Modify `src/evidence/reconstructor.ts`.
- Modify `src/learning/repository.ts`.
- Test `test/ael-evidence-continuity.test.ts`, case `AEC-A5`; fixture `test/fixtures/ael-evidence-continuity/cases.json`.

- [ ] Add failing case `AEC-A5`: A delayed terminal result links across page boundaries; unrelated and conflicting execution identities remain unresolved.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=AEC-A5 dist/test/ael-evidence-continuity.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Persist qualified execution keys with scope and unresolved relations. Resolve late completions across pages by exact identity; quarantine conflicting keys and never correlate solely by time.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-evidence-continuity r5` after GREEN.

## Task 6: Resumable migration and compatibility

Requirement `AEC-R6`. Acceptance `AEC-A6`.

Contract: Additive migration, replay and compatibility preserve old facts and expose incomplete backfill.

Files:

- Modify `src/storage/experience-store.ts`.
- Create `src/evidence/logical-index.ts`.
- Test `test/ael-evidence-continuity.test.ts`, case `AEC-A6`; fixture `test/fixtures/ael-evidence-continuity/cases.json`.

- [ ] Add failing case `AEC-A6`: Migrate a v1 fixture twice, interrupt backfill, resume and compare v1 rows and foreign keys; old output remains unchanged.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=AEC-A6 dist/test/ael-evidence-continuity.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Backfill reference rows in bounded transactions with a durable cursor. Preserve all legacy rows and foreign keys, expose incomplete coverage, and refuse writers lacking the new capability after activation.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-evidence-continuity r6` after GREEN.

## Acceptance and rollback

- [ ] Run the focused acceptance and regression suites after the final implementation change:

```sh
rtk pnpm build
rtk proxy node --test dist/test/ael-evidence-continuity.test.js dist/test/session-evidence-reconstruction.test.js dist/test/experience-store.test.js dist/test/learning-service.test.js
rtk pnpm check
rtk git diff --check
```

Expected: build and all selected/full checks exit 0; record actual test counts and any skipped cases. A host-dependent unsupported case remains explicitly unqualified rather than a passing integration.

- [ ] Exercise the complete user-visible path named in the specification in an isolated workspace, including negative scope, unknown evidence and restart cases. Component success cannot substitute for this path.
- [ ] For new tables or formats, interrupt migration and replay it twice; compare immutable old rows and foreign keys. Keep a pre-migration fixture and demonstrate a compatible rollback reader. Never run an incompatible old writer against an upgraded store.
- [ ] For new configuration or installation changes, restore the saved owned-file generation and verify unrelated hooks/settings are byte-identical. For feature-only changes, disable the feature and verify the passive path still operates.
- [ ] Write `docs/verification/2026-09-29-ael-evidence-continuity.md` with build identity, exact commands/results, actual fixtures, requirement evidence, exclusions and migration/rollback outcome. Fill the corresponding verification paths in the traceability manifest only after execution.
- [ ] Review the implementation against every requirement and its privacy/authority constraints. Update the delivery status only to the level established by evidence; leave unqualified work open.

## Traceability

| Requirement | Acceptance | Implementation task | Test case |
|---|---|---|---|
| AEC-R1 | AEC-A1 | 1 | AEC-A1 |
| AEC-R2 | AEC-A2 | 2 | AEC-A2 |
| AEC-R3 | AEC-A3 | 3 | AEC-A3 |
| AEC-R4 | AEC-A4 | 4 | AEC-A4 |
| AEC-R5 | AEC-A5 | 5 | AEC-A5 |
| AEC-R6 | AEC-A6 | 6 | AEC-A6 |
