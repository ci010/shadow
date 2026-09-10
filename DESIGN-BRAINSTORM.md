> **Historical design baseline — September 2026 status notice:** this brainstorm
> describes an earlier Deno-era architecture and proposed changes. Sections
> labelled “current” below are not the current source reference. Shadow now uses
> a direct Node.js/pnpm toolchain; multi-device infrastructure remains **WIP**.
> See [current architecture](docs/architecture.md) and the
> [documentation index](docs/README.md). The original analysis is retained below.

# Shadow Architecture Brainstorm

> Status: working notes, not an ADR or committed implementation plan.
>
> Last updated: 2026-08-26

This document records the current architecture review and the design space for:

- per-session working directories;
- migrating the desktop application to Electron;
- running Shadow across multiple machines;
- the security boundary needed by both desktop and multi-machine modes.

## 1. Current Architecture

### 1.1 Runtime boundary

Shadow currently runs most backend responsibilities in one Deno process:

- channel adapters;
- the in-memory event bus;
- agent and session orchestration;
- tools and local child processes;
- cron and background jobs;
- the HTTP/SSE gateway;
- VFS, skills, memory, and configuration.

The Vue application is already separated from this backend by HTTP and SSE. The
desktop wrapper does not contain a second business-logic implementation; it opens
a native window against the same gateway.

This is a useful boundary for both Electron and multi-machine support: the Vue
renderer can remain a client, while the Deno backend can remain the authority for
agent behavior and session state.

### 1.2 Bus and session ownership

The bus is currently in-process and memory-backed. It has useful routing concepts,
including targeted sessions and named event sources, but it is not a durable or
remote transport. There is no Redis, NATS, Kafka, gRPC, or equivalent broker layer.

Sessions are also owned by one process. The active-session map, parent/child graph,
handoff, and report-to behavior all assume local and immediate access to the same
`SessionManager`.

Logical session identity is currently derived from `channel:chatId`. It has no
machine, deployment, or agent-identity namespace.

### 1.3 Home, session data, and cwd

There are currently two effective directory concepts:

1. **Home** is `agent.workspace`, normally `./workspace`. It contains shared
   resources such as memory, skills, prompts, session storage, and `SOUL.md`.
2. **Session cwd** is generated as `workspace/<safeSessionId>/`. Relative file and
   shell operations normally resolve from this directory.

Each top-level session therefore already receives a different managed folder.
Subagents use `workspaceRoot` to share the root spawner's folder. Despite its name,
`workspaceRoot` contains an owning session ID, not a filesystem path.

The shell tool may receive a cwd for one invocation, but each command starts a new
process. Running `cd other-folder` does not change the cwd of later tool calls.

Arbitrary external folders are not currently selectable or persisted per session.

### 1.4 Path resolution

`ExecutionContext.cwd` is the main runtime seam. Filesystem and shell tools resolve
ordinary relative paths from it, while selected shared resources still resolve
from Home. Absolute paths are currently accepted by `resolveAgentPath`.

The cwd abstraction is not yet used consistently everywhere:

- session file browsing derives a managed folder again;
- the workspace prompt derives a managed folder again;
- MCP stdio servers start from Home instead of the execution cwd;
- media helpers derive their own session folder;
- active-session prompt creation can omit `workspaceRoot`, so the prompt and tool
  behavior can disagree for subagents.

### 1.5 Session persistence issue

The JSONL session store serializes the complete `SessionState`. The SQLite store
currently restores only the segment counters, activity/token values, and config.
Fields such as parent, children, `workspaceRoot`, `reportTo`, agent type, project,
and preload tools are not round-tripped.

This is already a correctness issue for lineage and subagents after restart. It
must be fixed before a workdir or remote-node assignment relies on `SessionState`.

### 1.6 Tool locality

Tool execution is machine-local today:

- shell commands spawn local child processes;
- filesystem tools read the local filesystem;
- browser and Windows integrations address local applications;
- MCP supports a local stdio child process in practice;
- the eval bridge is local HTTP RPC, not a remote worker protocol.

The config schema mentions SSE and streamable HTTP MCP transports, but the current
MCP client only implements stdio. Remote MCP cannot yet be treated as an existing
distributed execution layer.

## 2. Per-Session Workdir Design

### 2.1 Separate data ownership from execution location

The current session cwd also contains `uploads/`. Pointing it directly at a Git
repository would cause inbound media and other session-private artifacts to pollute
that repository.

The design should separate:

- **session data directory**: managed by Shadow and used for uploads, generated
  attachments, private scratch data, and other session-owned artifacts;
- **effective workdir**: selected by the user and used as the default base for
  filesystem, shell, project, and development tools;
- **Home**: shared agent resources such as memory, skills, prompts, and identity.

A possible state shape is:

```ts
interface SessionState {
  sessionDataOwnerId?: string
  workdir?: WorkdirRef
}

interface WorkdirRef {
  nodeId: string
  path: string
}
```

`nodeId` may initially always identify the local machine. Including it now avoids
making an absolute Windows or POSIX path appear globally meaningful once multiple
machines exist.

### 2.2 Expected behavior

- A new session defaults to its managed session data directory as its workdir.
- A user can assign an external directory to a session.
- Subagents inherit the parent's workdir unless explicitly assigned elsewhere.
- Uploads remain in the managed session data directory.
- Shared resources continue to resolve from Home.
- A missing, disconnected, or unauthorized workdir produces an explicit state and
  error. It must not silently fall back to another directory.
- Changing the workdir affects future tool calls. Existing background processes
  retain the cwd with which they were launched.
- UI file browsing and previews show the effective workdir, with session artifacts
  exposed as a distinct location.

### 2.3 Central resolver

All consumers should use one workdir resolver rather than re-derive paths:

```ts
resolveSessionLocations(sessionId) -> {
  home,
  sessionDataDir,
  workdir: WorkdirRef
}
```

The resolver should feed:

- `ExecutionContext`;
- session file routes;
- prompt context;
- MCP process startup;
- uploads and media access;
- project tools;
- subagent inheritance;
- remote tool dispatch.

`workspaceRoot` should eventually be renamed to something explicit such as
`workdirOwnerSessionId`, with a migration for existing state.

## 3. Electron Direction

### 3.1 Recommended process model

Electron is a desktop client and optional process supervisor, not a requirement for
the brain. Keep the Deno backend instead of moving agent logic into Electron main:

```text
Desktop installation
  Electron main
  |-- launches and monitors a Child Node sidecar
  |-- may launch a Main Server sidecar when this PC hosts Main
  |-- owns native dialogs, tray, updates, and app lifecycle
  |-- exposes a minimal preload API
  `-- opens the Vue renderer

Headless installation
  Main Server runs directly as a service, container, or daemon

Vue renderer --local proxy/authenticated transport--> Main Server
```

The same Main Server binary must work with no display server, interactive desktop
session, Electron process, or local browser. The packaged Vue renderer remains the
desktop UI and reaches Main through the local Child sidecar or a local Main
connection.

### 3.2 Responsibilities

**Electron main**

- start, monitor, and gracefully stop the selected local sidecar role;
- allocate the local port and pass startup credentials;
- provide native folder selection;
- manage single-instance behavior, tray, notifications, and deep links;
- provide installation, signing, and update integration;
- locate `userData`, logs, and packaged resources.

**Preload**

- expose a minimal typed API such as folder selection and external-link opening;
- never expose general Node.js or shell access to the renderer.

**Vue renderer**

- remain a gateway client;
- add workdir/node selection and connection-state UI;
- avoid direct filesystem access.

**Deno backend sidecar**

- in Main mode, remain the authority for agent behavior, sessions, channels,
  knowledge, tools, and policy;
- in Child mode, run only connectivity, approvals, capability grants, and local
  execution;
- expose readiness and graceful-shutdown endpoints;
- validate that a selected folder is an approved capability rather than trusting
  an arbitrary renderer-provided path.

### 3.3 Packaging choice

Produce the backend in two distribution forms from the same codebase:

- a compiled sidecar packaged with Electron for desktop Main or Child roles;
- a headless Main package for Windows service, Linux systemd, Docker, and similar
  server environments.

Do not require an end user to install Deno. Builtin skills and required runtime
resources should be packaged as explicit application resources. The headless
package must not depend on Electron or bundled Chromium.

Electron owns the launcher and window role. Development and production builds
use the same Electron shell with a compiled backend sidecar; no parallel Deno
Desktop architecture remains.

## 4. Multi-Machine Design Space

The two proposed models are both valid, but they solve different product problems.
The important distinction is between an **agent identity** and an **execution
node**.

### 4.1 Option A: independent app and agent per machine

Every machine runs a complete brain with its own identity, memory, sessions, and
tools. Machines collaborate through agent-to-agent messages.

**Strengths**

- each machine remains useful while offline;
- failures and compromises are isolated by agent boundary;
- agents can develop distinct roles, memory, trust, and personality;
- natural fit for genuinely different owners or autonomous assistants;
- no central service is required for ordinary local work.

**Costs**

- conversation and memory continuity are fragmented;
- work delegation becomes a protocol problem, not a local subagent call;
- duplicate work and conflicting decisions are possible;
- delivery needs durable queues, retries, deduplication, and expiry;
- trust, identity, and authorization between agents become user-visible concepts;
- a logical task spanning agents needs provenance rather than one shared session
  history.

This model should not share a writable session store. Each agent owns its own
state and exchanges immutable messages or artifacts with peers.

### 4.2 Option B: one brain with multiple machine nodes

One backend owns identity, memory, sessions, planning, and handoff. Other machines
register as execution nodes that expose selected capabilities and workdirs.

**Strengths**

- one continuous personality and memory;
- one owner for every session, avoiding normal-case split brain;
- the existing `SessionManager`, handoff, and subagent model can remain central;
- a user can ask one agent to act on whichever machine has the required project,
  browser, GPU, application, or operating system;
- policy, audit, and approvals have one control plane.

**Costs**

- the brain is initially a single availability and connectivity dependency;
- a disconnected node cannot execute new brain-directed work;
- remote filesystem and process tools need a real RPC/job protocol;
- large artifacts need transfer, references, or locality-aware handling;
- central compromise has a larger blast radius if node capabilities are broad.

This model should not mount remote files as if they were local. A tool call should
carry a node-scoped workdir and execute on that node.

### 4.3 Recommendation: central brain first, federation later

The recommended default is:

> One logical Shadow brain owns identity and sessions. Each machine runs a Shadow
> node that can expose local capabilities. A desktop installation may host both
> the brain and a node. Independent brains may later communicate through a
> separate agent-to-agent federation protocol.

This is a layered hybrid, not simultaneous multi-master state:

```text
Agent federation plane
  Brain A <-------- signed messages/artifacts --------> Brain B
     |
     `-- execution control plane
           |-- Node A1 (same machine as Brain A)
           |-- Node A2 (Windows workstation)
           `-- Node A3 (server/GPU machine)
```

The distinction matters:

- multiple nodes extend one agent's body;
- multiple brains represent different agents;
- brains exchange messages, not internal mutable session state;
- nodes execute capability-scoped jobs, not autonomous agent turns unless they
  also host their own brain.

This direction matches the current code because session ownership is centralized
and tool execution has identifiable dispatch seams. It also leaves room for the
independent-agent model without forcing distributed consensus into `SessionManager`.

## 5. Multi-Machine Runtime Model

### 5.1 Installation modes

The desktop MVP should make the installation role an explicit first-run choice.
The Electron package supports exactly two setup modes:

- **Host Main on this PC**: runs the complete brain; a local execution node is
  optional.
- **Join as Child Node**: connects to an existing Main and exposes explicitly
  granted local capabilities.

The headless server package supports a third deployment surface, not a third agent
role:

- **Run Main Server**: runs the same complete brain without Electron or a local
  desktop executor.

The selected mode is stored in installation bootstrap config before the normal app
starts. Shadow does not dynamically switch between Main and Child during ordinary
use. Changing roles requires an explicit **Reset or reconfigure this installation**
flow that warns about local data, revokes old pairing credentials, and restarts the
setup wizard.

There is no separate Client-only desktop mode and no multi-profile UI in the MVP. A
Child's Electron renderer is already a client of Main while its node runtime
provides local execution. Independent-agent profiles and federation remain future
features.

### 5.2 First-run wizard

The first screen presents two concrete choices:

```text
How should this desktop run Shadow?

[ Host Main on this PC ]
  Create and host the agent. Stores LLM configuration, memory, wiki, sessions,
  channels, and knowledge on this PC. Local tool execution is optional.

[ Join as Child Node ]
  Connect this machine to an existing Main. Lets that agent use only the folders
  and capabilities you approve here.
```

**Main setup path**

1. Choose **Host Main on this PC**.
2. Select the Shadow data directory.
3. Configure the model provider and agent identity.
4. Initialize session storage, memory, wiki/knowledge stores, skills, and channels.
5. Choose whether this PC also exposes local folders and desktop capabilities as a
   node.
6. Finish setup and optionally choose **Add a Child Node** to display a short-lived
   pairing code or QR code.

**Child setup path**

1. Choose **Join as Child Node**.
2. Generate a device keypair and stable node ID.
3. Enter or scan the pairing code shown by Main.
4. Verify the Main and Child fingerprints on both machines.
5. Name the Child and select the local folders and capabilities it may expose.
6. Choose approval defaults for shell, browser, Windows UI, and destructive actions.
7. Persist only node/pairing config and open the renderer connected to Main.

Child setup does not ask for a model provider, agent personality, memory directory,
wiki location, channels, or session storage. Those do not run on Child.

**Headless Main setup path**

The server package provides equivalent non-GUI setup through commands and
environment/config files, for example:

```text
shadow server init
shadow server start
shadow server pairing create
shadow server nodes list
shadow server nodes approve <pending-node-id>
shadow server nodes revoke <node-id>
```

`server init` creates the data directory, agent/brain identity, TLS material, admin
recovery material, and initial configuration. Model credentials should come from a
secret store, protected environment file, or interactive terminal prompt rather
than command-line arguments. A container deployment needs equivalent one-shot init
and persistent-volume behavior.

The first Child can be approved from the server terminal. After that, an authorized
Child UI can manage pending nodes remotely. Losing all authorized clients must not
lock out the server operator; terminal/console recovery remains available and is
audited.

### 5.3 Target topologies

The design explicitly supports two normal topologies.

**LAN PC as Main**

```text
Regular PC
Main Server + optional local Node + Electron UI
  |-- Child laptop
  |-- Child workstation
  `-- Child desktop
```

This is easiest to set up and works without a dedicated server. Main availability
follows the PC's power and sleep state.

**Dedicated headless Main**

```text
Server / VPS / NAS
Main Server only: LLM, sessions, memory, wiki, channels, cron
  |-- Personal PC: Child Node + Electron UI + shell/workdirs
  |-- Laptop: Child Node + Electron UI + shell/workdirs
  `-- Workstation: Child Node + Electron UI + shell/workdirs
```

This is the preferred always-on topology. The server does not need a desktop
environment and does not expose browser automation, Windows UI, or project shell
capabilities unless an explicit server-side executor is configured later.

### 5.4 Concrete two-machine setup

Suppose Shadow is installed on machines A and B. The application binary is the
same on both machines, but the first-run wizard gives each installation a different
fixed role.

```text
Machine A                                      Machine B
┌──────────────────────────────┐              ┌──────────────────────────────┐
│ Main Server                  │              │ Electron UI                  │
│ Headless or desktop-hosted   │◀────────────▶│ Mode: Child Node             │
│                              │  encrypted   │                              │
│ Owns:                        │  connection  │ Exposes with permission:     │
│ - LLM and agent identity     │              │ - selected workdirs          │
│ - memory, wiki, sessions     │              │ - shell/browser/Windows UI   │
│ - channels, skills, secrets  │              │ - temporary local artifacts  │
└──────────────────────────────┘              └──────────────────────────────┘
```

Machine A creates `agent-alpha` and is its only brain owner. Machine B joins that
Main during its setup. B never initializes a brain; its UI acts as a client of A,
while its node service makes selected local capabilities available to A.

Both UIs therefore show the same personality, memory, sessions, and active turns
because those are loaded from A. This is not synchronization between two agent
databases. There is only one authoritative database on Main.

The pairing code should contain only a short-lived rendezvous secret and identity
information. It must not contain model-provider API keys, the agent's private key,
session data, or a permanent bearer token.

If a machine was already initialized as Main, the MVP does not silently merge or
demote it into a Child. The user must back up or export its data, choose
**Reconfigure as Child Node**, confirm deletion or archival of the local Main
runtime, and then run the Child setup path.

### 5.5 Data placement

All intelligence and durable agent knowledge remain on Main:

| Data or service                               | Main                  | Child Node                           |
| --------------------------------------------- | --------------------- | ------------------------------------ |
| Model-provider credentials and LLM calls      | Owns and runs         | Never stores or calls                |
| Agent identity, prompt, and personality       | Owns                  | Receives only required outputs       |
| Session state and conversation history        | Authoritative store   | Optional bounded UI cache            |
| Memory, wiki, knowledge index, and embeddings | Owns and builds       | Does not persist                     |
| Skills, agent definitions, cron, and channels | Owns and runs         | Does not run                         |
| Pairing and device trust                      | Owns node registry    | Stores its device key and Main trust |
| Project files and workdirs                    | Optional capabilities | Local capabilities                   |
| Shell/browser/Windows execution               | Optional executor     | Capability-scoped executor           |
| Job logs and artifacts                        | Durable receipt/index | Temporary staging and bounded audit  |

Wiki generation and indexing run on Main even when the source project is on Child.
Child performs capability-scoped file reads or deterministic local scanning, then
sends only the required content or artifacts to Main over the encrypted connection.
The resulting summaries, embeddings, links, and indexes are stored only on Main.

This means Child is not a privacy-isolated compute enclave: file content selected
for an LLM turn or wiki indexing may be transmitted to Main. Folder grants and the
UI should state this clearly.

### 5.6 One complete turn

Assume the user opens B and asks `agent-alpha` to run tests in a project that only
exists on B:

1. B's renderer sends the message to the brain on A through the authenticated
   client connection.
2. A creates or resumes the authoritative session and performs the model call.
3. The session's workdir resolves to a capability such as
   `WorkdirRef(machine-b, project-alpha)`.
4. When the agent calls the shell tool, A creates a signed, idempotent job addressed
   to B's `project-alpha` shell capability.
5. B validates the brain identity, capability grant, cwd boundary, operation, and
   approval policy before spawning anything.
6. B executes locally and streams bounded stdout, stderr, status, and artifact
   references back to A.
7. A appends the tool result to the session, continues the model loop, stores the
   updated history and memory, and streams the assistant response to the connected
   UIs.

If Main also hosts an execution node, a session may use its workdir and execute
locally without network dispatch. A headless brain-only Main has no implicit local
workdir or shell. The model should not need separate local and remote tool names; a
dispatcher selects the node from the capability-bound workdir.

### 5.7 Connection topology

For the MVP, Main should own the reachable IP address and port. Child initiates an
outbound authenticated connection to Main, registers itself, and keeps that
connection alive. Main dispatches jobs and receives results over the same
bidirectional WebSocket connection.

```text
Main                                           Child
cluster endpoint                               no inbound listener
192.168.1.10:PORT                              outbound connection
┌─────────────────────┐      WSS/mTLS          ┌─────────────────────┐
│ node registry       │◀──────────────────────▶│ node connector      │
│ job dispatcher      │  jobs/results/events  │ local executor      │
│ agent + UI API      │                        │ approval service    │
└─────────────────────┘                        └─────────────────────┘
```

This is preferable to Main dialing a listening port on every Child:

- only Main needs a firewall rule and stable reachable address;
- Child does not expose a remote shell-adjacent service on the LAN;
- registration, heartbeats, jobs, cancellation, streaming output, and reconnect
  all use one connection;
- the design can later pass through NAT using a VPN or relay without reversing the
  control protocol;
- Main remains the obvious authority for admission and node revocation.

The setup flow is therefore:

1. Main enables **Accept Child Nodes** on a dedicated cluster port.
2. Main displays a pairing payload containing its endpoint, certificate/public-key
   fingerprint, and a short-lived one-time secret.
3. Child enters or scans the payload and connects to Main.
4. Main shows the pending Child and requires explicit approval.
5. Both sides derive or exchange permanent device credentials; the one-time secret
   expires immediately.
6. Child reconnects with its device identity and advertises only approved
   capabilities.

For a LAN-first version, manually entering `host:port` is acceptable, and the QR
code can include it. A hostname is preferable to persisting a raw DHCP address.
Local discovery may suggest Main endpoints, but the fingerprint confirmation is
still required. Main should show a focused Windows Firewall setup step when the
cluster listener is enabled.

The cluster endpoint is not the existing HTTP gateway opened to the network. Main
keeps its ordinary Electron UI/API gateway on `127.0.0.1` and exposes a separate,
narrow, authenticated listener for pairing, node control, and optionally remote UI
transport.

There are three practical deployment choices:

**Direct LAN connection**

- A advertises the brain through local discovery such as mDNS.
- B connects directly with mutually authenticated TLS or an equivalent secure
  channel.
- This is useful as a development and home-LAN mode, but discovery is not identity
  and must not bypass pairing.

**User-managed private network**

- Both machines join Tailscale, WireGuard, or another private network.
- B connects to A's private address.
- This is a strong early-adopter option, but Shadow still needs application-level
  device identity, capability authorization, and request signing/channel binding.

**Shadow rendezvous/relay**

- A and B both create outbound encrypted connections to a relay.
- The relay helps discovery and carries opaque traffic when direct connectivity is
  unavailable.
- End-to-end device authentication prevents the relay from becoming the authority
  for the agent identity.
- This gives the smoothest consumer experience across NAT and changing networks,
  but adds service operations, accounts, abuse controls, and availability costs.

An initial implementation can support direct private-network connectivity first.
The protocol should nevertheless avoid assuming stable IP addresses so a relay can
be introduced without redesigning agent and node identity.

Do not expose the existing web gateway publicly for this purpose. The node/client
transport should be a separate authenticated protocol, and the renderer should use
Electron main or the local node as its connection broker.

### 5.8 Where the brain should run

If A is an ordinary laptop, the shared agent is unavailable whenever A sleeps or
disconnects. B may finish already leased jobs and buffer bounded results, but it
cannot safely continue the same agent's session by starting another brain.

There are three product levels:

1. **Personal desktop brain**: simplest first version. A must be online for B to use
   the shared agent.
2. **Always-on personal brain**: run the headless Main Server on a home server, NAS,
   or cloud instance. Desktop PCs are clients and execution nodes. This is the best
   topology for a continuously available personal agent.
3. **Brain failover**: move or replicate authority between machines. This requires
   leases, fencing, replicated storage, and split-brain recovery, and should not be
   part of the initial node implementation.

A controlled **Move brain to this machine** operation may be added before automatic
failover. It should stop the old brain, export encrypted state, transfer ownership,
rotate authority credentials, and start the new brain. If the old brain cannot be
contacted, recovery must use an explicit recovery key and revoke the old authority;
two brains must never continue the same agent profile concurrently.

### 5.9 Node identity and pairing

Each installation should generate a device keypair and stable node ID. Pairing
should be an explicit approval ceremony using a short-lived code or QR flow.

The resulting registration should include:

- node ID and public key;
- human-readable device name;
- operating system and architecture;
- protocol version;
- advertised capability types;
- granted capability instances;
- last seen time and revocation status.

Prefer an outbound persistent connection from node to brain. This avoids opening a
new inbound LAN port on every workstation and works better through NAT. WSS is a
reasonable initial transport; a VPN such as Tailscale can simplify reachability,
but does not replace application-level identity and authorization.

### 5.10 Capability model

A node must not expose unrestricted remote shell and filesystem access merely
because it is paired. It should advertise capabilities such as:

```text
filesystem: project-alpha (root=C:\work\alpha, read-write)
shell: project-alpha (cwd restricted to that filesystem capability)
browser: edge-work-profile
windows-ui: local-interactive-session (approval required)
gpu: cuda-0
```

The brain stores opaque capability IDs. The node owns the real local paths and
validates every request. This avoids teaching the brain that a path on one machine
has meaning on another machine.

### 5.11 Job protocol

Remote execution needs more than forwarding a shell string. A job envelope should
include at least:

- globally unique job ID;
- brain, node, session, and turn IDs;
- capability ID and operation;
- structured arguments;
- deadline and cancellation token;
- idempotency key;
- approval requirement;
- output and artifact limits;
- protocol version;
- authenticated request signature or channel binding.

Results should include structured status, bounded logs, artifact references, and
an execution receipt. Streaming output and cancellation are required for parity
with current local background processes.

Do not model transport retries as re-running a command. Delivery must be
at-least-once while execution is deduplicated by job ID.

### 5.12 Workdir and artifact locality

For multi-machine support, cwd must be represented as `WorkdirRef(nodeId, path or
capabilityId)`, never as a globally valid string.

- Work executes where the workdir lives.
- Session data remains owned by the brain unless explicitly transferred.
- Node-produced files return as artifact references first; transfer happens only
  when the renderer, another node, or a channel needs the bytes.
- Cross-node tasks should prefer immutable artifacts over shared network-mounted
  writable directories.
- Offline workdirs remain visible but unavailable; they are not transparently
  replaced by a local directory.

### 5.13 Agent-to-agent federation

Federation should be added after node execution is stable. It should build on a
small message protocol rather than exposing either agent's internal bus.

Useful message types include:

- request;
- accept/reject;
- progress;
- result;
- cancel;
- artifact offer/request;
- capability summary.

Every message needs sender identity, recipient identity, conversation/task ID,
message ID, reply-to ID, timestamp, expiry, signature, and deduplication behavior.

An incoming peer request should create a local session owned by the receiving
brain. It must not become a remote write into the sender's session graph. Summaries,
messages, and artifacts may cross the boundary; hidden prompts, full memory stores,
credentials, and mutable session state should not cross by default.

### 5.14 Electron UI model

The existing Vue WebUI should be packaged as the Electron renderer and remain one
shared UI codebase. Electron provides an installation context before mounting it:

```ts
interface InstallationContext {
  mode: 'main' | 'child'
  localNodeId: string
  mainConnection: 'connected' | 'connecting' | 'offline' | 'unpaired'
  uiScopes: string[]
  apiBase: string
}
```

When Electron hosts Main locally, `apiBase` points to the local backend. In Child
mode, including when Main is a headless server, the packaged UI still talks to a
local loopback endpoint; the minimal Child sidecar proxies allowed HTTP/SSE
requests to Main over the authenticated connection. This preserves the current
same-origin API model, keeps permanent node credentials out of the renderer, and
gives Electron a local setup/offline surface even when Main cannot be reached.

Loading Main's remote webpage directly in Child would be simpler for a prototype,
but is not the preferred packaged design. It couples startup to Main availability,
makes local approvals awkward, and places remote-origin content inside a privileged
desktop window.

#### Product navigation

The current WebUI is a strong engineering console, but its top-level `Agents`,
`Spans`, and `Logs` tabs should not define the product navigation. The proposed
navigation is:

- **Chat**: sessions, conversation, tool progress, and artifacts;
- **Workspaces**: granted folders grouped by machine, availability, and permissions;
- **Knowledge**: wiki, memory, indexing status, and source provenance;
- **Automations**: cron, channels, and background activity;
- **Nodes**: Main/Child status, pairing, capabilities, approvals, and audit;
- **Settings**: model/provider, agent, storage, network, and security;
- **Diagnostics**: the current Agents, Spans, and Logs views.

Installation role and UI authorization are separate. `mode: 'child'` means the
local runtime does not host the brain; it does not imply that the user is a
read-only operator. A Child paired with owner/admin scopes may remotely manage
Main's model/provider, knowledge, channels, cron, agents, storage policy, and other
settings. Those changes execute and persist on Main.

Navigation and mutations are gated by `uiScopes`, not only by installation mode.
An admin Child can see the full Main control plane plus This Machine and local
Approvals. A restricted Child sees Chat, permitted Knowledge, This Machine,
Approvals, and Connection. Local capability grants and approval decisions always
remain controlled by that Child, even when the remote user is a Main admin.

#### Persistent status and session locality

The application bar should always show:

- the current role (`Main` or `Child Node`);
- Main connection state and latency on Child;
- the active node and workdir for the current session;
- a compact count of approvals requiring attention;
- agent/model status on Main, but not a model selector on Child.

The current global model selector should move into Settings or a session-specific
control. Changing the model is an administrative action and should not occupy the
same visual priority as connectivity and workdir locality.

Every session header should have a stable locality control:

```text
[ machine-b ] [ project-alpha / C:\work\alpha ] [ connected ]
```

Changing node or workdir is explicit, shows the permission scope, and affects
future tool calls. An offline workdir remains selected with an unavailable state;
the UI must not silently switch the session to another machine.

#### Wizard and recovery screens

The Electron setup wizard is a separate route/layout from the normal app shell. It
should be short and resumable:

- desktop-hosted Main: role -> data location -> model authentication -> optional
  local node -> ready;
- Child: role -> Main endpoint/pairing -> fingerprint approval -> machine name ->
  folder/capability grants -> ready.

Headless Main uses the server CLI/config setup path and never attempts to launch
this wizard.

Channels, automations, additional model tuning, wiki settings, and additional
folders belong in post-setup Settings. Requiring them during first run would turn
the setup wizard into configuration management.

Child needs first-class non-happy-path screens for:

- Main unreachable, with retry and endpoint diagnostics;
- pairing code expired;
- certificate/fingerprint changed;
- Child pending approval on Main;
- Child revoked;
- protocol version incompatible;
- selected workdir or capability no longer available.

#### Approvals

Sensitive Child operations should appear in a local approval sheet or tray-backed
queue that cannot be approved remotely by Main. Each request shows the requesting
agent/session, operation, node, workdir, command or action summary, scope, and
expiry. Decisions should distinguish **Allow once**, **Allow for this session**,
and **Deny**. Broad permanent grants should be managed separately in Nodes or
Settings rather than offered as the easiest approval button.

## 6. Security Boundary

### 6.1 Existing gateway risk

The gateway currently defaults to `0.0.0.0`, allows any Origin, and has no general
API authentication. Session, config, chat, and file routes therefore must not be
directly exposed to a LAN or the internet.

Desktop production mode should use:

- `127.0.0.1` only;
- a randomly selected port;
- a fresh launch token passed out of band from Electron main;
- strict Origin and CSP rules;
- `contextIsolation: true`;
- `nodeIntegration: false`;
- renderer sandboxing;
- explicit navigation and external-link policy.

Multi-machine traffic should use a separate authenticated transport. It should not
be implemented by changing the current gateway host to a public interface.

### 6.2 Device and request security

The distributed design needs:

- device keypairs and revocation;
- mutually authenticated encrypted channels;
- capability-scoped authorization;
- replay protection and idempotency;
- request size, output size, and runtime limits;
- an append-only audit trail;
- clear user approvals for sensitive UI automation, credentials, and destructive
  operations;
- redaction rules for logs and artifacts;
- version negotiation and a deny-by-default compatibility policy.

Node compromise must not automatically reveal the brain's model-provider secrets.
Brain compromise must not automatically grant unrestricted access to every paired
node; node-side policy remains authoritative.

## 7. Failure Semantics

### 7.1 Brain unavailable

- Existing node jobs may finish according to their issued lease.
- Nodes buffer bounded results until reconnect or expiry.
- Nodes do not begin new autonomous agent turns unless they host a separate brain.
- The UI clearly distinguishes disconnected brain, disconnected node, and a busy
  but connected node.

### 7.2 Node unavailable

- Sessions and history remain available at the brain.
- Workdirs on that node become unavailable, not remapped.
- Queued jobs have visible expiry and cancellation behavior.
- The agent may ask the user to select another capability, but should not silently
  execute against a different filesystem.

### 7.3 Duplicate or delayed delivery

- Job and message IDs are globally unique.
- Receivers persist a bounded deduplication window.
- Results arriving after cancellation or expiry are stored as late receipts but do
  not automatically resume the agent turn.

### 7.4 Split brain

The first implementation should avoid brain failover rather than pretend local
SQLite or JSONL can provide distributed ownership. High availability would require
explicit session leases and a replicated authoritative store. It is a separate
project from adding execution nodes.

## 8. Proposed Evolution

### Phase 0: correctness

- Make SQLite round-trip the complete `SessionState`.
- Fix active prompt context so its displayed workdir matches runtime behavior.
- Add restart tests for parent/child lineage and workdir ownership.

### Phase 1: first-class local workdirs

- Separate session data directory from effective workdir.
- Introduce `WorkdirRef` with a local node ID.
- Add a central location resolver.
- Route tools, prompts, file APIs, MCP, uploads, and subagents through it.
- Add Electron-mediated folder grants.

### Phase 2: desktop shell and headless Main

- Add Electron main and preload processes.
- Add the installation-level Main/Child first-run wizard and bootstrap config.
- Start the complete Main Server sidecar in desktop-hosted Main mode and a minimal
  node sidecar in Child mode.
- Package the compiled Deno sidecars with Electron.
- Package the same Main Server as a headless service/container with CLI bootstrap,
  persistent storage, health checks, and terminal node administration.
- Add readiness, shutdown, logs, crash reporting, signing, and updates.
- Harden the local gateway.

### Phase 3: brain/node protocol

- Introduce a stable node identity and pairing flow.
- Extract a local/remote `Executor` boundary from tool execution.
- Implement capability advertisement and node-side validation.
- Add WSS job streaming, cancellation, deduplication, and artifact references.
- Keep session and handoff ownership on one brain.

### Phase 4: remote workdir UX

- Show node availability and capability-scoped folders.
- Support assigning a session to a workdir on another node.
- Add approval, audit, artifact preview, and transfer UI.

### Phase 5: independent-agent federation

- Define signed agent identities and peer trust.
- Implement durable agent-to-agent task messages.
- Create local receiving sessions rather than sharing session state.
- Add explicit memory/artifact disclosure controls.

## 9. Decisions Suggested, Not Final

- Default to one brain with multiple execution nodes.
- Limit the Electron MVP setup wizard to **Host Main on this PC** and **Join as Child
  Node**.
- Make Main Server headless-first: Electron and a desktop environment are optional
  clients, not brain dependencies.
- Keep the selected role fixed during normal use; role changes require an explicit
  reset/reconfiguration flow.
- Keep all LLM calls, memory, wiki, knowledge indexes, sessions, skills, channels,
  and cron on Main.
- Keep the Child runtime limited to remote UI/proxy, pairing, approvals, local
  capabilities, execution, and temporary artifact staging. An authorized Child UI
  may still administer data and services that remain hosted on Main.
- Treat another independent brain as another agent, not another replica.
- Allow, but do not require, Main to run a local node. A dedicated server normally
  runs brain-only; a desktop-hosted Main may expose local capabilities.
- Keep session state single-owner; do not synchronize writable SQLite/JSONL files.
- Represent workdirs with node identity from the first local implementation.
- Keep uploads and session-private artifacts out of user repositories.
- Package Main Server both as an Electron sidecar and as a standalone headless
  service/container.
- Use a separate authenticated node transport rather than exposing the web gateway.

## 10. Open Questions

- Is the primary multi-machine use case one user with several personal machines,
  or multiple users/teams sharing nodes?
- Must the brain remain available when the main desktop is asleep, implying a
  server/NAS deployment?
- Should Child Node use one combined agent/approval window, or a normal agent window
  plus a separate tray approval queue?
- Which capabilities require approval every time, once per session, or once per
  device pairing?
- Can a session switch workdirs/nodes mid-conversation, or should that fork a new
  session for stronger provenance?
- How much artifact data should the brain cache, and for how long?
- Are channels such as Discord attached to exactly one brain identity, or can an
  independent agent federation share a public channel?
- Is end-to-end encryption between brains required even when transport already uses
  mutual TLS?
- What is the expected behavior when the brain is online but a selected desktop
  node is locked or has no interactive user session?
- Is future brain high availability a real requirement, or is backup/restore enough?

## 11. Relevant Code Areas

- `src/sessions/base-session.ts`: constructs the current execution cwd.
- `src/utils/paths.ts`: managed session paths and relative-path policy.
- `src/sessions/session-store.ts`: session state and lineage model.
- `src/sessions/session-store-jsonl.ts`: complete JSON state persistence.
- `src/sessions/session-store-sqlite.ts`: incomplete state persistence today.
- `src/sessions/session-manager.ts`: session ownership, prompt context, and subagents.
- `src/sessions/routes.ts`: session config and file APIs.
- `src/tools/shell.ts`: local shell dispatch and per-call cwd.
- `src/agent/process-manager.ts`: local process execution seam.
- `src/tools/load-tool.ts` and `src/mcp/client.ts`: MCP locality.
- `src/tools/subagent.ts` and `src/tools/message.ts`: local delegation and reporting.
- `src/bus/bus.ts` and `src/events/service.ts`: in-process routing primitives.
- `src/gateway/server.ts`: current listener and CORS policy.
- `src/channels/web.ts`: chat, SSE, uploads, and broad media route.
- `scripts/desktop.ts`: unified Electron development and packaging launcher.
- `src/index.ts`: runtime assembly and backend lifecycle.
