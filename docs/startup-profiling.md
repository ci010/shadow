# One-shot development startup profiling

This is a local, opt-in diagnostic capture, not a startup optimization or a
change to the desktop's 15-second readiness deadline. It does not launch, stop,
or restart an existing backend. The next normal in-app development rebuild/restart
(or a fresh `pnpm dev`) rebuilds the backend and Electron code before launching them.

## Arm and disable

From the repository root, create the ignored marker `.logs/startup-profile.arm`.
For example, in PowerShell:

```powershell
New-Item -ItemType Directory -Force .logs | Out-Null
New-Item -ItemType File -Force .logs/startup-profile.arm | Out-Null
```

Then use the normal **in-app development rebuild/restart**, or launch a fresh
`pnpm dev`. Electron checks the marker once when creating its runtime host,
using its known development app path; an already-running outer development
launcher does not need to be restarted or have profiling environment variables.
The marker is consumed once and the capture directory is retained for failed
sidecar retries in that Electron process. Rearming during that process targets
the next Electron restart, not a sidecar retry. Without a launcher-provided
capture directory, a subsequent Electron restart is unprofiled unless rearmed.

Fresh `pnpm dev` remains supported: its launcher consumes the marker after its
builds, immediately before launching Electron, and passes the capture directory.
That launcher-provided capture applies to its development invocation (including
in-app restarts), as before. Builds and tests alone do not consume the real
marker. Packaged and non-development launches never inspect repository markers.

To cancel before restarting, delete `.logs/startup-profile.arm`. Alternatively,
set `SHADOW_STARTUP_PROFILE=0` for the dev launcher; this disables capture but
leaves the marker for a later launch. No `NODE_OPTIONS` or network inspector is
used. `SHADOW_STARTUP_PROFILE_DIR` is an internal launcher-to-sidecar value;
`pnpm dev` clears inherited values and supplies it only after consuming the arm
marker; the development Electron host can also supply it by consuming the marker
itself. Explicit opt-out suppresses either source and leaves the marker intact.
To stop profiling future retries in an already armed dev invocation, exit it
normally and start a fresh unarmed invocation.

## Output and bounds

New capture files are under:

- `<repo>/.logs/startup-profiles/capture-<epoch-ms>-<pid>/phases.jsonl`
- `<repo>/.logs/startup-profiles/capture-<epoch-ms>-<pid>/cpu-<n>.cpuprofile`

Only the latest three strictly named capture generations are retained. Each
contains at most ten CPU chunks of at most 8 MiB each and 4,096 fixed-shape phase
records. Unrelated files in the parent directory are not deleted. The files are
local-only, git-ignored and not uploaded. Creation requests owner-only Unix
permissions; on Windows the existing directory ACL applies. Remove the capture
folders when diagnosis is complete.

The existing sanitized desktop timeline is unchanged:
`<Electron userData>/logs/startup.jsonl` (plus `.1` and `.2` rotations). By default
in development this is `<repo>/.tmp/desktop-dev/user-data/logs/startup.jsonl`;
an explicit desktop user-data override changes that path. It contains the
supervisor spawn, timeout and readiness timestamps, including a timeout when
the backend itself cannot run another callback.

## What is measured

- The supervisor describes the preload using Node `--import` ordering. Electron
  utility processes do not execute that flag through `ForkOptions.execArgv`;
  the utility adapter instead launches the built `utility-profile-bootstrap.js`
  only for an armed capture. It awaits the small profiler preload **before**
  importing `dist/src/index.js` and its static application dependency graph,
  restores the original application argv, then calls `runRootProcessEntry()`
  exactly once (the imported index's `import.meta.main` is false). Unarmed
  launches retain the original entry. A plain Node spawn uses `--import` directly. `bootstrap`
  spans from that preload to creation of the Main host's startup timer,
  including application import/module evaluation and pre-host setup. The
  initial `processUptimeMs` also exposes the small process/bootstrap interval
  before the preload; correlate its timestamp with the supervisor's `spawned`
  entry. This is not a per-module import trace and does not include Electron's
  own startup or the preceding build.
- Every existing host/Project startup phase writes an incremental snapshot.
  Ownership additionally records each Project and its JSONL scan, optional
  SQLite open/scan/close, and remote-workdir reservation. Completed storage
  records include state counts; neither session contents nor IDs are persisted.
- Snapshots include monotonic wall elapsed time, cumulative user/system CPU
  microseconds since preload, current RSS/heap bytes, process high-water RSS
  in KiB, filesystem operation and context-switch deltas. Subtract matching
  start/end records for phase costs. CPU/resource counters are process-wide:
  overlapping Project phases are not exclusive attribution. Some resource
  counters are zero or unsupported on Windows; they are not I/O byte counts.
- Project IDs stay in memory and become capture-local ordinals (up to 128).
  Ordinals are shared between ownership and later Project phases within this
  file. Do not assume they match ordinals in a different capture or in
  `startup.jsonl`.
- In-process `node:inspector.Session` samples CPU every 2 ms. Roughly every two
  seconds it stops, synchronously saves a chunk, then starts the next one.
  Capture stops at Main host readiness or after 20 seconds, whichever comes
  first. This covers the ownership tail of slow starts; it does **not** extend
  the supervisor timeout. Inspect individual `.cpuprofile` files in a local
  DevTools Performance/JavaScript profiler or another local CPU-profile viewer.

## Timeout, privacy and interpretation limits

Phase records are synchronously appended as work begins and completes, so an
incomplete phase still identifies where termination occurred. CPU chunks are
saved during startup rather than relying on graceful exit. A synthetic forced
kill test verifies that an already-written chunk and phase records survive.
Windows forced termination does not run exit handlers: the current unsaved
chunk is lost. A synchronous main-thread stall can also delay checkpoint and
stop timers; if it spans the whole startup, there may be no CPU chunk at all.
The preload record and prior phase records remain, and the independent desktop
`startup.jsonl` records the timeout. No in-process profiler can guarantee a
final flush after a hard kill. Files are not fsynced; this is process-kill
resilience, not a power-loss durability guarantee.

The new phase stream uses fixed labels and numeric counters, never configuration,
state, errors, environment values, Project/session IDs or filesystem paths.
CPU files retain source function symbols and line/column locations, but strip
absolute paths, arbitrary URL values, source text, arguments, local variables,
heap data and extra inspector metadata. Only repository `dist/src` and `node:`
source locations are kept; other locations become `(external)`, and unexpected
function-name characters are redacted. Treat these as private diagnostic files,
not as a reason to share full logs/configuration. Dependency paths are intentionally
redacted, so native/external attribution is less detailed.

Profiling and synchronous small-file writes add overhead; use this capture to
locate candidates, not as an uninstrumented performance benchmark. A slow cold
first launch and a faster retry are separate captures and should be compared
with cache effects in mind. Missing output can mean a consumed marker followed
by a launch failure, an unavailable inspector, or an unwritable capture path;
a fixed warning is printed if the capture directory cannot be prepared.

## Synthetic Electron regression smoke

After backend artifacts already exist, build only desktop with
`pnpm --dir desktop build`. In PowerShell, run:

```powershell
$env:SHADOW_TEST_ELECTRON_UTILITY_PROFILE = '1'
pnpm exec node --import tsx --test desktop/src/sidecar/utility-process-profile.node-test.ts
Remove-Item Env:SHADOW_TEST_ELECTRON_UTILITY_PROFILE
```

This launches a disposable real Electron main and utility process, not Shadow.
It uses the compiled backend preload and desktop bootstrap with a synthetic
entry: no backend/config/data imports. It verifies preload-before-entry, argv,
exactly-once explicit entry dispatch, CPU/phase output and nonzero bootstrap
failure. Temporary files are removed. Electron-as-Node alone cannot validate
this transport. The smoke does not consume the arm marker or profile an already
running host; the next normal in-app development rebuild/restart (or a fresh
`pnpm dev`) loads the rebuilt Electron code and consumes the marker.
