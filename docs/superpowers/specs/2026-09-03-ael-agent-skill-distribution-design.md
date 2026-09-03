# AEL agent skill distribution design

## Status

Approved by the user on 2026-09-03. Written specification pending user review.

## Goal

Give agents one installable, current, and focused skill for understanding and operating Agent Experience Layer. The same skill can be installed for one workspace or for the current user across workspaces.

The skill teaches agents how to select and execute existing `ael` workflows. It does not generate arbitrary skills or replace deterministic `ael` behavior with instructions.

## Context

The repository currently contains seven small workflow skills for session review, lesson review, promotion, revalidation, conflict resolution, experience review, and specification-driven change. Together they occupy about 6.5 KB, so raw size is not the main problem. Their generic names and descriptions can activate for unrelated work when installed globally, and maintaining several independently installable skills would multiply installation, versioning, and freshness state.

OpenAI's current skill guidance uses the open Agent Skills standard. A skill contains a required `SKILL.md` and may contain references, scripts, assets, and host metadata. Codex loads skill metadata first and reads the full instructions or routed references only when needed.[^1]

## Decision

Distribute one public skill named `ael`. Its `SKILL.md` is a compact router. Detailed workflows live in focused files under `references/` and are loaded only for the selected operation.

The installable artifact is:

```text
ael/
|-- SKILL.md
|-- .ael-skill.json
|-- agents/
|   `-- openai.yaml
`-- references/
    |-- setup-and-health.md
    |-- session-review.md
    |-- knowledge-lifecycle.md
    |-- runtime-and-profiles.md
    |-- diagnostics.md
    `-- command-reference.md
```

The initial artifact contains no skill-owned executable script. Deterministic validation and installation belong to the `ael` CLI, where they can be tested and versioned with the product.

## Alternatives considered

### One monolithic skill

A single `SKILL.md` would make installation simple but would load unrelated setup, review, lifecycle, and runtime instructions together. It would make context use and independent workflow maintenance worse as `ael` grows.

### Multiple public skills

Publishing the seven existing workflows independently would retain precise activation. It would also expose generic names such as `session-review` and `resolve-conflicts` to every workspace after global installation. Those descriptions could match tasks unrelated to `ael`, and each artifact would need separate installation and freshness tracking.

### One routed skill

The selected approach provides one installation and one product-specific activation boundary while preserving focused workflow documents. It also follows progressive disclosure without exposing several generic global triggers.

## Activation contract

The public skill name is `ael`. Its description explicitly names `ael` and Agent Experience Layer. It covers installation, configuration, capture health, session review, knowledge lifecycle, runtime profiles, diagnostics, and repository integration.

Implicit activation requires an explicit reference to `ael`, Agent Experience Layer, or an unambiguous `ael` command. Generic requests to review a session, resolve a conflict, or improve a project do not activate the globally installed skill. Explicit `$ael` invocation remains available.

The router identifies the requested operation and reads only the corresponding reference. It does not load every reference pre-emptively.

## Source of truth and freshness

The canonical skill source lives in this repository and is included in the packaged `ael` release. The installed copy is self-contained and does not use a symlink to a package-manager location.

Skill correctness is defined relative to the installed `ael` release:

- public command syntax and option behavior come from the CLI implementation and executable command-contract tests;
- lifecycle, privacy, and enforcement rules come from approved SDD specifications;
- host-specific installation paths and skill-format requirements come from a dated authoritative documentation snapshot reviewed for the release; and
- workflow guidance that is not backed by code or an approved specification is rejected from the artifact.

The `.ael-skill.json` file records schema version, bundled skill version, compatible `ael` version range, hashes for every managed file, and documentation snapshot date. It contains no installation path or scope, so workspace and global artifacts remain byte-equivalent. This file is owned by `ael` and is not an agent instruction source.

The product does not claim that an installed skill reflects a newer upstream release or documentation change that has not been fetched. No network call is required during skill activation, runtime evaluation, installation from the local package, or status inspection.

## Freshness states

`ael skill status` reports one of these states:

- `current`: the installed artifact matches the bundled artifact and supports the installed `ael` version;
- `code-changed`: the workspace development CLI contract differs from the skill command reference;
- `docs-changed`: an explicit maintainer revalidation found a material change in an authoritative documentation source;
- `invalid`: structure, metadata, hashes, or referenced files are invalid; or
- `unverified`: the artifact cannot be proven compatible with the installed `ael` version.

`current` never means globally latest. It means verified against the local release and its recorded source snapshot.

## User-visible commands

The CLI adds these forms:

```text
ael skill install --scope workspace [--workspace <directory>] [--json]
ael skill install --scope global --yes [--json]
ael skill update --scope workspace [--workspace <directory>] [--json]
ael skill update --scope global --yes [--json]
ael skill status --scope workspace|global [--workspace <directory>] [--json]
ael skill validate <skill-directory> [--json]
ael skill uninstall --scope workspace [--workspace <directory>] [--json]
ael skill uninstall --scope global --yes [--json]
```

Workspace scope defaults to the current working directory and installs to `<workspace>/.agents/skills/ael`. Global scope installs to the current user's `$HOME/.agents/skills/ael`, matching the documented Codex user-skill location.[^1]

The CLI output states the resolved scope, destination, skill version, compatible `ael` version, and resulting status. JSON output remains deterministic and excludes the user's home path when a stable scope-relative representation is sufficient.

## Installation lifecycle

Installation validates the packaged artifact before changing the destination. It writes a complete candidate directory beside the destination and publishes it atomically.

If the destination does not exist, installation creates it. If an identical managed version already exists, installation is idempotent. `install` refuses to replace a different version. `update` replaces another managed `ael` version only after validating the existing ownership boundary, the candidate, and compatibility. If the destination is unmanaged or contains additional user content, both commands fail without changing it.

Global installation, update, and uninstallation require explicit user authorization represented at the CLI boundary by `--yes`. Workspace installation may proceed when the user or calling agent has already requested that workspace mutation.

Uninstallation removes only a complete artifact whose ownership metadata and content boundary can be validated. It refuses to remove an unmanaged directory or user-added files. A failed installation, update, or uninstallation leaves the previous state intact.

## Existing project skills

The existing seven project workflow skills are source material for the routed references, not separately distributed public artifacts. During implementation they remain available until equivalent behavior and trigger coverage pass for the new `ael` skill.

After parity is verified, the repository removes or retires the generic skill entrypoints so agents working in this repository do not see duplicate workflows. The `ael` skill then becomes the canonical version-controlled skill for product operation. Superpowers process skills remain separate and are not copied into the artifact.

## Validation and optimization

Structural validation checks the open skill layout, required frontmatter, product-specific name, referenced files, metadata schema, path safety, size bounds, and unfinished placeholders.

Semantic validation checks that:

- the description activates for representative `ael` requests;
- unrelated generic requests do not activate it;
- each router branch resolves to one existing reference;
- documented commands and options match the public CLI contract;
- references do not duplicate generic agent knowledge or Superpowers procedures;
- instructions preserve authorization boundaries and `ael` fail-open or fail-closed rules; and
- no local absolute path, credential, raw session value, or private identifier enters the packaged artifact.

The release benchmark contains positive and negative activation fixtures, routing fixtures, supported command fixtures, and lifecycle scenarios. Behavioral assertions target selected workflow and command outcome, not exact prose.

## Agent workflow

When activated, the skill:

1. identifies whether the request concerns setup, health, review, knowledge, runtime, diagnostics, or installation;
2. checks the installed `ael` version and skill status when compatibility affects the requested operation;
3. reads the one relevant reference;
4. uses the local CLI for deterministic inspection or mutation; and
5. reports typed diagnostics without inventing unsupported recovery steps.

The skill never treats its own instructions as authorization for global installation, knowledge promotion, runtime enforcement, destructive replacement, or external communication.

## Failure behavior

Skill validation, installation, update, and uninstallation fail closed. Invalid input, unsafe paths, incompatible versions, ownership ambiguity, hash mismatch, or publication failure produce typed diagnostics and no partial destination change.

Ordinary `ael` operation retains its existing failure policy. A missing or invalid skill does not alter runtime ALLOW, WARN, or BLOCK decisions and does not prevent normal development.

If a routed reference is missing or incompatible, the agent reports the skill as invalid and uses public `ael --help` and status output for read-only diagnosis. It does not guess command syntax or repair a global installation without authorization.

## Privacy and security

The packaged skill contains product instructions only. It contains no session data, knowledge records, local paths, credentials, hook payloads, or generated project observations.

Validation follows symlinks only under an explicitly validated skill root and rejects escapes, special files, excess entries, and excess bytes. Installation does not execute content from the candidate skill. Optional `agents/openai.yaml` supplies presentation and invocation metadata only.

## Compatibility

The core artifact follows the open Agent Skills directory format. `agents/openai.yaml` is optional host metadata and does not contain the essential workflow.

Version 1 targets macOS and Linux, consistent with existing product requirements. Workspace and global installations produce byte-equivalent skill contents.

Existing `ael` commands and JSON output remain compatible. The new `skill` command group is additive.

## Acceptance criteria

- A fresh packaged release installs one valid `ael` skill into a temporary workspace and a temporary user home.
- The installed workspace and global instruction artifacts are byte-equivalent.
- Repeating the same installation is idempotent.
- An unmanaged destination, modified managed destination, unsafe path, invalid artifact, or incompatible version remains unchanged after failure.
- Uninstallation removes only a complete, validated, managed installation.
- Representative setup, review, lifecycle, runtime, diagnostic, and installation requests route to the expected reference.
- Representative generic requests unrelated to `ael` do not select the skill.
- A changed public CLI contract without a matching command reference fails the release check.
- A missing reference, stale compatibility range, or content hash mismatch cannot report `current`.
- The artifact contains no private fixture values or environment-specific absolute paths.
- The full offline `pnpm check` suite passes from a clean accepted baseline.

## Out of scope

- generating arbitrary user-authored skills;
- installing unrelated third-party skills;
- plugin packaging or marketplace publication;
- mandatory online freshness checks;
- automatic global installation;
- automatic knowledge promotion or runtime enforcement; and
- new semantic retrieval or reviewer runtimes.

[^1]: [OpenAI, "Build skills," accessed 2026-09-03](https://learn.chatgpt.com/docs/build-skills).
