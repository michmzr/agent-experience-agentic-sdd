# Domain model

## Session

A source-specific interaction history from Codex, Claude Code or Cursor, associated with a repository/workspace when discoverable.

## Event

A normalized factual unit from a session: prompt, response, tool request, tool result, file edit, test result, review result or other observable action.

## Observation

An interpreted but still local statement derived from one or more events.

## Lesson

A reusable generalization with applicability context and evidence.

Kinds include failure, successful workflow, project fact, convention, tool capability, environment quirk, heuristic and preference.

## Evidence

Traceable support for an observation or lesson. Evidence may confirm, contradict or contextualize a claim.

## Knowledge entry

A durable repository or global lesson with lifecycle state and retrieval metadata.

## Finding

A reviewer conclusion tied to evidence from session and optionally repository verification.

## Proposal

A concrete recommended change derived from one or more findings.

## Specification

An approved behavioral contract for a proposal before implementation planning.

## Review

A manual analysis run with a declared source tool, selected reviewer profile, normalized session and orchestrated result.

## Profile

A named bundle controlling runtime enforcement and learning behavior for a repository or workspace.
