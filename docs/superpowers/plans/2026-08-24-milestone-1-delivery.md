# Milestone 1 delivery plan

## Execution status

Last updated: 2026-08-24. Every checkbox is updated immediately after its verification gate. A checked task records the commit and verification evidence.

| Task | State | Verification / commit |
| --- | --- | --- |
| 1. Delivery design and executable contracts | completed | Design and source boundaries verified; `9ce0d20` adds contracts, `pnpm check` 56 passed. |
| 2. Source adapters and deterministic fixtures | in progress | Codex, Claude Code and Cursor adapters dispatched. |
| 3. Privacy scrubber and artifact boundary | pending | Not started. |
| 4. Manual review CLI and profile runtime | pending | Not started. |
| 5. Parallel orchestration, candidates and proposals | pending | Not started. |
| 6. Milestone acceptance, review and merge | pending | Not started. |

### Task 1: Delivery design and executable contracts

- [x] Define source, privacy, review and proposal boundaries in `2026-08-24-session-intelligence-delivery-design.md`.
- [x] Verify supported ingestion boundaries for Codex, Claude Code and Cursor.
- [x] Add normalized-session and review domain contracts with RED tests.
- [x] Run `pnpm check` and record the commit SHA: `9ce0d20`, 56 passed, 0 failed.

### Task 2: Source adapters and deterministic fixtures

- [ ] Implement injected-root, artifact-led adapter contract.
- [ ] Implement Codex observed-JSONL adapter with unknown-record rejection.
- [ ] Implement Claude Code adapter from verified supported local/export format.
- [ ] Implement Cursor adapter from verified supported local/export format.
- [ ] Add equivalent three-source fixtures and selection tests.
- [ ] Run `pnpm check` and record the commit SHA.

### Task 3: Privacy scrubber and artifact boundary

- [ ] Add RED tests for each redaction category and fail-closed behavior.
- [ ] Implement deterministic sanitization, policy hash and redaction report.
- [ ] Prove raw values cannot reach reviewer input, SQLite or repository artifacts.
- [ ] Run `pnpm check` and record the commit SHA.

### Task 4: Manual review CLI and profile runtime

- [ ] Add explicit source/session CLI selection and expensive-check gate.
- [ ] Resolve versioned reviewer profiles and enforce sanitized-only input.
- [ ] Add deterministic fake reviewer runtime tests.
- [ ] Run `pnpm check` and record the commit SHA.

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
