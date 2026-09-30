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

## ATI-A5 capability check

Codex, Claude Code and Cursor expose `taskVerification: unsupported` in the native source capability record because no qualified structured task-verification envelope is available. The local annotation producer is separately declared as `user-declared` and never claims native telemetry. The public `evidence session` command returns the unsupported native capability; the public `evidence import` command persists a resolved user-declared task-verification row with its origin intact. An auditable derived episode requires the later ATI-A6 worker integration.

`rtk pnpm build` exited 0. `rtk proxy node --test --test-name-pattern=ATI-A5 dist/test/ael-typed-evidence-ingestion.test.js` was RED at 0/1 because the previous native capability was `structured-only`. After the capability change, `rtk proxy node --test dist/test/ael-typed-evidence-ingestion.test.js` passed 5/5 with no failures.
