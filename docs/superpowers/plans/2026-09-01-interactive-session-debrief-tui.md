# Interactive session debrief TUI implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manually launched, keyboard-driven console debrief that presents sanitized review insights and their evidence after interactive session selection without changing existing JSON or non-interactive output.

**Architecture:** A pure builder derives an immutable presentation model from the sanitized session artifact and the completed review. A pure reducer and renderer own navigation and layout, while an injected terminal host owns raw input, resize events, ANSI screen control, and cleanup. The CLI invokes the TUI only for interactive, non-JSON reviews on capable terminals and otherwise preserves the existing text result.

**Tech Stack:** Node.js 22 standard library, TypeScript, ANSI escape sequences, `node:test`, pnpm

---

## Execution status

| Task | State | Verification | Commit |
| --- | --- | --- | --- |
| 1. Debrief presentation model | complete | focused model and CLI tests, then `rtk pnpm test` with 475 passed | `7254a1c`, `3ff8816`, `410f1b3`, `b3ed99a` |
| 2. TUI state and renderer | pending | reducer and renderer tests | `feat: render interactive session debrief` |
| 3. Terminal lifecycle | pending | terminal host lifecycle tests | `feat: run debrief in terminal host` |
| 4. CLI integration and fallback | pending | CLI compatibility tests | `feat: launch debrief from interactive review` |
| 5. Privacy, docs, and release gate | pending | privacy tests and `pnpm check` | `docs: document interactive review debrief` |

Update this table after every task with `in progress`, `complete`, the verification command, and the resulting commit hash.

## File map

- Create `src/review/debrief-model.ts`: immutable presentation types, deterministic insight ordering, evidence resolution, timeline bounds, and counts.
- Modify `src/review/review-service.ts`: expose an internal execution result containing the existing public review result plus the debrief model without changing serialized review fields.
- Create `src/review/debrief-state.ts`: pure TUI state, keyboard actions, resize actions, navigation, and exit semantics.
- Create `src/review/debrief-renderer.ts`: normal and compact ANSI frames with width-safe wrapping and monochrome support.
- Create `src/review/debrief-terminal.ts`: injected terminal boundary, production Node host, input decoding, redraw loop, and exactly-once cleanup.
- Modify `src/cli.ts`: mode gating, TUI invocation, exit 130 handling, generic fallback diagnostic, and unchanged static output.
- Create `test/review-debrief-model.test.ts`: model ordering, counts, timeline, and legacy behavior.
- Create `test/review-debrief-state.test.ts`: reducer transitions and empty-state behavior.
- Create `test/review-debrief-renderer.test.ts`: layout, color, truncation, and viewport limits.
- Create `test/review-debrief-terminal.test.ts`: terminal lifecycle, input, resize, failures, and cleanup.
- Create `test/helpers/debrief-terminal.ts`: reusable deterministic fake terminal host for terminal, CLI, and privacy tests.
- Modify `test/review-cli-terminal.test.ts`: interactive TUI launch, JSON bypass, terminal bypass, fallback, and interrupt behavior.
- Modify `test/review-cli.test.ts`: lock the public JSON field order and existing text output.
- Create `test/review-debrief-privacy.test.ts`: assert that frames and diagnostics contain only sanitized values.
- Modify `README.md`: document invocation, keys, compatibility, and fallback.

### Task 1: Debrief presentation model

**Files:**

- Create: `src/review/debrief-model.ts`
- Modify: `src/review/review-service.ts`
- Create: `test/review-debrief-model.test.ts`
- Test: `test/review-cli.test.ts`

- [ ] **Step 1: Write failing model tests**

Create fixtures directly in `test/review-debrief-model.test.ts`. Use already-sanitized identifiers and text so the tests focus on presentation behavior. Cover severity ordering, stable identifier ties, chronological evidence, the five-row timeline limit, legacy findings without evidence, and an empty review.

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSessionDebrief } from '../src/review/debrief-model.js';
import { sanitizeForReview } from '../src/review/sanitizer.js';

const artifact = sanitizeForReview({
  source: 'codex',
  sessionId: 'session-123',
  startedAt: '2026-09-01T10:00:00.000Z',
  endedAt: '2026-09-01T10:05:00.000Z',
  events: [
    { id: 'event-c', kind: 'tool', occurredAt: '2026-09-01T10:03:00.000Z', tool: 'pnpm', outcome: 'failed', text: 'test failed' },
    { id: 'event-a', kind: 'message', occurredAt: '2026-09-01T10:01:00.000Z', outcome: 'unknown', text: 'started validation' },
    { id: 'event-b', kind: 'tool', occurredAt: '2026-09-01T10:02:00.000Z', tool: 'pnpm', outcome: 'passed', text: 'build passed' },
    { id: 'event-d', kind: 'tool', occurredAt: '2026-09-01T10:04:00.000Z', tool: 'git', outcome: 'passed', text: 'checked diff' }
  ]
});

const [eventC, eventA, eventB, eventD] = artifact.session.events;

const review = {
  source: 'codex' as const,
  selectedSession: artifact.session.sessionId,
  profile: { id: 'default', version: '1' },
  skippedReviewerIds: [],
  runtimeDiagnostics: [],
  findings: [{
    rootCauseId: 'legacy-workflow',
    findings: [{ reviewerId: 'legacy', findingId: 'legacy-1', rootCauseId: 'legacy-workflow', recommendation: 'Keep the verified workflow.' }],
    recommendation: { state: 'agreed' as const, value: 'Keep the verified workflow.' }
  }],
  projectImprovements: [
    { id: 'project-improvement:developer-experience:zeta', category: 'developer-experience' as const, rootCauseId: 'zeta', recommendation: 'Run focused tests first.', severity: 'high' as const, findingIds: ['zeta-1'], evidenceEventIds: [eventC.id, eventA.id, eventB.id, eventD.id] },
    { id: 'project-improvement:architecture:alpha', category: 'architecture' as const, rootCauseId: 'alpha', recommendation: 'Separate the terminal boundary.', severity: 'high' as const, findingIds: ['alpha-1'], evidenceEventIds: [eventA.id, eventB.id] }
  ],
  projectReviewDiagnostics: [],
  serviceDiagnostics: [],
  candidates: [],
  proposals: []
};

test('orders evidence-backed improvements by severity and stable id', () => {
  const debrief = buildSessionDebrief(artifact, review);
  assert.deepEqual(debrief.insights.map(({ id }) => id), [
    'project-improvement:architecture:alpha',
    'project-improvement:developer-experience:zeta',
    'legacy:legacy-workflow'
  ]);
  assert.equal(debrief.initialInsightIndex, 0);
});

test('bounds the compact timeline and orders evidence chronologically', () => {
  const debrief = buildSessionDebrief(artifact, review);
  const insight = debrief.insights[1];
  assert.equal(insight.evidence.length, 4);
  assert.deepEqual(insight.timeline.map(({ kind }) => kind), ['session-start', 'evidence', 'evidence', 'evidence', 'session-end']);
  assert.deepEqual(insight.timeline.slice(1, 4).map(({ occurredAt }) => occurredAt), [
    '2026-09-01T10:01:00.000Z',
    '2026-09-01T10:02:00.000Z',
    '2026-09-01T10:03:00.000Z'
  ]);
});

test('does not fabricate evidence for a legacy finding', () => {
  const debrief = buildSessionDebrief(artifact, { ...review, projectImprovements: [] });
  assert.equal(debrief.insights[0].kind, 'legacy-finding');
  assert.deepEqual(debrief.insights[0].evidence, []);
  assert.deepEqual(debrief.insights[0].timeline, []);
});

test('drops evidence identifiers that do not resolve in the sanitized artifact', () => {
  const debrief = buildSessionDebrief(artifact, {
    ...review,
    projectImprovements: [{
      ...review.projectImprovements[0],
      evidenceEventIds: [eventA.id, 'not-a-sanitized-event-id']
    }]
  });
  assert.deepEqual(debrief.insights[0].evidence.map(({ id }) => id), [eventA.id]);
});

test('derives counts and returns an immutable nested model', () => {
  const debrief = buildSessionDebrief(artifact, {
    ...review,
    findings: [
      ...review.findings,
      { rootCauseId: 'conflict', findings: [], recommendation: { state: 'unresolved-disagreement' as const, values: ['a', 'b'] } }
    ],
    runtimeDiagnostics: [{ reviewerId: 'reviewer-1', code: 'REVIEWER_FAILED' as const }],
    projectReviewDiagnostics: [{ code: 'UNRESOLVED_DISAGREEMENT' as const, findingId: 'finding-1' }],
    skippedReviewerIds: ['reviewer-2']
  });
  assert.deepEqual(debrief.counts, { strengths: 1, improvements: 2, conflicts: 2, diagnostics: 3 });
  assert.equal(Object.isFrozen(debrief), true);
  assert.equal(Object.isFrozen(debrief.insights), true);
  assert.equal(Object.isFrozen(debrief.insights[0].evidence), true);
});

test('represents a completed review with no findings', () => {
  const debrief = buildSessionDebrief(artifact, { ...review, findings: [], projectImprovements: [] });
  assert.equal(debrief.initialInsightIndex, null);
  assert.deepEqual(debrief.insights, []);
  assert.equal(debrief.headline, 'Review completed with no corroborated insights.');
});
```

- [ ] **Step 2: Run the focused test and verify the missing module failure**

Run: `rtk pnpm build`

Expected: FAIL because `src/review/debrief-model.ts` does not exist.

- [ ] **Step 3: Implement the presentation model contract and pure builder**

Create `src/review/debrief-model.ts` with these exported contracts. Keep all arrays frozen through new copies and freeze every nested object before returning.

```ts
import type { AgentSource } from '../domain/types.js';
import type { NormalizedSessionEvent } from './contracts.js';
import type { ReviewFindingGroup } from './orchestrator.js';
import type { ProjectImprovement, ProjectReviewDiagnostic } from './project-improvements.js';
import type { ReviewRuntimeDiagnostic } from './runtime.js';
import type { SanitizedReviewArtifact } from './sanitizer.js';
import type { ReviewServiceDiagnostic } from './review-service.js';

export type DebriefSeverity = 'neutral' | 'low' | 'medium' | 'high';

export interface DebriefEvidence {
  readonly id: string;
  readonly occurredAt: string;
  readonly kind: NormalizedSessionEvent['kind'];
  readonly outcome: NormalizedSessionEvent['outcome'];
  readonly tool?: string;
  readonly summary: string;
}

export interface DebriefTimelineEntry {
  readonly kind: 'session-start' | 'evidence' | 'session-end';
  readonly occurredAt: string;
  readonly evidence?: DebriefEvidence;
}

export interface DebriefInsight {
  readonly id: string;
  readonly kind: 'project-improvement' | 'legacy-finding';
  readonly category: string;
  readonly severity: DebriefSeverity;
  readonly title: string;
  readonly recommendation: string;
  readonly evidence: readonly DebriefEvidence[];
  readonly timeline: readonly DebriefTimelineEntry[];
}

export interface SessionDebriefCounts {
  readonly strengths: number;
  readonly improvements: number;
  readonly conflicts: number;
  readonly diagnostics: number;
}

export interface SessionDebrief {
  readonly source: AgentSource;
  readonly sessionPseudonym: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly actionCount: number;
  readonly headline: string;
  readonly insights: readonly DebriefInsight[];
  readonly initialInsightIndex: number | null;
  readonly counts: SessionDebriefCounts;
}

export interface ReviewForDebrief {
  readonly source: AgentSource;
  readonly findings: readonly ReviewFindingGroup[];
  readonly projectImprovements: readonly ProjectImprovement[];
  readonly projectReviewDiagnostics: readonly ProjectReviewDiagnostic[];
  readonly serviceDiagnostics: readonly ReviewServiceDiagnostic[];
  readonly runtimeDiagnostics: readonly ReviewRuntimeDiagnostic[];
  readonly skippedReviewerIds: readonly string[];
}

export function buildSessionDebrief(
  artifact: SanitizedReviewArtifact,
  review: ReviewForDebrief
): SessionDebrief;
```

Implement the body with these exact rules:

1. Call `assertSanitizedReviewArtifact(artifact)` before reading it, then build an event map only from `artifact.session.events`.
2. For every project improvement, resolve unique `evidenceEventIds` through that map, discard unknown identifiers, sort by `occurredAt` and then `id`, and map only `id`, `occurredAt`, `kind`, `outcome`, optional `tool`, and a structured summary derived from those fields. Never read or copy `event.text` into the model. Use summaries such as `tool pnpm: failed`, `message event: unknown`, and `metadata event: passed`.
3. Include only project improvements with at least one resolved evidence event. Sort them by severity rank `high`, `medium`, `low`, then `id` ascending.
4. Convert every legacy group to an insight with id `legacy:${rootCauseId}`, category `workflow`, severity `neutral`, no evidence, and no timeline. For an unresolved recommendation use `Reviewer recommendations disagree.` as the recommendation and count one conflict.
5. Append legacy insights after project improvements, ordered by `rootCauseId`.
6. A project timeline is `[start, ...firstThreeEvidence, end]`. Never create a timeline for a legacy insight.
7. Count agreed legacy groups as strengths, project insights as improvements, unresolved legacy groups plus `UNRESOLVED_DISAGREEMENT` diagnostics as conflicts, and all runtime, project, service, and skipped-reviewer diagnostics as diagnostics.
8. Before using a reviewer-provided title or recommendation, call `assertDurableTextSafe`. If it rejects the value, use `Review insight` for the title or `Review recommendation is unavailable in this view.` for the recommendation. Format accepted root-cause identifiers by replacing hyphens and underscores with spaces. This prevents known private-value classes from entering a terminal frame through an injected reviewer.
9. Use `Review completed with N evidence-backed improvements.` when project insights exist, `Review completed with N workflow findings.` when only legacy insights exist, and the exact empty headline from the test otherwise.
10. Set `initialInsightIndex` to `0` when insights exist and `null` otherwise.
11. Calculate non-negative `durationMs` from the sanitized timestamps and use sanitized event count for `actionCount`.

- [ ] **Step 4: Split the public review result from the internal execution result**

In `src/review/review-service.ts`, extract the existing return shape into `ManualReviewResult`, add `ManualReviewExecution`, and make the existing API a wrapper. The public `result` object must contain exactly the current keys in the current order.

```ts
export interface ManualReviewResult {
  readonly source: AgentSource;
  readonly selectedSession: string;
  readonly profile: Pick<ReviewProfile, 'id' | 'version'>;
  readonly skippedReviewerIds: readonly string[];
  readonly runtimeDiagnostics: readonly ReviewRuntimeDiagnostic[];
  readonly findings: readonly ReviewFindingGroup[];
  readonly projectImprovements: readonly ProjectImprovement[];
  readonly projectReviewDiagnostics: readonly ProjectReviewDiagnostic[];
  readonly serviceDiagnostics: readonly ReviewServiceDiagnostic[];
  readonly candidates: readonly CandidateLesson[];
  readonly proposals: readonly ImprovementProposal[];
}

export interface ManualReviewExecution {
  readonly result: ManualReviewResult;
  readonly debrief: SessionDebrief;
}

interface ManualReviewPipelineExecution {
  readonly result: ManualReviewResult;
  readonly artifact: SanitizedReviewArtifact;
}

export async function runManualReview(
  input: ManualReviewInput,
  dependencies: ManualReviewDependencies = {}
): Promise<ManualReviewResult> {
  return (await executeManualReviewPipeline(input, dependencies)).result;
}

export async function runManualReviewExecution(
  input: ManualReviewInput,
  dependencies: ManualReviewDependencies = {}
): Promise<ManualReviewExecution> {
  const execution = await executeManualReviewPipeline(input, dependencies);
  return {
    result: execution.result,
    debrief: buildSessionDebrief(execution.artifact, execution.result)
  };
}

async function executeManualReviewPipeline(
  input: ManualReviewInput,
  dependencies: ManualReviewDependencies
): Promise<ManualReviewPipelineExecution> {
  const session = await resolveSelectedSession(input, dependencies);
  const normalized = await loadSession({ ...input, session });
  const artifact = sanitizeForReview(normalized);
  const runtime = dependencies.runtime ?? createDefaultReviewRuntime();
  const run = await runtime.run({ artifact, profile: input.profile ?? defaultReviewProfile, allowExpensiveChecks: input.allowExpensiveChecks });
  const knownEventIds = new Set(artifact.session.events.map((event) => event.id));
  const duplicateReviewerIds = crossReviewerDuplicateReviewerIds(run.results);
  const reviewerReviews = run.results.map((result) => duplicateReviewerIds.has(result.reviewerId)
    ? invalidReviewerResult(result.reviewerId, 'DUPLICATE_REVIEWER_FINDING_ID')
    : validateReviewerResult(result.reviewerId, result.findings, knownEventIds));
  const projectReview = consolidateProjectReviewFindings(
    reviewerReviews.flatMap((review) => review.projectFindings),
    knownEventIds
  );
  const groups = groupReviewFindings(reviewerReviews.flatMap((review) => review.legacyFindings));
  const legacyProposalFindings: readonly ReviewFindingForProposal[] = groups.map((group) => ({
    id: group.rootCauseId,
    statement: `Review finding ${group.rootCauseId}`,
    lessonKind: 'successful-workflow' as LessonKind,
    proposal: { category: 'workflow' as const, title: recommendation(group.recommendation) }
  }));
  const projectProposalFindings: readonly ReviewFindingForProposal[] = projectReview.improvements.map((improvement) => ({
    id: improvement.id,
    statement: `Project improvement ${improvement.rootCauseId}`,
    lessonKind: 'heuristic' as LessonKind,
    proposal: { category: improvement.category, title: improvement.recommendation },
    severity: improvement.severity,
    evidenceEventIds: improvement.evidenceEventIds,
    findingIds: improvement.findingIds
  }));
  const legacyFindingIds = new Set(legacyProposalFindings.map((finding) => finding.id));
  const collisionDiagnostics: readonly ReviewServiceDiagnostic[] = projectProposalFindings
    .filter((finding) => legacyFindingIds.has(finding.id))
    .map((finding) => ({ code: 'PROPOSAL_ID_COLLISION' as const, findingId: finding.id }));
  const serviceDiagnostics: readonly ReviewServiceDiagnostic[] = [
    ...reviewerReviews.flatMap((review) => review.diagnostic ? [review.diagnostic] : []),
    ...collisionDiagnostics
  ].sort(compareServiceDiagnostics);
  const intelligence = createReviewProposals({
    sessionId: artifact.session.sessionId,
    findings: [...legacyProposalFindings, ...projectProposalFindings.filter((finding) => !legacyFindingIds.has(finding.id))]
  });
  const result: ManualReviewResult = {
    source: input.source,
    selectedSession: artifact.session.sessionId,
    profile: run.profile,
    skippedReviewerIds: run.skippedReviewerIds,
    runtimeDiagnostics: run.diagnostics,
    findings: groups,
    projectImprovements: projectReview.improvements,
    projectReviewDiagnostics: projectReview.diagnostics,
    serviceDiagnostics,
    candidates: intelligence.candidates,
    proposals: intelligence.proposals
  };
  return { result, artifact };
}
```

Import `CandidateLesson`, `ImprovementProposal`, and `ReviewFindingForProposal` from `proposals.ts`; `ReviewFindingGroup` from `orchestrator.ts`; `ProjectImprovement` and `ProjectReviewDiagnostic` from `project-improvements.ts`; `ReviewProfile` and `ReviewRuntimeDiagnostic` from `runtime.ts`; `SanitizedReviewArtifact` from `sanitizer.ts`; and `SessionDebrief` plus `buildSessionDebrief` from `debrief-model.ts`. Keep `ManualReviewPipelineExecution` private so `SanitizedReviewArtifact` does not cross the service boundary.

- [ ] **Step 5: Lock the unchanged JSON contract**

Add this assertion to the first JSON review test in `test/review-cli.test.ts` after parsing `output`:

```ts
assert.deepEqual(Object.keys(output), [
  'source',
  'selectedSession',
  'profile',
  'skippedReviewerIds',
  'runtimeDiagnostics',
  'findings',
  'projectImprovements',
  'projectReviewDiagnostics',
  'serviceDiagnostics',
  'candidates',
  'proposals'
]);
assert.equal('debrief' in output, false);
```

- [ ] **Step 6: Build and run focused tests**

Run: `rtk pnpm build`

Expected: PASS with no TypeScript diagnostics.

Run: `rtk node --test dist/test/review-debrief-model.test.js dist/test/review-cli.test.js`

Expected: PASS with zero failed tests.

- [ ] **Step 7: Commit the model boundary**

Run: `rtk git add src/review/debrief-model.ts src/review/review-service.ts test/review-debrief-model.test.ts test/review-cli.test.ts docs/superpowers/plans/2026-09-01-interactive-session-debrief-tui.md`

Run: `rtk git commit -m "feat: build sanitized session debrief model"`

Expected: one commit containing only the listed files.

### Task 2: TUI state and renderer

**Files:**

- Create: `src/review/debrief-state.ts`
- Create: `src/review/debrief-renderer.ts`
- Create: `test/review-debrief-state.test.ts`
- Create: `test/review-debrief-renderer.test.ts`

- [ ] **Step 1: Write failing reducer tests**

Create `test/review-debrief-state.test.ts` around this public state contract:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDebriefState, reduceDebriefState } from '../src/review/debrief-state.js';

test('wraps insight navigation and collapses expanded evidence on selection change', () => {
  const initial = { ...createDebriefState(3, 120, 32, true, 1), view: 'detail' as const, evidenceExpanded: true };
  const next = reduceDebriefState(initial, { type: 'next-insight' }, 3);
  assert.equal(next.selectedInsightIndex, 2);
  assert.equal(next.view, 'overview');
  assert.equal(next.evidenceExpanded, false);
  assert.equal(reduceDebriefState(next, { type: 'next-insight' }, 3).selectedInsightIndex, 0);
  assert.equal(reduceDebriefState(next, { type: 'previous-insight' }, 3).selectedInsightIndex, 1);
});

test('opens details, toggles evidence, and treats escape as back then exit', () => {
  const initial = createDebriefState(1, 100, 30, false, 0);
  const detail = reduceDebriefState(initial, { type: 'open-detail' }, 1);
  assert.equal(detail.view, 'detail');
  assert.equal(reduceDebriefState(detail, { type: 'toggle-evidence' }, 1).evidenceExpanded, true);
  const overview = reduceDebriefState(detail, { type: 'back' }, 1);
  assert.equal(overview.view, 'overview');
  assert.equal(reduceDebriefState(overview, { type: 'back' }, 1).exit, 'completed');
});

test('resizes, quits, interrupts, and remains safe with no insights', () => {
  const empty = createDebriefState(0, 60, 20, true, null);
  assert.equal(reduceDebriefState(empty, { type: 'next-insight' }, 0).selectedInsightIndex, null);
  assert.deepEqual(reduceDebriefState(empty, { type: 'resize', width: 90, height: 25 }, 0), { ...empty, width: 90, height: 25 });
  assert.equal(reduceDebriefState(empty, { type: 'quit' }, 0).exit, 'completed');
  assert.equal(reduceDebriefState(empty, { type: 'interrupt' }, 0).exit, 'interrupted');
});
```

- [ ] **Step 2: Implement the pure reducer**

Create `src/review/debrief-state.ts` with no process or stream imports.

```ts
export type DebriefView = 'overview' | 'detail';
export type DebriefExit = 'active' | 'completed' | 'interrupted';

export interface DebriefState {
  readonly selectedInsightIndex: number | null;
  readonly view: DebriefView;
  readonly evidenceExpanded: boolean;
  readonly width: number;
  readonly height: number;
  readonly color: boolean;
  readonly exit: DebriefExit;
}

export type DebriefAction =
  | { readonly type: 'next-insight' }
  | { readonly type: 'previous-insight' }
  | { readonly type: 'open-detail' }
  | { readonly type: 'toggle-evidence' }
  | { readonly type: 'back' }
  | { readonly type: 'quit' }
  | { readonly type: 'interrupt' }
  | { readonly type: 'resize'; readonly width: number; readonly height: number };

export function createDebriefState(
  insightCount: number,
  width: number,
  height: number,
  color: boolean,
  initialInsightIndex: number | null
): DebriefState;

export function reduceDebriefState(
  state: DebriefState,
  action: DebriefAction,
  insightCount: number
): DebriefState;
```

Clamp viewport dimensions to at least `1`. Navigation wraps modulo `insightCount`, resets to overview, and collapses evidence. `open-detail` and `toggle-evidence` are no-ops without a selected insight. `back` closes detail first and exits only from overview. Ignore every action except resize after exit becomes non-active.

- [ ] **Step 3: Write failing renderer tests**

Create `test/review-debrief-renderer.test.ts` with a small `SessionDebrief` fixture. Assert semantic content rather than a full-frame snapshot.

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import type { SessionDebrief } from '../src/review/debrief-model.js';
import { renderSessionDebrief, stripAnsi, visibleWidth } from '../src/review/debrief-renderer.js';
import { createDebriefState } from '../src/review/debrief-state.js';

const evidence = [
  { id: 'event-a', occurredAt: '2026-09-01T10:01:00.000Z', kind: 'tool' as const, outcome: 'failed' as const, tool: 'pnpm', summary: 'tool pnpm: failed' },
  { id: 'event-b', occurredAt: '2026-09-01T10:02:00.000Z', kind: 'tool' as const, outcome: 'passed' as const, tool: 'pnpm', summary: 'tool pnpm: passed' },
  { id: 'event-c', occurredAt: '2026-09-01T10:03:00.000Z', kind: 'message' as const, outcome: 'unknown' as const, summary: 'message event: unknown' },
  { id: 'event-d', occurredAt: '2026-09-01T10:04:00.000Z', kind: 'tool' as const, outcome: 'passed' as const, tool: 'git', summary: 'tool git: passed' }
];

const model: SessionDebrief = {
  source: 'codex',
  sessionPseudonym: '[REDACTED:opaque-id:session]',
  startedAt: '2026-09-01T10:00:00.000Z',
  endedAt: '2026-09-01T10:05:00.000Z',
  durationMs: 300_000,
  actionCount: 4,
  headline: 'Review completed with 1 evidence-backed improvements.',
  initialInsightIndex: 0,
  counts: { strengths: 1, improvements: 1, conflicts: 0, diagnostics: 0 },
  insights: [{
    id: 'project-improvement:architecture:terminal-boundary',
    kind: 'project-improvement',
    category: 'architecture',
    severity: 'high',
    title: 'terminal boundary',
    recommendation: 'Separate the terminal boundary.',
    evidence,
    timeline: [
      { kind: 'session-start', occurredAt: '2026-09-01T10:00:00.000Z' },
      ...evidence.slice(0, 3).map((item) => ({ kind: 'evidence' as const, occurredAt: item.occurredAt, evidence: item })),
      { kind: 'session-end', occurredAt: '2026-09-01T10:05:00.000Z' }
    ]
  }]
};

test('renders the insight card, compact timeline, counts, and key help', () => {
  const state = createDebriefState(model.insights.length, 100, 30, true, 0);
  const frame = renderSessionDebrief(model, state);
  assert.match(stripAnsi(frame), /SESSION DEBRIEF/);
  assert.match(stripAnsi(frame), /Separate the terminal boundary/);
  assert.match(stripAnsi(frame), /Timeline/);
  assert.match(stripAnsi(frame), /Strengths 1/);
  assert.match(stripAnsi(frame), /Enter details/);
  assert.match(frame, /\u001b\[/);
});

test('uses compact monochrome layout and never exceeds the viewport', () => {
  const state = createDebriefState(model.insights.length, 48, 16, false, 0);
  const frame = renderSessionDebrief(model, state);
  assert.doesNotMatch(frame, /\u001b\[/);
  for (const line of frame.split('\n')) assert.ok(visibleWidth(line) <= 48, line);
  assert.ok(frame.split('\n').length <= 16);
});

test('renders all linked sanitized evidence only when expanded in detail view', () => {
  const detail = { ...createDebriefState(model.insights.length, 100, 30, false, 0), view: 'detail' as const, evidenceExpanded: true };
  const frame = renderSessionDebrief(model, detail);
  assert.match(frame, /4 linked events/);
  assert.match(frame, /tool git: passed/);
});

test('renders an explicit empty state', () => {
  const frame = renderSessionDebrief({ ...model, insights: [], initialInsightIndex: null }, createDebriefState(0, 80, 24, false, null));
  assert.match(frame, /No corroborated insights/);
});
```

- [ ] **Step 4: Implement width-safe ANSI rendering**

Create `src/review/debrief-renderer.ts` with these exports:

```ts
import type { SessionDebrief } from './debrief-model.js';
import type { DebriefState } from './debrief-state.js';

export function renderSessionDebrief(model: SessionDebrief, state: DebriefState): string;
export function stripAnsi(value: string): string;
export function visibleWidth(value: string): number;
```

Implement `stripAnsi` with a local regular expression covering only sequences emitted by this renderer. Build rows as plain text first, fit every row to `state.width`, then apply color to stable tokens. Use `Intl.Segmenter` when available to avoid slicing a grapheme and fall back to `Array.from`. Never slice an ANSI-colored string.

The normal layout at `width >= 80 && height >= 24` contains the title, metadata row, headline, selected insight card, up to five timeline rows, counts, and key help. The compact layout omits decorative borders and shortens metadata and help. The detail view uses the available body rows for recommendation and linked evidence. Reserve the final row for help. Truncate excess rows before joining so `frame.split('\n').length <= height`.

Use only these color roles when `state.color` is true:

```ts
const ansi = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  bold: '\u001b[1m'
} as const;
```

Use red for high severity and failed outcomes, yellow for medium and unknown outcomes, green for passed outcomes, cyan for navigation and structure, and dim text for metadata. Do not emit any ANSI sequence when `state.color` is false.

- [ ] **Step 5: Build and run reducer and renderer tests**

Run: `rtk pnpm build`

Expected: PASS.

Run: `rtk node --test dist/test/review-debrief-state.test.js dist/test/review-debrief-renderer.test.js`

Expected: PASS with zero failed tests.

- [ ] **Step 6: Commit the pure TUI layer**

Run: `rtk git add src/review/debrief-state.ts src/review/debrief-renderer.ts test/review-debrief-state.test.ts test/review-debrief-renderer.test.ts docs/superpowers/plans/2026-09-01-interactive-session-debrief-tui.md`

Run: `rtk git commit -m "feat: render interactive session debrief"`

Expected: one commit containing the reducer, renderer, tests, and updated execution status.

### Task 3: Terminal lifecycle

**Files:**

- Create: `src/review/debrief-terminal.ts`
- Create: `test/review-debrief-terminal.test.ts`
- Create: `test/helpers/debrief-terminal.ts`

- [ ] **Step 1: Write failing lifecycle tests with an injected host**

Create `FakeDebriefTerminalHost` in `test/helpers/debrief-terminal.ts`. It records `enter`, frames, subscriptions, requested sizes, output, and `leave` calls and can emit keys, resize, end, input errors, and process interruptions. Reuse this helper from later CLI and privacy tests. Cover normal quit, back from detail, Ctrl+C, input completion, render failure, input failure, and an injected process interruption.

```ts
import type {
  DebriefKey,
  DebriefTerminalHost,
  DebriefTerminalSize
} from '../../src/review/debrief-terminal.js';

interface FakeHandlers {
  readonly key: (key: DebriefKey) => void;
  readonly resize: (size: DebriefTerminalSize) => void;
  readonly end: () => void;
  readonly error: () => void;
  readonly interrupt: () => void;
}

export class FakeDebriefTerminalHost implements DebriefTerminalHost {
  readonly interactive: boolean;
  readonly color: boolean;
  readonly frames: string[] = [];
  readonly output: string[] = [];
  readonly requestedSizes: DebriefTerminalSize[] = [];
  enterCalls = 0;
  leaveCalls = 0;
  unsubscribeCalls = 0;
  #handlers?: FakeHandlers;
  #size: DebriefTerminalSize = { width: 100, height: 30 };

  constructor(
    private readonly queuedKeys: readonly DebriefKey[] = [],
    private readonly options: { readonly interactive?: boolean; readonly color?: boolean; readonly failEnter?: boolean; readonly failFrame?: boolean } = {}
  ) {
    this.interactive = options.interactive ?? true;
    this.color = options.color ?? false;
  }

  size(): DebriefTerminalSize {
    this.requestedSizes.push(this.#size);
    return this.#size;
  }

  enter(): void {
    this.enterCalls += 1;
    if (this.options.failEnter) throw new Error('injected enter failure');
  }

  writeFrame(frame: string): void {
    if (this.options.failFrame) throw new Error('injected frame failure');
    this.frames.push(frame);
    this.output.push(frame);
  }

  subscribe(handlers: FakeHandlers): () => void {
    this.#handlers = handlers;
    queueMicrotask(() => {
      for (const key of this.queuedKeys) this.#handlers?.key(key);
    });
    return () => {
      this.unsubscribeCalls += 1;
      this.#handlers = undefined;
    };
  }

  leave(): void {
    this.leaveCalls += 1;
  }

  emitKey(key: DebriefKey): void { this.#handlers?.key(key); }
  emitResize(size: DebriefTerminalSize): void {
    this.#size = size;
    this.requestedSizes.push(size);
    this.#handlers?.resize(size);
  }
  emitEnd(): void { this.#handlers?.end(); }
  emitError(): void { this.#handlers?.error(); }
  emitInterrupt(): void { this.#handlers?.interrupt(); }
}
```

In `test/review-debrief-terminal.test.ts`, import the helper and define this complete one-insight model before the tests:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import type { SessionDebrief } from '../src/review/debrief-model.js';
import { runSessionDebrief } from '../src/review/debrief-terminal.js';
import { FakeDebriefTerminalHost } from './helpers/debrief-terminal.js';

const model: SessionDebrief = {
  source: 'codex',
  sessionPseudonym: '[REDACTED:opaque-id:session]',
  startedAt: '2026-09-01T10:00:00.000Z',
  endedAt: '2026-09-01T10:01:00.000Z',
  durationMs: 60_000,
  actionCount: 1,
  headline: 'Review completed with 1 evidence-backed improvements.',
  initialInsightIndex: 0,
  counts: { strengths: 0, improvements: 1, conflicts: 0, diagnostics: 0 },
  insights: [{
    id: 'project-improvement:developer-experience:focused-tests',
    kind: 'project-improvement',
    category: 'developer-experience',
    severity: 'medium',
    title: 'focused tests',
    recommendation: 'Run focused tests first.',
    evidence: [{ id: 'event-a', occurredAt: '2026-09-01T10:00:30.000Z', kind: 'tool', outcome: 'failed', tool: 'pnpm', summary: 'tool pnpm: failed' }],
    timeline: [
      { kind: 'session-start', occurredAt: '2026-09-01T10:00:00.000Z' },
      { kind: 'evidence', occurredAt: '2026-09-01T10:00:30.000Z', evidence: { id: 'event-a', occurredAt: '2026-09-01T10:00:30.000Z', kind: 'tool', outcome: 'failed', tool: 'pnpm', summary: 'tool pnpm: failed' } },
      { kind: 'session-end', occurredAt: '2026-09-01T10:01:00.000Z' }
    ]
  }]
};

test('enters once, redraws on input, and leaves once on normal quit', async () => {
  const host = new FakeDebriefTerminalHost();
  const running = runSessionDebrief(model, host);
  host.emitKey({ name: 'down', ctrl: false });
  host.emitKey({ name: 'q', ctrl: false });
  assert.deepEqual(await running, { status: 'completed' });
  assert.equal(host.enterCalls, 1);
  assert.ok(host.frames.length >= 2);
  assert.equal(host.leaveCalls, 1);
  assert.equal(host.unsubscribeCalls, 1);
});

test('restores the terminal and reports interruption for ctrl-c', async () => {
  const host = new FakeDebriefTerminalHost();
  const running = runSessionDebrief(model, host);
  host.emitKey({ name: 'c', ctrl: true });
  assert.deepEqual(await running, { status: 'interrupted' });
  assert.equal(host.leaveCalls, 1);
});

test('restores the terminal and reports unavailable after a frame failure', async () => {
  const host = new FakeDebriefTerminalHost([], { failFrame: true });
  assert.deepEqual(await runSessionDebrief(model, host), { status: 'unavailable' });
  assert.equal(host.leaveCalls, 1);
});

test('cleans up after input end, input error, initialization failure, and process interruption', async () => {
  for (const [trigger, expected] of [
    [(host: FakeDebriefTerminalHost) => host.emitEnd(), 'completed'],
    [(host: FakeDebriefTerminalHost) => host.emitError(), 'unavailable'],
    [(host: FakeDebriefTerminalHost) => host.emitInterrupt(), 'interrupted']
  ] as const) {
    const host = new FakeDebriefTerminalHost();
    const running = runSessionDebrief(model, host);
    trigger(host);
    assert.deepEqual(await running, { status: expected });
    assert.equal(host.leaveCalls, 1);
  }

  const failedEnter = new FakeDebriefTerminalHost([], { failEnter: true });
  assert.deepEqual(await runSessionDebrief(model, failedEnter), { status: 'unavailable' });
  assert.equal(failedEnter.leaveCalls, 1);
});

test('redraws with new dimensions on resize', async () => {
  const host = new FakeDebriefTerminalHost();
  const running = runSessionDebrief(model, host);
  host.emitResize({ width: 72, height: 20 });
  host.emitKey({ name: 'q', ctrl: false });
  await running;
  assert.deepEqual(host.requestedSizes.at(-1), { width: 72, height: 20 });
});
```

- [ ] **Step 2: Define the terminal boundary and input mapping**

Create `src/review/debrief-terminal.ts` with these public types:

```ts
import type { SessionDebrief } from './debrief-model.js';

export interface DebriefKey {
  readonly name: string;
  readonly ctrl: boolean;
}

export interface DebriefTerminalSize {
  readonly width: number;
  readonly height: number;
}

export interface DebriefTerminalHost {
  readonly interactive: boolean;
  readonly color: boolean;
  size(): DebriefTerminalSize;
  enter(): void;
  writeFrame(frame: string): void;
  subscribe(handlers: {
    readonly key: (key: DebriefKey) => void;
    readonly resize: (size: DebriefTerminalSize) => void;
    readonly end: () => void;
    readonly error: () => void;
    readonly interrupt: () => void;
  }): () => void;
  leave(): void;
}

export type DebriefRunResult =
  | { readonly status: 'completed' }
  | { readonly status: 'interrupted' }
  | { readonly status: 'unavailable' };

export async function runSessionDebrief(
  model: SessionDebrief,
  host: DebriefTerminalHost
): Promise<DebriefRunResult>;

export function createProcessDebriefTerminalHost(): DebriefTerminalHost;
```

Map input exactly as follows: `down` and `j` to `next-insight`, `up` and `k` to `previous-insight`, `return` to `open-detail`, `d` to `toggle-evidence`, `escape` to `back`, `q` to `quit`, and Ctrl+C to `interrupt`. Ignore every other key.

- [ ] **Step 3: Implement the redraw loop and exactly-once cleanup**

`runSessionDebrief` must return `unavailable` immediately when `host.interactive` is false. Otherwise create state from `host.size()`, call `host.enter()`, subscribe, and write the first frame. Each accepted key and resize event reduces state and writes one new frame while active. Resolve only after cleanup.

Use a single guarded finalizer for every path:

```ts
let cleaned = false;
let unsubscribe = () => {};

const finish = (status: DebriefRunResult['status']): void => {
  if (cleaned) return;
  cleaned = true;
  try { unsubscribe(); } catch {}
  try { host.leave(); } catch {}
  resolve({ status });
};
```

An input end exits as `completed`. Subscription, input, render, resize, or initialization failures exit as `unavailable`. The injected interrupt handler and Ctrl+C both reduce to `interrupt`. A reducer exit of `interrupted` returns `interrupted`; all other user exits return `completed`. Do not include caught error messages in the result.

- [ ] **Step 4: Implement the production Node terminal host**

Use `readline.emitKeypressEvents(process.stdin)`, `process.stdin.setRawMode(true)`, `process.stdin.resume()`, `process.stdout.columns`, `process.stdout.rows`, stdout resize events, and a process `SIGINT` listener. `interactive` is true only when both streams report `isTTY` and stdin has `setRawMode`.

Use these exact control sequences:

```ts
const enterScreen = '\u001b[?1049h\u001b[?25l';
const clearAndHome = '\u001b[2J\u001b[H';
const leaveScreen = '\u001b[?25h\u001b[?1049l';
```

`enter()` writes `enterScreen`, records the previous raw-mode value, enables raw mode, and resumes stdin. `writeFrame()` writes `clearAndHome + frame`. `leave()` is internally idempotent, restores the previous raw-mode value, and writes `leaveScreen`. `subscribe()` removes exactly the keypress, resize, stdin end, stdin error, and `SIGINT` listeners it added. Route `SIGINT` through `handlers.interrupt`. Set `color` to false when `NO_COLOR` exists in `process.env` or stdout is not a terminal.

- [ ] **Step 5: Build and run terminal lifecycle tests**

Run: `rtk pnpm build`

Expected: PASS.

Run: `rtk node --test dist/test/review-debrief-terminal.test.js`

Expected: PASS with zero failed tests and no terminal escape sequences printed by the test process.

- [ ] **Step 6: Commit the terminal boundary**

Run: `rtk git add src/review/debrief-terminal.ts test/helpers/debrief-terminal.ts test/review-debrief-terminal.test.ts docs/superpowers/plans/2026-09-01-interactive-session-debrief-tui.md`

Run: `rtk git commit -m "feat: run debrief in terminal host"`

Expected: one commit containing the host, runner, tests, and updated execution status.

### Task 4: CLI integration and fallback

**Files:**

- Modify: `src/cli.ts`
- Modify: `test/review-cli-terminal.test.ts`
- Test: `test/review-cli.test.ts`

- [ ] **Step 1: Write failing CLI mode-selection tests**

Extend `test/review-cli-terminal.test.ts` with `FakeDebriefTerminalHost` from `test/helpers/debrief-terminal.ts`. Drive it by scheduling the exit key with `queueMicrotask()` inside `subscribe()` so the CLI promise completes after the unsubscribe function has been assigned.

```ts
import { FakeDebriefTerminalHost } from './helpers/debrief-terminal.js';
import { stripAnsi } from '../src/review/debrief-renderer.js';

function createInteractiveReviewFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ael-review-tui-'));
  initializeGitRepository(root);
  writeFileSync(join(root, 'latest.jsonl'), `${JSON.stringify({
    kind: 'message',
    occurredAt: '2026-09-01T10:00:00.000Z'
  })}\n`);
  const answers = ['yes'];
  return {
    args: ['review', 'session', '--source', 'codex', '--root', root, '--interactive', '--repository', root, '--session', 'latest'],
    selectionTerminal: {
      write() {},
      async readLine() { return answers.shift() ?? ''; }
    }
  };
}

test('launches the debrief after an interactive non-json review on a terminal', async () => {
  const fixture = createInteractiveReviewFixture();
  const debriefTerminal = new FakeDebriefTerminalHost([{ name: 'q', ctrl: false }]);
  const result = await runCliAsync(fixture.args, {
    terminal: fixture.selectionTerminal,
    debriefTerminal
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(debriefTerminal.enterCalls, 1);
  assert.match(stripAnsi(debriefTerminal.frames[0]), /SESSION DEBRIEF/);
});

test('never launches the debrief for interactive json output', async () => {
  const fixture = createInteractiveReviewFixture();
  const debriefTerminal = new FakeDebriefTerminalHost([{ name: 'q', ctrl: false }]);
  const result = await runCliAsync([...fixture.args, '--json'], {
    terminal: fixture.selectionTerminal,
    debriefTerminal
  });
  assert.equal(result.exitCode, 0);
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  assert.equal(debriefTerminal.enterCalls, 0);
});

test('uses existing static output when terminal capabilities are absent', async () => {
  const fixture = createInteractiveReviewFixture();
  const result = await runCliAsync(fixture.args, {
    terminal: fixture.selectionTerminal,
    debriefTerminal: new FakeDebriefTerminalHost([], { interactive: false })
  });
  assert.match(result.stdout, /^Review completed:/);
  assert.equal(result.stderr, '');
});

test('prints a generic diagnostic and static fallback after TUI failure', async () => {
  const fixture = createInteractiveReviewFixture();
  const result = await runCliAsync(fixture.args, {
    terminal: fixture.selectionTerminal,
    debriefTerminal: new FakeDebriefTerminalHost([], { failFrame: true })
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^Review completed:/);
  assert.equal(result.stderr, 'REVIEW_TUI_UNAVAILABLE: Interactive debrief unavailable; printed text fallback.\n');
});

test('returns 130 without static output after ctrl-c', async () => {
  const fixture = createInteractiveReviewFixture();
  const result = await runCliAsync(fixture.args, {
    terminal: fixture.selectionTerminal,
    debriefTerminal: new FakeDebriefTerminalHost([{ name: 'c', ctrl: true }])
  });
  assert.deepEqual(result, { exitCode: 130, stdout: '', stderr: '' });
});
```

- [ ] **Step 2: Add the terminal host injection seam**

In `src/cli.ts`, extend options and imports:

```ts
import {
  createProcessDebriefTerminalHost,
  runSessionDebrief,
  type DebriefTerminalHost
} from './review/debrief-terminal.js';
import {
  discoverReviewSessions,
  runManualReview,
  runManualReviewExecution,
  type ManualReviewDependencies
} from './review/review-service.js';

export interface RunCliAsyncOptions {
  readonly terminal?: TerminalHost;
  readonly debriefTerminal?: DebriefTerminalHost;
  readonly hookSelectionPrompt?: HookSelectionPrompt;
  readonly workingDirectory?: string;
  readonly cliEntrypoint?: string;
  readonly reviewDependencies?: ManualReviewDependencies;
  readonly hookInput?: string;
  readonly now?: () => string;
}
```

- [ ] **Step 3: Gate the TUI without changing discover, JSON, or static paths**

Replace only the `request.kind === 'review'` result branch in `runCliAsync` with this control flow:

```ts
if (request.kind === 'discover') {
  const value = (await discoverReviewSessions(request)).map(({ source, id, updatedAt }) => ({ source, id, updatedAt }));
  return success(value, json, parsed.positionals);
}

if (!request.interactive || json) {
  return success(await runManualReview(request, reviewDependencies), json, parsed.positionals);
}

const execution = await runManualReviewExecution(request, reviewDependencies);
const terminal = options.debriefTerminal ?? createProcessDebriefTerminalHost();
if (!terminal.interactive) return success(execution.result, false, parsed.positionals);

const debrief = await runSessionDebrief(execution.debrief, terminal);
if (debrief.status === 'completed') return { exitCode: 0, stdout: '', stderr: '' };
if (debrief.status === 'interrupted') return { exitCode: 130, stdout: '', stderr: '' };
const fallback = success(execution.result, false, parsed.positionals);
return {
  ...fallback,
  stderr: 'REVIEW_TUI_UNAVAILABLE: Interactive debrief unavailable; printed text fallback.\n'
};
```

Keep the existing privacy-safe outer catch unchanged. Do not turn non-TTY capability detection into a warning. Do not invoke the TUI for `review sessions`, explicit non-interactive `review session`, or any `--json` request.

- [ ] **Step 4: Build and run all review CLI tests**

Run: `rtk pnpm build`

Expected: PASS.

Run: `rtk node --test dist/test/review-cli-terminal.test.js dist/test/review-cli-options.test.js dist/test/review-cli.test.js`

Expected: PASS with zero failed tests. The interactive JSON test still parses the same public result and the non-interactive text test keeps its current sentence.

- [ ] **Step 5: Commit CLI integration**

Run: `rtk git add src/cli.ts test/review-cli-terminal.test.ts docs/superpowers/plans/2026-09-01-interactive-session-debrief-tui.md`

Run: `rtk git commit -m "feat: launch debrief from interactive review"`

Expected: one commit containing the CLI integration, compatibility tests, and updated execution status.

### Task 5: Privacy, docs, and release gate

**Files:**

- Create: `test/review-debrief-privacy.test.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-09-01-interactive-session-debrief-tui.md`

- [ ] **Step 1: Write an end-to-end privacy test**

Construct a `NormalizedSession` containing a private absolute path, password, API token, raw prompt, assistant content, and tool output. Sanitize it, build a review whose project improvement references the sanitized event IDs, render normal and expanded frames, and assert absence of every raw marker.

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedSession } from '../src/review/contracts.js';
import { buildSessionDebrief, type ReviewForDebrief } from '../src/review/debrief-model.js';
import { renderSessionDebrief } from '../src/review/debrief-renderer.js';
import { createDebriefState } from '../src/review/debrief-state.js';
import { runSessionDebrief } from '../src/review/debrief-terminal.js';
import { sanitizeForReview } from '../src/review/sanitizer.js';
import { FakeDebriefTerminalHost } from './helpers/debrief-terminal.js';

const privateNormalizedSession: NormalizedSession = {
  source: 'codex',
  sessionId: 'private-session-id',
  repositoryHint: '/Users/private/secret-project',
  startedAt: '2026-09-01T10:00:00.000Z',
  endedAt: '2026-09-01T10:03:00.000Z',
  events: [
    { id: 'private-event-1', kind: 'message', occurredAt: '2026-09-01T10:00:00.000Z', outcome: 'unknown', text: 'User: RAW_PRIVATE_PROMPT password=hunter2' },
    { id: 'private-event-2', kind: 'message', occurredAt: '2026-09-01T10:01:00.000Z', outcome: 'unknown', text: 'Assistant: RAW_ASSISTANT_RESPONSE' },
    { id: 'private-event-3', kind: 'tool', occurredAt: '2026-09-01T10:03:00.000Z', outcome: 'failed', tool: 'shell', text: 'RAW_TOOL_OUTPUT sk-live-private-token /Users/private/secret-project' }
  ]
};

function privateReviewResult(eventIds: readonly string[]): ReviewForDebrief {
  return {
    source: 'codex',
    findings: [],
    projectImprovements: [{
      id: 'project-improvement:developer-experience:private-output-boundary',
      category: 'developer-experience',
      rootCauseId: 'private-output-boundary',
      recommendation: 'Keep private event text outside presentation models.',
      severity: 'high',
      findingIds: ['finding-1'],
      evidenceEventIds: eventIds
    }],
    projectReviewDiagnostics: [],
    serviceDiagnostics: [],
    runtimeDiagnostics: [],
    skippedReviewerIds: []
  };
}

test('debrief frames and terminal failures never expose raw session content', async () => {
  const rawMarkers = [
    '/Users/private/secret-project',
    'password=hunter2',
    'sk-live-private-token',
    'RAW_PRIVATE_PROMPT',
    'RAW_ASSISTANT_RESPONSE',
    'RAW_TOOL_OUTPUT'
  ];
  const artifact = sanitizeForReview(privateNormalizedSession);
  const result = privateReviewResult(artifact.session.events.map(({ id }) => id));
  const model = buildSessionDebrief(artifact, result);
  const overview = renderSessionDebrief(model, createDebriefState(model.insights.length, 100, 30, true, model.initialInsightIndex));
  const detail = renderSessionDebrief(model, {
    ...createDebriefState(model.insights.length, 100, 30, true, model.initialInsightIndex),
    view: 'detail',
    evidenceExpanded: true
  });

  for (const marker of rawMarkers) {
    assert.equal(JSON.stringify(model).includes(marker), false, marker);
    assert.equal(`${overview}\n${detail}`.includes(marker), false, marker);
  }

  const host = new FakeDebriefTerminalHost([], { failFrame: true });
  assert.deepEqual(await runSessionDebrief(model, host), { status: 'unavailable' });
  for (const marker of rawMarkers) assert.equal(host.output.join('').includes(marker), false, marker);
});
```

The expected sanitized replacements may appear, but the test must not assert their exact hash values.

- [ ] **Step 2: Run the privacy test**

Run: `rtk pnpm build`

Expected: PASS.

Run: `rtk node --test dist/test/review-debrief-privacy.test.js`

Expected: PASS with zero failed tests.

- [ ] **Step 3: Document the manual TUI workflow**

Add an `Interactive session debrief` subsection near the existing review commands in `README.md` with this content:

~~~~markdown
### Interactive session debrief

Run a repository-scoped review manually:

```bash
ael review session --source codex --root <session-root> --interactive --repository <repository-path> --session latest
```

When standard input and output are terminals, the command opens a keyboard-driven debrief after session confirmation. Use Up/Down or `j`/`k` to select an insight, Enter for details, `d` for linked evidence, Escape to go back or exit, and `q` to exit. Ctrl+C restores the terminal and exits with status 130.

`--json` always returns the existing JSON result and does not start the debrief. Redirected output and terminals without interactive capabilities use the existing text result. Set `NO_COLOR=1` for monochrome rendering.
~~~~

- [ ] **Step 4: Run the complete release gate**

Run: `rtk pnpm check`

Expected: PASS with zero failed tests.

Run: `rtk git diff --check`

Expected: no output and exit code 0.

Run: `rtk git status -sb`

Expected: only the intended README, privacy test, and plan status changes are tracked. Existing untracked visual mockup directories remain uncommitted.

- [ ] **Step 5: Record final execution status and commit documentation**

Update every row in `Execution status` to `complete`, record the focused verification command for each task, and record its commit hash. Then stage only the release files.

Run: `rtk git add README.md test/review-debrief-privacy.test.ts docs/superpowers/plans/2026-09-01-interactive-session-debrief-tui.md`

Run: `rtk git commit -m "docs: document interactive review debrief"`

Expected: one commit containing documentation, the privacy test, and the completed execution ledger.

- [ ] **Step 6: Verify the committed branch**

Run: `rtk pnpm check`

Expected: PASS with zero failed tests.

Run: `rtk git status -sb`

Expected: branch is clean except for the pre-existing untracked `.superpowers/` and `output/` visual artifacts.
