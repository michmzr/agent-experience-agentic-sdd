# Milestone 2.5 passive agent capture verification evidence

Date: 2026-08-26

The verification covers the Milestone 2.5 implementation at parent commit `4dc236834a5e2800b9f30aedb4b12232fa25fe57`, plus the acceptance test and evidence changes in this delivery commit.

## Executed evidence

| Verification | Result |
| --- | --- |
| `pnpm build && node --test dist/test/milestone-2-5-acceptance.test.js` | Passed: 4 passed, 0 failed, 0 skipped. |
| `pnpm check` | Passed: TypeScript build succeeded; 426 tests passed, 0 failed, 0 skipped. |
| `rg -n "fetch\\(|https?://|node:https|node:http|child_process" src/capture src/domain src/storage` | No matches. |
| `git diff --check` | Passed with no whitespace errors. |
| Staged-diff scan for credential-value assignments | No matches. |

## Acceptance coverage

The cross-source acceptance test drives the public asynchronous CLI ingress with Codex and Cursor session starts, correlated pre-action and post-result technical hooks, and immutable session ends. Reopening the SQLite database confirms four captured technical events in source and lifecycle order, both closed sessions, migration 11 with `sessions.ended_at`, and no candidates, evidence or durable knowledge side effects.

Repeated lifecycle and technical deliveries are idempotent. A technical event delivered after session closure returns the generic fail-open persistence diagnostic and does not add a capture row. Every accepted hook response has exit code zero and empty stdout.

The privacy case includes raw tool-response, transcript, prompt and user-email markers in the public hook envelope. None is present in the SQLite file. A credential-bearing shell command is rejected with a generic private-input diagnostic without returning its marker. The project configuration assertion confirms that prompt events and permission decisions are not registered.

The wrapper acceptance case creates a temporary Git repository without `dist/src/cli.js`. The checked-in wrapper exits zero, emits no stdout and writes only `AEL_CAPTURE_UNAVAILABLE: Passive capture skipped.` to stderr.

## Migration result

The reopened database reports schema migration version 11 and contains the nullable `ended_at` column on `sessions`. Session starts remain open until a separate session-end hook updates the row. Existing event and capture tables remain usable through the same store API.

## Known non-goals

Milestone 2.5 does not ingest prompts, transcripts, assistant messages, user identity, raw tool responses or permission decisions. It does not invoke the runtime gate, alter agent permissions, call a network or LLM client, or derive lessons and evidence from passive records. Removing the project hook entries stops future capture without deleting the local database.
