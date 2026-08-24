# Agent process validation checklist

Before implementation begins:

- relevant Superpowers process skill selected;
- approved specification exists when required;
- no unresolved spec placeholders;
- acceptance criteria are observable;
- implementation plan points to the correct spec.

Before a fix:

- failure reproduced or enough evidence collected;
- root cause investigated;
- one hypothesis identified;
- smallest useful experiment selected.

Before completion:

- fresh tests/checks run;
- full relevant suite checked, not only a subset unless explicitly scoped;
- requirements coverage reviewed;
- benchmark cases updated when agent behavior changed;
- final diff reviewed for accidental scope expansion.

Before updating a project skill:

- trigger is specific;
- description says when to use the skill, not the whole workflow;
- skill does not duplicate deterministic policy better enforced by tooling;
- pressure/behavior scenarios exist for later validation against real agents.
