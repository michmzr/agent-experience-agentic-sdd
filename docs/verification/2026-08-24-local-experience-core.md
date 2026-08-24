# Local experience core verification evidence

Date: 2026-08-24

This record maps the local experience core acceptance criteria to the commands that verify them. Results are refreshed during Task 7 and record only executed evidence.

| Acceptance criterion | Test or command | Result |
| --- | --- | --- |
| Contradictions preserve source evidence and keep disputed knowledge | `pnpm check`, which runs the test named `does not expire an observation referenced by disputed knowledge` from `test/retrieval-and-retention.test.ts` | Passed 2026-08-24: 52 tests passed, 0 failed |
| Retention leaves no dangling references | `pnpm check`, which runs `tombstones terminal knowledge observations without purging referenced records` and `tombstones an unreferenced event before purging it on a later expiry` from `test/retrieval-and-retention.test.ts` | Passed 2026-08-24: 52 tests passed, 0 failed |
| Unapproved global knowledge is not returned as authoritative | `pnpm check`, which runs `does not return unapproved global knowledge as authoritative` from `test/retrieval-and-retention.test.ts` | Passed 2026-08-24: 52 tests passed, 0 failed |
| Corrupt input leaves persisted data unchanged | `pnpm check`, which runs `returns JSON diagnostics and leaves data unchanged for corrupt input` from `test/cli-integration.test.ts` | Passed 2026-08-24: 52 tests passed, 0 failed |
| The normal CLI path has no network or LLM dependency | `npm_config_offline=true HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 NO_PROXY= pnpm check`, plus `rg -n -i 'node:(http|https|net|tls|dns)|\\bfetch\\s*\\(|\\baxios\\b|\\bundici\\b|\\bwebsocket\\b|\\bopenai\\b|\\banthropic\\b|\\bllm\\b|https?://' src test README.md package.json` | Offline-oriented check passed: build and all 52 tests passed. Static scan returned no matches. |

## Verification conditions

The offline-oriented command disables package-manager network resolution with `npm_config_offline=true` and points conventional proxy variables at an unused local port. It is executed only after dependencies are already present in the local worktree. This confirms that the build and tests do not require package registry access under those conditions. The static scan separately records whether the application source or tests import or invoke known network clients. It does not establish a general operating-system network sandbox for arbitrary future code.

## Fresh command results

Executed on 2026-08-24 in the local-experience-core worktree:

```text
npm_config_offline=true HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 NO_PROXY= pnpm check
```

The command completed successfully after TypeScript compilation and the Node test runner reported 52 passed, 0 failed, 0 skipped. The package manager was instructed to use only its local store and ordinary proxy variables were directed to an unused loopback port. The executed build and test path therefore required neither package registry access nor a reachable conventional proxy. The static scan listed in the matrix produced no matches in the application source, tests, package manifest, or README.
