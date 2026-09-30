# ABI implementation evidence

The user authorized ABI implementation on 2026-09-29. Work is isolated on `codex/abi-build-identity`. Live registered installations and production databases are not mutated by acceptance fixtures.

## Acceptance contract

The final observable state is a content-addressed packaged artifact with a read-only installation inventory, hash-bound reversible hook alignment and controlled installed-wrapper qualification. Writer compatibility is checked before admission; the bounded spool envelope carries the verified running build digest. Full receipt provenance acceptance remains pending on ARC task 4.

## Decisions

The pre-change artifact hashes and integration matcher are frozen in `2026-09-29-abi-baseline.json`. This is a synthetic ABI baseline, not completion of the wider AVB benchmark. Before ABI changes, `rtk pnpm check` ran 900 tests: 899 passed, one failed with `ENOTEMPTY` in the detached-drain cleanup of `passive-hook-cli`.

The existing proposed plan is executed inline. ABI authorization does not authorize another specification or live rollout. Qualification reports `evidence: controlled-fixture`; it exercises the recognized installed wrapper with isolated storage and dispatches only AEL commands admitted by the selected matchers. It does not record host trust or real host event delivery.

The rollback and qualification operations are exposed as `installation rollback --input <plan.json>` and `installation qualify --repository <path>`. A generation journal retains the private plan and previous owned contents. A stopped publisher is recovered only when its owner process is absent and managed file hashes match either generation. Foreign edits are rejected.

No-manifest packages remain unknown inventory entries. A manifest is validated against its shipped bytes before capture provenance is admitted. Rollback to a previous wrapper requires its previous artifact manifest and compatible writer; unknown older writers cannot be approved by package version.

The writer minimum is a read-only `ael_writer_contract` check. Spool constructors and hook admission enforce the admission-store minimum without opening the primary database; alignment checks both selected and previous writer capabilities against the current local store minimum. Receipt retention/schema changes belong to ARC; historical receipts are not relabeled.

## Requirement ledger

ABI-A1: the initial public build assertion failed because no manifest existed. After implementation, deterministic generation and a changed shipped byte are tested, including duplicate paths and escaping symlinks.

ABI-A2: the initial public inventory assertion failed with unknown CLI syntax. The regression covers actual managed target resolution, absent manifests, modified and missing artifacts, a nonexecuted trap wrapper, registry-ID selection and path-free public reports.

ABI-A3: the initial public planning assertion failed with unknown installation syntax. Tests cover stale plans, idempotent replay, foreign-hook preservation, failure after the first publication, stopped publisher recovery, symlink boundaries and explicit rollback. An unsafe shell-path assertion failed before shell argument validation was added.

ABI-A4: the initial qualification assertion failed with unknown installation syntax. The fixture uses a separate installed artifact copy, invokes its wrapper and reads reopened SQLite facts for startup, end, resume and a correlated successful technical result. Removing resume from the matcher must leave the fixture unqualified.

ABI-A5 core: the initial persisted admission assertion failed because build provenance was absent. The test compares the admission digest with the actual build and rejects a store requiring writer 2 without changing its bytes. Receipt persistence remains pending, as specified by the staged ABI/ARC boundary.

The first full regression run reproduced the existing admission contract that a blocked primary database must not prevent durable spool admission. The ABI ingress guard now reads only the spool writer contract; primary-store checks are reserved for explicit alignment. ARC must synchronize upgraded writer requirements into the admission contract.

## Independent review

The independent reviewer found four required corrections. Regressions first reproduced missing startup/action matcher repair, overwrite of a concurrent foreign edit, unsafe restoration of an unknown previous writer, and qualification of a nonexecutable wrapper. The implementation repairs missing owned matcher coverage, rechecks each file before publication, restores only its published files, validates the previous artifact before any publication or recovery, and invokes the actual installed executable wrapper.

The previously deferred owner-file gap was reproduced by killing a publisher after directory creation; a retry failed on the ownerless lock. The user then authorized a lock-recovery amendment. Alignment now acquires a repository-local SQLite write transaction and marks its lock file with an application ID. A stopped publisher releases the mutex through process exit, including SIGKILL before the first journal write. ABI-A3 tests cover automatic retry, live contention, SIGKILL release, a verified dead legacy owner, ownerless legacy content, and preservation of an unrelated SQLite database at the lock path. Unknown legacy content remains protected because its ownership cannot be proven.

Alignment refuses to publish over a legacy target with no valid previous manifest because its rollback writer cannot be verified. Such packages remain inspectable as unknown. They require an explicit migration to establish a verifiable previous generation; package-version equality is insufficient authorization to enable that writer.

The reviewed full run passed 913 of 914 tests; its only failure repeated the baseline `ENOTEMPTY` cleanup race in `passive-hook-cli`. That suite now uses the existing bounded temporary-directory removal helper for detached-drain data directories.

## Final checks

After the final correction:

- `rtk pnpm build`: exit 0.
- `rtk proxy node --test dist/test/ael-build-identity.test.js dist/test/hook-installation.test.js dist/test/hook-readiness.test.js dist/test/project-hook-configuration.test.js`: 27 passed, 0 failed, 0 skipped.
- The same focused command plus `dist/test/passive-hook-cli.test.js`: 38 passed, 0 failed, 0 skipped.
- `pnpm check`, run through `rtk proxy sh` with output retained locally: 914 passed, 0 failed, 0 skipped; exit 0.
- `rtk git diff --check`: exit 0.

The actual executable CLI completed `installation inspect`, `plan`, `apply`, a second `inspect`, `qualify` and `rollback` in a fresh temporary Git repository. The first artifact state was missing, the second was current, and the qualification result was qualified with controlled-fixture evidence. Every command exited 0. This path changed only fixture hooks and isolated stores.

The user accepted the verified ABI core on 2026-09-29 with “tak” in response to the explicit acceptance question before real-host testing. The accepted implementation is commit `c60278d`, with the limitations recorded above. ABI-A5 receipt storage remains pending ARC. Live-host qualification, merge and rollout are not recorded as completed.

This acceptance update changes documentation only. `rtk git diff --check` passes; the preceding 914/914 implementation test result remains the verification evidence.

## Lock recovery amendment verification

The user requested the lock fix and spec update on 2026-09-29. The updated requirement is in ABI-R3/ABI-A3 and the execution plan. After the last source change:

- `rtk pnpm build`: exit 0.
- `rtk proxy node --test dist/test/ael-build-identity.test.js dist/test/hook-installation.test.js dist/test/hook-readiness.test.js dist/test/project-hook-configuration.test.js`: 32 passed, 0 failed, 0 skipped.
- `pnpm check` through `rtk proxy sh`: 919 passed, 0 failed, 0 skipped; exit 0.

The executable CLI also completed inspect (missing), plan (planned), apply (applied), qualify (qualified) and rollback (rolled-back) in a fresh temporary repository after the lock amendment; every command exited 0. No registered project installation or production database was modified. The original ABI-A5 receipt integration, live-host qualification, merge and rollout remain pending.

On 2026-09-29, the user answered “tak” to whether the controlled process-interruption test is sufficient lock-recovery evidence before rollout. The accepted evidence is limited to the ABI-A3 lock-recovery behavior; the answer does not authorize rollout or complete ABI-A5 or live-host qualification. Legacy ownerless locks remain protected because ownership cannot be established.

ABI-A5 acceptance was clarified after review: the current test verifies the running build digest in the admission record and rejects a newer writer requirement, but does not read build attribution from a persisted receipt after restart. The revised criterion requires receipt attribution for two byte-distinct installed artifacts with the same package version, verified against the artifact actually invoked. That assertion remains pending ARC task 4.

An additional association probe captured two distinct operations and then inspected `capture_receipts`. `rtk proxy node --test --test-name-pattern=ABI-A5 dist/test/ael-build-identity.test.js` passed 1/1, but the probe failed as expected (exit 1): the current receipt columns are `sequence`, `correlation_key`, `disposition` and `received_at`, with no persisted build identity. A two-build test that checks only the set of build IDs would not detect IDs exchanged between operations. ABI-A5 therefore also requires a per-operation correlation assertion and a swapped-identity negative fixture. This is an open acceptance test for ARC task 4, not a passing ABI-A5 receipt test.

On 2026-09-30, the ABI-A5 retention boundary was clarified against the ARC receipt contract: a retained receipt must preserve its per-operation attribution; after retention evicts it, receipt-level attribution is unavailable and must not be inferred from a surviving admission record. The bounded eviction assertion remains pending ARC task 4.

The status decision for absent receipts is non-causal: the retention window is reported, but absence alone does not distinguish eviction from a receipt that was never persisted. ABI-A5 will test both cases without requiring an unbounded per-operation tombstone ledger. This acceptance work remains pending ARC task 4.

The current report was probed on 2026-09-30 with two admitted operations and `maxReceipts: 1`, then reopened. `status().admitted` was 2; `receiptReport().receipts.length` was 1 and `accounting` was `available`. The report fields were `accounting`, `receipts` and `byDisposition`; the assertion for a retention window failed as expected (exit 1). The existing bounded-receipt regression passed 1/1. The current report therefore does not yet distinguish receipt retention coverage from operation count. ABI-A5 now requires the ARC health report to expose both counts separately and mark older receipt attribution unavailable without declaring an operation missing.

A second probe on 2026-09-30 admitted two distinct operations, redelivered the first and retried its delivery. The current spool reported `admitted: 2` and four receipts: two accepted, one duplicate and one delivery retry; the probe exited 0. This verifies present internal counters for that fixture, not the future ARC health report or per-receipt build attribution. ABI-A5 now requires the ARC integration to retain the unique-operation count and original build association under redelivery and retry.
