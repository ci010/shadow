# Shadow

Shadow is a personal LLM agent with persistent sessions, tools, memory, reusable
skills, subagents, messaging integrations, and a Vue web UI. It runs on **Node.js**
and can be hosted inside an **Electron** desktop application.

**Multi-device infrastructure is work in progress.** Main/Child runtime roles,
pairing, execution capabilities, and product UI scaffolding exist, but they do
not imply a production-ready distributed system.

## Documentation

| Document | Purpose |
| --- | --- |
| [Architecture and features](docs/architecture.md) | Global view of the agent, key design, execution flow, and implementation status |
| [Contributor instructions](AGENTS.md) | Repository guidance for coding agents and contributors |
| [Documentation index](docs/README.md) | Current references versus historical designs |
| [Distributed desktop workstreams](docs/implementation/README.md) | WIP multi-device contracts and implementation plans |

## Requirements

Use **Node.js 24.15 or newer** and **pnpm 12.3.1** (pinned in `packageManager`
for availability on the configured Microsoft npm proxy). Deno is not needed to
develop, build, or run Shadow.

```sh
npm install --global pnpm@12.3.1
pnpm install
```

All three packages use the root `pnpm-lock.yaml`. Do not run `npm install` inside
`app` or `desktop`. Dependencies are installed with pnpm's explicit build-script
allowlist in `pnpm-workspace.yaml`.

The project `.npmrc` uses `https://packagefeedproxy.microsoft.io/npm/`.
The pnpm hook keeps package tarball downloads on that proxy even when registry
metadata advertises an upstream feed URL. Missing mirror versions are pinned to
the nearest available stable releases in the manifests and workspace overrides.

## Local development

Copy `bot.config.example.json` to `bot.config.json`, choose your provider/model,
and supply its credentials in `.env`, for example:

```dotenv
OPENAI_API_KEY=your-api-key
```

The example enables web chat and SQLite sessions. `bot.config.json`, `.env`, and
the runtime `workspace` directory are local data, not distributable application
assets. Do not overwrite an existing configuration or workspace.

```sh
pnpm dev
```

This starts the Node backend with watch/inspector support and Vite. Open
`http://localhost:5273`. Vite proxies API requests to the gateway on port `3123`.
For independent processes, use `pnpm dev:server` and `pnpm dev:app`.

`pnpm start` runs the backend without watch mode. It loads `.env` if present;
an optional positional argument selects another bot config:

```sh
pnpm start path-to-bot-config.json
```

Common settings are defined by `src/config/schema.ts`; environment overrides
are in `src/config/loader.ts`. Provider selection is model-based and can be made
explicit with `model@provider`. External channels and services need their own
credentials and setup.

## Build and run

```sh
pnpm build:all
node --env-file-if-exists=.env dist/src/index.js
```

The backend build emits Node ESM modules and their runtime assets in `dist/src`,
preserving module-relative paths rather than bundling the backend. Vite emits
`app/dist`. The gateway serves that UI alongside its APIs on
`http://localhost:3123` when the frontend build is present. Keep both output
directories and installed runtime dependencies together when deploying headlessly.

## Electron

```sh
pnpm desktop:dev
pnpm desktop
```

The development command builds the backend and Electron main/preload, starts
Vite, and launches Electron. The packaging command additionally builds the
production UI and creates a Windows NSIS installer in `desktop/release`.

Desktop development uses a separate profile at `.tmp/desktop-dev/user-data` in
the worktree, rather than the installed application's profile. An absolute
`SHADOW_DESKTOP_USER_DATA` path can override it. In packaged applications, the
Main directory defaults to the OS home directory's `.shadow` folder (shown as
an expanded path); it can be edited or selected with Browse. Existing saved
Main directories are preserved. Development instead defaults Main to
`.tmp/desktop-dev/data` to avoid using personal data during smoke tests. The
absolute `SHADOW_DESKTOP_DEV_MAIN_DIRECTORY` override applies only to development.

After Main starts, an unconfigured provider opens **Connect a model provider**
instead of an unusable chat. Choose **GitHub Copilot** for device-code login, or
**API key / local provider** for a provider key or keyless OpenAI-compatible
endpoint. The device code must be approved by the user on
`https://github.com/login/device`; the UI supports cancellation and retry.
The **Providers** navigation tab remains available to change providers or recover from
rejected credentials. Readiness follows the selected provider, not just the
presence of an OpenAI key.

Copilot requests follow each model's advertised `supported_endpoints`. Models
that support chat completions retain that protocol; Responses-only models use
`/responses` with converted history and tool calls. Endpoint capabilities are
cached alongside model names. Legacy metadata without capabilities retains
chat-completions compatibility with a warning; explicit unsupported protocols
fail without switching models or retrying a rejected request against another API.
Responses history preserves ordered output and encrypted reasoning separately
from displayed text, including tool-call IDs and assistant phases. JSONL and
SQLite retain this provider/model-scoped continuation across restarts; older
messages remain compatible. Streaming failures and incomplete responses are
reported as errors instead of committing partial tool calls.
Clients of Shadow's compatible chat API can preserve this continuation by
round-tripping the assistant message's optional `provider_state` field unchanged.

The backend saves provider settings in the selected Main directory's
`config/bot.config.json`. Copilot credentials remain in the desktop profile's
`auth/copilot` directory, not renderer storage or the repository configuration.
The same backend applies the saved settings without a separate UI-only config.
The desktop window uses a custom, draggable title bar with minimize,
maximize/restore, and close controls; it has no native application menu.
Navigation (including Providers) and window controls share one Shadow header.
Projects dock to the left edge; the session list and chat history scroll
independently while the composer stays visible. Narrow browser windows expose
Projects through a toggle. The model selector lives in the chat composer's
toolbar and retains the existing global model-selection behavior; it is also
available on the Providers tab from other views. Returning from Providers
restores the existing chat and unsent draft; leaving settings cancels any pending
device login. First-run credential checks still gate unavailable chat access.

The Projects header's **+** menu contains exactly **Open folder**, **Clone repo**,
and **Start from scratch**. Open folder registers an existing directory using
Electron's native folder picker (the browser accepts an explicit Main-local path).
Registered folders remain visible when empty. Each folder's own **+** creates a
conversation whose filesystem tools and shell use that folder as their working
directory. Collapse a folder to hide its conversations.

Folder registrations persist in `<workspace>/projects.v1.json`; session
associations persist in the selected JSONL or SQLite store.
Reopening the same canonical folder reuses its project; existing unassociated
conversations remain under **Chats**. Start from scratch retains the managed
session-directory behavior and does not use the OS home directory. Session
history and uploaded attachments remain in Main's private session data, separate
from the selected project's working directory. This folder registry is distinct
from the agent `project` tool's named planning documents.
Upload API callers should preserve the returned `path` unchanged: new uploads
return absolute private-file references, while relative media paths refer to the
session's actual working directory.
An existing `restrictToWorkspace=true` policy still prevents the write tool from
writing outside Main; opening a project does not silently disable that policy.

Clone repo accepts a repository URL and a new child directory inside a selected
existing parent. Git runs on Main without a shell command string or new OAuth
flow, using the machine's existing noninteractive authentication. The UI supports
progress, errors, cancellation, and retry. A destination that already exists is
never overwritten; failed or cancelled clones keep partial files for inspection.
Only successful clones become projects. If registration fails after cloning,
recover the checkout with Open folder rather than cloning over it.
Accepted transports are credential-free HTTPS, SSH Git URLs, and local `file:`
URLs. Passwords, queries, fragments, and Git remote-helper command syntax are
rejected. Remote cloning requires Git and suitable existing credentials or SSH
configuration on Main.

The optional layout regression uses the built renderer in hidden Electron
windows with synthetic APIs and disposable project-local profiles. It does not
connect to a running Main or use saved credentials:

```sh
pnpm build:app
pnpm exec node --import tsx --test desktop/tests/layout.node-test.ts
```

Packaging uses `pnpm deploy --prod --node-linker hoisted` to include a portable
backend without development-tree symlinks; only built modules, runtime dependencies,
and assets are copied, never the local workspace
or credentials. Electron runs the backend module in a separate process using its own Node runtime
(`ELECTRON_RUN_AS_NODE=1`), not a Deno-compiled executable. The renderer is
sandboxed with Node integration disabled; a narrow preload bridge handles setup,
and the main process owns backend startup, authorization, and shutdown. The
distributed setup/Child flows remain WIP.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Backend and Vite together |
| `pnpm start` | Backend without watch or inspector |
| `pnpm build` / `pnpm build:app` | Backend / web build |
| `pnpm build:all` | Both production builds |
| `pnpm test` | Backend, script, and frontend logic tests using Node's test runner |
| `pnpm test:desktop` | Electron lifecycle and bootstrap tests |
| `pnpm test:packaged` | Exercise a built Windows package after relocating it outside the repository |
| `pnpm typecheck` | Backend/scripts and desktop TypeScript checks |
| `pnpm desktop:dev` / `pnpm desktop` | Desktop development / Windows installer |
| `pnpm migrate:sessions <directory>` | Explicit JSONL-to-SQLite history migration; retains source files |
| `pnpm dev:searxng` | Optional SearXNG service |
| `pnpm dev:docker:compose` | Development container with Chrome/Xpra and SearXNG |

Tests support targeted execution with
`pnpm exec node --import tsx --test src/runtime/backend-cli_test.ts`.
Use `pnpm test:update` only when snapshot changes are intentional.

## Existing cron jobs

The Node scheduler uses standard cron weekdays: `0` (or `7`) is Sunday,
`1` is Monday, and names such as `SUN` and `MON` are supported. Deno used
`1` for Sunday, so old expressions must not be reused without review.

Cron storage now has the shape `{ "version": 1, "jobs": [...] }`. Startup
rejects the old unversioned array in `<workspace>/.cron/jobs.json` without
executing or overwriting it. Before upgrading an existing workspace, move that
file to a backup, then recreate the schedules with the cron tool after confirming
their weekdays and timezone. Do not simply wrap the old array in the new format.
There is no automatic conversion or Deno scheduling compatibility layer.

## Gateway and trust boundary

| Path | Purpose |
| --- | --- |
| `/api/*` | Configuration, sessions, providers, web chat, and runtime APIs |
| `/v1/traces`, `/v1/logs`, `/v1/metrics` | OTLP/HTTP JSON ingest |
| `/v1/query/*` | Stored telemetry queries |
| `/v1/stream/{spans,logs}` | Live telemetry over SSE |
| `/*` | Production SPA, when installed |

The normal gateway binds to loopback by default (`GATEWAY_HOST`,
`GATEWAY_PORT`). Treat Shadow as a trusted local agent: it can launch commands,
access files, and communicate with configured providers and MCP processes.
Workspace restrictions are not an OS sandbox.

Docker Compose explicitly binds the gateway to `0.0.0.0` and publishes gateway,
inspector, and Xpra ports for development. Do not expose that stack directly to
an untrusted network. The WIP device protocol is not a substitute for deployment
hardening.

## Repository layout

| Directory | Responsibility |
| --- | --- |
| `src` | Agent backend, providers, tools, sessions, channels, gateway, runtime |
| `app` | Vue 3 + Vite renderer |
| `desktop` | Electron main process, preload, setup, and backend supervision |
| `scripts` | Development, packaging, pairing, and data migration commands |
| `docs` | Architecture reference and WIP design workstreams |
| `workspace` | User-owned runtime state, memory, skills, sessions, and files |
