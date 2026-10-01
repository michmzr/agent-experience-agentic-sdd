# AEC installed-host result probe

Date: 2026-10-01. Source revision: `004b65b`. Installed Codex CLI: `0.157.1`.

## Acceptance boundary

AEC-A1 needs sanitized success and failure envelopes observed from the installed host. AEC-A5 needs an observed asynchronous request and terminal result joined by a stable host identifier. A fixture or undocumented status field cannot qualify these capabilities.[^aec]

## Documentation and local observations

Current Codex hook documentation lists `session_id`, `turn_id`, `tool_use_id`, `tool_input` and `tool_response` for `PostToolUse`. The response is tool-specific. The page does not promise a top-level scalar `exit_status`, `exitStatus` or `exit_code`. It says `PostToolUse` also runs after a nonzero Bash command and that a later `write_stdin` poll can deliver the original command's `PostToolUse` when a unified-exec command finishes. It does not establish a separate terminal-completion envelope or a stable execution relation between multiple hook calls.[^hooks]

The repository adapter still recognizes three top-level scalar exit fields, but all 2503 Codex post-result rows in the frozen audit have `unknown` outcomes and no retained exit status. The installation qualification path injects `exit_status: 0` itself, so its success is fixture evidence rather than a host observation.[^prior]

The hook documentation states that project-local `.codex/` hooks load only when that project layer is trusted; `--dangerously-bypass-hook-trust` bypasses handler review. Read-only configuration inspection found the temporary project path marked `trusted` in the user `config.toml` and the ordinary Codex `hooks` feature enabled. The exact installed release's config loader substitutes an empty user layer when `--ignore-user-config` is set. It reads project trust from the merged configuration before discovering `.codex/` layers and disables untrusted project hooks. Thus the first probes removed their observed trust declaration while bypassing only handler review. This explains why those probes could not establish hook behavior; it does not explain the final corrected probe below.[^hooks][^loader]

A corrected isolated command kept `--ignore-user-config` and added `-c 'projects."/private/tmp/aec-codex-host-016dvnud".trust_level="trusted"'`; CLI overrides enter the merge before project discovery. A read-only `codex doctor --json` check accepted this override and reported `config.load: ok`. This did not prove hook registration. The documented `/hooks` inspection command is interactive; neither the checked CLI help nor `codex doctor` supplied a non-model hook self-test.[^loader]

A controlled probe used an empty Git repository under `/private/tmp`, a temporary hook matching `Bash` pre- and post-tool events, and `codex exec --ephemeral --ignore-user-config`. The hook code would have retained only field names and types, numeric or Boolean status values, hashed correlation identifiers, and a hashed one-time nonce match. It did not store raw prompt, output, transcript, credentials or file contents. The first invocation stopped at argument parsing because `-a` belongs before `exec`; it exited 2. The corrected invocation with `gpt-6.1-sol` exited 1 after about 0.2 seconds and produced no hook event. A bounded stderr classifier returned `model`, without retaining the error text. The installed CLI's bundled catalog lacks `gpt-6.1-sol`, while the local configuration selects it, which is a plausible cause but not a captured error message.

`codex login status` reported configured ChatGPT login. Inside the default sandbox, `codex doctor --summary` reported a failed Responses WebSocket check and unreachable runtime CDN. Outside that sandbox, the same command reported WebSocket HTTP 101 and reachable provider endpoints. One authorized retry used the bundled `gpt-6-sol` model outside the sandbox with the same temporary repository and three-command prompt. Codex exited 0 after about 29 seconds. The temporary hook still recorded zero events. Since that retry discarded all model output and did not retain an ephemeral transcript, it cannot distinguish missing hook discovery from a model that did not call the shell tool. That retry yielded no sanitized hook result envelope and no token-usage telemetry.

The official Codex eval guide documents a separate `codex exec --json` event stream with `command_execution` items and turn token usage. The Codex source defines an item `id`, command status and optional integer exit code. This is CLI event telemetry, not the `PostToolUse` hook payload.[^json]

One further authorized invocation used the same isolated repository and three-command prompt with a bounded in-memory JSONL parser. A synthetic parser self-test passed before invocation. The parser discarded raw event lines, commands, output, prompts and paths. It retained three ordered `command_execution` start/completion pairs with matching hashed item IDs:

| Pair | Started status | Completed status | Exit code | Command label |
|---|---|---|---:|---|
| 1 | `in_progress` | `completed` | 0 | nonce generator |
| 2 | `in_progress` | `failed` | 1 | unclassified by the allowlist |
| 3 | `in_progress` | `completed` | 0 | delayed `sleep 12` |

The CLI process exited 0. `turn.completed` reported 78,707 input tokens, 70,144 cached input tokens and 185 output tokens. These counts describe this probe only. Pair 2 is an observed failed command item, but the sanitized trace does not independently prove the exact command string. Pair 3 proves a delayed command item reached a terminal state with the same item ID; no explicit asynchronous process-session ID or `write_stdin` relation was retained. The project hook still yielded no event.

A final authorized run added the explicit project-trust override, `features.hooks=true` and the vetted hook-trust bypass to the same isolated setup. Its bounded parser self-test passed before invocation. Codex exited 0 and again emitted three `command_execution` start/completion pairs with exit codes 0, 1 and 0. `turn.completed` reported 78,702 input tokens, 70,144 cached input tokens and 216 output tokens. The temporary `PreToolUse` and `PostToolUse` hook still recorded zero events. This negative result leaves hook discovery or runtime behavior unresolved; it does not qualify the hook result fields. No further model invocation was made.

## Decision

Keep the existing Codex hook `processExit` capability `unqualified` and AEC-A1/A5 open for that integration. Do not change the hook adapter or global capability profile from CLI event observations. The controlled CLI source produced structured success and failure status with stable item identity, which can support a separate `codex exec --json` adapter if that integration is explicitly implemented and verified. It did not qualify desktop/project hook result extraction or an asynchronous poll relation. No AEC production code changed in this worktree.

## Commands and results

`rtk proxy codex --version` exited 0 and returned `codex-cli 0.157.1`. `rtk proxy codex exec --help` exited 0. `rtk proxy codex exec --ephemeral --ignore-user-config --dangerously-bypass-hook-trust -m gpt-6.1-sol -s workspace-write -a never -C <temporary-repository> --json <three-command-prompt>` exited 2 before model invocation; a local help check identified the misplaced `-a`. `rtk proxy codex --dangerously-bypass-hook-trust -a never exec --ephemeral --ignore-user-config -m gpt-6.1-sol -s workspace-write -C <temporary-repository> --json <three-command-prompt>` exited 1 without a hook event. `rtk proxy codex debug models --bundled` listed `gpt-6-sol` and omitted `gpt-6.1-sol`; `rtk rg -n '^\s*model\s*=' /Users/michmzr/.codex/config.toml` found `model = "gpt-6.1-sol"`. `rtk proxy codex doctor --summary --ascii --no-color` completed inside and outside the default sandbox with the different connectivity results above. `rtk proxy codex login status` exited 0. The authorized retry used `rtk proxy python3 /private/tmp/aec-codex-host-016dvnud/run_probe.py` outside the sandbox; that script invoked `codex --dangerously-bypass-hook-trust -a never exec --ephemeral --ignore-user-config -m gpt-6-sol -s workspace-write -C <temporary-repository> --json <three-command-prompt>`, discarded raw output, and reported `exit=0 category=complete hook_events=False`. No acceptance test was run because no adapter behavior changed.

`rtk proxy python3 /private/tmp/aec-codex-host-016dvnud/run_json_probe.py --selftest` returned `parser-selftest=pass`. The final outside-sandbox `rtk proxy python3 /private/tmp/aec-codex-host-016dvnud/run_json_probe.py` ran `codex -a never exec --ephemeral --ignore-user-config -m gpt-6-sol -s workspace-write -C <temporary-repository> --json <three-command-prompt>` and returned `cli_exit_code=0 safe_events=7`. It retained only the seven fields groups reported above in `/private/tmp/aec-codex-host-016dvnud/safe-events.json`. No acceptance test was run because no adapter behavior changed.

`rtk proxy codex -C <temporary-repository> -c 'projects."<temporary-repository>".trust_level="trusted"' doctor --json` returned `config.load: ok`; no hook registration result is provided by that command. `rtk git diff --check` passed after this note correction.

The final outside-sandbox `rtk proxy python3 /private/tmp/aec-codex-host-016dvnud/run_json_probe.py` used `codex --dangerously-bypass-hook-trust -a never exec --ephemeral --ignore-user-config -c 'projects."<temporary-repository>".trust_level="trusted"' -c features.hooks=true -m gpt-6-sol -s workspace-write -C <temporary-repository> --json <three-command-prompt>`. It reported `cli_exit_code=0 safe_events=7`, with zero temporary hook records. It was the last model invocation.

[^aec]: [AEC design](../superpowers/specs/2026-09-29-ael-evidence-continuity-design.md).
[^hooks]: [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks), sections "Tool coverage" and "PostToolUse", accessed 2026-10-01.
[^prior]: [AEC qualification checkpoint](2026-10-01-aec-host-qualification.md), [frozen audit results](../analysis/2026-09-29-ael-audit-results.json), [installation qualification](../../src/installation/qualification.ts).
[^json]: [OpenAI eval guide](https://developers.openai.com/blog/eval-skills), [Codex `exec_events.rs`](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs), accessed 2026-10-01. The source file is on `main`; the installed binary was separately observed at version 0.157.1.
[^loader]: [Codex 0.157.1 configuration loader](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/config/src/loader/mod.rs), `load_user_config_layer`, `project_trust_context` and `load_project_layers`, accessed 2026-10-01.
