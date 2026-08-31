# Worktree hook reliability verification

Date: 2026-08-31

## Executed checks

| Command | Result |
| --- | --- |
| `pnpm build && node --test dist/test/hook-readiness.test.js dist/test/project-hook-configuration.test.js` | 6 passed, 0 failed. |
| `pnpm check` | 429 passed, 0 failed. |
| `node dist/src/cli.js hooks verify --worktree "$(git rev-parse --show-toplevel)"` | `Hook readiness passed for codex, cursor.` |

## Scope

The verifier runs static Cursor and Codex lifecycle and technical payloads through the checked-in wrapper. It sets `AEL_DATA_DIR` to a temporary directory, reopens only that SQLite database and removes it before returning. The default local experience database is not inspected or modified.

The wrapper test constrains `PATH` to `/usr/bin`. The wrapper locates a compatible Node executable, forwards standard input to the local built CLI and persists the expected session in the isolated database.
