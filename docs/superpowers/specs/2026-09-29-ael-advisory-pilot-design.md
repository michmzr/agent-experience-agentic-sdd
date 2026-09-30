# AEL opt-in local advisory pilot

## Status

Draft, 2026-09-29. Change ID: `AAP`. Priority: P1. Dependencies: ABI, ARC, ACL.

Prepared with a proposed execution plan at the user’s explicit request. Neither this document nor that plan records implementation approval. Existing approved behavior remains authoritative until the relevant amendment is approved.

## Problem

Stored knowledge cannot reduce repeated work unless a later session receives applicable advice. Full Draft M8 depends on cloud and SSO M7, delaying a narrower local proof of reuse.

## Evidence

F10: passive capture deliberately does not deliver guidance; M8-A2 already requires separate evidence of delivery, application and result. The audit does not establish any observed automatic reuse.[^sources]

## Goals

Demonstrate local session A to session B reuse in one explicitly enabled integration, preserving scope, lifecycle and passive behavior. Keep retrieval, delivery, use and outcome as separately supported facts.

## Non-goals

Automatic hook advice, cloud/SSO recommendations, new WARN/BLOCK rules, automatic command execution, activation on install, cross-user sharing, or claiming model comprehension from lookup success.

## User-visible behavior

The first channel is explicit agent-invoked CLI retrieval for Codex, qualified in one controlled integration. Proposed commands:

```text
ael advice configure --repository-id <id> --enabled true|false --json
ael advice retrieve --input <context.json> --json
ael advice record --input <usage.json> --json
ael advice status --repository-id <id> --json
```

Default is disabled. Configuration is repository-scoped and separate from runtime enforcement. Retrieval returns at most three eligible entries and at most 4096 UTF-8 bytes in total, including evidence references and invalidation conditions. It has a 200 ms local lookup budget; timeout returns unavailable without waiting for new analysis. These are proposed pilot limits, not measured performance claims.

Only verified local entries with resolved applicability and no unresolved contradiction can produce actionable pilot advice. A stale instruction/context revision suppresses the entry pending revalidation. Retrieval uses existing deterministic matching plus ACL applicability, and performs no live environment probe.

## Architecture and boundaries

Add an advisory service beside the existing runtime service. It never calls the gate for a new enforcing directive. An explicit context artifact supplies current repository, subproject, operation signature and context revision; missing required scope suppresses advice. A caller cannot substitute another repository merely by naming a lesson.

Usage records identify lesson revision, session, context revision, operation reference and fact origin. The CLI records retrieved when it returns a bundle. Delivered requires an integration observation that the response was exposed to the agent, or is labeled agent-claimed when only a declaration exists. Applied requires an explicit lesson selection tied to a later matching operation; a coincidental matching command is not enough. Outcome-observed attaches the corresponding AEC/ATI result or task-verification evidence. None implies another automatically.

Deduplicate unchanged lesson/context/session bundles. Disabling advice revokes future delivery; preexisting usage history remains. Bound all usage input and reject forged cross-scope/lesson-version references.

## State and lifecycle

Advice enablement is disabled or enabled for the selected repository. Usage facts are append-only retrieved, delivered, selected, applied, outcome-observed, rejected or expired, each with its evidence origin. A changed lesson or context starts a new usage identity. Invocation permission is not evidence that the recommendation was adopted.

## Failure behavior

Disabled, unavailable, stale or mismatched advice returns no actionable entry and permits ordinary work. No background retry loop prompts the user or injects messages. Retrieval failure never triggers a fresh expensive analysis or executes the candidate procedure.

## Privacy and security

Return only bounded sanitized local advice. No credentials, external service calls or hidden reasoning. Enabling the pilot does not change platform permissions, current project instruction precedence, existing runtime policy or shared-knowledge authority.

## Compatibility and rollout

Qualification is staged after AVB baseline. Start with one repository and one integration. Test a tooling convention and one newly acquired deterministic project fact, so reuse is not demonstrated solely by repeating an existing instruction. A second-agent integration and all M7 scenarios remain later M8/M9 work. ADR 002 proposes this dependency split; the full Draft M8 is not silently marked complete.

## Requirements and acceptance criteria

| Requirement | Contract | Acceptance | Observable check |
|---|---|---|---|
| AAP-R1 | Advice is default-off and independent of passive capture and enforcement. | AAP-A1 | Install/upgrade and ordinary capture emit no advice; disabling the pilot stops future delivery without deleting history. |
| AAP-R2 | Retrieval enforces lifecycle, exact scope, context freshness, item/byte/time budgets and deduplication. | AAP-A2 | Wrong repository, subproject, stale revision, dispute and budget exhaustion produce no actionable guidance. |
| AAP-R3 | Usage facts retain distinct evidence for retrieval, delivery, selection, application and result. | AAP-A3 | Lookup alone records only retrieved; a linked controlled operation and verification advance only the facts supported by their witnesses. |
| AAP-R4 | A controlled session B receives and uses eligible session A knowledge through the actual selected channel. | AAP-A4 | Complete both tooling-convention and new-project-fact scenarios with separate delivery/application/result evidence. |
| AAP-R5 | Failure and revocation preserve ordinary work and existing authority. | AAP-A5 | Fault the store, revoke advice and submit forged usage; no command, new block or permission change occurs. |

## Benchmark and regression impact

AVB records the pre-change case and the post-change behavior. The matching plan names focused tests and its full acceptance path. Capture remains passive and fail-open; SQLite migrations, replay, scope isolation and privacy assertions are mandatory when affected. Successful component tests do not replace the listed public-path acceptance criteria.

## Open decisions

No unresolved product choice is hidden in this draft. Limits, supported initial paths and exclusions above are proposed decisions for review. Source capability qualification is an implementation discovery task with explicit unsupported outcomes, not permission to guess a host contract. Implementation begins only after approval is recorded in the delivery index.

## Related artifacts

- [Execution plan](../plans/2026-09-29-ael-advisory-pilot.md)
- [Delivery index](../../product/ael-value-delivery.md)
- [Proposal](../../sdd/proposals/2026-09-29-ael-value-delivery.md)

[^sources]: [2026-09-06-m8-advisory-reuse-design.md](2026-09-06-m8-advisory-reuse-design.md), [2026-09-06-m9-effectiveness-benchmark-design.md](2026-09-06-m9-effectiveness-benchmark-design.md), [matcher.ts](../../../src/runtime/matcher.ts), [runtime-service.ts](../../../src/application/runtime-service.ts). Audited production counts are historical observations; proposed behavior and limits are not claims about the current installation.
