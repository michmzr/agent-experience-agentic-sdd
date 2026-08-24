# Agent operating instructions

## Always

- Read the relevant approved specification before proposing implementation work.
- Distinguish observation, lesson, rule, workflow, heuristic and preference.
- Preserve context and evidence for reusable knowledge.
- Investigate root cause before proposing a fix for a failure.
- Search existing project knowledge before retrying a failed approach.
- Treat successful workflows and positive discoveries as potential reusable knowledge, not only failures.
- Prefer deterministic, cheap and local mechanisms on the runtime hot path.
- Keep LLM analysis, embeddings and deep review outside the critical execution path.
- Explain which evidence supports a WARN or BLOCK decision.
- Treat disputed knowledge as advisory only. Never hard-block from disputed knowledge.
- Propose revalidation when successful evidence contradicts an existing verified lesson.
- Keep shared knowledge concise enough to be reviewed in Git.
- When executing a written plan, update its checklist immediately after each verified action, task, or stage. Record the current status, verification command and outcome, and the relevant commit SHA in the plan's execution-status section.
- Mark a plan item complete only after its required verification and review gates pass. Do not report an agent or task as running without a fresh status check.

## Never

- Blindly retry a failed action.
- Turn a transient failure into a permanent rule without root-cause evidence.
- Promote task-specific instructions into durable project policy.
- Automatically promote a pure user preference to shared knowledge.
- Store hidden chain-of-thought as project knowledge.
- Require network availability for normal runtime decisions.
- Make the experience layer a single point of failure for ordinary development.
- Treat a model-generated numeric confidence value as evidence.
- Claim completion without fresh verification evidence.

## Runtime failure policy

- Normal development operations fail open with one concise degraded-mode warning.
- Protected operations may fail closed according to repository policy.
- If the main store is temporarily unavailable, use the last-known-good runtime snapshot.
- If repeated integration failures occur, use a circuit breaker rather than slowing every action.

## Learning mode

When hard blocking is disabled for the current user, repository or workspace:

- keep retrieval enabled;
- keep warnings enabled;
- keep evidence collection enabled;
- downgrade BLOCK decisions to WARN;
- treat successful contradictions as evidence for revalidation, not automatic rule deletion.
