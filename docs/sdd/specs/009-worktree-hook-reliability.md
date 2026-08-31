# Spec 009: Worktree hook reliability

## Status

Approved.

## Problem

The checked-in AEL hook configuration, wrapper and built CLI are present in `main` and in the active `codex/milestone-3-project-improvements` worktree. Cursor and Codex accept the project configuration, and the Codex hook definitions in `main` are trusted. A fresh Codex session in the worktree did not add a session record to the default local SQLite database.

The same installed CLI accepts a documented Codex `SessionStart` envelope and persists it in an isolated SQLite database. The observed gap is therefore between agent hook execution in a worktree and the passive-capture ingress. The root cause is not yet established.

## Evidence

- On 2026-08-31, `main` and `codex/milestone-3-project-improvements` contained byte-identical `.codex/hooks.json`, `.cursor/hooks.json` and `.agents/hooks/ael-passive-capture.sh` files.
- Both worktrees contained `dist/src/cli.js` and the executable wrapper.
- A new Codex session in the Milestone 3 worktree did not request a hook review, but `sessions` and `events` in `~/Library/Application Support/AgentExperience/experience.sqlite` remained empty after that session ended.
- `ael capture hook --source codex` persisted a valid `SessionStart` envelope in an isolated database.
- Codex command hooks receive one JSON object on standard input and execute from the session working directory.[^1]
- Cursor project hooks execute from the project root and resolve project paths relative to that root.[^2]

## Goals

- Make passive Cursor and Codex capture verifiable in `main` and every Git worktree that contains the tracked AEL hook files and a build.
- Preserve the same hook input until it reaches the source-specific ingress.
- Detect an unavailable or incompatible local execution environment before claiming that capture is ready.
- Provide one deterministic local verification command that checks configuration, runtime prerequisites and persisted results without requiring an interactive agent session.
- Keep the existing private SQLite schema, source adapters and fail-open agent behavior compatible.

## Non-goals

- Capturing prompts, transcripts, assistant messages, tool results, user identity or environment-variable values.
- Changing Cursor or Codex permissions, approvals or tool execution.
- Installing global user hooks or relying on a user-specific absolute path in tracked configuration.
- Remote telemetry, network transport or external service calls.
- Retrofitting observations from sessions that were not captured.
- Treating an interactive hook trust decision as proof that the command completed successfully.

## User-visible behavior

Each worktree containing the tracked hook files and `dist/src/cli.js` is independently ready for passive capture after its Codex hook definitions are trusted. Cursor uses its project-level configuration in the same worktree without a global configuration requirement.

The hook wrapper forwards the agent-provided JSON envelope unchanged to the local CLI. It resolves an eligible Node runtime deterministically instead of relying on the agent process's inherited `PATH`. It emits no standard output and never changes the source agent's decision. If capture cannot run, it exits successfully and emits only the existing bounded generic diagnostic on standard error.

The CLI exposes a local verification command. It accepts a worktree path and verifies, for both `codex` and `cursor`:

- the Git worktree root;
- the tracked hook configuration and wrapper;
- the built local CLI;
- a supported Node runtime;
- the source-specific normalized session and technical-event path in a temporary SQLite database.

The command prints a concise result per source and returns non-zero only for readiness verification. It does not inspect, modify or delete the default experience database.

## Architecture and boundaries

### Hook wrapper

`.agents/hooks/ael-passive-capture.sh` remains the sole project-local process boundary for Cursor and Codex. It resolves the Git root, selects the local built CLI and resolves a Node executable satisfying `package.json`'s supported engine range. The script passes standard input directly to the CLI process and keeps its fail-open result mapping.

The wrapper does not parse, log, transform or persist hook input. It does not use a global `ael` executable.

### Readiness verifier

A new CLI subcommand owns worktree readiness verification. It reads known project files, validates their source coverage and calls the existing ingress with fixed, non-sensitive synthetic envelopes in an isolated temporary data directory. It reopens that database and asserts the expected normalized session and event state.

The verifier owns process exit status and human-readable diagnostics. Passive hook ingress retains exit zero behavior, including for malformed or unavailable capture input.

### Source contracts

Source adapters remain the only code that interprets Cursor and Codex envelopes. The verifier uses only the documented public fields that the adapters already accept. It does not add prompt or permission event support.

## State and lifecycle

For each source and verified worktree, readiness has these states:

```text
unverified -> ready
unverified -> not-ready
ready -> not-ready
```

`ready` means the verifier observed configuration, runtime prerequisites and expected isolated persistence. It does not guarantee that a future agent process cannot fail open because of a database lock or malformed source input.

The default experience database remains outside the verification state. It changes only when a real hook delivery is accepted by passive ingress.

## Failure behavior

Real Cursor and Codex hooks remain fail-open. An absent build, unsupported Node runtime, malformed envelope, database lock or persistence failure must not block an agent action and must not produce standard output.

Readiness verification is fail-closed. It returns a non-zero status and identifies the failed prerequisite or expected persistence assertion. It does not invoke real agents and does not alter their trust state.

Temporary verification data is removed after each completed verification, including failure paths. A cleanup failure is reported as verification failure and never affects a real hook invocation.

## Privacy and security

The verifier uses static synthetic identifiers, paths and non-sensitive technical actions. It does not read a transcript, prompt, agent history, tool output, environment-variable value or default SQLite record.

The wrapper continues to retain no raw envelope. Existing bounded parsing, credential detection and private SQLite permissions remain unchanged. No data leaves the local machine.

## Compatibility and rollout

Existing `ael capture hook --source codex|cursor` syntax and its fail-open exit status remain unchanged. The new verifier is additive.

Existing repositories that use the tracked hook files require only `pnpm build` in each worktree before verification. Codex trust remains a per-project security action and cannot be bypassed by the verifier. Cursor continues to discover project hooks from `.cursor/hooks.json`.

The change must pass in `main` and in a linked Git worktree created from the same commit. It does not require a database migration or a global package installation.

## Acceptance criteria

- The wrapper selects a Node runtime that satisfies the package engine range when the inherited `PATH` contains only an older Node binary.
- The wrapper forwards a valid Codex and Cursor JSON envelope without modification and the local CLI persists the expected record in an isolated database.
- A missing build, unsupported Node or CLI failure produces exit zero from a real hook wrapper, empty standard output and the existing generic diagnostic only.
- The readiness verifier passes in `main` and in a linked worktree with the tracked hook files and a build.
- The readiness verifier fails with actionable, non-sensitive output when a hook file, wrapper, build or supported Node runtime is missing.
- The readiness verifier leaves the default experience database unchanged.
- Existing Milestone 2.5 adapter, privacy, lifecycle and fail-open tests continue to pass.
- `pnpm check` passes.

## Open decisions

None.

[^1]: [Codex hooks](https://learn.chatgpt.com/docs/hooks)
[^2]: [Cursor hooks](https://cursor.com/docs/hooks)
