# Desktop release verification

The release pipeline builds natively for the following targets. Each package
contains Electron, the Vue assets, the backend and its production dependencies.
Only Windows includes the pinned WinSW service host.

| Platform | Architecture | Download | GitHub runner |
| --- | --- | --- | --- |
| Windows | x64 | NSIS `.exe` | `windows-latest` |
| macOS | Apple Silicon arm64 | `.zip` containing `Shadow.app` | `macos-15` |
| macOS | Intel x64 | `.zip` containing `Shadow.app` | `macos-15-intel` |
| Linux | x64 | `.tar.gz` | `ubuntu-22.04` |

Archives are named `Shadow-<version>-<os>-<arch>.<extension>`. The build output
directories (`win-unpacked`, `mac`, `mac-arm64`, `linux-unpacked`) are staging
locations, not additional distribution formats. macOS architectures are separate
downloads, not a universal application. Cross-compiling and Linux arm64 are not
part of this pipeline.

## Build gate

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm desktop
```

The release command runs backend/build-script, Electron and Vue typechecks,
the focused `test:release` suite, all three production builds, production
dependency deployment, packaging, and `test:packaged`, in that order. A failure
stops the pipeline. `test:release` covers build/packaging helpers, service-mode
contracts, Vite integration and the Electron lifecycle suite; it is not a
replacement for the broader `pnpm test` feature suite.
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

Run `pnpm desktop` on the matching operating system and architecture; target
selection follows the native Node host and rejects unsupported combinations.
Do not substitute raw `electron-builder` for this command: it omits preparation
and verification.

### Shared build and cache boundaries

The split commands are intended for CI:

```sh
pnpm release:prepare all                  # typechecks, then selected JS/Web builds
pnpm release:verify-prepared desktop      # verifies current source and output bytes
pnpm test:release                        # run on the native desktop host
pnpm desktop:package                     # verified shared outputs -> native package + smoke
```

`desktop:package` refuses missing/stale prepared output but **does not run
typechecks or `test:release`**; CI runs those gates explicitly. For an ordinary
local release, keep using `pnpm desktop`, which retains the complete build gate.
Mobile consumers verify `mobile`, then run `mobile:sync`, mobile tests and native
compilation. `release:prepare` also accepts `desktop` or `mobile` individually.

The ignored `release-prepared.json` binds outputs to their source fingerprint.
Consumers download from the **same workflow run**, never from a previous run's
build-output cache, and reject changed, extra or missing output files. Checkout
disables automatic CRLF conversion so source bytes match on Windows and Unix.
Tar preserves output permissions during artifact transfer. This receipt is a
consistency check, not a signing/provenance attestation.

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

On Linux, extract the entire tarball and run its `shadow` executable as a regular
desktop user, keeping the adjacent resources/libraries intact. The archive needs
no FUSE or distribution package installer, but still requires compatible system
GTK/NSS/ALSA/GBM libraries, a graphical session and working Chromium sandbox
support. It does not register desktop shortcuts, autostart or a system service.
macOS/Linux use the ordinary owned backend sidecar, not WinSW.

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
Portable builds do not download or include WinSW.

WinSW is fixed at **2.12.0 x64**, with SHA-256:

```text
05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da
```

Its original source is the `WinSW-x64.exe` asset in the official
`winsw/winsw` GitHub release `v2.12.0`. The checksum pins those release bytes;
it is not a claim that upstream publishes a separately signed checksum.
The MIT license ships beside it.

For restricted/offline environments:

- `SHADOW_WINSW_BINARY`: a pre-provisioned binary; the same hash is always required.
- `SHADOW_WINSW_URL`: an HTTPS mirror of the exact pinned binary.
- `ELECTRON_BUILDER_BINARIES_MIRROR`: electron-builder's HTTPS mirror for its own
  packaging helpers. This is distinct from the npm package registry.
- `ELECTRON_BUILDER_CACHE`: electron-builder's cache location.
- `electron_config_cache`: the Electron npm installer's download cache location.

Mirror URLs must not embed credentials. Download errors and hash mismatches fail
the build rather than falling back to an unverified binary. The generated
`desktop/service/ShadowService.exe` is a local cache/output and is not committed.

## Artifact identity and acceptance boundaries

The package carries `resources/release-manifest.v1.json`. It records the release
and Electron versions, a build ID, hashes of packaged backend/frontend/service
files and Electron ASAR code/assets, and a fingerprint of the current build
sources, including uncommitted changes. This does not require a clean Git tree.
Source edits during release validation require a new build.
The filename is retained for compatibility; new manifests use schema v2 and
record the platform/architecture. Legacy v1 manifests are treated as Windows
x64. macOS stores resources under `Shadow.app/Contents/Resources`. Service files
are required on Windows and forbidden in macOS/Linux package inventories.

`pnpm test:packaged` first compares that manifest to the current source and
the actual packaged files, including ASAR contents. Missing, extra, modified or
stale files fail verification. This is a consistency check, not a code-signing
or supply-chain attestation.

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

For service resource measurements, distinguish the empty Electron Node runtime
from the fully initialized backend, and working set from private memory. A
headless process still consumes memory; a Node-mode baseline is not a budget
for sessions, providers, tools or the WinSW supervisor.

## Opt-in headless Windows service

The normal desktop remains a UI with an owned sidecar. Service mode is explicit:
WinSW supervises `Shadow.exe` with `ELECTRON_RUN_AS_NODE=1` and the backend JS
entrypoint, not Electron's application entrypoint. The desktop connects to that
independent backend; closing it only detaches. A missing, invalid or unavailable
service connection fails explicitly instead of starting a second backend.

Service mode rejects an Electron browser/renderer process, missing credentials,
an invalid control port, or a non-loopback `GATEWAY_HOST`. It supports an
ACL-protected `WINDOWS_USE_LAUNCH_TOKEN_FILE`; file and inline credentials cannot
be combined. Credentials are not put in the WinSW XML, renderer or command line.
The installer uses LocalService and protected Windows DACLs, not LocalSystem
or Unix permission bits as a substitute for Windows ACLs.

Choose **All users** in the assisted installer to use a service. The supported
service installation lives under native Program Files; a current-user
installation remains available for ordinary sidecar mode, but cannot register
this service. Registration checks this prerequisite before creating service
state, rather than granting a service broad access to a private user profile.

The management script requires **explicit administrator invocation** in Windows
PowerShell 5.1. Review paths and the selected local desktop user before running
it. These commands change the machine's service configuration; the build and
tests do not run them:

```powershell
$manager = 'C:\Program Files\Shadow\resources\service\manage.ps1'
powershell.exe -NoProfile -File $manager -Action Install `
  -DataDirectory 'C:\ProgramData\ShadowService' `
  -DesktopUser 'COMPUTER\username' -Port 18800
powershell.exe -NoProfile -File $manager -Action Start `
  -DataDirectory 'C:\ProgramData\ShadowService'
```

Use the actual installation path rather than assuming the example is correct.
The unsigned management script must be permitted by your organization's
PowerShell policy (for example, reviewed/signed by an administrator). It does
not silently change that policy. Runtime stop uses Node `stop.cjs`, so it does
not depend on the installing administrator's PowerShell script policy.
Install requires a **new** data directory, does not migrate an existing Home,
and does not start the service automatically. State lives outside the
application installation:

```text
<DataDirectory>\
  control\connection.v1.json
  control\runtime-config.v1.json
  control\launch-token
  control\installation.v1.json
  control\ShadowService.exe and its configuration/helpers
  data\
  logs\
```

Launch the desktop as the selected user:

```powershell
& 'C:\Program Files\Shadow\Shadow.exe' `
  --service-connection='C:\ProgramData\ShadowService\control\connection.v1.json'
```

Alternatively set `SHADOW_SERVICE_CONNECTION` for that desktop process.
Conflicting command-line and environment paths are rejected. The descriptor is
strictly validated and supplies the authoritative service configuration, port
and credential file; setup in attached mode is read-only.

The desktop is not required for browser access to this service. From a source
checkout, run the pairing CLI as the selected local user who can read the
service's protected control credential:

```powershell
pnpm web:pair --connection 'C:\ProgramData\ShadowService\control\connection.v1.json'
```

An installed application can use its bundled Node runtime instead, without a
source checkout or a separate Node installation:

```powershell
$previousNodeMode = $env:ELECTRON_RUN_AS_NODE
try {
  $env:ELECTRON_RUN_AS_NODE = '1'
  & 'C:\Program Files\Shadow\Shadow.exe' `
    'C:\Program Files\Shadow\resources\backend\dist\src\index.js' `
    web pair --connection 'C:\ProgramData\ShadowService\control\connection.v1.json'
} finally {
  $env:ELECTRON_RUN_AS_NODE = $previousNodeMode
}
```

Use the actual installation paths. `web pair` runs before backend configuration
startup, so this command issues a code from the existing service rather than
starting a second backend.

Open the printed loopback URL and enter the one-time code, not the service
credential. The code expires in five minutes; the resulting browser session
expires in twelve hours and is revoked on logout or service restart. Browser
logout does not stop the service, and browser cookies cannot call service
readiness/shutdown or issue more pairing codes. The normal browser has no
Electron minimize/maximize/close controls. This access path is loopback-only;
it does not establish an authenticated remote or multi-user deployment.

The manager also supports `Status`, `Stop`, `Reinstall` and `Uninstall`, always
with the explicit `-DataDirectory`. Install/Reinstall also require
`-DesktopUser`. Stop first attempts authenticated backend shutdown, with a
bounded, ownership-checked process-tree fallback. Uninstall preserves data.

For a manual application upgrade, **stop the service and close desktop clients
before replacing installed files**, then run Reinstall against the new
installation's manager and Start. This is not an automatic transactional updater;
exercise upgrade/rollback and uninstall on a disposable Windows VM before release.

Windows services run in Session 0. Desktop capture, microphones and interactive
browsers need a separate user-session execution path; this service implementation
does not establish that capability or claim an OS sandbox for backend tools.
