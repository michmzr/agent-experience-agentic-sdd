# System overview

## Architectural style

Local-first modular CLI/core with thin integrations for Codex, Claude Code and Cursor. The system separates the critical runtime path from slower analysis and learning workflows.

## Runtime plane

Responsibilities:

- receive normalized intent/tool events;
- retrieve exact and metadata-matched durable knowledge;
- apply lifecycle and profile policy;
- return ALLOW, WARN or BLOCK;
- operate from in-memory state and last-known-good snapshots when possible.

Constraints:

- no mandatory LLM call;
- no mandatory network access;
- no mandatory daemon;
- graceful degradation for ordinary development.

## Experience plane

Responsibilities:

- capture raw events and observations;
- cluster related observations;
- generate candidate lessons;
- manage lifecycle transitions and contradictions;
- promote durable repository knowledge under policy.

## Review plane

Responsibilities:

- discover and normalize complete source sessions;
- sanitize sensitive data;
- dispatch focused reviewer perspectives;
- synthesize findings;
- create candidate lessons and improvement proposals.

## Shared knowledge plane

Durable team knowledge is stored in human-reviewable project documentation with a machine-readable index. The exact storage format is defined by the shared-knowledge spec. Git merge is the team governance boundary.

## Proposal plane

Improvement findings move through proposal and SDD artifacts. Code/tooling/architecture changes require approved specification before development.
