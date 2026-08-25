# Milestone 2 runtime learning implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic runtime learning, enforcement, shared Git knowledge activation, and resilient local fallback without requiring a network, LLM, or daemon on the hot path.

**Architecture:** Runtime inputs are normalized into immutable intent or action contracts, matched against an in-memory rule snapshot, and evaluated by a pure policy matrix. Private captured evidence remains in SQLite, while repository knowledge becomes authoritative only when loaded from an explicitly trusted local Git ref; validated snapshots preserve last-known-good behavior during storage or Git failures.

**Tech stack:** TypeScript 5.9, Node.js 22 built-ins, `node:sqlite`, `node:test`, local Git subprocesses through injected adapters, pnpm.

**Execution status (2026-08-25):** Tasks 1-7 complete. Task 8 implementation and verification are complete at `4d9b493a241948b1598e6c652aa5fc4e00dbf6e8`; final independent review of the production knowledge-to-runtime bridge is pending.

---

## Fixed policy decisions

- Only authoritative knowledge affects WARN or BLOCK. Branch-local, unapproved, or otherwise non-authoritative entries remain retrievable context with an ALLOW decision.
- Verified authoritative exact conflicts may BLOCK. Verified metadata conflicts and confirmed conflicts WARN. Observed and disputed entries never block. Terminal entries do not enter runtime snapshots.
- Learning profile changes a would-be BLOCK to WARN without disabling retrieval, override auditing, or capture.
- Automatic capture writes normalized events, observations, candidates, and evidence. It may transition existing knowledge through canonical lifecycle rules, but it never silently creates new durable policy.
- Repository activation is derived from an explicitly trusted local Git ref or commit. Promotion writes branch-local review artifacts and cannot self-assert merged activation.
- Runtime decisions use an immutable in-memory snapshot only. SQLite, Git, Markdown parsing, optional semantic ranking, and snapshot compilation stay outside the hot path.

### Task 1: Runtime contracts, matcher, and policy

**Files:**

- Create: `src/runtime/contracts.ts`
- Create: `src/runtime/matcher.ts`
- Create: `src/runtime/policy.ts`
- Create: `test/runtime-policy.test.ts`
- Create: `test/runtime-matcher.test.ts`

- [x] **Step 1: Write failing policy tests**

Cover the complete state matrix with table-driven tests. The core fixtures must use contracts equivalent to:

```ts
const exactVerified = rule({ state: 'verified', authoritative: true, match: 'exact' });
assert.equal(evaluateRule(exactVerified, normalProfile).outcome, 'BLOCK');
assert.equal(evaluateRule(exactVerified, learningProfile).outcome, 'WARN');
assert.equal(evaluateRule(rule({ state: 'confirmed', authoritative: true, match: 'exact' }), normalProfile).outcome, 'WARN');
assert.equal(evaluateRule(rule({ state: 'disputed', authoritative: true, match: 'exact' }), normalProfile).outcome, 'ALLOW');
assert.equal(evaluateRule(rule({ state: 'verified', authoritative: false, match: 'exact' }), normalProfile).outcome, 'ALLOW');
```

- [x] **Step 2: Run focused policy tests and verify RED**

Run: `pnpm build && node --test dist/test/runtime-policy.test.js`

Expected: FAIL because runtime contracts and policy modules do not exist.

- [x] **Step 3: Implement immutable runtime contracts and pure policy**

Define `RuntimeInput`, `RuntimeRule`, `RuleMatch`, `RuntimeProfile`, `RuntimeDecision`, `OperationClass`, `DecisionOutcome`, and structured explanation/reference types. `evaluateRule()` must be synchronous and accept all dependencies as values. It must not import filesystem, SQLite, subprocess, network, review, or clock modules.

- [x] **Step 4: Write failing matcher tests**

Test canonical exact action signatures, argument-sensitive mismatches, technical intent inputs, POSIX and Windows path normalization, metadata strength, tag subset matching, combined global and repository applicability, cross-repository isolation, and stable rule-ID ordering.

- [x] **Step 5: Run focused matcher tests and verify RED**

Run: `pnpm build && node --test dist/test/runtime-matcher.test.js`

Expected: FAIL because matcher behavior is absent.

- [x] **Step 6: Implement deterministic matching**

Canonical signatures must be explicit allowlisted structured fields, never inferred from lesson prose. Match order is exact signature, repository/tool/path metadata, then tags. Return immutable matches sorted by strength and rule ID. Expose optional semantic enrichment as an interface only and do not invoke it from the deterministic path.

- [x] **Step 7: Verify task 1**

Run: `pnpm build && node --test dist/test/runtime-policy.test.js dist/test/runtime-matcher.test.js`

Expected: all task 1 tests pass.

- [x] **Step 8: Commit task 1**

```sh
git add src/runtime/contracts.ts src/runtime/matcher.ts src/runtime/policy.ts test/runtime-policy.test.ts test/runtime-matcher.test.ts
git commit -m "feat: add deterministic runtime policy"
```

### Task 2: Runtime profiles and target resolution

**Files:**

- Create: `src/config/runtime-profile.ts`
- Create: `src/config/profile-resolver.ts`
- Create: `test/runtime-profile.test.ts`
- Create: `test/profile-resolver.test.ts`

- [x] **Step 1: Write failing built-in profile tests**

Define normal, learning, and observe-only profiles. Assert learning preserves capture and retrieval while disabling hard blocking, observe-only disables WARN/BLOCK but preserves explanations, and profile objects are immutable.

- [x] **Step 2: Run profile tests and verify RED**

Run: `pnpm build && node --test dist/test/runtime-profile.test.js`

Expected: FAIL because runtime profiles do not exist.

- [x] **Step 3: Implement built-in profiles and validated inheritance**

Custom profiles may inherit one built-in profile and override only declared runtime fields. Reject unknown parents, unknown fields, circular references, and profiles that disable capture while claiming learning mode.

- [x] **Step 4: Write failing resolution tests**

Test field-level precedence in this order: session/CLI override, local exact target, local wildcard target, repository-shared setting, global exact remote/path, global wildcard remote/path, global default, built-in default. Include exact and wildcard Git remotes, exact and wildcard workspace paths, non-Git directories, deterministic wildcard specificity, and an explanation trace for every resolved field.

- [x] **Step 5: Implement deterministic resolver**

Use injected repository/workspace facts. Do not call Git or the filesystem from the resolver. Normalize remote URLs and paths before matching, reject ambiguous equally specific selectors, and return `{ profile, trace }`.

- [x] **Step 6: Verify and commit task 2**

Run: `pnpm build && node --test dist/test/runtime-profile.test.js dist/test/profile-resolver.test.js`

Expected: all task 2 tests pass.

```sh
git add src/config/runtime-profile.ts src/config/profile-resolver.ts test/runtime-profile.test.ts test/profile-resolver.test.ts
git commit -m "feat: resolve runtime learning profiles"
```

### Task 3: Shared knowledge schema, promotion, and Git activation

**Files:**

- Create: `src/shared-knowledge/schema.ts`
- Create: `src/shared-knowledge/promotion-policy.ts`
- Create: `src/shared-knowledge/git-activation.ts`
- Create: `src/shared-knowledge/repository.ts`
- Modify: `src/storage/repository-knowledge.ts`
- Create: `test/shared-knowledge-schema.test.ts`
- Create: `test/knowledge-promotion.test.ts`
- Create: `test/git-knowledge-activation.test.ts`

- [x] **Step 1: Write failing versioned-schema tests**

Version 2 index entries must contain identity, document path, repository scope, kind, lifecycle state, structured applicability, instruction origin, approval, last verification, and superseded identities. Test version 1 read compatibility, version 2 round-trip, malformed timestamps, duplicate IDs, unsafe document paths, missing/orphan documents, index/Markdown identity disagreement, and sanitized evidence summaries.

- [x] **Step 2: Run schema tests and verify RED**

Run: `pnpm build && node --test dist/test/shared-knowledge-schema.test.js`

Expected: FAIL because no public reader or version 2 schema exists.

- [x] **Step 3: Implement strict schema and repository boundary**

Keep `agent-experience/index.json` and `agent-experience/knowledge/<id>.md`. Preserve version 1 reads, write version 2 deterministically, validate the complete staged directory before publishing, reject symlinks and path escapes, and retain the previous complete generation if publication fails. The Markdown sections are title, Context, Lesson, Recommended behavior, and Evidence summary.

- [x] **Step 4: Write failing promotion-policy tests**

Test code/tool-confirmed facts, user preferences, skill/workflow candidates, task-specific constraints, disputed entries, missing evidence, and approval requirements. Facts may be promoted without manual approval only when deterministic tool/code evidence exists. Preferences and skill/workflow candidates require approval. Task constraints and disputed entries are rejected.

- [x] **Step 5: Implement promotion policy**

Return an explainable eligibility result. Promotion produces branch-local files only and cannot accept `merged-team-active` or caller-provided merged provenance.

- [x] **Step 6: Write failing real-Git activation tests**

Using `test/helpers/git-repository.ts`, assert that a trusted-ref entry is authoritative, a feature-branch addition is local context, a branch modification cannot replace the trusted version, and the addition becomes authoritative only after the trusted ref contains the merge commit. Require an explicit trusted ref; no ref means no team activation.

- [x] **Step 7: Implement injected Git activation**

Read knowledge from a configured trusted local ref through an injected Git content adapter. Derive provenance from the resolved commit. Overlay working-tree/branch entries as non-authoritative context. Do not run Git on the decision path.

- [x] **Step 8: Verify and commit task 3**

Run: `pnpm build && node --test dist/test/repository-knowledge.test.js dist/test/shared-knowledge-schema.test.js dist/test/knowledge-promotion.test.js dist/test/git-knowledge-activation.test.js`

Expected: existing repository writer tests and all new task 3 tests pass.

```sh
git add src/shared-knowledge src/storage/repository-knowledge.ts test/shared-knowledge-schema.test.ts test/knowledge-promotion.test.ts test/git-knowledge-activation.test.ts
git commit -m "feat: activate merged repository knowledge"
```

### Task 4: Immutable snapshots and resilient fallback

**Files:**

- Create: `src/runtime/rule-index.ts`
- Create: `src/runtime/snapshot.ts`
- Create: `src/runtime/resilience.ts`
- Create: `src/runtime/circuit-breaker.ts`
- Create: `src/storage/runtime-snapshot-store.ts`
- Create: `test/runtime-snapshot.test.ts`
- Create: `test/runtime-degradation.test.ts`
- Create: `test/runtime-circuit-breaker.test.ts`

- [x] **Step 1: Write failing snapshot tests**

Test schema/version validation, deterministic serialization, repository isolation, authoritative global plus repository composition, terminal-state exclusion, immutable indexes, atomic replacement, corrupt/incompatible snapshot rejection, and failed rebuild preserving the prior snapshot.

- [x] **Step 2: Run snapshot tests and verify RED**

Run: `pnpm build && node --test dist/test/runtime-snapshot.test.js`

Expected: FAIL because snapshot modules do not exist.

- [x] **Step 3: Implement snapshot compiler and last-known-good store**

Compile only runtime-safe structured rules. Write a candidate file, reopen and validate it, then atomically replace current. Keep the previous valid snapshot as last-known-good. Freeze loaded rule arrays and nested values.

- [x] **Step 4: Write failing degradation and circuit tests**

Cover fallback order: in-memory, freshly compiled local snapshot, last-known-good snapshot, degraded policy. Ordinary degraded actions ALLOW with a one-time diagnostic; protected actions BLOCK only when the effective profile explicitly fails closed. Open the circuit after the configured consecutive failure threshold, skip repeated expensive loads while open, and allow an injected successful recovery probe to close it.

- [x] **Step 5: Implement resilience and circuit breaker**

All clocks and loaders are injected. Status must expose health, profile ID, hard-blocking state, retrieval mode, fallback source, and circuit state. Never catch policy/matcher programming errors as storage degradation.

- [x] **Step 6: Verify and commit task 4**

Run: `pnpm build && node --test dist/test/runtime-snapshot.test.js dist/test/runtime-degradation.test.js dist/test/runtime-circuit-breaker.test.js`

Expected: all task 4 tests pass.

```sh
git add src/runtime/rule-index.ts src/runtime/snapshot.ts src/runtime/resilience.ts src/runtime/circuit-breaker.ts src/storage/runtime-snapshot-store.ts test/runtime-snapshot.test.ts test/runtime-degradation.test.ts test/runtime-circuit-breaker.test.ts
git commit -m "feat: add resilient runtime snapshots"
```

### Task 5: Gate orchestration and auditable overrides

**Files:**

- Create: `src/runtime/gate.ts`
- Create: `src/runtime/override.ts`
- Create: `src/storage/override-store.ts`
- Modify: `src/storage/experience-store.ts`
- Create: `test/runtime-gate.test.ts`
- Create: `test/runtime-overrides.test.ts`

- [x] **Step 1: Write failing gate tests**

Assert ALLOW/WARN/BLOCK aggregation across multiple sorted matches, deterministic explanations, intent and action evaluation, no filesystem/SQLite/Git access once the gate is constructed, learning downgrade, disputed-rule nonblocking, and explicit protected degraded behavior.

- [x] **Step 2: Run gate tests and verify RED**

Run: `pnpm build && node --test dist/test/runtime-gate.test.js`

Expected: FAIL because gate orchestration does not exist.

- [x] **Step 3: Implement synchronous gate orchestration**

Evaluate the immutable index, select the strongest outcome, preserve every relevant rule explanation in stable order, and expose structured JSON-safe decisions. The gate accepts an already resolved profile and runtime status; it cannot load dependencies itself.

- [x] **Step 4: Write failing override tests**

Test required non-empty reason, rule/action/task-session scopes, action signature binding, optional expiry, nonmatching and expired rejection, deterministic append-only audit rows, continuation after a valid override, and successful repeated overrides yielding contradiction/revalidation evidence without deleting history.

- [x] **Step 5: Implement override validation and persistence**

Add a SQLite migration for append-only override audit. Store scope, target, reason, created timestamp, optional expiry, decision references, and post-action outcome. Runtime application must be pure; persistence occurs before/after execution outside the hot decision function.

- [x] **Step 6: Verify and commit task 5**

Run: `pnpm build && node --test dist/test/runtime-gate.test.js dist/test/runtime-overrides.test.js`

Expected: all task 5 tests pass.

```sh
git add src/runtime/gate.ts src/runtime/override.ts src/storage/override-store.ts src/storage/experience-store.ts test/runtime-gate.test.ts test/runtime-overrides.test.ts
git commit -m "feat: enforce runtime rules with overrides"
```

### Task 6: Automatic capture and incremental evidence lifecycle

**Files:**

- Create: `src/capture/contracts.ts`
- Create: `src/capture/normalization.ts`
- Create: `src/capture/capture-service.ts`
- Create: `src/capture/adapters/codex.ts`
- Create: `src/capture/adapters/claude-code.ts`
- Create: `src/capture/adapters/cursor.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/domain/transitions.ts`
- Modify: `src/storage/experience-store.ts`
- Create: `test/automatic-capture.test.ts`
- Create: `test/capture-adapter-equivalence.test.ts`
- Create: `test/incremental-evidence.test.ts`

- [x] **Step 1: Write failing normalization and adapter tests**

Normalize equivalent pre-intent, pre-action, and post-result records from Codex, Claude Code, and Cursor into the same allowlisted capture contract. Reject raw transcript payloads, credentials, unknown event kinds, oversized fields, unstable source fields, and duplicate source-event identities.

- [x] **Step 2: Run adapter tests and verify RED**

Run: `pnpm build && node --test dist/test/capture-adapter-equivalence.test.js`

Expected: FAIL because capture adapters do not exist.

- [x] **Step 3: Implement capture contracts and adapters**

Persist structured signatures and bounded summaries, never complete command transcripts or arbitrary payloads. Make normalization deterministic across supported sources and idempotent by source plus event identity.

- [x] **Step 4: Write failing incremental lifecycle tests**

Test idempotent session/event append, failed action observation/candidate creation, successful contradiction evidence attached to an existing candidate, active knowledge moving to disputed through `applyTransition`, explicit revalidation, immutable history, and atomic rollback on invalid input.

- [x] **Step 5: Implement incremental store mutations**

Add transactional append APIs rather than reusing batch import. Reuse canonical validation and transitions. Preserve every transition and evidence record. Do not auto-create durable knowledge for new candidates.

- [x] **Step 6: Write failing learning-capture tests**

Prove a learning-profile downgraded BLOCK still records pre-action and post-result evidence. Repeated successful contradiction may create a revalidation proposal, but it must not delete or silently reverify the existing rule.

- [x] **Step 7: Implement capture service**

Coordinate pre/post events, matcher references, candidate creation, and contradiction evidence. Keep capture failure outside the synchronous gate outcome and return a structured degraded diagnostic.

- [x] **Step 8: Verify and commit task 6**

Run: `pnpm build && node --test dist/test/automatic-capture.test.js dist/test/capture-adapter-equivalence.test.js dist/test/incremental-evidence.test.js dist/test/domain-validation.test.js`

Expected: all task 6 tests and existing domain validation tests pass.

```sh
git add src/capture src/domain/types.ts src/domain/transitions.ts src/storage/experience-store.ts test/automatic-capture.test.ts test/capture-adapter-equivalence.test.ts test/incremental-evidence.test.ts
git commit -m "feat: capture runtime evidence incrementally"
```

### Task 7: Application and CLI integration

Status: Complete.

**Files:**

- Create: `src/application/runtime-service.ts`
- Modify: `src/application/experience-service.ts`
- Modify: `src/cli.ts`
- Modify: `README.md`
- Create: `test/runtime-cli.test.ts`
- Create: `test/runtime-status.test.ts`

- [x] **Step 1: Write failing service and CLI tests**

Add commands equivalent to:

```text
ael runtime evaluate --input action.json [--profile normal|learning|observe-only] [--json]
ael runtime status [--json]
ael runtime config explain --workspace <path> [--remote <url>] [--json]
ael knowledge validate --repository <path> [--trusted-ref <ref>] [--json]
ael knowledge promote --repository <path> --input <document.json> [--json]
```

Test strict option allowlists, deterministic JSON, concise human output, exit code 0 for ALLOW/WARN, exit code 1 for BLOCK/domain failures, exit code 2 for syntax, and no leakage of repository paths or captured sensitive values in diagnostics.

- [x] **Step 2: Run focused CLI tests and verify RED**

Run: `pnpm build && node --test dist/test/runtime-cli.test.js dist/test/runtime-status.test.js`

Expected: FAIL because runtime commands are absent.

- [x] **Step 3: Implement application service and CLI commands**

Keep CLI parsing and rendering thin. Construct dependencies in the application service, refresh snapshots before evaluation only when explicitly requested or absent, and keep the actual evaluation synchronous and snapshot-only.

- [x] **Step 4: Update README contracts**

Document command syntax, trusted-ref activation, normal/learning/observe-only semantics, override audit behavior, local capture/privacy boundaries, fallback behavior, and exit codes.

- [x] **Step 5: Verify and commit task 7**

Run: `pnpm build && node --test dist/test/cli.test.js dist/test/cli-integration.test.js dist/test/runtime-cli.test.js dist/test/runtime-status.test.js`

Expected: existing CLI tests and all task 7 tests pass.

```sh
git add src/application/runtime-service.ts src/application/experience-service.ts src/cli.ts README.md test/runtime-cli.test.ts test/runtime-status.test.ts
git commit -m "feat: expose runtime learning commands"
```

### Task 8: Milestone acceptance, benchmarks, and delivery evidence

Status: Implementation and verification complete at `4d9b493a241948b1598e6c652aa5fc4e00dbf6e8`. Final independent review is pending.

**Files:**

- Create: `test/fixtures/runtime/repeated-invalid-command.json`
- Create: `test/fixtures/runtime/stale-verified-rule.json`
- Create: `test/fixtures/runtime/degraded-runtime.json`
- Create: `test/milestone-2-acceptance.test.ts`
- Create: `test/runtime-benchmark.test.ts`
- Create: `docs/verification/2026-08-25-milestone-2-runtime-learning.md`
- Create: `src/shared-knowledge/runtime-compiler.ts`
- Modify: `src/shared-knowledge/schema.ts`
- Modify: `src/application/runtime-service.ts`
- Modify: `src/application/experience-service.ts`
- Modify: `src/cli.ts`
- Modify: `README.md`
- Modify: `docs/product/roadmap.md`
- Modify: `docs/superpowers/plans/2026-08-25-milestone-2-runtime-learning.md`

- [x] **Step 1: Add failing acceptance fixtures and tests**

Cover repeated invalid action prevention, reusable successful workflow retrieval, stale verified rule contradicted by success, disputed rule never blocking, task-specific instruction not promoted, learning-mode downgrade with capture active, trusted structured repository knowledge compiled and published through the public application bridge, durable reuse through all three adapters, ordinary degraded fail-open, protected configured fail-closed, deterministic serialization, and no network/LLM runtime dependency. Preserve v1/v2 knowledge reads while v3 adds a strict optional runtime directive. Never derive enforcement from Markdown prose or branch-local changes; valid active branch-local directives remain non-authoritative runtime context.

- [x] **Step 2: Add deterministic benchmark metrics**

Measure fixture-level retrieval recall, false warnings, false hard blocks, decision counts, and synchronous gate latency. Record observed values but do not establish release thresholds without real project-session data.

- [x] **Step 3: Run acceptance tests and fix only requirement gaps**

Run: `pnpm build && node --test dist/test/milestone-2-acceptance.test.js dist/test/runtime-benchmark.test.js`

Expected: all milestone 2 acceptance and benchmark tests pass.

- [x] **Step 4: Run complete verification**

Run: `pnpm check`

Expected: build succeeds and all tests pass with zero failures.

Run: `git diff --check`

Expected: no whitespace errors.

Run: `rg -n "fetch\(|https?://|node:https|node:http|child_process" src/runtime src/capture src/config`

Expected: no network client on the runtime/capture/config path; any Git subprocess use is isolated to shared-knowledge refresh code.

- [x] **Step 5: Record verification evidence**

The verification document must include exact commit SHA, test counts, focused acceptance results, offline/runtime dependency scan, unresolved benchmark threshold status, and reviewer dispositions. Mark the roadmap milestone complete only after full verification and final independent reviews approve.

- [x] **Step 6: Commit task 8**

```sh
git add test/fixtures/runtime test/milestone-2-acceptance.test.ts test/runtime-benchmark.test.ts docs/verification/2026-08-25-milestone-2-runtime-learning.md docs/product/roadmap.md docs/superpowers/plans/2026-08-25-milestone-2-runtime-learning.md
git commit -m "docs: record milestone two verification"
```
