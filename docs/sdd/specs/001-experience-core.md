# Spec 001: experience core

## Status

Approved baseline.

## Goal

Define the shared vocabulary and lifecycle for experience captured from multiple coding agents.

## Scope

Sessions, events, observations, lessons, evidence, knowledge states, repository/global scopes, clustering and value-aware retention.

## Required behavior

- Raw events do not directly become durable rules.
- Observations preserve factual context.
- Similar observations can be clustered into one generalized candidate lesson.
- Knowledge uses explicit lifecycle states rather than numeric model confidence.
- Contradictions are preserved as evidence.
- Global promotion requires user approval.
- Team-shared repository knowledge is authoritative after merge.

## Non-goals

Runtime enforcement and deep session review orchestration are defined in separate specs.

## Acceptance

The domain model must represent positive workflows and negative failures, preserve evidence, support disputes and avoid dangling references when old observations expire.
