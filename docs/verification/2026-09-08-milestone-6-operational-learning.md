# Milestone 6 verification

Date: 2026-09-08

Environment: Node.js v26.8.1 on Darwin 25.6.0 arm64.

Executed command:

    pnpm check

Result: passed. After the fast-forward merge to `main`, the compiled suite ran 669 tests with 669 passing in 15.747 seconds.

Focused M6 verification also passed:

    pnpm build && node --test dist/test/capture-spool.test.js dist/test/milestone-6-acceptance.test.js

Observed report shape is version `1` with `coverage`, `findings`, `hypotheses`, `unverifiedRepairs`, `candidates` and `verifiedKnowledge`. The acceptance test checks repository isolation and verifies that a credential-like marker from repository instructions is absent from serialized report output.

Decisions recorded in the implementation:

- Explicit root-scoped `pnpm` and `uv` directives create local convention candidates.
- Command repairs create outcome-observed episodes only. Codex and Cursor passive hooks do not provide a task-verification relation that would justify a durable repair procedure.
- Automatic learning admission runs after capture persistence, is best effort and can be disabled through `.ael/settings.json` with `automaticOperationalLearning: false`.
- The worker processes at most 1,024 events and 250 ms per claimed job by default. Timeouts and execution failures retry three times; invalid input is quarantined immediately.
- Asynchronous capture tests wait for the terminal spool state before deleting their data directories. A persisted session can become visible before post-commit learning admission and spool acknowledgement finish.
