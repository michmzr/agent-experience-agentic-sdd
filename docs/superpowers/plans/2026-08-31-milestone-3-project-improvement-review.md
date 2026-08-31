# Milestone 3 project-improvement review implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce evidence-backed architecture, developer-experience, and project-management proposals from recurring sanitized session evidence.

**Architecture:** Existing specialist reviewers emit a typed project finding for each supported event. A project-improvement module validates source references, consolidates findings by category and root cause, and promotes only groups with two distinct supporting events and one agreed recommendation. The review service forwards those consolidated improvements through the existing candidate and proposal pipeline.

**Tech stack:** Node.js 22, TypeScript, `node:test`, pnpm.

---

## Scope map

- `src/review/runtime.ts` permits typed evidence arrays and isolates reviewer failures while preserving profile order.
- `src/review/project-improvements.ts` validates and consolidates typed specialist findings.
- `src/review/default-reviewers.ts` emits deterministic architecture, DX, and PM findings.
- `src/review/proposals.ts` preserves project category, severity, and event provenance.
- `src/review/review-service.ts` returns improvements and typed diagnostics with existing review output.
- `test/` proves validation, consolidation, reviewer behavior, failure isolation, and end-to-end provenance.

### Task 1: Define project-improvement findings and consolidation

**Files:**

- Create: `src/review/project-improvements.ts`
- Modify: `src/review/runtime.ts`
- Create: `test/project-improvements.test.ts`

- [ ] **Step 1: Write the failing consolidation tests**

Create `test/project-improvements.test.ts` with a helper that returns this valid finding:

```ts
const finding = (eventId: string, recommendation = 'Split the module boundary') => ({
  code: 'project-improvement',
  findingId: `architecture:${eventId}`,
  rootCauseId: 'module-boundary',
  recommendation,
  category: 'architecture' as const,
  severity: 'high' as const,
  evidenceEventIds: [eventId]
});
```

Assert that two findings for `event-1` and `event-2` produce one improvement with sorted evidence IDs, `high` severity, and the agreed recommendation. Assert that a single finding produces no improvement. Assert that two findings for the same event produce no improvement. Assert that conflicting recommendations produce an `UNRESOLVED_DISAGREEMENT` diagnostic and no improvement. Assert that an unknown event reference and an empty evidence list produce `INVALID_PROJECT_FINDING` diagnostics.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm build && node --test dist/test/project-improvements.test.js
```

Expected: TypeScript cannot resolve `../src/review/project-improvements.js`.

- [ ] **Step 3: Add the typed contract and deterministic consolidation**

Create `src/review/project-improvements.ts` with these public types:

```ts
export const projectImprovementCategories = ['architecture', 'developer-experience', 'project-management'] as const;
export const projectFindingSeverities = ['low', 'medium', 'high'] as const;

export interface ProjectReviewFinding {
  readonly code: 'project-improvement';
  readonly findingId: string;
  readonly rootCauseId: string;
  readonly recommendation: string;
  readonly category: (typeof projectImprovementCategories)[number];
  readonly severity: (typeof projectFindingSeverities)[number];
  readonly evidenceEventIds: readonly string[];
}

export interface ProjectImprovement {
  readonly id: string;
  readonly category: ProjectReviewFinding['category'];
  readonly rootCauseId: string;
  readonly recommendation: string;
  readonly severity: ProjectReviewFinding['severity'];
  readonly findingIds: readonly string[];
  readonly evidenceEventIds: readonly string[];
}

export interface ProjectReviewDiagnostic {
  readonly code: 'INVALID_PROJECT_FINDING' | 'UNRESOLVED_DISAGREEMENT';
  readonly findingId?: string;
}
```

Export `isProjectReviewFinding(value: unknown): value is ProjectReviewFinding` and `consolidateProjectReviewFindings(findings, eventIds)`. Validate every required string, category, severity, and non-empty evidence list. Validate each evidence ID against `eventIds`. Group valid findings by `${category}:${rootCauseId}`, sort groups and IDs lexically, remove duplicate event IDs, require two remaining event IDs, and require exactly one unique recommendation. Pick the highest severity using the exported severity order. Return `{ improvements, diagnostics }`; diagnostic ordering is by code then finding ID. Use IDs in the form `project-improvement:${category}:${rootCauseId}`.

In `src/review/runtime.ts`, change the `ReviewFinding` index signature to permit typed evidence properties:

```ts
export interface ReviewFinding {
  readonly code: string;
  readonly [attribute: string]: unknown;
}
```

This is a type-only widening. The runtime behavior remains unchanged in this task.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm build && node --test dist/test/project-improvements.test.js
```

Expected: all project-improvement tests pass.

- [ ] **Step 5: Commit the consolidation increment**

```bash
git add src/review/project-improvements.ts test/project-improvements.test.ts
git commit -m "feat: consolidate evidence-backed project improvements"
```

### Task 2: Emit deterministic specialist findings

**Files:**

- Modify: `src/review/default-reviewers.ts`
- Modify: `test/default-reviewers.test.ts`

- [ ] **Step 1: Write failing specialist reviewer assertions**

Replace the architecture, developer-experience, and project-management assertions in `test/default-reviewers.test.ts` with assertions for a full project finding. For the existing fixture, assert:

```ts
{
  code: 'project-improvement',
  findingId: 'architecture:tool-1',
  rootCauseId: 'module-boundary',
  recommendation: 'Separate the affected module boundary',
  category: 'architecture',
  severity: 'high',
  evidenceEventIds: ['tool-1']
}
```

Add two events containing `developer experience friction` and `project milestone ownership`; assert that their reviewer output has categories `developer-experience` and `project-management`, stable root-cause IDs `developer-workflow-friction` and `milestone-ownership`, and one source event ID each.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm build && node --test dist/test/default-reviewers.test.js
```

Expected: assertions fail because the reviewers return keyword findings without category, severity, or event provenance.

- [ ] **Step 3: Replace the three keyword reviewers with project reviewers**

In `src/review/default-reviewers.ts`, replace the three corresponding `keywordReviewer` registrations with:

```ts
projectReviewer('architecture', 'architecture', [
  ['module-boundary', ['architecture', 'boundary', 'dependency', 'module'], 'Separate the affected module boundary']
]),
projectReviewer('developer-experience', 'developer-experience', [
  ['developer-workflow-friction', ['developer experience', 'developer-experience', 'dx', 'friction'], 'Remove the recurring developer workflow friction']
]),
projectReviewer('project-management', 'project-management', [
  ['milestone-ownership', ['project', 'milestone', 'plan', 'ownership'], 'Clarify milestone ownership and delivery scope']
]),
```

Implement `projectReviewer` so it scans the sanitized event text and tool name in input order. It emits one `ProjectReviewFinding` per matched event, uses `high` severity for failed events and `medium` otherwise, and sets `evidenceEventIds` to `[event.id]`. Keep all other default reviewers unchanged.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm build && node --test dist/test/default-reviewers.test.js
```

Expected: the default reviewer test passes with the same reviewer order.

- [ ] **Step 5: Commit the reviewer increment**

```bash
git add src/review/default-reviewers.ts test/default-reviewers.test.ts
git commit -m "feat: add deterministic project specialist reviewers"
```

### Task 3: Isolate runtime failures and preserve proposal provenance

**Files:**

- Modify: `src/review/runtime.ts`
- Modify: `src/review/proposals.ts`
- Modify: `src/review/review-service.ts`
- Modify: `test/review-runtime.test.ts`
- Modify: `test/review-proposals.test.ts`
- Create: `test/project-improvement-review.test.ts`

- [ ] **Step 1: Write failing runtime, proposal, and integration tests**

In `test/review-runtime.test.ts`, add a reviewer that throws and a succeeding reviewer. Assert that the succeeding result is returned and that `diagnostics` contains exactly `{ reviewerId: 'broken', code: 'REVIEWER_FAILED' }`.

In `test/review-proposals.test.ts`, pass these optional fields to one input finding and assert they are present on its proposal:

```ts
severity: 'high',
evidenceEventIds: ['event-1', 'event-2']
```

Create `test/project-improvement-review.test.ts` with an injected runtime returning two architecture findings with distinct matching event IDs. Call `runManualReview` and assert it returns one `projectImprovement`, one proposal with category `architecture`, `requiresSpecification: true`, `severity: 'high'`, and both event IDs. Add a single-finding case that returns no project improvement or project proposal.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm build && node --test dist/test/review-runtime.test.js dist/test/review-proposals.test.js dist/test/project-improvement-review.test.js
```

Expected: compilation fails because `ReviewRun.diagnostics`, proposal provenance fields, and `projectImprovements` do not exist.

- [ ] **Step 3: Implement failure isolation, proposal fields, and service integration**

In `src/review/runtime.ts`, add:

```ts
export interface ReviewRuntimeDiagnostic {
  readonly reviewerId: string;
  readonly code: 'REVIEWER_FAILED';
}
```

Add `diagnostics: readonly ReviewRuntimeDiagnostic[]` to `ReviewRun`. Wrap each reviewer call so a thrown error returns the generic diagnostic without exposing its message. Preserve profile order for successful results and diagnostics.

In `src/review/proposals.ts`, add `developer-experience` and `project-management` to `proposalCategories`. Add optional `severity` and `evidenceEventIds` to `ReviewFindingForProposal` and `ImprovementProposal`. Validate that optional severity is one of `low`, `medium`, or `high`; validate a supplied evidence list is non-empty and contains unique non-empty strings. Copy those fields into generated proposals. Keep the existing `requiresSpecification` set unchanged, so only architecture from this increment requires a specification by default.

In `src/review/review-service.ts`, collect all runtime findings, call `consolidateProjectReviewFindings` with the sanitized session event-ID set, and create proposals only from returned improvements:

```ts
const projectReview = consolidateProjectReviewFindings(
  rawFindings.filter(isProjectReviewFinding),
  new Set(artifact.session.events.map((event) => event.id))
);
const projectIntelligence = createReviewProposals({
  sessionId: artifact.session.sessionId,
  findings: projectReview.improvements.map((improvement) => ({
    id: improvement.id,
    statement: `Project improvement ${improvement.rootCauseId}`,
    lessonKind: 'heuristic' as const,
    proposal: { category: improvement.category, title: improvement.recommendation },
    severity: improvement.severity,
    evidenceEventIds: improvement.evidenceEventIds
  }))
});
```

Return `projectImprovements`, `projectReview.diagnostics`, and `run.diagnostics` with the existing result. Do not add a duplicate project improvement to the legacy `findings` group pipeline.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm build && node --test dist/test/review-runtime.test.js dist/test/review-proposals.test.js dist/test/project-improvement-review.test.js
```

Expected: all three focused test files pass.

- [ ] **Step 5: Run the full regression suite**

Run:

```bash
pnpm test
```

Expected: every compiled test passes with zero failures and zero skipped tests.

- [ ] **Step 6: Commit the integrated increment**

```bash
git add src/review/runtime.ts src/review/proposals.ts src/review/review-service.ts test/review-runtime.test.ts test/review-proposals.test.ts test/project-improvement-review.test.ts
git commit -m "feat: surface corroborated project improvement proposals"
```
