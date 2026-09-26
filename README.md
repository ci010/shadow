# Shadow

Shadow is a personal, local-first LLM agent with persistent conversations,
tools, memory, skills, subagents, messaging integrations, and a Vue web UI.
One Node.js backend runs the agent; Electron can host it as a desktop app.
The Capacitor iOS/Android app is a client of an existing backend, not a
backend or execution node.

**Multi-device infrastructure is work in progress.** Pairing and some remote
execution paths exist, but remote tool parity and distributed release
hardening are unfinished. See the [architecture reference](docs/architecture.md)
for implemented boundaries.

## Get started

Use **Node.js 24.15+** and **pnpm 12.3.1**, as pinned in
[`package.json`](package.json). Install from the repository root:

```sh
npm install --global pnpm@12.3.1
pnpm install
```

Copy `bot.config.example.json` to `bot.config.json` if you do not already have
a configuration, choose a provider/model, and set its credentials in `.env` or
the environment (for example `OPENAI_API_KEY`). The example enables web chat
and SQLite sessions. **Do not overwrite an existing config or workspace**;
`bot.config.json`, `.env`, and runtime `workspace/` are private local data.
The root, `app`, and `desktop` share one lockfile; do not install separately
inside those packages.

```sh
pnpm dev
```

Open `http://localhost:5273`. This starts the backend and Vite; for separate
processes use `pnpm dev:server` and `pnpm dev:app`. `pnpm start` runs the
backend without a development watcher; an optional argument selects another
bot config: `pnpm start path-to-bot-config.json`.

For a production web build:

```sh
pnpm build:all
node --env-file-if-exists=.env dist/src/index.js
```

The backend build emits `dist/src`; the web build emits `app/dist`. The
gateway serves the built UI on `http://localhost:3123` when present.
Keep the build outputs and installed runtime dependencies together when
deploying headlessly.

## Other ways to run

| Client | Start here |
| --- | --- |
| Electron desktop | `pnpm desktop:dev` for development; `pnpm desktop` builds and verifies a native package on a supported host. See [release verification](docs/release.md) and [two-device pairing](docs/desktop-pairing.md). |
| Browser without Electron | Run the backend independently and follow [browser access and installation](docs/browser-access.md) for PIN/pairing login and PWA limitations. |
| iOS and Android | Use the [mobile client guide](docs/mobile.md) for the separate HTTPS endpoint and [native build instructions](mobile/README.md) for platform builds and signing. |

The gateway defaults to loopback. Do not expose an unauthenticated gateway,
development Vite, inspector, or Docker/Xpra ports to untrusted networks.
`restrictToWorkspace` is not an OS sandbox; host tools run with the backend
user's permissions.

## Projects

Projects own separate Homes, conversations, settings, bots, and memory;
provider credentials and devices are App-wide. Folder/Repository entries
are file resources within a Project, not separate Projects. For navigation,
conversation continuity, files, and answering agent questions, see
[using Shadow](docs/using-shadow.md). For storage, ownership, and remote
folder boundaries, see the
[architecture reference](docs/architecture.md#projects-ownership-storage-and-routing).

## Development commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` / `pnpm start` | Develop with Vite and a watcher / run the backend without watch mode |
| `pnpm build:all` | Build the backend and web UI |
| `pnpm typecheck` | Typecheck backend, scripts, integrations, desktop, and Vue app |
| `pnpm test` / `pnpm test:desktop` | Run backend/frontend-logic tests / desktop tests |
| `pnpm desktop:dev` / `pnpm desktop` | Develop Electron / build and verify a native package |

For a focused test, run
`pnpm exec node --import tsx --test src/sessions/locality_test.ts`.
Consult [`package.json`](package.json) for the complete command list and
[AGENTS.md](AGENTS.md) for contributor conventions.

## Documentation

Start with the [documentation index](docs/README.md) for current references
versus historical designs. Operational guides cover
[browser access](docs/browser-access.md), [using Shadow](docs/using-shadow.md),
[messaging channels](docs/channels.md),
[tools and automations](docs/tools-and-automations.md), and
[session diagnosis](docs/diagnostics.md). The
[frontend I/O guide](docs/io.md) covers browser capture panels and
agent-started services; [A2A integration](docs/a2a.md) is opt-in.
