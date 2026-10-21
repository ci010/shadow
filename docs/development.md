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
The backend build copies TypeScript (including its standard-library declarations)
and esbuild (including the current platform's native executable) into
`dist/node_modules`. Keep these packages external to the ESM bundle: their
CommonJS loaders and adjacent runtime files must retain their original layout.
Build on the target platform; copying this output to another OS or architecture
does not replace esbuild's native executable.

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

### Message attachment previews and desktop reveal

Message file cards open the existing file preview directly through their authorized
`/api/media` URL; a file need not belong to the file tree or a registered Folder.
Text previews read at most 64 KiB; document-viewer inputs are capped at 64 MiB.
Attachment HTML is shown as source, and attachment Markdown does not load sibling
assets: a single-file media grant is not a directory/static-site grant. Downloads
remain available independently of preview support.

“Show in file explorer” on message attachments requires an attestation from a
backend launched by the current Electron host. The host creates a process-private
random key and passes it only to its Main sidecar. After the normal media
resolution/authorization succeeds, `reveal=1` returns a 60-second signed resolved
path. The existing trusted-window file-explorer IPC verifies this proof before
checking file existence and revealing it. Neither Electron detection, loopback
URLs, workdir display paths, nor matching filenames prove locality. Pure Web,
remote backends, and independently launched local backends therefore do not show
this action; they can still preview/download authorized attachments. No additional
folder registration or arbitrary-path media API is introduced.

These changes require rebuilding the app/backend/desktop and relaunching Electron
(and its owned Main sidecar). Updating only the renderer cannot establish the
host/sidecar attestation. Development or tests must not log or persist the private
`SHADOW_DESKTOP_MEDIA_KEY` environment value.

### Frontend console diagnostics (development only)

With backend `NODE_ENV=development` and a Vite development renderer, the agent can
use `read({ path: "v:runtime/frontend-logs" })` (or offset/limit paging). Read
`v:runtime` for the live guide. Production does not register ingestion or advertise
this path, and production renderers do not install hooks. Restart the dev backend
after updating backend code; reload the renderer after updating frontend code.
No automatic restart is performed by this feature.

In a development renderer, the hook is installed synchronously for an explicit
Project in the visible route, before its child components render. An authenticated
capability GET gates transmission (not capture), so initial render warnings are
buffered while it is pending. It captures `console.log`, `info`, `warn`, `error`,
`window.error` and `unhandledrejection`; not output before the scoped App setup,
DOM/user inputs or network payloads. It preserves the original console behavior.
Capability/network failures and transient POST failures (429/5xx) retry on
subsequent one-second flushes while there are queued events; queues remain bounded
and delivery is best-effort, not exactly-once. Permanent invalid POST batches are
dropped; POST 401/403/404 stops capture. Batches also respect the UTF-8 byte limit,
not just the event/character limits. Capture continues during an in-flight request.
A disabled/404 capability restores hooks without sending. Project or API-base
changes, unmount and HMR discard the local queue, abort requests and restore hooks
synchronously. An unscoped route has no capture. A client-generated tab ID is
unverified; there is no session association. Global console events are associated with the visible route, not
proven to originate in that Project (including background components).

Transport uses `credentials: 'same-origin'`, matching normal API requests: web
cookies stay on same-origin deployments, while cross-port Electron development
requests use the host-injected launch `Authorization` header. The gateway keeps
its explicit origin allowlist and does not enable cross-origin cookie credentials.
Using `include` here causes browsers to reject even HTTP 200 responses from the
dev gateway, because it intentionally omits `Access-Control-Allow-Credentials`.
The real-browser regression is `app/src/frontend-log-browser_test.ts` (isolated
Electron profile, two ephemeral loopback ports, real gateway/preflight/ingestion).

Ingestion uses existing Project gateway authentication and a Project-owned memory
ring, never a body-supplied Project ID. `POST /projects/<id>/api/runtime/frontend-logs`
accepts strict bounded batches; authenticated `DELETE` at the same path clears the
ring. It retains 200 events, accepts at most 120/minute/Project and 20/request,
with 4096 characters/event and a 96 KiB request limit. Restart/Project disposal
clears memory. No OTLP/database/history event is emitted by ingestion. As with any
agent read, a requested tool result can subsequently become part of normal agent
conversation history; this is not a secret-storage or zero-retention channel.

Objects are depth/entry bounded, cycles summarized, getters/toJSON not invoked,
and sensitive field names omitted. URLs and recognizable credentials/header/body
text are redacted both before sending and on ingestion. Arbitrary freeform logs
may still contain unlabeled secrets: avoid logging private data. Log text,
including HTML, newlines and apparent instructions, remains untrusted JSONL data;
reads do not render HTML or execute browser JavaScript. Failed diagnostic requests
are silent, are not retried, and cannot recursively log through the hook.

### Vite lazy syntax-highlighting dependencies

`app/highlighting-deps.ts` explicitly includes all literal lazy Shiki imports in
`app/src/file-highlighting.ts` in the initial dependency optimization batch. Keep
the list synchronized when adding grammars (the browser integration test checks
this). This does not eagerly load grammars into the renderer.

Every programmatic Vite test using the real app root must set a unique disposable
`cacheDir`: otherwise even a test with `noDiscovery: true, include: []` can replace
`app/node_modules/.vite/deps` metadata underneath the running development server.
Its in-memory transforms can continue referring to the old dependency hash while
the disk metadata has changed, yielding `504 Outdated Optimize Dep` even after a
browser refresh. Do not run a second Vite instance against the live cache.

After applying optimizer configuration changes, restart the Vite development
server at an operator-chosen time, then reload the renderer. A renderer reload
alone cannot repair mismatched live optimizer state. No backend restart is needed
for the optimizer change; backend diagnostic-redaction changes require restarting
the backend process. New redaction does not recover information from old events.
Development frontend logs retain only allowlisted loopback Vite optimized
Shiki/chunk module paths, not URL host/port, credentials, query or fragment. Browser
network-panel status lines are not console events and are not intercepted.

Focused regression (real Vite transforms, Electron browser dynamic imports, JSON,
TypeScript and Markdown fenced languages, followed by a fresh page load):
`pnpm exec node --import tsx --test app/src/highlighting-vite_test.ts`.
