# Shadow

Shadow is a personal, local-first LLM agent with persistent conversations,
tools, memory, skills, subagents, messaging integrations, and a Vue web UI.
One Node.js backend runs the agent; Electron can host it as a desktop app.
The desktop owns its Main or Child backend in an Electron utility process.
Closing its main window keeps Shadow running in the tray; use the tray's Quit
action to stop it. Reopening the same desktop profile restores the existing app.
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

The root, `app`, and `desktop` share one lockfile; do not install separately
inside those packages. Electron setup initializes or reuses the Main configuration;
choose the provider/model in the app. Credentials may also be supplied in `.env`
or the environment (for example `OPENAI_API_KEY`). **Do not overwrite existing
configuration or workspace data.**

For the optional headless `pnpm start` path, copy `bot.config.example.json` to
`bot.config.json` only if no config exists. That example enables web chat and
SQLite sessions; `bot.config.json`, `.env`, and `workspace/` are private local data.

```sh
pnpm dev
```

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
packaging; see [aria2 build instructions](desktop/aria2/BUILD.md).
For local Windows dogfooding, `pnpm desktop:prepare-aria2` prepares missing source,
licenses and build instructions automatically, and downloads the checksum-verified
upstream binary when absent. It still validates the complete aria2 package.

After changing the executable path or rebuilding backend code, restart the
backend and use `download` with `action: "status"` to verify availability.
The rest of Shadow can run without aria2; only new downloads require it.

## Other ways to run

| Client | Start here |
| --- | --- |
| Electron desktop | `pnpm dev` for development; `pnpm desktop` builds a native package on a supported host. Tests run separately. See [release verification](docs/release.md) and [two-device pairing](docs/desktop-pairing.md). |
| Browser without Electron | Run the backend independently and follow [browser access and installation](docs/browser-access.md) for PIN/pairing login and PWA limitations. |
| iOS and Android | Use the [mobile client guide](docs/mobile.md) for the separate HTTPS endpoint and [native build instructions](mobile/README.md) for platform builds and signing. |

The gateway defaults to loopback. Do not expose an unauthenticated gateway,
development Vite or inspector ports to untrusted networks.
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
| `pnpm dev` / `pnpm start` | Launch Electron development with Vite / run the headless backend |
| `pnpm build:all` | Build the backend and web UI |
| `pnpm typecheck` | Typecheck backend, scripts, integrations, desktop, and Vue app |
| `pnpm test` / `pnpm test:desktop` | Run backend/frontend-logic tests / desktop tests |
| `pnpm desktop` | Build a native package without tests |
| `pnpm desktop:prepare-aria2` | Prepare local Windows aria2 binary, source and license materials |
| `pnpm desktop:build` | Build and package locally without typechecks or test suites |
| `pnpm desktop:install` | Install the existing package for the current Windows x64 user; quit Shadow first. See [local installation](docs/release.md#install-a-local-windows-build) |
| `pnpm release` | Build current source natively over SSH and deploy to your Mac; see [internal releases](docs/release.md#internal-mac-dogfood-releases) |

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

## Frontend localization

The browser, Electron renderer, and mobile client support English and Simplified
Chinese. Use the language selector in the window header, mobile navigation, or
**App settings > Language**. It is also available before login and during desktop
setup. See [language preferences](docs/using-shadow.md#language) for storage and
system-language behavior.

Frontend copy uses Vue I18n through the typed `t()` helper in
`app/src/i18n.ts`. Add the same literal English source key to
`app/src/locales/en.json` and `app/src/locales/zh-CN.json`, then call `t()` from
rendering, a computed value, or a metadata getter so language changes remain
reactive. Do not eagerly translate module constants or default props.

Translate complete messages with named placeholders rather than concatenating
words or adding English plural suffixes. For example,
`t('{count} agents', { count }, count)` uses the English catalog value
`{count} agent | {count} agents` and the Chinese value `{count} 个智能体`.
Vue I18n reserves `@`, braces, and `|`; use its literal interpolation syntax for
literal special characters, such as `{'@'}`, and reserve unescaped `|` for plurals.
Use `formatNumber()` / `formatDateTime()` for presentation and `enumLabel()` only
for known display enums. Never translate protocol values, paths, IDs, prompts,
user-authored text, tool arguments/results, or server-provided content.

The existing frontend test runner includes catalog, locale persistence,
reactivity, and rendered desktop/mobile checks in `app/src/i18n*_test.ts`.
