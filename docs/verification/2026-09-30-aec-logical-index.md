# AEC logical evidence index verification

This is a partial implementation record for AEC-A2, AEC-A3 and the restart portion of AEC-A6. It does not qualify host result envelopes or complete AEC acceptance.

The store now gives legacy and resumed technical events one transactional logical reference each. The reader uses per-session ordinals and a fixed high-water mark with pages limited to 1024 entries. Learning admission and repository quality read that stream. Opening an upgraded store backfills at most 1024 older references in one transaction; `backfillLogicalEvidence` reports the remaining count and can resume after reopening. Existing version 1 session output remains separate.

`rtk pnpm build` exited 0. The focused command `rtk proxy node --test dist/test/ael-evidence-continuity.test.js dist/test/experience-store.test.js dist/test/learning-service.test.js dist/test/analysis-load.test.js dist/test/incremental-evidence.test.js` passed 56/56. Tests cover resumed request/result replay, learning admission, repository quality, fixed-watermark pagination, bounded page limits, restart and idempotent legacy backfill with unchanged version 1 rows and no foreign-key violations.

The final full `rtk pnpm check` run had 922 tests: 920 passed and 2 failed. One failure is a preexisting milestone test asserting exactly 17 migrations; the additive logical index is migration 18 and this assertion needs integration ownership. The other failure was a temporary-directory cleanup assertion in `hook-readiness.test.js`; an isolated rerun passed 4/4. The preceding full run had 921/922 passing, with only the migration-count assertion failing.

AEC-A1, AEC-A4 and AEC-A5 remain open. AEC-A1 requires sanitized observed success, failure and asynchronous envelopes from the installed host. AEC-A6 still needs interrupted multi-page backfill and rollback-reader evidence. No real host profile, installation or user database was changed.
