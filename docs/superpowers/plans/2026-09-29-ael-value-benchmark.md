# AEL end-to-end value benchmark implementation plan

> For agentic workers: after approval, use `superpowers:executing-plans` task by task. Use subagents only with explicit authorization. Track the steps below; no step is completed by this document.

Goal: Begin baseline measurement before behavior changes, test the actual local pipeline, and compare disabled, passive and opt-in advice conditions using reproducible behavioral and cost evidence.

Architecture: extend the existing local capture, evidence and knowledge boundaries identified in the specification. Preserve passive admission, immutable provenance and existing authority rules. Keep new responsibilities in the named modules instead of expanding unrelated runtime policy.

Tech stack: repository TypeScript, Node.js built-in SQLite and node:test, pnpm. No new production dependency is required by this plan.

## Status and inputs

Execution authorized 2026-09-30; drafted 2026-09-29. Specification: [AVB](../specs/2026-09-29-ael-value-benchmark-design.md), status Approved for implementation. Dependencies: None.

On 2026-09-30 the user authorized implementation of all eight AEL specifications and requested subagents. Before each task, review this plan against current source and work in an isolated checkout with explicit file ownership. Do not change live project installations or databases merely to run a test.

Read `.agents/SDD.md`, `.agents/QUALITY-GATES.md`, the linked specification and [delivery index](../../product/ael-value-delivery.md). Ownership of shared files is serialized between plans. No parallel edits to `src/cli.ts`, store, learning or retrieval files.

## File ownership

Create `test/ael-value-benchmark.test.ts` for requirement-level regression and public-path acceptance. Create `test/fixtures/ael-value-benchmark/cases.json` for sanitized scenario inputs and expected semantic relationships. Source paths below marked Create are proposed modules; Modify paths existed at planning time. Each task adds its own test to the same focused suite.

## Test method

Each task below is a small review unit containing multiple TDD steps. Start from the described fixture, assert the observable acceptance condition, run RED, implement the bounded change, run GREEN, and review its diff before committing that unit. A missing import is not sufficient RED evidence: establish the semantic failure after adding the minimal compiling interface. Test helpers must invoke the real public CLI or real store/service; they must not return prepared findings.

Use `node:test` and `node:assert/strict`. Every test name includes its acceptance ID. For migration/restart cases, close and reopen a temporary SQLite store; never point fixtures at the user database. Serialize returned records to inspect forbidden payload fields. Exact expected values and counterexamples are specified in each acceptance row.

Execute task 1 as B0 before product changes. Tasks 2–3 run as B1 after ABI core, AEC, ARC, ASC, ATI and ACL. Tasks 4–6 run as B2 after AAP. AAP consumes B0; it does not depend on completion of B2.

## Task 1: B0 baseline capture

Requirement `AVB-R1`. Acceptance `AVB-A1`.

Contract: Baseline is immutable, versioned and clearly separates synthetic from actual integration observations.

Files:

- Create `src/benchmark/manifest.ts`.
- Create `src/benchmark/runner.ts`.
- Modify `src/cli.ts`.
- Test `test/ael-value-benchmark.test.ts`, case `AVB-A1`; fixture `test/fixtures/ael-value-benchmark/cases.json`.

- [ ] Add failing case `AVB-A1`: Record current failing behaviors before changes; reject unrecorded build substitution and incompatible scenario/environment revisions while allowing the declared baseline/candidate build difference.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=AVB-A1 dist/test/ael-value-benchmark.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Freeze build/corpus/environment identities and budgets before any repair. Run isolated synthetic regressions separately from controlled actual-host cases and store immutable baseline records with unavailable metrics explicit.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-value-benchmark r1` after GREEN.

## Task 2: B1 public pipeline corpus

Requirement `AVB-R2`. Acceptance `AVB-A2`.

Contract: Golden scenarios traverse the actual public pipeline and fault boundaries rather than returning prepared findings.

Files:

- Create `src/benchmark/runner.ts`.
- Create `test/fixtures/ael-value/scenarios.json`.
- Test `test/ael-value-benchmark.test.ts`, case `AVB-A2`; fixture `test/fixtures/ael-value-benchmark/cases.json`.

- [ ] Add failing case `AVB-A2`: Exercise resume, unknown result, recovery, scoped convention and typed verification through CLI and reopened SQLite stores.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=AVB-A2 dist/test/ael-value-benchmark.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Drive CLI admission, spool drain, worker, typed import and candidate review against isolated real stores. Compare semantic outputs with declared golden relations, not prepopulated findings.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-value-benchmark r2` after GREEN.

## Task 3: Safety rejection gates

Requirement `AVB-R3`. Acceptance `AVB-A3`.

Contract: Quality gates check correct scope, evidence and authority, not lesson count.

Files:

- Create `src/benchmark/compare.ts`.
- Create `test/fixtures/ael-value/scenarios.json`.
- Test `test/ael-value-benchmark.test.ts`, case `AVB-A3`; fixture `test/fixtures/ael-value-benchmark/cases.json`.

- [ ] Add failing case `AVB-A3`: Wrong-scope advice, secret persistence, passive intervention and unapproved promotion each fail the run regardless of task success.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=AVB-A3 dist/test/ael-value-benchmark.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Fail a run for any wrong-scope guidance, secret persistence, passive intervention or unapproved promotion. Add fault fixtures and check persisted tables/exports as well as CLI output.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-value-benchmark r3` after GREEN.

## Task 4: B2 paired measurement

Requirement `AVB-R4`. Acceptance `AVB-A4`.

Contract: Paired pilot measurements include AEL overhead and unavailable telemetry, with budgets fixed before the comparison.

Files:

- Create `src/benchmark/manifest.ts`.
- Create `src/benchmark/runner.ts`.
- Create `src/benchmark/compare.ts`.
- Test `test/ael-value-benchmark.test.ts`, case `AVB-A4`; fixture `test/fixtures/ael-value-benchmark/cases.json`.

- [ ] Add failing case `AVB-A4`: Run five paired cases per condition; report distributions and net metrics when available, otherwise performance-not-established.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=AVB-A4 dist/test/ael-value-benchmark.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Run at least five paired repetitions per scenario and condition after AAP. Record task result, redundant operations, wall time and available costs including AEL. Reject incompatible corpora/environments; paired builds may differ only as declared baseline/candidate identities.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-value-benchmark r4` after GREEN.

## Task 5: Local value decision

Requirement `AVB-R5`. Acceptance `AVB-A5`.

Contract: The local value pilot demonstrates reduced redundant work in its declared scenarios without false improvement claims.

Files:

- Create `src/benchmark/compare.ts`.
- Test `test/ael-value-benchmark.test.ts`, case `AVB-A5`; fixture `test/fixtures/ael-value-benchmark/cases.json`.

- [ ] Add failing case `AVB-A5`: Require correct task outcome and at least one fewer redundant operation in the median advice run versus its matched disabled baseline; no wrong-scope or authority violation is permitted.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=AVB-A5 dist/test/ael-value-benchmark.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Require correct task outcome and median reduction of at least one redundant operation for each declared pilot scenario. Report performance-not-established when telemetry cannot support a net-cost conclusion; do not substitute event counts for tokens.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-value-benchmark r5` after GREEN.

## Task 6: Requirement evidence manifest

Requirement `AVB-R6`. Acceptance `AVB-A6`.

Contract: Every accepted requirement links to a real verification artifact and documentation status matches qualified capability.

Files:

- Create `src/benchmark/manifest.ts`.
- Create `docs/product/ael-value-delivery-traceability.json`.
- Test `test/ael-value-benchmark.test.ts`, case `AVB-A6`; fixture `test/fixtures/ael-value-benchmark/cases.json`.

- [ ] Add failing case `AVB-A6`: Generate a requirement-to-test/run manifest, retain exclusions, and do not label this local pilot as full M7/M8/M9 completion.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=AVB-A6 dist/test/ael-value-benchmark.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Record actual verification report paths and accepted exclusions per requirement. Update only the capability statuses supported by artifacts; a local pilot cannot mark full cloud, SSO or cross-agent milestones complete.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-value-benchmark r6` after GREEN.

## Acceptance and rollback

- [ ] Run the focused acceptance and regression suites after the final implementation change:

```sh
rtk pnpm build
rtk proxy node --test dist/test/ael-value-benchmark.test.js dist/test/reliable-observation.test.js dist/test/analysis-worker.test.js
rtk pnpm check
rtk git diff --check
```

Expected: build and all selected/full checks exit 0; record actual test counts and any skipped cases. A host-dependent unsupported case remains explicitly unqualified rather than a passing integration.

- [ ] Exercise the complete user-visible path named in the specification in an isolated workspace, including negative scope, unknown evidence and restart cases. Component success cannot substitute for this path.
- [ ] For new tables or formats, interrupt migration and replay it twice; compare immutable old rows and foreign keys. Keep a pre-migration fixture and demonstrate a compatible rollback reader. Never run an incompatible old writer against an upgraded store.
- [ ] For new configuration or installation changes, restore the saved owned-file generation and verify unrelated hooks/settings are byte-identical. For feature-only changes, disable the feature and verify the passive path still operates.
- [ ] Write `docs/verification/2026-09-29-ael-value-benchmark.md` with build identity, exact commands/results, actual fixtures, requirement evidence, exclusions and migration/rollback outcome. Fill the corresponding verification paths in the traceability manifest only after execution.
- [ ] Review the implementation against every requirement and its privacy/authority constraints. Update the delivery status only to the level established by evidence; leave unqualified work open.

## Traceability

| Requirement | Acceptance | Implementation task | Test case |
|---|---|---|---|
| AVB-R1 | AVB-A1 | 1 | AVB-A1 |
| AVB-R2 | AVB-A2 | 2 | AVB-A2 |
| AVB-R3 | AVB-A3 | 3 | AVB-A3 |
| AVB-R4 | AVB-A4 | 4 | AVB-A4 |
| AVB-R5 | AVB-A5 | 5 | AVB-A5 |
| AVB-R6 | AVB-A6 | 6 | AVB-A6 |
