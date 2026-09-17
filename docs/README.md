# Documentation index

## Current references

| Document | Read it for |
| --- | --- |
| [Project README](../README.md) | Node/pnpm setup, running, builds, and deployment cautions |
| [Windows release verification](release.md) | Build gates, verified downloads, package identity and installation acceptance boundaries |
| [Contributor guide](../AGENTS.md) | Repository conventions and change boundaries |
| [Architecture](architecture.md) | Features, project ownership/storage/routing, execution flow, persistence, and known limitations |
| [Shared live transport](realtime-protocol.md) | Multiplexed SSE, topic ownership, replay/reset, reconnect recovery, and resource limits |
| [Frontend I/O](io.md) | Browser capture panels, adhoc backend connection protocol, controls, and verification limits |

**Status, September 2026:** the supported development direction is a direct
Node.js 24.15+ backend with pnpm, a Vue web application, and an Electron host.
Multi-device infrastructure is **work in progress**. Local agent behavior,
implemented device infrastructure, and future product plans are different things.
The architecture reference identifies those boundaries.

Project groups now have independently composed backend runtimes and Homes,
not a global project switcher or UI-only tags. Provider credentials and
devices stay App-wide; model defaults, sessions, bots, and learning belong to a
project. See the [README project guide](../README.md#projects) and
[source-backed architecture](architecture.md#projects-ownership-storage-and-routing)
for the canonical sibling storage layout, fresh Default startup, recovery,
and verified remote-folder ownership with its Child upgrade boundary. This implementation does not
establish OS sandboxing, multi-tenant authorization, or distributed release
readiness. Mac/WSL SSH fixtures remain test environments, not portable installs.

Source is authoritative for implementation behavior; package manifests are
authoritative for commands. Documentation describes behavior but is not a
security assessment, compatibility certification, or a record of a test run.

## Distributed desktop workstreams — WIP

[Implementation index](implementation/README.md) preserves a coordinated
distributed-desktop implementation effort, including its contracts, ownership
boundaries, checkpoints, and deferred work.

| Workstream | Subject |
| --- | --- |
| [S0](implementation/00-contracts-and-decisions.md) | Shared contracts and decisions |
| [S1](implementation/01-session-state-and-locality.md) | Session persistence and workdir locality |
| [S2](implementation/02-execution-and-artifacts.md) | Executors and artifact design |
| [S3](implementation/03-cluster-security-and-remote-api.md) | Pairing, device transport, authorization design |
| [S4](implementation/04-runtime-roles-and-headless-main.md) | Runtime roles and composition |
| [S5](implementation/05-electron-shell-and-bootstrap.md) | Electron and setup lifecycle |
| [S6](implementation/06-frontend-product-ui.md) | Role-aware UI, initially fixture-backed |
| [S7](implementation/07-gateway-hardening.md) | Gateway boundary |
| [S8](implementation/08-release-migration-observability.md) | Release, migration, and operational design |

These are **workstream specifications and historical checkpoints**, not an
installation guide or evidence that the entire distributed product is ready.
In older specifications, directory Project means today's Folder/Repository.
The old long-running
`ProjectTool` is a separate concept, now Initiative. Historical names are
preserved rather than rewriting proposals as current implementation.
Unqualified phrases such as “current,” “integrated,” or “MVP” refer to the
checkpoint within that document. Old Deno commands, test counts, package layouts,
and file ownership locks are preserved as history; use the current README and
manifests for operation. Do not replace Deno with Node mechanically in an old
proposal: that would invent a historical implementation that did not exist.

## Design history

| Document | How to interpret it |
| --- | --- |
| [DESIGN-BRAINSTORM.md](../DESIGN-BRAINSTORM.md) | Earlier architecture analysis and multi-device design space; its “current architecture” describes the older Deno-era baseline |
| [MEM.md](../MEM.md) | Memory model rationale and proposed invariants; several pieces are implemented, but exact paths, prompt inclusion, and enforcement must be checked in source |
| [KEY.md](../KEY.md) | Product/agent interaction ideas and desired behavior, not a feature inventory |
| [PROBLEMS.md](../PROBLEMS.md) | Historical observations and open questions, not a maintained bug-status dashboard |
| [ui-refactor.md](../ui-refactor.md) | UI refactoring design material, not the live route/API contract |

Runtime prompt documents are another category: `src/agent/types/builtin/*/AGENT.md`,
`src/agent/context/*.md`, `src/sessions/handoff/HANDOFF.md`, and
`src/skills/builtin/*/SKILL.md` are **inputs to the agent**, not contributor
instructions or architecture authority. Changing them changes agent behavior.
