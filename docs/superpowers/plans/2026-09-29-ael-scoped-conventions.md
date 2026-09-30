# AEL scoped instruction conventions implementation plan

> For agentic workers: after approval, use `superpowers:executing-plans` task by task. Use subagents only with explicit authorization. Track the steps below; no step is completed by this document.

Goal: Recognize a finite set of explicit conventions in configured instruction files, preserve their scope and historical provenance, and produce inspectable candidates without claiming instructions were delivered to an agent.

Architecture: extend the existing local capture, evidence and knowledge boundaries identified in the specification. Preserve passive admission, immutable provenance and existing authority rules. Keep new responsibilities in the named modules instead of expanding unrelated runtime policy.

Tech stack: repository TypeScript, Node.js built-in SQLite and node:test, pnpm. No new production dependency is required by this plan.

## Status and inputs

Proposed, 2026-09-29. Specification: [ASC](../specs/2026-09-29-ael-scoped-conventions-design.md), status Draft. Dependencies: AEC.

The user explicitly requested specifications and plans together. This is a proposed task decomposition prepared before approval, not an executable authorization. Before execution, record spec approval, review this plan against the then-current source, and prepare an isolated checkout when implementation needs isolation. Do not change live project installations or databases merely to run a test.

Read `.agents/SDD.md`, `.agents/QUALITY-GATES.md`, the linked specification and [delivery index](../../product/ael-value-delivery.md). Ownership of shared files is serialized between plans. No parallel edits to `src/cli.ts`, store, learning or retrieval files.

## File ownership

Create `test/ael-scoped-conventions.test.ts` for requirement-level regression and public-path acceptance. Create `test/fixtures/ael-scoped-conventions/cases.json` for sanitized scenario inputs and expected semantic relationships. Source paths below marked Create are proposed modules; Modify paths existed at planning time. Each task adds its own test to the same focused suite.

## Test method

Each task below is a small review unit containing multiple TDD steps. Start from the described fixture, assert the observable acceptance condition, run RED, implement the bounded change, run GREEN, and review its diff before committing that unit. A missing import is not sufficient RED evidence: establish the semantic failure after adding the minimal compiling interface. Test helpers must invoke the real public CLI or real store/service; they must not return prepared findings.

Use `node:test` and `node:assert/strict`. Every test name includes its acceptance ID. For migration/restart cases, close and reopen a temporary SQLite store; never point fixtures at the user database. Serialize returned records to inspect forbidden payload fields. Exact expected values and counterexamples are specified in each acceptance row.

## Task 1: Explicit directive grammar

Requirement `ASC-R1`. Acceptance `ASC-A1`.

Contract: The finite directive grammar recognizes the observed forms and rejects mentions, negation and code examples.

Files:

- Modify `src/learning/project-conventions.ts`.
- Test `test/ael-scoped-conventions.test.ts`, case `ASC-A1`; fixture `test/fixtures/ael-scoped-conventions/cases.json`.

- [ ] Add failing case `ASC-A1`: Use pnpm (never npm) and pnpm only produce directives; a quoted example and a sentence forbidding that convention do not.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ASC-A1 dist/test/ael-scoped-conventions.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Add versioned finite patterns for the observed pnpm and uv directives. Parse instruction context before matching, excluding quoted examples, prohibited conventions and incidental mentions.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-scoped-conventions r1` after GREEN.

## Task 2: Resolved subproject scope

Requirement `ASC-R2`. Acceptance `ASC-A2`.

Contract: Directive applicability preserves explicit subproject scope and refuses ambiguous scope.

Files:

- Modify `src/config/project-settings.ts`.
- Modify `src/learning/project-conventions.ts`.
- Modify `src/learning/contracts.ts`.
- Test `test/ael-scoped-conventions.test.ts`, case `ASC-A2`; fixture `test/fixtures/ael-scoped-conventions/cases.json`.

- [ ] Add failing case `ASC-A2`: A mobile-only rule applies to the configured mobile path and not to backend or an unmapped project.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ASC-A2 dist/test/ael-scoped-conventions.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Validate at most 16 explicit scope mappings to repository-relative paths. Reject traversal and boundary-crossing symlinks; retain unresolved scope as non-actionable evidence.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-scoped-conventions r2` after GREEN.

## Task 3: Immutable instruction provenance

Requirement `ASC-R3`. Acceptance `ASC-A3`.

Contract: Context revisions are immutable and found/delivered/read provenance remains independent.

Files:

- Modify `src/learning/repository.ts`.
- Modify `src/learning/service.ts`.
- Test `test/ael-scoped-conventions.test.ts`, case `ASC-A3`; fixture `test/fixtures/ael-scoped-conventions/cases.json`.

- [ ] Add failing case `ASC-A3`: Edit the instruction after capture; the old operation retains its original directive and unknown delivery state.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ASC-A3 dist/test/ael-scoped-conventions.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Persist instruction revision and resolved scope with independent found/read/delivered facts. Never overwrite the snapshot used by an admitted operation after an instruction edit.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-scoped-conventions r3` after GREEN.

## Task 4: Versioned reanalysis

Requirement `ASC-R4`. Acceptance `ASC-A4`.

Contract: Parser changes are versioned and cannot backdate current instructions into legacy sessions.

Files:

- Modify `src/learning/detectors.ts`.
- Modify `src/learning/repository.ts`.
- Test `test/ael-scoped-conventions.test.ts`, case `ASC-A4`; fixture `test/fixtures/ael-scoped-conventions/cases.json`.

- [ ] Add failing case `ASC-A4`: Reprocess an old session without retained instruction facts and report insufficient historical context.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ASC-A4 dist/test/ael-scoped-conventions.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Include parser/input revision in detector stream identity. Reuse retained historical context only; absent historical instruction evidence produces an explicit gap, never a current-file substitute.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-scoped-conventions r4` after GREEN.

## Task 5: Bounded snapshot acquisition

Requirement `ASC-R5`. Acceptance `ASC-A5`.

Contract: Privacy and context acquisition budgets are preserved without reading every instruction file on every event.

Files:

- Modify `src/learning/service.ts`.
- Modify `src/learning/project-conventions.ts`.
- Test `test/ael-scoped-conventions.test.ts`, case `ASC-A5`; fixture `test/fixtures/ael-scoped-conventions/cases.json`.

- [ ] Add failing case `ASC-A5`: Credential-bearing, oversized and escaping files produce no leaked candidate; repeated admissions reuse the stored snapshot.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ASC-A5 dist/test/ael-scoped-conventions.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Load an existing snapshot before opening instruction files. Enforce configured location count and 128 KiB file limits, sanitize before persistence, and measure admissions against small and large retained histories.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-scoped-conventions r5` after GREEN.

## Acceptance and rollback

- [ ] Run the focused acceptance and regression suites after the final implementation change:

```sh
rtk pnpm build
rtk proxy node --test dist/test/ael-scoped-conventions.test.js dist/test/learning-project-conventions.test.js dist/test/learning-service.test.js
rtk pnpm check
rtk git diff --check
```

Expected: build and all selected/full checks exit 0; record actual test counts and any skipped cases. A host-dependent unsupported case remains explicitly unqualified rather than a passing integration.

- [ ] Exercise the complete user-visible path named in the specification in an isolated workspace, including negative scope, unknown evidence and restart cases. Component success cannot substitute for this path.
- [ ] For new tables or formats, interrupt migration and replay it twice; compare immutable old rows and foreign keys. Keep a pre-migration fixture and demonstrate a compatible rollback reader. Never run an incompatible old writer against an upgraded store.
- [ ] For new configuration or installation changes, restore the saved owned-file generation and verify unrelated hooks/settings are byte-identical. For feature-only changes, disable the feature and verify the passive path still operates.
- [ ] Write `docs/verification/2026-09-29-ael-scoped-conventions.md` with build identity, exact commands/results, actual fixtures, requirement evidence, exclusions and migration/rollback outcome. Fill the corresponding verification paths in the traceability manifest only after execution.
- [ ] Review the implementation against every requirement and its privacy/authority constraints. Update the delivery status only to the level established by evidence; leave unqualified work open.

## Traceability

| Requirement | Acceptance | Implementation task | Test case |
|---|---|---|---|
| ASC-R1 | ASC-A1 | 1 | ASC-A1 |
| ASC-R2 | ASC-A2 | 2 | ASC-A2 |
| ASC-R3 | ASC-A3 | 3 | ASC-A3 |
| ASC-R4 | ASC-A4 | 4 | ASC-A4 |
| ASC-R5 | ASC-A5 | 5 | ASC-A5 |
