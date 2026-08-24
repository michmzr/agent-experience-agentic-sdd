# Spec 007: quality benchmark

## Status

Approved baseline.

## Goal

Measure whether the system actually improves agent behavior instead of merely producing more rules and more persuasive reports.

## Required benchmark dimensions

- relevant-knowledge retrieval recall;
- false warning rate;
- false hard-block rate;
- lesson precision and reusability;
- conflict/dispute lifecycle correctness;
- session-review finding usefulness;
- proposal quality;
- cross-agent/team knowledge reuse;
- graceful degradation behavior.

## Deterministic assertions

Prefer assertions on decisions and state transitions over wording produced by LLM reviewers.

## Acceptance

Every material change to retrieval, enforcement, lifecycle or review behavior must be evaluable against a stable regression suite before release.
