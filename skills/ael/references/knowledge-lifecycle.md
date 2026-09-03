# Knowledge lifecycle

Use `ael lessons list`, `ael retrieve`, and `ael inspect <id>` to inspect persisted knowledge. Scope is `global` or `repo` at the CLI boundary. Filter explicitly with repository IDs, tags, or states when the task requires it.

Promote a reviewed entry with `ael knowledge promote --repository <path> --input <path>`. Verify repository knowledge with `ael knowledge validate --repository <path>` and refresh runtime activation only with `ael knowledge refresh-runtime --repository <path> --repository-id <id> --trusted-ref <ref>`.

Do not treat a candidate, observed, disputed, superseded, rejected, or expired entry as verified guidance. Resolve conflicts from evidence, preserving the lifecycle state. Run `ael --help` before relying on a command not listed here.
