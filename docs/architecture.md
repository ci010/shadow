# Shadow architecture

This is the global view of the **implemented local agent** and its evolving
desktop/device infrastructure. It is based on the composition root and source
modules, not solely on design documents.

**Multi-device support is WIP.** A Main/Child protocol, capability executors, and
some real integration paths exist. That does not establish a production-ready
distributed release, feature parity with local tools, or completed operational
and security guarantees.

For setup and commands, use the [README](../README.md). For contribution rules,
use [AGENTS.md](../AGENTS.md). The [documentation index](README.md) separates
current references from historical proposals.

## Contents

- [Product and implementation status](#product-and-implementation-status)
- [Process architecture and startup](#process-architecture-and-startup)
- [Projects: ownership, storage, and routing](#projects-ownership-storage-and-routing)
- [A message from input to response](#a-message-from-input-to-response)
- [Sessions and continuity](#sessions-and-continuity)
- [Context and memory](#context-and-memory)
- [Model providers](#model-providers)
- [Tools, skills, and MCP](#tools-skills-and-mcp)
- [Events, background work, and cron](#events-background-work-and-cron)
- [Channels, gateway, and UI](#channels-gateway-and-ui)
- [Programmable browser I/O](#programmable-browser-io)
- [Electron lifecycle](#electron-lifecycle)
- [Multi-device infrastructure — WIP](#multi-device-infrastructure--wip)
- [Persistence, configuration, and trust](#persistence-configuration-and-trust)
- [Module map and extension points](#module-map-and-extension-points)
- [Limitations and documentation corrections](#limitations-and-documentation-corrections)

## Product and implementation status

| Area | Implemented behavior and boundary |
| --- | --- |
| Personal agent | Persistent conversations, configurable models, tool-use loops, steering, subagents, and slash commands in the local backend |
| Projects | Concurrent project runtimes with separate Homes, sessions, context, bots, learning, and diagnostics; shared provider credentials/devices, not separate OS sandboxes |
| Context and memory | Agent prompts, identity, project context, scoped conventions, file-backed memory, daily event summaries, compaction, and learning-agent pipelines |
| Tools | Files, text editing, search, shell processes, background continuations, messaging, plans, conventions, dynamic script tools, and MCP adapters |
| Skills and agent types | Built-in definitions plus watched workspace overrides; progressive skill disclosure and per-type tool filtering |
| Channels | Web plus project-owned Discord, Feishu, and QQ bot instances; legacy WeChat/iLink implementation is not started by project runtimes |
| Browser automation | Lazy Chrome DevTools MCP with session-local launch/attach instances; requires a usable browser/CDP target and MCP process |
| Web application | Vue chat/session/files UI, agent views, logs and traces; Nodes reads device/capability inventory from the backend; paired nodes execute without operation approvals |
| Electron | Main bootstrap, persisted launch profile, backend supervision, narrow preload API, renderer setup/recovery; Child/product integration remains incomplete |
| Device execution | Pairing/challenge/WebSocket code and bounded remote UTF-8 workdir operations exist; full remote tools, artifacts, UI administration, and release hardening remain WIP |

“Implemented” means a source path exists and is composed into the application
where noted. It is not a claim that every external integration was exercised on a
clean machine or that every historical acceptance criterion has been met.

## Process architecture and startup

### Local topology

```text
Browser / Electron renderer              External messaging platforms
          | HTTP + SSE                              |
          v                                         v
                 One Node backend (Main host)
  Shared gateway / project catalog / provider credentials / devices
              |
              +--> Project runtime A (flow below)
              +--> Project runtime B (same flow, separate state)

  Within each project:
  Hono gateway + channels --> AgentApp --> SessionManager.deliver
  Event routing / other sessions ------->      |
                                               |
                               Session / EphemeralSession
                                  |                   |
                            LLM providers         SessionTools
                                                      |
                                 host files/processes, VFS, MCP,
                                 browser, subagents, event services

  Session facts/output --> Bus notifications + outbound queue --> UI/channels

        File/SQLite state beneath that project's Home

Electron main, when used:
  setup + preload IPC + authorization + backend process supervision
  (not a second agent engine)

WIP extension:
  Main <-> authenticated device WebSocket <-> Child local executor
```

The backend runs directly on **Node.js 24.15+**. TypeScript development uses
`tsx`; backend production output is Node ESM. The Vue package uses Vite.
Electron launches that Node backend module using Electron's Node runtime in a
separate process. There is no Deno compatibility layer or parallel Deno runtime
to maintain. Package scripts and `build.ts` own compilation/assets; do not infer
current packaging from the older compiled-sidecar proposals.

The backend build emits ESM modules and supporting assets under `dist/src`,
preserving relative paths. Its entry is `dist/src/index.js`; the shared script
worker is `dist/src/script-runtime/worker.js`. Electron packaging uses
`pnpm deploy --prod --node-linker hoisted` to include the built backend and its
runtime dependencies without relying on development-tree symlinks. The renderer
build emits `app/dist`.
The release command gates packaging on backend/Electron/Vue typechecks and
focused release tests, then verifies source-bound hashes of the fresh package's
resources and ASAR. See [release verification](release.md) for its exact limits.
Opt-in Windows service mode uses a pinned WinSW host to run Electron in Node
mode independently of the UI. Attached desktop shutdown only disconnects; normal
sidecar mode retains the existing owned-process shutdown behavior. Installation
and SCM lifecycle acceptance remain distinct from a passing packaged smoke.
The eval child is the separate Node runner used by inline script execution, not
another long-lived agent authority.

### Composition root

[`src/index.ts`](../src/index.ts) is the stable, thin process entrypoint.
[`src/runtime/main/`](../src/runtime/main/) owns `startProjectHost` and
the `createProjectRuntime` composition factory:

1. Load configuration and initialize the canonical Project catalog. A new
   catalog starts Default with a fresh Home; old Homes are not imported.
2. Create the shared gateway, provider setup/authentication, device cluster,
   host diagnostics, and browser-port allocator.
3. For each catalog entry, create its immutable Home/configuration/scope and
   compose a separate Bus, `EventService`, provider aggregator, background-task
   manager, telemetry store, tools, VFS, identity, and eval bridge.
4. Initialize that project's folder registry and selected session store,
   `HandoffManager`, `ContextBuilder`, `SessionManager`, skills and agent types.
5. Mount its VFS and routes, register commands, messaging/subagent tools,
   schedules, and `LearningService`; start channels, watchers, and recovery.
6. Mount scoped project dispatch alongside shared host routes, then the
   frontend fallback. Start catalogued projects with at most three concurrent
   starts, independently tracking their ready/failed state rather than
   selecting one global runtime. Reserve persisted remote-workdir ownership
   before starting any Project.

Main's local readiness still waits for the initial Project starts to settle;
it does not declare incomplete Project services ready. Optional web-search
network discovery is deferred to the first search, and external channel
connections continue independently of local readiness. MCP startup registers
its lazy catalog; it does not connect every configured server.

Fixed-shape `[startup]` records report host/Project phases, completion/failure,
elapsed milliseconds and phase durations. They include no configuration values,
workspace paths, conversation contents, or error payloads. These timings separate
local store/recovery work from desktop process-launch overhead.

Electron validates these records through a bounded startup-only parser and
persists safe lifecycle/failure events and phase timings to
`<userData>/logs/startup.jsonl`. Project IDs become per-attempt numeric ordinals;
raw child output is not persisted. The current log and two rotations are each
bounded to 256 KiB. Recovery displays the failure category, runtime role and
elapsed time, and a main-window-only, argument-free IPC action reveals that
fixed log. Retry awaits failed-process cleanup. The readiness watchdog remains
15 seconds; the optimization removes optional network discovery from startup
rather than masking slow initialization with a longer timeout.

Shutdown is coordinated through a runtime handle: stop accepting work, stop
polls/sessions/channels/schedules/watchers, release browsers, drain node
connections, stop the gateway, and save cluster state. This is lifecycle
coordination, not a promise that all in-flight work is durably replayable.

`src/runtime/process-entry.ts`, `runtime-cli.ts`, `bootstrap-config.ts`, and
`startup-plan.ts` add explicit Main/Child startup and separate bootstrap data
from the ordinary agent configuration. The simple local `pnpm start` path
remains the primary way to run the agent without Electron.
Startup plans contain validated arguments and normalized configuration, not
descriptive service-name catalogs. Actual services are assembled by the Main
and production Child factories.

The Child lifecycle starts credential validation, local executor lifecycle
management, the Main connector, and an optional authenticated loopback control
listener in that order; shutdown and partial-start rollback reverse the
successfully started services. Capability descriptors are supplied directly to
the connector, not hosted in an empty registry service. No placeholder service
is created for artifact staging or for an absent local control listener.

## Projects: ownership, storage, and routing

Project owns a runtime and its data. Folder/Repository names the file resources
within it. Initiative is
coordinated work within that Project, not another runtime or isolation boundary.

### Ownership is not presentation

[`ProjectCatalog`](../src/projects/catalog.ts) persists stable IDs and
renameable names. [`ProjectsWorkspace.vue`](../app/src/components/ProjectsWorkspace.vue)
renders all project groups together and retains conversation resources keyed
by project and session; there is no global project switcher. Changing
the visible conversation does not move a runtime, draft, bot, or learning job.
Project settings expose General, Models, Bots, and Learning; Providers and
Nodes remain App-level views.

A project owns Home, session history and continuity, folder membership,
context/memory/identity, learned skills and agent overrides, MCP/browser state,
events/cron, background work, bots, learning, and scoped diagnostics. These are
separate service instances, not just `projectId` labels on a shared mutable
session manager. Built-in instruction assets can be reused read-only.
**Automations**, Chats, and folder/repository rows are UI groupings inside a
project, not independent ownership or authorization boundaries.

Each session persists `projectId` and at most one `folderId`.
[`SessionManager`](../src/sessions/session-manager.ts) validates project
membership for folder/workdir references, parent/child/report links, messages,
fork/call context, and yield handling. An agent cannot address another
project's history, fork, or message target through these APIs. Scoped VFS
views do not expose the host catalog as cross-project conversation data.
Local folder ownership is checked centrally after directory canonicalization:
another project's identical or parent/child-overlapping folder is rejected,
including clone destination reservations. Same-project directory rules
remain unchanged. Files stay in their registered folders.

Folder membership can be removed or moved through the owning project's
folder API and folder-row menu. A move creates a new folder identity in the
destination; neither operation transfers files, conversation history, or
learned knowledge. Retained source conversations cannot keep using the former
folder workdir, including after moving the folder back. Busy checks conservatively
cover the source project, not only the selected folder. Overlapping folder
registrations can prevent a safe transfer. Unconfirmed remote termination remains
durably blocked across restart, without automatic recovery. Retired folder
identities prevent removed membership from being reused.
This is not a project migration or a filesystem move.

Shared provider connections/credentials are merged into project configs.
Model defaults, quick-model choice, temperature and reasoning settings resolve
from conversation overrides, then project overrides, then App defaults, then
built-in defaults. Unset project fields are not materialized on disk; explicit
choices from existing records are retained.
[`ProjectConfigStore`](../src/projects/config-store.ts) excludes
provider credentials from its persisted file and rejects attempts to change
shared connections or relocate Home through the project config endpoint.
Devices and pairing are shared; visibility of a device alone does not assign
its folders to every project.

Identity observations also retain the source bot address.
[`userlink verify <channel> <senderId> [targetBotInstanceId]`](../src/tools/shell-commands/userlink.ts)
selects an observed target in the same project; ambiguous targets require
the bot selector. Confirmation checks the pinned project, bot, platform,
conversation, and sender instead of guessing a same-platform bot. Default's
legacy account links remain compatible; unknown or ambiguous targets fail
explicitly before sending a challenge.

This is enforced application ownership, not team/RBAC isolation or host
confinement. Local exec, script imports, MCP, and external processes still run
with host-user permissions. No whole-project move/merge/delete, cross-project
knowledge sharing, cross-project coordination, or separate process sandbox is
provided by this catalog.

### Actual storage

The [Main host](../src/runtime/main/) resolves the configured
`agent.workspace` and appends `.projects` to obtain the host root.
[`projectPaths`](../src/projects/contracts.ts) defines this layout:

```text
<workspaceBase>\                      configured base / shared device state
  .cluster\registry.v1.json            shared registry unless overridden
<workspaceBase>.projects\              sibling of the configured base
  projects.v2.json                     catalog and folder ownership index
  .host.otel.db                        host-only diagnostics
  projects\
    default\                          stable ID; display name may change
      config\
        project.json                  Project settings, no shared providers
        bots.v1.json                  private bot-instance configuration
      workspace\                      Default's active Home
        .sessions\                    JSONL and/or SQLite history
        memory\                       includes learning watermark
        skills\ / agents\ / SOUL.md    project-owned learned content
        .events\ / .cron\ / .otel.db    Project-owned state
    <project-id>\
      config\...
      workspace\...
```

Only canonical Project storage is loaded. Unsupported catalogs,
ownership formats, and storage locations are not upgraded or imported.
New catalogs initialize Default without copying an existing Home, its session
history, memory, skills, or folder registrations. Old directories remain
untouched but are not visible through this catalog. This is an intentional
compatibility break, not an automatic data migration.

Shared provider configuration and Copilot credentials stay in their existing
host/profile locations. The device registry remains at the configured base
unless explicitly overridden, so this cleanup does not reset device pairing.
Current JSONL and SQLite records keep distinct `projectId` and `folderId`
ownership; unsupported formats fail rather than reinterpret old IDs.

### Routes, failures, and scoped services

[`gateway.ts`](../src/projects/gateway.ts) exposes:

| Surface | Scope |
| --- | --- |
| `/api/projects`, `/api/projects/:id` | App catalog list/create and rename |
| `/api/projects/:id/status`, `/retry` | Project startup state and explicit retry |
| `/projects/<id>/api/...` | Project sessions, folders, bots, config, learning and content |
| `/projects/<id>/v1/...` | Existing project telemetry/compatible API suffixes |
| Root provider setup/discovery and device routes | Shared App services |
| `/host/v1/...` | Separate host diagnostics |

The base is `/projects/<id>/`, **not** `/api/projects/<id>/api/`.
Frontend content clients preserve the existing `api/...` and `v1/...` suffixes;
HTTP/SSE/file URLs and conversation cache identity include the owning
project. Legacy unscoped content routes dispatch to `default`, not to the
current UI selection. Old chat/agent/log routes similarly redirect to Default.
Existing gateway authorization still applies; a route prefix is not a new
multi-tenant login system.

The host tracks each runtime as starting, ready, or failed. A failed runtime
returns `503 project_unavailable` for scoped content; catalog status/retry
remain available, and [`ProjectGroup.vue`](../app/src/components/ProjectGroup.vue)
shows its startup error/retry without disabling healthy groups. Failed partial
startup cleans up owned resources. Host initialization failures occur
earlier and can still prevent host startup. Shutdown stops project
producers/sessions and flushes/closes owned services before releasing shared
gateway/device/telemetry infrastructure; in-memory work is not crash-durable.

[`LearningService`](../src/agent/learning/service.ts) owns per-project activity buffers,
subscriptions, activity gates, dispatch cancellation, and status at
`/projects/<id>/api/learning`. Enabled/interval settings apply live.
Its managed fresh jobs run on the project's `CronService`, rather than
independent learning timers.
`lastDispatchedAt` means dispatch acceptance, not that a learning agent completed
or successfully wrote knowledge. [`otel/runtime.ts`](../src/otel/runtime.ts)
routes spans/logs to an explicitly bound project scope; unscoped host
diagnostics use a separate store rather than broadcasting into every project.
[`EvalBridgeRuntime`](../src/script-runtime/bridge.ts) and remote job IDs are also
project-bound; this does not sandbox the code they execute.

### Remote folder ownership and upgrade boundary

Project composition wires
[`RemoteFolderOwnership`](../src/folders/remote-ownership.ts) into the folder
registry and [`remote-session-routes.ts`](../src/sessions/remote-session-routes.ts).
New remote-session creation registers or reuses a project-owned remote
folder, then persists its `folderId` and opaque node/capability workdir
reference. `POST /projects/<id>/api/sessions/remote` accepts `nodeId`,
`capabilityId`, and an optional UUID `requestId` for retry-stable session
creation; it does not accept an execution path. A reused request ID targeting a
different capability is a conflict.

For a reopened registered-folder draft,
`POST /projects/<id>/api/folders/<folder-id>/sessions` accepts an optional
`{requestId: UUID}` object; an empty body remains compatible. It verifies the
saved remote folder identity before creating a session, rather than reselecting
its node/capability. Concurrent requests and retries after a lost response reuse
the same persisted conversation; a request ID already bound to another folder
returns a conflict.

[`CapabilityWorkdirIdentity`](../src/execution/capability-workdir-identity.ts)
implements the advertised Child operation `workdir.identity`. It resolves the
configured root on Child using `realpath`, then hashes filesystem device/inode
identities for the root and its ancestors. Main validates the bounded
[`WorkdirIdentityV1`](../src/execution/workdir-identity.ts) response and checks
same-node root/ancestor overlap in the host catalog, rejecting cross-project
identical, aliased, or nested folders. Remote display paths remain display-only,
never inputs to Main's local filesystem. A filesystem without stable directory
identity fails explicitly rather than guessing ownership from its path.

Startup reserves legacy remote workdirs from **both JSONL and SQLite** for
Default. Both direct registration and registered-folder `requireAvailable`
revalidate every saved claim and folder on that device. An unavailable or
retargeted **other** saved capability can block not only new registration but
also opening a new session in an existing folder or accessing its
resources. These ownership checks intentionally fail closed until the affected
capability is restored and revalidated; they never fall back to Main.
Existing session records remain preserved.
Migrated existing sessions retain their references and supported execution
paths. An older Child without `workdir.identity` returns
`409 remote_workdir_identity_unsupported` / `upgrade_node` for new folder
actions, not a blanket prohibition on existing remote sessions. Deploy updated
Main and Child and reconnect; Mac/WSL SSH test fixtures need this rollout too,
and are not a portable/autostart release. An unavailable device/workdir returns
`503 remote_workdir_unavailable`. Native test execution is not an upgrade or
restart of already-running Child processes.

[`FolderService`](../src/folders/routes.ts) routes registered remote folder
file listings, UTF-8 text previews, and Git status/diffs through Child, including
folder browsing before a conversation exists. Remote raw/static media remains
`501 remote_raw_unavailable` in
[`remote-files.ts`](../src/folders/remote-files.ts); alternate text encodings
and remote cloning remain unsupported. Errors never select a Main-local folder.
These changes do not alter pairing or add per-operation approvals, OS isolation,
cross-node filesystem identity guarantees, or distributed release readiness.

## A message from input to response

1. **Normalize input at the boundary.** A channel validates its configured sender
   policy and calls its explicit receiver. `AgentApp.receiveChannelMessage`
   translates the existing channel wire shape into `SessionInput`. Only this
   adapter preserves legacy `channel:chatId` addresses for migrated bots while
   new bot instances carry project/instance-qualified addresses. Directed
   callers supply a session ID without disguising input as a channel message.
2. **Handle channel commands.** `AgentApp` tries the slash-command dispatcher for
   ordinary channel text, retaining its existing admin checks.
   Commands such as `/help`, `/config`, `/status`, `/sessions`, `/compact`, `/clear`,
   `/dump-prompt`, and `/learn` can respond without an ordinary agent turn.
   Command admission initializes session identity and Main-owned session data,
   without creating external folder paths or interpreting remote display paths.
   Results are persisted as non-message `command_result` records in both stores,
   returned separately as `commandResults` by display-history APIs, and delivered
   as typed web receipts (also included in the send acknowledgement). They do not
   enter provider history, inherited fork context, or channel-message fanout.
   Other channel adapters retain their ordinary textual command response.
   Event and other-session inputs do not pass through this command boundary.
   Retry is a typed control, not another copy of the user's content.
   `/clear` serializes with input admission, requires an idle persistent session,
   refreshes its installed agent definition, retires its in-memory context/tools,
   and persists an empty next segment without invoking handoff or the provider.
   Logical identity, locality, lineage, and old logs remain unchanged. Fork
   inheritance applies only to segment zero. Both stores persist `contextResetAt`,
   which excludes older transient memory from prompt injection without deleting
   files or long-term conventions. The next turn builds a new prompt/tool overlay.
3. **Accept into a session.** `SessionManager.deliver(sessionId, input)`
   restores/builds state and history,
   resolves the agent type and workdir, builds context, and supplies the
   session-specific tool overlay, and admits the input to that session's mailbox.
   Its receipt means accepted in this process, not model completion or durable
   persistence. Preparation/admission errors reject the directed caller; web
   requests do not return a successful acceptance for those errors.
4. **Build the message.** `agent/message-builder.ts` converts inbound text,
   explicit user/session/event provenance and supported media into provider-neutral
   **user-role** messages. Sender prefixes and arbitrary metadata do not select
   roles, urgency, or command privileges. The execution context carries logical and physical IDs, effective
   cwd or remote capability, tool overlay, model settings, and an abort signal.
5. **Run the LLM/tool loop.** `BaseSession` calls `LLMProvider.chat`, persists
   assistant messages and usage/reasoning, and emits response/tool activity.
   Tool calls are grouped according to read-only metadata: compatible read-only
   calls can run together; other calls are sequenced. Results are appended as
   paired tool messages before the next model call.
   `yield` holds that tool call while `SessionManager.yields` waits for a
   correlated human/parent answer or a configured default timeout. No separate
   provider loop is created; parent requests enter the normal session mailbox.
6. **Finish or continue.** No tool calls ends the turn. A context-limit response
   can trigger persistent-session compaction and retry; ordinary errors and
   cancellation follow the session error path. A real `session.turn.finished`
   fact records completed/failed/cancelled status. Independent outbound projections
   retain the channel/web response format; `done` is a display boundary, not the
   source of domain completion.

```mermaid
flowchart LR
  Channel["Channel adapter / web HTTP"] --> Ingress["AgentApp channel boundary"]
  Ingress --> Delivery["SessionManager.deliver(target, typed input)"]
  Ingress -. "explicit channel-source publication" .-> Events["EventService: match / dedupe / debounce"]
  Producers["Cron / background completion / domain reports"] --> Events
  Events --> Delivery
  Messages["Other session: message tool"] --> Delivery
  Delivery --> Mailbox["Target Session mailbox"]
  Mailbox --> Turn["Agent / provider / tool loop"]
  Delivery -. "accepted fact" .-> Bus["Bus notifications"]
  Turn -. "turn finished fact" .-> Bus
  Turn --> Output["Outbound projection / explicit channel queue"]
  Output --> UI["Channels / HTTP SSE"]
```

The channel source is published once after direct acceptance and skips its original
session during subscription fanout. Delivery is never re-published as
`message.inbound`: there is no Message-to-Event-to-Message feedback loop.
`SessionInput` separates target identity from source and optional reply address;
event IDs and original input/session provenance survive fanout, while each delivery
has its own input ID. These envelopes are in-memory contracts, not a new storage
format or network protocol.

This is an iterative conversation loop, not a durable workflow DAG. A frontend
SSE activity stream does not mean every provider is token-streaming to the UI:
the common loop works with completed `chat` responses and tool events.

The renderer uses an application-owned, per-Main connection pool
(`app/src/live-client.ts`, `app/src/composables/useLiveClient.ts`). Its
`GET /api/live` stream multiplexes project-qualified chat, session
invalidations, logs and spans; cached Vue panes own subscriptions, not sockets.
Backend publisher leases attribute events to their owning project, and
the host and standalone Main integrate the same shared transport. Legacy
per-chat, per-request, and standalone telemetry streams have been removed;
retired streaming APIs return explicit HTTP 410 migration errors.

The wire contract is `src/realtime/protocol.ts`: named `realtime` SSE envelopes
carry epoch/sequence cursors, ordered data, explicit reset/ready controls and
observable heartbeats. A failed catalog Project is reported with an explicit
`unavailable` topic list rather than rejecting the whole multiplexed connection.
Only its readiness waits fail; healthy Projects keep receiving updates, and a
successful retry resets/re-enables its topics on the existing connection.
The server bounds its replay journal and client queues;
slow consumers disconnect rather than growing an unbounded server queue.
The renderer closes the old transport before replacing a subscription set,
deduplicates replayed cursors, reconnects with bounded backoff, and detects
half-open connections with a heartbeat watchdog. New subscriptions and
unrecoverable cursors trigger authoritative snapshot reads. Snapshots and
invalidations are coalesced; hidden idle chat panes do not render token updates
or retain individual network connections. A hidden submitted request can retain
its shared subscription to observe completion.
Execution cards also observe the owning project's sessions topic and
coalesce graph refreshes; metadata-only call-wait changes update mounted cards
without reloading the conversation or discarding its draft.

This is not a durable token-event ledger. Replay is bounded and in memory.
After a Main restart or replay gap, committed session history is authoritative;
temporary generated output may be replaced during reconciliation. Reconnecting
the UI never re-admits a command or implicitly resumes interrupted execution.
Not every resource has push hooks: intermediate stages and Nodes still use
visible-only polling, project lists have a 20-second reconciliation
fallback, and provider configuration uses ordinary bounded HTTP reads.

`app/src/chat-request-control.ts` manages composer Stop state across preparation,
admission, streaming and cancellation. The Send button becomes Stop in the same
position while a request is busy, remains disabled while cancellation is pending,
and returns to Send when the request finishes. Enter can still send guidance
during active work. The renderer waits for its shared chat
subscription, then submits `/api/chat/send` with `stream:false` and reads the
short JSON `{requestId,chatId}` acknowledgement. It does not keep a per-request
SSE response open or automatically retry an uncertain admission. Omitting
`stream` also returns the admission JSON; `stream:true` fails before submission.
Restored activity gets the same identity from
`/api/sessions/stages`'s `activeRequestIds`. The UI always captures and submits
that ID, failing closed if it is unavailable. `POST /api/sessions/:key/cancel` uses a URL-encoded
logical session ID and an optional `{requestId}` body. A supplied ID must match
the active input's reply-address message ID (or its input/event ID); a mismatch returns
`409 request_not_active`. Omitting it explicitly targets the current turn.
The `requested` response acknowledges `Session.cancel()`, not completed cleanup;
the UI retains activity until a terminal event or confirmed inactivity, and
shows cancellation errors without pretending work stopped. Provider/tool abort
is cooperative, preserves queued inputs and does not kill unrelated background
tasks or roll back completed side effects.

The composer also exposes an explicit Continue action from
`/api/sessions/stages`'s `recoveries`. `SessionState.recovery` stores a recovery ID
and stopped/interrupted/failed reason through JSONL and SQLite, including their
migration path. `POST /api/sessions/:key/resume` accepts only `{recoveryId}` and
returns a 202 admission receipt with a new request ID. Serialized admission
rejects stale, duplicate, wrong-session or busy/queued resumes with 409. The
normal session loop handles a distinct resume control, continuing saved history
rather than retrying the original content or attachments. Resume appends no
user/event instruction to the model context. Pending calls from the trailing
assistant tool batch execute with their original IDs and arguments before the
next provider request; calls with persisted results are not executed again.

Startup recovery marks interrupted reusable sessions without invoking a model.
It changes recovery metadata only: unfinished calls remain unfinished, without
fabricated result messages. Reusable sessions persist each completed tool result
without waiting for sibling tools; a real result returned during cooperative
cancellation is retained. A new message supersedes unfinished calls with cancellation
results, whereas Continue/Retry finish the saved batch. Successful completion
clears recovery; unsent preparation cancellation creates none. After a crash,
explicit continuation may repeat effects from calls whose results were never
saved; exactly-once external effects are not guaranteed. In-memory queues are
not restored. Unrelated scheduled activity is unchanged.

## Sessions and continuity

### Roles and execution modes

`agent_type` selects the role, instructions, and tool constraints. `mode` is a
separate per-execution contract: `session` is reusable, `task` is a fresh
one-assignment worker with asynchronous completion, and `call` is a bounded
invocation inheriting a caller-context snapshot and returning its final result
through the original blocking tool call. Task creation returns after admission,
not model completion; their caller can work independently or finish its turn.
There is no independently configurable
`ephemeral` execution flag. Agent definitions provide `defaultMode`, not a fixed
lifetime. `subagent` accepts only task/call, defaulting omission to task regardless
of role default; durable topics use a separate creation surface. Mode is stored with execution state rather than inferred repeatedly
from a role that can be edited later.

The delegation capability matrix is enforced at runtime as well as described in
the prompt: durable root/topic → task/call; task → explicit call; call → none.
Role tool restrictions can narrow this further. The Project coordinator cannot
delegate. Structural delegation ownership applies to temporary executions, not
topic provenance; neither the agent type's visibility flag nor context-only fork
ancestry establishes coordination authority.

### Project coordination and topic peers

Each Project has exactly one `web:orchestrator`, pinned as the default UI routing
entry. Its built-in role and canonical runtime guard permit only
read/search/topic/message/initiative, excluding invoke_tool/exec/write/subagent.
It routes to reusable topics and lets users continue there, rather than owning
their session hierarchy. Ensuring its existence never automatically runs an LLM.

Durable topics are `web:chat-UUID` root peers. Project-scoped
`search({space: "sessions:", query, limit: 5, offset: 0})` returns their
title/goal/scope/nonGoals, folderId, initiativeId, createdBySessionId, and status;
page size is bounded at 20. Prefer reuse before creating a new topic.
Topic create/search/update receipts return `conversationUrl` in
`/projects/<encodedProjectId>/chat/<encodedLogicalSessionId>` form. Coordinator
handoffs link the topic title to that returned URL, making the peer conversation
directly accessible rather than merely reporting an ID.
Remote-workdir sessions may use `sessions:` search and typed Project messaging
as control-plane operations. This does not enable other remote search spaces,
which remain explicitly rejected.
`topic` creation requires title, goal, and scope; optional nonGoals, folderId,
agentType, initiativeId, initialMessage, and requestId refine it. Kickoff admission
is optional and never transfers an Initiative assignment. Idempotent requestId
retries do not replay kickoff; initialMessageStatus distinguishes accepted,
not_requested, and not_replayed.

Topic update takes sessionId and the full title/goal/scope/nonGoals brief; only
self/coordinator or authorized UI may update it. `register_folder` with path
uses the existing Project registry for an existing Main-local folder. List with
`read("v:project/folders")`; never translate a remote topic's display path into
a Main filesystem path. Task/call executions cannot create/manage durable topics
or register folders.

Authorized routes expose GET/POST `/projects/:projectId/api/topics`, PATCH
`/projects/:projectId/api/topics/:key`, and POST
`/projects/:projectId/api/orchestrator`. Topic brief metadata is projected into
session detail/graph results separately from delegation ownership.

JSONL and SQLite migration flatten old reusable structural children without
losing context parents or changing effective workdirs. `createdBySessionId`
preserves provenance. `workspaceRoot` remains an owner-ID compatibility reference
for managed-session data/workdir locality, not structural/dependency ownership.
Graph parentage comes from delegation ownership, not a historical context parent.

- `Session` owns an inbox, active turn, abort controller, steering queue,
  compaction, and inactivity timer. Different logical sessions can operate
  concurrently in one backend.
- New human input during an LLM request aborts that request and queues the
  message. During tool work it can steer into the next model iteration; longer
  tool work can use `quickModel` to classify steer versus abort.
- Content has an explicit `interactive`, `queue`, `steering`, or `silent` policy.
  Event defaults and trailing-debounce flushes are explicitly queued, including
  during LLM/tool work; they cannot accidentally take the human-interruption path.
  Silent inputs only record content after any active turn; they neither inject
  into its context nor start a later model turn. The `message` tool defaults to
  queued, non-interrupting delivery regardless of its descriptive `intent`.
  Required materials and unblocking instructions need a non-silent request;
  multi-part context must end with one, not with silent follow-ups.
  Retry/cancel/compact are distinct controls;
  debounce exists only in the event router, not as another admission policy.
- `EphemeralSession` serializes admitted work without persistent-session steering,
  idle sleep, or compaction. Admission does not wait for the model; lifetime end
  follows actual processing. Its transcript **is still persisted**. The internal
  class name describes one-shot execution, not a public role property or absence
  of stored data.

The default persistent-session inactivity period is 15 minutes. Sleep releases
active session resources and dynamically imported tools; state/history remain.
Below the handoff threshold, sleep does not require an LLM summary. Above it,
compaction creates a continuation before the loop stops.

### Logical history, physical segments, and subagents

`SessionState` holds a stable logical session ID, current segment index, activity
and token values, settings, parent/children, agent type, execution mode, project, report target,
workdir, and preload tools. New sessions persist `physicalIdVersion: 2` in both
JSONL and SQLite. Their physical log addresses combine a readable sanitized prefix,
a SHA-256 digest of the **complete** logical ID, and the segment number. This keeps
same-bot private chats and groups distinct even when their logical IDs share a long
Project/bot prefix. Compaction starts a new segment linked to the previous one;
forks can inherit a parent segment up to a record index. History assembly
sanitizes/truncates tool-call/result pairs rather than treating every stored
message as independent.

Absent `physicalIdVersion` retains the old log addresses for inspection; startup
does not rename, split, discard, or automatically migrate old transcripts. Legacy
IDs truncated at 48 characters may already reference mixed histories. Those
sessions (and forks inheriting their history) reject further execution and new
forks pending repair; automatic recovery/reporting also skips them. Explicit
deletion removes the selected session and recursively owned tasks/calls, including
finished executions missing from the optional `children` index. It drains active
execution, in-flight child creation and final receipt/report writes before deleting
persisted state and traces in JSONL or SQLite. Independent topics remain separate;
ambiguous legacy logs and history still referenced by another conversation are
preserved. A subsequent
message recreates the deleted address with a fresh v2 transcript, without adopting
the retained legacy log. Failed storage deletions remain errors, not successful
deletion confirmations. Short legacy sessions retain their previous behavior. This is
history-address isolation, not a change to shared Project memory or tool permissions.

Registered folders have a project-filtered registry backed by the host
catalog's ownership index.
Their stable `folderId` is distinct from the `initiativeId` used for coordinated
work and shared context. Creating a folder conversation stores the folder ID
and a local workdir capability reference. The locality resolver obtains its
absolute directory from the backend registry, never from a display-path snapshot.
Managed scratch directories and old unassociated sessions keep their previous
behavior. Session data and uploads remain under their owning session directory
even when filesystem tools execute in an external registered folder.

`src/folders/` owns registration, canonical-path deduplication, and cancellable
Git clone operations; `src/runtime/main/` composes these with session creation and the
existing capability lookup. Electron only exposes a Main-window-validated native
directory picker. Folder HTTP routes use the existing gateway authorization
boundary. The Main sidebar also offers Open remote folder, which opens the
existing remote-capability draft picker rather than registering a Main-local
path. Git worktree/branch management is not implemented.

`subagent` requires the initial `task` for task/call execution. Legacy
`mode: "session"` fails explicitly with guidance to use topic creation.
Tasks/calls start their assignment as part of
creation and do not accept later message-tool assignments. Child sessions inherit
the spawner's workdir ownership, not an isolated git worktree.

For asynchronous task execution, persisted `reportTo` routing consumes
real turn facts and sends `subagent-complete` or `subagent-failed` to the callback.
UI command responses, tool projections, and `outbound.done` cannot produce a
spurious completion report. Calls have no `report_to`: the original tool invocation
awaits their final result and no separate completion event is emitted to the caller.
The message tool enforces execution/ownership boundaries as well as waiting for
target admission before displaying its sent projection. Optional message intent
is request/question/progress/handoff/acknowledgement. Project-validated
initiativeId/itemId references appear in the first trusted sender envelope as
context only. Receipt is not acceptance of responsibility, completion, or an
ownership transfer; use explicit guarded Initiative release/handoff/claim.

The conversation's right-hand message history rail includes human turns, incoming
session messages, and session-sourced events (including execution completions).
Previews identify the sender and message type, retaining the source session ID
when a display name is available. Selecting a marker scrolls to that message or
event in the current conversation; it does not switch to the source session.
These navigation entries do not make session messages or events resendable as
human prompts.

Call context is a snapshot, not a live shared message array. Internal tool calls
and intermediate responses stay in the child trace. Calls are blocking leaves:
no yield, session messaging, subagent creation, or deferred coordination. Missing
information/permission returns as a blocker, including partial work and side
effects, so the caller can decide or yield before another invocation. No yield
decision continuation or asynchronous one-shot child-receipt lifecycle is needed.
Caller cancellation stops its call, and cancellation/errors preserve paired tool
history. Durable topics yield to the human; temporary tasks yield to their
delegation owner, not a topic creator or historical context parent. Persisted
trace does not imply a blocked in-memory call survives a backend restart.

Call receipts retain their structured `completed`, `blocked`, `failed`, or
`cancelled` status without generic tool-output truncation. A model can return raw
JSON with `status: "blocked"`, `reason`, and `partialWork`, or `status: "failed"`
and `error` (including partial work/side effects), to make non-success explicit.
Only native subagent tool invocation supports blocking calls; embedding one in
exec/scripts/invoke_tool is rejected because those wrappers do not establish the
same caller-bound lifetime. Calls have a 120-second execution deadline and up to
10 seconds of cancellation cleanup.

Leaf calls retain role-permitted local exec with a foreground-only policy.
Its `timeout_ms` is 1–120000, defaults to 120000, and cannot be zero. Timeout/abort
waits for managed process-tree cleanup rather than detaching work or scheduling a
background completion event. Remote foreground exec inside calls is explicitly
unsupported; this does not change ordinary session/task execution. These lifecycle
rules do not constitute an OS sandbox or roll back external side effects.

The session graph exposes mode, role, structural parent, execution status, and the
optional native `parentToolCallId`. Both JSONL and SQLite preserve this correlation
field; older records can still be matched through their tool admission receipts.
The UI pins the coordinator and lists durable topic peers, while displaying delegated one-shot
tasks/calls as inspectable execution cards at their originating native tool calls,
not in a separate footer. Outbound tool events retain their IDs so parallel
results cannot overwrite or cross-pair. Executions without a matching native call
in the loaded history (such as older segments or script-created work) retain
compact inspector links under Other execution traces, rather than losing access
or guessing an invocation from a description. After a user-role message is persisted,
`session.message.appended` notifies observers; the web channel forwards received
event envelopes on the owning chat topic of the shared live connection. Completion bodies
are expanded inline, with raw metadata secondary, consistently with loaded
history. They are not synthetic assistant replies or additional call completions.
System reflection remains a separate
root activity. Internal execution records are retained even when they are not
listed as ordinary conversations.

### Compaction is continuity, not full memory reconstruction

`HandoffManager` checks configured context thresholds (default 0.95 in-loop and
0.75 during sleep). It runs a bounded, specialized handoff session to synthesize
the objective/summary/recent context, with a fallback when synthesis fails.
The next physical segment starts with that continuation and a rebuilt system
prompt. Tool-pair boundaries are respected before automatic compaction.

Session memory, scoped conventions, file tracking, and learning events are
separate mechanisms. A handoff is not a distributed transfer to another node.

## Context and memory

### Prompt assembly

`ContextBuilder` concatenates providers in registration order:

1. **Guideline:** selected agent prompt plus tool guides and the execution
   contract. There is no generic Safety checklist. Delegation,
   decision, messaging, and shell guidance is scoped by execution mode, structural
   ownership, and role tool permissions. Root/topic sessions receive task/call
   instructions, and tasks explicit call only, further
   narrowed by the role. Leaf calls receive no coordination-tool usage guide or
   background-execution advice. Tool descriptions and parameter schemas use the
   same scope, rather than advertising unavailable modes. The coordinator's
   hard capability cap excludes delegation and worker tools. The general role owns
   work strategy, the scoped Tools Guide owns invocation instructions, and the
   execution contract owns the current lifecycle and completion format.
2. **Workspace:** Home, effective local workdir or remote/unavailable capability,
   private session uploads and attachment paths, VFS entry points, memory usage
   guidance, and `SOUL.md` according to agent-type policy.
3. **Runtime/identity:** platform and shell information, channel/user/admin
   metadata, role and conversation audience, identity lookup, skill summaries,
   selectable agent types for either subagent or durable-topic creation, and
   active temporary executions only for their delegation owner. Topic-only
   coordinators see expertise/templates without gaining subagent capabilities.
4. **Initiative:** bounded shared-work context associated with the session,
   including its responsibility, dependencies, and actual execution activity.
5. **Memory:** conventions, keyword index, recent/related events, working set,
   and session memory.

The dedicated topic context provider supplies the durable topic brief separately
from Initiative responsibility and runtime delegation ownership.

MCP recovery and execution protocols remain inline, not deferred to optional
skills. Conversation guidance depends on actual audience context: direct and
explicitly configured trusted groups use normal assistant behavior; other groups
and unknown audiences receive a short shared-conversation reminder. Audience
trust is descriptive context, not tool authorization or a verified member list.

Providers are not recomputed before every token or every tool call. Prompts are
built at session creation/restoration and rebuilt at relevant lifecycle points,
including compaction. Saving a changed `trustedChats` list invalidates reusable
prompts; they rebuild before the next model request, including when preparation
was already in flight. Failed refreshes surface as failed turns rather than
sending a stale prompt. Requests already sent to a provider and one-shot tasks/
calls keep their existing context. No persisted session trust field is used:
rebuilds resolve the current bot configuration. Watchers updating the skill/type
registry do not by themselves rewrite the prompt of an already-running turn.

Runtime types are parsed from
`src/agent/types/builtin/<name>/AGENT.md` and workspace `agents/<name>/AGENT.md`.
Frontmatter controls tool allow/block lists, default execution mode, skills/Soul
inclusion, model settings, and visibility. Existing built-ins include `general`,
`sub`, `explore`, `plan`, `verify`, `reflector`, `encapsulator`, and
`soul-reflector`; retained definitions such as `general-legacy` are not a second
engine. Root repository `AGENTS.md` is a contributor guide, not one of these
runtime definitions.

Legacy `ephemeral` frontmatter maps to `defaultMode` with a visible deprecation
warning; conflicting old/new fields are rejected. `soul` is an explicit role
context preference, independent of mode. The general role prompt favors direct
work for simple continuous tasks and leaves concrete mode selection and completion
instructions to the scoped guide. It no longer requires every nontrivial action
to create agents or an alignment document.

### File-backed memory layers

Paths below are relative to the owning project's Home; they describe schemas, not data
that should be checked into the repository.

| Layer | Storage and use |
| --- | --- |
| Session summary | `memory/sessions/<safe-id>.md`; bounded text injected for continuity |
| Working set | `memory/sessions/<safe-id>.files.jsonl`; runtime hook records successful `write` tool calls, including its edit mode |
| Session conventions | `memory/sessions/<safe-id>.conventions.md` |
| Initiative conventions | `memory/projects/<initiative>/conventions.md`; legacy path retained for compatibility |
| Agent conventions | `memory/agent.conventions.md` |
| Daily knowledge events | `memory/events/YYYY-MM-DD.jsonl`; structured `when/who/what/why/challenge/refs/origin` material |
| Keyword/wiki index | Markdown names in `memory/topics`, `identities`, `concepts`, and `tools`; bodies read on demand |
| Learning watermark | `memory/.reflect-watermark.json`; identifies transcript increments already scheduled for reflection |
| Personality/identity | Project-shared `SOUL.md` and identity-manager files; distinct from user authentication |

Conventions are merged agent → initiative → session, with labels. Today's own
events are included eagerly; other sessions' events are relevance-gated by
initiative/shared modified paths when such signals exist, and capped. With no
initiative/file signals, related events can still be included up to the cap.
This is **relevance selection within a project, not a privacy boundary
between its sessions**. Other projects have separate memory stores.

The keyword index is included for the main `general` and `general-legacy` roles,
independently of their execution mode; it is not a parent/child authorization
check. The index reads the
project-wide category directories, not the proposed per-project keyword hierarchy
everywhere. Working-set tracking captures the `write` tool path, not all edits
made by shell commands, MCP tools, other applications, or all descendants.

### Learning pipelines

Each project's `LearningService` registers in-process activity aggregation
and managed fresh jobs on its existing `CronService`:

- **Reflector**, default 30 minutes after activity aggregation: compare session
  history with a watermark and ask a specialized agent to process increments.
- **Encapsulator**, default 2-hour poll of reflector completions: derive reusable
  skills/tools/agent definitions from recurring work.
- **Soul reflector**, default 12-hour poll of reflector completions: refine
  personality/identity material.

`/learn` can trigger pipelines manually. These are model-driven file updates,
not training the underlying model. The watermark advances after the reflector
execution succeeds, not when its run is merely admitted. Failed or cancelled
runs leave that increment eligible for retry; successful execution is still not
a transactional proof that all knowledge writes are correct.
Memory-link and working-set hooks assist the process but do not
provide a complete audit or correctness guarantee.

## Model providers

`providers/provider.ts` defines the common chat, message, tool-call, usage, and
model-listing contract. Implementations include:

- Anthropic's message format;
- GitHub Copilot with its own OAuth/authentication flow;
- DeepSeek, including its reasoning/thinking handling;
- generic OpenAI-compatible HTTP providers, used for OpenAI, OpenRouter,
  Gemini's compatibility endpoint, Groq, StepFun, Kimi, and custom base URLs.

`factory.ts` detects the initial provider from the configured model unless an
explicit `model@provider` is supplied. For example, dot-version Claude names
are treated as Copilot models by that heuristic. Prefer explicit provider
selection when ambiguity matters.

`AggregatedProvider` routes **bare model names to the configured primary
provider**; it does not redetect every per-session model override. An
`@provider` suffix chooses another instantiated provider or fails if absent.
Aggregation is routing and model discovery, not automatic failover.

Context windows come from `model-registry.ts` plus provider-specific overrides.
`quickModel` is used for lightweight steering classification; it does not create
an independent scheduler. Generic provider config fields do not guarantee every
specialized adapter consumes all of them.

## Tools, skills, and MCP

### Tool layers

`Tool` supplies a name, description, JSON parameter schema, execution method,
and optional read-only/opt-in/remote-workdir metadata. `Tools` owns base
registration, execution hooks, error conversion, tracing, and large-output
truncation to a Home-local scratch file. Hook failures are logged rather than
treated as authorization failures.

`SessionTools` filters base tools by agent type and owns a session-only dynamic
layer. **Dynamic tool schemas are not added to the base definitions sent to
the model.** `search` with `space: "tools:"` returns only matching invocation contracts;
`invoke_tool({name, args})` resolves known catalog IDs lazily and validates
arguments before execution. There is no "contract already disclosed" flag or
extra first-call round trip. Invalid arguments return only the affected tool's
contract, without execution; unsupported schemas fail closed. Validators are
scoped to tool instances, so reused schema IDs cannot alias across sources or
versions. Validation is not authorization. In allowlist mode, access to dynamic
tools is gated by `invoke_tool`; this must be considered when designing agent
tool policies. Sleep/reset clears dynamic tools and disconnects session-owned
MCP connections. Configuration changes and MCP tool-list notifications invalidate
affected adapters, including tools borrowed by blocking call snapshots.
After context compaction, an agent can search for an exact ID again if it needs
the schema; runtime correctness does not depend on a stale disclosure marker.

| Facility | Main implementation |
| --- | --- |
| `read` | Local text/directories, supported media/URLs, VFS; bounded remote UTF-8 read path |
| `write` | Create/overwrite, append, or match-and-replace edit; local checks and remote workdir path |
| `search` | Unified glob/grep/web/tools search; targeted contracts and paginated empty-query tool listing |
| `v:config/mcp.json` via `read`/`write` | Revision-checked, atomic Project MCP configuration without connecting |
| `invoke_tool` | Lazy connections and current-schema argument validation |
| `exec` | Managed local shell processes and inline script/tool-bridge execution |
| `kill`, `continuation`, `v:bg` | Cancel background work, attach continuation text, and inspect task status/output |
| `topic` | Project peer-topic creation/full-brief updates and Main-local folder registration |
| `message`, `subagent` | Authorized session messaging and temporary task/call execution |
| `yield` | Three-option decision requests, actual-parent routing, correlated answers and configurable waiting |
| `plan_write`, `update_convention`, `log` | Planning documents, scoped constraints, structured knowledge logging |
| `event_subscribe` | Subscribe to normalized system events |
| Lazy tools | Cron, Initiative SQL, search/MCP/tool factories |

### Initiative coordination

[`InitiativeStore`](../src/initiatives/store.ts) opens one `initiatives.sqlite`
per Project Home, independently of the selected JSONL/SQLite session backend.
Its `initiatives`, `initiative_items`, `initiative_item_deps`, and
`initiative_entries` tables store goals, assignments, dependencies, and an
append-only audit trail. Runtime-stamped creators/authors cannot be supplied by
the model. Coordinating owners and item assignees are logical session IDs, not
physical history segments.

The [`initiative`](../src/tools/initiative.ts) tool accepts only `query`;
the coordinator receives it directly rather than through forbidden dynamic invocation.
Project scope and the acting session come from dispatch context. A closed SQL
parser permits bounded, parameterized single-table queries and transactional
mutation batches, not arbitrary SQLite. There are no joins, CTEs, subqueries,
DDL, or access to session databases. Runtime views provide ready work and the
actor's todos without requiring those constructs. Ownership, dependency,
claim, and audit rules are enforced by the store, not just prompt instructions.
See the [SQL contract](../src/initiatives/README.md) for its precise grammar and
limits.

An explicit `initiativeId` survives delegation, compaction, and storage reload.
Absent that link, prompt summaries show only work the session created, owns, or
is assigned. Runtime activity is separate from recorded task status; an
inactive owner or assignee retains responsibility across sleep/recovery and needs
explicit guarded release/handoff/claim, not automatic completion, stealing, or
reassignment. Topic creation and message admission do not transfer work.
Inactive or unknown ownership is never claimable merely because its session
is unavailable. Schema version 3 adds `needs_attention`; deprecated
`needs_handoff` is an attention-only compatibility signal, not a claim/recovery
authorization. Ownership belonging to an already-deleted session remains recorded
as needing attention. No privileged recovery API/UI is added by this work;
normal owners/assignees must explicitly handoff or release while they still exist.
Deleting a session does not release its work.
Session todos are a query view of shared items. `plan_write`
remains a planning-document tool, not another authoritative task list.
Here active means a live, accepting session without pending recovery, not proof
that a model turn is currently running.

Startup imports legacy `projects/<slug>/project.md` files once, retaining their
original contents as an archive and recording migration provenance. Invalid or
changed legacy inputs fail explicitly. JSONL and SQLite session metadata
normalize legacy `projectName`/`initiativeName` to `initiativeId`, separately
from canonical Project/Folder ownership validation.

Remote-workdir sessions may import and invoke only this verified built-in
through the dynamic wrappers: it edits the owning Project's Home, never a
remote path. This exception does not enable arbitrary remote scripts, MCP
imports, or tool factories.

### Tool execution details

Names and parameters should be checked in each implementation rather than
copied from a historical prompt. Local `exec` launches a new process per command:
changing directory in one command does not change later invocations.
Its `shell: "node"` mode executes inline TypeScript in a Node child with a
session tool bridge. OS-shell names such as `pwsh`, `bash`, or `cmd` select the
ordinary managed-process path.

`yield` is called directly, not through the Node script bridge. Its question
advertises two distinct suggested options and one default; legacy three-option
requests remain readable. Binary questions render direct answer buttons; legacy
three-option questions use radio selection. The application always adds its own
custom-response entry for humans, separate from the chat composer. Root sessions expose the
question to the human; a child addresses its stored parent, not `reportTo`.
Only that parent can answer through `yield(action="answer")`; human answers
use the session yield HTTP endpoint or the `/yield` channel command. The
coordinator checks recipient, request ID and exact option before resolving
the suspended call. Session stages report `waiting` while a request is active.
Human free-text replies use the separate HTTP body `{requestId, customText}` or
`/yield <request-id> text <your response>`, with the same recipient and initiating
channel-user checks. Mixing `option` and `customText` is rejected. Text is bounded
to 4000 characters and trimmed, never accepted as an arbitrary preset or parent
answer. The tool receipt contains the text in `option` with `custom: true` and is
persisted through the ordinary paired tool result in both stores.

Global `tools.yield.timeoutMs` defaults to indefinite waiting (`null`).
`SessionConfig.yield` can override it, including explicit indefinite waiting;
removing the override restores the global default. Positive timeouts choose
the declared default on the backend, with timeout provenance in the tool
result. Policy is captured when each question opens. Cancellation never
chooses a default. This workflow is not an authorization or capability
approval mechanism.

Calls, results and policy overrides persist through the normal JSONL/SQLite
paths. Waiters/timers are process-local, are cancelled on shutdown/deletion,
and are not resurrected after restart; normal interrupted-tool history
recovery still applies.

The `write` tool returns a bounded success report after the filesystem operation
completes: path, mode, UTF-8 bytes written, resulting line count, and line-numbered
boundary excerpts. Edits also report the actual matching strategy and replacement
count; CRLF normalization, no-op edits, and the fuzzy fallback's single-region
behavior with `g` are explicit. Replacement text is literal, including `$&`.
Full writes show the head/tail, edits show surrounding context, and appends show
the old/new seam. Long lines show clipped windows around the change; their column
labels use UTF-16 code units. Reports cap output at 8,000 characters, 24 snippets,
and four replacement regions, with omissions labeled.

These previews describe the written payload and pre-write context, not a separate
post-write read-back or a guarantee against concurrent modifications. Remote
append reads its previous contents through the owning capability before the
append job; missing files start at line 1. If the existing content exceeds the
remote read limit or is not readable as text, the append can still succeed, but
its preview explicitly uses appended-text-relative lines without a whole-file
range. Other remote read failures stop the operation. Local append uses append
mode rather than rewriting the previously read contents.

### Virtual filesystem

`VirtualFs` exposes logical read/search surfaces mounted in `src/runtime/main/`:

- `v:sessions`: conversation history;
- `v:bg`: background status/output;
- `v:skills`: skill bodies/categories/resources;
- `v:config/mcp.json`: revisioned Project MCP configuration with redacted secrets;
- `v:tools`: dynamic tool and MCP source discovery without starting servers or
  revealing commands, environment values, URLs, or authentication headers;
- `v:memory`: shared file-backed knowledge;
- `v:events`: event subscriptions.

`v:tools/<name>` identifies a virtual catalog source for the internal lazy
loader, not an ordinary filesystem directory. Models
select it through `search({ space: "tools:<name>", query })` or invoke a known
tool ID. `v:memory` writes are mapped to Home's memory directory
by path helpers.

### Skills

Skills are `SKILL.md` instruction documents, not running code. A bounded selection
of metadata is disclosed first; full bodies and bundled resources are
read via `v:skills` when needed. Built-ins live in `src/skills/builtin`;
workspace skills can shadow them and are watched for changes. Metadata supports
platform/architecture, category/core presentation, and admin visibility.
These filters are not an execution sandbox for scripts referenced by a skill.
`SkillDisclosure` limits the entire metadata summary to 1,200 estimated tokens:
capped core hints, session LRU, then Project recency/cold fallback. Learned Skills
participate; admin filtering happens before ranking. Successful exact reads and
saves record use, not discovery or prompt rebuilding. Recency is memory-only,
bounded per Project/session, and never removes files or active tools. Search
continues to expose the complete permitted catalog.

`SkillEditStore` and `skill_read`/`skill_save` provide ordinary shared Skill
editing, including bundled tool sources, to durable local web topics and the
coordinator. The coordinator receives only scoped Skill access, not generic
write/exec. Raw editing reads do not register tools. Session-local read
baselines detect stale saves without model-provided revisions. The save path
validates the complete candidate, rejects unsafe paths/symlinks and invalid
declarations, stages files, and swaps directories with rollback on ordinary
commit failures. This is not crash-recovery infrastructure or an OS sandbox.
There is no retained backup/history, Git repository, or bounded-session pinning.
Built-in-only entries cannot be edited through this API. Existing Bot
authoring/publication is unchanged and remains a separate resource system.
Watcher scans discard reads racing direct manager mutations; exact Skill reads
also reload current instructions instead of waiting for the watcher debounce.

Skills are optional workflow guidance, not an MCP admission requirement. A server
does not need a corresponding skill; a workflow may use several servers, and
several skills may guide use of the same server. Indexed MCP schemas can be stale;
the current live invocation contract overrides indexed metadata and copied examples.
JavaScript/erasable TypeScript tools require an owning skill's frontmatter
`tools` map. Each alias declares `source`, `description`, `parameters` and
`imports`. Source files export ESM `async function run(args)`. Sources must be relative to the
skill directory and pass realpath containment checks; absolute paths and
standalone external modules are not accepted.

Published conversation tools use a separate immutable resource path under
`src/agent-authoring`, with the same shared execution engine as generic skill
tools. Their SKILL.md tool declaration specifies exact
`imports: [node:path, '@shadow/service-read']`; the authored role's AGENT.md must
explicitly allow each import in `allowedModules`. Absent/empty module lists
deny imports. This authored role ceiling adds to controlled skill-tool import
policy; ordinary host exec does not use the authored role ceiling.
Runtime selectors, duplicate capabilities declarations and legacy
`run(args, capabilities)` entrypoints are unsupported. Owners recreate old
tools; no local runtime data or configuration is migrated.
`@shadow/<grant-id>` exports named `call` and the same
function as default; selected bindings still grant exact HTTP targets/routes/
secretRefs and inbox IDs, never all main tools.

The shared `src/script-runtime/runtime.ts` core executes authored tools, generic
skill tools and host exec in disposable Node children. Controlled tools use
`vm.SourceTextModule`, with controlled
static/dynamic import resolution, no global process/require/fetch or default
Node loader; exec retains host authority under a separate host policy, not a
separate engine. The catalog in `src/script-runtime/module-policy.ts` permits exact
supported node: identifiers, not wildcards, npm installs or arbitrary package/
file/data/http imports. Defaults are 15 seconds wall including startup, 64 MiB
V8 old-space (not RSS/total OS memory), 32 capability calls and 256 KiB source/
JSON bounds; timeout, cancellation, completion and crash clean up the child.
Module policy and the child process are not an OS sandbox for hostile code.
Approved immutable main/developer-authored tools are trusted implementations.
Raw fs/network modules require explicit author/owner approval and carry the
child user's OS authority: they are not readFolders-limited and bypass named
HTTP-grant restrictions by design when granted. Prefer @shadow grants for scoped
HTTP/credentials. Production native filesystem tools run on Main with cwd set
to Project Home; remote workdir sessions reject them without fallback.
Raw native I/O can have nontransactional side effects even when cancellation or
a revision change later rejects the result; process isolation does not roll
those effects back.

Tests/live use the shared runner but explicit test/probe policy permits only
`PURE_NODE_MODULES`, rejecting effectful native imports even unused. Authoring
tests use synthetic @shadow receipts (including sequences and safe thrown
errors). `authoring_change` maintains independent published-base Changes with
scoped, revocable editor assignments and immutable-version check evidence.
Virtual authoring files never become live loader files. The coordinator can
edit a small prompt directly or delegate explicit paths without relaying source
bundles. Rebase is explicit and conflicts on divergent file/binding changes.

Change probe reviews pin exact source/arguments, expose only GET grant scope,
expire and authorize one bounded execution after an authenticated owner click
in the topic or coordination. New test connections need no production release.
Legacy `project_config` probes retain their unchanged-published-grant rule.
Neither route permits writes/inbox delivery. Source revision/hash and authorization
revision are distinct; no staging or publication is needed for candidate tests.
Only an explicit published target tests deployed code. Probe receipts retain
failures and transport/response evidence even when guest code catches errors.
Developers test native fs/http with
normal exec and project-local disposable fixtures, not synthetic tests.
Prompt scenarios use the ordinary ephemeral session loop with only synthetic
tools and bounded model execution, not a separate provider/tool implementation.
Preview is assembly evidence, not a model behavior test. Runs are persisted by
identity instead of recovered from chat logs or manually maintained reports.

Publication remains owner-reviewed. Durable review stores pin exact snapshots,
base revisions and affected bindings; Change publication does not overwrite a
legacy shared draft. The coordinator still has no shell/write/dynamic invocation
authority. Delegated Change operations do not confer live or deployment rights.
Nonmutating `project_config` actions `schema`, `inspect`, `read`, `preview`, and
synthetic `test` are available in
session/event-triggered turns of that same Project's coordinator. All other
actions of that legacy tool retain the direct-owner-turn requirement. The
separate Change tool validates Project, durable authoring session and assigned
resource paths on every operation; bot/group conversations and other Projects
are not authoring principals. Reads never return stored credential values.
See [Conversation agent authoring](agent-authoring.md) for formats, test inputs,
source hashes, approval and credential boundaries.

`search({ space: "skills:", query: "CSV", limit: 5, offset: 0 })` returns names,
descriptions, and read paths, optionally filtered with `skills:<category>`.
Search, index/category reads, and bundled resource reads never activate tools.
Only an exact `read("v:skills/csv-utils")` registers that skill's declarations
in the current session. This never imports source into Main for metadata.
The skill body documents arguments, so an agent can invoke a declared alias
directly after reading, without a separate preparation step; invocation
validates the declared schema and executes the source in the shared child.

Declarations persist only in `SKILL.md`; there is no Project persistence of
skill-tool registrations. New sessions and sleep/reset require another exact
skill read. Source files remain in their original locations.
After activation, `search({space: "tools:<alias>", query: ""})`
reads schema metadata without executing source. Skill search never activates
tools. Registration captures a whole-package content fingerprint and executable
text. Imports and pre/post execution checks reject changed instructions,
declarations, code or resources with an explicit reread requirement. A fresh
exact read updates only that session; no historical package is preserved.
These checks are not execution isolation and cannot undo side effects of edits
racing a running script. Rereading the exact skill refreshes
changed bundles; registrations are not shared across
sessions. Invalid frontmatter tools remain discoverable with `toolsError`,
while an exact skill read fails explicitly.
Metadata belongs exclusively to `SKILL.md`; `init`, `execute`, `callTool`,
executable metadata exports and source-path tool loading are unsupported.
Declared `@shadow/<tool-name>` imports can compose session-authorized tools
through module-call bindings, without granting access to every tool.

### Project MCP configuration and lazy loading

[`search-tools.ts`](../src/tools/search-tools.ts) ranks names and descriptions
lexically, returning complete schemas only for the top matches (default 3,
maximum 10). Global and targeted installed/configured MCP searches read a
configuration-bound persistent index, returning exact names, descriptions,
parameters and `indexedAt` timestamps. They perform zero connections or
`tools/list` RPCs, execute no tools and register no dynamic tools.
Search reports searched, failed and deferred sources rather than implying
exhaustive success. Built-in browser/factory initialization still requires explicit
source selection and may create live resources. Active session tools are also
searchable. The metadata index is not an embedding provider or a second tool registry.

After restart, persisted Project MCP configuration restores the source catalog,
not live connections or tool registrations. Cold and repeated searches work
offline from indexed metadata: 100 installed servers will not start from search.
Missing, mismatched or corrupt records produce explicit source `errors`, never
fallback auto-connections. Read/save MCP configuration to build missing metadata,
including a no-op resave of legacy configuration. Keyword misses are not proof of
absent capabilities. A session-only JSON import is not a persistent install.

MCP configuration is persistent **current Project** state. Agents use existing
`read`/`write` tools on `v:config/mcp.json`, not application configuration or
source files. The document is `{ revision, mcpServers }`, with an opaque revision
returned by the read. Reads redact secrets as placeholders; unchanged placeholders
preserve stored values. Writes retain that revision and validate the whole
document before atomic `ProjectConfigStore` persistence. Stale revisions are
rejected with a reread instruction, rather than overwriting concurrent edits.
Whole-document `write({path, content})` includes the revision explicitly.
Exact edits use `write({path, match, content, flag?})`, with `flag: "g"` for
global replacement. They operate on a remembered redacted read snapshot scoped
to both logical and physical session, require a prior read, and retain its
revision for checking inside the configuration update. Missing snapshots require
a reread, not a silent edit against current configuration.

Each `mcpServers` key names a server. Stdio entries use `{ command, args, env, ... }`;
HTTP entries use `{ type: "streamable-http", url, headers, ... }`. Add or edit
entries for configuration, remove keys for removal, and submit several changes
in one document for an atomic batch. The dedicated `mcp-config` skill documents
the read/edit workflow and secret handling. No extra installation tool or
explicit model-visible import tool is exposed.

Before writing configuration, `ProjectConfigStore` ensures persistent metadata
for each installed MCP. Missing/new/config-changed records use temporary connections
and paginated `tools/list` only, in batches of up to three with 60-second
per-source timeouts. Connections close after indexing; no tools execute and no
runtime connection is retained. Matching cached records are reused, and removal
requires no new connection. Index failure aborts the save, leaving the previous
configuration and runtime catalog unchanged.

Private content-addressed index records under Project Home `.mcp-tool-index`
are atomically persisted before the configuration commit. Records bind metadata
to configuration without storing raw configuration or credentials. Unreferenced
records may remain for rollback; ConfigStore activation rollback remains in place.
Successful installation/indexing does not guarantee current availability or future
execution. Metadata can become stale. Invoking an exact known ID still lazily
connects, lists live tools and refreshes the index, then validates the current
schema before `tools/call`; the current live invocation contract wins.

The internal lazy loader remains responsible for session connections and
modules. Unchanged connections are reused; changed configuration invalidates old
connections. Loads within a session are serialized, and sleep cancels pending
loads so they cannot repopulate a reset session. Sleep clears live session state,
not Project MCP configuration. Skill declarations must be activated again by
reading the skill. Legacy internal preload restoration is session-only
and never writes persistent configuration. See the
[configuration examples](../README.md#configure-project-mcp-servers).

User-authored TypeScript uses Node's `registerHooks` and
`stripTypeScriptTypes` in transform mode, rather than requiring packaged `tsx`.
This supports enums and parameter properties; relative imports must include
their extensions. JSX and decorators are not supported in user scripts.
Backend source decorators are handled by the build compiler instead.

`McpConnection` uses the MCP SDK for stdio, SSE, and streamable HTTP transports.
HTTP authentication can use configured headers; Shadow does not automatically
authorize OAuth or retry an executing tool with another transport. Tool discovery
follows pagination, and cancellation reaches startup and RPC requests.
Text-only successful results remain text. Errors, structured
results, and non-text content are preserved in a JSON envelope with `isError`,
`content`, and `structuredContent`; protocol-private `_meta` is not projected.
Shadow's tool-result interface is still a string: retaining image/audio/resource
blocks is not native multimodal rendering or automatic resource fetching.
[`mcp/text.ts`](../src/mcp/text.ts) normalizes Unicode escapes in string tokens of
complete JSON text, before tool-result truncation. It preserves exact numeric
literals, duplicate keys and nested string values; it does not blindly unescape
arbitrary text or change a `rawResponse` string into an object. Historical records
remain unchanged.

[`mcp/errors.ts`](../src/mcp/errors.ts) provides sanitized `mcp_error` diagnostics
inside the existing string tool-result interface. These retain the failing phase
(config read/validation, connection, listing, invocation, cleanup), server/source,
available HTTP/RPC/OS codes, safe cause messages, and recovery guidance.
Stdio stderr is captured in bounded memory and sanitized before inclusion on
failure. Known configured/inherited credential values and credential-shaped text
are redacted; arbitrary SDK objects, headers, protocol data and raw causes are
not attached to the exception. This is not a guarantee of detecting every
unlabelled secret emitted by an arbitrary server.

Cleanup failures are reported alongside the primary failure, not instead of it.
Listing failures no longer trigger a hidden reconnect/retry. The agent receives
the diagnostic through indexing or live invocation and can attempt bounded
recovery; its tool guidance asks it to explain the server, phase, sanitized cause
and required help to the user when needed. The existing conversation/tool-result
projection is reused; there is no new automatic notification or credential repair
service. A failed `tools/call` reports an unknown execution outcome and is not
marked safe to retry automatically.

Configured servers are always lazy catalog sources, including after config
reload. `McpManager`/watcher updates that catalog and invalidates affected
session connections; it never registers raw MCP tools in the base registry.
Discovery through `read("v:tools")` exposes source names and descriptions without
connections; `search({space: "tools:<source>", query})` returns individual tool contracts.
An empty, whitespace or omitted tools query lists contracts in stable name order.
`limit` (default 3, maximum 10) and `offset` bound results; `nextOffset` continues
the list or search. Partial failures and deferred sources remain explicit.
Complete tool contracts bypass generic result truncation; other search spaces
retain their existing result limits. File/web searches retain parallel-read
scheduling, while tool discovery is conservatively serialized because explicit
built-in browser/factory selection can initialize live resources.
Known MCP IDs can be invoked directly with current-schema validation. Skill
aliases can be invoked directly after the exact owning skill read. There is no
explicit model-visible import step. Saving configuration reports installed/indexed,
not guaranteed live availability; targeted MCP search reads the index too, and
tool execution is a separate operation with its own possible side effects.

Chrome DevTools has one public lazy source, `chrome-devtools`, with no
`chrome-devtools-full` alias, exposing all advertised tools without a common/full
filter. Search returns only the relevant
contracts; loading the source does not inject all schemas into the base tool list.
The dynamic catalog also exposes `browser_setup`: global
`search({space: "tools:", query: "browser_setup"})` discovers its metadata without
initializing browsers. Global `tools:` search also includes already-loaded browser
contracts with per-result `instance` IDs without reconnecting. Uninitialized
browser sources and live refresh remain deferred unless explicitly selected.
Installed MCP global search remains offline.
Invoke the known setup ID with `args: {action: "launch", browser: "edge"}` to
select `edge`, `brave`, `chrome`, or `default`, or supply `executablePath` instead
of `browser`. Explicit selections fail without fallback. Each owned launch gets
a fresh private profile; host profiles are never copied and Project configuration
is unchanged. Without setup, automatic lazy default launch remains available
in an owning session.

Explicit `{action: "attach", endpoint}` accepts only loopback HTTP(S)/WS(S)
preenabled CDP targets, including compatible Electron. Examples are
`http://127.0.0.1:9222` and `ws://127.0.0.1:9222/devtools/browser/...`.
This is separate from import arguments: raw endpoint/profile/executable flags
remain rejected. Startup import/preload arguments are pinned per instance;
changing arguments cannot silently create a second browser. Empty
`preload_tools: { "chrome-devtools": [] }` still works.

Setup connects/lists live contracts without business tool RPCs and returns
`{instance, source: "tools:chrome-devtools", mode, owned, ready, ...}`.
`search({space: "tools:chrome-devtools", instance: id, query: "snapshot"})`
reads that instance's live schemas.
`invoke_tool({name: "chrome-devtools__take_snapshot", instance: id, args: {...}})`
routes canonical tool names to isolated instance registries, never prefix variants.
One instance allows an omitted ID; two or more require explicit selection, with
no mutable current browser. Invalid/other-session IDs fail without fallback;
IDs are scoped to the session lifecycle.

Use `browser_setup` with `{action: "list"}` or `{action: "close", instance: id}`.
Separate ordinary tasks/sessions remain independent, but blocking leaf
calls/snapshots borrow their owner's instance IDs and may interact/list, not
launch/attach/close. If the owner has no browser, automatic discovery/invocation
fails asking the owner to initialize first, never silently creates a persistent
resource in a leaf.
Session sleep/reset closes owned instances and only disconnects attached targets,
never kills external targets. Browser/host tests are synthetic, not actual browser
end-to-end coverage. Browser/Windows automation still depends on optional external
tools/services; configuration fields alone do not establish native automation availability.

Web search service selection and Firecrawl, Brave, Exa and Tavily credentials
belong to App configuration. `/api/app/web-search` exposes credential presence,
not values, and saves through the shared configuration store. Projects inherit
these fields and cannot override them or persist inherited keys. Legacy
Project-local search fields are ignored with a warning, not automatically
promoted to App credentials. Existing legacy keys may remain in old files.
The runtime resolves the active App selection for each search, so saved changes
reach running Projects without replacing their tool registry. Automatic mode
prefers configured Firecrawl, Brave, Exa, then Tavily, finally keyless Firecrawl;
explicit selection does not switch services when a request fails or a key is
missing. The unified `search` tool's `web:` scheme is the entry point;
there is no separate loadable `web_search` tool or local search service.
Provider selection does not perform network probes, and requests observe the
turn's abort signal. Service reachability, rate limits, and provider behavior
remain external dependencies.

## Events, background work, and cron

Three mechanisms must not be conflated:

1. **Bus:** in-memory typed notifications with immediate subscribers and bounded
   polling buffers/aggregators. A work queue exists only after `declareQueue`;
   composition explicitly declares `message.outbound` before publishing, preserving
   FIFO messages sent before the channel consumer starts. Ordinary notification
   topics never accumulate hidden consume buffers. Async/sync observer failures
   reach the error reporter; notification emission is not an input-acceptance API.
   Shutdown stops session producers, then drains the outbound dispatcher before
   stopping the Bus. Pending event deliveries are still not crash-durable.
   It is not Redis, a message broker, or a durable event log.
2. **EventService:** normalized events with source descriptors, subscriptions,
   targets, urgency, and trailing debounce. Definitions persist under `.events`;
   writes are serialized, failures are reported, and `flush`/`stop` await pending
   writes. Delivery/debounce state remains in memory. It calls typed session delivery
   directly. `emit` awaits directed admission (or schedules the debounce window);
   independent fanout targets can partially succeed, with failures returned to the
   producer. Timer-triggered failures report correlation IDs. There is no automatic
   retry or crash replay of this pending work.
3. **Memory event log:** model-curated daily knowledge in `memory/events`, not
   the transport log of every Bus event.

`BackgroundTaskManager` keeps task records and callbacks in memory. `exec` and
other operations can outlive the originating turn and report completion through
events. Continuation text tells the resumed agent what to do; it is not a
serialized execution stack. Restarting the backend does not restore OS
processes from these records. Session-bound tasks use turn facts rather than UI
`done`. Callback delivery errors are reported separately from the real task result.

`CronService` persists user definitions in `.cron/jobs.json` and schedules them
only while the backend is running. `cron_add`, `cron_list` and `cron_remove`
are separate dynamically loaded tools, discoverable individually or via the
`cron` catalog source. No action-dispatch tool is exposed and no scheduling
tools are added to the base prompt. `cron_add` exposes `existing` (append to
an explicit `targetSessionId`, defaulting to the creating session) and `fresh`
(an independent context per run). Existing jobs require durable source/target
sessions in the current Project and messaging permission for a peer target.
`SessionManager.assertCanScheduleSession` checks access at creation and each
dispatch; missing targets are never implicitly recreated. Events carry creator
session provenance, not user/admin authority. The target retains its own agent,
tools, workdir and history. Dedicated recurring conversations are ordinary topics
created before scheduling, not a separate cron mode. The former `origin` and
`isolated` modes/boolean are rejected without migration.
Learning registers managed fresh
jobs on this same scheduler; learning configuration remains its durable source.
[`CronDispatcher`](../src/cron/dispatch.ts) delivers normalized events for append
mode and calls `SessionManager.startSession` for fresh runs. It does not create
a second provider/tool loop. Fresh runs retain validated project/workdir
references without parent transcript inheritance, and persist explicit
automation/run identity plus configuration snapshots in both session stores.
The Node implementation uses
Croner with a configured timezone for cron expressions and UTC for `every`
shorthand schedules. Weekdays use standard cron numbering (`0`/`7` = Sunday,
`1` = Monday), not Deno's old `1` = Sunday convention. The persisted format is
`{ "version": 1, "jobs": [...] }`; startup rejects legacy unversioned arrays
without executing or overwriting them. Existing schedules must be backed up
and recreated after review, not automatically converted.
Fresh dispatch waits for the actual execution lifecycle, so overlap protection
covers that run. Existing mode retains event-admission behavior: acceptance is
not completion of the resulting agent turn. There is no claim of
exactly-once execution, cross-machine leader election, or missed-tick replay.

Project-scoped `/api/automations` and `/api/automations/:id/runs` provide a
read-only fresh-job catalog and bounded run pages. Definitions without runs and
retained history for removed definitions are represented; legacy outcomes stay
unknown. The renderer groups by explicit graph metadata, keeps append sessions
in ordinary conversation lists, and reuses the shared sessions live topic to
refresh catalog/run snapshots without switching the selected history.
The sidebar and detail view share an application-injected automation catalog
keyed by normalized full API base, keeping Main hosts and projects separate.
Visible active consumers hold reference-counted leases: concurrent catalog reads,
live observers, and refresh timers are shared. The last release aborts reads,
removes the entry, and stops its observer/timer; late responses cannot update a
replacement project. Detail pagination only fetches run pages, not the
catalog again. Run-page refresh is coalesced within each detail view, not cached
globally across unrelated views. Dedicated conversation/automation navigation
composables preserve selected off-page runs without creating draft sessions.

`HEARTBEAT.pulse` is a periodically written local timestamp, distinct from cron
jobs, learning polls, and the WIP device-transport heartbeat.

## Channels, gateway, and UI

### Channels and media

`ChannelManager` instantiates enabled project bot instances for Discord,
Feishu, and QQ.
The **web adapter is created unconditionally**, even though a web `enabled`
field exists in the schema. Legacy WeChat/iLink code remains, but project
runtimes explicitly warn and do not start it; a `wechatDesktop` schema entry is
not a separately wired desktop channel. Migrated configuration is not evidence
of a running adapter.
Likewise, a comment mentioning Telegram is not a shipped Telegram adapter.

App settings retain shared Providers; each project's Bots section owns
QQ, Feishu, and Discord setup.
Within `/projects/<id>/`, `GET /api/channels` returns public bot-instance
configuration, credential-presence flags, and actual runtime state.
[`bot-setup.ts`](../src/channels/bot-setup.ts) provides POST creation and
PATCH/DELETE at `/api/channels/:instanceId`; names, credentials, and lifecycle
are independent even for multiple bots on the same platform.
[`BotInstanceStore`](../src/channels/bot-store.ts) persists the private
project-owned records. Deleting a bot retains existing conversation history.
These are Main-administration endpoints, not unauthenticated platform callbacks.
Enabling connects or reconnects; disabling stops the adapter without erasing its
credentials. Omitted secrets remain unchanged and are never returned to the UI.
Reconfiguration is serialized, and replaced adapters cannot publish stale
connection updates or deliver old inbound events.

Configuration is not connectivity: QQ and Discord become connected on gateway
readiness, not merely after saving credentials. Feishu reports `running` because
its SDK does not expose verifiable connection readiness. That SDK runs in a
terminable worker so disconnect can stop its pending requests and retries; the
session/agent loop remains in Main. Failed connections report sanitized status
messages; external configuration changes can require a restart or reapplication
through Channels. UI status polling pauses when the Channels section is hidden.

`AbstractChannel` provides sender allowlisting and response update behavior.
No/empty `allowFrom` means allow all; direct chats are admin by default, selected
groups may be admin, and the web channel is always-admin at this layer.
Those are local-agent trust assumptions, not a multi-tenant account system.

`trustedChats` separately names exact group/channel IDs whose complete audience
the operator trusts. It is configured per bot in the same validated settings
path as other public channel fields. `ChannelManager.isTrustedConversation`
resolves the exact project, bot instance and conversation; neither `allowFrom`
nor `adminChats`, an incoming message claim, another bot, or a parent Discord
channel grants audience trust. Threads must be listed separately. Missing
configuration leaves group audiences shared, and trust does not change sender
admission, tool permissions or platform capabilities.

Adapters declare destination-specific capabilities in
`src/channels/capabilities.ts`: conversation kind, formatting, outbound media,
updates, native threads, and decision presentation. `ChannelManager` filters out
missing, disconnected, stale, or failed-cleanup connections. Runtime prompt
assembly uses this capability snapshot together with role/execution-mode scope;
thread creation checks capabilities again at execution. A platform name or an
`update`/`createThread` method alone does not enable that feature. Progressive
output also respects the adapter's declared update support.

Subagent task/call executions remain internal and never create native threads.
Durable Project topics are web-visible root peers, not platform threads created
by subagent. Existing platform conversation routing remains separate from
delegation ownership and never widens tool permissions.

Discord checks the destination and permissions before creating a public thread.
Feishu keeps root message IDs as compatible routing handles, but only treats
messages carrying actual topic metadata as topic traffic; ordinary reply ancestry
is not a child session. Topic creation must be confirmed before returning a
successful handle. Card replacement is not CardKit streaming. QQ exposes its
implemented group/C2C/guild differences without advertising unimplemented stream
or button APIs; iLink declares text/image output and no editing or threads.

`yield` keeps one semantic tool. Discord/Feishu native controls call the same
coordinator as text choices, using validated request IDs and choice indexes rather
than model-generated commands. The requesting human's channel identity is frozen
in the in-memory waiter; other group members cannot answer or cancel it.
External root requests without a human source fail explicitly. Native presentation
has an isolated text fallback, and production delivery errors reject the waiter
instead of leaving an apparently delivered question waiting forever. These channel
decisions bypass the ordinary progressive response buffer. Parent-directed requests
and authenticated application-side decisions retain their existing authorization.
Raw platform messaging/history/moderation APIs are not added to base tools.

These changes do not select an execution node. A new external-channel root without
an explicit workdir uses Main's `<workspace>/<safeSessionId>` managed directory;
session storage stays under Main's `<workspace>/.sessions`. Remote execution
requires a workdir capability; automatic per-channel/group node selection remains
unimplemented.

Uploads are normally placed under the session's `uploads` directory. Message
construction and media helpers translate supported attachments for providers
and channels. Optional speech-to-text uses the configured external STT service;
it is not an embedded universal speech backend.

### Hono gateway

The default host is `127.0.0.1`, port `3123`; environment/options can override
them. Plugins expose:

- chat input/activity, uploads/media, and provider authentication;
- session/history/configuration/agent management;
- provider discovery and runtime control;
- OTLP JSON ingest at `/v1/traces`, `/v1/logs`, `/v1/metrics`;
- telemetry queries at `/v1/query/*`, with live logs/spans on `/api/live`;
- WIP pairing/node protocol endpoints.

An explicit launch bearer can protect gateway requests; some pairing/challenge/
node paths use their own protocol checks instead. Origin policy accepts the
same origin or configured origins and handles authenticated opaque Electron
origins. **CORS is not authentication**: non-browser callers need not send an
Origin header, and ordinary local startup may have no launch credential.
Provider OAuth endpoints are not a general login/authorization system for all
gateway data.

Main additionally owns browser authentication in `src/gateway/web-auth.ts`;
Electron is not an authentication dependency. Public frontend pages/assets and
`/api/web-auth/*` are reachable before login, while ordinary APIs remain protected.
An authorized local CLI issues a five-minute, single-use code through the
management-only `POST /local/v1/web-pairing` endpoint. The browser exchanges it at
`POST /api/web-auth/pair` for a twelve-hour HttpOnly/SameSite=Strict cookie.
Only hashes of random codes/session secrets are retained in bounded in-memory
stores. Failed exchanges are rate-limited. Restart drops all browser sessions;
logout and expiry abort associated live feeds and WebSocket connections.
Browser authorization is carried through scoped Project requests as well as the
shared API gateway. Browser cookies never authorize `/local`, device-pairing or
cluster-control routes; those retain their management/protocol checks.

The browser flow requires a loopback target and the TCP peer captured at the
server boundary, not forwarded client-address headers. Mutations require a
same-origin request (or the explicitly configured development Vite origin);
opaque Electron origins do not authorize browser cookies. Cookie names include
the backend port to avoid collisions between local runtimes. This is a local
browser session, not a remote deployment, per-user permissions model, or OS
sandbox. Legacy local startup without a launch credential remains unprotected.

Frontend serving is registered last: use a Vite development proxy if configured,
otherwise an available built UI, otherwise expose APIs without a frontend.
The development UI normally runs on `5273`; static UI can share the gateway.
The reverse development proxy strips management authorization and browser
cookies before forwarding frontend assets to Vite.
`OtelStore` persists telemetry separately from conversations. Traces can contain
tool arguments or other sensitive operational context.

Node tracing is initialized explicitly by `src/otel/runtime.ts`. The
OpenTelemetry Node SDK sends application spans directly to the local store;
console records are stored with their active trace/span IDs. Shutdown restores
the console and releases the provider. This replaces Deno's implicit telemetry
integration; the OTLP endpoints remain available for external ingestion.

Node's built-in `WebSocket` is used for outbound connections, including the
development proxy. Inbound HTTP upgrades use Hono's Node adapter and `ws` because
Node does not provide a native WebSocket server.

### Vue application

`app/src` uses Vue 3, Vue Router, and Vite. Chat views include conversation and
tool activity, session navigation, files/previews, and related controls;
agent, span, and log views use backend APIs. Electron `file:` loading uses hash
history; browser deployment uses web history.

Shared button styles live in `app/src/styles.css`, not `App.vue`'s scoped styles.
Use `btn` for a standard action, `btn primary` for its main action, `btn ghost`
for a quiet action, and `btn btn-sm` for compact controls. Low-specificity
defaults cover theme, focus and disabled states while preserving component-owned
icon buttons, navigation rows and other specialized controls.

The [visual design system](../DESIGN.md) records the implemented Quiet Workbench
palette. Shared light/dark tokens separate neutral surfaces, readable text,
blue interaction/selection, and success/attention/error states. Conversation
surface aliases distinguish incoming input, assistant content, and supporting
tool actions without assigning a status color to a sender identity. Ordinary
thinking, tool activity and ready states stay neutral; completed, failed and
needs-reply states retain explicit text and semantic colors.

Sidebar spacing is defined by the `--sidebar-*` tokens in `app/src/styles.css`:
32px navigation rows, 36px project headers, 16px nesting, 4px heading-to-list
spacing, 12px between projects, and 16px before separate sections. Narrow or
coarse-pointer layouts use 44px rows and action controls. Project, folder, bot,
and automation labels share explicit alignment columns; long names truncate
instead of changing row height. `FoldersSidebar` supplies these dimensions to
`TreeRow` through scoped variables, leaving the file workbench's tree density
independent.

Project navigation has pinned and hidden states, not a persistent initials rail.
When hidden, the content toolbar shows the current project and opens the full
navigation as a temporary overlay without resizing the work area. Selecting a
conversation, folder draft, knowledge view, or automation closes the overlay;
Escape and outside clicks dismiss it, and keyboard focus returns to the trigger.
Desktop users can pin it again at their saved width. The tree stays mounted to
retain disclosure and scroll state. Mobile always uses the overlay without
changing the desktop preference. Existing sidebar `collapsed` preferences now
mean fully hidden; the storage key and preferred width remain compatible.

On phone-width browser views (700px and below), `MobileChrome` replaces the four
stacked navigation rows with one 56px header. Existing global navigation and the
project sidebar are teleported into a shared drawer; the active `FileWorkbench`
owns the header's view picker and contextual actions. Hidden cached conversations
cannot retain header ownership. Desktop Electron chrome and desktop pane layout
are unchanged. Session details, rename, diagnosis, Knowledge, files and child
return remain reachable through sheets rather than extra persistent bars.

The drawer supports rightward swipes from anywhere in the viewport's left half
and leftward swipes inside the open drawer. Once horizontal intent is established,
its position and backdrop track the held finger; a 64px threshold commits the
change on release, otherwise it settles back. Vertical scrolling, multi-touch,
editing controls and code surfaces do not initiate it; browser-owned
history gestures may take precedence. The hamburger remains the reliable entry.
The mobile composer exposes plus/options and send/stop around a single-row
16px textarea; options retain attachments, model settings, execution location
and guidance for a running agent. Plain Enter inserts a newline on phones.
The frame follows the visual viewport to accommodate keyboard resizing and uses
safe-area insets. Hardware/browser-specific keyboard and gesture behavior still
requires real-phone validation.
Phone messages use 8px safe-area-aware gutters rather than the desktop 112px
column allowance. Assistant/action rows can fill the column; user bubbles retain
a 92% cap. The history rail becomes a touch-sized list in contextual actions,
reusing the same markers and scroll navigation instead of covering message text.

Message presentation distinguishes human input from session-to-session handoffs
and background events using recorded source envelopes, independently of the
model protocol's `user` role. Incoming session messages are right-aligned like
human input, with a dashed border and a labelled source-session link; they remain
excluded from human resend actions. Trace provides a separate `SESSION` filter and keeps the original
envelope available as raw evidence. Missing legacy provenance is not inferred
from a sender name or session-like ID; these labels do not grant permissions.
The web channel preserves the same sender envelope on live peer-message
projections, so progress and request cards do not wait for a history reload to
show their origin. Their headings open the source conversation (or its read-only
execution trace). Human-history markers scroll to the corresponding rendered
message in the current pane, suspending automatic bottom jumps until the user
returns to the bottom or sends another message. Sidebar yields show a highlighted **Needs reply**
badge; folded folder, bot, automation and conversation-family indicators
prioritize those waits over running work, without treating blocking calls as
requests for a reply.
Initial conversation-history loading uses a pulsing message skeleton, paused
for inactive panes or hidden documents and static with reduced-motion preferences.
Outgoing `message` calls (including `invoke_tool` wrappers) render separately from
generic tool groups with their content, a recipient-session navigation control,
and paired receipt details. Queued, silently recorded, failed and unconfirmed
results remain distinct; queue admission is not recipient completion. Historical
calls without a result do not claim delivery.
Conversation rows share the same base indentation under folders, **Chats**, and
bot groups; nested session lineage adds indentation relative to that base.
The composer accepts dropped files (including mixed image/document batches) as
pending attachments, using the same deduplication and upload path as **Add file**.
Only images receive thumbnails; dropping does not upload until Send. Image-preview
drags retain their source metadata, clipboard paste remains image-specific, and
local attachments remain unavailable for remote workspaces. Directory drops are
rejected explicitly rather than creating empty file attachments.

Chat image attachments, Markdown images, and pending image thumbnails open the
shared `ImageViewer` native modal dialog instead of navigating away. Images fit
the viewport by default; actual-size mode provides a scrollable view of large
screenshots. The dialog preserves authenticated attachment URLs and downloads,
reports loading failures with Retry, and restores focus without scrolling on
close. Markdown image affordances are added after sanitization and support
Enter/Space. Switching conversation, history segment, or active pane dismisses
the preview; background message updates do not.

Installation context and route policy distinguish Main/Child and UI scope.
These client-side policies are presentation rules, not server authorization.
The former Workspaces page is consolidated into each node's capability details;
`/workspaces` redirects to `/nodes`. Nodes consumes a versioned, allowlisted
read-only inventory, not product fixtures. The renderer validates responses,
polls every five seconds while visible, aborts requests on navigation, and
displays errors without stale online statuses or synthetic fallback devices.
Unsupported fields (including remote filesystem paths) are omitted.
Node/capability IDs are identifiers, not capability kinds.

Main's `GET /nodes/v1` combines its configured identity, registered local shell
and project workdirs, and approved/revoked Child records. Remote availability
requires an authenticated connection and a capability advertisement from that
connection, not a persisted `online` flag. Remote versions and last-seen times
are not currently reported. The route requires the launch credential when
configured; credentialless development permits only a verified loopback TCP
peer with a loopback request hostname, under the gateway's origin policy.
Pairing and administration authorization are unchanged.

Child's authenticated `GET /local/v1/nodes` reports only its local executor
capabilities and configured workdir paths. Its connected status describes the
reachable local runtime, not connectivity to Main. Local workdir availability
reflects the current directory state. These endpoints are read-only and do not
expose device credentials, public keys, or permission lists.

The application no longer installs approval fixtures or displays an Approvals
tab. The legacy `/approvals` route redirects to Nodes. Paired nodes are trusted
to run supported operations without extra prompts or grants. A live inventory
does not imply working pairing/revocation UI or complete multi-device support.

## Programmable browser I/O

`src/io/` connects first-party browser input and interaction to an agent-started
local backend. The agent uses existing execution tools to start that backend in
any language, then registers its WebSocket endpoint, input sources and initial
controls through dynamically discovered `io_capabilities`, `io_run` and
`io_surface` tools. These tools do not grant device permission or execute a
second scripting engine.

The shared Web/Electron renderer owns permission prompts, device previews,
start/stop controls and backend-driven UI. Browser events pass through Shadow's
authenticated same-origin HTTP gateway to the temporary service, so that service
does not need to handle browser CORS, Electron origins or launch credentials.
Business logic, model calls and output locations belong to the temporary
backend, not to a first-party processor/sink graph.

The shared `io` live topic only invalidates state. Bounded event requests and
an update cursor carry source/control events and asynchronous UI, preview,
status and artifact results. Finishing input stops devices but preserves the
connection while the service finishes processing; cancellation closes the
input channel. Backend processes remain managed by existing execution tools.
Active capture is not restored after a restart.

Client discovery and active capture leases have separate recovery behavior.
An idle renderer renews an expired client registration automatically, including
when returning to the foreground, without opening devices or resuming a run.
Leaving a Project drops unused cached registrations and aborts pending ones;
an active capture keeps its owning Project registered. Only the explicit
`403 client_expired` response triggers quiet idle recovery. Other failures and
failed re-registration remain visible. Losing a client during active input or
processing still terminates that execution and requires a new explicit start;
the backend's 15-second lease and consent checks are unchanged.

This is a local user-interaction capability, not full Web API coverage or a
whole-host sandbox. It does not add another script execution mechanism;
ordinary agent scripts retain their host execution privileges. Arbitrary embedded webpages,
remote capture and unattended recording are outside the first implementation.
See [Programmable I/O](io.md) for supported flows and validation boundaries.

## Electron lifecycle

`desktop/src/main.ts` owns the BrowserWindow, navigation policy, external-link
handling, directory selection, bootstrap IPC, and backend host. Web preferences
enable context isolation and sandboxing and disable renderer Node integration.
`preload.ts` exposes a narrow setup/runtime API, not arbitrary filesystem or
process execution.

`desktop/src/navigation.ts` keeps navigation within the configured renderer.
External HTTP/HTTPS links, including Markdown's `target="_blank"` links, open
through the system browser without creating another Electron window. Other
protocols remain blocked, internal routes remain in-app, and browser-launch
failures produce a desktop error dialog. This does not change browser-hosted
Markdown behavior or grant local-file access.

The shared renderer shows minimize/maximize/close only when the native window
capability exists. A normal browser bootstraps its own backend session and has no
native window controls; setup/runtime recovery remains an Electron concern.

The bootstrap coordinator persists setup state and a launch profile, initializes
Main configuration, and starts/resumes the backend before mounting the product
UI. The renderer can show first-run setup or recovery rather than pretending the
backend is ready.

The runtime host/supervisor launches the backend module in a separate process
using `ELECTRON_RUN_AS_NODE=1`, checks authenticated loopback readiness, and
requests shutdown during app quit. The launch credential remains in Electron
main; request authorization is attached only to the current renderer's requests
to the expected literal-loopback backend origin.

`taskbar-activity.ts` observes the existing authenticated project catalog and
session-stage endpoints in Electron main, independently of renderer visibility
or the selected Project. Active `llm`, `tool`, or `waiting` stages drive native
indeterminate taskbar progress; no remaining active turns clears it. Snapshot
cycles are nonoverlapping, scheduled 1.5 seconds apart, bounded to four concurrent
Project reads and a five-second cycle timeout. Unstarted/failed Project runtimes
are not initialized or retried by observation. Failed/malformed reads are logged,
without suppressing known activity in another Project. Revoked authorization,
window closure, or a lost Main connection clears stale activity and cancels
pending observation. Child hosts are not polled for Main session state.

`pnpm desktop:dev` is the local desktop development path; `pnpm desktop` targets
the current Windows installer pipeline. Build configuration and artifacts are
not evidence of clean-machine certification, signing/notarization, automated
updates, or completed Child onboarding. Those require their own validation.

## Multi-device infrastructure — WIP

### Intended boundary

Main is the agent authority: providers, sessions, memory, orchestration, and
gateway data. Child supplies machine-local capabilities rather than a second
federated agent brain. Installation role, UI permission scope, and a particular
session's execution locality are distinct concepts.

### Implemented slices

- Versioned registry/protocol contracts, PIN pairing offers/presentation, admin
  approval, device challenge proofs, and node WebSocket sessions.
- Main composition in `cluster/main-cluster.ts`, including a persisted registry
  snapshot and a `RemoteExecutor` bound to connected node sessions.
- Production Child composition with Ed25519 credential references, protected
  key-store adapters, challenge-based connection/reconnection, advertised shell
  and configured workdir capabilities.
- Versioned jobs with acceptance/status/events, cancellation/deadline handling,
  and node/capability/job ownership checks.
- Cluster owns device trust and routing, not session permission policy.
  Approved, non-revoked devices no longer carry `uiScopes` or
  `nodePrivileges`; session-specific restrictions belong at session/execution
  dispatch. This change does not introduce a new per-session policy mechanism.
  Installation-context UI visibility scopes are separate and unchanged.
  Device approval still requires owner authentication and fingerprint
  confirmation; the approval JSON contains `version`,
  `expectedDeviceIdentityFingerprint`, and optionally `credentialId`.
  Retired permission fields are rejected on this API rather than silently
  pretending to apply restrictions.
- The device registry snapshot is `<workspaceBase>/.cluster/registry.v1.json`,
  not session history. Restoration ignores retired `uiScopes` and
  `nodePrivileges` in approved/revoked records; subsequent saves omit them.
  Identity, public keys, revocation, pending pairings, and capabilities remain
  intact. Old empty permission lists no longer restrict a trusted device.
  Back up before upgrading: compatibility reads old snapshots, but does not
  promise that older builds can read newly saved snapshots.
- Supported Child operations execute directly after authenticated pairing.
  Execution approval policies, grants, queues, APIs, and the `awaiting-approval`
  job state have been removed; cancellation, deadlines, capability operations,
  and workdir boundaries remain enforced. Upgrade Main and Child together:
  wire validators reject retired approval fields, including requests that used
  to require approval. Registry snapshot restoration strips recognized legacy
  policy metadata without changing paired identities or capability ownership.
  Jobs are in-memory and are not resumed from old approval waits after restart.
- Workdir capability operations for bounded UTF-8 file reads/writes; higher
  layers provide listing, edit, and text-preview paths without giving Main the
  Child's physical root.

The credential-store adapters include Windows/WSL DPAPI, Linux Secret Service,
and macOS Keychain. macOS uses the user's default Keychain through
`/usr/bin/security`, supplies secret values through stdin, and verifies writes.
Pairing and startup require an unlocked, accessible Keychain; over SSH, run
`security unlock-keychain`, pairing, and Child startup in the same login session.
Unlocking a separate SSH connection does not guarantee access from another
security session. Keep that session alive while running the Child. Locked, denied, or
unavailable stores fail explicitly rather than falling back to plaintext.
This implementation scope is not a portability or secret-protection guarantee
on every deployment.

### Locality contract

`WorkdirRefV1` contains a node ID and opaque capability ID. Display names/paths
are presentation snapshots, not authority. The resolver returns one of:

- managed local workdir with an actual local path;
- available remote workdir with no Main-local path;
- explicit missing/offline/revoked/incompatible status.

Legacy local sessions normalize to managed capabilities derived from the owning
session. The current local resolver does not turn an arbitrary display path into
an external local-folder capability.

Tools reject remote contexts unless they explicitly opt in.
`read`/`write` have remote filesystem implementations. Session/task `exec` supports
bounded foreground OS-shell commands through the separate
`workdir.process.execute` operation on a configured workdir capability. The Child
resolves cwd, validates the supported operation, and owns
deadline/cancellation cleanup. Main's platform and detected shells are not
advertised as the remote target's capabilities. A generic `process.execute`
advertisement alone does not authorize capability-bound workdir execution.
Remote inline Node/TypeScript, background processes, call-mode exec, search,
dynamic/MCP imports and browser operations remain unsupported; a shell workdir is
not an OS sandbox.

The Main-admin-only `POST /projects/<id>/api/sessions/remote` route creates
a fresh web root from an online node/workdir capability reference after
[verified project folder registration](#remote-folder-ownership-and-upgrade-boundary).
Older Children must be updated for new project actions; existing remote sessions
retain their supported paths. The route uses ordinary session construction
and JSONL/SQLite persistence, without accepting paths or rebinding an active
conversation. Subsequent messages still go through the web channel and
`SessionManager`. No raw job-submission endpoint or second agent loop is added.
The Main renderer offers this selection in the new-conversation composer and
defers the creation request until send. It reads the same live node inventory,
disables unavailable Child workdirs, and never supplies a physical execution path.
Remote attachment staging is not implemented, so the UI does not pass local file
references off as usable remote attachments. Remote file browsing is explicit,
with bounded loading and no extra operation approval.
Git status and diff endpoints dispatch `workdir.git.status` / `workdir.git.diff`
to the owning Child. `CapabilityGit` resolves its configured workdir root and
reuses the local read-only Git implementation, including HEAD/index/workdir
semantics, path scoping, disabled hooks/filters, cancellation and size limits.
Hooks are disabled with Node's platform null-device path (`os.devNull`), not an
empty `core.hooksPath`: Git 2.55 VFS rejects the empty path even during repository
discovery (`rev-parse`).
Main and the renderer share validated Git response contracts. JSON results are
bounded to 4 MiB; job output is chunked and the Child waits for transport capacity
rather than overflowing its outbound queue. Errors, missing Git and non-repository
folders remain distinct; none triggers Main-local Git fallback. These UI routes
do not clone, stage, commit or switch branches.
The explorer combines file/Git failures into a neutral **Node offline** state
only for HTTP 503 `workdir_unavailable` (sessions) or
`remote_workdir_unavailable` (projects), with the validated locality reason
`node-offline` and non-empty `nodeId`/`capabilityId`. Project resource responses
include these additive fields from the ownership resolver's node/capability
lookup. Other reasons, authorization failures, unsupported operations, generic
503s, and ambiguous `remote-node-unavailable` execution receipts remain errors,
not evidence that a node is offline. **Check again** retries the same scoped
source; successful Git reconnection also rechecks an offline tree. Nested
folders report offline to the explorer rather than stacking alerts, and
previews use the same classification. Remote media previews first check their
owning directory because browser media elements cannot interpret API errors.
Requests are cancelled when their source or project changes; no recovery
path falls back to Main's filesystem.
Read-only Git failures retain safe operation/stage, actual exit or OS codes, and
fixed cause labels in their diagnostic message. Missing/inaccessible workdirs
are distinct from a missing Git executable. Raw stderr, arguments, paths,
configuration and environment values are not exposed; unexpected failures are
not silently treated as ordinary non-repository folders.
Authenticated Child advertisements can include bounded display-only workspace
paths, negotiated with `workdir-display-v1`; older peers omit this optional
metadata. The header uses current registry metadata rather than trusting a
renderer-supplied or persisted display path. Direct admin web root conversations
also receive a bounded live device/workdir inventory in their runtime context.
This disclosure grants no execution authority and is not exposed as fleet
inventory to public channel conversations.

### Not complete

Binary artifact transfer/staging, full remote tool parity, general remote UI
proxy/admin flows, pairing/revocation UI, recovery/retention semantics,
version-skew deployment policy, and release hardening remain incomplete.
Unimplemented roles are not represented by successful no-op lifecycle services.
Job/process state includes in-memory components; a persisted node
registry is not durable replay for the entire execution system.

## Persistence, configuration, and trust

### Home, session data, and effective workdir

The initial `agent.workspace` (default `./workspace`) identifies legacy Home;
the host derives each active project's **Home** as described
[above](#actual-storage). Inside that runtime, `agent.workspace`
is fixed to its own Home. Ordinary local sessions use a managed subdirectory
derived from a safe logical session ID.
`workspaceRoot`, when present, is the owner session ID inherited by subagents.
The locality resolver separates Home, session-data storage, and effective
workdir, even when the latter two coincide in the local managed case.

`resolveAgentPath` keeps shared prefixes such as `memory`, `skills`, `agents`,
`projects`, `.sessions`, `.plans`, and `.tmp` at Home. Other relative paths,
including `uploads`, resolve against cwd. Absolute paths are supported by the
local helper. A managed folder therefore provides project, **not isolation
from the host or other sessions**.

### State inventory

| Data | Persistence/lifetime |
| --- | --- |
| Session state and logs | `.sessions`: JSONL files/state or SQLite `sessions.db` |
| Memory and learning | Markdown/JSONL under `memory`, plus watermark and Soul/identity files |
| Agent types and skills | Workspace `agents` and `skills`; shipped definitions are application assets |
| Initiative context | Project-local SQLite work records and bounded prompt summaries; folder ownership lives in the host catalog |
| Project catalog/config | Sibling host `projects.v2.json`; per-project `config/project.json` and `config/bots.v1.json` |
| Event subscriptions/sources | `.events/subscriptions.json`, `.events/sources.json` |
| Cron definitions | `.cron/jobs.json` |
| Telemetry | Each project Home's `.otel.db`; separate host `.host.otel.db`; project composition does not use a shared `OTEL_DB_PATH` override |
| WIP device registry | Shared legacy Home `.cluster/registry.v1.json`, unless an explicit host snapshot path is supplied |
| Electron installation | Bootstrap/runtime configuration and launch profile under Electron user data, separate from agent Home |
| Active work | Bus buffers, debounce timers, session loops, task/process registries and executor job records have in-memory lifetimes |

Both `JsonlSessionStore` and `SqliteSessionStore` implement the same interface.
SQLite persists versioned session metadata including project, lineage, project/workdir,
and preload tools, not just token counters. JSONL-to-SQLite migration is an
explicit script with legacy handling; changing the backend setting is not a
promise that existing history was migrated automatically.

No general replication, backup, multi-writer transaction protocol, or
exactly-once durability follows from these stores. Some write failures are
logged while execution continues. Back up real user state deliberately rather
than using it as a test fixture.

### Configuration

`config/loader.ts` loads an explicit config or discovers `bot.config.json` /
`.bot/config.json`, overlays recognized environment variables, and validates
with Zod schemas. It can fall back to defaults when no implicit config exists.
Use the committed example for setup; local credentials/configuration are private.

`bot.config.example.json` selects `gpt-6-astra@copilot` with medium reasoning
effort, SQLite session storage, web settings,
and `restrictToWorkspace: true`. These are example choices, not all schema
defaults: the schema still defaults session storage to JSONL, and the web channel
is instantiated regardless of that example's enabled flag.

Fresh projects receive their own Home and project settings, but leave model
overrides unset. App defaults live in the host configuration; shared provider
keys remain host-owned and bot credentials have their own project store.
`GET/PATCH /api/app/model-defaults` manages App overrides;
`/projects/<id>/api/config/model-defaults` manages project overrides. Responses
include effective values, explicit `overrides`, and `inherited` values. A null
patch field removes the override. Session overrides use the existing session
config endpoint and persist in both JSONL and SQLite.

`ConfigStore` caches its first disk read and returns copied snapshots. App and
project mutations share this mechanism: serialize updates, validate, atomically
replace the file, await runtime activation, and publish the new snapshot.
Activation failure restores the previous file and leaves the cached snapshot
unchanged. Startup-only environment credentials/settings remain in memory
without being copied to disk. The project wrapper excludes shared credentials,
preserves unset overrides on unrelated edits, and resolves inheritance at runtime.

There is no configuration file watcher. Programmatic saves directly update
provider/default settings and await MCP catalog refresh; external file edits
take effect after restart. Skills and agent instruction files retain their
separate watchers. This is not a full live reload of every service or a change
to bootstrap configuration: already-running turns and connections are not
automatically replaced. Later turns resolve the latest inherited defaults.

### Trust boundaries

- **Host authority:** shell execution, imported TypeScript, MCP stdio processes,
  and automation act with the backend user's OS permissions.
- **Tool policies:** allow/block lists and remote-workdir checks apply at tool
  dispatch. `restrictToWorkspace` is a write-tool option, not blanket filesystem,
  process, network, or MCP confinement. Self-code admin checks also do not
  constrain arbitrary host code.
- **Untrusted content:** user text, attachments, web pages, tool output, and
  learned files can influence the model. Prompt guidelines are not enforced
  access-control rules.
- **Project knowledge:** separate stores/context and scoped APIs enforce
  application ownership. Session/Initiative relevance scopes within a Project are not
  privacy controls, and project separation is not multi-tenant OS/RBAC
  isolation. Authorized local web access can expose agent-owned state.
- **External services:** providers receive assembled context; MCP, STT, search,
  and messaging services have their own credentials and data boundaries.
- **Gateway:** keep loopback defaults. Explicit non-loopback hosting needs
  deployment authentication, transport protection, and exposure review.
- **Electron:** renderer restrictions and credential ownership reduce the IPC
  surface, but do not sandbox the trusted backend's tools.
- **WIP Child:** pairing trusts the node for supported operations without
  per-operation approval. Connection authentication, revocation and workdir
  routing validation remain; these do not sandbox the Child user's shell.

The development Docker stack deliberately exposes additional services, including
inspector/Xpra paths. It is a development environment, not a safe public default.
The Docker build context excludes the runtime `workspace`, local configuration,
and environment files; runtime data must be supplied separately rather than
baked into the image.

## Module map and extension points

| Module | Responsibility |
| --- | --- |
| `src/index.ts` | Stable process entrypoint and public runtime exports |
| `src/projects` | Catalog, project scopes/runtime contracts, scoped gateway/configuration, ownership validation, job namespacing |
| `src/runtime` | CLI/process roles, bootstrap schemas, readiness/control, Main/Child composition |
| `src/runtime/main` | Main host service graph, project runtime factories, registration and lifecycle |
| `src/agent` | Message router, identity, memory, prompts, background-task management |
| `src/agent/learning` | Learning service, reflection watermark and pipeline dispatch |
| `src/sessions` | Session/task/call execution, state/history stores, locality, session APIs |
| `src/sessions/handoff` | Context-threshold decisions and continuation synthesis |
| `src/providers` | Provider contracts, adapters, aggregation, model registry/auth APIs |
| `src/tools`, `src/script-runtime` | Execution context/tool contracts, tool implementations, dynamic invocation, local script bridge |
| `src/tools/hooks` | Post-tool memory-link and working-set processing |
| `src/skills`, `src/agent/types` | Built-ins, parsing, registries, workspace watchers |
| `src/mcp` | MCP client/transports/adapters and serialized catalog updates |
| `src/bus`, `src/events`, `src/cron` | In-process messaging, subscriptions, scheduling |
| `src/slash-commands`, `src/tools/shell-commands` | User slash-command adapters and separate tool-side shell-command handlers |
| `src/channels`, `src/voice` | Platform adapters, web chat/media, optional STT |
| `src/gateway` | Hono policy/serving, plugin contract, UI proxy/static serving |
| `src/otel` | Tracing, project telemetry-context integration, storage/query/streaming and distributed-job audit helpers |
| `src/browser` | Browser discovery, port allocation and process/profile lifecycle |
| `src/vfs` | Logical resource mounts |
| `src/cluster`, `src/execution` | WIP device plane, capability/job contracts and executors; local filesystem/Git/process capabilities |
| `src/utils`, `src/testing` | Shared paths/platform/media/watch helpers and test utilities |
| `app/src` | Browser renderer, shared realtime client, desktop bootstrap UI |
| `desktop/src` | Electron main/preload, setup state, authorization, process supervisor |
| `scripts`, `build.ts` | Local development, compilation/packaging, pairing, migration |

Directory siblings are modules, not a claim that they occupy the same dependency
layer. Main composition depends on domain services and execution adapters.
Execution capabilities do not depend on gateway HTTP handlers; gateway wrappers
call their filesystem/Git implementations. Platform SDKs live with their channel
adapters. Project lifecycle scopes are domain-owned, while their OTel
context bridge remains instrumentation. `bus`, `events`, and `realtime` retain
different roles: in-process notifications, session event subscriptions, and the
client-facing feed.

Source relocation does not change user `agents/` overrides, `.eval` working
directories, eval bridge URLs, CLI flags, or persisted session/automation schemas.
Historical workstream ownership tables retain their original source paths.

To extend the system:

1. **Tool:** implement `Tool`, register in composition or a lazy source, and add
   execution/policy tests. Treat read-only and remote support as behavior claims.
2. **Skill/type:** add a built-in or workspace definition, validate frontmatter,
   and use existing parser/watcher conventions. Tool policy and prompt text are
   independent.
3. **Provider:** implement `LLMProvider`, wire factory/config/model discovery,
   and test tool calls, reasoning, errors, and cancellation.
4. **Context section:** implement `SystemPromptProvider` and register its order;
   keep bounded content and clear scope.
5. **Channel:** implement the channel contract, wire configuration/manager,
   normalize messages/media, and preserve admin/sender and lifecycle behavior.
6. **Gateway feature:** add a plugin and runtime validation; keep renderer-only
   state out of authority decisions and mount before the SPA fallback.
7. **Persistence/locality:** update both stores and migration fixtures; keep
   node/capability references opaque and unavailable states explicit.
8. **Device capability:** extend validated contracts, Child handling,
   Main routing, tool locality, and UI only as each slice is
   genuinely integrated. Do not relabel an incomplete protocol as released.

## Limitations and documentation corrections

Important differences from older plans:

- Deno commands and compiled-backend designs in historical documents describe
  the earlier baseline. Current development is direct Node/pnpm.
- “Wave integrated” and recorded test counts in `docs/implementation` are
  checkpoint reports, not current validation or distributed release readiness.
- The older SQLite “only counters/config persist” diagnosis no longer describes
  the versioned metadata store.
- Projects now separate application state/context, but memory relevance
  scopes and prompt permissions still are not tenant isolation. Keyword paths
  and working-set coverage are narrower than some proposed memory invariants.
- Registry watchers do not mean every active prompt is refreshed immediately.
- A selectable WIP remote reference does not provide remote `exec`/search/MCP/
  browser parity or binary artifacts.
- Config fields are not sufficient evidence of integration: web is always
  instantiated, and `wechatDesktop`/native Windows settings are not a second
  wired channel/tool merely by existing in the schema.
- `maxToolIterations` exists in config, but the common `BaseSession` loop
  currently uses a hard-coded 100-iteration bound; do not document that setting
  as an enforced per-turn limit.
- In-memory event/task/process state, best-effort persistence paths, limited
  recovery, and external-service failures prevent claims of lossless or
  exactly-once execution.

Keep these distinctions when updating documentation: local behavior,
implemented-but-WIP infrastructure, and planned design each need their own
evidence.
