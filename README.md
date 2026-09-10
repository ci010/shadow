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

Use **Node.js 24.15 or newer** and **pnpm 12.3.4** (the latest pnpm release when
this migration was made, pinned in `packageManager`). Deno is not needed to
develop, build, or run Shadow.

```sh
npm install --global pnpm@12.3.4
pnpm install
```

All three packages use the root `pnpm-lock.yaml`. Do not run `npm install` inside
`app` or `desktop`. Dependencies are installed with pnpm's explicit build-script
allowlist in `pnpm-workspace.yaml`.

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
