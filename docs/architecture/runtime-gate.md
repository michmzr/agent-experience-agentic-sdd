# Runtime gate architecture

## Inputs

Two event classes are evaluated:

1. technical intent or plan, before expensive implementation starts;
2. concrete tool action, immediately before execution when an integration supports interception.

## Retrieval order

1. exact command/action match;
2. path, tool, repository and structured metadata match;
3. tags and deterministic filters;
4. optional semantic ranking when embeddings/RAG are enabled;
5. lifecycle and runtime-profile policy.

Semantic retrieval enriches candidate selection but is never required for core enforcement.

## Decision semantics

ALLOW means no relevant active knowledge prevents the action.

WARN means relevant evidence exists, but policy permits continuation.

BLOCK means a verified rule and enforcement policy require explicit override or profile change before continuation.

## Override

Human override may be scoped to one action, session/task or specific rule. It must record a reason. Repeated successful overrides are revalidation evidence.

## Learning profile

Hard blocking is disabled locally while evaluation remains active. BLOCK becomes WARN. This allows experimentation while collecting contradictions and new evidence.
