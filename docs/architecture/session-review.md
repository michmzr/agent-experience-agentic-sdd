# Session review architecture

## Manual invocation

Deep review requires an explicit source tool and selected session. Session discovery should support repository-scoped interactive selection, explicit ID and latest-for-current-repository behavior.

## Pipeline

1. source adapter discovers and reads the session;
2. parser normalizes events into the common schema;
3. raw source material remains local;
4. sanitizer removes secrets and configured sensitive patterns;
5. selected reviewer runtime dispatches specialist reviews;
6. orchestrator reconciles the outputs;
7. results become findings, lessons and proposals.

## Pluggable reviewer runtime

The source tool and reviewer backend are independent. A Codex session may be reviewed by Claude Code, Codex, Cursor or a direct API backend if configured.

## Review profiles

Built-in profiles define reviewer sets. Custom reviewer skills are allowed. Reviewer scopes should be independent enough for parallel analysis.

## Repository verification

Reviewers may read repository state. Controlled diagnostics should use isolated execution where practical. Expensive checks require explicit permission.

## Persistence

Full sanitized review artifacts remain local. Only durable insights, approved knowledge and SDD artifacts are candidates for Git.
