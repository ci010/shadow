# Local development

See the [quick start](../README.md#get-started) for prerequisites and installation.
Run `pnpm dev` from the repository root.

This builds the backend and desktop shell, starts Vite, and launches Electron.
Development uses the same Main data directory as production: `~/.shadow`
(including `workspace/` and the project index). **Development reads and writes
production data.** Set `SHADOW_DESKTOP_DEV_MAIN_DIRECTORY` to an absolute path
before first-time setup to use isolated data instead. Existing saved Main directory
selections are preserved; old development data is not migrated automatically.
Electron's development UI profile/cache remains worktree-local. The development
backend uses port `43124` rather than production's `43123`; existing saved dev
launch ports are overridden at runtime, without rewriting the saved profile.
Distinct ports do not bypass Main data ownership: stop production before using
the same Main directory, or select isolated development data.
Use **重启 Shadow（开发）** in the development tray menu to stop the current Electron
Main and its backend, rebuild the backend/desktop shell, and launch a new
Electron process while keeping Vite running. Normal quit still stops the entire
development process tree; this restart entry is absent in packaged builds.

The same supervised development restart is available to local admin sessions as
an on-demand dynamic tool: `invoke_tool({ name: 'development_restart', args: {} })`.
It is absent from the production/headless tool catalog and requires the live
Electron utility-process bridge, not just `NODE_ENV=development`. The host first
persists the tool receipt and publishes its outbound event, then waits 1.5 seconds
before invoking the tray's existing restart callback. This is a transport flush
window, not a client/network delivery acknowledgement; disconnected clients can
read the durable receipt after reconnecting. Scripts, remote workdirs, recovered
calls and non-admin sessions cannot request it. The whole app restarts, interrupting
other active sessions; do not use it as a per-session reset.

Browser session checks automatically retry temporary HTTP 503 responses while
the backend starts, within a single 15-second timeout. The app stays gated until
the session is verified; a longer outage displays an error with a manual retry.
Pairing submissions and sign-out requests are not automatically replayed.

`pnpm start` runs the backend without Electron or a development watcher; an
optional argument selects another bot config: `pnpm start path-to-bot-config.json`.

For a production web build:

```sh
pnpm build:all
node --env-file-if-exists=.env dist/src/index.js
```

The backend build emits `dist/src`; the web build emits `app/dist`. The
gateway serves the built UI on `http://localhost:3123` when present.
Keep the build outputs and installed runtime dependencies together when
deploying headlessly.

### Local download tool

The optional `download` tool requires **aria2 1.37.0**. It is bundled in desktop
release packages, but `pnpm install` does not install it. Source development,
`pnpm dev`, and the built backend in this checkout look for
`desktop/aria2/aria2c.exe` on Windows or `desktop/aria2/aria2c` on macOS/Linux,
independently of the process working directory. Alternatively, set
`SHADOW_ARIA2C_PATH` to an absolute path to a trusted copy of that exact version.
System PATH is not used as a fallback; no downloads run at startup.

For Windows x64, upstream publishes
[aria2-1.37.0-win-64bit-build1.zip](https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip).
Verify its SHA-256 before extraction:
`67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288`
([WinGet manifest](https://github.com/microsoft/winget-pkgs/blob/master/manifests/a/aria2/aria2/1.37.0/aria2.aria2.installer.yaml)).
Copy `aria2c.exe`, `COPYING`, and `LICENSE.OpenSSL` into `desktop/aria2`.
These local assets are Git-ignored. This portable development binary does not
replace the native-build and corresponding-source requirements for release
packaging; see [aria2 build instructions](../desktop/aria2/BUILD.md).
For local Windows dogfooding, `pnpm desktop:prepare-aria2` prepares missing source,
licenses and build instructions automatically, and downloads the checksum-verified
upstream binary when absent. It still validates the complete aria2 package.

After changing the executable path or rebuilding backend code, restart the
backend and use `download` with `action: "status"` to verify availability.
The rest of Shadow can run without aria2; only new downloads require it.
