# AEL agent skill distribution implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one validated `ael` Agent Skills artifact that agents can install atomically for one workspace or globally, inspect for freshness, update, and remove without overwriting unmanaged content.

**Architecture:** `skills/ael/` is the distributable open-skill artifact and is included in the npm package. `src/skill/ael-skill.ts` loads that artifact, produces a deterministic manifest, validates managed files, and performs same-parent atomic publication. `src/cli.ts` exposes the additive `ael skill` command group using injected paths for deterministic tests. The skill routes to focused references and contains no executable script.

**Tech Stack:** Node.js 22.17+, TypeScript, Node standard library, `node:test`, pnpm, open Agent Skills format.

---

## File structure

- Create: `skills/ael/SKILL.md` - compact product-specific router.
- Create: `skills/ael/agents/openai.yaml` - optional Codex presentation metadata.
- Create: `skills/ael/references/*.md` - focused AEL procedures and generated command contract.
- Create: `src/skill/ael-skill.ts` - bundle loading, manifest generation, validation, atomic lifecycle.
- Modify: `src/cli.ts` - parse and render the `skill` command group.
- Modify: `package.json` - ship `skills/ael` with the package.
- Create: `test/ael-skill.test.ts` - skill structure, routing, validation, installation, update and removal tests.
- Modify: `test/cli-integration.test.ts` - packed-package workspace installation coverage.
- Modify: `README.md` - documented AEL skill use and command forms.
- Modify: `docs/superpowers/skill-selection.md` - replace generic entrypoints with the `ael` route.
- Delete: `.agents/skills/{experience-review,promote-lessons,resolve-conflicts,revalidate-knowledge,review-lessons,session-review,spec-driven-change}/SKILL.md` - retire duplicate generic project skills after routing coverage passes.

### Task 1: Create the routed open-skill artifact

**Files:**

- Create: `skills/ael/SKILL.md`
- Create: `skills/ael/agents/openai.yaml`
- Create: `skills/ael/references/setup-and-health.md`
- Create: `skills/ael/references/session-review.md`
- Create: `skills/ael/references/knowledge-lifecycle.md`
- Create: `skills/ael/references/runtime-and-profiles.md`
- Create: `skills/ael/references/diagnostics.md`
- Create: `skills/ael/references/command-reference.md`
- Create: `test/ael-skill.test.ts`

- [ ] **Step 1: Write failing artifact-contract tests**

Create a test that reads `skills/ael/SKILL.md` and asserts `name: ael`, a description containing `Agent Experience Layer`, and references to exactly the six declared reference files. Add positive request fixtures for setup, session review, knowledge lifecycle, runtime, diagnostics, and installation. Add negative fixtures for generic session review, generic conflict resolution, and unrelated code review. Assert the router does not direct a negative fixture to a reference.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
pnpm build
node --test dist/test/ael-skill.test.js
```

Expected: the test fails because `skills/ael/SKILL.md` does not exist.

- [ ] **Step 3: Add the minimal router and references**

Write `SKILL.md` with this frontmatter:

```yaml
---
name: ael
description: Use when installing, configuring, diagnosing, operating, or interpreting Agent Experience Layer (ael), including capture, session review, knowledge lifecycle, runtime profiles, and repository integration. Do not use for generic review, conflict, or runtime requests unrelated to ael.
---
```

Route setup and capture health to `setup-and-health.md`; manual review and debrief to `session-review.md`; lesson review, promotion, revalidation and disputes to `knowledge-lifecycle.md`; gate profiles and snapshots to `runtime-and-profiles.md`; typed errors and fail-open boundaries to `diagnostics.md`; and exact public commands to `command-reference.md`. Each reference directs the agent to run local `ael --help` before relying on a command not listed in the reference. Do not include absolute paths, private examples, prompts, transcripts, credentials, or raw tool output.

Create `agents/openai.yaml` with display name `AEL`, a short description, a default prompt, and default implicit invocation. Keep all essential instructions in `SKILL.md` and references.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run:

```bash
pnpm build
node --test dist/test/ael-skill.test.js
```

Expected: structural, route, positive-trigger and negative-trigger assertions pass.

- [ ] **Step 5: Commit the artifact**

```bash
git add skills/ael test/ael-skill.test.ts
git commit -m "feat: add routed AEL agent skill"
```

### Task 2: Add deterministic skill bundle validation and lifecycle

**Files:**

- Create: `src/skill/ael-skill.ts`
- Modify: `test/ael-skill.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Add temporary-directory tests using a source fixture copied from `skills/ael`. Import these contracts:

```ts
import {
  installAelSkill,
  inspectAelSkill,
  updateAelSkill,
  uninstallAelSkill,
  validateAelSkill,
  type AelSkillScope
} from '../src/skill/ael-skill.js';
```

Assert all of these outcomes:

```ts
assert.equal(validateAelSkill(source).status, 'valid');
assert.equal(installAelSkill({ source, scope: 'workspace', workspace, home }).status, 'installed');
assert.equal(inspectAelSkill({ source, scope: 'workspace', workspace, home }).status, 'current');
assert.equal(installAelSkill({ source, scope: 'workspace', workspace, home }).status, 'unchanged');
assert.equal(installAelSkill({ source, scope: 'global', workspace, home, confirmed: false }).status, 'confirmation-required');
```

Modify `SKILL.md` after installation and assert inspection becomes `invalid`, update refuses it, and uninstall refuses it without deleting the destination. Add an unmanaged `workspace/.agents/skills/ael/notes.txt` fixture and assert install, update and uninstall leave it untouched. Add a source symlink fixture and assert validation rejects it. Add a second valid source with a changed manifest and assert `updateAelSkill` atomically replaces only the managed destination.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
pnpm build
node --test dist/test/ael-skill.test.js
```

Expected: TypeScript cannot resolve `../src/skill/ael-skill.js`.

- [ ] **Step 3: Implement the skill lifecycle boundary**

Export:

```ts
export type AelSkillScope = 'workspace' | 'global';
export type AelSkillStatus = 'valid' | 'current' | 'code-changed' | 'invalid' | 'unverified';
export interface AelSkillManifest {
  readonly schemaVersion: 1;
  readonly skillVersion: string;
  readonly compatibleAelVersion: string;
  readonly documentationSnapshotDate: string;
  readonly files: Readonly<Record<string, string>>;
}
export interface AelSkillLocation { readonly source: string; readonly scope: AelSkillScope; readonly workspace: string; readonly home: string; }
export interface AelSkillOperation { readonly status: 'installed' | 'updated' | 'unchanged' | 'removed' | 'confirmation-required'; readonly destination: string; }
export function validateAelSkill(directory: string): { readonly status: 'valid' | 'invalid'; readonly manifest?: AelSkillManifest; };
export function inspectAelSkill(input: AelSkillLocation): { readonly status: AelSkillStatus; readonly destination: string; };
export function installAelSkill(input: AelSkillLocation & { readonly confirmed?: boolean }): AelSkillOperation;
export function updateAelSkill(input: AelSkillLocation & { readonly confirmed?: boolean }): AelSkillOperation;
export function uninstallAelSkill(input: Omit<AelSkillLocation, 'source'> & { readonly confirmed?: boolean }): AelSkillOperation;
```

Resolve workspace destination as `join(realpathSync(workspace), '.agents', 'skills', 'ael')` and global destination as `join(realpathSync(home), '.agents', 'skills', 'ael')`. Require `confirmed === true` for global mutation. Enumerate a fixed allowlist of artifact files, reject unexpected entries and symbolic links, bound every file at 64 KiB, calculate SHA-256 hashes, and derive a canonical manifest. Write `.ael-skill.json` only into candidates and installations. Publish candidates with `renameSync` from the exact destination parent. Rename the old managed destination to a same-parent rollback name only after candidate validation; restore it if final publication fails. Do not use recursive deletion on a destination unless `inspectAelSkill` has returned `current`.

`inspectAelSkill` returns `current` only for a valid managed installation matching the source manifest. A valid managed installation that differs from the source returns `code-changed`. Missing ownership metadata or a malformed directory returns `unverified` or `invalid` without modifying it.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run:

```bash
pnpm build
node --test dist/test/ael-skill.test.js
```

Expected: validation, workspace and global confirmation, idempotence, mutation detection, unsafe-source rejection, rollback protection and ownership boundaries pass.

- [ ] **Step 5: Commit the lifecycle boundary**

```bash
git add src/skill/ael-skill.ts test/ael-skill.test.ts
git commit -m "feat: validate and install AEL skills safely"
```

### Task 3: Expose the additive CLI contract and packed artifact

**Files:**

- Modify: `src/cli.ts`
- Modify: `package.json`
- Modify: `test/ael-skill.test.ts`
- Modify: `test/cli-integration.test.ts`

- [ ] **Step 1: Write failing command tests**

Extend `RunCliAsyncOptions` with `skillSourceDirectory?: string` and `homeDirectory?: string`. In `test/ael-skill.test.ts`, invoke `runCli` with temporary workspace and home paths. Assert exact JSON statuses for install, status, update and uninstall. Assert global install, update and uninstall without `--yes` return syntax exit code 2 and do not create or remove files. Assert workspace `--yes` is rejected as an unsupported option. Assert malformed scope and unknown options return syntax diagnostics.

In `test/cli-integration.test.ts`, extend the existing packed-package test. After `pnpm pack` and local installation, invoke the packed `ael skill install --scope workspace --workspace <temporary-workspace> --json`, assert `.agents/skills/ael/SKILL.md` exists, then run packed `ael skill status` and assert `"status":"current"`.

- [ ] **Step 2: Run the focused tests to verify RED**

Run:

```bash
pnpm build
node --test dist/test/ael-skill.test.js dist/test/cli-integration.test.js
```

Expected: the CLI reports `Unknown command` for `skill` and the npm tarball does not contain `skills/ael`.

- [ ] **Step 3: Implement CLI parsing, rendering and package shipping**

Add `skill` to `knownCommands`. Recognize only these forms:

```text
skill install --scope workspace [--workspace directory] [--json]
skill install --scope global --yes [--json]
skill update --scope workspace [--workspace directory] [--json]
skill update --scope global --yes [--json]
skill status --scope workspace|global [--workspace directory] [--json]
skill validate <directory> [--json]
skill uninstall --scope workspace [--workspace directory] [--json]
skill uninstall --scope global --yes [--json]
```

Resolve the bundled source relative to `fileURLToPath(import.meta.url)` as `../../skills/ael`, unless a test injects `skillSourceDirectory`. Resolve the default workspace from `workingDirectory ?? process.cwd()` and default user home from `homeDirectory ?? process.env.HOME`; throw a syntax diagnostic if the global home is unavailable. Keep JSON ordering stable. Human output reports operation, scope, and destination only after a successful validation. Update `usage()` with `skill install|update|status|validate|uninstall`.

Add `skills` to `package.json` `files`. Keep the existing `dist` entry and bin path unchanged.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run:

```bash
pnpm build
node --test dist/test/ael-skill.test.js dist/test/cli-integration.test.js
```

Expected: all command allowlists, confirmation boundaries, deterministic output and packed-artifact installation tests pass.

- [ ] **Step 5: Commit the public interface**

```bash
git add src/cli.ts package.json test/ael-skill.test.ts test/cli-integration.test.ts
git commit -m "feat: expose AEL skill installation commands"
```

### Task 4: Retire duplicate entrypoints and document supported use

**Files:**

- Modify: `README.md`
- Modify: `docs/superpowers/skill-selection.md`
- Delete: `.agents/skills/*/SKILL.md`
- Modify: `test/ael-skill.test.ts`

- [ ] **Step 1: Write failing migration and documentation assertions**

Add assertions that the installed skill has all six references, that its router maps every workflow previously covered by the seven project skills, and that no generic project `SKILL.md` files remain under `.agents/skills/`. Add a command-reference assertion that each supported `ael skill` form appears in `README.md`.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
pnpm build
node --test dist/test/ael-skill.test.js
```

Expected: the generic project entrypoints still exist and README lacks the skill command documentation.

- [ ] **Step 3: Update user and agent documentation, then retire duplicates**

Document workspace and global installation, the global `--yes` confirmation, `$ael` invocation, implicit trigger boundary, freshness-state meanings, local-only freshness limits, and safe removal. Replace `docs/superpowers/skill-selection.md` with an `ael` section that directs AEL tasks through the routed skill and preserves separate Superpowers process skills.

Delete only the seven generic `SKILL.md` entrypoints named in the file structure. Do not delete the `.agents/skills` directory or any unrelated skill.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run:

```bash
pnpm build
node --test dist/test/ael-skill.test.js
```

Expected: routed coverage remains complete, duplicate generic entrypoints are absent, and documentation contains the public command contract.

- [ ] **Step 5: Run the release gate**

Run:

```bash
pnpm check
git diff --check
```

Expected: every compiled test passes, no test is skipped, and no whitespace error exists.

- [ ] **Step 6: Commit the migration and documentation**

```bash
git add README.md docs/superpowers/skill-selection.md .agents/skills skills/ael test/ael-skill.test.ts
git commit -m "docs: route AEL workflows through installable skill"
```
