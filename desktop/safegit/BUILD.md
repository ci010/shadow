# Bundled safegit

Pinned fork: ci010/safegit v0.33.0-windows.1, MIT (see LICENSE).
The fork provides macOS/Linux x64/arm64 and Windows x64 binaries; there is
no automatic system PATH, raw Git or WSL fallback on unsupported hosts.

`pnpm dev` and `pnpm start` prepare the host-native binary before launching.
A matching existing package is verified and reused without a network request.
When both binary and inventory are absent, the shared development preparation
uses the pinned packaging downloader. Partial, corrupt, wrong-architecture or
wrong-version packages fail closed instead of silently replacing local files.
For an explicit repair, run
`pnpm exec node --import tsx scripts/safegit-package.ts` from the repository root.

The packaging downloader reuses `.tmp/safegit_<version>_<target>.tar.gz` after
checking its fixed SHA-256 from src/execution/git/safegit.ts. Invalid cached
archives fail closed; inspect/remove the invalid cache explicitly before retrying.
Only the named binary and LICENSE are extracted. Generated release.json records
the target, archive digest and binary digest. Verification checks inventory,
license, native executable format/architecture, and the version on the host.
Desktop packaging prepares the resource independently; macOS ad-hoc signing
updates its binary inventory before the final release manifest is generated.
Installed applications do not download resources at runtime.

The runtime resolves desktop/safegit/safegit (safegit.exe on Windows) in source
and compiled development runs, and resources/safegit in installed applications.
An explicit absolute SHADOW_SAFEGIT_PATH is respected and version-checked, never
overwritten or replaced by a download. Local exec provides a child-only native `safegit` PATH alias (also in noninteractive
shells) using a verified content-addressed copy in session storage. Missing or invalid
binaries install a failing alias, not a system PATH fallback. No structured safegit
tool is exposed. Git must be installed
separately; gh remains optional and is not bundled. This integration does not
sandbox arbitrary shell commands or enforce a global Git policy.
