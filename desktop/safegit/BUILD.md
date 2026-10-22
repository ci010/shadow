# Bundled safegit

Pinned upstream: stricttools/safegit v0.33.0, MIT (see LICENSE).

Run `pnpm exec node --import tsx scripts/safegit-package.ts` from the repository
root on macOS/Linux x64/arm64 to prepare the official release binary for local
development. Desktop packaging prepares it automatically. The downloaded archive
is checked against the fixed SHA-256 values in src/execution/git/safegit.ts before
extracting only safegit and LICENSE. Generated release.json records the target,
archive digest and binary digest; the desktop release manifest inventories the
packaged files. macOS performs ad-hoc signing before that final inventory.

The runtime resolves desktop/safegit/safegit in source and compiled development
runs, and resources/safegit/safegit in installed applications. An explicit absolute
SHADOW_SAFEGIT_PATH may override the location; no PATH binary is substituted.
The imported safegit tool offers status and run with literal argument arrays.
run uses the current local session workdir, bounded output/time, cancellation,
closed stdin and no automatic approval flags. Git must be installed separately;
gh remains optional and is never included in this package.

Windows is unsupported upstream, including source builds. At v0.33.0,
todo/.defer/windows-lockfileex-support.md explains that Windows platform files
were deliberately deleted and GOOS=windows fails at compile time. See also
internal/filelock/locked_append_unix.go and .goreleaser.yml. Windows desktop builds
continue without this binary; status reports unsupported and run refuses without
falling back to raw Git or WSL. This integration does not enforce a global Git
policy or sandbox arbitrary shell commands.
