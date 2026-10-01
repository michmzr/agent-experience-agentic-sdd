# AAP delivery witness audit

## Observable target

An AAP `delivered` fact must identify evidence that a specific advice response reached the agent in the same session. A CLI retrieval alone may create only `retrieved`. A public agent declaration remains labeled `agent-claim`. The store must reject a direct attempt to promote `cli-output` to `delivered`.

## Observed implementation

`retrieveLocalAdvice` writes `retrieved` before returning a bounded CLI response. The public `recordLocalAdviceUsage` path accepts `delivered` only with `agent-claim`, but `AdvisoryUsageStore.record` previously accepted `cli-output` for the same fact with a valid scope. A focused test reproduced that promotion before the store change.[^implementation]

The Codex review adapter can normalize a string `function_call_output` record from an explicitly supplied JSONL artifact. Its normalized record omits the call identifier and structured output. It also accepts synthetic records in the same adapter. Current AAP usage does not bind a normalized output to an advice invocation, bundle, and session. The controlled AAP-A4 tests submit an agent claim for delivery; they do not observe live-agent exposure. These paths do not qualify an independent delivery witness.[^adapter]

## Decision and checks

`AdvisoryUsageStore.record` now rejects new `delivered` facts with `cli-output`. Existing stored facts remain readable, but they cannot authorize `selected`, `applied` or `outcome-observed`. Prerequisites follow the recorded order of allowed origins, so a later valid delivery does not rehabilitate a selection recorded before it. The public application check uses the qualified selection timestamp, and outcome attribution uses only operation references after that selection. The public `agent-claim` path remains available. A future observed-delivery origin needs a separately qualified host source, an invocation-to-output binding, and evidence that the full response was exposed in the selected session. This audit does not define such a host contract.

`rtk proxy node /Users/michmzr/.codex/worktrees/avb-trial-evidence/agent-experience-agentic-sdd/node_modules/typescript/bin/tsc -p tsconfig.build.json` exited 0. Before the store change, `rtk proxy node --test dist/test/ael-advisory-usage.test.js` failed 0/1 because `cli-output` was accepted. After the change, the four focused advisory test files passed 9/9. Independent live-agent delivery remains unsupported.

An initial full run in the isolated AAP branch passed 1040/1041. The sole failure was the CLI integration test invoking `pnpm` against a temporary symlinked `node_modules` directory. The symlink was replaced with an offline local install; this failure did not exercise AAP behavior. The branch's `rtk pnpm check` then exited 0 with 1041/1041 tests passing. After integration, a new legacy-row test failed before the ordered-prerequisite fix. A public-path test then showed that an invalid early selection could authorize an operation before the later valid selection; it failed before the attribution fix. The four focused advisory files passed 10/10 after both changes.

[^implementation]: [Advice service](../../src/advice/service.ts), [public record path](../../src/advice/record.ts), [usage store](../../src/advice/usage.ts), [usage regression](../../test/ael-advisory-usage.test.ts).
[^adapter]: [Codex review adapter](../../src/review/adapters/codex.ts), [AAP specification](../superpowers/specs/2026-09-29-ael-advisory-pilot-design.md), [controlled AAP test](../../test/ael-advisory-session-reuse.test.ts).
