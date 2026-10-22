---
name: git-github
description: "Use the pinned safegit CLI alias for commits/pushes; prefer gh for GitHub research."
core: true
metadata:
  category: tools
---

# Git and GitHub

Default to the pinned **safegit** CLI through `exec`. Local exec provides a
child-only PATH alias `safegit` on Windows/macOS/Linux and the absolute
`SHADOW_SAFEGIT_PATH`; no structured safegit tool is provided. Nothing changes
the system PATH or user shell configuration. Main paths/aliases are not sent to
remote devices; prepare/use the binary on the execution device.

- Inspect repository status/diff with read-only Git; preserve others' edits.
- `safegit --version` and `safegit commit --help` check availability/arguments.
- Commit explicit task-owned paths: `safegit commit -m "Describe change" -- src/example.ts`.
- Push only when authorized: `safegit push --refs head`.
- `SHADOW_SAFEGIT_PATH` is an explicit absolute override, never a PATH search.
  Missing/corrupt resources report `SHADOW_SAFEGIT_ERROR`; in source development,
  repair with `pnpm exec node --import tsx scripts/safegit-package.ts`.

If safegit is unavailable or fails, stop, inspect possible side effects (local
status/diff/refs and remote outcome when relevant), and report known/unknown
effects before retrying. Never automatically fall back to raw Git. Only explicit
human authorization for the specified repository and operation permits the
corresponding raw Git operation, subject to higher-priority restrictions. Honor
an explicit scoped human instruction to use ordinary Git; ask if scope is unclear.
This does not expand force/reset/clean, hook bypass or publication permissions.
Workers route human decisions through the parent when required; they cannot
authorize their own bypass. Availability is not permission to commit or publish.

Prefer **gh** for GitHub search/file reading over fetching pages with `fetch` or
`read`; authentication improves quotas, not unlimited requests. If missing,
offer setup from https://cli.github.com/; manual downloads follow
`v:skills/download`. Humans complete login; never request tokens in chat.
