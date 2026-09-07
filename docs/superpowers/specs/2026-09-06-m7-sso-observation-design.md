# M7b: passive SSO and human-intervention observation

## Status

Draft, 2026-09-06. Part of M7; depends on [M6](2026-09-06-m6-operational-learning-design.md). Shares scope identity with [M7a](2026-09-06-m7-resource-discovery-design.md). Active assistance belongs to M8.

## Problem

An agent may retry an operation that requires human authentication, or confuse an authorization/network failure with SSO. AEL must learn how the episode was resolved while remaining entirely passive during observation.

## Evidence

The user described SSO requiring human intervention. Existing passive capture explicitly cannot ask or block, and failure-learning instructions require distinguishing transient failures from reusable knowledge.[^1]

## Goals

Identify supported authentication-required evidence, observed intervention and successful resumption. Preserve a safe procedure and scope for later reuse. Measure observed repeated attempts and waiting without fabricating human activity from timestamps.

## Non-goals

Initiating login, opening browsers, requesting human action, collecting credentials, bypassing SSO, polling access or automatically resuming the agent in passive mode.

## User-visible behavior

On-demand reports distinguish authentication required, access denied, unreachable service and unknown failure. An episode can record that the agent requested help, that a human completion signal was observed, and that a later operation verified access. If the integration cannot observe a step, label it unknown. A long gap alone is not evidence of human waiting.

The resulting candidate states when human login was necessary and which bounded verification succeeded afterwards. It does not assert that all future sessions need login or that confirmation alone proves access.

## Architecture and boundaries

Use typed error categories and scoped M6 episodes. Human-intervention observations come only from allowed source fields or explicitly selected sanitized local artifacts. Queue admission remains free of raw messages and token-bearing login links. The classifier has explainable evidence; unsupported providers produce unknown rather than a guessed SSO diagnosis.

## State and lifecycle

`access-attempt -> auth-required-observed -> intervention-observed -> access-verification -> resolved/unresolved` represents observed states, not required sequential deliveries. Missing steps are preserved as missing. Access denied and network failure are alternate classifications, not automatic transitions to SSO.

A candidate describes a conditional workflow, not the current validity of a login session. Subsequent already-authenticated success or changed policy is contextualizing/contradictory evidence under the existing lifecycle.

## Failure behavior

Classifier uncertainty yields an unresolved episode. An inaccessible transcript or missing human signal does not trigger a request to the acting agent. Analysis failures never change source permission responses, ingestion or retry behavior of the agent itself.

## Privacy and security

Never retain access tokens, cookies, device codes, callback parameters or credential-bearing URLs. Record a safe procedure identifier and bounded error category. A successful login does not authorize unrelated resources. Reports distinguish observed authentication from authorization to perform a specific operation.

## Compatibility and rollout

New episode categories are additive and source-capability aware. Existing unknown outcomes stay unknown unless supported new evidence is explicitly ingested. Enabling or disabling this passive detector changes reports only. No login hook, external request or advisory behavior is enabled implicitly.

## Acceptance criteria

- M7b-A1: a supported challenge, observed human step and verified access produce a scoped episode with references to each available step.
- M7b-A2: access denied and network failure are not classified as SSO solely from generic failure text.
- M7b-A3: timestamps without intervention evidence do not become human waiting; absent completion remains unknown.
- M7b-A4: repeated attempts without new evidence are counted for review without AEL interrupting the agent.
- M7b-A5: already-authenticated and expired-session variants remain distinguishable; prior login requirements do not imply current login state.
- M7b-A6: secret-bearing challenge fixtures leave no sensitive values in spool, candidates, database or reports.
- M7b-A7: with only passive mode enabled, no prompt, browser action, access probe or instruction reaches the agent.

Verify source-specific classification, partial episodes, privacy and passive isolation plus `pnpm check`. M7 completes only after both M7a and M7b acceptance evidence exists.

## Open decisions

Before approval: choose the first supported provider/source evidence categories and how sanitized human-completion signals are ingested. Do not claim generic SSO support beyond tested adapters.

[^1]: [Passive capture specification](../../sdd/specs/008-passive-agent-capture.md), [failure-learning instructions](../../../.agents/reviewers/failure-learning.md).
