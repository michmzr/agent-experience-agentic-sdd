# Current agent instruction support

Verified on 2026-08-24 against current public documentation.

## OpenAI Codex

Codex supports `AGENTS.md` project instructions and hierarchical discovery of project guidance. This makes a root `AGENTS.md` a suitable thin entrypoint into the canonical `.agents/` documentation.

Source: OpenAI, "Custom instructions with AGENTS.md"  
https://developers.openai.com/codex/guides/agents-md

## Claude Code

Claude Code uses `CLAUDE.md` for project instructions. Current documentation explicitly describes using a `CLAUDE.md` that imports an existing `AGENTS.md` so multiple coding agents can share one instruction source. It also recommends concise project instruction files and separate skills/rules for procedures or scoped guidance.

Source: Anthropic, "How Claude remembers your project"  
https://code.claude.com/docs/en/memory

Claude Code hooks can intercept tool lifecycle events. They are appropriate as thin runtime adapters when deterministic blocking is required, while project memory itself is context rather than enforced configuration.

Source: Anthropic, "Hooks reference"  
https://code.claude.com/docs/en/hooks

## Cursor

Cursor supports version-controlled project rules under `.cursor/rules` and supports root `AGENTS.md` as a simpler project instruction mechanism. Current Cursor documentation recommends checking project rules into Git so team members share behavior.

Source: Cursor, "Rules"  
https://cursor.com/docs/rules

Cursor CLI also applies project rules and reads common project instruction files.

Source: Cursor, "Using Agent in CLI"  
https://cursor.com/docs/cli/using

## Packaging decision

This project therefore keeps detailed guidance in `.agents/` and treats tool-specific root files as thin entrypoints generated or linked during setup. This minimizes divergence while respecting each tool's current instruction-loading behavior.
