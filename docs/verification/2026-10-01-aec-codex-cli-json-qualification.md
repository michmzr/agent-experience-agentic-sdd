# AEC Codex CLI JSON result qualification

Date: 2026-10-01. Installed host: `codex-cli 0.157.1`. Source: `codex exec --json`, separate from project hooks.

## Observable boundary

The source emits `thread.started` and `command_execution` `item.started`/`item.completed` events. A command item has a stable item ID, status and optional integer exit code. The adapter retains only a hashed item identity, receipt timestamp, fixed shell signature, result status and exit code. It discards command text, aggregated output, other item classes and turn text. The caller must supply a canonical receipt timestamp. The adapter rejects other CLI versions until requalified.[^source]

`projectCodexCliJsonEvidence` gives results the provenance `cli-json-item`. The existing hook projection continues to use `hook-envelope`; the global Codex hook capability remains `unqualified`. The CLI path does not provide a qualified project-hook result, explicit process-session/poll relation, task verification or agent advice-exposure witness.

## Controlled host check

An isolated empty Git repository under `/private/tmp` ran three requested shell commands through `codex exec --json`: `true`, `false` and `sleep 3; true`. The bounded parser accepted at most 200 JSONL lines, 4 MiB total output and 1 MiB of incomplete-line buffer, killed the child after 120 seconds, and discarded stderr and all raw command/output fields. It returned `exit=0`, `invalid=false`, 10 JSONL lines, three requests, three results and three exact item-identity links. Result exit codes were `0`, `1`, `0`; the corresponding adapter outcomes were succeeded, failed, succeeded. No command text or aggregated output was retained in normalized events. This qualifies success/failure and a delayed item lifecycle for this CLI source. The delayed item is not evidence of an asynchronous process-session poll relation.

The controlled run was performed after the adapter tests first failed to compile, then passed. The source records no `turn.completed` token usage; token arithmetic and benchmark run binding remain separate work.

## Commands and results

`rtk proxy codex --version`: exit 0, `codex-cli 0.157.1`.

`rtk pnpm build` before adapter implementation: exit 2, missing adapter module. `rtk pnpm build` after implementation: exit 0. `rtk node --test dist/test/codex-cli-json-capture.test.js`: 5/5 passed.

`rtk proxy node /private/tmp/aec-codex-host-016dvnud/verify_adapter.mjs` outside the default sandbox: exit 0; `requests=3`, `results=3`, `linked=true`, outcomes 0/1/0, `noPrivatePayload=true`. The temporary script and raw stream are not published as repository fixtures; only the sanitized result is retained here.

[^source]: [Codex `exec_events.rs`](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs), `ThreadEvent`, `CommandExecutionItem`, accessed 2026-10-01; [installed-host probe](2026-10-01-aec-real-host-probe.md).
