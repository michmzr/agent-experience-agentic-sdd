# AEC host result qualification checkpoint

Date: 2026-10-01. Source revision: `3cf194e`. Locally available Codex CLI: `0.157.1`.

## Observable acceptance

AEC-A1 can be marked qualified only after sanitized result envelopes from the installed host show a controlled successful operation and a controlled failed operation. AEC-A5 additionally needs an observed asynchronous request and terminal result with a stable identifier. The accepted source fields, their provenance and the host version must be recorded without raw tool output. A missing class stays unsupported; a synthetic envelope does not qualify it.[^spec]

## Evidence checked

The frozen repository audit has 2503 Codex `post-result` events. All 2503 have `capture_outcome=unknown`; none has a retained `exit_status`. All 2503 link to a request. This establishes correlation in that snapshot but supplies no successful or failed host result and no asynchronous completion envelope.[^audit]

The Codex hook adapter accepts scalar `exit_status`, `exitStatus` or `exit_code` fields from a post-tool payload. The installed-build qualification routine injects its own top-level `exit_status: 0` and reports `evidence: controlled-fixture`. These are implementation and fixture contracts, not observations that the installed Codex host emits those fields. The existing AEC test correctly declares Codex process exit `unqualified`.[^code]

The local `codex --version` command returned `codex-cli 0.157.1`. A version string alone does not establish result field shape. No controlled real-host success, failure or asynchronous envelope was available in the checked evidence. No external agent run was launched, and no private transcript or user database was read.

## Decision

Keep `sourceEvidenceCapabilities.codex.processExit` at `unqualified`. Do not add a nested extractor, enable success or failure claims from a proposed host shape, or treat the synthetic installation check as AEC-A1/A5 acceptance. AEC source qualification and AVB measured host trials remain open until the three observed classes in the acceptance criterion are recorded. A follow-up must preserve the fail-closed `unknown` outcome for missing or unsupported fields.[^spec]

## Commands and results

`rtk proxy codex --version` exited 0 and returned `codex-cli 0.157.1` with a PATH alias warning. `rtk sed -n '110,140p' docs/analysis/2026-09-29-ael-audit-results.json` showed the counts above. `rtk rg -n 'PostToolUse|tool_use_id|exit_status|exit_code' src test docs` located the adapter and synthetic qualification path. No production code changed, so no test result is claimed for this checkpoint.

[^spec]: [AEC design](../superpowers/specs/2026-09-29-ael-evidence-continuity-design.md), [AVB design](../superpowers/specs/2026-09-29-ael-value-benchmark-design.md).
[^audit]: [Frozen audit results](../analysis/2026-09-29-ael-audit-results.json), [assessment findings](../analysis/2026-09-29-ael-value-findings.md).
[^code]: [Codex hook adapter](../../src/capture/hook-adapters/codex.ts), [installation qualification](../../src/installation/qualification.ts), [AEC test](../../test/ael-evidence-continuity.test.ts).
