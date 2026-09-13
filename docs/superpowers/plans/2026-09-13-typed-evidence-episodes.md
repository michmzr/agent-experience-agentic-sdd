# Typed evidence episodes implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive local correction, verification-gap, and repeated-acceptance episodes only from typed, bounded evidence.

**Architecture:** The learning contract gains immutable typed evidence records. The detector turns retained tool activity into typed evidence, accepts explicit task and claim evidence, persists each evidence record before dependent episodes, and abstains with a typed finding if a required relation is absent. Existing convention and command-repair records remain compatible.

**Tech Stack:** TypeScript, `node:test`, `node:sqlite`.

---

### Task 1: Define typed evidence

**Files:**

- Modify: `src/learning/contracts.ts`
- Modify: `test/learning-contracts.test.ts`

- [ ] **Step 1: Write failing contract tests**

Add valid tool-request, tool-result, agent-claim, task-transition, and analyzer-inference values. Assert malformed kind, duplicate references, empty scope key, free-text field, and inference without dependencies fail.

```ts
assert.throws(() => createEpisodeEvidence({ ...toolRequest, kind: 'transcript' as never }), /kind/i);
assert.throws(() => createEpisodeEvidence({ ...inference, evidenceIds: [] }), /evidence/i);
assert.equal(Object.isFrozen(createEpisodeEvidence(toolRequest)), true);
```

- [ ] **Step 2: Confirm RED**

Run: `rtk pnpm build && node --test dist/test/learning-contracts.test.js`

Expected: FAIL because `EpisodeEvidence` and its factory do not exist.

- [ ] **Step 3: Implement the bounded contract**

Add `EpisodeEvidenceKind`, `EpisodeEvidence`, and `createEpisodeEvidence`. Retain an identifier, kind, state, normalized decision key, optional scope key, and evidence references. Reject arbitrary text. Add `episodeEvidence` to detector input and learning result.

```ts
export type EpisodeEvidenceKind = 'tool-request' | 'tool-result' | 'task-verification' | 'agent-claim' | 'user-instruction' | 'task-transition' | 'instruction-context' | 'analyzer-inference';
export interface EpisodeEvidence { readonly id: string; readonly kind: EpisodeEvidenceKind; readonly state: 'observed' | 'succeeded' | 'failed' | 'closed'; readonly decisionKey?: string; readonly scopeKey?: string; readonly evidenceIds: readonly string[]; }
```

- [ ] **Step 4: Confirm GREEN and commit**

Run: `rtk pnpm build && node --test dist/test/learning-contracts.test.js`

Expected: PASS; malformed and free-text-shaped records are rejected.

Run: `git add src/learning/contracts.ts test/learning-contracts.test.ts && git commit -m "feat: define typed episode evidence"`

### Task 2: Persist and detect episodes

**Files:**

- Modify: `src/learning/detectors.ts`
- Modify: `src/learning/repository.ts`
- Modify: `test/learning-detectors.test.ts`
- Modify: `test/learning-repository.test.ts`

- [ ] **Step 1: Write failing detector and persistence tests**

Cover a Liquibase-to-SQL correction, closure with absent criterion, repeated acceptance with same scope, repeated acceptance with changed scope, and a correction with no reason. Reopen the repository and assert typed evidence survives.

```ts
assert.equal(result.episodes.find(({ kind }) => kind === 'correction')?.reasonEvidenceId, undefined);
assert.equal(result.episodes.find(({ kind }) => kind === 'verification-gap')?.criterionState, 'unknown');
assert.equal(result.findings.some(({ kind }) => kind === 'insufficient-evidence'), true);
assert.equal(result.episodes.some(({ kind }) => kind === 'repeated-acceptance'), false);
```

- [ ] **Step 2: Confirm RED**

Run: `rtk pnpm build && node --test dist/test/learning-detectors.test.js dist/test/learning-repository.test.js`

Expected: FAIL because episodes are not discriminated and typed evidence is not persisted.

- [ ] **Step 3: Implement additive persistence and abstaining detectors**

Create `operational_episode_evidence`. Validate and insert evidence before its dependent episode. Add correction, verification-gap, and repeated-acceptance payloads. Emit correction only for linked changed decisions; emit verification gap only for closure plus unknown or unmet criterion; require equal decision and scope keys for repeated acceptance. Emit `insufficient-evidence` otherwise. Do not create candidates from these episodes.

```ts
if (first.scopeKey !== second.scopeKey) return noEpisode();
if (!closure || !criterion) return insufficientEvidence('criterion-evidence');
return verificationGap({ closureEvidenceId: closure.id, criterionState: criterion.state });
```

- [ ] **Step 4: Confirm GREEN and commit**

Run: `rtk pnpm build && node --test dist/test/learning-detectors.test.js dist/test/learning-repository.test.js`

Expected: PASS with persistence, scope-change abstention, provenance separation, and missing-evidence findings.

Run: `git add src/learning/detectors.ts src/learning/repository.ts test/learning-detectors.test.ts test/learning-repository.test.ts && git commit -m "feat: derive typed evidence episodes"`

### Task 3: Connect the service and verify issue #9

**Files:**

- Modify: `src/learning/service.ts`
- Modify: `test/learning-service.test.ts`
- Modify: `test/reliable-observation.test.ts`
- Modify: `test/fixtures/reliable-observation/scenarios.json`
- Modify: `docs/superpowers/plans/2026-09-12-reliable-session-observation.md`

- [ ] **Step 1: Write failing end-to-end tests**

Add a synthetic closure with absent criterion and scope-changed repeated approval. Assert the service projects tool request/result evidence, persists a verification-gap report, does not label the changed-scope approval redundant, and does not leak `Liquibase` into report JSON.

```ts
assert.equal(report.episodes.some(({ kind }) => kind === 'verification-gap'), true);
assert.equal(report.episodes.some(({ kind }) => kind === 'repeated-acceptance'), false);
assert.equal(JSON.stringify(report).includes('Liquibase'), false);
```

- [ ] **Step 2: Confirm RED**

Run: `rtk pnpm build && node --test dist/test/learning-service.test.js dist/test/reliable-observation.test.js`

Expected: FAIL because the service does not project typed evidence.

- [ ] **Step 3: Implement service projection**

Project retained pre-action and post-result records into typed tool evidence with bounded local identifiers and decision keys. Pass fixture task evidence through the same detector input. Preserve job boundaries and context snapshots.

```ts
const episodeEvidence = Object.freeze(events.flatMap((event) => episodeEvidenceFromCapture(event)));
const result = detectOperationalEpisodes({ repositoryId, sessionId, events, conventions, episodeEvidence });
```

- [ ] **Step 4: Confirm GREEN, complete acceptance, and commit**

Run: `rtk pnpm build && node --test dist/test/learning-service.test.js dist/test/reliable-observation.test.js`

Run: `rtk pnpm check`

If the parallel cleanup race recurs, run: `rtk pnpm build && node --test dist/test/hook-readiness.test.js && node --test --test-concurrency=1 dist/test/**/*.test.js`

Run: `git diff --check && git status --short && git diff main...HEAD --check`

Expected: focused tests and acceptance pass; no whitespace errors.

Mark Task 7 checked with exact command results, then run: `git add src/learning/service.ts test/learning-service.test.ts test/reliable-observation.test.ts test/fixtures/reliable-observation/scenarios.json docs/superpowers/plans/2026-09-12-reliable-session-observation.md && git commit -m "feat: analyze evidence-backed operational episodes"`
