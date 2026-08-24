# Shared knowledge architecture

## Goal

Allow knowledge learned during one developer's work to improve agents used by other team members without exposing raw private session data.

## Layers

- private observations and review details: local only;
- durable project knowledge: repository and Git;
- cross-project user knowledge: global local store, with explicit promotion approval.

## Versioned format

Use a machine-readable index plus separate human-readable Markdown knowledge documents. The index carries identity, kind, lifecycle state, tags, applicability and last verification metadata. Markdown carries context, lesson, recommended behavior and evidence summary.

## Governance

Repository knowledge becomes team-active after Git merge. Author identity may be retained for provenance, but policy does not assign different trust scores to different people or agents.

## Change behavior

Contradictions do not delete history. Move active knowledge to disputed when appropriate; later verification may restore it or supersede it with a newer entry.
