# Git and GitHub agent workflow

The built-in `git-github` skill and shared runtime context default commits/pushes
to [ci010/safegit](https://github.com/ci010/safegit), the pinned Windows-enabled
fork of stricttools/safegit. Other Git commands use ordinary Git; safegit coverage alone does not require
extra approval. Existing destructive-operation and publication permissions still apply.
This grants no extra tools or permission to publish.

## CLI, not a structured tool

Local `exec` exposes a native `safegit` alias through a child-only PATH and an
absolute `SHADOW_SAFEGIT_PATH`. There is no safegit tool registration, schema,
`status` action or `run` action. Historical tool calls must migrate to CLI use:

```sh
safegit --version
safegit commit --help
safegit commit -m "Describe the change" -- src/example.ts
safegit push --refs head
```

Only commit task-owned paths; push only when authorized. Private indexes and
serialized ref updates do not isolate concurrent edits to the same file.
Noninteractive Windows/macOS/Linux shells use the same native name. A
content-addressed copy under session storage handles overrides with arbitrary
filenames and spaces. Matching copies and version checks are reused; a changed
binary selects a new digest, never an old cached executable. PATH is modified
only for the child, keeping its inherited order after the alias directory.
No global PATH or user shell configuration is changed. Missing/invalid binaries
install a failing alias before inherited PATH entries, preventing system-name
substitution, and expose `SHADOW_SAFEGIT_ERROR`. Windows native lookup fails on
an intentionally invalid executable; POSIX shells print a bounded error.

`SHADOW_SAFEGIT_PATH` explicitly overrides the binary location and must be
absolute; alias preparation validates the pinned version. Main aliases/paths
are not sent to remote workdirs. The Child prepares its own native alias and
absolute binary path for remote shell execution, using the Child bundle or its
explicit host override. Its content-addressed alias cache lives under the Child
OS temporary directory (`shadow-exec/cli/safegit`), outside the worktree. Git must be installed on that device; gh remains optional.

## Preparation and failure handling

The pinned fork v0.33.0-windows.1 supports macOS/Linux x64/arm64 and Windows x64.
Archives are SHA-256 pinned in `src/execution/git/safegit.ts`; preparation checks
inventory, license, executable format, architecture and host version.
`pnpm dev` and `pnpm start` verify/reuse existing host assets or prepare absent
assets using the same pinned downloader/cache. Partial or corrupt packages and
invalid cached archives fail closed; repair explicitly with
`pnpm exec node --import tsx scripts/safegit-package.ts` after investigation.
Installed applications never download runtime resources. Release preparation
and signing remain separate and unchanged.

On safegit commit/push failure, stop and inspect possible side effects, including local status,
diff/refs and remote outcomes when relevant. Report known/unknown effects before
retrying. Never automatically fall back to raw Git, WSL or gh/API writes for commit/push.
Only explicit human authorization for the specified repository and operation
permits the corresponding ordinary Git operation, subject to higher-priority
restrictions. Honor scoped human instructions; ask if scope is unclear. This
does not expand force/reset/clean, hook bypass or publication permissions.
Workers route human decisions through their parent when required and cannot
authorize their own bypass. This is workflow guidance, not a universal sandbox.

## GitHub

Prefer optional official `gh` for bounded search/read. It is not bundled or
automatically installed. Offer official setup when missing, subject to network
and installation consent. Humans complete login; never request credentials in
chat. Reads do not authorize writes or publication.

## Focused checks

```sh
pnpm exec node --import tsx --test scripts/development-safegit_test.ts scripts/safegit-package_test.ts src/execution/git/safegit*_test.ts src/skills/git-github-discovery_test.ts src/agent/context/workspace_test.ts src/tools/shell_test.ts src/tools/shell_remote_test.ts
```

Native platform behavior and signed installers require checks on those platforms.
