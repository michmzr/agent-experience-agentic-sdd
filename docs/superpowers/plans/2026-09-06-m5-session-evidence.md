# M5 session evidence implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Reconstruct privacy-safe session operations, lifecycle state, coverage, time and token measurements from explicitly supplied structured evidence, and preserve versioned reports.

**Architecture:** A pure reconstruction boundary validates a versioned, allowlisted input and derives deterministic operations and metrics without timestamp-based pairing or missing-data inference. A SQLite-backed repository stores immutable reconstruction versions by input digest, while a small service projects existing capture records into the contract. The CLI exposes read-only report generation for a selected stored session.

**Tech stack:** TypeScript, Node.js 22 test runner, `node:sqlite`, SHA-256 identities, pnpm.

---

### Task 1: Reconstruction contract and operation correlation

**Files:**
- Create: `src/evidence/contracts.ts`
- Create: `src/evidence/reconstructor.ts`
- Test: `test/session-evidence-reconstruction.test.ts`

- [x] **Step 1: Write failing correlation and lifecycle tests**

Define fixtures containing reordered results, duplicate identities, unmatched results, repeated timestamps, source-end-before-drain and missing source-end cases. Assert exact-ID pairing, stable operation IDs, explicit unmatched records and the four lifecycle states.

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm build && node --test dist/test/session-evidence-reconstruction.test.js`

Expected: compilation fails because `reconstructSessionEvidence` does not exist.

- [x] **Step 3: Implement the minimal public contract and reconstructor**

Expose `SessionEvidenceInput`, `SessionEvidenceReport`, `SessionOperation`, `SessionLifecycleState`, and:

```ts
export function reconstructSessionEvidence(input: SessionEvidenceInput): SessionEvidenceReport;
```

Validate identifiers, canonical timestamps, bounded arrays and source consistency. De-duplicate equal evidence identities, reject conflicting duplicates, correlate only through `relatedEventId`, and derive lifecycle solely from `sourceEndedAt`, `reconciliationAttempted`, `expectedThrough` and `committedThrough`.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm build && node --test dist/test/session-evidence-reconstruction.test.js`

Expected: all reconstruction tests pass.

### Task 2: Outcomes, coverage and measurements

**Files:**
- Modify: `src/evidence/contracts.ts`
- Modify: `src/evidence/reconstructor.ts`
- Create: `src/evidence/capabilities.ts`
- Test: `test/session-evidence-measurement.test.ts`

- [x] **Step 1: Write failing outcome, waiting, usage and privacy tests**

Cover command failure, successful process followed by failed task verification, unknown result, explicit human waiting, cumulative usage, delta usage, parent/subagent overlap, cached-input subsets, unavailable usage, unsupported classes, truncation and secret-bearing rejected fields.

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm build && node --test dist/test/session-evidence-measurement.test.js`

Expected: assertions fail for missing measurement behavior.

- [x] **Step 3: Implement bounded deterministic measurements**

Publish source capability rows and derive elapsed, unioned active-operation duration, explicitly observed waiting, transport overhead/lag distributions and source-provided token totals. Treat cache tokens as an input subset, exclude child totals when a parent aggregate exists, and keep absent values undefined.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm build && node --test dist/test/session-evidence-measurement.test.js`

Expected: all measurement tests pass.

### Task 3: Immutable reconstruction history

**Files:**
- Create: `src/evidence/repository.ts`
- Test: `test/session-evidence-repository.test.ts`

- [x] **Step 1: Write failing persistence and idempotency tests**

Assert that the same normalized input returns the same version, a late correction appends a new version, earlier JSON remains byte-identical, and references survive reopening the database.

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm build && node --test dist/test/session-evidence-repository.test.js`

Expected: compilation fails because `SessionEvidenceRepository` does not exist.

- [x] **Step 3: Implement the versioned repository**

Use a private SQLite table keyed by session and version, a unique `(session_id, input_digest)` constraint, canonical JSON, parameterized statements and immutable inserts. Expose `save`, `latest` and `history`.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm build && node --test dist/test/session-evidence-repository.test.js`

Expected: all repository tests pass.

### Task 4: Stored-capture projection, CLI report and acceptance evidence

**Files:**
- Create: `src/evidence/capture-projection.ts`
- Modify: `src/storage/experience-store.ts`
- Modify: `src/cli.ts`
- Create: `test/milestone-5-acceptance.test.ts`
- Create: `test/fixtures/session-evidence/scenarios.json`
- Create: `docs/verification/2026-09-06-milestone-5-session-evidence.md`
- Modify: `docs/product/roadmap.md`
- Modify: `tasks/todo.md`

- [x] **Step 1: Write failing projection and CLI acceptance tests**

Assert `ael evidence session <id> --json` reports correlated stored operations without importing artifacts, exposes source capabilities and unavailable fields, and preserves existing raw-event counters. Run the five labeled synthetic scenarios plus changed-environment, missing-data and secret-bearing variants.

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm build && node --test dist/test/milestone-5-acceptance.test.js`

Expected: CLI command and projection are unavailable.

- [x] **Step 3: Implement projection and read-only CLI reporting**

Add a session-scoped capture read method, map pre-action/post-result records without retaining summaries or arguments, construct the report, save a derived version, and render JSON or a compact text report. Do not scan default artifact locations.

- [x] **Step 4: Verify focused and full gates**

Run:

```bash
pnpm build
node --test dist/test/session-evidence-reconstruction.test.js dist/test/session-evidence-measurement.test.js dist/test/session-evidence-repository.test.js dist/test/milestone-5-acceptance.test.js
pnpm check
git diff --check
```

Expected: every command exits 0 with zero failed and zero skipped tests.

- [x] **Step 5: Record measured evidence only after verification**

Write the observed counts and representative local fixture inspection to the verification document, then update milestone status only if every acceptance criterion has direct evidence. Do not claim M4 transport guarantees as part of M5.
