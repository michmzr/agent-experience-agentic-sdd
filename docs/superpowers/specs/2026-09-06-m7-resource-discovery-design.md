# M7a: passive resource discovery and access knowledge

## Status

Draft, 2026-09-06. Part of milestone M7; depends on [M6](2026-09-06-m6-operational-learning-design.md). Extends specs 001/002 and FR-03/04/12. M7 also requires the [SSO observation specification](2026-09-06-m7-sso-observation-design.md).

## Problem

Agents can repeatedly search several environments and namespaces to find a resource or a working connection method. A useful memory must identify what was found, where it belongs and what access method actually worked, with sufficient scope to avoid directing future work to a different environment.

## Evidence

The user described repeated cloud connection discovery and Kubernetes searches. The baseline requires applicability context and reusable workflow knowledge; current runtime applicability has repository/tool/path/tags but no typed cloud-resource identity.[^1]

## Goals

Passively reconstruct resource-discovery episodes and persist scoped location/access candidates. Distinguish unsuccessful search, inaccessible resource, absent resource and confirmed location. Provide evidence of redundant discovery on later inspection.

## Non-goals

Automatic scanning, trying credentials, querying cloud APIs from analysis, choosing a production target on behalf of an agent, synchronizing secrets or delivering advice. Active use belongs to M8.

## User-visible behavior

A report shows the searched scopes, observed results, discovered resource, working connection procedure and verification evidence. It labels incomplete searches and inaccessible environments. A location is not confirmed merely because a command returned successfully. A repeated search is described as potentially avoidable only when prior applicable evidence existed at that time.

Store resource alias/type and explicit applicable account/tenant, environment, cluster/context and namespace when supported. For non-Kubernetes resources, omit inapplicable fields. A connection procedure references a safe tool/profile alias and prerequisites, never authentication material. Missing identity dimensions restrict reuse.

## Architecture and boundaries

Resource detectors consume M5/M6 observations and emit operational candidates using the common evidence/lifecycle model. Identity matching must not rely on resource display name alone. Verification is an observed agent action or deliberately supplied evidence; passive AEL does not perform network validation itself.

The applicability contract is versioned and separates repository identity from external environment identity. Record last verification, provenance and conditions that invalidate the location or access procedure. Reading a profile name is not proof that the corresponding account was used.

## State and lifecycle

An episode can be searching, unresolved, location-observed or access-confirmed. These states do not replace the knowledge lifecycle. Resource relocation, account mismatch or contrary evidence creates a new observation and a dispute/revalidation path. A stale location remains auditable but must not be presented as currently verified.

## Failure behavior

Incomplete source coverage yields a partial episode. Permission errors are not recorded as resource absence. Ambiguous scope prevents actionable cross-session matching; analysis reports the missing field without asking the acting agent. Detector failure leaves source evidence available for reprocessing.

## Privacy and security

No kubeconfig, credentials, authentication cookies, credential-bearing URLs or raw provider output is stored as a lesson. Resource identifiers remain local unless a reviewed sharing policy permits them. Discovery knowledge does not confer authority to use the resource. Sanitized matching keys must remain distinguishable enough to avoid cross-environment collisions.

## Compatibility and rollout

Add typed applicability without reinterpreting old tags as verified cloud identity. Legacy records remain weakly scoped context. Pilot with local fixtures and previously collected eligible evidence; no live cloud mutation is part of rollout. Disabling the detector retains prior evidence and does not change agent behavior.

## Acceptance criteria

- M7a-A1: multi-environment/namespace search reconstructs observed attempts and a correctly scoped final location with evidence.
- M7a-A2: identical resource names in different accounts, clusters or namespaces never collapse into one verified location.
- M7a-A3: access denied, timeout, missing resource and successful connection remain distinct outcomes.
- M7a-A4: relocation or changed connection prerequisites creates revalidation evidence rather than silently keeping a current label.
- M7a-A5: a positive discovery without preceding failure is retained; incomplete observations do not invent missing search steps.
- M7a-A6: a sanitized connection procedure contains no credentials and no executable action is launched by passive analysis.
- M7a-A7: a later report can identify repeated discovery against knowledge available at the time without claiming saved time or tokens before advice is enabled.

Verify scoped-resource and access fixtures, negative identity collisions, privacy and lifecycle regressions plus `pnpm check`.

## Open decisions

Before approval: finalize resource-identity fields, provider-neutral verification evidence, local identifier exposure and freshness conditions. Exact cloud CLI syntax is not specified here; adapter implementation must verify the documentation for the selected tools and versions.

[^1]: [Runtime applicability](../../../src/runtime/contracts.ts), [experience core](../../sdd/specs/001-experience-core.md), [product requirements](../../product/requirements.md).
