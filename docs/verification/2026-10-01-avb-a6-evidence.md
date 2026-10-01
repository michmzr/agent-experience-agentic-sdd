# AVB-A6 requirement evidence, 2026-10-01

## Scope

The [AVB requirement overlay](2026-10-01-avb-requirement-evidence.json) maps AVB-R1 through AVB-R6 to tagged tests and existing run artifacts. It supplements the 2026-09-30 46-requirement snapshot without changing that snapshot's revision or historical run scope. The overlay records test presence separately from requirement acceptance. No requirement is marked accepted by this record.

AVB-A4 and AVB-A5 still lack a qualified five-pair installed-host series. The staged B2 declaration has no independent host or advice-delivery witness. Synthetic pilot test data cannot establish measured savings. Controlled external AEC CLI probes observed command-item status and exit codes, but no project-hook event or asynchronous poll relation. They neither qualify the existing hook adapter nor constitute a B2 benchmark series. The overlay excludes full M7, M8 and M9 acceptance, unobserved net cost and live cloud mutation.[^basis][^aec-probe]

## Verification

TDD RED: `rtk pnpm build` exited 0. `rtk proxy node --test dist/test/ael-value-traceability.test.js` exited 1 with one pass and one failure because the current overlay did not exist.

TDD GREEN: `rtk pnpm build` exited 0 and `rtk proxy node --test dist/test/ael-value-traceability.test.js` exited 0 with 2 tests passed, 0 failed. The first GREEN attempt found that the existing combined `AVB-A4/A5` test title does not spell out `AVB-A5`; the traceability assertion now recognizes that exact combined title.

The first `rtk pnpm check` exited 1 with 1043/1044 tests passed. Its only failure was the existing M4 enabled-hook timing gate: p99 268.159 ms exceeded 250 ms. The isolated `rtk proxy node --test dist/test/milestone-4-acceptance.test.js` then exited 0 with 6/6 tests passed and enabled-hook p99 67.793 ms. A serial `rtk pnpm check` retry exited 0 with 1044/1044 tests passed and 0 skipped.

On the qualification-probe correction, `rtk pnpm build` exited 0 and the focused test failed 1/2 because `externalRunScope` was absent. After adding that field and removing the false external-run exclusion, `rtk proxy node --test dist/test/ael-value-traceability.test.js` exited 0 with 2/2 tests passed. `rtk pnpm check` exited 0 with 1044/1044 tests passed and 0 skipped.

After the AEC probe note was integrated on the parent branch, `rtk pnpm build` exited 0 and the focused traceability test failed 1/2 because the overlay still said its artifact was pending. The artifact path and the no-hook-qualification status were then added. The focused test passed 2/2; `rtk pnpm check` passed 1044/1044 with 0 skipped. The linked file is present in the parent integration branch; this isolated worktree is based on the earlier commit.

[^basis]: [AVB specification](../superpowers/specs/2026-09-29-ael-value-benchmark-design.md), [B2 development evidence](2026-10-01-avb-b2-development.md), [historical requirement snapshot](2026-09-30-ael-requirement-traceability.json).
[^aec-probe]: [AEC installed-host result probe](2026-10-01-aec-real-host-probe.md), integrated as commit `4a7f963` in the parent branch.
