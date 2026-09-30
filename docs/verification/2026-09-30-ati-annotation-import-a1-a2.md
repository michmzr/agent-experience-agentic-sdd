# ATI-A1/A2 annotation import verification

The public `evidence import --repository-id <id> --input <artifact.json> --json` path accepts a closed local-annotation artifact with at most 128 typed records and 256 KiB of input. It persists immutable evidence identity and origin in a private SQLite table. Reimport preserves one row per producer namespace, repository, session and evidence ID. Missing operation references remain pending and can resolve on reimport after the source request arrives. References to another session and source result references are rejected, including while AEC backfill is incomplete.

This slice covers ATI-A1 and ATI-A2. The imported table is not yet part of the AEC logical index or normal analysis worker path. ATI-A6 requires a store-owned extension of `logical_evidence.path` and its page reader, followed by worker admission. No native verification capability is claimed.

| Command | Result |
| --- | --- |
| `rtk pnpm build` before implementation | Exit 0. |
| `rtk proxy node --test dist/test/ael-typed-evidence-ingestion.test.js` before implementation | RED: 0/2; public CLI returned exit 2 instead of 0. |
| `rtk proxy node --test --test-name-pattern=unindexed dist/test/ael-typed-evidence-ingestion.test.js` | RED: 0/1 before physical scope fallback. |
| `rtk proxy node --test --test-name-pattern='unindexed source result' dist/test/ael-typed-evidence-ingestion.test.js` | RED: 0/1 before source phase validation. |
| `rtk proxy node --test --test-name-pattern=ATI-A1 dist/test/ael-typed-evidence-ingestion.test.js` | RED: 0/1 before credential-like identifier rejection. |
| `rtk pnpm build` after the final source change | Exit 0. |
| `rtk proxy node --test dist/test/ael-typed-evidence-ingestion.test.js` | GREEN: 4/4, 0 failed. |
| `rtk git diff --check` | Exit 0. |

The full repository check is deferred for the serial integration run while ASC and ARC test their separate worktrees.
