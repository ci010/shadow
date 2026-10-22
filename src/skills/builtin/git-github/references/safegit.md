# safegit usage

Shadow bundles [ci010/safegit](https://github.com/ci010/safegit), a Windows-enabled fork of stricttools/safegit.
The pinned release is [v0.33.0-windows.1](https://github.com/ci010/safegit/releases/tag/v0.33.0-windows.1).
On Windows x64 the bundle contains native `safegit.exe` from this fork, not an
upstream Linux/macOS executable or WSL wrapper. The same release provides the
macOS/Linux x64/arm64 bundles. Target selection and archive SHA-256 pins live in
`src/execution/git/safegit.ts`; preparation uses `scripts/safegit-package.ts`.
Do not resolve a floating `latest` version or manually replace the bundle with
an unchecked download. Windows ARM64 is not supported.

Discover `safegit` under `v:tools` and call it through `invoke_tool`:

- Check availability: `{ "action": "status" }`.
- Commit explicit task-owned files (no separate `git add`):
  `{ "action": "run", "args": ["commit", "-m", "Describe the change", "--", "src/example.ts"] }`.
- Push, only when authorized:
  `{ "action": "run", "args": ["push", "--refs", "head"] }`.

Inspect status/diff before committing, preserve others' edits and verify the
result. Consult the pinned binary's subcommand help for other arguments;
safegit is not a drop-in replacement for all Git commands. Its private indexes
prevent staging races, not simultaneous edits to the same file.

The tool uses the session's local effective workdir and verified bundled binary.
macOS/Linux x64/arm64 and native Windows x64 are supported; remote workdirs are unsupported.
Missing/invalid assets block mutations: do not substitute PATH Git, WSL or gh/API
writes. Git itself must still be installed. Do not bypass refusals or disable
hooks. Availability does not grant permission to commit or publish.
