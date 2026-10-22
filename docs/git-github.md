# Git and GitHub agent workflow

Shadow ships the built-in `git-github` skill. The shared session workspace
context points executing agents to it before Git mutations or GitHub research;
coordination-only agents carry the requirement into worker assignments.
This does not grant extra tools or permission to publish.

## Git

Commits and pushes use [ci010/safegit](https://github.com/ci010/safegit), the Windows-enabled fork of stricttools/safegit,
a separate binary, rather than raw `git add` / `git commit` / `git push`.
Safegit commits explicit paths through private indexes and serializes reference
updates. It does not isolate simultaneous edits to the same working-tree file.
Read-only Git inspection remains available through ordinary Git.

The `safegit` tool exposes `status` and `run` actions. Run `status` first;
`run` executes arguments in the local session's effective workdir. For example:

```json
{"action":"run","args":["commit","-m","Describe the change","--","src/example.ts"]}
```

```json
{"action":"run","args":["push","--refs","head"]}
```

The pinned fork prerelease `v0.33.0-windows.1` supports macOS/Linux x64/arm64
and native Windows x64. The [fork release](https://github.com/ci010/safegit/releases/tag/v0.33.0-windows.1)
was built from `559455e6cf0e68d067684b11e725fae1ad821358`; all 16 jobs in
[its CI run](https://github.com/ci010/safegit/actions/runs/39716324711) passed.
Every archive is SHA-256 pinned in `src/execution/git/safegit.ts` against the
release's `checksums.txt`; packaging verifies
the executable format, architecture and (on the host target) version. Agents
must not fall back to raw Git or WSL. Remote workdirs are not supported
by the local safegit tool. Git itself must still be installed on the execution
device. Missing assets/version mismatches block execution instead of selecting
an arbitrary executable from PATH. No download occurs automatically at startup.

This is an agent workflow convention with a verified execution entry point, not
a universal shell sandbox: arbitrary shell commands are not rewritten or blocked.

## GitHub

For GitHub search/read, prefer the optional official `gh` CLI with explicit repo,
structured output and bounded pagination. The skill covers repository/code search,
issues, PRs, contents API decoding and reproducible refs. `gh` is not bundled or
automatically installed. If absent, agents can offer official package-manager or
checksum-verified release setup, subject to installation/network consent. Login
uses the human's official browser/device flow, never credentials pasted in chat.
Public API/web reads remain a clearly labelled fallback if setup is unavailable.

GitHub reads do not authorize writes. Do not use gh/API mutations to bypass
safegit commit/push rules.

## Focused checks

```sh
pnpm exec node --import tsx --test src/skills/git-github-discovery_test.ts src/agent/context/workspace_test.ts
```

Native Unix execution and signed desktop installers require verification on
those platforms; Windows tests cannot establish that runtime behavior.
