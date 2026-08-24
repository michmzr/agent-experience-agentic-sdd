# Configuration intent

Implementation should support hierarchical configuration with these sources, from strongest to weakest:

1. explicit CLI/session override;
2. user-local repository override;
3. exact global repository selector;
4. exact global workspace/path selector;
5. repository-shared configuration;
6. Git remote wildcard selector;
7. path wildcard selector;
8. global default profile;
9. built-in defaults.

Global target selection must support both Git remotes and plain workspace directories without Git.

Built-in profiles: `normal`, `learning`, `observe-only`, `strict`. Custom profiles may extend built-ins and control both runtime and learning policy.

The effective configuration must be explainable: a user should be able to see which source produced each resolved setting.
