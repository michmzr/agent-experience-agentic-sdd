# ARC-A3 analysis reconciliation verification

The public `analysis reconcile --repository-id <id> [--apply] --json` command reads the retained logical evidence index in pages of at most 1024 rows and scans at most 100 sessions per invocation. `--after-session` continues a repository scan. Preview opens SQLite in read-only mode. Explicit `--apply` admits missing detector work; when automatic operational learning is disabled, it records the repository, detector version, input high-water and session scope in `analysis_reconciliation_overrides`.

The focused acceptance test covers a read-only preview, an initial admission and a second idempotent apply, resumed evidence, opt-out override, incomplete backfill, an orphaned detector stream, and cursor pagination. An orphaned stream with committed but unprocessed evidence and no active job is reported as unavailable until the shared admission repository supports its repair.

| Command | Result |
| --- | --- |
| `rtk pnpm build` | Exit 0 after the last source change. |
| `rtk proxy node --test --test-name-pattern=orphaned dist/test/ael-recovery-reconcile.test.js` | RED: 0/1; orphaned stream was reported as current. |
| `rtk proxy node --test dist/test/ael-recovery-reconcile.test.js` | GREEN: 6/6. |
| `rtk pnpm check` | Exit 0; 946 tests passed, 0 failed. |
| `rtk git diff --check` | Exit 0. |
