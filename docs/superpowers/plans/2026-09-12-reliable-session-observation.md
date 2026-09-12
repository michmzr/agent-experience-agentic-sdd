# Reliable session observation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete epic #1 by making passive capture, outcome evidence, analysis, context provenance, and quality reports trustworthy and explicitly bounded.

**Architecture:** Preserve all version 1 persistence and JSON contracts. Add version 2 capture receipts, conversation runs, result facts, analysis streams, context snapshots, and typed episode evidence in additive SQLite tables. Capture writes bounded facts first, drains asynchronously, then schedules bounded analysis after acknowledgement.

**Tech Stack:** TypeScript 5, Node.js 22, `node:sqlite`, Node test runner, pnpm, GitHub CLI.

---

## File structure

- `test/fixtures/reliable-observation/scenarios.json`: synthetic regression corpus and expected quality measures.
- `test/reliable-observation.test.ts`: corpus validation and deterministic evaluator tests.
- `src/capture/contracts.ts`: version 2 capture, receipt, disposition, result-fact, and lifecycle contracts.
- `src/capture/hook-ingress.ts`, `src/capture/hook-adapters/*.ts`, `src/capture/spool*.ts`: private receipt admission, source adaptation, and bounded workers.
- `src/storage/experience-store.ts`: additive migrations and repository APIs for version 2 durable records.
- `src/evidence/*.ts`: version 2 reconstruction with source, receipt, and analysis provenance.
- `src/learning/*.ts`: coalesced stream persistence, automatic execution, context snapshots, and typed episodes.
- `src/application/experience-service.ts`, `src/cli.ts`: explicit version 2 reporting and command orchestration.
- `test/*`: focused regression, migration, privacy, concurrency, CLI, and acceptance tests.
- `docs/verification/2026-09-12-reliable-session-observation.md`: measured baseline/final comparison and unresolved gaps.

### Task 1: Add the synthetic quality corpus for issue #2

**Files:**

- Create: `test/fixtures/reliable-observation/scenarios.json`
- Create: `test/reliable-observation.test.ts`
- Modify: `test/milestone-5-acceptance.test.ts`

- [ ] **Step 1: Write failing corpus tests**

Add tests that parse the fixture as a closed schema and reject raw transcript keys, absolute private paths, credential-like values, duplicate scenario IDs, and missing expected disposition or evidence-gap fields.

```ts
assert.equal(fixture.synthetic, true);
assert.deepEqual(fixture.scenarios.map(({ id }) => id), [
  'resume-after-run-end', 'missing-result', 'privacy-redaction',
  'expected-red', 'liquibase-to-sql', 'closure-with-verification-gap'
]);
assert.deepEqual(evaluateReliableObservationFixture(fixture), fixture.expectedQuality);
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `pnpm build && node --test dist/test/reliable-observation.test.js`

Expected: failure because the fixture and evaluator do not exist.

- [ ] **Step 3: Add the fixture evaluator and synthetic data**

Implement a test-local `evaluateReliableObservationFixture` that counts unique source operation IDs, receipts, linked results, skip dispositions, unknown reasons, analysis states, findings, abstentions, and cost. Store only synthetic identifiers and bounded expected metadata.

```ts
function evaluateReliableObservationFixture(fixture: Fixture): QualityMeasure {
  const receipts = new Map(fixture.receipts.map((receipt) => [receipt.id, receipt]));
  return Object.freeze({
    uniqueOperations: new Set(fixture.receipts.map(({ operationId }) => operationId)).size,
    durableReceipts: receipts.size,
    linkedResults: fixture.results.filter(({ relatedOperationId }) => receipts.has(relatedOperationId)).length,
    skips: countBy(fixture.receipts.filter(({ disposition }) => disposition !== 'accepted'), 'disposition')
  });
}
```

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `pnpm build && node --test dist/test/reliable-observation.test.js`

Expected: all corpus tests pass.

- [ ] **Step 5: Commit issue #2**

Run: `git add test/fixtures/reliable-observation/scenarios.json test/reliable-observation.test.ts test/milestone-5-acceptance.test.ts && git commit -m "test: add reliable observation regression corpus"`

### Task 2: Add conversation and run lifecycle records for issue #3

**Files:**

- Modify: `src/capture/contracts.ts`
- Modify: `src/capture/hook-adapters/codex.ts`
- Modify: `src/capture/spool.ts`
- Modify: `src/capture/spool-drain.ts`
- Modify: `src/storage/experience-store.ts`
- Modify: `test/passive-hook-adapters.test.ts`
- Modify: `test/experience-store.test.ts`

- [ ] **Step 1: Write failing resume and migration tests**

Define a Codex startup, run end, resume, post-result, and second end sequence. Assert two run records link to one conversation, receipt and source times are separate, exact lifecycle duplicates are idempotent, and old session rows have no fabricated run identity.

```ts
assert.equal(store.listConversationRuns('conversation-1').length, 2);
assert.equal(store.listConversationRuns('conversation-1')[1]?.state, 'ended');
assert.equal(store.loadSession('legacy-session' as SessionId)?.endedAt, legacyEnd);
assert.equal(store.conversationForLegacySession('legacy-session'), undefined);
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `pnpm build && node --test dist/test/passive-hook-adapters.test.js dist/test/experience-store.test.js`

Expected: failure because resume is ignored and conversation-run APIs are absent.

- [ ] **Step 3: Add additive lifecycle contracts and migration**

Add `CaptureConversation`, `CaptureRun`, and `LifecycleSignal` contracts. Add versioned tables for conversations, capture runs, and lifecycle signals. Keep `sessions` and `capture_events` unchanged. Update Codex adaptation so `SessionStart` accepts only `startup` and `resume`; map other sources to unsupported disposition. Resolve only deterministic lifecycle transitions and persist ambiguous signals unresolved.

```ts
export interface CaptureRun {
  readonly id: string;
  readonly conversationId: string;
  readonly state: 'open' | 'ended' | 'unresolved';
  readonly receiptStartedAt: string;
  readonly receiptEndedAt?: string;
}
```

- [ ] **Step 4: Run focused lifecycle tests and confirm GREEN**

Run: `pnpm build && node --test dist/test/passive-hook-adapters.test.js dist/test/experience-store.test.js`

Expected: resume, duplicate, delayed, and legacy migration tests pass.

- [ ] **Step 5: Commit issue #3**

Run: `git add src/capture src/storage/experience-store.ts test/passive-hook-adapters.test.ts test/experience-store.test.ts && git commit -m "feat: preserve conversation runs across resumes"`

### Task 3: Account for capture receipts and preserve result facts for issues #4 and #5

**Files:**

- Modify: `src/capture/contracts.ts`
- Modify: `src/capture/hook-ingress.ts`
- Modify: `src/capture/hook-adapters/codex.ts`
- Modify: `src/capture/hook-adapters/cursor.ts`
- Modify: `src/capture/normalization.ts`
- Modify: `src/capture/spool.ts`
- Modify: `src/storage/capture-diagnostic-store.ts`
- Modify: `src/storage/experience-store.ts`
- Modify: `src/evidence/contracts.ts`
- Modify: `src/evidence/capture-projection.ts`
- Modify: `src/evidence/reconstructor.ts`
- Modify: `test/passive-hook-cli.test.ts`
- Modify: `test/session-evidence-reconstruction.test.ts`
- Modify: `test/session-evidence-measurement.test.ts`

- [ ] **Step 1: Write failing receipt and outcome tests**

Assert accepted, duplicate, unsupported, redacted, malformed, retry, quarantine, and unavailable-accounting behavior. Assert exit facts preserve source provenance and `rg` status 1, interruption, environment restriction, expected RED, and missing result have distinct interpretation or unknown reason.

```ts
assert.equal(report.receipts.accounting, 'available');
assert.equal(report.receipts.byDisposition['privacy-redaction'], 1);
assert.equal(operation.result?.unknownReason, 'result-not-delivered');
assert.equal(operation.result?.interpretation?.kind, 'no-match');
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `pnpm build && node --test dist/test/passive-hook-cli.test.js dist/test/session-evidence-reconstruction.test.js dist/test/session-evidence-measurement.test.js`

Expected: failure because receipt ledger, result provenance, and unknown reason contracts are absent.

- [ ] **Step 3: Implement private receipt ledger and result-fact projection**

Persist a bounded receipt before normalization with fixed disposition and an HMAC-derived local correlation key. Do not retain source identifiers, arguments, output, prompts, or paths. Persist source exit facts separately from an interpreter result. Make task verification independent. On receipt persistence failure, return the existing fail-open diagnostic and mark accounting unavailable in reports.

```ts
export interface CaptureReceipt {
  readonly correlationKey: string;
  readonly disposition: CaptureDisposition;
  readonly receivedAt: string;
  readonly relatedCorrelationKey?: string;
}

export interface ResultFact {
  readonly relatedCorrelationKey: string;
  readonly exitStatus?: number;
  readonly provenance: 'hook-envelope' | 'async-completion';
  readonly unknownReason?: ResultUnknownReason;
}
```

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `pnpm build && node --test dist/test/passive-hook-cli.test.js dist/test/session-evidence-reconstruction.test.js dist/test/session-evidence-measurement.test.js`

Expected: receipt, privacy, source-result, and classification tests pass without exposing fixture markers.

- [ ] **Step 5: Commit issues #4 and #5**

Run: `git add src/capture src/storage src/evidence test/passive-hook-cli.test.ts test/session-evidence-reconstruction.test.ts test/session-evidence-measurement.test.ts && git commit -m "feat: account for capture receipts and result facts"`

### Task 4: Coalesce and automatically execute analysis for issue #6

**Files:**

- Modify: `src/learning/contracts.ts`
- Modify: `src/learning/repository.ts`
- Modify: `src/learning/service.ts`
- Modify: `src/capture/spool-drain.ts`
- Modify: `src/capture/hook-ingress.ts`
- Modify: `src/application/experience-service.ts`
- Modify: `src/cli.ts`
- Modify: `test/learning-service.test.ts`
- Modify: `test/capture-spool.test.ts`
- Modify: `test/milestone-2-5-acceptance.test.ts`

- [ ] **Step 1: Write failing stream, lease, and worker-completion tests**

Assert repeated admission raises one stream's desired high-water, a claimed run reads only its declared sequence range, new events remain pending after a run, stale leases recover, unchanged completed input does not rerun, and worker completion waits for the drain lock to release.

```ts
assert.equal(repository.streamsFor('repo-1')[0]?.desiredThrough, 8);
assert.equal(repository.analysisRunsFor('repo-1')[0]?.inputThrough, 5);
assert.equal(repository.streamsFor('repo-1')[0]?.state, 'pending');
assert.equal(await waitForWorkerCompletion(dataDir), true);
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `pnpm build && node --test dist/test/learning-service.test.js dist/test/capture-spool.test.js dist/test/milestone-2-5-acceptance.test.js`

Expected: failure because jobs are keyed by each high-water, the runner rereads the current session, and completion has no worker condition.

- [ ] **Step 3: Implement coalesced streams and bounded analysis drain**

Replace the unique job-per-high-water model with an analysis stream keyed by repository, session or conversation, and detector version. Atomically raise desired high-water. Claim immutable runs with sequence bounds and lease expiry. Schedule one bounded analysis drain only after acknowledgement. Publish a worker-complete condition after database and spool resources close.

```ts
enqueue(input): AnalysisStream {
  return this.raiseDesiredThrough(input.repositoryId, input.sessionId, detectorVersion, input.highWater);
}

complete(run): void {
  this.advanceCompletedThrough(run.streamId, run.inputThrough);
  this.requeueIfDesiredAhead(run.streamId);
}
```

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `pnpm build && node --test dist/test/learning-service.test.js dist/test/capture-spool.test.js dist/test/milestone-2-5-acceptance.test.js`

Expected: coalescing, actual-range, restart, bounded retry, and cleanup-race regression tests pass.

- [ ] **Step 5: Commit issue #6**

Run: `git add src/learning src/capture src/application/experience-service.ts src/cli.ts test/learning-service.test.ts test/capture-spool.test.ts test/milestone-2-5-acceptance.test.ts && git commit -m "feat: coalesce and run operational analysis automatically"`

### Task 5: Add explicit quality reporting for issue #7

**Files:**

- Modify: `src/application/experience-service.ts`
- Modify: `src/cli.ts`
- Modify: `src/learning/repository.ts`
- Modify: `src/storage/experience-store.ts`
- Modify: `test/cli.test.ts`
- Modify: `test/repository-observability.test.ts`
- Modify: `skills/ael/references/setup-and-health.md`
- Modify: `skills/ael/references/diagnostics.md`

- [ ] **Step 1: Write failing schema-version 2 report tests**

Assert default JSON is unchanged. Assert explicit `--schema-version 2` distinguishes ready installation with backlog, all unknown results, no analysis, completed no-findings, failed analysis, and absent denominator.

```ts
assert.deepEqual(JSON.parse(runCli(['status', '--json']).stdout), legacyStatus);
assert.equal(quality.analysis.state, 'pending');
assert.equal(quality.dataQuality.completeness, 'unavailable');
assert.equal(quality.analysis.result, 'no-findings');
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `pnpm build && node --test dist/test/cli.test.js dist/test/repository-observability.test.js`

Expected: failure because schema version 2 reports do not exist.

- [ ] **Step 3: Implement the multidimensional report**

Add an explicit schema-version option and a report assembler that reads installation, spool delivery, receipt quality, and analysis stream state independently. Keep legacy output untouched when no version is requested. Keep global aggregation path-free.

```ts
return Object.freeze({
  version: 2,
  installation: installationState,
  delivery: deliveryState,
  dataQuality: qualityState,
  analysis: analysisState
});
```

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `pnpm build && node --test dist/test/cli.test.js dist/test/repository-observability.test.js`

Expected: version 1 compatibility and version 2 state-separation tests pass.

- [ ] **Step 5: Commit issue #7**

Run: `git add src/application/experience-service.ts src/cli.ts src/learning/repository.ts src/storage/experience-store.ts test/cli.test.ts test/repository-observability.test.ts skills/ael/references && git commit -m "feat: report installation data and analysis quality separately"`

### Task 6: Preserve historical instruction and execution context for issue #8

**Files:**

- Modify: `src/config/project-settings.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/learning/project-conventions.ts`
- Modify: `src/learning/contracts.ts`
- Modify: `src/learning/repository.ts`
- Modify: `src/learning/service.ts`
- Modify: `src/repository/local-repository.ts`
- Create: `test/learning-project-conventions.test.ts`
- Modify: `test/learning-service.test.ts`

- [ ] **Step 1: Write failing immutable-context tests**

Assert `.agents/AGENTS.md` is found under configured bounded locations, found is not delivered or read, later file mutation cannot alter a stored snapshot, separate worktrees retain separate keyed identities, and unknown agent provenance stays unknown.

```ts
assert.equal(snapshot.instructions[0]?.found, true);
assert.equal(snapshot.instructions[0]?.delivered, 'unknown');
assert.equal(snapshot.instructions[0]?.explicitlyRead, 'unknown');
assert.notEqual(snapshot.worktreeKey, otherSnapshot.worktreeKey);
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `pnpm build && node --test dist/test/learning-project-conventions.test.js dist/test/learning-service.test.js`

Expected: failure because context snapshots and `.agents/AGENTS.md` support do not exist.

- [ ] **Step 3: Implement immutable context snapshots**

Add bounded configurable instruction locations. At first retained event, persist only relative location, scope, keyed digest, state triples, and evidence identity. Derive repository family from Git common directory and worktree from canonical root using local keys. Do not persist raw instruction text, absolute paths, or source agent IDs.

```ts
export interface InstructionContext {
  readonly location: string;
  readonly found: boolean;
  readonly delivered: 'yes' | 'no' | 'unknown';
  readonly explicitlyRead: 'yes' | 'no' | 'unknown';
  readonly digest: string;
}
```

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `pnpm build && node --test dist/test/learning-project-conventions.test.js dist/test/learning-service.test.js`

Expected: context history, worktree isolation, symlink safety, and privacy tests pass.

- [ ] **Step 5: Commit issue #8**

Run: `git add src/config src/domain src/learning src/repository test/learning-project-conventions.test.ts test/learning-service.test.ts && git commit -m "feat: preserve instruction and worktree provenance"`

### Task 7: Detect evidence-backed corrections and verification gaps for issue #9

**Files:**

- Modify: `src/learning/contracts.ts`
- Modify: `src/learning/detectors.ts`
- Modify: `src/learning/repository.ts`
- Modify: `src/learning/service.ts`
- Modify: `src/evidence/contracts.ts`
- Modify: `src/evidence/reconstructor.ts`
- Modify: `test/learning-detectors.test.ts`
- Modify: `test/learning-repository.test.ts`
- Modify: `test/reliable-observation.test.ts`

- [ ] **Step 1: Write failing typed-episode tests**

Assert a Liquibase-to-SQL correction retains decision, correction, reason, and outcome evidence; a closure with missing verification becomes a verification-gap episode; an agent claim differs from a tool result; scope-changed repeat acceptance abstains; and missing evidence remains an abstention.

```ts
assert.equal(episodes[0]?.kind, 'correction');
assert.equal(episodes[1]?.kind, 'verification-gap');
assert.equal(episodes[1]?.criterionState, 'unknown');
assert.equal(findings[0]?.kind, 'insufficient-evidence');
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `pnpm build && node --test dist/test/learning-detectors.test.js dist/test/learning-repository.test.js dist/test/reliable-observation.test.js`

Expected: failure because current episodes only represent convention and command-repair paths.

- [ ] **Step 3: Implement typed evidence references and abstaining detectors**

Introduce discriminated episode kinds and typed evidence provenance. Persist implementation facts, checks, criteria, claims, and closure separately. Require unchanged scope for repeated acceptance. Return an explicit insufficient-evidence finding when a required relation is missing.

```ts
export type EpisodeKind = 'correction' | 'verification-gap' | 'repeated-acceptance';
export type EvidenceKind = 'tool-request' | 'source-result' | 'task-verification' |
  'user-instruction' | 'agent-claim' | 'task-transition' | 'instruction-context' | 'analyzer-inference';
```

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `pnpm build && node --test dist/test/learning-detectors.test.js dist/test/learning-repository.test.js dist/test/reliable-observation.test.js`

Expected: correction, gap, negative, scope-change, and abstention tests pass.

- [ ] **Step 5: Commit issue #9**

Run: `git add src/learning src/evidence test/learning-detectors.test.ts test/learning-repository.test.ts test/reliable-observation.test.ts && git commit -m "feat: derive evidence-backed correction episodes"`

### Task 8: Verify, document, and prepare the pull request

**Files:**

- Create: `docs/verification/2026-09-12-reliable-session-observation.md`
- Modify: `README.md`
- Modify: `docs/product/acceptance-criteria.md`
- Modify: `docs/sdd/specs/008-passive-agent-capture.md`
- Modify: `docs/superpowers/plans/2026-09-12-reliable-session-observation.md`

- [ ] **Step 1: Update every completed plan checkbox and issue traceability entry**

Mark only verified steps complete. Record the commit, focused command, output count, and GitHub issue comment URL beside each task.

- [ ] **Step 2: Write the final measured verification report**

Record fixture baseline and final evaluator output, test totals, known denominator availability, analysis cost, unresolved gaps, privacy scans, migration compatibility, and the exact version 1 and version 2 CLI commands.

- [ ] **Step 3: Run all required verification**

Run: `pnpm check`

Expected: exit code 0 with zero test failures.

Run: `git diff --check && git status --short && git diff main...HEAD --check`

Expected: no whitespace errors and only intended tracked changes.

- [ ] **Step 4: Commit final documentation and verification evidence**

Run: `git add README.md docs/product/acceptance-criteria.md docs/sdd/specs/008-passive-agent-capture.md docs/verification/2026-09-12-reliable-session-observation.md docs/superpowers/plans/2026-09-12-reliable-session-observation.md && git commit -m "docs: verify reliable session observation"`

- [ ] **Step 5: Open one pull request**

Push `codex/issue-1-reliable-observation`, create a pull request that closes #1 and references #2 through #9, and include the final verification output and remaining explicit limitations.
