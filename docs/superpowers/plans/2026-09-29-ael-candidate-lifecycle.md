# AEL candidate review and knowledge lifecycle integration implementation plan

> For agentic workers: after approval, use `superpowers:executing-plans` task by task. Use subagents only with explicit authorization. Track the steps below; no step is completed by this document.

Goal: Create one inspectable local candidate review path, attach repeat evidence to stable logical candidates and make accepted knowledge retrievable under the existing lifecycle and authority boundaries.

Architecture: extend the existing local capture, evidence and knowledge boundaries identified in the specification. Preserve passive admission, immutable provenance and existing authority rules. Keep new responsibilities in the named modules instead of expanding unrelated runtime policy.

Tech stack: repository TypeScript, Node.js built-in SQLite and node:test, pnpm. No new production dependency is required by this plan.

## Status and inputs

Execution authorized 2026-09-30; drafted 2026-09-29. Specification: [ACL](../specs/2026-09-29-ael-candidate-lifecycle-design.md), status Approved for implementation. Dependencies: ASC, ATI.

On 2026-09-30 the user authorized implementation of all eight AEL specifications and requested subagents. Before each task, review this plan against current source and work in an isolated checkout with explicit file ownership. Do not change live project installations or databases merely to run a test.

Read `.agents/SDD.md`, `.agents/QUALITY-GATES.md`, the linked specification and [delivery index](../../product/ael-value-delivery.md). Ownership of shared files is serialized between plans. No parallel edits to `src/cli.ts`, store, learning or retrieval files.

## File ownership

Create `test/ael-candidate-lifecycle.test.ts` for requirement-level regression and public-path acceptance. Create `test/fixtures/ael-candidate-lifecycle/cases.json` for sanitized scenario inputs and expected semantic relationships. Source paths below marked Create are proposed modules; Modify paths existed at planning time. Each task adds its own test to the same focused suite.

## Test method

Each task below is a small review unit containing multiple TDD steps. Start from the described fixture, assert the observable acceptance condition, run RED, implement the bounded change, run GREEN, and review its diff before committing that unit. A missing import is not sufficient RED evidence: establish the semantic failure after adding the minimal compiling interface. Test helpers must invoke the real public CLI or real store/service; they must not return prepared findings.

Use `node:test` and `node:assert/strict`. Every test name includes its acceptance ID. For migration/restart cases, close and reopen a temporary SQLite store; never point fixtures at the user database. Serialize returned records to inspect forbidden payload fields. Exact expected values and counterexamples are specified in each acceptance row.

## Task 1: Canonical candidate inbox

Requirement `ACL-R1`. Acceptance `ACL-A1`.

Contract: Operational and opted-in manual-review candidates are inspectable through one inbox with provenance.

Files:

- Create `src/knowledge/candidate-service.ts`.
- Create `src/knowledge/candidate-repository.ts`.
- Modify `src/cli.ts`.
- Test `test/ael-candidate-lifecycle.test.ts`, case `ACL-A1`; fixture `test/fixtures/ael-candidate-lifecycle/cases.json`.

- [ ] Add failing case `ACL-A1`: A convention and a review finding appear with their different origins after restart.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ACL-A1 dist/test/ael-candidate-lifecycle.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Persist producer origin references in the private store; list and inspect operational and explicitly opted-in manual candidates without changing lifecycle state.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-candidate-lifecycle r1` after GREEN.

## Task 2: Stable scoped identity

Requirement `ACL-R2`. Acceptance `ACL-A2`.

Contract: Logical candidate identity deduplicates unchanged propositions across sessions without merging incompatible scope.

Files:

- Create `src/knowledge/candidate-identity.ts`.
- Modify `src/learning/repository.ts`.
- Create `src/knowledge/candidate-repository.ts`.
- Test `test/ael-candidate-lifecycle.test.ts`, case `ACL-A2`; fixture `test/fixtures/ael-candidate-lifecycle/cases.json`.

- [ ] Add failing case `ACL-A2`: Two equivalent scoped episodes create one candidate with two origins; a changed subproject or procedure remains separate.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ACL-A2 dist/test/ael-candidate-lifecycle.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Hash versioned repository/kind/applicability/proposition keys. Keep episode IDs as origins. Create separate candidates when semantic keys are unavailable; never fuzzy-merge prose or incompatible scope.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-candidate-lifecycle r2` after GREEN.

## Task 3: Evidence-qualified review

Requirement `ACL-R3`. Acceptance `ACL-A3`.

Contract: Review validates lifecycle, evidence independence and verification eligibility without automatic promotion.

Files:

- Create `src/knowledge/candidate-service.ts`.
- Modify `src/domain/transitions.ts`.
- Modify `src/cli.ts`.
- Test `test/ael-candidate-lifecycle.test.ts`, case `ACL-A3`; fixture `test/fixtures/ael-candidate-lifecycle/cases.json`.

- [ ] Add failing case `ACL-A3`: Reject a direct candidate-to-verified request, duplicate confirmations and a repair without task verification; preserve valid staged transitions.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ACL-A3 dist/test/ael-candidate-lifecycle.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Validate new independent evidence and allowed transitions before calling existing lifecycle functions. Reject direct verified promotion, repeated confirmations and unverified repairs atomically.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-candidate-lifecycle r3` after GREEN.

## Task 4: Retrieval bridge

Requirement `ACL-R4`. Acceptance `ACL-A4`.

Contract: Accepted local knowledge is retrievable with its actual lifecycle and structured applicability.

Files:

- Create `src/knowledge/candidate-repository.ts`.
- Modify `src/repository/local-repository.ts`.
- Modify `src/application/experience-service.ts`.
- Test `test/ael-candidate-lifecycle.test.ts`, case `ACL-A4`; fixture `test/fixtures/ael-candidate-lifecycle/cases.json`.

- [ ] Add failing case `ACL-A4`: After accepted observed transition, lessons/retrieve exposes the same canonical entry; wrong-scope and terminal entries are excluded from actionable use.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ACL-A4 dist/test/ael-candidate-lifecycle.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Materialize the canonical local entry at accepted observed transition, preserving ID/state and typed provenance. Apply structured scope on retrieval; actionable advice requires the stricter verified filter.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-candidate-lifecycle r4` after GREEN.

## Task 5: Dispute and revision history

Requirement `ACL-R5`. Acceptance `ACL-A5`.

Contract: Contradictions and freshness changes preserve audit history and suppress actionable stale knowledge.

Files:

- Create `src/knowledge/candidate-service.ts`.
- Create `src/knowledge/candidate-repository.ts`.
- Test `test/ael-candidate-lifecycle.test.ts`, case `ACL-A5`; fixture `test/fixtures/ael-candidate-lifecycle/cases.json`.

- [ ] Add failing case `ACL-A5`: Attach contradiction, inspect disputed state, and require explicit qualifying revalidation before renewed eligibility.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ACL-A5 dist/test/ael-candidate-lifecycle.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Append contradiction, freshness and supersession facts without rewriting origins. Remove disputed/stale entries from actionable eligibility and require explicit qualifying revalidation.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-candidate-lifecycle r5` after GREEN.

## Task 6: Manual review kind fidelity

Requirement `ACL-R6`. Acceptance `ACL-A6`.

Contract: Manual-review lesson kinds reflect their source findings and ambiguous history is not relabeled successful.

Files:

- Modify `src/review/review-service.ts`.
- Modify `src/review/contracts.ts`.
- Create `src/knowledge/candidate-service.ts`.
- Test `test/ael-candidate-lifecycle.test.ts`, case `ACL-A6`; fixture `test/fixtures/ael-candidate-lifecycle/cases.json`.

- [ ] Add failing case `ACL-A6`: Failure and project-fact cases retain their kinds; a legacy ambiguous record remains review-required.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ACL-A6 dist/test/ael-candidate-lifecycle.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Preserve justified source finding kinds. Keep ambiguous legacy records in review-required inbox state outside the domain enum until classified; add an explicit opt-in sink.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-candidate-lifecycle r6` after GREEN.

## Task 7: Transactional origin migration

Requirement `ACL-R7`. Acceptance `ACL-A7`.

Contract: Migration and transactions preserve existing knowledge, privacy and the Git authority boundary.

Files:

- Create `src/knowledge/candidate-repository.ts`.
- Modify `src/storage/experience-store.ts`.
- Test `test/ael-candidate-lifecycle.test.ts`, case `ACL-A7`; fixture `test/fixtures/ael-candidate-lifecycle/cases.json`.

- [ ] Add failing case `ACL-A7`: Interrupt candidate backfill/review, retry without duplicates, and verify no runtime directive or shared file was created.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ACL-A7 dist/test/ael-candidate-lifecycle.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Backfill only origin links under a previewed cursor. Preserve existing knowledge and IDs, roll back partial review transactions, and assert no shared Git file or enforcing directive is generated.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-candidate-lifecycle r7` after GREEN.

## Acceptance and rollback

- [ ] Run the focused acceptance and regression suites after the final implementation change:

```sh
rtk pnpm build
rtk proxy node --test dist/test/ael-candidate-lifecycle.test.js dist/test/knowledge-promotion.test.js dist/test/retrieval-and-retention.test.js dist/test/review-proposals.test.js
rtk pnpm check
rtk git diff --check
```

Expected: build and all selected/full checks exit 0; record actual test counts and any skipped cases. A host-dependent unsupported case remains explicitly unqualified rather than a passing integration.

- [ ] Exercise the complete user-visible path named in the specification in an isolated workspace, including negative scope, unknown evidence and restart cases. Component success cannot substitute for this path.
- [ ] For new tables or formats, interrupt migration and replay it twice; compare immutable old rows and foreign keys. Keep a pre-migration fixture and demonstrate a compatible rollback reader. Never run an incompatible old writer against an upgraded store.
- [ ] For new configuration or installation changes, restore the saved owned-file generation and verify unrelated hooks/settings are byte-identical. For feature-only changes, disable the feature and verify the passive path still operates.
- [ ] Write `docs/verification/2026-09-29-ael-candidate-lifecycle.md` with build identity, exact commands/results, actual fixtures, requirement evidence, exclusions and migration/rollback outcome. Fill the corresponding verification paths in the traceability manifest only after execution.
- [ ] Review the implementation against every requirement and its privacy/authority constraints. Update the delivery status only to the level established by evidence; leave unqualified work open.

## Traceability

| Requirement | Acceptance | Implementation task | Test case |
|---|---|---|---|
| ACL-R1 | ACL-A1 | 1 | ACL-A1 |
| ACL-R2 | ACL-A2 | 2 | ACL-A2 |
| ACL-R3 | ACL-A3 | 3 | ACL-A3 |
| ACL-R4 | ACL-A4 | 4 | ACL-A4 |
| ACL-R5 | ACL-A5 | 5 | ACL-A5 |
| ACL-R6 | ACL-A6 | 6 | ACL-A6 |
| ACL-R7 | ACL-A7 | 7 | ACL-A7 |
