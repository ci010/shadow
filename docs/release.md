# Desktop release verification

## Install a local Windows build

On Windows x64, run from the repository root:

```sh
pnpm desktop:prepare-aria2
pnpm desktop:prepare-agent-desktop
pnpm desktop:build
pnpm desktop:install
```

These commands have separate responsibilities. `desktop:prepare-aria2` only
prepares and validates aria2 materials. `desktop:prepare-agent-desktop`
downloads and verifies the pinned official MCP CLI and required helpers. `desktop:build` compiles the backend,
Electron host and renderer, deploys production dependencies and creates the
native installer. It does not run typechecks, test suites or packaged smoke
tests, and does not install anything. `desktop:install` only installs an existing
package; it does not prepare dependencies, build, download or run test suites.
`pnpm desktop` is an alias of the same build-only flow. Typechecking and tests
are separate commands: `pnpm typecheck`, `pnpm test:release` and
`pnpm test:packaged` (the last requires an existing package).

The installation command runs the existing NSIS installer silently for the
current user. Shadow is installed
at `%LOCALAPPDATA%\Programs\Shadow`, with the installer's normal shortcuts and
uninstall registration. The command checks the installed release manifest and
file hashes against the local build before reporting success. It does not push,
publish, launch the installed app, or reset its configuration and runtime data.

Quit the installed Shadow, including background processes, before running it.
The script refuses a running installation before package verification and
immediately before installing; it does not terminate processes itself. Missing
or inconsistent package contents prevent installation. Source changes after a
build do not invalidate an existing package for installation.
Package identity/hash checks remain installation safeguards, not test suites.
An installation/post-install verification failure
is reported explicitly and does not automatically roll back binaries or data.
Dependencies must already be installed with the pinned Node/pnpm toolchain.
macOS and Linux are not supported by this local installation command.

Windows' `tar.exe` is required for first-time preparation. Missing
corresponding source and licenses are fetched from the pinned upstream aria2
commit's checksum-verified source archive; the native build script is copied
from this repository. Download archives are cached under `.tmp` and their hashes
are checked again before reuse. If no local
`aria2c.exe` exists, the official Windows x64 1.37.0 archive is downloaded and
checked against its pinned SHA-256 before extraction. Existing binaries are not
overwritten and must pass the native format and version checks. Complete inputs
are reused offline; incomplete or invalid inputs fail explicitly.
This local dogfood path can use the upstream Windows binary; CI distribution
continues to compile aria2 natively with `scripts/build-aria2-native.sh`.

## Build gate

### Desktop startup diagnostics

Desktop startup failures are written to `logs/startup.jsonl` under Electron's
user-data directory (normally `%APPDATA%\@shadow\desktop` on Windows).
The file is bounded and rotated. Failed starts include `backendError` when
the backend emits a recognizable exception: its allowlisted exception name,
error code and up to eight backend/Node source locations. Absolute paths,
exception messages, configuration, credentials and arbitrary stdout/stderr
are not persisted. The preceding `backend-phase` events show how far startup
progressed; an `early-exit` before any phase can indicate module/bootstrap failure.
Windows proxy discovery isolates its PowerShell C# compiler from inherited
`LIB`, `LIBPATH` and `INCLUDE` variables, so stale Visual Studio paths do not
prevent desktop startup. These variables are removed only from that resolver
subprocess, not from the user's environment or tool execution.

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm desktop:prepare-agent-desktop
pnpm typecheck
pnpm test:release
pnpm desktop
pnpm test:packaged
```

Build and validation are independent commands. `pnpm desktop` runs all three
production builds, production dependency deployment and packaging only.
It does not run typechecks, test suites or packaged smoke tests.
Run the commands above in order for the complete release gate; CI and Mac
deployment invoke their validation steps explicitly. `test:release` covers build/packaging helpers, service-mode
contracts, Vite integration and the Electron lifecycle suite; it is not a
replacement for the broader `pnpm test` feature suite.
Release helper test files run serially because they launch compiler and runtime
subprocesses with bounded deadlines. The cold Vite/UnoCSS integration check runs
after them, so competing builds cannot consume its readiness budget on native
CI runners.
The desktop test glob is quoted so Node discovers root and nested tests
consistently on Windows, macOS and Linux instead of relying on shell expansion.

Nested pnpm commands reuse `npm_execpath`: JavaScript entrypoints run through
Node, while native executables (including extensionless macOS/Linux pnpm 12
binaries) run directly without a shell.

The **Shadow release build** workflow (`.github/workflows/release-check.yml`)
is the single desktop/mobile entrypoint. Relevant pull requests validate **all**
targets; manual dispatch selects `desktop`, `mobile`, or `all` (default).
There is no additional push-triggered release run: to get a branch test build,
dispatch this workflow with that branch selected. Mobile jobs are called through
`mobile-release.yml`, which no longer has a separate dispatch or push trigger.
New runs cancel older runs for the same PR/ref and target selection.

A shared Ubuntu job runs typechecks once and builds the selected portable
JS/assets in parallel. Desktop consumers download backend JS, Electron host JS
and the ordinary Vue bundle; mobile consumers use a **separate mobile-mode**
Vue bundle. Native jobs still install their own dependencies and run their
existing platform tests. Desktop jobs deploy native production dependencies,
package, and run the full packaged verification; mobile jobs sync Capacitor and
compile with the native SDK. No installed `node_modules` crosses platforms.

Linux uses Xvfb for Electron checks without disabling the renderer sandbox and
installs its display-library prerequisites on the ephemeral runner. Successful
native jobs upload their installer/archive as Actions artifacts, retained for
14 days; failed verification does not upload a package. The intermediate shared
artifact is retained for 3 days and is **not an installable release**.
The workflow does not publish GitHub Releases or install/register applications.
Synthetic acceptance and packaged smoke processes use explicit direct-network
settings rather than inheriting the host's proxy or PAC configuration. These
loopback checks do not validate production proxy connectivity.
The release gate separately exercises proxy routing and cancellation. Windows
also evaluates a synthetic PAC served over loopback through native WinHTTP,
without reading or changing the runner's system proxy configuration.

Run `pnpm desktop` on the matching operating system and architecture; target
selection follows the native Node host and rejects unsupported combinations.
Prepare the pinned official CLI and adjacent helpers on that host with
`pnpm desktop:prepare-agent-desktop` before building or packaging. For a split
build, prepare assets on both the shared build host and each native packaging
runner; verified package output uses only the native runner’s target assets.
Do not substitute raw `electron-builder` for this command: it omits preparation
and verification.

### Shared build and cache boundaries

The split commands are intended for CI:

```sh
pnpm desktop:prepare-agent-desktop        # official assets for the current host
pnpm release:prepare all                  # typechecks, then selected JS/Web builds
pnpm release:verify-prepared desktop      # verifies current source and output bytes
pnpm test:release                        # run on the native desktop host
pnpm desktop:package                     # verified shared outputs -> native package
pnpm test:packaged                       # test the existing native package
```

`desktop:package` refuses missing/stale prepared output but does not run
typechecks or tests; CI runs those gates explicitly. For an ordinary local
release, run the separate commands listed under Build gate.
Mobile consumers verify `mobile`, then run `mobile:sync`, mobile tests and native
compilation. `release:prepare` also accepts `desktop` or `mobile` individually.

The ignored `release-prepared.json` binds outputs to their source fingerprint.
Consumers download from the **same workflow run**, never from a previous run's
build-output cache, and reject changed, extra or missing output files. Checkout
disables automatic CRLF conversion so source bytes match on Windows and Unix.
Tar preserves output permissions during artifact transfer. Extraction reads the
archive through stdin so Windows drive-letter paths are not interpreted as
remote hosts by Git Bash's tar. This receipt is a consistency check, not a
signing/provenance attestation.

Caches cover pnpm's dependency store; Electron and electron-builder downloads
keyed by OS/architecture and dependency inputs; Gradle user home/local build
cache; and Swift package downloads keyed by OS/architecture, Xcode and dependency
inputs. Electron is resolved once before parallel tests to avoid concurrent
lazy extraction. Signed jobs only read native build caches; signing material and
Xcode DerivedData are not cached. Already-compressed native archives use upload
compression level zero.

This removes repeated typechecking and JS/Web compilation but adds a shared-job
dependency and artifact transfer. Compare cold and warm CI runs before claiming
a wall-time improvement; native compilation, tests and packaged smoke still run.

### Portable package boundaries

On macOS, extract the ZIP to obtain `Shadow.app`. The initial artifacts use
**ad-hoc signing**, not an Apple Developer ID certificate, and are **not
notarized**. The entitlements permit Electron's JIT and ad-hoc framework loading;
this does not disable the renderer's sandbox/context isolation. These are
test artifacts, not Gatekeeper-approved public releases. Trusted distribution
requires a separate Developer ID/notarization setup; do not bypass OS security
warnings as part of build verification.
Keep the entitlement plist files LF-terminated when transferring a Windows
checkout to a Mac. Git attributes enforce this: macOS `codesign` may reject CRLF
entitlements even when `plutil -lint` accepts the same file.

On Linux, extract the entire tarball and run its `shadow` executable as a regular
desktop user, keeping the adjacent resources/libraries intact. The archive needs
no FUSE or distribution package installer, but still requires compatible system
GTK/NSS/ALSA/GBM libraries, a graphical session and working Chromium sandbox
support. It does not register desktop shortcuts, autostart or a system service.

Native CI smoke tests are not broad clean-machine certification, an OS-install
test, or proof that every platform-specific tool is available. The macOS/Linux
jobs must run on GitHub before claiming those packages passed native verification;
Windows-hosted unit tests alone do not establish that.

## Download configuration

Packaging reuses the installed Electron distribution and verifies its version
against `desktop/package.json`, avoiding a second Electron download. Set
`SHADOW_ELECTRON_DIST` to the root of an existing matching native Electron
distribution to override it. Its `version` plus `electron.exe` (Windows),
`Electron.app/Contents/MacOS/Electron` (macOS), or `electron` (Linux) must exist.
For restricted/offline environments:

- `ELECTRON_BUILDER_BINARIES_MIRROR`: electron-builder's HTTPS mirror for its own
  packaging helpers. This is distinct from the npm package registry.
- `ELECTRON_BUILDER_CACHE`: electron-builder's cache location.
- `electron_config_cache`: the Electron npm installer's download cache location.

Mirror URLs must not embed credentials.

## Artifact identity and acceptance boundaries

The package carries `resources/release-manifest.v1.json`. It records the release
and Electron versions, a build ID, hashes of packaged backend/frontend
files and Electron ASAR code/assets, and a fingerprint of the current build
sources, including uncommitted changes. This does not require a clean Git tree.
Source edits during release validation require a new build.
The filename is retained for compatibility; new manifests use schema v2 and
record the platform/architecture. Legacy v1 manifests are treated as Windows
x64. macOS stores resources under `Shadow.app/Contents/Resources`. New builds do not ship the Windows service wrapper.

`pnpm test:packaged` first compares that manifest to the current source and
the actual packaged files, including ASAR contents. Missing, extra, modified or
stale files fail verification. This is a consistency check, not a code-signing
or supply-chain attestation.
The input inventory omits dependency `.gitkeep` placeholders that Electron's
packager removes; verification still rejects unexpected files in the package.
Only the target OS's aria2 executable is included, even if another platform's
binary is present in the source staging directory. On macOS the downloader is
ad-hoc signed and verified before its hash is recorded, using the same signing
options as the application packager; packaging must preserve those bytes.

The packaged smoke relocates the entire application outside the repository,
rechecks its manifest, and runs its copied executable in Node mode with
disposable configuration, a credential file, loopback networking and an isolated
profile. It exercises backend readiness/authentication, telemetry, the eval
runner and shutdown. It reports the empty Node-runtime memory baseline and
separate backend working-set/cumulative-CPU samples.
Generated data paths use the canonical temporary directory (including macOS's
`/var` to `/private/var` alias), without relaxing resource-store symlink checks.

A separate hidden/offscreen fixture loads the packaged renderer and preload,
checking startup rendering, assets, IPC and sandboxing. It substitutes a test
entry in the copied package while preserving the original ASAR; this is **not**
the unchanged production application entry or a full UI regression suite.
On macOS only the disposable relocated bundle is re-signed ad-hoc after this
substitution, preserving its entitlements/runtime flags; the original packaged
application is not modified. Unix process cleanup checks exact PID/start
identity and waits within a bounded deadline for termination to complete,
while Windows retains its own process-census implementation.
The fixture substitutes inert local CSS for the application's exact optional
Google Fonts stylesheet request; it verifies fallback rendering, not remote font
availability. Other external requests remain blocked and fail acceptance.
Neither fixture uses real provider credentials or user history.
Do not treat a successful smoke as proof of NSIS installation, upgrade,
uninstallation, Windows SCM behavior, or interactive capabilities in Session 0.
Those require a disposable Windows VM and explicit operator approval.
