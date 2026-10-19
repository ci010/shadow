# Contributor guide

This file is for contributors and coding agents working on the **Shadow
repository**. It is not a system prompt for a running Shadow agent. Runtime agent
definitions are the singular `AGENT.md` files under
`src/agent/types/builtin/<type>/`, with user overrides under the configured
workspace's `agents/<type>/`.

## Start here

- [README](README.md): installation, commands, and local operation.
- [Architecture](docs/architecture.md): source-backed global view and limitations.
- [Documentation index](docs/README.md): user and developer references.
- [Local development](docs/development.md): data isolation, restart, and optional tools.
- [Localization](docs/localization.md): frontend translation conventions.

Shadow is a personal, local-first LLM agent. One Node backend owns sessions,
providers, tools, memory, channels, events, and persistence. Vue communicates with
that backend through HTTP/SSE. Electron hosts the same backend in a child process;
it must not become a second implementation of agent business logic.

Multi-device code exists under `src/cluster`, `src/execution`, and `src/runtime`,
but remote workdir/tool parity, live product UI, operational recovery, and release
hardening are unfinished. Do not infer product readiness from a type, fixture,
passing unit test, or old workstream status.

## Toolchain and commands

Use **Node.js 24.15+** and **pnpm 12.3.1**, as pinned in root `package.json`.
Install from the repository root with `pnpm install`; the root, `app`, and
`desktop` share `pnpm-lock.yaml` and `pnpm-workspace.yaml`.

The runtime is directly Node-based. Use `node:` APIs, normal npm dependencies, and
the existing TypeScript/build setup. Do not introduce a Deno global, Deno runtime
dependency, JSR import scheme, or a compatibility shim to emulate Deno.

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Build and launch Electron with Vite; Main data defaults to production `~/.shadow` |
| `pnpm start` | Backend without development watcher |
| `pnpm build` / `pnpm build:app` | Build backend ESM / production web assets |
| `pnpm build:all` | Build both |
| `pnpm test` | Existing backend, script, and frontend-logic tests using Node with `tsx` |
| `pnpm test:desktop` | Electron lifecycle/bootstrap tests |
| `pnpm test:release` | Focused build, package, service-mode and Electron release checks |
| `pnpm typecheck` | Backend/scripts, desktop and Vue application typechecks |
| `pnpm desktop` | Validate, build and verify the native Windows x64, macOS x64/arm64 or Linux x64 package |

For a focused test, use, for example:

```sh
pnpm exec node --import tsx --test src/sessions/locality_test.ts
```

Use existing runners and nearby tests. Backend/renderer logic tests generally use
`*_test.ts`; Electron tests use `*.node-test.ts`. Update snapshots only when the
behavior change is intentional. A frontend build is not a replacement for
typechecking or behavior tests. Documentation-only changes need a link/source
review, not the full test suite. Consult the scripts before claiming that a
particular command covers all packages.

## Navigation and ownership

| Area | Main entry points |
| --- | --- |
| Composition and CLI | `src/index.ts`, `src/runtime/`, `src/runtime/main/` |
| Message routing and session loop | `src/agent/app.ts`, `src/sessions/` |
| Context, identity, memory | `src/agent/context/`, `src/agent/memory.ts`, `src/sessions/handoff/`, `src/agent/learning/` |
| Projects, folders, and initiatives | `src/projects/` owns runtime/data boundaries; `src/folders/` owns file resources; `src/initiatives/` owns coordinated work |
| Provider implementations | `src/providers/` |
| Tool contracts and implementations | `src/tools/context.ts`, `src/tools/`, `src/script-runtime/`, `src/tools/hooks/` |
| Skills and runtime agent definitions | `src/skills/`, `src/agent/types/` |
| MCP | `src/mcp/`, `src/tools/load-tool.ts`, `src/tools/invoke-tool.ts` |
| Events, background work, schedules | `src/bus/`, `src/events/`, `src/cron/`, `src/agent/background-task.ts` |
| Gateway, channels, telemetry | `src/gateway/`, `src/channels/`, `src/otel/`, `src/voice/` |
| Slash commands and shell commands | `src/slash-commands/`, `src/tools/shell-commands/` |
| Local capabilities and browser lifecycle | `src/execution/git/`, `src/execution/filesystem/`, `src/execution/processes/`, `src/browser/` |
| WIP device execution | `src/cluster/`, `src/execution/`, `src/sessions/locality.ts` |
| Browser application | `app/src/` |
| Electron host and preload | `desktop/src/` |
| Development/build/migration | `scripts/`, `build.ts`, package manifests |

Before editing, inspect the worktree and preserve existing edits. Coordinate
changes to shared composition files such as `src/index.ts`, configuration
schemas, session contracts, gateway routing, and package manifests.

## Architectural rules

- Keep backend code independent of Electron and Vue. Share small, validated
  contracts instead of importing backend services into the renderer.
- Keep Main composition under `src/runtime/main/`; `src/index.ts` is the stable
  process entrypoint. Execution capabilities must not import HTTP gateway code.
  Project scopes belong to `src/projects/`, with telemetry context
  integration under `src/otel/`. Slash-command handlers adapt learning services,
  rather than owning pipelines or persistence. Keep platform SDKs with channels,
  not in general-purpose `utils`.
- Route agent turns through `SessionManager` and the session classes. Do not
  create an unrelated provider/tool loop in a channel or UI handler.
- Preserve logical session IDs, physical segments, parent/child lineage,
  workdir references, and tool-call/result pairing. Changes to persisted state
  must cover **both JSONL and SQLite**, old records, and migration behavior.
- Project is a runtime/data boundary, not a Git repository. Folder IDs select
  registered file resources; Initiative IDs select shared work context. Keep
  project memories partitioned and directory ownership exclusive. Initiative
  SQL must stay within the runtime-bound Project database; session todos are
  views of shared items, not a second task store.
- Distinguish shared Home, session data, and effective workdir. Use the locality
  resolver and path helpers rather than rebuilding paths in each feature.
  `workspaceRoot` is an owning **session ID**, not a filesystem path.
- A remote workdir is an opaque node/capability reference. Never interpret its
  display path on Main, silently fall back to Main's filesystem, or mark a tool
  remote-capable without implementing and testing that execution route.
- Keep base tool schemas small. Session-imported tools are invoked through
  `invoke_tool`; skills are instruction documents read through `v:skills`.
  A skill is not an executable tool registration.
- Propagate abort signals, maintain lifecycle cleanup, and distinguish
  persisted configuration/history from in-memory queues and running processes.
- Validate external wire/configuration data at runtime. TypeScript interfaces
  and frontend role checks do not authorize a request.
- Separate prompt conventions from enforced controls. Tool filtering, local
  filesystem checks, gateway authorization, and Child capability approvals have
  different scopes; none implies a universal sandbox.
- Model-context updates must be append-only history events. Do not use `with*`
  prompt/context wrappers to rewrite the system prompt or attach disposable
  Work/audience suffixes for each inference. Deduplicate unchanged snapshots;
  retain old events at their original positions. Execution budgets remain host
  enforcement, not per-inference model-visible countdowns.

## Data and security precautions

Do not inspect, log, overwrite, or commit local `bot.config.json`, `.env`,
credentials, browser profiles, or runtime `workspace/` data unless a task
explicitly requires access. Use `bot.config.example.json`, config schemas,
synthetic fixtures, and disposable **project-local** test data instead.
Do not sweep `node_modules`, build outputs, or the third-party
`temp_adapter_qq` / `temp_botpy` trees during source searches.

The agent can run host commands, load script modules and MCP subprocesses, and
send context to configured providers. `restrictToWorkspace` is not an OS sandbox
or a blanket restriction on every tool. Keep the default gateway on loopback;
do not expose development inspector or unauthenticated gateway ports to
untrusted networks.

## Before handing off

1. Review the diff for unrelated edits and accidental data or secrets.
2. Run the smallest relevant existing tests/checks for code changes.
3. Update current documentation when behavior or commands change.
4. Report what was verified, what was not, and any WIP integration boundaries.
5. Keep current documentation source-backed. Remove obsolete plans when their
   useful guidance is covered by current references; Git retains the history.
