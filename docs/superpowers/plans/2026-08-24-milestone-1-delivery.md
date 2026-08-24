# Milestone 1 delivery plan

## Execution status

Last updated: 2026-08-24. Every checkbox is updated immediately after its verification gate. A checked task records the commit and verification evidence.

| Task | State | Verification / commit |
| --- | --- | --- |
| 1. Delivery design and executable contracts | completed | Design and source boundaries verified; `9ce0d20` adds contracts, `pnpm check` 56 passed. |
| 2. Source adapters and deterministic fixtures | completed | `4a6c90a`, `8181a54`, `a8eebf2`, `522175a`; full `pnpm check` 67 passed. |
| 3. Privacy scrubber and artifact boundary | completed | `96c959a`; independent `pnpm check` 71 passed and diff check passed. |
| 4. Manual review CLI and profile runtime | in progress | `7f837e8` adds profile runtime; CLI source/session integration remains. |
| 5. Parallel orchestration, candidates and proposals | pending | Not started. |
| 6. Milestone acceptance, review and merge | pending | Not started. |

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

- [ ] Add explicit source/session CLI selection and expensive-check gate.
- [x] Resolve versioned reviewer profiles and enforce sanitized-only input: `7f837e8`.
- [x] Add deterministic fake reviewer runtime tests: `7f837e8`.
- [x] Verify runtime: `7f837e8`, independent `pnpm check` 75 passed, 0 failed.

### Task 5: Parallel orchestration, candidates and proposals

- [ ] Run independent reviewers concurrently and sort results deterministically.
- [ ] Group root causes, preserve disagreements and create candidate lessons.
- [ ] Generate traceable proposals with specification requirements where needed.
- [ ] Run `pnpm check` and record the commit SHA.

### Task 6: Milestone acceptance, review and merge

- [ ] Add or update quality fixtures for all Milestone 1 acceptance paths.
- [ ] Run offline verification and security/privacy scans.
- [ ] Obtain fresh implementation review and resolve all required findings.
- [ ] Mark `docs/product/roadmap.md` Milestone 1 complete only after all gates pass.
- [ ] Merge the reviewed feature branch into local `main` and record the merge SHA.
