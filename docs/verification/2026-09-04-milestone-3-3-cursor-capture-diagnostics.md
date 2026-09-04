# Milestone 3.3 Cursor capture diagnostics

Date: 2026-09-04

Branch: `codex/milestone-3-3-cursor-diagnostics`

Release commits:

- `f05b58af0527ab6047d70fedce7cf758ddfd6aa0` `test: verify workspace capture diagnostics`
- `3af45fe295c4fc3da2ef868339de5d5705d5016c` `fix: retain Cursor technical paths`
- `f15e63466c97dd823e385a9c266ea29dd58723db` `fix: anonymize Cursor hook sessions`

## Verified behavior

Cursor capture diagnostics select a verified Git repository when available and initialize or reuse a stable local workspace scope for a non-Git directory. `ael hooks diagnostics` and `ael experience inspect` return the same versioned scope and category counts for that directory.

The workspace acceptance test delivers a supported Cursor Shell event and a rejected credential-bearing Shell event from a temporary non-Git directory. It verifies that the rejected delivery increments only `unsafe-command-shape`, while the supported delivery persists. It scans `experience.sqlite`, `capture-diagnostics.sqlite`, stdout and stderr for the raw command, prompt, credential marker and raw session markers, including the accepted `conversation_id`. The configured workspace slug remains the intentional, readable scope exception.

Cursor ingress replaces accepted `conversation_id` values with deterministic local hashes before persistence. Cursor technical events retain their normalized working-directory path for both verified Git repositories and non-Git workspaces. Diagnostics reports omit that path.

## Release commands

| Command | Result |
| --- | --- |
| `pnpm build && node --test dist/test/milestone-2-5-acceptance.test.js` | 5 passed, 0 failed, 0 skipped. |
| `pnpm build && node --test dist/test/diagnostic-scope.test.js dist/test/capture-diagnostic-store.test.js dist/test/cursor-capture-diagnostics.test.js dist/test/milestone-2-5-acceptance.test.js` | 19 passed, 0 failed, 0 skipped. |
| `pnpm test` after session anonymization | 570 passed, 0 failed, 0 skipped. |

Diagnostics record only delivered hook outcomes. They do not claim to detect a Cursor hook invocation or `sessionEnd` delivery that the host never made.
