# Documentation index

## Current references

| Document | Read it for |
| --- | --- |
| [Project README](../README.md) | Node/pnpm setup, local development, builds, and entry points |
| [Using Shadow](using-shadow.md) | Project/folder navigation, conversations, files, and answering agent questions |
| [Messaging channels](channels.md) | Discord per-channel Agents, UI/chat review, memory domains, recovery and live-test limits; QQ passive replies |
| [Browser access](browser-access.md) | Local PIN and one-use pairing, trusted LAN, and PWA installation limits |
| [Tools and automations](tools-and-automations.md) | Virtual discovery, Project MCP, local versus Discord-domain learning, skills and schedules |
| [Project conventions](project-conventions.md) | Project SQL, attributable rule changes, Work queries, decisions and personal memory boundaries |
| [GitHub collaboration](github.md) | Project Issue/PR links, confirmed writes, cached evidence, explicit follow-up and uncertain outcome recovery |
| [Session diagnosis](diagnostics.md) | Read-only export/API/CLI and development-only prompt capture |
| [Session retirement](session-retirement.md) | Ordinary opt-in cleanup automation, verified preservation, recovery, upgrade behavior and limits |
| [Startup profiling](startup-profiling.md) | One-shot dev startup CPU/resource capture, timeout survival, local output and disable controls |
| [Live event-wait acceptance](event-wait-acceptance.md) | Real-model simulated and real GitHub CI/CD runs, mid-run URL deadline, observed wait strategies and integration limits |
| [Desktop release verification](release.md) | Native Windows/macOS/Linux build gates, Actions artifacts, package identity and installation acceptance boundaries |
| [Mobile client](mobile.md) | Capacitor client architecture, HTTPS gateway, pairing/revocation, native release and operational boundaries |
| [Two-device Electron pairing](desktop-pairing.md) | Trusted-LAN/VPN Main/Child setup, fingerprint approval, remote-work verification, reconnect and test boundaries |
| [Contributor guide](../AGENTS.md) | Repository conventions and change boundaries |
| [Architecture](architecture.md) | Features, project ownership/storage/routing, execution flow, persistence, and known limitations |
| [Visual design system](../DESIGN.md) | Quiet Workbench light/dark color roles, message hierarchy, components, and implementation guardrails |
| [Shared live transport](realtime-protocol.md) | Multiplexed SSE, topic ownership, replay/reset, reconnect recovery, and resource limits |
| [Frontend I/O](io.md) | Browser capture panels, adhoc backend connection protocol, controls, and verification limits |
| [Windows computer use](computer-use.md) | UIA-first shared windows, opt-in guarded keyboard/mouse, exact-action reviews, transient observations and limits |
| [Conventional audio setup](audio-setup.md) | First-use local/remote chooser, Agent-managed verified audio.cpp installation, model assessment and explicit API routes |
| [Project Quick Actions](quick-actions.md) | Chat command buttons, dashboard pins, direct runs, and stable Search overlays |
| [Inline visual answers](inline-visual-answers.md) | Native Markdown + safe HTML explanatory layouts inside web messages; no iframe or separate app |
| [Project Micro Apps](microapps.md) | Reusable Web tools, reviewed revisions, isolated pages, local backends and scoped model access |
| [Conversation agent authoring](agent-authoring.md) | Independent Changes, delegated resource edits, saved checks, owner-reviewed probes/publication and legacy drafts |
| [A2A text integration](a2a.md) | Opt-in A2A server/client, SDK/MCP coding-agent bridges, task continuation, notifications and trust boundaries |

**Status, September 2026:** the supported development direction is a direct
Node.js 24.15+ backend with pnpm, a Vue web application, and an Electron host.
Multi-device infrastructure is **work in progress**. Local agent behavior,
implemented device infrastructure, and future product plans are different things.
The architecture reference identifies those boundaries.

Project groups now have independently composed backend runtimes and Homes,
not a global project switcher or UI-only tags. Provider credentials and
devices stay App-wide; model defaults, sessions, bots, and learning belong to a
project. See [using Shadow](using-shadow.md#projects-folders-and-conversations) and the
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

## Designs and implementation checkpoints

- [Project causal alignment: goals and future work](project-causal-alignment-plan.md):
  the intent behind optional shared Work notes, abstraction-aware questions and
  the Project canvas; parent/worker responsibilities, lessons from evaluation,
  and future real-model experiments. Separates implemented foundations from
  unverified product goals; it is not a completed-feature or acceptance claim.
- [Discord integration and memory-domain authorization](discord-agent-integration-plan.md):
  original end-to-end plan for channel-specific Agents, UI/chat configuration,
  enforced memory domains, learning provenance, migration, and acceptance.
  Its status notice distinguishes the connected implementation and local checks
  from outstanding dedicated live Discord acceptance. Use Messaging channels
  above for current behavior; the original plan is not an acceptance certificate.

## Design history

The [distributed desktop workstreams](implementation/README.md) preserve
historical proposals and checkpoints. Use the current references above for
operational instructions; the historical workstreams are not a feature inventory.

Runtime prompt documents are another category: `src/agent/types/builtin/*/AGENT.md`,
`src/agent/context/*.md`, `src/sessions/handoff/HANDOFF.md`, and
`src/skills/builtin/*/SKILL.md` are **inputs to the agent**, not contributor
instructions or architecture authority. Changing them changes agent behavior.
