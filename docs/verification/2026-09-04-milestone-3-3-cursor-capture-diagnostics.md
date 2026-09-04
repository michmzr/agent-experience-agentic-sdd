# Milestone 3.3 Cursor capture diagnostics

Date: 2026-09-04

Branch: `codex/milestone-3-3-cursor-diagnostics`

Release commit: `test: verify workspace capture diagnostics`

## Verified behavior

Cursor capture diagnostics select a verified Git repository when available and initialize or reuse a stable local workspace scope for a non-Git directory. `ael hooks diagnostics` and `ael experience inspect` return the same versioned scope and category counts for that directory.

The workspace acceptance test delivers a supported Cursor Shell event and a rejected credential-bearing Shell event from a temporary non-Git directory. It verifies that the rejected delivery increments only `unsafe-command-shape`, while the supported delivery persists. It scans `experience.sqlite`, `capture-diagnostics.sqlite`, stdout and stderr for the temporary full path, the raw command, prompt, credential marker and raw session marker. The configured workspace slug remains the intentional, readable scope exception.

For a non-Git workspace, ingress validates the supplied working directory but omits it from the persisted Cursor technical signature. Existing Git adapter normalization remains unchanged.

## Release commands

| Command | Result |
| --- | --- |
| `pnpm build && node --test dist/test/milestone-2-5-acceptance.test.js` | 5 passed, 0 failed, 0 skipped. |
| `pnpm build && node --test dist/test/diagnostic-scope.test.js dist/test/capture-diagnostic-store.test.js dist/test/cursor-capture-diagnostics.test.js dist/test/milestone-2-5-acceptance.test.js` | 19 passed, 0 failed, 0 skipped. |
| `pnpm test` | 570 passed, 0 failed, 0 skipped. |

Diagnostics record only delivered hook outcomes. They do not claim to detect a Cursor hook invocation or `sessionEnd` delivery that the host never made.
