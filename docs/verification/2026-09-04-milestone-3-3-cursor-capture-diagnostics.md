# Milestone 3.3 Cursor capture diagnostics

Date: 2026-09-04

Branch: `codex/milestone-3-3-cursor-diagnostics`

Release commits:

- `f05b58af0527ab6047d70fedce7cf758ddfd6aa0` `test: verify workspace capture diagnostics`
- `3af45fe295c4fc3da2ef868339de5d5705d5016c` `fix: retain Cursor technical paths`
- `f15e63466c97dd823e385a9c266ea29dd58723db` `fix: anonymize Cursor hook sessions`
- `2151457daa3a80bb08d032df2301b38af1eb96c5` `fix: isolate workspace diagnostic scopes`

## Verified behavior

Cursor capture diagnostics select a verified Git repository when available and initialize or reuse a stable local workspace scope for a non-Git directory. `ael hooks diagnostics` and `ael experience inspect` return the same versioned scope and category counts for that directory.

The workspace acceptance test delivers a supported Cursor Shell event and a rejected credential-bearing Shell event from a temporary non-Git directory. It verifies that the rejected delivery increments only `unsafe-command-shape`, while the supported delivery persists. It scans `experience.sqlite`, `capture-diagnostics.sqlite`, stdout and stderr for the raw command, prompt, credential marker and raw session markers, including the accepted `conversation_id`. The configured workspace slug remains the intentional, readable scope exception.

Cursor ingress replaces accepted `conversation_id` values with deterministic local hashes before persistence. Cursor technical events retain their normalized working-directory path for both verified Git repositories and non-Git workspaces. Diagnostics reports omit that path.

Default non-Git workspace IDs use the readable folder-name slug while it is unclaimed in the selected local data directory. A second workspace with the same basename receives an eight-character SHA-256 path-hash suffix. The selected ID is persisted in `.ael/workspace.json` and remains unchanged after a move. When diagnostics are invoked below a Git root, an existing root `.ael/workspace.json` remains authoritative.

If the primary experience database cannot be opened or migrated, Cursor ingress attempts exactly one best-effort `persistence-failure` increment. A busy primary database and a simultaneous diagnostic-store failure preserve the existing fail-open result and bounded CLI status.

## Release commands

| Command | Result |
| --- | --- |
| `pnpm build && node --test dist/test/milestone-2-5-acceptance.test.js` | 5 passed, 0 failed, 0 skipped. |
| `pnpm build && node --test dist/test/diagnostic-scope.test.js dist/test/capture-diagnostic-store.test.js dist/test/cursor-capture-diagnostics.test.js dist/test/milestone-2-5-acceptance.test.js` | 19 passed, 0 failed, 0 skipped. |
| `pnpm test` after session anonymization | 570 passed, 0 failed, 0 skipped. |
| `pnpm build && node --test dist/test/diagnostic-scope.test.js dist/test/capture-diagnostic-store.test.js dist/test/cursor-capture-diagnostics.test.js` after final review fixes | 19 passed, 0 failed, 0 skipped. |
| `pnpm build && node --test dist/test/diagnostic-scope.test.js dist/test/capture-diagnostic-store.test.js dist/test/cursor-capture-diagnostics.test.js dist/test/passive-hook-cli.test.js dist/test/cli.test.js dist/test/cli-integration.test.js dist/test/milestone-2-5-acceptance.test.js` after final review fixes | 50 passed, 0 failed, 0 skipped. |
| `pnpm test` after final review fixes | 575 passed, 0 failed, 0 skipped. |

Diagnostics record only delivered hook outcomes. They do not claim to detect a Cursor hook invocation or `sessionEnd` delivery that the host never made.
