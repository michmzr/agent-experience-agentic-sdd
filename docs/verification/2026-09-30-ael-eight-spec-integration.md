# AEL eight-spec integration verification

Date: 2026-09-30. Branch: `codex/abi-build-identity`. Scope: local implementation and controlled public CLI fixtures for ABI, AEC, ARC, ASC, ATI, ACL, AAP and AVB. The 46 requirement mappings and their distinct evidence limits are recorded in the requirement manifest.[^manifest]

## Checks

The final source and specification state was checked with `rtk pnpm check > /tmp/ael-final-check.log 2>&1`: exit 0, 1037 tests passed, 0 failed. The earlier integrated run failed on the ACL-A7 migration fixture because convention backfill opened the evidence resolver before validating a legacy session ID. Validating the ID first restored atomic rollback; `rtk node --test dist/test/ael-candidate-migration.test.js dist/test/ael-candidate-backfill-proposition.test.js dist/test/ael-candidate-backfill-a7.test.js` then passed 4/4. `rtk git diff --check` returned exit 0 after the edits.

The controlled AAP-A4 test passed 2/2 through public `candidates review`, `advice retrieve` and `advice record` for a persisted instruction convention and a Git-tracked `packageManager` fact. The captured session B operation follows the recorded selection. Changing the tracked fact before recording the outcome rejects that outcome; restoring it permits the linked verification. The AAP-A5 public fault and revocation test passed with the focused AAP suite 8/8.[^aap]

AVB-B1 runs capture, drain, analysis, typed import, candidate backfill and staged public review before retrieving verified advice. The focused B1, B2 and ACL regression set passed 12/12. Its read-only SQLite snapshot closes readers before a bounded retry on a busy store. The B2 protocol fixes five paired repetitions and reports `incomplete` while real-host trials are absent.[^avb]

## Qualification limits

The installed lifecycle fixture qualifies its fixture artifact, not an observed production Codex host. Real installed-host success, failure and asynchronous result envelopes remain unqualified for AEC; native task-verification remains unsupported for ATI. ARC reports unavailable coverage for an orphaned committed stream with no analysis job. AAP delivery in the controlled CLI test is marked `agent-claim`, not independently observed live-agent visibility. AVB has no completed host pair series or measured reduction in redundant work. These limits prevent a full M7, M8 or M9 acceptance claim.

[^manifest]: [Requirement traceability](2026-09-30-ael-requirement-traceability.json), [delivery index](../product/ael-value-delivery.md).
[^aap]: [AAP-A4 public reuse](../../test/ael-advisory-session-reuse.test.ts), [AAP-A5 public fault path](../../test/ael-advisory-fail-open.test.ts).
[^avb]: [B1 public pipeline](../../src/benchmark/pipeline.ts), [B2 paired protocol](../../src/benchmark/paired.ts).
