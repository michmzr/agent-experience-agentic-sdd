# Milestone 5 session evidence verification

## Scope

The implementation range `e5aa704..b2a15b7` adds deterministic session reconstruction, categorized outcomes, coverage reporting, source-provided time and token measurements, immutable derived-history versions and the read-only `ael evidence session <id>` command.

The stored-capture projection excludes summaries, arguments, prompts and unrestricted output. It reports missing source fields as unavailable. A true source end remains distinct from reconciliation completion.

## Acceptance evidence

| Criterion | Evidence |
|---|---|
| M5-A1 | Reconstruction tests cover reordered results, equal and conflicting duplicates, repeated timestamps, unmatched results and exact-reference correlation. Equivalent duplicate source events produce one operation. |
| M5-A2 | Tests cover open, source-ended, reconciled-complete and incomplete states. Missing source end leaves elapsed time unavailable. |
| M5-A3 | Measurement and acceptance tests distinguish command failure, process success followed by failed task verification, unknown outcome and explicit human waiting. |
| M5-A4 | Tests cover cumulative snapshots, delta snapshots, parent/subagent overlap and cached-input subsets. Missing usage is absent rather than zero. Decreasing cumulative counters and contradictory exit-status/outcome pairs are rejected. |
| M5-A5 | `test/fixtures/session-evidence/scenarios.json` labels five synthetic scenarios and changed-environment, missing-data and secret-bearing variants. |
| M5-A6 | Repository tests cover repeat reconstruction, late correction, stable operation identities, immutable prior versions, reopen behavior and corrupted-history rejection. Coverage exposes skipped classes, unsupported classes and truncation. |
| M5-A7 | Metrics retain observed-boundary attribution for elapsed, active, waiting, hook-duration, spool-lag and source-provided token fields. No currency estimate is produced. |

## Commands and observed results

On 2026-09-06:

```text
pnpm build && node --test dist/test/session-evidence-reconstruction.test.js dist/test/session-evidence-measurement.test.js dist/test/session-evidence-repository.test.js dist/test/milestone-5-acceptance.test.js
19 passed, 0 failed, 0 skipped

pnpm check
599 passed, 0 failed, 0 skipped

pnpm audit --prod
No known vulnerabilities found
```

The first audit attempt could not resolve the registry inside the sandbox. The allowed network retry returned the recorded result.

## Representative source inspection

The explicitly selected observed Codex fixture `test/fixtures/session-review/observed-codex-session.jsonl` was read through the bounded adapter after the full build. The output contained only structural measurements: 8 retained events, comprising 2 tool records, 1 message record and 5 metadata records, from `2026-08-24T10:00:00.000Z` through `2026-08-24T10:00:07.000Z`. Retained text was not printed.

## Integration boundary

M4 durable transport is not implemented in this checkout. The M5 contract accepts explicit reconciliation bounds and tests their semantics, but the stored-capture CLI cannot claim `reconciled-complete` until an M4 consumer supplies verified expected and committed bounds. The pre-existing draft roadmap and task-list changes were not included in the M5 commits, so they remain user-owned and do not record a false integrated completion claim.
