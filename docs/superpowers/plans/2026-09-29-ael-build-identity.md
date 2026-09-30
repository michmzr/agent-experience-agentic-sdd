# AEL build identity and installation alignment implementation plan

> For agentic workers: after approval, use `superpowers:executing-plans` task by task. Use subagents only with explicit authorization. Track the steps below; no step is completed by this document.

Goal: Identify the artifact actually invoked by each managed integration and align a selected installation through a reviewable, reversible operation. Separate artifact compatibility from a live end-to-end qualification.

Architecture: extend the existing local capture, evidence and knowledge boundaries identified in the specification. Preserve passive admission, immutable provenance and existing authority rules. Keep new responsibilities in the named modules instead of expanding unrelated runtime policy.

Tech stack: repository TypeScript, Node.js built-in SQLite and node:test, pnpm. No new production dependency is required by this plan.

## Status and inputs

Execution authorized by “Implement ABI specs”, 2026-09-29. Specification: [ABI](../specs/2026-09-29-ael-build-identity-design.md), status Approved for implementation. Dependencies: None for core; ARC for receipt persistence.

The user approved ABI execution. The plan was reviewed against current source and executed in the managed `abi-build-identity` worktree. Requirement evidence and implementation decisions are recorded in [verification](../../verification/2026-09-29-abi-implementation.md). Live installations and production databases are not changed by acceptance fixtures.

Read `.agents/SDD.md`, `.agents/QUALITY-GATES.md`, the linked specification and [delivery index](../../product/ael-value-delivery.md). Ownership of shared files is serialized between plans. No parallel edits to `src/cli.ts`, store, learning or retrieval files.

## File ownership

Create `test/ael-build-identity.test.ts` for requirement-level regression and public-path acceptance. Create `test/fixtures/ael-build-identity/cases.json` for sanitized scenario inputs and expected semantic relationships. Source paths below marked Create are proposed modules; Modify paths existed at planning time. Each task adds its own test to the same focused suite.

## Test method

Each task below is a small review unit containing multiple TDD steps. Start from the described fixture, assert the observable acceptance condition, run RED, implement the bounded change, run GREEN, and review its diff before committing that unit. A missing import is not sufficient RED evidence: establish the semantic failure after adding the minimal compiling interface. Test helpers must invoke the real public CLI or real store/service; they must not return prepared findings.

Use `node:test` and `node:assert/strict`. Every test name includes its acceptance ID. For migration/restart cases, close and reopen a temporary SQLite store; never point fixtures at the user database. Serialize returned records to inspect forbidden payload fields. Exact expected values and counterexamples are specified in each acceptance row.

ABI tasks 1–4 and task 5 admission/compatibility contract form the core prerequisite. The receipt persistence part of ABI-A5 closes with ARC task 4, after AEC. This deferred integration edge does not block AEC and must remain pending in the verification manifest.

## Execution record

Tasks 1–4 and task 5 admission/writer compatibility were implemented and verified. The immutable receipt-persistence part of ABI-A5 remains pending ARC task 4. Detailed command results, review fixes and rollback limitations are in the linked verification record. Step checkboxes below preserve the original task decomposition rather than asserting deferred acceptance.

## Task 1: Deterministic artifact manifest

Requirement `ABI-R1`. Acceptance `ABI-A1`.

Contract: Manifest identity is deterministic for identical shipped content, changes when shipped code changes, and does not equate two 0.0.0 artifacts.

Files:

- Create `src/installation/build-manifest.ts`.
- Modify `package.json`.
- Test `test/ael-build-identity.test.ts`, case `ABI-A1`; fixture `test/fixtures/ael-build-identity/cases.json`.

- [ ] Add failing case `ABI-A1`: Build twice, compare identities, then change one shipped byte and require a different identity.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ABI-A1 dist/test/ael-build-identity.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Canonicalize sorted relative artifact paths and SHA-256 content digests. Reject duplicate paths and escaping symlinks. Generate the manifest after compilation; exclude the manifest from its own digest.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-build-identity r1` after GREEN.

## Task 2: Read-only target inventory

Requirement `ABI-R2`. Acceptance `ABI-A2`.

Contract: Inventory resolves the actual managed wrapper target without executing it and distinguishes unknown, modified and missing targets.

Files:

- Create `src/installation/inspection.ts`.
- Modify `src/cli/hook-installation.ts`.
- Modify `src/cli.ts`.
- Test `test/ael-build-identity.test.ts`, case `ABI-A2`; fixture `test/fixtures/ael-build-identity/cases.json`.

- [ ] Add failing case `ABI-A2`: Inventory synthetic copies of the observed installation shapes; a trap wrapper is never executed.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ABI-A2 dist/test/ael-build-identity.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Parse only recognized managed wrapper syntax. Resolve the literal target as data and compare file hashes and capability fields. Return unknown for dynamic shell expansions; never execute an inventory target.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-build-identity r2` after GREEN.

## Task 3: Transactional alignment

Requirement `ABI-R3`. Acceptance `ABI-A3`.

Contract: Alignment uses hash-bound plans, preserves foreign hooks and supports idempotent apply and rollback.

Files:

- Create `src/installation/alignment.ts`.
- Modify `src/cli/hook-installation.ts`.
- Modify `src/cli.ts`.
- Test `test/ael-build-identity.test.ts`, case `ABI-A3`; fixture `test/fixtures/ael-build-identity/cases.json`.

- [ ] Add failing case `ABI-A3`: Race a file edit after plan creation; reject it. Inject failure after the first publication and verify restoration.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ABI-A3 dist/test/ael-build-identity.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Persist the selected old/new hashes and ownership boundary in a plan. Stage new files on the same filesystem, journal publication, restore on failure, and preserve unrelated hook groups.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-build-identity r3` after GREEN.

## Task 4: Installed lifecycle qualification

Requirement `ABI-R4`. Acceptance `ABI-A4`.

Contract: A qualified Codex integration delivers supported startup and resume signals and a correlated technical result through the installed artifact.

Files:

- Create `src/installation/qualification.ts`.
- Modify `src/cli/hook-installation.ts`.
- Test `test/ael-build-identity.test.ts`, case `ABI-A4`; fixture `test/fixtures/ael-build-identity/cases.json`.

- [ ] Add failing case `ABI-A4`: Run the lifecycle fixture through the installed package, then repeat with a matcher excluding resume and require qualification failure.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ABI-A4 dist/test/ael-build-identity.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Exercise the installed entrypoint in an isolated fixture workspace. Require both startup and resume admission plus a correlated result; a static inspection cannot set qualified.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-build-identity r4` after GREEN.

## Task 5: Writer compatibility and provenance contract

Requirement `ABI-R5`. Acceptance `ABI-A5`.

Contract: The actual build is attributable to new receipts and incompatible writer rollback is refused.

Files:

- Create `src/installation/build-manifest.ts`.
- Modify `src/capture/hook-ingress.ts`.
- Test `test/ael-build-identity.test.ts`, case `ABI-A5`; fixture `test/fixtures/ael-build-identity/cases.json`.

- [ ] Add failing case `ABI-A5`: Capture two distinct operations through verified installed artifacts with different shipped bytes and equal package versions. Reopen the receipt store and associate each retained accepted receipt with its operation using private correlation independent of build identity. Its capture build ID and writer capability must match the invoked capture artifact. Redeliver and retry one operation; require two unique operations despite extra transport and receipt counts. A retry receipt attributes its verified writer build, or unknown when unverified, without claiming the original capture build. Capture under build A, retry under B, then evict the accepted receipt; the retained retry receipt may attest B, while accepted-receipt attribution to A is unavailable and any surviving admission provenance for A stays separately labeled. Swap the two accepted-receipt build IDs in a fixture; the association check must fail even though the set of IDs is unchanged. Retain one receipt while preserving two admitted operations; require the health report to count two distinct admitted operations, one retained receipt and the retention window, without reporting a missing operation. Neither an evicted receipt nor an independently absent receipt gets a cause without durable evidence. Caller-provided or unverified identities cannot establish attribution, and historical receipts remain unknown. Reject an old writer against a newer store without changing its bytes.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=ABI-A5 dist/test/ael-build-identity.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Pass the actual artifact digest in the bounded admission envelope and reject incompatible writer rollback. With ARC task 4, persist the verified capture artifact in accepted receipts and the verified current writer in retry receipts; label their roles separately. Do not copy admission provenance into a retry receipt as proof of its writer, infer identity for historical receipts or trust a caller-supplied value. ABI core inventory does not wait for that storage integration.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-build-identity r5` after GREEN.

## Lock recovery amendment

Authorized by the user on 2026-09-29. Replace the directory/owner-file lock with a process-held SQLite write transaction in `src/installation/alignment-lock.ts`, acquired before journal publication and released by process exit. Add ABI-A3 regressions for immediate interruption, live contention and SIGKILL release. Preserve unrecognized legacy metadata and keep ownership/symlink checks before acquisition. Mark the new lock file with an application ID before use; reject a foreign SQLite database at that path without changing its bytes or mode. Rerun focused ABI/hook tests and `pnpm check` after the final source change.

## Acceptance and rollback

- [ ] Run the focused acceptance and regression suites after the final implementation change:

```sh
rtk pnpm build
rtk proxy node --test dist/test/ael-build-identity.test.js dist/test/hook-installation.test.js dist/test/hook-readiness.test.js dist/test/project-hook-configuration.test.js
rtk pnpm check
rtk git diff --check
```

Expected: build and all selected/full checks exit 0; record actual test counts and any skipped cases. A host-dependent unsupported case remains explicitly unqualified rather than a passing integration.

- [ ] Exercise the complete user-visible path named in the specification in an isolated workspace, including negative scope, unknown evidence and restart cases. Component success cannot substitute for this path.
- [ ] For new tables or formats, interrupt migration and replay it twice; compare immutable old rows and foreign keys. Keep a pre-migration fixture and demonstrate a compatible rollback reader. Never run an incompatible old writer against an upgraded store.
- [ ] For new configuration or installation changes, restore the saved owned-file generation and verify unrelated hooks/settings are byte-identical. For feature-only changes, disable the feature and verify the passive path still operates.
- [ ] Write `docs/verification/2026-09-29-ael-build-identity.md` with build identity, exact commands/results, actual fixtures, requirement evidence, exclusions and migration/rollback outcome. Fill the corresponding verification paths in the traceability manifest only after execution.
- [ ] Review the implementation against every requirement and its privacy/authority constraints. Update the delivery status only to the level established by evidence; leave unqualified work open.

## Traceability

| Requirement | Acceptance | Implementation task | Test case |
|---|---|---|---|
| ABI-R1 | ABI-A1 | 1 | ABI-A1 |
| ABI-R2 | ABI-A2 | 2 | ABI-A2 |
| ABI-R3 | ABI-A3 | 3 | ABI-A3 |
| ABI-R4 | ABI-A4 | 4 | ABI-A4 |
| ABI-R5 | ABI-A5 | 5 | ABI-A5 |
