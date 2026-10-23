---
name: git-github
description: "Use the pinned safegit CLI alias for commits/pushes; prefer gh for GitHub research."
core: true
metadata:
  category: tools
---

# Git and GitHub

Use **safegit** for concurrent-safe **commit** and **push** via `exec`:

- Commit explicit task-owned paths: `safegit commit -m "Describe change" -- src/example.ts`.
- Push when authorized: `safegit push --refs head`.
- Local exec provides a child-only PATH alias `safegit` and absolute
  `SHADOW_SAFEGIT_PATH`. Check arguments with `safegit commit --help` or
  `safegit push --help`. Remote devices need their own prepared binary.

Other Git commands use ordinary Git; safegit coverage alone does not require
extra approval. Existing destructive-operation and publication permissions still
apply. Concurrent commits/pushes do not isolate edits to the same file.

If a safegit commit/push fails or is unavailable, inspect possible side effects
and report before retrying. Never automatically fall back to raw Git **for
commit/push**. Only explicit human authorization for the specified repository and operation
permits that fallback, subject to higher-priority restrictions; it does not expand
force/reset/clean, hook bypass or publication permissions.

Prefer **gh** for GitHub search/file reading over fetching pages with `fetch` or
`read`; authentication improves quotas, not unlimited requests. If missing,
offer setup from https://cli.github.com/; manual downloads follow
`v:skills/download`. Humans complete login; never request tokens in chat.
