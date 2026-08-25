# Milestone 2 runtime learning verification evidence

Date: 2026-08-25

The verified implementation and acceptance commit is `535c3f31b4800947d0f4862d176b87ccc3308490`. It contains the complete production knowledge-to-runtime bridge, three runtime fixtures, milestone acceptance tests, and deterministic benchmark test. This verification document is a later docs-only commit, so the implementation SHA is exact without circular self-reference.

## Executed evidence

| Verification | Result |
| --- | --- |
| `node --test dist/test/milestone-2-acceptance.test.js dist/test/runtime-benchmark.test.js` | Passed at the implementation commit: 11 passed, 0 failed, 0 skipped. |
| Focused capture, schema, compiler, promotion, CLI, acceptance, and benchmark run | Passed at the implementation commit: 72 passed, 0 failed, 0 skipped. |
| `pnpm check` | Passed at the implementation commit: TypeScript build succeeded; 382 tests passed, 0 failed, 0 skipped. |
| `git diff --check` | Passed with no whitespace errors. |
| `rg -n "fetch\(|https?://|node:https|node:http|child_process" src/runtime src/capture src/config` | Returned no matches. |

The production local Git adapter uses `node:child_process` in `src/application/runtime-service.ts`. It is outside the scanned runtime, capture, and configuration modules. It runs only for explicit repository-knowledge validation or refresh operations. The synchronous gate evaluates an immutable in-memory index and does not invoke Git, a network client, or an LLM.

## Acceptance coverage

The acceptance suite covers repeated invalid action prevention, successful workflow context retrieval, stale verified-rule contradiction, disputed-rule non-enforcement, task-specific promotion rejection, and learning-mode capture. Its adapter case starts from a real version 3 repository document at a trusted Git commit, calls the public runtime refresh method, then evaluates equivalent Codex, Claude Code, and Cursor inputs through restarted `RuntimeService` instances. A valid active branch-local directive is included in the same snapshot as `authoritative: false` context: its exact match returns ALLOW with its knowledge reference and `CONTEXT_ONLY` explanation. Inactive local entries and entries for another repository are excluded, and cross-repository evaluation returns no reference.

The schema and compiler tests cover byte-stable version 3 serialization, compatible version 1 and version 2 reads, malformed directives, closed-world keys, bounded canonical values, path flavors, privacy rejection, deterministic immutable rule ordering, exact repository scope, trusted provenance, inactive states, context-only disputed/observed knowledge, empty evidence references, and the absence of prose inference. Promotion tests prove that validated structured directives survive the document flow while prose-only documents acquire no directive. Capture, schema write/parse, promotion, and existing-generation read regressions use one shared structured argument classifier for split, attached, equal-sign, camel-case, collapsed, environment, authorization-header, single-dash named, double-dash named, and tool-specific short credential forms. Generic diagnostics omit tested values. Benign `--key`, `-key`, `-verbose`, SSH, and `jq` controls remain accepted.

The resilience cases distinguish retained-service memory from process-restart last-known-good fallback. They cover repository-target isolation, durable reload after target LRU eviction, corrupt current state with and without a last-known-good generation, explicit no-LKG recovery, logical current/LKG references, bounded regular generation files, and preservation of checksum-shaped symlinks and directories.

Boundary cases cover cross-adapter credential classification and benign controls, causal capture using a public `RuntimeService` decision, decision-bound overrides, and stable override-evidence cursor high-water and filtering. Production Git tests verify bounded NUL-delimited mode/type/object/path parsing, path-count and output bounds, non-blob, gitlink, tree, duplicate, and unsafe-path rejection. Real trusted commits with a symlinked index or Markdown document are rejected after the working-tree generation is removed, while regular trusted activation remains accepted.

## Benchmark observation

The focused post-commit run recorded four deterministic fixtures, retrieval recall `1.0`, `0` false warnings, `0` false hard blocks, and `20,000` synchronous decisions. Observed elapsed gate time was `132.763 ms`, or `6.63815 microseconds` per decision on that run. Timing is observational and is not a release threshold.

Release thresholds remain unset because real project-session data has not been collected. The current fixture values are regression observations only.

## Reviewer disposition

Task-level specification and quality reviews for Tasks 1 through 7 were approved before Task 8 began. Earlier Task 8 reviews found the missing production bridge, omitted branch-local structured context, credential-classifier divergence, and insufficient Git tree object validation. The final privacy review found that single-dash multi-character named options did not use the shared long-option classification. Commit `535c3f31b4800947d0f4862d176b87ccc3308490` closes that gap while retaining tool-specific handling for ambiguous one-character flags. Final independent review of this commit and the complete milestone remains pending. The product roadmap remains in progress until that review approves the verified tree.

## Known minor follow-ups

The repository-knowledge and runtime-snapshot stores currently maintain separate writer-lock implementations. Extracting a shared lock primitive may reduce maintenance duplication, but is not required for the verified behavior.

The current filesystem threat model does not claim protection from a hostile same-UID process that can swap files inside owner-writable private state while an operation is in progress. That threat requires a separate hardening design.

Benchmark release thresholds require real project-session measurements. No threshold is inferred from fixture-only latency, recall, or false-enforcement results.
