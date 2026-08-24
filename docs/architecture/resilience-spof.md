# Resilience and single-point-of-failure design

## Default runtime

Use an embedded/in-memory runtime snapshot inside the tool integration where feasible. An optional local sidecar may improve performance but must never be a required dependency.

## Fallback chain

1. in-memory active rules;
2. local persistent store when available;
3. last-known-good runtime snapshot;
4. degraded policy.

## Degraded policy

- normal development: fail open with a concise one-time warning;
- caution operations: fail open with stronger warning unless repository policy says otherwise;
- protected operations: may fail closed.

## Circuit breaker

Repeated runtime integration failures should open a circuit so agents do not pay repeated timeout costs. Recovery should probe health before returning to normal operation.

## Time budget

Runtime checks must be designed to feel effectively instantaneous to developers. Heavy retrieval, LLM reflection, embeddings and session review are outside the hot path.

## Status and explainability

Users need a concise status view showing runtime health, active profile, hard-blocking state, retrieval mode and whether fallback data is being used.
