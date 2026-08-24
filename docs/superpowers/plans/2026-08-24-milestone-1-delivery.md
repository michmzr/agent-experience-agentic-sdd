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
| 6. Milestone acceptance, review and merge | in progress | Prior fixes pass 114 tests. Repeat final review found open privacy limits, required interactive repository selection, and incomplete built-in reviewer perspectives. |

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
- [ ] Sanitize and residual-scan complete source text before truncation so a credential crossing the event limit cannot escape detection.
- [ ] Enforce fail-closed maximum artifact bytes, event count and aggregate review-text size before reviewer dispatch.
- [ ] Implement interactive repository-scoped discovery and latest-for-current-repository selection with explicit confirmation; align README.
- [ ] Add all reviewer perspectives required by Spec 006 to the default versioned profile with deterministic coverage.
- [ ] Obtain fresh implementation review and resolve all required findings.
- [ ] Mark `docs/product/roadmap.md` Milestone 1 complete only after all gates pass.
- [ ] Merge the reviewed feature branch into local `main` and record the merge SHA.
