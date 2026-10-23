# safegit CLI compatibility reference

Use `safegit` via `exec`, not the former structured tool. Local exec provides a
child-only native CLI alias and `SHADOW_SAFEGIT_PATH`; remote hosts need their
own prepared binary. `safegit --version` checks availability, and each subcommand
has `--help`. Inspect status/diff before committing, name only task-owned paths,
and push only when authorized. See the Git skill for examples and the explicit
human-scoped commit/push fallback exception. Other Git commands use ordinary Git;
safegit coverage alone does not require extra approval. Never automatically fall back for commit/push after failure;
inspect side effects and report before retrying. Only explicit human authorization
for the specified repository and operation permits the corresponding raw Git
operation, subject to higher-priority restrictions. It does not expand
force/reset/clean, hook bypass or publication permissions.
