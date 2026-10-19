# Shadow

A personal, local-first AI agent with persistent conversations, tools, memory,
skills, subagents, and messaging integrations. One Node.js backend powers the
Vue web UI and Electron desktop app. The optional iOS/Android app connects to an
existing backend.

- **Work across conversations:** organize projects, files, memory, and automations.
- **Use local tools:** run commands, work with files, and connect optional MCP services.
- **Choose your interface:** desktop, browser, mobile, or messaging channels.
- **English and 简体中文** interfaces.

Multi-device execution is **work in progress**; remote tool parity and distributed
release hardening are not complete. See [architecture](docs/architecture.md).

## Get started

Requires **Node.js 24.15+** and **pnpm 12.3.1**.

```sh
npm install --global pnpm@12.3.1
pnpm install
pnpm dev
```

Run these commands from the repository root; packages share one lockfile.
Electron setup initializes or reuses your configuration. Choose a provider and
model in the app.

> **Development uses production data by default (`~/.shadow`).** For isolated
> development, set `SHADOW_DESKTOP_DEV_MAIN_DIRECTORY` to an absolute path before
> first-time setup. Existing saved directory selections are preserved. Stop the
> production app before sharing its data directory with development.

The desktop stays in the tray when its main window closes; use **Quit** to stop it.
See [local development](docs/development.md) for isolation, restart behavior,
headless builds, and the optional aria2 download dependency.

### Headless backend

Copy `bot.config.example.json` to `bot.config.json` **only if no config exists**,
then configure your provider credentials through the environment or `.env`.

```sh
pnpm start
```

To serve the built web UI:

```sh
pnpm build:all
node --env-file-if-exists=.env dist/src/index.js
```

The example gateway serves `http://localhost:3123`. See
[browser access](docs/browser-access.md) for login and pairing.
Local configuration, `.env`, and `workspace/` are private data, not repository content.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Launch Electron development with Vite |
| `pnpm start` | Run the headless backend |
| `pnpm build:all` | Build backend and web UI |
| `pnpm typecheck` | Typecheck backend, integrations, desktop, and web app |
| `pnpm test` | Run backend, script, integration, and frontend-logic tests |
| `pnpm test:desktop` | Run desktop tests |
| `pnpm desktop` | Build a native desktop package; tests run separately |

See [`package.json`](package.json) for all commands and
[release verification](docs/release.md) for packaging requirements.

## Documentation

- [Using Shadow](docs/using-shadow.md) — projects, conversations, files, and settings
- [Messaging channels](docs/channels.md) · [Tools and automations](docs/tools-and-automations.md)
- [Mobile client](docs/mobile.md) · [Two-device pairing](docs/desktop-pairing.md)
- [Contributor guide](AGENTS.md) · [Architecture](docs/architecture.md)
- [Documentation index](docs/README.md)

## Security

Host tools run with the backend user's permissions; `restrictToWorkspace` is
**not an OS sandbox**. Keep the gateway on loopback unless you have configured
appropriate access controls. Never expose unauthenticated gateways, Vite, or
inspector ports to untrusted networks. Configured providers and integrations may
receive conversation content.
