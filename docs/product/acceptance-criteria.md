# Product acceptance criteria

V1 is acceptable only when both functional behavior and measurable quality are demonstrated.

## Functional acceptance

- Sessions from all three source tools can be discovered or selected with explicit tool identity.
- A deep review produces structured findings from sanitized data.
- Reviewer outputs can be synthesized into candidate lessons and project improvement proposals.
- Repository knowledge can be shared through normal Git review and merge.
- Runtime rules can produce ALLOW, WARN and BLOCK decisions without LLM or network calls.
- Learning mode reliably downgrades hard blocks while keeping learning active.
- Contradictory successful evidence can move knowledge toward revalidation without automatic deletion.
- Configuration can resolve repository and workspace profiles and explain precedence.

## Benchmark acceptance

Maintain regression cases that cover at least:

- repeated invalid command;
- reusable successful workflow;
- stale verified rule contradicted by new evidence;
- disputed rule must not block;
- task-specific user instruction must not become durable policy;
- repeated user correction becomes a proposal, not automatic policy;
- temporary artifact becomes tooling candidate only when recurrence justifies it;
- architecture/DX friction is consolidated from multiple reviewer findings;
- knowledge learned in one merged branch is reusable by another agent/user;
- degraded runtime fails open for ordinary actions and preserves protected fail-closed behavior.

Metrics should include retrieval recall, false warnings, false hard blocks, lesson precision and reviewer finding usefulness. Thresholds must be established from real project sessions before being used as release gates.
