---
name: git-github
description: "Use bundled safegit for commits/pushes; prefer gh for GitHub search and file reading."
core: true
metadata:
  category: tools
---

# Git and GitHub

## Git

In every session, use bundled **safegit** for commits and pushes, never raw
`git commit` or `git push`. It works with ordinary Git repositories but supports
only a subset of Git, with different commit/push arguments. Read-only commands
can use Git. Read `v:tools/safegit/safegit` directly for the tool contract, then
call `safegit` through `invoke_tool` (the default structured entry). Local exec
also exposes `SHADOW_SAFEGIT_PATH` for CLI help and the same authorized safegit
operations; this is not permission to bypass safegit with raw Git. See
[safegit usage](v:skills/git-github/references/safegit.md) for commit/push examples.
If unavailable, stop the mutation; do not fall back to raw Git.

## GitHub

Prefer **gh** when searching GitHub or reading repository files, rather than
fetching GitHub pages/files with `fetch` or `read`. It provides structured access
and uses existing GitHub authentication; authenticated requests generally have
higher API quotas, not unlimited requests.

If gh is missing, offer setup from the [official source](https://cli.github.com/);
for manual downloads follow [download](v:skills/download). Let the human complete
any required login; never request tokens in chat.
