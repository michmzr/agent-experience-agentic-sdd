# AEL scoped instruction conventions

## Status

Approved for implementation on 2026-09-30; drafted 2026-09-29. Change ID: `ASC`. Priority: P1. Dependencies: AEC.

The user authorized implementation on 2026-09-30; the delivery index records this decision. Existing approved behavior remains authoritative until the implementation passes its acceptance gates.

## Problem

The audited instruction snapshots contain no recognized conventions. The parser accepts Use pnpm instead of npm but rejects the observed Use pnpm (never npm) form. A project instruction may constrain only one subproject, which cannot be widened into a repository-wide recommendation.

## Evidence

F06: twelve context snapshots contain empty conventions; the actual sisterhood instruction form was reproduced against the current parser. Other mentions of package managers in files are not by themselves directives.[^sources]

## Goals

Recognize a finite set of explicit conventions in configured instruction files, preserve their scope and historical provenance, and produce inspectable candidates without claiming instructions were delivered to an agent.

## Non-goals

Scanning the entire home directory, interpreting arbitrary prose, automatically converting user preferences or task instructions to repository policy, inferring a package manager only from usage frequency, or rewriting historical snapshots.

## User-visible behavior

The existing analysis report shows recognized convention, instruction location, bounded evidence reference, parser version, applicability scope and any unresolved scope. Initial grammar covers use/prefer pnpm instead of npm, use pnpm (never npm), pnpm only, and corresponding explicit uv/pip substitutions. Markdown formatting can surround directive tokens; examples in fenced code and negated/quoted instructions are not directives.

Root directives apply to the repository only when no narrower qualifier is present. A qualifier such as mobile app needs an explicit mapping to a relative subproject scope; without it the candidate is marked scope-unresolved and cannot supply actionable advice. Configuration extends .ael/settings.json with bounded instruction-scope mappings. No default mapping guesses that a directory is mobile.

## Architecture and boundaries

Keep configurable instruction locations and regular-file/size checks. A bounded parser returns structured directives with syntax version, source line, digest, scope selector, found state and independent delivered/read evidence states. Parse at context capture, not repeatedly for every admission after a valid immutable snapshot exists.

A scope selector is repository or a normalized relative path prefix within it. At most 16 mappings are allowed, each attached to a configured instruction location and an exact supported qualifier. Parent traversal, symlink escape and ambiguous overlapping mappings are rejected. The most specific applicable authoritative instruction wins; conflicting directives at the same authority and scope are explicit conflicts.

Legacy context lacking the necessary directive/scope facts remains insufficient. Reanalysis can use a retained immutable instruction artifact if available and identified; current file content cannot be backdated into an old session. New context revisions belong to later operations and keep the old snapshot unchanged.

## State and lifecycle

A recognized convention begins as a candidate with found provenance. Delivered and explicitly-read remain unknown without evidence. A conflicting new directive attaches contradiction or supersession context through ACL; parsing alone cannot set verified. Same-scope repeated observations can later add evidence to one logical candidate.

## Failure behavior

Unavailable files, unsupported grammar, unresolved scope and exceeded bounds yield explicit limitations. They do not stop capture, request clarification from the acting agent or create a default convention.

## Privacy and security

Keep bounded structural directives and evidence references, not entire instruction files. Existing credential checks apply before candidate persistence. Global preferences and session-only corrections retain their original scope and are excluded from automatic repository convention creation.

## Compatibility and rollout

Version the parser and create a new analysis input/detector version when its output changes. Preserve the current supported forms and context identity. Demonstrate the observed sisterhood syntax with synthetic paths and both mobile and non-mobile negative cases before rollout.

## Requirements and acceptance criteria

| Requirement | Contract | Acceptance | Observable check |
|---|---|---|---|
| ASC-R1 | The finite directive grammar recognizes the observed forms and rejects mentions, negation and code examples. | ASC-A1 | Use pnpm (never npm) and pnpm only produce directives; a quoted example and a sentence forbidding that convention do not. |
| ASC-R2 | Directive applicability preserves explicit subproject scope and refuses ambiguous scope. | ASC-A2 | A mobile-only rule applies to the configured mobile path and not to backend or an unmapped project. |
| ASC-R3 | Context revisions are immutable and found/delivered/read provenance remains independent. | ASC-A3 | Edit the instruction after capture; the old operation retains its original directive and unknown delivery state. |
| ASC-R4 | Parser changes are versioned and cannot backdate current instructions into legacy sessions. | ASC-A4 | Reprocess an old session without retained instruction facts and report insufficient historical context. |
| ASC-R5 | Privacy and context acquisition budgets are preserved without reading every instruction file on every event. | ASC-A5 | Credential-bearing, oversized and escaping files produce no leaked candidate; repeated admissions reuse the stored snapshot. |

## Benchmark and regression impact

AVB records the pre-change case and the post-change behavior. The matching plan names focused tests and its full acceptance path. Capture remains passive and fail-open; SQLite migrations, replay, scope isolation and privacy assertions are mandatory when affected. Successful component tests do not replace the listed public-path acceptance criteria.

## Open decisions

The stated limits, initial paths and exclusions are approved for implementation. Source capability qualification remains an implementation task with explicit unsupported outcomes, not permission to guess a host contract. Acceptance and rollout require their own evidence.

## Related artifacts

- [Execution plan](../plans/2026-09-29-ael-scoped-conventions.md)
- [Delivery index](../../product/ael-value-delivery.md)
- [Proposal](../../sdd/proposals/2026-09-29-ael-value-delivery.md)

[^sources]: [project-conventions.ts](../../../src/learning/project-conventions.ts), [project-settings.ts](../../../src/config/project-settings.ts), [service.ts](../../../src/learning/service.ts), [2026-09-12-reliable-session-observation-design.md](2026-09-12-reliable-session-observation-design.md). Audited production counts are historical observations; proposed behavior and limits are not claims about the current installation.
