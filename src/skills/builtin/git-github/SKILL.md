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
can use Git. See [safegit usage](v:skills/git-github/references/safegit.md) for
Shadow's invocation and command differences. If unavailable, stop the mutation;
do not fall back to raw Git.

### Native Windows

On Windows x64, use Shadow's bundled **ci010/safegit** fork, pinned to
`v0.33.0-windows.1`, through the same `safegit` tool. This is a native Windows
binary, not the upstream Unix binary or a WSL wrapper. Shadow verifies the
release archive against its pinned SHA-256 during preparation; do not download
`latest`, substitute a PATH binary, or bypass a missing/invalid bundle.
Windows ARM64 is not a supported bundled target.

## GitHub

Prefer **gh** when searching GitHub or reading repository files, rather than
fetching GitHub pages/files with `fetch` or `read`. It provides structured access
and uses existing GitHub authentication; authenticated requests generally have
higher API quotas, not unlimited requests.

If gh is missing, offer setup from the [official source](https://cli.github.com/);
for manual downloads follow [download](v:skills/download). Let the human complete
any required login; never request tokens in chat.
