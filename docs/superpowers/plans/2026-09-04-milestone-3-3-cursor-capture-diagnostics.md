# Milestone 3.3 Cursor capture diagnostics implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Persist privacy-safe Cursor passive-capture diagnostic counts and expose one automatically selected Git-repository or non-Git-workspace report through hook diagnostics and experience inspection.

**Architecture:** Cursor adaptation returns typed classification results with no rejected values. Hook ingress writes fixed aggregate categories to a separate owner-only SQLite store on a best-effort basis. Both CLI surfaces call one application-service report function.

**Tech stack:** Node.js 22.17+, TypeScript, node:sqlite, node:test, pnpm.

---

## File structure

- Create: src/capture/hook-diagnostics.ts. Closed diagnostic categories, report contract and safe scope sentinel.
- Create: src/storage/capture-diagnostic-store.ts. Owner-only aggregate SQLite persistence.
- Modify: src/capture/hook-adapters/technical-signature.ts and cursor.ts. Typed Cursor classification.
- Modify: src/capture/hook-adapters/index.ts and contracts.ts. Source-specific classified adapter contract.
- Modify: src/capture/hook-ingress.ts. Best-effort aggregate writes around existing capture outcomes.
- Modify: src/application/experience-service.ts. Canonical repository-scoped diagnostic query.
- Modify: src/cli.ts. hooks diagnostics and experience inspect command forms.
- Create: test/capture-diagnostic-store.test.ts and test/cursor-capture-diagnostics.test.ts.
- Modify: test/passive-hook-adapters.test.ts, test/passive-hook-cli.test.ts and test/cli.test.ts.
- Create: docs/verification/2026-09-04-milestone-3-3-cursor-capture-diagnostics.md.
- Modify: docs/product/roadmap.md.

### Task 1: Define typed Cursor classifications

**Files:**

- Create: src/capture/hook-diagnostics.ts
- Modify: src/capture/hook-adapters/contracts.ts
- Modify: src/capture/hook-adapters/technical-signature.ts
- Modify: src/capture/hook-adapters/cursor.ts
- Modify: src/capture/hook-adapters/index.ts
- Modify: test/passive-hook-adapters.test.ts

- [x] **Step 1: Write failing classification tests**

Add Cursor cases asserting exact fixed results for unsupported Read and Grep tools, missing or empty working directories, shell metacharacters, excessive arguments and credential-like input. Assert prompt and unknown lifecycle hooks remain unclassified ignored events. Assert valid shell, MCP and file edits still return their existing PassiveCaptureRecord values. Serialize every rejected result and prove supplied command, path, credential, prompt and session markers are absent.

- [x] **Step 2: Verify RED**

Run:

    pnpm build && node --test dist/test/passive-hook-adapters.test.js

Expected: the adapter returns records or undefined and has no typed diagnostic result.

- [x] **Step 3: Add closed classification contracts**

Create:

    export const cursorCaptureDiagnosticCategories = [
      'invalid-working-directory',
      'persistence-failure',
      'unsafe-command-shape',
      'unsupported-tool'
    ] as const;

    export type CursorCaptureDiagnosticCategory =
      (typeof cursorCaptureDiagnosticCategories)[number];

    export type CursorHookAdaptation =
      | { readonly state: 'accepted'; readonly record: PassiveCaptureRecord }
      | { readonly state: 'ignored' }
      | { readonly state: 'diagnostic'; readonly category: Exclude<CursorCaptureDiagnosticCategory, 'persistence-failure'>; readonly ingressCode?: 'INVALID_INPUT' | 'PRIVATE_INPUT' };

Technical-signature internals return or throw fixed reason codes without values. Cursor requires a valid cwd for technical hooks, maps unsupported technical tools to unsupported-tool, maps cwd contract failures to invalid-working-directory, and maps unsafe or private structured inputs to unsafe-command-shape while preserving PRIVATE_INPUT for credential-like material. Keep ordinary nontechnical hooks ignored. Adapt the source index so Codex retains its existing record-or-undefined path while Cursor uses CursorHookAdaptation.

- [x] **Step 4: Verify GREEN**

Run:

    pnpm build && node --test dist/test/passive-hook-adapters.test.js

Expected: typed classification and all existing valid adapter tests pass.

- [x] **Step 5: Commit**

    git add src/capture/hook-diagnostics.ts src/capture/hook-adapters test/passive-hook-adapters.test.ts
    git commit -m "feat: classify Cursor capture diagnostics"

### Task 2: Persist fixed aggregate counts

**Files:**

- Create: src/storage/capture-diagnostic-store.ts
- Create: test/capture-diagnostic-store.test.ts

- [ ] **Step 1: Write failing storage tests**

Test new and reopened stores, four fixed zero counts, atomic repeated increments, repository isolation, global sentinel scope, deterministic lexical ordering and owner-only file mode. Assert invalid source, category, repository identifier, zero or overflow count and corrupt schema fail without mutation. Scan database bytes for representative command, path, credential and session markers and assert none occur.

- [ ] **Step 2: Verify RED**

Run:

    pnpm build && node --test dist/test/capture-diagnostic-store.test.js

Expected: the diagnostic store module cannot be resolved.

- [ ] **Step 3: Implement the aggregate store**

Expose:

    export interface CursorDiagnosticCounts {
      readonly 'invalid-working-directory': number;
      readonly 'persistence-failure': number;
      readonly 'unsafe-command-shape': number;
      readonly 'unsupported-tool': number;
    }

    export class CaptureDiagnosticStore {
      constructor(databasePath: string);
      increment(scope: { readonly source: 'cursor'; readonly repositoryId?: RepositoryId }, category: CursorCaptureDiagnosticCategory): void;
      counts(scope: { readonly source: 'cursor'; readonly repositoryId?: RepositoryId }): CursorDiagnosticCounts;
      close(): void;
    }

Use capture-diagnostics.sqlite with one closed-schema aggregate table keyed by source, scope kind, a resolver-created canonical repository ID, a resolver-created workspace-path SHA-256, or a fixed global sentinel, and category. Increment through one SQLite upsert transaction. Validate safe integers before and after increment. Create the file and parent directory with owner-only permissions using the existing database helper pattern. Missing store returns zero counts when opened; malformed existing schema rejects. The store never accepts a raw path or arbitrary caller-provided scope ID.

- [ ] **Step 4: Verify GREEN**

Run:

    pnpm build && node --test dist/test/capture-diagnostic-store.test.js

Expected: storage, isolation, permissions and corruption tests pass.

- [ ] **Step 5: Commit**

    git add src/storage/capture-diagnostic-store.ts test/capture-diagnostic-store.test.ts
    git commit -m "feat: store aggregate capture diagnostics"

### Task 3: Integrate best-effort ingress counting

**Files:**

- Modify: src/capture/hook-ingress.ts
- Modify: src/application/experience-service.ts
- Create: test/cursor-capture-diagnostics.test.ts
- Modify: test/passive-hook-cli.test.ts

- [ ] **Step 1: Write failing ingress tests**

Inject primary and diagnostic stores. Assert a valid Cursor action persists with no diagnostic increment. Assert unsupported tool returns ignored and increments unsupported-tool once. Assert invalid cwd and unsafe/private command shapes remain exit-zero degraded outcomes and increment their categories once. Make primary persistence fail and assert one best-effort persistence-failure attempt. Make diagnostic storage throw and prove the original accepted, ignored or degraded result, stdout, stderr and exit status are unchanged.

- [ ] **Step 2: Verify RED**

Run:

    pnpm build && node --test dist/test/cursor-capture-diagnostics.test.js dist/test/passive-hook-cli.test.js

Expected: ingress has no diagnostic-store dependency or typed Cursor handling.

- [ ] **Step 3: Wire best-effort increments**

Extend HookIngressOptions with an optional diagnostic-store factory for tests. Production derives capture-diagnostics.sqlite beside experience.sqlite. Resolve repository once. For Cursor typed diagnostic results, call a helper that catches every diagnostic-store error and returns no value. Unsupported tools return ignored. Rejected diagnostics map to existing INVALID_INPUT or PRIVATE_INPUT results. When passive persistence returns degraded, attempt persistence-failure before returning existing PERSISTENCE_FAILED.

Do not change Codex ingress behavior. Do not emit the diagnostic category through hook stdout or stderr.

- [ ] **Step 4: Verify GREEN**

Run:

    pnpm build && node --test dist/test/cursor-capture-diagnostics.test.js dist/test/passive-hook-cli.test.js

Expected: all Cursor diagnostic paths count once and every hook remains fail-open.

- [ ] **Step 5: Commit**

    git add src/capture/hook-ingress.ts src/application/experience-service.ts test/cursor-capture-diagnostics.test.ts test/passive-hook-cli.test.ts
    git commit -m "feat: count Cursor capture outcomes"

### Task 4: Expose one report through both CLI surfaces

**Files:**

- Modify: src/application/experience-service.ts
- Modify: src/cli.ts
- Modify: test/cli.test.ts
- Modify: test/cli-integration.test.ts

- [ ] **Step 1: Write failing report tests**

Seed aggregate counts for two repositories. Assert hooks diagnostics resolves only the selected verified Git root, emits every category including zero in lexical order, and supports stable JSON. Assert experience inspect returns the identical diagnostic object for the same repository and data directory. Test current-directory selection, explicit top-level selection, nested path rejection, symlink boundary rejection, nonrepository rejection, absent database zero counts and corrupt-store generic errors.

- [ ] **Step 2: Verify RED**

Run:

    pnpm build && node --test dist/test/cli.test.js dist/test/cli-integration.test.js

Expected: both command forms are unknown.

- [ ] **Step 3: Implement canonical reporting**

Add one service method:

    cursorCaptureDiagnostics(repositoryRoot: string): {
      readonly version: 1;
      readonly source: 'cursor';
      readonly repositoryId: string;
      readonly counts: CursorDiagnosticCounts;
    };

Resolve a scope before opening the diagnostic store: use a verified Git top-level repository where available; otherwise derive a workspace SHA-256 from the normalized real selected directory. Both commands invoke this method. hooks diagnostics accepts data-dir, repository and json. experience inspect accepts the same directory selection and embeds the exact returned object. Text output lists the four categories in lexical order. JSON uses the closed versioned object with scope kind and ID. Reporting errors use bounded generic diagnostics with no database or path.

- [ ] **Step 4: Verify GREEN**

Run:

    pnpm build && node --test dist/test/cli.test.js dist/test/cli-integration.test.js

Expected: both surfaces return identical repository counts and stable output.

- [ ] **Step 5: Commit**

    git add src/application/experience-service.ts src/cli.ts test/cli.test.ts test/cli-integration.test.ts
    git commit -m "feat: report Cursor capture diagnostics"

### Task 5: Verify privacy and milestone acceptance

**Files:**

- Modify: test/milestone-2-5-acceptance.test.ts
- Create: docs/verification/2026-09-04-milestone-3-3-cursor-capture-diagnostics.md
- Modify: docs/product/roadmap.md

- [ ] **Step 1: Add failing acceptance coverage**

Run supported, unsupported, invalid-cwd, unsafe-shell, private-input and primary-persistence-failure Cursor deliveries against isolated databases. Assert expected counts through both CLI surfaces. Read both SQLite files and concatenate JSON/stdout/stderr; assert no command, path, prompt, credential, session ID or arbitrary marker is present. Assert supported actions persist, unsupported actions do not, and every hook exit code remains zero with empty stdout and generic stderr only.

- [ ] **Step 2: Verify RED**

Run:

    pnpm build && node --test dist/test/milestone-2-5-acceptance.test.js

Expected: diagnostic counts and report commands are absent.

- [ ] **Step 3: Record verification**

Make only acceptance corrections required by the approved design. Write the verification document with date, branch, commit, exact commands and pass counts. Update the roadmap to mark Cursor capture diagnostics complete while large-artifact review remains complete and stale-session reconciliation remains deferred. Do not claim true absent hook delivery detection.

- [ ] **Step 4: Run release gate**

Run:

    pnpm build && node --test dist/test/cursor-capture-diagnostics.test.js dist/test/capture-diagnostic-store.test.js dist/test/milestone-2-5-acceptance.test.js
    pnpm test

Expected: zero failures and zero skipped tests.

- [ ] **Step 5: Commit**

    git add test/milestone-2-5-acceptance.test.ts docs/verification/2026-09-04-milestone-3-3-cursor-capture-diagnostics.md docs/product/roadmap.md
    git commit -m "test: verify Cursor capture diagnostics"

## Plan self-review

The five tasks cover typed classification, fixed aggregate persistence, best-effort ingress writes, both reporting surfaces, privacy scans and release verification. Category names, report types and command forms are consistent. True absent host invocation and stale-session reconciliation remain outside this plan.

## Execution status

- 2026-09-04: Implementation started on `codex/milestone-3-3-cursor-diagnostics` at `c7f7521`. Baseline: `pnpm build` passed.
- 2026-09-04: Task 1 completed and reviewed. RED command: `pnpm build && node --test dist/test/passive-hook-adapters.test.js` failed as expected before typed results existed. Final verification: the same command passed with 18 tests and zero failures at `693b5fd`; fix round 1 scoped re-review found the `PRIVATE_INPUT` regression addressed and no new Critical or Important issue.
