# Knowledge lifecycle

## Layers

### Observation

A factual event or discovery from a session. It may be useful or transient. Observations are local by default.

### Candidate lesson

A generalized interpretation of one or more observations that appears reusable.

### Durable knowledge

A reviewed lesson, workflow, fact, convention, heuristic or preference with explicit applicability and evidence.

## States

- `candidate` - proposed generalization, not trusted.
- `observed` - supported by direct evidence but not yet broadly confirmed.
- `confirmed` - repeated or independently supported; advisory.
- `verified` - sufficient evidence for enforcement according to policy.
- `disputed` - credible contradictory evidence exists; never hard-block.
- `superseded` - replaced by newer knowledge; retained for audit.
- `rejected` - reviewed and intentionally not accepted.
- `expired` - no longer considered active due to lifecycle policy.

## Scope

- Local episodic memory: private observations and candidates.
- Repository memory: project-specific durable knowledge.
- Global user memory: reusable knowledge across projects; promotion requires explicit user approval.

## Team sharing

Shared repository knowledge becomes authoritative for the team only after normal Git merge. Unmerged branch knowledge may be used as local context but must not be presented as merged team policy.

## Clustering

Learning mode may capture aggressively. Similar observations should be clustered and generalized so multiple symptoms can become one useful lesson instead of many noisy rules.

## Retention

Observations use value-aware retention. Keep evidence referenced by active lessons, disputes, reviews, proposals or specs. Unreferenced observations may expire under configured TTL.
