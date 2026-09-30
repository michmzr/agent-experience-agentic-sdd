# AEL opt-in local advisory pilot implementation plan

> For agentic workers: after approval, use `superpowers:executing-plans` task by task. Use subagents only with explicit authorization. Track the steps below; no step is completed by this document.

Goal: Demonstrate local session A to session B reuse in one explicitly enabled integration, preserving scope, lifecycle and passive behavior. Keep retrieval, delivery, use and outcome as separately supported facts.

Architecture: extend the existing local capture, evidence and knowledge boundaries identified in the specification. Preserve passive admission, immutable provenance and existing authority rules. Keep new responsibilities in the named modules instead of expanding unrelated runtime policy.

Tech stack: repository TypeScript, Node.js built-in SQLite and node:test, pnpm. No new production dependency is required by this plan.

## Status and inputs

Proposed, 2026-09-29. Specification: [AAP](../specs/2026-09-29-ael-advisory-pilot-design.md), status Draft. Dependencies: ABI, ARC, ACL.

The user explicitly requested specifications and plans together. This is a proposed task decomposition prepared before approval, not an executable authorization. Before execution, record spec approval, review this plan against the then-current source, and prepare an isolated checkout when implementation needs isolation. Do not change live project installations or databases merely to run a test.

Read `.agents/SDD.md`, `.agents/QUALITY-GATES.md`, the linked specification and [delivery index](../../product/ael-value-delivery.md). Ownership of shared files is serialized between plans. No parallel edits to `src/cli.ts`, store, learning or retrieval files.

## File ownership

Create `test/ael-advisory-pilot.test.ts` for requirement-level regression and public-path acceptance. Create `test/fixtures/ael-advisory-pilot/cases.json` for sanitized scenario inputs and expected semantic relationships. Source paths below marked Create are proposed modules; Modify paths existed at planning time. Each task adds its own test to the same focused suite.

## Test method

Each task below is a small review unit containing multiple TDD steps. Start from the described fixture, assert the observable acceptance condition, run RED, implement the bounded change, run GREEN, and review its diff before committing that unit. A missing import is not sufficient RED evidence: establish the semantic failure after adding the minimal compiling interface. Test helpers must invoke the real public CLI or real store/service; they must not return prepared findings.

Use `node:test` and `node:assert/strict`. Every test name includes its acceptance ID. For migration/restart cases, close and reopen a temporary SQLite store; never point fixtures at the user database. Serialize returned records to inspect forbidden payload fields. Exact expected values and counterexamples are specified in each acceptance row.

## Task 1: Explicit pilot configuration

Requirement `AAP-R1`. Acceptance `AAP-A1`.

Contract: Advice is default-off and independent of passive capture and enforcement.

Files:

- Create `src/advisory/settings.ts`.
- Modify `src/config/project-settings.ts`.
- Modify `src/cli.ts`.
- Test `test/ael-advisory-pilot.test.ts`, case `AAP-A1`; fixture `test/fixtures/ael-advisory-pilot/cases.json`.

- [ ] Add failing case `AAP-A1`: Install/upgrade and ordinary capture emit no advice; disabling the pilot stops future delivery without deleting history.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=AAP-A1 dist/test/ael-advisory-pilot.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Create separate default-off per-repository advisory settings. Configure via explicit command only; keep passive capture and runtime enforcement switches independent.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-advisory-pilot r1` after GREEN.

## Task 2: Bounded eligible retrieval

Requirement `AAP-R2`. Acceptance `AAP-A2`.

Contract: Retrieval enforces lifecycle, exact scope, context freshness, item/byte/time budgets and deduplication.

Files:

- Create `src/advisory/service.ts`.
- Modify `src/repository/local-repository.ts`.
- Test `test/ael-advisory-pilot.test.ts`, case `AAP-A2`; fixture `test/fixtures/ael-advisory-pilot/cases.json`.

- [ ] Add failing case `AAP-A2`: Wrong repository, subproject, stale revision, dispute and budget exhaustion produce no actionable guidance.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=AAP-A2 dist/test/ael-advisory-pilot.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Filter verified entries by exact scope and freshness before selection. Return at most three entries and 4096 UTF-8 bytes within a 200 ms lookup budget; timeout abstains and reports a bounded reason.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-advisory-pilot r2` after GREEN.

## Task 3: Witnessed usage facts

Requirement `AAP-R3`. Acceptance `AAP-A3`.

Contract: Usage facts retain distinct evidence for retrieval, delivery, selection, application and result.

Files:

- Create `src/advisory/usage.ts`.
- Create `src/advisory/service.ts`.
- Modify `src/cli.ts`.
- Test `test/ael-advisory-pilot.test.ts`, case `AAP-A3`; fixture `test/fixtures/ael-advisory-pilot/cases.json`.

- [ ] Add failing case `AAP-A3`: Lookup alone records only retrieved; a linked controlled operation and verification advance only the facts supported by their witnesses.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=AAP-A3 dist/test/ael-advisory-pilot.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Persist retrieved, delivered, selected, applied and outcome facts independently with origin and scoped references. An agent claim stays a claim; matching command text is not delivery or adoption evidence.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-advisory-pilot r3` after GREEN.

## Task 4: Codex agent-invoked pilot

Requirement `AAP-R4`. Acceptance `AAP-A4`.

Contract: A controlled session B receives and uses eligible session A knowledge through the actual selected channel.

Files:

- Create `src/advisory/service.ts`.
- Modify `src/cli.ts`.
- Test `test/ael-advisory-pilot.test.ts`, case `AAP-A4`; fixture `test/fixtures/ael-advisory-pilot/cases.json`.

- [ ] Add failing case `AAP-A4`: Complete both tooling-convention and new-project-fact scenarios with separate delivery/application/result evidence.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=AAP-A4 dist/test/ael-advisory-pilot.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Use explicit CLI retrieval as the first channel. Run separate session A acquisition/review and B reuse for both convention and new project fact. Preserve the actual rendered payload and delivery witness without storing raw transcript.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-advisory-pilot r4` after GREEN.

## Task 5: Revocation and safe failures

Requirement `AAP-R5`. Acceptance `AAP-A5`.

Contract: Failure and revocation preserve ordinary work and existing authority.

Files:

- Create `src/advisory/settings.ts`.
- Create `src/advisory/usage.ts`.
- Create `src/advisory/service.ts`.
- Test `test/ael-advisory-pilot.test.ts`, case `AAP-A5`; fixture `test/fixtures/ael-advisory-pilot/cases.json`.

- [ ] Add failing case `AAP-A5`: Fault the store, revoke advice and submit forged usage; no command, new block or permission change occurs.
- [ ] Run `rtk pnpm build`, then `rtk proxy node --test --test-name-pattern=AAP-A5 dist/test/ael-advisory-pilot.test.js`. Expected RED: the specified semantic assertion fails. Record actual output, not a predicted pass count.
- [ ] Implement this boundary: Recheck enablement before delivery, reject forged usage links, and fail open on missing storage. Disabling stops future guidance while retaining history; no execution, block or permission changes are introduced.
- [ ] Repeat the same two commands. Expected GREEN: this acceptance case passes and its negative controls remain rejected.
- [ ] Inspect persisted state after restart and check that the case did not create raw payload, cross-scope references or stronger lifecycle authority than its evidence permits.
- [ ] Review `rtk git diff --check` and the scoped diff; commit only this task with message `feat: ael-advisory-pilot r5` after GREEN.

## Acceptance and rollback

- [ ] Run the focused acceptance and regression suites after the final implementation change:

```sh
rtk pnpm build
rtk proxy node --test dist/test/ael-advisory-pilot.test.js dist/test/runtime-policy.test.js dist/test/retrieval-and-retention.test.js
rtk pnpm check
rtk git diff --check
```

Expected: build and all selected/full checks exit 0; record actual test counts and any skipped cases. A host-dependent unsupported case remains explicitly unqualified rather than a passing integration.

- [ ] Exercise the complete user-visible path named in the specification in an isolated workspace, including negative scope, unknown evidence and restart cases. Component success cannot substitute for this path.
- [ ] For new tables or formats, interrupt migration and replay it twice; compare immutable old rows and foreign keys. Keep a pre-migration fixture and demonstrate a compatible rollback reader. Never run an incompatible old writer against an upgraded store.
- [ ] For new configuration or installation changes, restore the saved owned-file generation and verify unrelated hooks/settings are byte-identical. For feature-only changes, disable the feature and verify the passive path still operates.
- [ ] Write `docs/verification/2026-09-29-ael-advisory-pilot.md` with build identity, exact commands/results, actual fixtures, requirement evidence, exclusions and migration/rollback outcome. Fill the corresponding verification paths in the traceability manifest only after execution.
- [ ] Review the implementation against every requirement and its privacy/authority constraints. Update the delivery status only to the level established by evidence; leave unqualified work open.

## Traceability

| Requirement | Acceptance | Implementation task | Test case |
|---|---|---|---|
| AAP-R1 | AAP-A1 | 1 | AAP-A1 |
| AAP-R2 | AAP-A2 | 2 | AAP-A2 |
| AAP-R3 | AAP-A3 | 3 | AAP-A3 |
| AAP-R4 | AAP-A4 | 4 | AAP-A4 |
| AAP-R5 | AAP-A5 | 5 | AAP-A5 |
