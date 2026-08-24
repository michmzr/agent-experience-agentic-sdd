# Product requirements

## Functional requirements

### FR-01 Cross-agent support

Support Codex, Claude Code and Cursor through thin adapters while keeping one shared core behavior model.

### FR-02 Memory scopes

Support global user knowledge and repository-scoped knowledge. Repository knowledge may be shared through Git after merge.

### FR-03 Experience types

Capture failures, successful workflows, project facts, conventions, tool capabilities, environment quirks, heuristics and preferences.

### FR-04 Context preservation

Every reusable lesson must preserve applicability context and evidence sufficient to understand why it exists.

### FR-05 Action and intent gating

Check both tool actions and higher-level technical intent. Decisions are ALLOW, WARN or BLOCK according to lifecycle state, match strength, profile and repository policy.

### FR-06 Learning mode

Allow hard blocking to be disabled per user and per repository/workspace while preserving warnings, retrieval and learning.

### FR-07 Session review

Provide manual session discovery and review for a declared source tool. Support an interactive selector, explicit session ID and a repository-scoped latest session concept.

### FR-08 Multi-reviewer analysis

Run independent reviewer perspectives in parallel when supported, then synthesize findings through an orchestrator.

### FR-09 Privacy

Keep raw session data local. Sanitize secrets and sensitive values before analysis by external reviewer models.

### FR-10 Shared knowledge

Use a human-readable versioned knowledge representation with machine-readable indexing. Durable team knowledge becomes authoritative after Git merge.

### FR-11 Proposals and SDD

Session review can generate improvement proposals. Executable behavior changes require approved specifications before implementation.

### FR-12 Optional semantic retrieval

Embeddings and RAG are optional. Exact, path, tool, tag and metadata retrieval must remain sufficient for core operation.

### FR-13 Resilience

Normal development must continue if the experience layer degrades. Protected operations may fail closed. Runtime should prefer in-memory rules and a last-known-good snapshot before heavier storage or services.

### FR-14 Configurable targets

Global configuration must map profiles to exact or wildcard Git remotes and to exact or wildcard workspace paths, including directories without Git.

### FR-15 Quality benchmark

Maintain deterministic benchmark cases for retrieval, enforcement, conflict handling, lesson quality, session review and cross-agent reuse.

## Non-functional requirements

- macOS and Linux for v1.
- local-first and cheap to operate.
- no mandatory always-running daemon.
- no LLM or network requirement on the runtime hot path.
- runtime decision path designed for negligible developer-visible latency.
- explainable configuration and enforcement decisions.
- auditability of knowledge and proposal provenance.
