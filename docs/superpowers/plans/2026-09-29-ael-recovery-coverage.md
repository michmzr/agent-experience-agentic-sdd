# AEL recovery and scoped analysis coverage implementation plan

> For agentic workers: after approval, use `superpowers:executing-plans` task by task. Use subagents only with explicit authorization. Track the steps below; no step is completed by this document.

Goal: Make delivery gaps diagnosable and recoverable without endless unproductive retries, reconcile retained operations with analysis admission, and report scoped coverage honestly.

Architecture: extend the existing local capture, evidence and knowledge boundaries identified in the specification. Preserve passive admission, immutable provenance and existing authority rules. Keep new responsibilities in the named modules instead of expanding unrelated runtime policy.

Tech stack: repository TypeScript, Node.js built-in SQLite and node:test, pnpm. No new production dependency is required by this plan.

## Status and inputs

Execution authorized 2026-09-30; drafted 2026-09-29. Specification: [ARC](../specs/2026-09-29-ael-recovery-coverage-design.md), status Approved for implementation. Dependencies: AEC.

On 2026-09-30 the user authorized implementation of all eight AEL specifications and requested subagents. Before each task, review this plan against current source and work in an isolated checkout with explicit file ownership. Do not change live project installations or databases merely to run a test.

Read `.agents/SDD.md`, `.agents/QUALITY-GATES.md`, the linked specification and [delivery index](../../product/ael-value-delivery.md). Ownership of shared files is serialized between plans. No parallel edits to `src/cli.ts`, store, learning or retrieval files.

## File ownership

Create `test/ael-recovery-coverage.test.ts` for requirement-level regression and public-path acceptance. Create `test/fixtures/ael-recovery-coverage/cases.json` for sanitized scenario inputs and expected semantic relationships. Source paths below marked Create are proposed modules; Modify paths existed at planning time. Each task adds its own test to the same focused suite.

## Test method

Each task below is a small review unit containing multiple TDD steps. Start from the described fixture, assert the observable acceptance condition, run RED, implement the bounded change, run GREEN, and review its diff before committing that unit. A missing import is not sufficient RED evidence: establish the semantic failure after adding the minimal compiling interface. Test helpers must invoke the real public CLI or real store/service; they must not return prepared findings.

Use `node:test` and `node:assert/strict`. Every test name includes its acceptance ID. For migration/restart cases, close and reopen a temporary SQLite store; never point fixtures at the user database. Serialize returned records to inspect forbidden payload fields. Exact expected values and counterexamples are specified in each acceptance row.

## Task 1: Typed recovery state

Requirement `ARC-R1`. Acceptance `ARC-A1`.

Contract: Delivery failures have fixed typed causes and bounded automatic attempts with preserved held/dependency-waiting records.

Files:

- Modify `src/capture/spool.ts`.
- Modify `src/capture/spool-drain.ts`.
- Modify `src/capture/contracts.ts`.
- Test `test/ael-recovery-coverage.test.ts`, case `ARC-A1`; fixture `test/fixtures/ael-recovery-coverage/cases.json`.

- [ ] Add failing case `ARC-A1`: A permanently missing request does not accumulate unbounded retries; its later arrival enables one new eligible generation.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ARC-A1 dist/test/ael-recovery-coverage.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Add a recovery metadata side table with typed reasons, generation and attempts. Cap automatic transient attempts at four; wait for missing dependencies; only relevant dependency arrival or explicit apply opens a new generation.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-recovery-coverage r1` after GREEN.

## Task 2: Scoped recovery plans

Requirement `ARC-R2`. Acceptance `ARC-A2`.

Contract: Recovery plans are bounded, hash-bound, scope-bound and idempotent without erasing original quarantine provenance.

Files:

- Create `src/capture/recovery.ts`.
- Modify `src/cli.ts`.
- Test `test/ael-recovery-coverage.test.ts`, case `ARC-A2`; fixture `test/fixtures/ael-recovery-coverage/cases.json`.

- [ ] Add failing case `ARC-A2`: Replay a eligible selected record once; repeat apply, inject a conflicting row and interrupt midway without duplicate effects.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ARC-A2 dist/test/ael-recovery-coverage.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Preview at most 100 selected records with hashes, repository and eligibility reason. Apply only matching selections, preserve original quarantine classification, and use existing idempotent sink identities across interruption.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-recovery-coverage r2` after GREEN.

## Task 3: Analysis reconciliation

Requirement `ARC-R3`. Acceptance `ARC-A3`.

Contract: Reconciliation admits missing detector work for retained operations, including pre-upgrade and resumed data.

Files:

- Create `src/learning/reconciliation.ts`.
- Modify `src/learning/repository.ts`.
- Modify `src/cli.ts`.
- Test `test/ael-recovery-coverage.test.ts`, case `ARC-A3`; fixture `test/fixtures/ael-recovery-coverage/cases.json`.

- [ ] Add failing case `ARC-A3`: A captured session with no job becomes analyzable through --apply; a second reconcile reports no added work.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ARC-A3 dist/test/ael-recovery-coverage.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Page the logical index and compare detector/version watermarks. Default to a read-only diff; --apply admits missing jobs idempotently and records explicit opt-out override scope.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-recovery-coverage r3` after GREEN.

## Task 4: Scoped receipts and health v3

Requirement `ARC-R4`. Acceptance `ARC-A4`.

Contract: Health counts distinguish transport, operations, scope, retention and trusted source denominators.

Files:

- Create `src/capture/receipts.ts`.
- Modify `src/capture/hook-ingress.ts`.
- Modify `src/application/experience-service.ts`.
- Modify `src/cli.ts`.
- Test `test/ael-recovery-coverage.test.ts`, case `ARC-A4`; fixture `test/fixtures/ael-recovery-coverage/cases.json`.

- [ ] Add failing case `ARC-A4`: Mixed repositories and repeated delivery do not inflate unique operations; missing source denominator yields unavailable, not 100%.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ARC-A4 dist/test/ael-recovery-coverage.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Store bounded repository/source/class/build receipt fields and retention window. Count deliveries separately from unique operations, expose unavailable source denominator, and complete ABI task 5 provenance integration.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-recovery-coverage r4` after GREEN.

## Task 5: Detector evaluation states

Requirement `ARC-R5`. Acceptance `ARC-A5`.

Contract: Detector applicability and data sufficiency remain distinct from job completion and empty findings.

Files:

- Modify `src/learning/contracts.ts`.
- Modify `src/learning/service.ts`.
- Modify `src/application/experience-service.ts`.
- Test `test/ael-recovery-coverage.test.ts`, case `ARC-A5`; fixture `test/fixtures/ael-recovery-coverage/cases.json`.

- [ ] Add failing case `ARC-A5`: An all-unknown result set yields insufficient-evidence for repairs even after its job completes.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ARC-A5 dist/test/ael-recovery-coverage.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Persist applicability, required-evidence sufficiency and completed range independently from job status. Only eligible complete input can yield evaluated-no-findings; unknown-only repairs yield insufficient-evidence.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-recovery-coverage r5` after GREEN.

## Task 6: Fault and compatibility boundary

Requirement `ARC-R6`. Acceptance `ARC-A6`.

Contract: Legacy reports, opt-out behavior and fail-open capture remain compatible through faults and migration.

Files:

- Modify `src/capture/spool-drain.ts`.
- Modify `src/learning/worker.ts`.
- Modify `src/application/experience-service.ts`.
- Test `test/ael-recovery-coverage.test.ts`, case `ARC-A6`; fixture `test/fixtures/ael-recovery-coverage/cases.json`.

- [ ] Add failing case `ARC-A6`: Run v1/v2 golden outputs, disabled automatic learning, lease recovery and full store-unavailability cases.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ARC-A6 dist/test/ael-recovery-coverage.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Keep v1/v2 serialization unchanged. Preserve capture fail-open and disabled automatic learning; verify lease expiry, held rows, unavailable storage and interrupted upgrades without deleting evidence.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-recovery-coverage r6` after GREEN.

## Acceptance and rollback

- [ ] Run the focused acceptance and regression suites after the final implementation change:

```sh
rtk pnpm build
rtk proxy node --test dist/test/ael-recovery-coverage.test.js dist/test/capture-spool.test.js dist/test/analysis-worker.test.js dist/test/repository-observability.test.js
rtk pnpm check
rtk git diff --check
```

Expected: build and all selected/full checks exit 0; record actual test counts and any skipped cases. A host-dependent unsupported case remains explicitly unqualified rather than a passing integration.

- [ ] Exercise the complete user-visible path named in the specification in an isolated workspace, including negative scope, unknown evidence and restart cases. Component success cannot substitute for this path.
- [ ] For new tables or formats, interrupt migration and replay it twice; compare immutable old rows and foreign keys. Keep a pre-migration fixture and demonstrate a compatible rollback reader. Never run an incompatible old writer against an upgraded store.
- [ ] For new configuration or installation changes, restore the saved owned-file generation and verify unrelated hooks/settings are byte-identical. For feature-only changes, disable the feature and verify the passive path still operates.
- [ ] Write `docs/verification/2026-09-29-ael-recovery-coverage.md` with build identity, exact commands/results, actual fixtures, requirement evidence, exclusions and migration/rollback outcome. Fill the corresponding verification paths in the traceability manifest only after execution.
- [ ] Review the implementation against every requirement and its privacy/authority constraints. Update the delivery status only to the level established by evidence; leave unqualified work open.

## Traceability

| Requirement | Acceptance | Implementation task | Test case |
|---|---|---|---|
| ARC-R1 | ARC-A1 | 1 | ARC-A1 |
| ARC-R2 | ARC-A2 | 2 | ARC-A2 |
| ARC-R3 | ARC-A3 | 3 | ARC-A3 |
| ARC-R4 | ARC-A4 | 4 | ARC-A4 |
| ARC-R5 | ARC-A5 | 5 | ARC-A5 |
| ARC-R6 | ARC-A6 | 6 | ARC-A6 |
