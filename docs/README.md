# Documentation

Start with the [project README](../README.md) for installation and commands,
[Using Shadow](using-shadow.md) for everyday operation, and the
[contributor guide](../AGENTS.md) for repository conventions.

## Using Shadow

- [Projects, folders and conversations](using-shadow.md)
- [Browser access and pairing](browser-access.md)
- [Messaging channels](channels.md), [WeChat delivery](wechat-delivery.md),
  and [QQ owner questions](qq-owner-questions.md)
- [Tools, skills and automations](tools-and-automations.md)
- [Project conventions and shared Work](project-conventions.md)
- [GitHub collaboration](github.md)
- [Provider instances and multiple accounts](provider-instances.md)
- [Provider cost estimates](provider-cost.md)
- [Quick Actions](quick-actions.md)
- [Conversation agent authoring](agent-authoring.md)
- [Project Micro Apps](microapps.md)
- [Inline visual answers](inline-visual-answers.md)
- [Windows computer use](computer-use.md)
- [Audio setup](audio-setup.md)
- [Mobile client](mobile.md)
- [A2A text integration](a2a.md)

## Architecture and contracts

- [Local development and troubleshooting](development.md)
- [Localization development](localization.md)
- [Architecture and implementation boundaries](architecture.md)
- [Visual design system](../DESIGN.md)
- [File spaces](file-spaces.md) and [media attachments](media-attachments.md)
- [Session references](session-references.md), [proxy sessions](session-proxy.md),
  [context usage](session-context-usage.md), and [task review lifecycle](task-review-lifecycle.md)
- [Shared live transport](realtime-protocol.md) and [frontend I/O](io.md)
- [Audio streaming backend](audio-streaming-backend.md)
- [Image input optimization](image-input-optimization.md)
- [Provider Flash support](providers-flash.md)
- [Fresh automation state persistence](fresh-automation-state.md)

## Operations and verification

- [Session diagnosis](diagnostics.md), [handoff recovery](handoff-recovery.md),
  and [session retirement](session-retirement.md)
- [Startup profiling](startup-profiling.md)
- [Desktop release verification](release.md) and [desktop bundling](desktop-bundling.md)
- [Data migration](data-migration.md) and [desktop data upgrade](desktop-data-upgrade.md)
- [Two-device Electron pairing](desktop-pairing.md)
- [Live event-wait acceptance](event-wait-acceptance.md)

## Scope

The backend uses Node.js and pnpm, with a Vue application and an Electron host.
Multi-device infrastructure remains **work in progress**: implemented slices,
fixture coverage and historical live runs do not establish full remote-tool
parity or release readiness. See the architecture and individual verification
boundaries before relying on a feature.

Source defines implementation behavior; package manifests define commands.
Documentation is not a security assessment or compatibility certification.
Superseded implementation plans and workstream checkpoints are available in Git
history, rather than maintained alongside current instructions.

Runtime prompts under `src/agent/types/builtin/`, `src/agent/context/`,
`src/sessions/handoff/` and `src/skills/builtin/` are agent inputs, not contributor
documentation. Editing them changes runtime behavior.
