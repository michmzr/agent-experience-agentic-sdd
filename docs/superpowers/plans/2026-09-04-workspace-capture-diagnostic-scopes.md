# Workspace capture diagnostic scopes implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Cursor diagnostics select a Git repository or a non-Git workspace automatically without persisting a path or accepting a caller-provided identifier.

**Architecture:** A scope resolver creates a closed repository, workspace, or global scope. The aggregate store persists only its kind and derived ID. Ingress and both reporting commands call the resolver; no hook payload is accepted as scope identity.

**Tech stack:** Node.js 22.17+, TypeScript, node:sqlite, node:test, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-04-milestone-3-3-cursor-capture-diagnostics-design.md`

## Global constraints

- A workspace ID is the readable slug in Git-trackable `.ael/workspace.json`; it may disclose a folder-name fragment but never a full path or hook value.
- A Git scope uses the existing canonical repository ID and its verified top-level root.
- Scope kinds are exactly `repository`, `workspace`, and `global`.
- The aggregate store rejects raw paths and arbitrary caller-provided IDs.
- Hook execution remains fail-open; reporting errors remain bounded and path-free.

---

### Task 1: Resolve closed diagnostic scopes

**Files:**

- Create: `src/capture/diagnostic-scope.ts`
- Modify: `src/storage/capture-diagnostic-store.ts`
- Modify: `test/capture-diagnostic-store.test.ts`
- Create: `test/diagnostic-scope.test.ts`

**Interfaces:**

- Produces `DiagnosticScope = { readonly kind: 'repository'; readonly id: RepositoryId } | { readonly kind: 'workspace'; readonly id: string } | { readonly kind: 'global'; readonly id: 'global' }`.
- Produces `resolveDiagnosticScope(directory?: string): DiagnosticScope`, which retains `.ael/workspace.json` after Git initialization and otherwise resolves Git top levels or a workspace configuration.
- Changes `CaptureDiagnosticStore.increment(scope: { readonly source: 'cursor'; readonly scope: DiagnosticScope }, category)` and `counts` to the same scope shape.

- [x] **Step 1: Write failing scope and store tests**

Add tests proving `ael init` creates mode-0755 `.ael/workspace.json` with a folder-name slug, an explicit workspace ID overrides it, a moved workspace retains its scope, and an existing workspace configuration remains authoritative after Git initialization. Assert a malformed configuration rejects without replacement. Add store tests proving repository and workspace slugs isolate rows, a raw path and `sk-test-credential` cannot be supplied as a scope ID, and database bytes contain neither full paths nor hook markers while retaining the configured slug.

- [x] **Step 2: Verify RED**

Run:

    pnpm build && node --test dist/test/diagnostic-scope.test.js dist/test/capture-diagnostic-store.test.js

Expected: scope resolver imports or scope-shaped store calls fail because workspace scopes do not exist.

- [x] **Step 3: Implement closed scope resolution and persistence**

Create idempotent `ael init [--workspace-id <slug>]`: when valid `.ael/workspace.json` exists, print its configured workspace ID and exit successfully without modification; otherwise initialize the selected non-Git workspace with a slugified folder name or explicit slug. The resolver first reads a valid workspace configuration, otherwise resolves a Git top level. Create `.ael` mode 0755 and `workspace.json` mode 0644. The store schema has `scope_kind` constrained to `repository`, `workspace`, `global`; `scope_id` constrained to `global`, canonical repository IDs, or validated lowercase workspace slugs. Do not expose a public constructor that accepts a string scope ID.

- [x] **Step 4: Verify GREEN**

Run:

    pnpm build && node --test dist/test/diagnostic-scope.test.js dist/test/capture-diagnostic-store.test.js

Expected: scope, privacy, schema and aggregate tests pass.

- [x] **Step 5: Commit**

    git add src/capture/diagnostic-scope.ts src/storage/capture-diagnostic-store.ts test/diagnostic-scope.test.ts test/capture-diagnostic-store.test.ts
    git commit -m "feat: resolve workspace diagnostic scopes"

### Task 2: Use scopes at ingress and reporting boundaries

**Files:**

- Modify: `src/capture/hook-ingress.ts`
- Modify: `src/application/experience-service.ts`
- Modify: `src/cli.ts`
- Modify: `test/cursor-capture-diagnostics.test.ts`
- Modify: `test/passive-hook-cli.test.ts`
- Modify: `test/cli.test.ts`
- Modify: `test/cli-integration.test.ts`

**Interfaces:**

- Consumes `resolveDiagnosticScope` and the scope-shaped diagnostic store API from Task 1.
- Produces a versioned report whose scope object is `{ kind: 'repository' | 'workspace' | 'global'; id: string }` and whose count object remains the closed four-category contract.

- [x] **Step 1: Write failing ingress and CLI tests**

Add `ael init` CLI fixtures proving first invocation writes the slugified or explicit workspace ID, a second invocation displays the valid existing ID without replacement even with `--workspace-id`, and malformed existing configuration returns a bounded error. Add a non-Git temporary current directory to Cursor hook and both diagnostics CLI fixtures. Assert a rejected Cursor event increments only its workspace scope, automatic current-directory selection uses that scope, explicit non-Git directory selection returns the same scope, and a Git nested directory with existing workspace configuration retains that scope. Assert JSON and text output omit the temporary full path and show the scope kind and workspace slug; assert symlinked workspace selections resolve to one scope.

- [x] **Step 2: Verify RED**

Run:

    pnpm build && node --test dist/test/cursor-capture-diagnostics.test.js dist/test/passive-hook-cli.test.js dist/test/cli.test.js dist/test/cli-integration.test.js

Expected: non-Git automatic selection is rejected or reports no workspace scope.

- [x] **Step 3: Implement boundary integration**

Implement `ael init [--workspace-id <slug>]` using Task 1's core initializer. On valid existing configuration, print its workspace ID and exit zero without replacement; malformed configuration returns a bounded generic error. Replace repository-only scope resolution in hook ingress and the application service with `resolveDiagnosticScope`. Keep existing primary capture repository behavior unchanged. Both CLI forms call the one application-service report method and format the same `scope` object. Catch resolver and diagnostic-store errors at hook ingress, preserving its existing empty stdout, generic stderr and zero exit status.

- [x] **Step 4: Verify GREEN**

Run:

    pnpm build && node --test dist/test/cursor-capture-diagnostics.test.js dist/test/passive-hook-cli.test.js dist/test/cli.test.js dist/test/cli-integration.test.js

Expected: Git and workspace scopes return stable, matching counts without path disclosure.

- [x] **Step 5: Commit**

    git add src/capture/hook-ingress.ts src/application/experience-service.ts src/cli.ts test/cursor-capture-diagnostics.test.ts test/passive-hook-cli.test.ts test/cli.test.ts test/cli-integration.test.ts
    git commit -m "feat: report workspace capture diagnostics"

### Task 3: Extend acceptance and verification records

**Files:**

- Modify: `test/milestone-2-5-acceptance.test.ts`
- Modify: `docs/verification/2026-09-04-milestone-3-3-cursor-capture-diagnostics.md`
- Modify: `docs/product/roadmap.md`

- [x] **Step 1: Write failing workspace acceptance coverage**

Deliver supported and rejected Cursor hooks from a non-Git temporary directory. Assert both CLI surfaces return identical workspace counts and a path-free scope object. Scan both SQLite files, stdout and stderr for the temporary path, raw command, prompt, credential and session markers.

- [x] **Step 2: Verify RED**

Run:

    pnpm build && node --test dist/test/milestone-2-5-acceptance.test.js

Expected: workspace scope assertions fail before Tasks 1 and 2 are integrated.

- [x] **Step 3: Record release evidence**

Update the verification document with the branch, final commit, exact release commands and pass counts. Update the roadmap to state that diagnostics support verified Git repositories and automatically selected non-Git workspaces; retain the prohibition on claiming detection of missing hook delivery.

- [x] **Step 4: Run release gate**

Run:

    pnpm build && node --test dist/test/diagnostic-scope.test.js dist/test/capture-diagnostic-store.test.js dist/test/cursor-capture-diagnostics.test.js dist/test/milestone-2-5-acceptance.test.js
    pnpm test

Expected: zero failures and zero skipped tests.

- [x] **Step 5: Commit**

    git add test/milestone-2-5-acceptance.test.ts docs/verification/2026-09-04-milestone-3-3-cursor-capture-diagnostics.md docs/product/roadmap.md
    git commit -m "test: verify workspace capture diagnostics"

## Plan self-review

Task 1 covers scope derivation, schema closure and privacy. Task 2 routes the same scope through ingress and both reporting surfaces. Task 3 verifies user-visible behavior and records release evidence. The plan does not permit raw paths or arbitrary scope IDs to reach SQLite, output or hook diagnostics.
