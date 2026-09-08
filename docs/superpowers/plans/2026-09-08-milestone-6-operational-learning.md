# Milestone 6 operational learning implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist evidence-backed, repository-scoped operational episodes and local candidate lessons without delaying passive capture or advising agents.

**Architecture:** New `learning` modules derive deterministic episodes from captured, sanitized events and narrowly scoped repository instructions. A SQLite-backed repository stores coalesced jobs, episodes, findings and candidate knowledge with stable identities; the capture drain only admits jobs. The CLI exposes an explicit analysis report and manual run, while the automatic worker remains bounded and passive.

**Tech Stack:** Node.js 22.17+, TypeScript, `node:sqlite`, `node:test`, pnpm.

**Execution status:** Complete. Tasks 1-7 completed on 2026-09-08. Tool conventions create candidates; repaired commands remain outcome-observed episodes because supported passive sources lack task-verification evidence. Jobs persist capped retries, the worker records bounded coverage, capture admission remains independent, and the CLI exposes repository-scoped run and report commands. Reports expose coverage, findings, hypotheses, unverified repairs, candidates and verified knowledge without exposing repair commands as procedures. Final verification: `pnpm check` passed with 669 tests on 2026-09-08. Evidence: [`docs/verification/2026-09-08-milestone-6-operational-learning.md`](../../verification/2026-09-08-milestone-6-operational-learning.md).

---

## File structure

- Create: `src/learning/contracts.ts`. Public analysis states, records, bounded report and options.
- Create: `src/learning/project-conventions.ts`. Bounded, root-only extraction of explicit `pnpm` and `uv` directives.
- Create: `src/learning/detectors.ts`. Deterministic convention and command-repair episode detection.
- Create: `src/learning/repository.ts`. Transactional SQLite persistence, coalescing and stable identities.
- Create: `src/learning/service.ts`. Bounded job runner that reads captured records and persists detector output.
- Modify: `src/capture/spool-drain.ts`. Enqueue analysis only after a record has committed.
- Modify: `src/application/experience-service.ts` and `src/cli.ts`. Manual analysis and report commands.
- Create: `test/learning-contracts.test.ts`, `test/learning-detectors.test.ts`, `test/learning-repository.test.ts`, `test/learning-service.test.ts` and `test/milestone-6-acceptance.test.ts`.
- Create: `test/fixtures/milestone-6/scenarios.json` and `docs/verification/2026-09-08-milestone-6-operational-learning.md`.

### Task 1: Define M6 contracts and detector inputs

**Files:**

- Create: `src/learning/contracts.ts`
- Create: `test/learning-contracts.test.ts`

- [x] **Step 1: Write failing detector-contract tests**

Add tests that construct a repository-scoped instruction observation and assert a candidate of kind `convention`. Construct a failed action and changed later action and assert an `outcome-observed` episode without a candidate. Assert an unknown outcome produces no candidate and that changing the command target or adding a privilege-changing argument produces a hypothesis only.

- [x] **Step 2: Verify RED**

Run:

    pnpm build && node --test dist/test/learning-detectors.test.js

Expected: TypeScript cannot resolve `src/learning/contracts.js` or `src/learning/detectors.js`.

- [x] **Step 3: Define validated immutable contracts**

Create these public types and constructors:

    export type AnalysisJobState = 'pending' | 'running' | 'completed' | 'retryable-failure' | 'quarantined-input';
    export type EpisodeState = 'unresolved' | 'outcome-observed' | 'solution-supported';
    export type FindingKind = 'repository-tool-convention' | 'command-repair' | 'ambiguous-repair';
    export interface AnalysisCoverage { readonly detector: string; readonly status: 'completed' | 'incomplete' | 'failed'; readonly examinedEvents: number; readonly findings: number; }
    export interface OperationalEpisode { readonly id: string; readonly repositoryId?: string; readonly sessionId: string; readonly detector: string; readonly state: EpisodeState; readonly evidenceEventIds: readonly string[]; readonly attemptedOperation?: string; readonly changedOperation?: string; readonly confirmingEventId?: string; readonly hypothesis?: string; }
    export interface LearningCandidate { readonly id: string; readonly episodeId: string; readonly kind: 'convention'; readonly state: 'candidate'; readonly statement: string; readonly conditions: readonly string[]; readonly procedure: readonly string[]; readonly evidenceEventIds: readonly string[]; readonly invalidationConditions: readonly string[]; }

Reject empty identifiers, duplicate evidence IDs, noncanonical timestamps and unsupported lesson kinds. Keep source commands as structured capture signatures; do not add raw-session text to these contracts.

- [x] **Step 4: Verify GREEN**

Run:

    pnpm build && node --test dist/test/learning-detectors.test.js

Expected: contract validation tests pass.

- [x] **Step 5: Commit**

    git add src/learning/contracts.ts test/learning-contracts.test.ts
    git commit -m "feat: define operational learning contracts"

### Task 2: Implement deterministic detectors

**Files:**

- Create: `src/learning/detectors.ts`
- Modify: `test/learning-detectors.test.ts`

- [x] **Step 1: Write failing behavior tests**

Add a `pnpm` convention test using an explicit repository-scoped instruction record and a separate repository ID with no matching candidate. Add a task-scoped instruction test that returns only a finding. Add repair tests for `npm install` failing followed by `pnpm install`; assert an outcome-observed episode and no repair candidate. Assert a later unrelated success, a transient failed network operation, a zero-only result and a command merely named `test` do not produce a repair candidate.

- [x] **Step 2: Verify RED**

Run:

    pnpm build && node --test dist/test/learning-detectors.test.js

Expected: detector exports do not exist.

- [x] **Step 3: Implement root-only instruction extraction and pure detection**

Create `readProjectToolConventions(repositoryRoot)` in `src/learning/project-conventions.ts`. It must inspect only root-level regular files `AGENTS.md`, `CLAUDE.md` and `.ael/instructions.md`; reject symlinks, files larger than 128 KiB and unreadable inputs without echoing their contents. Match only complete, case-insensitive directives `Use pnpm instead of npm` and `Use uv instead of pip`, and return basename, SHA-256 digest, line number and normalized tool pair.

Export:

    export function detectOperationalEpisodes(input: DetectorInput): DetectorResult;

Map explicit, repository-scoped `pnpm` and `uv` instruction evidence to a `convention` candidate. For repairs, require a captured `post-result` failure linked to a pre-action and a later same-tool-intent action with a different executable or argument set. Emit an outcome-observed episode and an ambiguity finding, never a repair candidate, because Codex and Cursor passive hooks have no task-verification relation. Do not infer confirmation from the executable or its arguments. Treat a target change, `sudo`, `--force`, deletion arguments and unknown result as `ambiguous-repair` findings. Derive IDs with SHA-256 from record type, repository ID, session ID, ordered evidence IDs and detector version. Sort all output by ID before freezing it.

- [x] **Step 4: Verify GREEN**

Run:

    pnpm build && node --test dist/test/learning-detectors.test.js

Expected: convention, repair, ambiguity and scope-isolation tests pass.

- [x] **Step 5: Commit**

    git add src/learning/detectors.ts test/learning-detectors.test.ts
    git commit -m "feat: detect local operational episodes"

### Task 3: Persist jobs, episodes, findings and candidates

**Files:**

- Create: `src/learning/repository.ts`
- Modify: `src/storage/experience-store.ts`
- Create: `test/learning-repository.test.ts`

- [x] **Step 1: Write failing persistence tests**

Use one temporary SQLite database. Enqueue the same repository/session/range twice and assert one pending job. Persist a detector result, reopen the repository and assert the same episode and candidate IDs remain. Persist contradicting evidence for the candidate and assert prior evidence is retained and candidate state becomes `disputed`. Assert an invalid JSON record is quarantined and that a later valid job still runs.

- [x] **Step 2: Verify RED**

Run:

    pnpm build && node --test dist/test/learning-repository.test.js

Expected: TypeScript cannot resolve the learning repository.

- [x] **Step 3: Add the additive schema and repository**

`OperationalLearningRepository` creates additive `operational_*` tables in the existing local SQLite database. It enforces unique `(repository_id, session_id, input_high_water)` jobs and stable IDs for detector records. Existing `ExperienceStore.listRepositoryRecords(repositoryId)` remains the repository-scoped capture reader for the next task.

In `OperationalLearningRepository`, implement `enqueue`, `claim`, `complete`, `retry`, `quarantine`, `saveResult` and `report`. Wrap `saveResult` in `BEGIN IMMEDIATE`; use `INSERT ... ON CONFLICT` only to update provenance and coverage, never to overwrite conflicting evidence. Cap retries at three and sanitize all stored diagnostic text to fixed codes.

- [x] **Step 4: Verify GREEN**

Run:

    pnpm build && node --test dist/test/learning-repository.test.js

Expected: deduplication, restart, contradiction and quarantine tests pass.

- [x] **Step 5: Commit**

    git add src/storage/experience-store.ts src/learning/repository.ts test/learning-repository.test.ts
    git commit -m "feat: persist operational learning analysis"

### Task 4: Run bounded passive analysis

**Files:**

- Create: `src/learning/service.ts`
- Create: `test/learning-service.test.ts`

- [x] **Step 1: Write failing worker tests**

Inject a fake clock and a repository containing 101 events with a limit of 100. Assert the job reports incomplete coverage without preventing a subsequent job from completing. Inject a detector failure and assert state `retryable-failure`, then assert the fourth attempt becomes `quarantined-input`. Assert a completed job stores candidates and an automatic job produces no process output or advice.

- [x] **Step 2: Verify RED**

Run:

    pnpm build && node --test dist/test/learning-service.test.js

Expected: TypeScript cannot resolve the learning service.

- [x] **Step 3: Implement the bounded runner**

Export:

    export class OperationalLearningService {
      runNext(options?: { readonly maxEvents?: number; readonly deadlineMs?: number }): LearningRunResult;
      enqueueCommittedSession(repositoryId: string, sessionId: string): void;
      report(repositoryId: string, sessionId?: string): OperationalLearningReport;
    }

Read only committed capture records in the selected repository. Use defaults of 1,024 events and 250 ms per claimed job. Record one coverage entry per detector. Catch detector errors by detector ID, retain output from other detectors, and convert only bounded errors to retryable/quarantined job state. Never call runtime evaluation, subprocess APIs or hook adapters.

- [x] **Step 4: Verify GREEN**

Run:

    pnpm build && node --test dist/test/learning-service.test.js

Expected: limits, retries, partial coverage and passive-boundary tests pass.

- [x] **Step 5: Commit**

    git add src/learning/service.ts test/learning-service.test.ts
    git commit -m "feat: run bounded passive learning jobs"

### Task 5: Enqueue after capture commitment

**Files:**

- Modify: `src/capture/spool-drain.ts`
- Modify: `src/application/experience-service.ts`
- Modify: `test/capture-spool.test.ts`
- Modify: `test/learning-service.test.ts`

- [x] **Step 1: Write failing integration tests**

Add a drain test that commits a repository-bound session and asserts one analysis job is pending after acknowledgement. Make the learning enqueue dependency throw and assert the capture record is still acknowledged and the drain returns normally. Disable automatic analysis in injected settings and assert no job is created.

- [x] **Step 2: Verify RED**

Run:

    pnpm build && node --test dist/test/capture-spool.test.js dist/test/learning-service.test.js

Expected: the drain has no post-commit learning admission path.

- [x] **Step 3: Wire the non-blocking enqueue**

Extend `DrainCaptureSpoolInput` with optional `learningAdmission`. Immediately after `persistPassiveCapture` succeeds and before `acknowledge`, derive the repository ID from the committed session. Call `enqueueCommittedSession` inside a separate `try/catch`; never retry or quarantine the capture delivery because analysis admission fails. Add `automaticOperationalLearning?: boolean` to project settings with a default of `true`, preserving strict settings validation and backward-compatible defaults.

- [x] **Step 4: Verify GREEN**

Run:

    pnpm build && node --test dist/test/capture-spool.test.js dist/test/learning-service.test.js

Expected: analysis admission is coalesced and capture remains independent of it.

- [x] **Step 5: Commit**

    git add src/capture/spool-drain.ts src/application/experience-service.ts src/config/project-settings.ts test/capture-spool.test.ts test/learning-service.test.ts
    git commit -m "feat: enqueue learning after passive capture"

### Task 6: Expose manual analysis and reports

**Files:**

- Modify: `src/application/experience-service.ts`
- Modify: `src/cli.ts`
- Create: `test/milestone-6-acceptance.test.ts`

- [x] **Step 1: Write failing CLI tests**

Seed a repository with a convention and a repair. Assert `analysis run --repository-id repo-1 --json` completes at most one job and `analysis report --repository-id repo-1 --json` returns separate `coverage`, `findings`, `hypotheses`, `unverifiedRepairs`, `candidates` and `verifiedKnowledge` arrays. Assert unverified repairs contain evidence and a missing-verification reason but no recommended procedure. Assert `analysis report` for another repository has no candidate. Assert unsupported options and a missing repository selection fail without leaking input text.

- [x] **Step 2: Verify RED**

Run:

    pnpm build && node --test dist/test/milestone-6-acceptance.test.js

Expected: CLI rejects the `analysis` command.

- [x] **Step 3: Implement service and CLI surfaces**

Add `ExperienceService.runOperationalAnalysis(repositoryId)` and `ExperienceService.operationalAnalysisReport(repositoryId, sessionId?)`. Add parser branches for:

    ael analysis run --repository-id <id> [--json]
    ael analysis report --repository-id <id> [--session <id>] [--json]

Return report version `1`. The report must expose lifecycle state and evidence IDs, but never raw summaries, source text or executable strings beyond the already-sanitized candidate procedure. Keep `review session` output unchanged.

- [x] **Step 4: Verify GREEN**

Run:

    pnpm build && node --test dist/test/milestone-6-acceptance.test.js

Expected: report compatibility and repository isolation tests pass.

- [x] **Step 5: Commit**

    git add src/application/experience-service.ts src/cli.ts test/milestone-6-acceptance.test.ts
    git commit -m "feat: report operational learning analysis"

### Task 7: Execute M6 acceptance and document evidence

**Files:**

- Create: `test/fixtures/milestone-6/scenarios.json`
- Modify: `test/milestone-6-acceptance.test.ts`
- Create: `docs/verification/2026-09-08-milestone-6-operational-learning.md`
- Modify: `docs/product/roadmap.md`

- [x] **Step 1: Write the acceptance fixture and assertions**

Add labeled fixture scenarios for M6-A1 through M6-A7. Include cross-repository and task-only scope isolation, a confirmed repair, unrelated success, transient outage, positive discovery, unknown outcome, replay/restart, contradiction, coverage with a failed detector and an interrupted worker. Add a credential-like marker to raw fixture input and assert it is absent from every persisted report and diagnostic.

- [x] **Step 2: Verify RED**

Run:

    pnpm build && node --test dist/test/milestone-6-acceptance.test.js

Expected: one or more M6 acceptance requirements are not yet represented by the fixture.

- [x] **Step 3: Complete the fixture-driven behavior and verification record**

Make only the minimal corrections required by the failed acceptance tests. Record exact commands, Node version, platform, test duration and observed report shape in the verification document. Change roadmap M6 status only after the full verification command succeeds.

- [x] **Step 4: Verify GREEN**

Run:

    pnpm check

Expected: build and every compiled test pass.

- [x] **Step 5: Commit**

    git add test/fixtures/milestone-6/scenarios.json test/milestone-6-acceptance.test.ts docs/verification/2026-09-08-milestone-6-operational-learning.md docs/product/roadmap.md
    git commit -m "test: verify milestone 6 operational learning"
