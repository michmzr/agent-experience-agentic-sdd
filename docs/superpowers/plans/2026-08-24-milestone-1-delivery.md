# Milestone 1 delivery plan

## Execution status

Last updated: 2026-08-24. Every checkbox is updated immediately after its verification gate. A checked task records the commit and verification evidence.

| Task | State | Verification / commit |
| --- | --- | --- |
| 1. Delivery design and executable contracts | completed | Design and source boundaries verified; `9ce0d20` adds contracts, `pnpm check` 56 passed. |
| 2. Source adapters and deterministic fixtures | completed | `4a6c90a`, `8181a54`, `a8eebf2`, `522175a`; full `pnpm check` 67 passed. |
| 3. Privacy scrubber and artifact boundary | completed | `96c959a`; independent `pnpm check` 71 passed and diff check passed. |
| 4. Manual review CLI and profile runtime | completed | `7f837e8`, `9bee20b`; independent `pnpm check` 78 passed. |
| 5. Parallel orchestration, candidates and proposals | completed | `66cfe7a`, `e0deb53`; independent `pnpm check` 84 passed and diff check passed. |
| 6. Milestone acceptance, review and merge | completed | Two independent final reviews approved; roadmap closed; local `main` fast-forwarded to `fca8c11`. The identical merge SHA passed 131 tests before merge. |

### Task 1: Delivery design and executable contracts

- [x] Define source, privacy, review and proposal boundaries in `2026-08-24-session-intelligence-delivery-design.md`.
- [x] Verify supported ingestion boundaries for Codex, Claude Code and Cursor.
- [x] Add normalized-session and review domain contracts with RED tests.
- [x] Run `pnpm check` and record the commit SHA: `9ce0d20`, 56 passed, 0 failed.

### Task 2: Source adapters and deterministic fixtures

- [x] Implement injected-root, artifact-led adapter contract.
- [x] Implement Codex observed-JSONL adapter with unknown-record rejection: `4a6c90a`.
- [x] Implement Claude Code adapter from verified supported local/export format: `8181a54`.
- [x] Implement Cursor adapter from verified supported local/export format: `a8eebf2`.
- [x] Add equivalent three-source fixtures and selection tests: `522175a`.
- [x] Run `pnpm check` and record the commit SHA: `522175a`, 67 passed, 0 failed.

### Task 3: Privacy scrubber and artifact boundary

- [x] Add RED tests for each redaction category and fail-closed behavior.
- [x] Implement deterministic sanitization, policy hash and redaction report: `96c959a`.
- [x] Prove raw values cannot reach reviewer input, SQLite or repository artifacts: normalized input and review artifact are allowlisted; no review API persists raw sessions.
- [x] Run `pnpm check` and record the commit SHA: `96c959a`, 71 passed, 0 failed.

### Task 4: Manual review CLI and profile runtime

- [x] Add explicit source/session CLI selection and expensive-check gate: `9bee20b`.
- [x] Resolve versioned reviewer profiles and enforce sanitized-only input: `7f837e8`.
- [x] Add deterministic fake reviewer runtime tests: `7f837e8`.
- [x] Verify runtime: `7f837e8`, independent `pnpm check` 75 passed, 0 failed.

### Task 5: Parallel orchestration, candidates and proposals

- [x] Run independent reviewers concurrently and sort results deterministically: `7f837e8`.
- [x] Group root causes, preserve disagreements and create candidate lessons: `66cfe7a`, `e0deb53`.
- [x] Generate traceable proposals with specification requirements where needed: `e0deb53`.
- [x] Run `pnpm check` and record the commit SHA: `e0deb53`, independently verified at 84 passed, 0 failed.

### Task 6: Milestone acceptance, review and merge

- [x] Add or update quality fixtures for all Milestone 1 acceptance paths: `6d0045b`, independently verified at 85 passed, 0 failed.
- [x] Run offline verification and security/privacy scans: 92 passed, 0 failed; diff check clean; no production network/process client matches.
- [x] Close third-gate review-output privacy finding: `c332adc`; focused privacy tests 2 passed, full `pnpm check` 108 passed, 0 failed; raw selected session identifiers and public discovery locations are absent from output.
- [x] Close third-gate command-specific CLI allowlist finding: `7f610d6`; RED proved that `review sessions` accepted `--session` and `--allow-expensive-checks`, and GREEN focused coverage plus full `pnpm check` passed 108 tests, 0 failed. The distinct allowlist now returns exit code 2 with `INVALID_SYNTAX: Unsupported option` for both flags.
- [x] Remove non-interactive `--session latest`: `4aef5d7`; RED showed mtime-based selection, then the CLI rejected `latest` with `INVALID_SYNTAX` before loading data and the selection path was deleted. Focused coverage and offline `pnpm check` passed 114 tests, 0 failed.
- [x] Add bounded, allowlisted session text that is sanitized and residual-scanned before review: `bc11ecb`; focused evidence tests 3 passed, full offline `pnpm check` 114 passed, 0 failed, and diff check passed.
- [x] Inject a versioned profile registry/runtime and expose explicit profile selection: `4aef5d7`; the manual-review service accepts an injected runtime, defaults to `default@1`, and the CLI accepts `--profile id@version`. Regression tests cover explicit default selection and unknown profile identifiers or versions; focused coverage and offline `pnpm check` passed 114 tests, 0 failed.
- [x] Sanitize and residual-scan complete source text before truncation so a credential crossing the event limit cannot escape detection: `066809b`; boundary regression passed and reviewer-visible output remains limited to 4096 characters per event.
- [x] Enforce fail-closed maximum artifact bytes, event count and aggregate review-text size before reviewer dispatch: `066809b`; resource-focused tests 3 passed, combined privacy tests 6 passed, full offline `pnpm check` 121 passed, 0 failed, and diff check passed.
- [x] Implement interactive repository-scoped discovery and latest-for-current-repository selection with explicit confirmation; align README: `b4e02df`; injected discovery and prompt boundaries filter to verified repository hints, confirm every interactive selection, select latest only from dated scoped descriptors, and reject latest outside interactive repository scope. Focused coverage and full offline `pnpm check` passed 121 tests, 0 failed.
- [x] Add all reviewer perspectives required by Spec 006 to the default versioned profile with deterministic coverage: `b92e095`; RED failed because the default-reviewers module did not exist, then the focused compiled Node test passed with all ten ordered reviewers and evidence-derived findings.
- [x] Wire the public CLI to a concrete terminal selection prompt and verified repository/recency descriptors: terminal prompt `5eea067`, verified Codex/Claude Code/Cursor scope and artifact-stat recency `e102daa`; selector receives no locations, public JSON omits paths, focused metadata coverage 3 passed, combined focused coverage 14 passed, and full offline `pnpm check` passed 125 tests, 0 failed.
- [x] Derive interactive repository identity from a validated canonical Git top-level: `f37c474`; RED canonical coverage failed 3 of 5 tests, including acceptance of a caller-controlled same-basename value, then focused integrated coverage passed 30 tests and full offline `pnpm check` passed 131 tests, 0 failed. The filesystem resolver validates canonical real paths plus `.git` directories or gitfiles, rejects different, nested, non-Git and symlinked artifact roots for interactive/latest selection, preserves explicit external-store IDs, and exposes only IDs and recency through the prompt and public JSON.
- [x] Obtain fresh implementation review and resolve all required findings: two independent reviewers approved `7e291d1`; each independently ran 131 tests with 0 failures and a clean diff check.
- [x] Mark `docs/product/roadmap.md` Milestone 1 complete only after all gates pass: completed on 2026-08-24 after both final approvals.
- [x] Merge the reviewed feature branch into local `main` and record the merge SHA: fast-forward `774ad6b..fca8c11`. The identical SHA passed 131 tests before merge; direct post-merge build succeeded and 130 code tests passed, while the package-bootstrap test could not repeat because the local pnpm store lacked the offline TypeScript tarball.
