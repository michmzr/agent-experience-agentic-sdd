# AEL integration checkpoint, 2026-09-30

The integration worktree at `74b51b0` contained ABI core and receipt attribution, AEC logical evidence continuity, ARC-A1/A2/A3, ASC-A1–A5, ATI-A1/A2/A5 and the AVB-B0 fixture plus the unconnected A3 safety evaluator. This checkpoint does not qualify an installed host or constitute final acceptance of the eight specifications.

`rtk pnpm check` exited 0: 977 tests passed, 0 failed, 0 skipped. The M4 enabled hook benchmark reported p99 202.934 ms against its 250 ms limit. The run followed the integrated fix for re-delivery of a committed capture operation. The generated `pnpm-lock.yaml` syntax change was inspected and restored because it did not change dependencies.

The targeted regression `rtk proxy node --test --test-name-pattern='ASC-A3 retains distinct|ASC-A3 spool identity|ABI-A5 two installed|ARC-A1 missing request' dist/test/ael-scoped-conventions.test.js dist/test/ael-build-identity.test.js dist/test/ael-recovery-coverage.test.js` exited 0 with 4/4 passing. `rtk proxy node --test dist/test/ael-recovery-plans-public.test.js dist/test/ael-recovery-plans.test.js` exited 0 with 7/7 passing.

ARC health v3 and detector sufficiency, ATI worker integration, ACL candidate lifecycle, AAP advisory delivery and public AVB-B1/B2 runs remained open at this checkpoint. A new full check is required after the last implementation change.
