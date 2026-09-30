# AEL typed evidence ingestion and episode continuity

## Status

Approved for implementation on 2026-09-30; drafted 2026-09-29. Change ID: `ATI`. Priority: P1. Dependencies: AEC, ARC.

The user authorized implementation on 2026-09-30; the delivery index records this decision. Existing approved behavior remains authoritative until the implementation passes its acceptance gates.

Implementation checkpoint 2026-09-30: public bounded annotation import, indexed decision relations and worker restart paths have tests. Native task-verification remains unsupported; user-declared verification retains its distinct origin. See the [requirement manifest](../../verification/2026-09-30-ael-requirement-traceability.json).

## Problem

The typed episode detector has contracts for claims, instructions, task verification and closure, but the ordinary capture projection supplies only tool requests and results. Tests inject richer evidence directly. Decision relations also need to survive separate pages and jobs.

## Evidence

F07: all 3069 persisted typed records are tool-request or tool-result with observed state. The current production worker supplies no task-verification, task-transition, user-instruction or agent-claim producer.[^sources]

## Goals

Provide a bounded real ingestion path for typed relations, preserve their actual origin, and derive correction and verification-gap episodes across job boundaries without inferring private prose.

## Non-goals

Free-text or chain-of-thought analysis, automatic issue-tracker access, an external LLM, pretending user declarations are tool facts, automatic verification or policy promotion, and prompting the acting agent during passive observation.

## User-visible behavior

Add `ael evidence import --repository-id <id> --input <artifact.json> --json`. The input is a closed, versioned local artifact with producer kind, producer version, local source reference, scope, operation/decision identities and typed evidence. The initial supported producer is an explicit local annotation artifact bound to retained operation references. It is user-declared evidence, not native host telemetry.

Add a qualified source-artifact adapter only for structured source fields demonstrated in the host capability fixtures from AEC. If no native task-verification relation exists, its capability remains unsupported; the product can still use an explicitly supplied annotation. Import never asks the acting agent to provide one.

Reports show which relations are source-observed, user-declared, agent-claimed or analyzer-inferred. Task closure is a separate administrative fact. Missing or incompatible links generate an abstention naming the missing categories. The public ingestion path must feed the same worker and storage path as capture, rather than bypassing them through test-only runNext options.

## Architecture and boundaries

A new ingestion module validates artifacts, resolves their references in the AEC logical index, and transactionally stores typed evidence plus index entries before scheduling analysis. Identity includes producer namespace, repository, conversation/run when known and producer evidence ID. Reimport is idempotent; same identity with different content is a conflict.

Artifacts have at most 128 records, 256 KiB serialized input, bounded nesting and no arbitrary transcript/output fields. Only typed bounded reason classes and linkage keys are accepted. An annotation cannot supply a source-native execution result: it may reference an existing source result and separately state a user verification. Unresolved references remain pending within the bounded recovery model, without fabricated parent records.

Decision identity is explicit and stable across original and changed operations; it is not the hash of the entire changed command. Scope includes repository and context revision; changed scope or authority prevents a repeated-acceptance classification. Versioned detector checkpoints retain bounded unresolved relation keys. Older related evidence is fetched by indexed reference under a budget. Exhaustion reports incomplete and preserves a continuation cursor, not silent truncation.

## State and lifecycle

`received → validated → retained → analyzed` records ingestion progress. Evidence origin and content are immutable. An episode can be unresolved, outcome-observed or solution-supported only according to the available relations. A successful tool process never supplies missing task verification. A claim contradicted by a source result remains a claim plus contradiction, not a resolved success.

## Failure behavior

Reject invalid origin, forged native provenance, cross-scope references and conflicting identities before persistence. Missing references and budget exhaustion expose pending or incomplete state. Analysis failure cannot remove imported evidence or change capture acknowledgement.

## Privacy and security

No arbitrary prose, raw command output, source transcript fragments or secrets are retained. Annotation text is limited to allowlisted structural fields; long explanations stay in a user-owned artifact outside AEL storage. Imported evidence is data and never becomes executable input to a tool.

## Compatibility and rollout

Start with explicit local annotation import and a controlled real operation. Native source-adapter support is a separately qualified capability within this spec. Persist legacy tool evidence unchanged. Mark report and checkpoint versions explicitly and migrate continuation state through restart fixtures.

## Requirements and acceptance criteria

| Requirement | Contract | Acceptance | Observable check |
|---|---|---|---|
| ATI-R1 | The public import path admits bounded typed evidence with explicit origin and idempotent identity. | ATI-A1 | Import the same valid annotation twice, reject extra raw-text fields, and preserve one evidence record per identity. |
| ATI-R2 | Annotations and agent claims cannot impersonate source results or verify a task merely through exit zero. | ATI-A2 | A forged source result is rejected; a user verification remains user-declared and links to a real retained operation. |
| ATI-R3 | Correction, closure and repeated acceptance use explicit decision/context relations. | ATI-A3 | A changed decision yields a correction; closure without a criterion yields a gap; changed scope does not yield redundant acceptance. |
| ATI-R4 | Relations survive page boundaries, late delivery, restart and bounded lookback. | ATI-A4 | Split original decision, correction and verification across three jobs; compare with one-page analysis and require equivalent logical episodes. |
| ATI-R5 | Native source capabilities are advertised only after a real structured-field fixture is qualified. | ATI-A5 | An unsupported host exposes unsupported verification capability; a controlled public-path annotation still produces an auditable episode. |
| ATI-R6 | Imported evidence triggers the normal index/worker path without new passive prompts or network calls. | ATI-A6 | Import through CLI, wait for the normal worker and inspect the episode after restart; fault injection leaves capture available. |

## Benchmark and regression impact

AVB records the pre-change case and the post-change behavior. The matching plan names focused tests and its full acceptance path. Capture remains passive and fail-open; SQLite migrations, replay, scope isolation and privacy assertions are mandatory when affected. Successful component tests do not replace the listed public-path acceptance criteria.

## Open decisions

The stated limits, initial paths and exclusions are approved for implementation. Source capability qualification remains an implementation task with explicit unsupported outcomes, not permission to guess a host contract. Acceptance and rollout require their own evidence.

## Related artifacts

- [Execution plan](../plans/2026-09-29-ael-typed-evidence-ingestion.md)
- [Delivery index](../../product/ael-value-delivery.md)
- [Proposal](../../sdd/proposals/2026-09-29-ael-value-delivery.md)

[^sources]: [service.ts](../../../src/learning/service.ts), [contracts.ts](../../../src/learning/contracts.ts), [detectors.ts](../../../src/learning/detectors.ts), [2026-09-13-typed-evidence-episodes-design.md](2026-09-13-typed-evidence-episodes-design.md). Audited production counts are historical observations; proposed behavior and limits are not claims about the current installation.
