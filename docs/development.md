# Local development

See the [quick start](../README.md#get-started) for prerequisites and installation.
Run `pnpm dev` from the repository root.

On Windows, install a Windows MSVC Rust toolchain **1.89 or newer** through
rustup, plus Visual Studio C++ Build Tools and the Windows SDK. Open a fresh
terminal after installation so the tools are on PATH. `pnpm install` prepares
the native desktop assets automatically on Windows x64/arm64:

```powershell
pnpm install --frozen-lockfile
$env:SHADOW_DESKTOP_DEV_MAIN_DIRECTORY = Join-Path (Get-Location) '.shadow-test-dev'
pnpm dev
```

The install hook verifies source and binary hashes before doing any work.
It also runs through `pnpm:devPreinstall` because pnpm can skip `postinstall`
on an otherwise up-to-date install.
Valid cached assets require no Rust/MSVC invocation or network access. Missing,
modified or stale assets use `pnpm desktop:repair-native`, which discovers MSVC
and reuses Cargo's existing dependency/build cache to build the pinned Windows
addon and input guard, including the required
`integrations/agent-desktop/artifacts/win32-x64/build-manifest.json`.
Git, a suitable Rust MSVC toolchain, the Windows SDK, and the .NET Framework 4
compiler must already be installed; the hook never installs system tools.
Initial source/dependency fetches may need network access. Offline builds work
only when the pinned upstream checkout and Cargo dependencies are already cached.

Native preparation failures warn without failing dependency installation.
Windows startup/build still rejects missing or invalid assets; after resolving
the reported prerequisite/network/build failure, rerun `pnpm install` or
`pnpm desktop:repair-native` (`-Arch arm64` for ARM64).
Non-Windows installs do not prepare these Windows-only assets. The hook uses
Node's built-in TypeScript support, not development dependencies, so production-only
installs can run it too. Set `SHADOW_SKIP_NATIVE_BUILD=1` to explicitly skip native
preparation, or use `pnpm install --ignore-scripts` to disable all lifecycle hooks.
Concurrent installers do not start a second native build. An interrupted install
can leave the Git-ignored `integrations/agent-desktop/artifacts/.postinstall-win32-<arch>.lock`;
remove that exact file only after confirming no repair is running, then retry.
See the [native backend build instructions](../integrations/agent-desktop/README.md#reproduce-windows-x64).

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

### Child UI, loopback secure context, and hot reload

In `pnpm dev`, a paired desktop Child keeps its **local Vite renderer** for setup,
recovery, and the workspace. HTML, CSS, JavaScript, and HMR come from that local
Vite server; no Main UI probe or gateway-page navigation gates development startup.
Business API requests still use the Child gateway's `apiBase`, with Electron's
main-frame launch authorization and the approved device connection to Main.
An unavailable Main shows the workspace connection error/retry state in the local
UI; it does not prevent the development renderer from loading. This recovery view
retains the desktop window controls and local role switcher even while a Main
request is pending. Switching to Main does not require Main connectivity; it uses
the existing confirmation/restart flow and preserves both role profiles. Switching
to Child still requires execution consent. A reconnect does not dismiss an active
role-switch confirmation. Main need not run
Vite for Child frontend development, but its business APIs must remain compatible.

In packaged builds (or without a local Vite renderer), Electron keeps the bundled renderer for
setup and recovery, probes Main's UI through the authenticated Child gateway,
and then loads that UI at **`http://127.0.0.1:<child-port>/`**. HTML, CSS, JavaScript,
API traffic, and Vite HMR all traverse the Child's local gateway and its approved
device connection to Main. The window does not navigate to Main's LAN address;
no Main bearer token is handed to frontend JavaScript. Local launch authorization
is attached by Electron only for the trusted main frame and exact Child authority
(including its `ws:` HMR counterpart), not embedded frames or another port.
Failed UI probes retain local recovery; failed remote document loads return to it.
A remote page must reach the desktop bootstrap handshake within 20 seconds; an
HTML-200 page with broken entry scripts returns to local recovery too. Retry is
explicit after such a failure, rather than looping between renderers.
Revoking the device also terminates its active HMR connection.

For local development hot reload, run `pnpm dev` on the Child. Packaged Child instances
can instead follow Main's Vite resources when Main runs `pnpm dev`. Vite binds to
`127.0.0.1` by default, including the development launcher. Do not expose its
unauthenticated port on the LAN: use the approved Main device endpoint instead.
An explicit `VITE_DEV_HOST` override is still possible but is not needed for
Child access. Proxied `/@vite/client` uses the renderer's own loopback port and
does not fall back to a direct Vite-server socket. Vite's filesystem deny list
also excludes local bot configuration and runtime `workspace/` trees.

The role's `logs/startup.jsonl` distinguishes local runtime `ready` from
`renderer-ready`. Packaged renderer diagnostics also record probe HTTP status,
navigation, handshake timeouts, and failed resource types/statuses. These records
contain no request URLs, response bodies, credentials, or arbitrary error messages.

HTTP loopback is a potentially trustworthy origin in Chromium, so the Child
retains a secure context without deploying a LAN HTTPS certificate for its
renderer. This fixes the *origin prerequisite*, not every permission or device
requirement: microphone/camera/screen APIs still depend on Electron's media
permission policy, OS permissions and available devices; clipboard writes may
require focus/user activation. The frontend checks secure-context/media support
in `app/src/io/adapters.ts` and `audio-input.ts`; notifications also check
`isSecureContext`. No `webSecurity` disablement or insecure-origin override is used.
Opening Main's LAN HTTP URL directly in a browser is different and does not gain
loopback secure-context privileges.

Main/Child transport policy is unchanged: non-loopback HTTP still requires the
existing explicit `allowInsecureLocalTransport` opt-in; otherwise use HTTPS.
Loopback rendering does **not** encrypt or relax the device transport. Automated
tests cover remote resource bytes, loopback-only navigation/credential policy,
authenticated bidirectional HMR text/binary traffic, and trust revocation using
multiple local ports. They do not certify real two-device LAN networking,
packaged Electron/OS media permissions, clipboard activation, or a physical
microphone/camera/screen session; verify those on the target devices.

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

With backend `NODE_ENV=development`, the agent can
use `read({ path: "v:runtime/frontend-logs" })` (or offset/limit paging). Read
`v:runtime` for the live guide. Production does not register ingestion or advertise
this path. All renderer builds discover the authenticated Project capability; a
production-built renderer (including Main-served assets loaded by a Windows Child)
installs no console/network hooks until Main returns `enabled: true`. Production
Main returns 404, so production defaults still do not collect. Capability failure
retries every five seconds without hooks in a built renderer; 404 or explicit
disabled stops polling until a new scope/reload. Restart the dev backend
after updating backend code; reload the renderer after updating frontend code.
No automatic restart is performed by this feature.

In a development renderer, the hook is installed synchronously for an explicit
Project in the visible route, before its child components render. An authenticated
capability GET gates transmission (not capture), so initial render warnings are
buffered while it is pending. It captures `console.log`, `info`, `warn`, `error`,
`window.error` (including capture-phase resource load errors) and
`unhandledrejection`; not output before the scoped App setup or DOM/user inputs.
Error summaries use a `detail` field so the backend's conservative payload-key
redaction does not discard an ordinary `Error.message`. Sensitive text is still
redacted. It preserves the original console behavior.
Capability/network failures and transient POST failures (429/5xx) retry on
subsequent one-second flushes while there are queued events; queues remain bounded
and delivery is best-effort, not exactly-once. Permanent invalid POST batches are
dropped; POST 401/403 retries (temporary authentication loss), while 404 stops capture. Batches also respect the UTF-8 byte limit,
not just the event/character limits. Capture continues during an in-flight request.
A disabled/404 capability restores hooks without sending. Project or API-base
changes, unmount and HMR discard the local queue, abort requests and restore hooks
synchronously. An unscoped route has no capture. A client-generated tab ID is
unverified; coarse `client.platform` and `client.renderer` labels are also
unverified diagnostic hints, never authorization. There is no session association. Global console events are associated with the visible route, not
proven to originate in that Project (including background components).

Transport uses `credentials: 'same-origin'`, matching normal API requests: web
cookies stay on same-origin deployments, while cross-port Electron development
requests use the host-injected launch `Authorization` header. The gateway keeps
its explicit origin allowlist and does not enable cross-origin cookie credentials.
Using `include` here causes browsers to reject even HTTP 200 responses from the
dev gateway, because it intentionally omits `Access-Control-Allow-Credentials`.
The real-browser regression is `app/src/frontend-log-browser_test.ts` (isolated
Electron profile, two ephemeral loopback ports, production-built collector,
Child admission/CORS, signed device challenge tunnel and distinct Main Project ring).
This exercises the cross-device protocol on one test host, not the user's live
Windows renderer or physical Windows→Mac network.

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
reads do not render HTML or execute browser JavaScript. Diagnostic requests are
silent and excluded from network capture, including their retries.

This is **not a complete or verbatim DevTools Console mirror**. While scoped,
fetch failures/HTTP errors and EventSource errors are also captured as fixed
endpoint metadata for `live`, `projects`, `service-groups`, `agent-types`,
`work/history`, and `background-tasks`. Only the API origin and either the visible
Project prefix or host endpoints qualify; another Project's requests are excluded.
No query, arbitrary path segments, headers or request/response bodies are collected.
Fetch returns the original response and rejection; intentional aborts are quiet.
The `/api/live` EventSource error covers stream interruptions after connection,
including the failure category behind `ERR_INCOMPLETE_CHUNKED_ENCODING`, but the
web API exposes neither that Chromium code nor the HTTP status. A fetch body
read failing after headers is **not** intercepted; a subsequent application
console/error/rejection is captured normally. Resource errors have no native
status. XHR, pre-hook requests, other origins and non-allowlisted endpoints are
not network-instrumented.

Electron currently has child-renderer recovery hooks (`desktop/src/main.ts`) for
`did-fail-load` and loopback `webRequest` failures. They write role-scoped startup
diagnostics, not Project frontend rings, exclude local Main renderer requests,
and do not provide a general Console/Project attribution bridge. There is no
existing production `console-message`/CDP-to-frontend-log pipeline to reuse. A
true native Console mirror would require a separately designed privileged
Electron/CDP collector and explicit Project/lifecycle/redaction controls; this
feature does not attach a debugger, open profiles or broaden gateway access.

For empty output, check the active visible Project and renderer/backend version
first. `/` and legacy `/chat` redirect to explicit `default` Project routes (covered
by routing/collector regression tests), so they are not inherently unscoped. The
Project list `/projects` and host Settings remain intentionally unscoped. An empty
ring alone cannot distinguish no events, an old renderer, disabled/404 capability,
a failed transport or a different Project; inspect DevTools request status without
copying private headers. Existing Console entries are never replayed retroactively.

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

### Markdown fenced-code highlighting

Chat answers, system prompts, knowledge entries, outcome details and Markdown file
previews share `markdown-highlight.ts` (a synchronous marked extension). It lazily
uses the same Shiki core, GitHub themes and supported grammar loaders as file/diff
highlighting in `file-highlighting.ts`. Grammar completion invalidates reactive
Markdown consumers; streaming does not initialize a highlighter per token. Explicit
language aliases are supported; unlabelled, text/ASCII, unsupported, failed-load and
oversized (over 20,000 characters) fences remain escaped plain code. Tokenization
has the same per-line/time limits as file highlighting and caches at most 64 blocks.

Generated spans use the static GitHub palette in `markdown-highlight.css`, with
`.dark` overrides, rather than inline styles. Existing DOMPurify passes remain in
place (including the file preview's style prohibition), and code text remains
available for selection and copying. If updating Shiki themes, regenerate/review
the palette against both themes' foreground colors. Focused regression:
`pnpm exec node --import tsx --test app/src/markdown-highlight_test.ts app/src/file-highlighting_test.ts app/src/file-selection_test.ts`.

### Provider rejection diagnostics

Non-success inference HTTP responses (OpenAI-compatible chat, Responses, and
Anthropic, including Copilot inference) emit `[provider.http.failure]` through
the backend console warning sink. Copilot authentication HTTP rejections use the
same event with provider `copilot-auth` and model `authentication` (no model is
involved yet). Fields are `provider`, `model`, HTTP `status`, an allowlisted
machine `code` (otherwise `unrecognized`), and an optional validated hex/UUID
`requestId` from a supported response header. Unknown request-ID formats are
omitted. Configured identifiers that resemble URLs or known credential prefixes
are omitted. No endpoint, headers, credentials, response message/body or request
context is logged. Error bodies are read only up to 16 KiB for structured code
extraction, then discarded; malformed or oversized bodies retain status only.
This deliberately cannot diagnose every vendor-specific error message. Correlate
status and the safe request ID with provider support rather than enabling raw
request/body logging. Rate-limit retries may produce more than one event.

Recovery UI distinguishes missing credentials, expired authorization, failed
credential verification (HTTP 401), and denied access (HTTP 403 / Copilot scope
or access denial). Access denial calls for checking model entitlement, license,
SSO, host and organization policy, not mandatory reauthentication. Legacy
`authentication` recovery records remain valid; both JSONL and SQLite keep the
same recovery metadata shape.

## Observing chat history network traffic

The chat view uses an explicit, memory-only snapshot protocol for
`GET /api/chat/session?snapshot=...`. The first request returns a revision and
the history/context data. Subsequent requests send that revision; unchanged
responses contain only `{ revision, unchanged: true }` (HTTP 200), not history.
Every read still validates against Main, including access and session existence.
Changes to history, context, tools, decisions, receipts or segment navigation
produce a new revision and full response. Network/access errors never serve a
cached snapshot as a successful read.

Snapshots are scoped to the live-client pool and full request URL (including
Project and chat), capped at eight entries and 16 MiB per pool, and cleared on
pool disposal. No localStorage, IndexedDB, service-worker or browser HTTP cache
is used. `Cache-Control: no-store` remains in effect; DevTools **Disable cache**
does not disable this memory-only optimization. In HAR, look for a `snapshot`
query parameter and a small unchanged JSON response, not HTTP 304. Legacy
clients without the query parameter retain the ETag conditional-read interface.
This saves transfer bytes, not server-side history assembly work, and does not
eliminate the validation GET.

## Shared resources during conversation navigation

Project configuration snapshots belong to the live-client pool, not individual
conversation components. Successful runtime config activation emits a `config`
resource invalidation; saves and reconnects also invalidate the shared snapshot.
Concurrent model-catalog reads are coalesced, but completed catalogs are not
cached because external provider credentials have no complete notification source.
Audio status is a pool/Project-scoped capability hint, shared across conversation
mounts and visibility changes. Config invalidations and live recovery refresh it;
opening audio settings or explicitly refreshing also rechecks external files.
Actual capture/transcription still use authoritative backend endpoints and do not
treat this hint as a recording grant. Session/draft changes still cancel capture.

Credential-request metadata is shared per Project; Bot setup invitations are
shared per session URL. Both reuse the existing interactions invalidation stream
and idle-cache cleanup. Secret input and all approval writes remain local to the
owning view. A healthy empty result need not be fetched on every chat switch.
I/O discovery retains Main's bounded Project inventory and filters by the visible
session, instead of re-fetching that inventory on every session change. Capture
consent, lease heartbeats, failure handling and disconnected polling are unchanged.

The fixed-topic SSE protocol still reconnects for new chat topics. To avoid
reconnects when returning to recently visited chats, the client retains at most
four previously connected chat topics in a single non-extending, at-most-30-second
cleanup window; active topics take priority over these warm topics in the protocol
budget. The window expires all idle topics together, avoiding staggered expiry
reconnections. Real disconnect/retry discards warm topics before reconnecting. Closed observers receive no
messages, and returning observers still take an authoritative snapshot. Project
exit, disposal and failures clean up warm topics. This is bounded subscription
reuse, not Project-wide chat-body broadcasting or a dynamic subscription protocol.

Session invalidations can carry optional `changes` hints. Ordinary history
persistence does not invalidate Work, background-task or scheduled-task views;
completed turns still reconcile Work, and genuine task notifications refresh
background inventory. Missing-session recovery remains conservative. Legacy or
unknown hints retain broad invalidation behavior. Scheduled-task views listen to
`automations` resource changes and use periodic reads only when live updates are
disconnected, not while the connection is healthy.

Session graph revisions do not imply catalog changes. Folder catalog commits
publish Project-scoped `folders` invalidations after successful persistence;
node connection/registry transitions publish `nodes` invalidations. These readers
are independent, so folder changes do not reload device inventory. Bot/config
updates publish `channels` invalidations. Initial reads, manual retries and live
recovery remain available. Channel-manager spontaneous connection transitions do
not yet have a complete notification source; silently changed channel connection
status may require manual refresh or live recovery rather than being real-time.
