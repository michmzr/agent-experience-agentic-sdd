# AEL value findings used by the specification package

## Evidence boundary

Assessment date: 2026-09-29. Source revision: `2dc0f5e`. This note preserves the findings used for planning without publishing private installation paths or source payloads. The main audit snapshot and separate spool snapshot were taken at different moments. They are historical observations, not a live completeness report.[^audit]

## Findings

| ID | Observation | Evidence class | Specification |
|---|---|---|---|
| F01 | AEL uses a checkout build, sisterhood another installed package, and wkregukobiet, SecondBrain and vimeo-downloader older targets without `learning/worker.js`; manifests report 0.0.0 | Read-only wrapper/manifest/file inventory | ABI |
| F02 | Five registered projects have 5083 technical events; all 2503 technical results are unknown and lack retained exit status | Frozen SQLite queries | AEC |
| F03 | Current-source probe stores two resumed run events; learning range reader and repository quality return zero for those operations | Isolated synthetic reproduction | AEC |
| F04 | Spool snapshot: 41 pending, 988 CORRUPT, maximum 1411 attempts; retry code caps delay but not attempts | Frozen SQLite queries and source | ARC |
| F05 | 477 wkregukobiet events and 513 SecondBrain events belong to sessions with no analysis stream | Frozen SQLite joins | ARC |
| F06 | `Use pnpm instead of npm` yields one convention; `Use pnpm (never npm)` yields zero; 12 audited context snapshots have no conventions | Current-source probe and frozen SQLite | ASC |
| F07 | Production projection generates tool requests/results; typed task evidence can be injected through `LearningRunOptions.episodeEvidence` in tests | Source inspection | ATI |
| F08 | An isolated analysis persists one operational candidate; public lessons listing returns zero because it reads knowledge | Current-source probe and source inspection | ACL |
| F09 | Legacy manual review findings are assigned `successful-workflow` independently of their actual kind | Source inspection | ACL |
| F10 | M8 Draft depends on both M7 specifications; a local reuse pilot is a proposed change to delivery order | Documentation comparison | AAP |
| F11 | Reliable-observation evaluation counts prepared fixture facts and cost units; it does not execute the whole hook-to-reuse pipeline | Test/fixture inspection | AVB |

The nested-result probe used an illustrative envelope: top-level `exit_code: 0` produced succeeded; nested `tool_response.exit_code: 0` remained unknown. It does not establish the actual host format. AEC therefore starts with real source qualification rather than implementing that nested field based on the probe alone.[^source]

The global verified project-location fact in the audit is useful retained knowledge, but does not demonstrate automatic operational learning. Candidate creation and accepted knowledge are separate contracts; closing the integration must preserve the review boundary.

## Verification already performed during assessment

```text
rtk pnpm exec tsc -p tsconfig.build.json --outDir /private/tmp/ael-assessment-20260929/dist
exit 0

rtk proxy node .ai/doc-drift/2026-09-29-assessment-probes.mjs
exit 0; four isolated probes completed
```

Five existing suites ran against that isolated build: learning-contracts, learning-detectors, learning-project-conventions, learning-service and session-evidence-reconstruction. Result: 64 passed, zero failed and zero skipped after copying the required existing fixture into the isolated build layout. The initial run lacked that fixture; no product code was changed to obtain the passing result. Full `pnpm check` was not run for the assessment.

The local probe and installation inventory under `.ai/doc-drift/` are ignored working artifacts. Their paths are not portable verification dependencies for future implementation. The new plans require sanitized durable fixtures and fresh acceptance reports. These historical checks establish the assessment observations, not the behavior proposed in the new specs.

[^audit]: [Audit report](2026-09-29-ael-records-and-lessons.md), [audit SQL](2026-09-29-ael-audit.sql), [frozen query results](2026-09-29-ael-audit-results.json).
[^source]: [Hook installation](../../src/cli/hook-installation.ts), [Codex adapter](../../src/capture/hook-adapters/codex.ts), [store](../../src/storage/experience-store.ts), [learning service](../../src/learning/service.ts), [conventions](../../src/learning/project-conventions.ts), [review service](../../src/review/review-service.ts), [reliable-observation tests](../../test/reliable-observation.test.ts).
