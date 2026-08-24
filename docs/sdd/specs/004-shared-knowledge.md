# Spec 004: shared repository knowledge

## Status

Approved baseline.

## Goal

Share reusable project knowledge across developers and agents through Git without sharing raw session history.

## Required behavior

- Durable knowledge uses a machine-readable index plus human-readable documents.
- Repository knowledge has explicit scope, kind, lifecycle state, applicability and evidence summary.
- Branch-local additions are not represented as merged team truth.
- Merge is the activation boundary for shared knowledge.
- User instructions are promoted differently according to origin: code/tool-confirmed facts may be automated; pure preferences and skill candidates require approval; task-specific constraints are not promoted.
- Superseded knowledge remains auditable.

## Acceptance

A lesson learned in one merged change can be retrieved by another developer's Codex, Claude Code or Cursor workflow while raw private review data stays local.
