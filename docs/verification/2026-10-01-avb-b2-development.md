# AVB B2 development verification, 2026-10-01

## Scope

Branch `codex/avb-b2-development` contains a public `benchmark trial stage` command and paired-assessment corrections. Staging binds a bounded declaration to the frozen protocol, selected slot, build and manifest. It writes an exclusive owner-only report containing the full validated protocol, with `status: incomplete` and `actualHost.status: unsupported`. The assessor accepts that staged report as an incomplete slot record without counting its operator declaration as an observed trial. It rejects a synthetic or staged report that claims verified host observation after its digest is recomputed. It uses the median of differences within matched disabled/advice pairs and exposes per-trial measurements.[^spec]

The change does not add a host-witness adapter, run a controlled agent trial or mark AVB-A4/A5 accepted. No live hook, installed skill, user database, schema or configuration was changed.

## Verification

The integrated focused command `rtk proxy node --test dist/test/ael-value-benchmark-trial-stage.test.js dist/test/ael-value-benchmark-paired.test.js dist/test/ael-value-benchmark-runner.test.js` exited 0 with 8 tests passed, 0 failed and 0 skipped after `rtk pnpm build` exited 0. A direct run before rebuilding after the skill-documentation edit passed 6/8 and failed both public pipeline cases with `Benchmark public command failed: capture hook`; rebuilding restored the current build identity. The public CLI cases check an incomplete staged report, immutable output, protocol and context binding, and rejection of fields outside the sanitized declaration. They also reject credential-shaped strings in operation IDs, manifest labels and protocol source versions without writing a report or echoing the value. The paired tests cover a recomputed digest carrying a false host claim, matched-pair median behavior and rejection of non-regular or oversized report input.

The subsequent assessor change began with a failing public-path test: a staged trial raised `Paired report was modified.` because the reader required `status: complete`. After the change, `rtk pnpm build` exited 0 and `rtk proxy node --test dist/test/ael-value-benchmark-paired.test.js dist/test/ael-value-benchmark-trial-stage.test.js` passed 8/8. The tests also reject a re-sealed staged report whose slot or host status was substituted. The assessor still reports zero observed trials and `performance-not-established` for operator declarations.

After the code changes, `rtk pnpm check` exited 0 with 1041 tests passed, 0 failed and 0 skipped; the M4 enabled-hook p99 was 178.428 ms against its 250 ms limit. The first check after documentation edits failed only the same timing test at p99 308.141 ms, with 1040/1041 tests passing. `rtk proxy node --test dist/test/milestone-4-acceptance.test.js` then passed 6/6 with enabled-hook p99 69.343 ms. A serial `rtk pnpm check` retry passed 1041/1041 with enabled-hook p99 179.037 ms. An earlier concurrent agent run had also failed this timing test at p99 394.647 ms. These outcomes show that the timing gate varies with execution load; they do not change the AVB host qualification status.

`rtk git diff --check` exited 0 after the documentation edits.

After updating the skill documentation snapshot date to 2026-10-01, `rtk pnpm check` passed 1041/1041 again with enabled-hook p99 153.010 ms. `rtk proxy node dist/src/cli.js skill validate skills/ael --json` returned `status: valid` and the same snapshot date.

After the credential-screening change and removal of links outside the installed skill bundle, `rtk pnpm check` passed 1041/1041 with enabled-hook p99 167.974 ms. `rtk git diff --check` exited 0.

Both new readers reject non-regular files and read at most their declared limit plus one byte from one descriptor. The trial input limit is 1 MiB; the paired-report limit is 4 MiB. Their negative tests include `/dev/zero` and an oversized regular file. The staging output uses exclusive creation and mode 0600.

## Acceptance boundary

AVB-A4 and AVB-A5 remain unqualified: no five-pair actual-host series, independently observed advice exposure, qualified Codex success/failure/asynchronous result envelopes, token telemetry or measured redundant-operation reduction was produced. B0/B1 evidence and the 2026-09-30 requirement manifest retain their historical scope. A staged declaration is an operator record, not host verification.[^prior]

The next acceptance inputs are sanitized installed-host observations for AEC-A1/A4/A5 and an independent AAP-A4 delivery witness linked to the selected and applied operation. A qualified trial producer must bind those witnesses to the protocol and slot before the assessor can count an observed B2 trial.[^dependencies]

[^spec]: [AVB specification](../superpowers/specs/2026-09-29-ael-value-benchmark-design.md), [AVB plan](../superpowers/plans/2026-09-29-ael-value-benchmark.md).
[^prior]: [Eight-spec integration verification](2026-09-30-ael-eight-spec-integration.md), [requirement manifest](2026-09-30-ael-requirement-traceability.json).
[^dependencies]: [AEC specification](../superpowers/specs/2026-09-29-ael-evidence-continuity-design.md), [AAP specification](../superpowers/specs/2026-09-29-ael-advisory-pilot-design.md).
