# Milestone 2 runtime learning verification evidence

Date: 2026-08-25

The verified runtime implementation head before acceptance evidence is `8de28d78fc8f5cd431d6a51814aca607d2aeccbd`. The acceptance commit is `8229948c7441ff131d3e3718a10a7108da125fa2`. The acceptance commit contains the complete implementation tree plus the three runtime fixtures, milestone acceptance tests, and deterministic benchmark test.

## Executed evidence

| Verification | Result |
| --- | --- |
| `node --test dist/test/milestone-2-acceptance.test.js dist/test/runtime-benchmark.test.js` | Passed after the acceptance commit: 11 passed, 0 failed, 0 skipped. |
| `pnpm check` | Passed on the acceptance tree: TypeScript build succeeded; 370 tests passed, 0 failed, 0 skipped. |
| `git diff --check` | Passed with no whitespace errors. |
| `rg -n "fetch\(|https?://|node:https|node:http|child_process" src/runtime src/capture src/config` | Returned no matches. |

The production local Git adapter uses `node:child_process` in `src/application/runtime-service.ts`. It is outside the scanned runtime, capture, and configuration modules. It runs only for explicit repository-knowledge validation or refresh operations. The synchronous gate evaluates an immutable in-memory index and does not invoke Git, a network client, or an LLM.

## Acceptance coverage

The acceptance suite covers repeated invalid action prevention, successful workflow context retrieval, stale verified-rule contradiction, disputed-rule non-enforcement, task-specific promotion rejection, learning-mode capture, and trusted merged knowledge reuse through Codex, Claude Code, and Cursor capture adapters.

The resilience cases distinguish retained-service memory from process-restart last-known-good fallback. They cover repository-target isolation, durable reload after target LRU eviction, corrupt current state with and without a last-known-good generation, explicit no-LKG recovery, logical current/LKG references, bounded regular generation files, and preservation of checksum-shaped symlinks and directories.

Boundary cases cover cross-adapter credential classification and benign controls, causal capture using a public `RuntimeService` decision, decision-bound overrides, stable override-evidence cursor high-water and filtering, and production Git blob/path preflight limits.

## Benchmark observation

The focused post-commit run recorded four deterministic fixtures, retrieval recall `1.0`, `0` false warnings, `0` false hard blocks, and `20,000` synchronous decisions. Observed elapsed gate time was `130.574 ms`, or `6.529 microseconds` per decision on that run. Timing is observational and is not a release threshold.

Release thresholds remain unset because real project-session data has not been collected. The current fixture values are regression observations only.

## Reviewer disposition

Task-level specification and quality reviews for Tasks 1 through 7 were approved before Task 8 began. Final independent specification and quality reviews of Task 8 and the complete milestone remain pending. The product roadmap therefore remains in progress and must not be marked complete until both reviews approve the verified tree.

## Known minor follow-ups

The repository-knowledge and runtime-snapshot stores currently maintain separate writer-lock implementations. Extracting a shared lock primitive may reduce maintenance duplication, but is not required for the verified behavior.

The current filesystem threat model does not claim protection from a hostile same-UID process that can swap files inside owner-writable private state while an operation is in progress. That threat requires a separate hardening design.

Benchmark release thresholds require real project-session measurements. No threshold is inferred from fixture-only latency, recall, or false-enforcement results.
