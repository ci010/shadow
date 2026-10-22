# safegit usage

Read `v:tools/safegit/safegit` directly for the current tool contract; no search
is needed. Call `safegit` through `invoke_tool`:

- Check availability: `{ "action": "status" }`.
- Commit explicit task-owned files (no separate `git add`):
  `{ "action": "run", "args": ["commit", "-m", "Describe the change", "--", "src/example.ts"] }`.
- Push, only when authorized:
  `{ "action": "run", "args": ["push", "--refs", "head"] }`.

Local `exec` provides `SHADOW_SAFEGIT_PATH` when the bundled binary exists on a
supported host. CLI help examples:

- PowerShell: `& $env:SHADOW_SAFEGIT_PATH --help`
- POSIX shell: `"$SHADOW_SAFEGIT_PATH" commit --help`

The structured tool remains the default entry; invoking this CLI variable is
also allowed for the same authorized safegit operations. The default uses a
file check, not the tool's version validation. Explicit host overrides win over
workspace `.env` for this variable; otherwise explicit `.env` values are kept,
including empty values. Other `.env` variables retain their normal precedence.
Explicit values are configuration, not an availability guarantee. Missing or
unsupported bundles leave the default unset without breaking unrelated exec.
No Main binary path is forwarded to remote workdirs. Do not substitute raw Git.

Inspect status/diff before committing, preserve others' edits and verify the
result. Consult the pinned binary's subcommand help for other arguments;
safegit is not a drop-in replacement for all Git commands. Its private indexes
prevent staging races, not simultaneous edits to the same file.

The tool uses the session's local effective workdir and verified bundled binary.
Remote workdirs are unsupported. Missing/invalid assets block mutations:
do not substitute another binary or gh/API writes. Git itself must still be installed. Do not bypass refusals or disable
hooks. Availability does not grant permission to commit or publish.
