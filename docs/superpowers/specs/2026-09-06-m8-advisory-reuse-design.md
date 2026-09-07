# M8: explicitly enabled operational advice

## Status

Draft, 2026-09-06. Depends on M6 and both M7 specifications. Extends specs 003/004/006; does not change passive mode or existing enforcement authority.

## Problem

Persisted knowledge cannot improve the next session unless relevant advice reaches the agent at the right time. Passive observation must remain usable without that delivery behavior.

## Evidence

The runtime supports deterministic matching and authority-aware decisions, while passive hooks do not invoke it. Source adapters need an explicit, verified channel for advice. The user distinguishes non-intervening capture from subsequent use of learned knowledge.[^1]

## Goals

Deliver scoped, bounded and evidence-backed guidance before a relevant operation when explicitly enabled. Verify actual delivery and use. Keep defaults passive and preserve independent platform permissions and runtime policy.

## Non-goals

Silent activation, generic autonomous command execution, LLM/network in deterministic matching, auto-enforcement of new lessons, bypassing SSO or granting authority from remembered access.

## User-visible behavior

The operator explicitly enables advice for a declared integration/scope. The agent receives a concise applicable procedure, why it applies, freshness conditions and evidence references. No match or ambiguity produces no actionable target recommendation. Task instructions and current authoritative project rules take precedence over learned observations.

Supported examples: choose the project package manager; check a previously verified resource location first; use a validated command correction; recognize a conditional SSO requirement. For SSO, the acting agent may request one concrete human step only when current evidence establishes need. It verifies access before resuming. AEL does not itself authenticate.

Disabling advice restores passive behavior. An unsupported host channel is explicitly reported in configuration/status; use an explicit agent-invoked retrieval flow where supported rather than claiming automatic delivery.

## Architecture and boundaries

Use existing local matching, snapshots and lifecycle policy with typed operational applicability. Delivery is a separate adapter contract, not an added side effect in passive ingress. Validate the current supported host API before implementation. One integration must pass end-to-end delivery before expanding to another.

Retrieval is bounded by item/text limits and deduplicates advice already delivered for unchanged context. Cloud freshness checks are separately authorized actions by the agent outside deterministic matching. No live resource probe is hidden inside retrieval.

## State and lifecycle

Record retrieved, delivered, applied, outcome-observed and rejected/expired usage facts separately, each only when supported by observable evidence. A returned hook code proves neither delivery nor adoption. Apply existing disputes, expiry and authority rules. A suggestion used successfully once does not silently become a blocking policy.

Advice activation and enforcement activation are distinct. Enabling advice adds no new BLOCK rule; independently configured existing gate behavior remains unchanged. Only reviewed authoritative structured directives may enforce under baseline policy.

## Failure behavior

Advice delivery failure falls back to ordinary agent behavior and passive recording, within a specified latency budget. Missing or stale knowledge cannot force a target choice. Queue/analysis failure cannot stall guidance through waiting on a fresh lesson. Retry loops for advice delivery are bounded and cannot spam the user.

## Privacy and security

Agent-visible content is sanitized, scoped and size-bounded. Treat all learned text as evidence, not trusted executable instruction. Cross-account/cluster/namespace mismatches suppress actionable advice. No shared/global promotion occurs without applicable governance; no credentials enter instructions or usage logs.

## Compatibility and rollout

Default off for existing installations. Pilot one scope and one integration; then test second-agent reuse. Version the delivery contract and applicability extension; old clients continue passive capture. Revocation must stop new advice without deleting observations or changing independent enforcement policies.

## Acceptance criteria

- M8-A1: passive-only mode produces no agent-visible advice for every supported scenario.
- M8-A2: enabling advice gives session B a valid lesson from session A before the relevant operation; evidence confirms delivery, application and result separately.
- M8-A3: different project/account/environment or insufficient identity cannot receive a wrong actionable target; stale knowledge triggers revalidation rather than blind use.
- M8-A4: changed project tooling overrides older observations; task-only corrections do not become global instructions.
- M8-A5: current SSO challenge results in one applicable human-step recommendation; already-authenticated or access-denied variants do not produce that recommendation automatically.
- M8-A6: corrections that broaden privilege/target/destructive scope are not silently substituted or executed.
- M8-A7: delivery failure, stale snapshot and disabled advice leave normal work available and preserve baseline protected-operation policy.
- M8-A8: advice size, delivery latency and its token cost are measured; no claim of adoption is inferred from lookup success.

Verify real integration delivery, scenario fixtures, scoping, permissions, lifecycle and runtime degradation plus `pnpm check`.

## Open decisions

Before approval: select and verify the first integration delivery mechanism; define opt-in/status/revocation CLI and config semantics, context precedence and deduplication scope; establish bounded delivery/text budgets from baseline.

[^1]: [Runtime contracts](../../../src/runtime/contracts.ts), [runtime matching](../../../src/runtime/matcher.ts), [passive capture](../../sdd/specs/008-passive-agent-capture.md).
