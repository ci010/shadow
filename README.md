# Shadow

Shadow is a personal LLM agent with persistent sessions, tools, memory, reusable
skills, subagents, messaging integrations, and a Vue web UI. It runs on **Node.js**
and can be hosted inside an **Electron** desktop application.

**Multi-device infrastructure is work in progress.** Main/Child runtime roles,
pairing, execution capabilities, and product UI scaffolding exist, but they do
not imply a production-ready distributed system.

The [frontend I/O guide](docs/io.md) describes user-approved browser capture panels
connected to agent-started adhoc services, with backend-driven controls and files.

## Projects

Projects are persistent ownership boundaries, not just sidebar folders.
Folder and Repository refer to a Project's file resources, not another layer
of projects.
The sidebar shows multiple project groups together: **there is no global
project switcher**. Their conversations, bots, and background runtimes can
run concurrently; selecting a conversation does not retarget another group's
work. Each group has folders/repositories, retained **Start from scratch** chats, and
**Automations** that start a fresh context for each run.
Click a project's name to open **Project coordination**; only the arrow to its
left expands or collapses its children. Coordination has no separate sidebar
item, and opening it leaves the group's expanded state unchanged.

Use the pencil beside a conversation's heading to rename it. Enter saves and
Escape cancels; names are trimmed, non-empty, single-line, and at most 120
characters. The saved display name updates the sidebar and survives restarts
with either JSONL or SQLite storage. Renaming never changes the session ID,
history, folder, or topic goal/scope, and takes precedence over generated titles.

Each project owns its Home, sessions, context, memory, identity/Soul,
workspace skills and agent overrides, learning, bots, and diagnostics.
**Automations** is a UI grouping within that ownership boundary, not a
separate project. A session belongs to one project and at most one
registered folder. Local folder registration rejects another project's folder
and overlapping parent/child paths; code stays in its original folder.
Agent messaging, forks, and delegation cannot target another project's
sessions. This is application data/context isolation, **not an OS sandbox**:
`exec`, imported code, and MCP still have the backend user's host permissions.

**Start from scratch** leaves the registered folder unselected, but the agent
still receives its current project's identity and a bounded summary of the
project's registered folders. It can read/search `v:project/folders` for the
complete current folder metadata and availability, scoped to that project.
This is discovery, not a working-directory change or additional permission.
Remote paths are display metadata only; remote operations still need their
node/workdir capability. Folder contents, READMEs and repository instructions
are not automatically loaded. Delegated sessions still inherit the parent's
folder/workdir; this does not add cross-folder execution.

Provider connections/credentials and device pairing remain App-wide.
Project settings (the gear beside its name) control **General**, **Models**,
**Bots**, and **Learning**. Model, effort, and temperature resolve independently:
**conversation/draft → project → App → built-in defaults**. Every editable layer
can be unset; the built-in model is `gpt-6-astra@copilot` with `medium` effort.
App defaults are in **App settings → Models**. Unset project settings follow
App defaults without copying the resolved value into project configuration.
Conversation overrides remain local to that conversation.
Changing shared provider credentials does not overwrite other projects'
model preferences. A failed project reports its own startup error with
**Retry project startup**; healthy projects remain usable.

The Projects sidebar resizes from its right edge (or with arrow keys on
the resize handle) and collapses into a narrow project-icon rail. Width
and collapsed state are remembered on this installation. Selecting a rail icon
expands that project's group without changing the current conversation.

Use a folder row's **...** menu, or right-click the row, to **Remove folder**
or **Move to project...**. Both actions change membership only: they never
move or delete files on disk. Existing conversations, memory, and learning stay
in the original project; those conversations lose access to that folder.
The destination starts with a new folder identity, not transferred history.
Stop active work in the source project first; busy checks conservatively
cover the whole source project. Overlapping folder ownership and remote
jobs whose termination is unconfirmed can also block the change. Unconfirmed
remote jobs remain blocked across restart; automatic recovery is not yet
implemented. These controls do not delete or merge projects.

### Storage

The host storage root is a **sibling** of the configured `agent.workspace`:
`${workspaceBase}.projects`. Its catalog is `projects.v2.json`. Each project
uses `projects/<id>/workspace` under that root, with adjacent
`config/project.json` and `config/bots.v1.json`.

The renameable **Default** project (`default`) starts with a fresh Home when
this catalog is absent. Existing Homes outside this layout
are not copied, imported, or migrated. Old directories are not
deleted, but their histories and memory will not appear in the new catalog.
Shared provider credentials and the device registry retain their existing
locations. See [project storage and routing](docs/architecture.md#projects-ownership-storage-and-routing)
for the layout.

Project content requests use `/projects/<id>/` plus their existing
`api/...` or `v1/...` suffixes. The App catalog is `/api/projects`; scoped folder
registration uses `/projects/<id>/api/folders`. Only canonical Project routes
and ownership fields are supported, without alternate scope aliases or field
translation. Shared provider/device routes remain at the
root. Unscoped content routes always
refer to **Default**, never whichever conversation happens to be visible.

**Remote project folders:** an updated Child advertising `workdir.identity`
can verify and register its selected folder in the owning project before
the first session is created. Main checks Child-reported directory/ancestor
identities, never canonicalizing a remote display path on Main. Another
project cannot claim an identical, aliased, or overlapping folder on that
node. Registered remote folders retain their capability references and
ownership reservations across restart; those reservations must be verified
before new folders are opened on the same node.
Registration and access to registered folders revalidate every saved claim and
folder on that device. An unavailable or retargeted **other** saved capability
can therefore also block opening a new session in an existing folder or reading
its resources. Ownership checks intentionally fail closed: restore and
revalidate the affected capability, not a Main-local fallback. Existing session
records remain preserved.

Older Children without this operation return
`409 remote_workdir_identity_unsupported` with `upgrade_node` for new folder
actions; existing remote sessions retain their supported execution paths.
An unavailable device/workdir returns `503 remote_workdir_unavailable`.
Update Main and Child, then reconnect. The Mac/WSL SSH test environments also
need that Child rollout; they are not portable, autostart-capable releases.
Passing native tests does not upgrade or restart already-running Child processes.
Remote folder listings, UTF-8 text previews, and Git inspection use the owning
Child. Raw/static remote media remains unsupported (`501`), as does remote
cloning. These additions do not complete distributed release hardening.

### Knowledge: memory, wiki and skills

Use the book icon beside a project to open **Knowledge** beside **Conversation**
in the existing document tab bar, not a separate page. Switch between knowledge,
conversation and file tabs without discarding the conversation or its draft.
Close Knowledge with its close button, middle-click or Ctrl+W; closing the tab
does not delete knowledge. Existing Knowledge links open the same workspace tab.
Browse that project's memory files, wiki pages and effective skills. Search
titles, paths and descriptions, inspect content and source, and follow incoming
and outgoing references. The relationship graph shows explicit Markdown links,
event `refs` and learned-skill associations, including missing targets; it does
not infer semantic relationships. Category/search filters retain direct graph
neighbors, and focus mode shows one entry's immediate relationships.

Management requires Main administrator access. Built-in skills are read-only.
Deletion requires confirmation with incoming references and a content revision
check. It removes only the selected file, not referring entries: dangling
references remain visible. A daily JSONL log is deleted as an entire file, not
one event. Skill deletion removes its `SKILL.md` and updates discovery while
retaining bundled resources; a same-name built-in becomes available again.
Already loaded session instructions and conversation history are not erased,
and future agent learning can recreate deleted knowledge. Refresh to pick up
changes made by agents or other windows. Knowledge lives in the owning Project
Home, never in a session's remote workdir.

**Link health** runs a separate deterministic scan once per day, with an overdue
check after startup, and offers **Scan now** in Knowledge. It shares CronService's
project-scoped scheduling and shutdown, but creates no agent session, calls no
model, and is independent of the three learning pipelines. The most recent
report is persisted per Project; restarting Main does not reset its daily due
time. Failed scheduled scans retry at most once a minute and surface an error.

Catalog absence is not proof of a dead link. Reports distinguish confirmed
missing local targets, unavailable/unsafe-to-inspect targets, and existing files
outside the browsable catalog. External URLs are not probed. Scans never rewrite
content. **Preview Wiki repair** shows the original and proposed contents for
one Wiki file; **Confirm repair** replaces eligible missing links with their
label text. Source/report revisions and target absence are rechecked before the
write. Session memories, event-history refs, skills, built-ins, unavailable
targets and ambiguous links remain review-only. No page is deleted or recreated,
and no replacement target is guessed. Refresh or scan again after a conflict.

### Initiatives: shared work, not another folder

The former `project` tool is now `initiative`: Project-local SQLite records for
goals, work items, dependencies, and an append-only activity log. Creator,
coordinating owner, and item assignee are separate logical session IDs. Claims
and changes are transactional; stopping a session does not complete its work or
silently transfer responsibility. Responsibility survives sleep and recovery;
inactive owners/assignees are not available for automatic stealing. Use explicit
guarded release, handoff, and claim operations.
Inactive or unknown ownership is never automatically claimable. Initiative schema
version 3 exposes `needs_attention`; deprecated `needs_handoff` remains an
attention-only compatibility signal, not permission to take ownership. Work owned
by an already-deleted session remains recorded as needing attention. This work
adds no privileged recovery API or UI: the normal owner/assignee must explicitly
handoff or release while the session still exists. Deletion does not release work.

Agents discover the built-in Initiative schema with
`search({space: "tools:initiative", query: ""})` and issue bounded SQL through
`invoke_tool`; no installation or explicit import is needed.
The restricted Project coordinator instead uses its direct `initiative` tool;
its runtime cap excludes `invoke_tool`.
This is a documented SQL subset, not arbitrary SQLite: single-table reads,
guarded writes and batches are supported; joins, CTEs, subqueries, DDL, and
access to other databases are not. Read-only views expose ready work, the
current session's todos, and activity/handoff information. Session todos are
views of shared items, not a second task database; `.plans` remains available
for design and planning documents. Small requests need no Initiative.

Existing `projects/<slug>/project.md` work records are imported once into
`initiatives.sqlite`, retaining the originals as read-only archives. Legacy
session links migrate in both JSONL and SQLite without changing logical IDs.
This tool also works for remote-workdir sessions because it accesses only the
owning Project's Home, not the remote filesystem. Other remote dynamic
tools, scripts, and MCP imports remain unsupported.
See the [Initiative SQL contract](src/initiatives/README.md) for schema,
permissions, limits, and migration errors.

## Documentation

| Document | Purpose |
| --- | --- |
| [Architecture and features](docs/architecture.md) | Global view of the agent, key design, execution flow, and implementation status |
| [Contributor instructions](AGENTS.md) | Repository guidance for coding agents and contributors |
| [Documentation index](docs/README.md) | Current references versus historical designs |
| [Distributed desktop workstreams](docs/implementation/README.md) | WIP multi-device contracts and implementation plans |

## Requirements

Use **Node.js 24.15 or newer** and **pnpm 12.3.1** (pinned in `packageManager`
for availability on the configured Microsoft npm proxy). Deno is not needed to
develop, build, or run Shadow.

```sh
npm install --global pnpm@12.3.1
pnpm install
```

All three packages use the root `pnpm-lock.yaml`. Do not run `npm install` inside
`app` or `desktop`. Dependencies are installed with pnpm's explicit build-script
allowlist in `pnpm-workspace.yaml`.

The project `.npmrc` uses `https://packagefeedproxy.microsoft.io/npm/`.
The pnpm hook keeps package tarball downloads on that proxy even when registry
metadata advertises an upstream feed URL. Missing mirror versions are pinned to
the nearest available stable releases in the manifests and workspace overrides.

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

`pnpm desktop:dev` also loads the repository's optional `.env` before launching
Electron and its backend. For example, `DEEPSEEK_API_KEY` enables DeepSeek without
copying the key into saved provider settings. Existing shell variables take
precedence. This development behavior does not bundle `.env` into the installer.

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

### Browser access without Electron

Electron is an optional setup/native-window host, not the backend's login server.
A Node process or the [Windows service](docs/release.md#opt-in-headless-windows-service)
can own the backend while a normal browser opens its loopback gateway URL.
Only Electron shows the native minimize, maximize and close controls.

For temporary local administrator access, place a shared PIN in `.pin` in the
backend process's working directory (the repository root for development).
`desktop:dev` explicitly forwards the repository-root path despite launching
Electron from `desktop`. Set `SHADOW_BROWSER_PIN_FILE` to select another file
when launching a backend from elsewhere; this variable is a path, not the PIN.
Use a private, hard-to-guess value of 4–128 characters on one line. The root
`.pin` is Git-ignored; never put it in URLs, frontend configuration, or logs.
Restart the backend after creating, changing or removing the file. Main reads
it at startup and keeps only its hash in memory; an invalid/unreadable file
fails startup rather than disabling authentication. With this file present,
the browser login defaults to **Administrator PIN**, even when no launch
credential is configured. The same PIN can sign in multiple local browsers
and be reused after expiry or backend restart. Browser sessions still expire
after twelve hours; the PIN itself does not expire. One-use pairing remains
available when a launch credential is configured.

When the gateway has a launch credential, its frontend shell opens a browser
pairing screen instead of requiring the management credential in the browser.
In Electron's Main window, click the browser icon beside the theme button
(**Connect browser** on hover) to generate
a one-use code, then **Copy code** and **Open Web**. The panel shows the browser
address and expiry, and can generate a new code when needed. Closing the panel
clears its displayed code but does not revoke an unused code before expiry.
This entry is Electron-only; issuance uses Main's protected connection without
exposing its management credential to the renderer.

Without Electron, generate a one-time code using an authorized local terminal:

```powershell
pnpm web:pair --connection 'C:\ProgramData\ShadowService\control\connection.v1.json'
# Or select a protected credential file and its explicit loopback backend:
pnpm web:pair --url http://127.0.0.1:18800 --credential-file 'C:\ProgramData\ShadowService\control\launch-token'
```

Open the printed URL and enter the code. Codes expire after five minutes and can
be used once. Browser sessions last twelve hours, use an HttpOnly/SameSite=Strict
cookie, and are invalidated by logout or backend restart. Logout/expiry also
closes that session's live event/WebSocket connections. Browser sessions do not
grant access to service readiness/shutdown, pairing-code issuance, or device
enrollment controls. Management credentials stay outside the renderer, browser
storage and URLs. Keep pairing codes private until used.

This is local loopback browser access, not an Internet-facing login system or
multi-user authorization. PIN login grants the same application administrator
access as pairing, not service management/device-enrollment credentials.
PIN and code attempts share the same throttle (20 attempts per minute).
An ordinary local backend without a launch credential or `.pin`
retains its existing unprotected behavior. Closing Electron still stops an
Electron-owned sidecar; a separately started Node backend or Windows service
continues independently.

## Electron

```sh
pnpm desktop:dev
pnpm desktop
```

If Corepack cannot download the pinned pnpm version, use
`npx --yes pnpm@12.3.1 desktop:dev` to bypass Corepack through npm.
The Electron launch shortcut in `.github/github-app.yml` uses this command.
Keep its pnpm version aligned with `packageManager` in the root `package.json`.

The development command builds the backend and Electron main/preload, starts
Vite, and launches Electron. Vite follows the backend origin reported by Electron
instead of assuming port `3123`; it returns a retryable `503` while that runtime
is not ready. Only the origin crosses this development IPC boundary, not the
management credential. Plain `pnpm dev` retains its normal backend target.

After an owned desktop backend is ready, the terminal prints the
deployment-specific pairing command for its live descriptor under
`<userData>\control\web-access\connection.v1.json`. On Windows, the associated
credential is protected with CurrentUser DPAPI and a restrictive DACL. The
descriptor expires after five minutes, is refreshed while the backend is ready,
and is removed on stop. An attached service uses its existing protected service
descriptor instead.
Source checkouts use `pnpm web:pair`; built runtimes support
`node dist\src\index.js web pair` without starting another backend.
For the installed Electron Node runtime, see the
[installed pairing command](docs/release.md#opt-in-headless-windows-service).

The packaging command runs typechecks and the
focused release tests, builds the production UI, creates a Windows NSIS
installer in `desktop/release`, and verifies that fresh package. See
[release verification](docs/release.md) for download mirrors/caches, artifact
identity checks, and the remaining Windows installation/service acceptance boundary.

On Windows, the taskbar icon shows an indeterminate progress indicator while
any Project has an active agent turn (thinking, using tools, or waiting).
This is maintained by Electron main, including while the window is minimized;
it clears when all turns stop. Desktop main-process changes require restarting
`pnpm desktop:dev`; renderer hot reload alone does not apply them.

Desktop development uses a separate profile at `.tmp/desktop-dev/user-data` in
the worktree, rather than the installed application's profile. An absolute
`SHADOW_DESKTOP_USER_DATA` path can override it. In packaged applications, the
Main directory defaults to the OS home directory's `.shadow` folder (shown as
an expanded path); it can be edited or selected with Browse. Existing saved
Main directories are preserved. Development instead defaults Main to
`.tmp/desktop-dev/data` to avoid using personal data during smoke tests. The
absolute `SHADOW_DESKTOP_DEV_MAIN_DIRECTORY` override applies only to development.

Startup no longer probes optional web-search services: SearXNG discovery runs on
the first search when no Firecrawl/Brave key is configured. Up to three Projects
initialize concurrently, after persisted workdir ownership has been checked.
The desktop still verifies authenticated local readiness; it does not mark
unfinished Project services ready or wait for QQ/Discord network connections.

For a disposable real-Electron backend startup regression (three launches with
four synthetic Projects, using the unchanged 15-second readiness budget), run
`pnpm build`, then
`pnpm exec node --import tsx --test desktop/tests/runtime-startup.node-test.ts`.
This reports process-launch-to-readiness timings and does not use your desktop
profile or credentials.

Desktop startup diagnostics are saved to `<userData>/logs/startup.jsonl`
(`.tmp/desktop-dev/user-data/logs/startup.jsonl` with the default development
profile). The failure page shows the runtime role, failure category and elapsed
time; **Show startup log** reveals this fixed file. **Retry** preserves setup
and waits for the failed process to stop before launching another attempt.
The log rotates through the current file and `.1`/`.2`, each at most 256 KiB.
It records lifecycle events and allowlisted backend phase timings, not raw
stdout/stderr, credentials, configuration, or conversation content. Project
identities are replaced by per-attempt numeric ordinals. Up to 512 backend phase
records are retained per attempt; this is a startup diagnostic, not a full
runtime log. Existing Project diagnostics remain available after startup.

After Main starts, an unconfigured provider opens **Connect a model provider**
instead of an unusable chat. Choose **GitHub Copilot** for device-code login, or
**API key / local provider** for a provider key or keyless OpenAI-compatible
endpoint. The device code must be approved by the user on
`https://github.com/login/device`; the UI supports cancellation and retry.
**Settings → Providers** remains available to change providers or recover from
rejected credentials. Readiness follows the selected provider, not just the
presence of an OpenAI key. Each configured provider has a card; **Configure**
opens its existing settings without exposing the saved key. The large **Add
provider** card offers providers not yet configured and named local endpoints.
Saving updates the shared provider connection; project model defaults are
managed separately. A card marked **Configured**
means settings exist, not that its connection has been checked.

Bot conversation groups show a small connection icon at the right of their
header, without a text badge. Hover or keyboard focus on the header explains
the state. Verified connection, connecting, disconnected, errors, and an
unverified SDK connection use distinct indicators; an unavailable status is
never shown as connected. Status follows the existing sidebar refresh cycle
(conversation invalidations plus a 20-second fallback while the sidebar is active).

**Project settings → Bots** configures **QQ, Feishu, and Discord** bot
instances. A project can have several bots on the same platform, each with
its own name, credentials, sender policy, and runtime lifecycle. Each bot shows
configuration and runtime status separately, with
setup instructions, **Save and connect**, **Connect**, and **Disconnect** actions.
Advanced settings separate sender allowlists, admin group IDs, and **Trusted group
or channel IDs** (`trustedChats`). Trust is an explicit declaration about everyone
who can read replies, not just allowed senders. Unlisted groups and unknown
audiences receive restrained shared-conversation guidance; trusted groups and
direct conversations use normal assistant behavior. This does not grant admin
or tool permissions. List exact conversation IDs; Discord threads must be listed
separately and do not inherit trust from a server or parent channel.

Saving a trust change refreshes active reusable conversations before their next
model request. An already-running model request or one-shot task/call keeps its
existing context; saving cannot retract an in-flight reply. Saved
credentials are never returned to the form; leave a password field blank to keep
its existing value. Changes are saved on Main, not in browser storage. Only Main
administrators can manage these settings. Bot setup remains accessible before
a model provider is ready; answering messages still requires a working provider.
Legacy WeChat/iLink adapters are not started by project runtimes; their
retained configuration is not a connected bot. Old `/providers` links
redirect to `/settings/providers`; `/settings/channels` opens Default's Bots.
QQ and Discord show **Connected** only after gateway readiness. Feishu shows
**Running · connection unverified** because its SDK cannot confirm readiness to
the UI. Main and the desktop become locally ready without waiting for these
external connections. An offline or slow bot remains Connecting/Error in Bots
instead of blocking application startup; shutdown cancels pending startup
connections. A saved configuration is not proof that platform credentials, event
permissions, or message delivery work. Editing configuration outside Channels
may require reapplying it here or restarting Main.

**QQ GROUP/C2C outbound policy:** ordinary replies send the final summary only,
not raw tool names/results or intermediate model progress. App events and session
history retain those details. Final error messages and genuine yield/decision
questions remain distinct messages; questions are not buffered until the turn
finishes. Guild channels/DMs retain their existing progressive delivery.

The [official GROUP endpoint](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)
documents at most **5 passive replies per inbound `d.id`, within 5 minutes**.
The [official C2C endpoint](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)
headline/overview says **4 replies within 60 minutes**, but its `msg_id` field
still says **5 minutes** (public documentation reviewed September 18, 2026).
Shadow therefore uses **4 replies and a conservative 5-minute C2C deadline**.
These are documentation-derived local safeguards, **not live-runtime-verified
platform guarantees**. Ordinary text, Markdown, decisions and each attachment
share the allowance. GROUP streaming is unsupported; the separate C2C streaming
endpoint and its quota accounting are not implemented.

Each bot instance tracks accepted gateway sources by conversation plus message
ID, serializes sends and allocates unique `msg_seq` values before message I/O.
It prechecks an entire text/media bundle against the remaining budget and checks
expiry again before each message POST. No latest-message substitution or
automatic proactive send is allowed. Unknown, unaccepted, expired and exhausted
sources fail visibly through channel delivery failure handling. A resumed yield
turn currently retains its original source: a later human answer or unrelated
group message does **not** refresh that turn's deadline. Long waits can therefore
complete in App/history but fail to deliver to QQ; trusted answer-origin rebinding
is not implemented.

Tracking is in memory, bounded to 500 live sources per instance, pruned on later
ingress without per-source timers. At capacity, ingress continues but untracked
sources cannot reply. Transient gateway reconnects retain counts/deadlines;
stop/replacement clears them. A usable gateway timestamp must be no earlier than
this tracking lifecycle and no later than local receipt, so missing timestamps,
clock skew or pre-restart backlog fail closed rather than minting a fresh window.
Source retries never reset the recorded deadline/count.

GROUP/C2C do not automatically retry Markdown as plain text: no documented,
formatting-only rejection is currently allowlisted. Known expiry/count codes
`304103`, `40034005`, `40034128`, duplicate `40054005`, invalid/unauthorized source
`40034024`, active rate `40034100` and permission `40034105` are classified without
retaining raw error bodies. Network failures, unrecognized errors and missing
acknowledgements have **unknown outcome**. Message attempts are never refunded;
a platform rejection or unknown send blocks further delivery on that source,
preventing blind retries/duplicates. Safe errors contain only the classification,
HTTP status and allowlisted code. Partial text/media delivery is not rolled back.

Copilot requests follow each model's advertised `supported_endpoints`. Models
that support chat completions retain that protocol; Responses-only models use
`/responses` with converted history and tool calls. Endpoint capabilities are
cached alongside model names. Legacy metadata without capabilities retains
chat-completions compatibility with a warning; explicit unsupported protocols
fail without switching models or retrying a rejected request against another API.
Responses history preserves ordered output and encrypted reasoning separately
from displayed text, including tool-call IDs and assistant phases. JSONL and
SQLite retain this provider/model-scoped continuation across restarts; older
messages remain compatible. Streaming failures and incomplete responses are
reported as errors instead of committing partial tool calls.
Clients of Shadow's compatible chat API can preserve this continuation by
round-tripping the assistant message's optional `provider_state` field unchanged.

For GPT models, the conversation **Effort** menu offers **None, Low, Medium,
High, XHigh, Max**, plus **Default** to inherit project settings. Explicit levels
are sent unchanged as `reasoning_effort` for Chat Completions or
`reasoning.effort` for Responses. **None** disables thinking and maps to `none`;
it is distinct from **Default**. Provider/model capability checks still apply:
an unsupported level is an error, not silently downgraded.

DeepSeek's current catalog is `deepseek-flash` (V4.1 Flash, including images) and
`deepseek-v4-pro`, both with a 1M context window. DeepSeek uses
`/chat/completions`, including when configured with a custom gateway URL.
The **Effort** control supports `low`, `high`, and `max`, sent as
`reasoning_effort`. **Thinking** uses `thinking.type: "enabled"` or `"disabled"`;
when disabled, effort is omitted without clearing the saved preference.
Unset controls follow the configuration inheritance chain. DeepSeek accepts only
low/high/max effort; choose a supported level explicitly if the inherited value
is medium or xhigh. Unsupported levels are reported, not silently lowered.
Temperature is omitted during thinking because DeepSeek ignores it.
Full history, previous turns' reasoning and tool-call IDs are retained; both
JSONL and SQLite preserve session settings and history across restarts.
Flash accepts JPEG, PNG, GIF and WebP images as `image_url` parts. Image tool
results are attached as user-role images after their matching tool outputs,
as required by DeepSeek's Chat API. Pro rejects image inputs with an actionable
error instead of silently dropping them. Transitional `deepseek-v4-flash` aliases still
route, but are not offered as new selections; retired `deepseek-chat` and
`deepseek-reasoner` are no longer setup defaults.
See the official [model list](https://api-docs.deepseek.com/quick_start/pricing/)
and [Thinking guide](https://api-docs.deepseek.com/guides/thinking_mode/).

In Desktop, use the composer's **+ → Upload image / file** to attach local
images directly; **Add file / Add folder** keep their existing path-context
behavior. The browser's **Add file** uploads attachments. Files stay in the
draft until Send, image-only messages are supported, and uploaded images remain
visible when history is reopened.

Conversation attachments from Web and SNS channels also render when reopening
history: images have previews, videos have inline playback controls, and other
files appear as filename/type rows with **Download**. Video/audio bytes load only
when playback starts; unsupported formats offer a download instead. Downloads
use the authenticated, Project-scoped Web endpoint, not Electron-only file APIs.
SNS file references resolve only within the owning session's private uploads.
Video serving supports byte ranges for seeking without buffering the entire file.
This previews media for the user; it does not add video understanding or archive
extraction to the model.

The composer exposes **Stop request** while a request is being prepared or is
running. Stop cancels the targeted request through the session's provider/tool
abort path, rather than merely hiding streamed output. A late cancellation
cannot stop a newer request; other queued messages are preserved. Pending
cancellation and failures remain visible. Cancellation is cooperative: it does
not undo completed side effects, and non-cooperative tools can delay cleanup.

Stopped, failed, or restart-interrupted conversations show a **Continue** banner
above the composer. It continues from saved history instead of resending the
original message. Restart recovery marks interrupted work but does not start a
model request until you choose Continue. Continue adds no prompt or event message
to the model context: it executes unfinished tool calls with their original IDs,
then submits the real results, or submits existing results directly. Results are
saved individually as tools finish, even while sibling tools are still running.
After a crash, a call without a saved result may run again when you choose Continue;
external effects in that unsaved interval cannot be guaranteed exactly-once.
In-memory queued messages are not reconstructed after a crash. Successfully
completed conversations and unsent cancelled drafts do not show this banner.

Pasting an image into the composer (**Ctrl+V**) adds a removable pending thumbnail
through the same attachment flow; it does not upload or create a session until
Send. Ordinary text paste stays native, including when the clipboard contains
both text and images. HTML-only clipboard content does not fetch external images.
Image file previews support marker strokes, a color picker, and **Clear**.
**Undo** or **Ctrl+Z** while the image/marker controls have focus removes the last
stroke and updates its pending image; undoing every stroke removes the attachment.
Text-input undo remains native. Image references appear in the composer with
an uncropped thumbnail, a reference label, and an X to remove the attachment
without clearing the marks.
Each preview image reference includes its original absolute file path and whether
it is marked. On Send, that source is paired with the uploaded image path in the
message text, so the model and saved history retain the relationship even after
retry or reopening the conversation. Ordinary pasted/uploaded images do not claim
an original filesystem path. Source paths come from the authorized image response;
if unavailable, the image remains viewable with an explicit notice, but marking
and references are disabled instead of attaching an anonymous copy. Reload image
source retries after Main has been updated/restarted.
Finishing a stroke adds a flattened PNG to the current editable conversation's
pending attachments; further strokes replace that image instead of adding duplicates.
Send waits for image preparation, then uses the ordinary attachment upload flow.
The original file is never modified. Clear removes the marks and that pending
image; closing the file keeps a completed attachment in the composer.
Hold **Ctrl** while dragging a preview into the input box to attach its current
image (the original bytes when unmarked, a PNG when marked). Read-only
conversations cannot draw directly into a pending message.

Reselecting the active project or conversation is a no-op; use the project's
chevron to expand or collapse it. Model and Effort changes keep the composer in place while
saving; selecting the current value does not issue another save.
On desktop, Projects can collapse into a 64px icon rail. Folder rows and chats
show component-based information cards on hover or keyboard focus, including
conversation navigation and new-conversation actions. Expanding restores the
previous sidebar width. Narrow-screen project drawers remain full-width.
Tree information and file navigation hints use these components, not native
browser title tooltips. Clicking a full-width tree row performs its action
without opening an information card; hover and keyboard focus still reveal it.
Conversation information cards clamp long titles and descriptions without
changing saved text. **Automations** shows one stable entry per fresh-context
scheduled task, not one row per generated conversation. This includes
agent-created jobs and the learning pipelines (reflection, encapsulation, and
soul reflection). Open an entry for paginated **Runs** and read-only
**Configuration**; opening a run keeps the existing conversation, file browser,
and Diagnosis, with a run selector above it. Refresh never switches away from
the run being inspected. Run ownership comes from explicit metadata, not matching
prompts or mutable titles. Jobs that append to an existing or dedicated reusable
session keep their ordinary conversation presentation.
For local built-in learning runs and their descendants, the file browser
shows **Home**, not the session's managed workdir. Listing, previews, downloads,
and Git Changes share that root; this does not change the agent's execution cwd.
Quotes from Home use absolute source paths. Remote or unavailable workdirs never
fall back to local Home.
Switching between learning runs retains the loaded Home tree and nested
expansion state while validating the next session's browsing root. Rows cannot
be opened during that check. Only a confirmed matching local Home reuses the
tree; another root, Main, project, or remote workdir never shares its identity.
Failed validation clears the retained rows and reports an error.
Folder conversations also retain their own explorer and resolved header
when hidden, so returning does not reset expanded folders or flash a loading
folder label. Learning runs share an in-memory, project-scoped cache of
confirmed Home entries, folder expansion, and scroll position. A different
run validates its root without reloading unchanged expanded directories;
**Refresh files** refreshes the shared listing and invalidates cached children.
Removed directories, changed roots, and different Folder or Project identities cannot
inherit that cached directory state.
When a workdir's owning node is offline, Files and Git show one **Node offline**
state rather than duplicate request errors. **Check again** retries both after
reconnection. Missing/revoked capabilities and genuine file errors remain
distinct; offline status never selects Main's local filesystem instead.
When the current conversation owns running background work, a **Background
tasks** disclosure appears above its input. Expand it to see process, tool, and
agent task titles and start times. Finished tasks disappear automatically;
other conversations and projects never share this list. It uses the
shared live connection and a bounded active-pane refresh, not another stream.
This read-only inventory does not expose process output or stop controls, and
does not survive a Main restart or add remote background execution support.

Live updates share one application-owned SSE connection per Main base, rather
than opening a socket for each cached conversation or submitted request.
Hidden idle conversations release their subscriptions, including when the
workspace is cached behind Nodes or Settings. Already-submitted requests keep
their completion subscription without keeping a separate HTTP response open.
Returning to a direct chat refreshes its history without replacing its composer
or unsent draft. Draft input and attachments clear only after admission is
confirmed; a rejected submission leaves them available to retry.
While the agent runs, the composer remains available for guidance, attachments,
and context; **Send** and **Stop request** are separate controls. Only message
preparation/admission temporarily locks submission. Follow-ups use the existing
interactive session scheduler: they can interrupt an LLM request or steer at a
tool boundary according to the backend's existing policy. A parent waiting on a
blocking call also accepts guidance; call/task traces themselves remain read-only.
Follow-up admission does not erase current output or retarget Stop to an input
that was merged into the existing turn.
Deleting a conversation uses an in-app confirmation showing its name and the
child-session deletion scope. Cancel is focused by default; deletion errors stay
in the dialog for review and retry, and confirmed child deletions also clear
their cached conversation views.
For a run identified as learning by the project graph, Home browsing does not wait for
session-header metadata to reserve its layout. Directory requests show their
busy state inside the existing folder row rather than inserting a temporary
loading row that shifts its siblings. Browsing requests still use the owning
project's validated session endpoints.

The shared feed carries project-qualified chat, session invalidation, log,
and span topics. Bounded replay cursors support reconnection and suppress
duplicate events; a missed replay window or Main restart explicitly resets the
affected views to saved snapshots. Reconnection never resubmits a chat command.
Legacy chat/telemetry streaming endpoints now return HTTP 410. External clients
must subscribe through `/api/live` and use the JSON admission response from
`POST /api/chat/send`; `stream:true` is rejected without submitting a message.
The synchronous `/api/chat/message` endpoint remains supported. See
[realtime protocol migration](docs/realtime-protocol.md#retired-streaming-apis).
Transient output is not a durable event log: persisted history remains the
source of truth, and interrupted work still follows the explicit continuation
workflow. Disconnected live updates show a retryable app-level notice.
Session invalidations are coalesced; visible project sidebars also reconcile
every 20 seconds. Intermediate execution stages, Nodes, and provider settings
are not all push-driven: visible chat activity and Nodes retain bounded polling,
and provider reads retain their 30-second deadline even when a view supplies its
own cancellation signal.

The backend saves provider settings in the selected Main directory's
`config/bot.config.json`. Copilot credentials remain in the desktop profile's
`auth/copilot` directory, not renderer storage or the repository configuration.
The same backend applies the saved settings without a separate UI-only config.
The desktop window uses a custom, draggable title bar with minimize,
maximize/restore, and close controls; it has no native application menu.
Navigation (including Providers) and window controls share one Shadow header.
The header, setup, and recovery screens use `app/src/assets/shadow-logo.png`.
The matching browser favicon is `app/public/favicon.png`; the multi-resolution
Windows icon in `desktop/assets/icon.ico` is used by both the desktop window and
the installer build. Renderer branding updates through Vite during development;
native window icon changes require restarting Electron.
Content begins directly below navigation without a persistent runtime status row;
device roles, connection status, and node IDs remain available in **Nodes**.
Projects dock to the left edge; the session list and chat history scroll
independently while the composer stays visible. Narrow browser windows expose
Projects through a toggle. New conversations start as a centered, unsent draft.
Folder drafts prominently show the folder name and path above the input;
scratch drafts explicitly say that no registered folder is selected.
No session ID, history request, or sidebar conversation is created until the
first message is sent. Background clicks do not focus the composer. An
unmodified letter (a-z), digit (1-9), or Backspace focuses it and lets the browser
perform the native edit at the retained caret/selection, except while editing
another field, using an open menu/dialog, composing with an IME, viewing Diagnosis,
or viewing a read-only/historical conversation.
The focus shortcut does not cancel the native key or insert `event.key` as text:
Backspace keeps native deletion behavior, and input-method text remains owned by
the IME. Recognizable IME-start keys can focus the composer before composition;
first-key handoff from a non-editable area still depends on the OS/input method.
Typing `/` at the start of the composer opens the current Project's registered
slash commands. Continue typing to filter by command name; Up/Down selects,
Tab or Enter completes the name, and Escape dismisses the list. Clicking a
command also completes it without sending: add any arguments, then send normally.
Shift+Enter and IME composition retain their normal behavior. Slashes in prose,
paths, arguments, or multiline text do not open the menu. The authenticated
`GET /api/chat/commands?sessionId=...` catalog shares the backend registry with
`/help`; owner publication commands appear only in Project coordination.
Catalog failures offer Retry and never substitute a hard-coded command list.
Slash commands return a separate **Command result** in the conversation, not a
user/assistant exchange. Results survive reloads and stay with their history
segment, but neither command text nor output is added to model context or
forwarded to channel-message subscribers. A first command also initializes the
scratch conversation's local data directory without starting a model turn.
`/clear` starts a fresh AI context in the same conversation, including the fixed
Project coordinator. It reloads the selected agent definition, discards the
in-memory tool overlay, and opens an empty history segment without an LLM call or
handoff summary. Previous segments remain viewable. Project/folder bindings,
files, tasks, configuration, and long-term memory/conventions are retained;
pre-clear event entries, working-set entries, and session summaries are no longer
automatically injected. Active or queued work must finish or be stopped first.
Unlike `/compact`, `/clear` does not carry conversation context forward.

Previous conversation summaries appear as a collapsed disclosure in the message
history. Expanding one renders the complete Markdown with compact headings and
readable spacing; it scrolls with the conversation rather than inside a separate
panel. Collapsing it releases the rendered content without changing the saved
summary.
Compiled backend/tool implementation changes still require a backend restart;
this command reloads the installed agent definition, not running application code.
The composer has one compact model button showing the model and effort. Its menu
contains only **Model** and **Effort**; each opens a submenu in the same popover.
Model retains searchable options, provider labels, and the current selection
marked. Back/Left returns to the two-row menu; Escape returns from a submenu,
then closes the menu. Model selection is scoped to the conversation/draft;
project defaults are available in Project settings → Models.
Selecting a conversation model saves it immediately, without sending a message.
**Follow project default** clears that model override; **Default** clears the
conversation's thinking/effort overrides. Unsent model/effort choices are saved
locally per installation, project and draft location; they survive renderer
reloads and are removed after successful first-message admission. This does not
persist unsent message text or attachments. Existing explicit choices remain
pinned, including values written by older versions; clear them to opt into
inheritance.

App and project configuration use one cached `ConfigStore` save/load mechanism:
read the file once, validate and serialize programmatic changes, atomically
replace the file, and await runtime activation. Failed activation restores the
previous file and cached settings. Environment-only credentials remain in
memory, not written into configuration. Configuration files are not watched:
use settings/API changes for live updates; manual file edits require a restart.
MCP catalog updates are applied directly by the save path; skills and agent
instruction documents still retain their own filesystem watchers.

Returning from Settings
restores the existing chat and unsent draft; leaving settings cancels any pending
device login, as does switching to Channels. Channel form drafts survive switching
between settings sections, and status refreshes never overwrite those drafts.
First-run credential checks still gate unavailable chat access.

The conversation heading shows its name and effective workdir folder. Clicking
it opens a read-only details popover with the full path, session name and ID,
reported token usage, and context usage/limit. Unknown measurements and remote
paths stay explicitly unavailable; context is the last reported usage, not a
live estimate of the unsent draft. The popover has no management action buttons.
Tokens currently describe the latest recorded model call, not a cumulative bill:
older persisted records can repeat usage, so summing them would overcount.
Context uses the selected segment's latest prompt count and the currently
configured model's known/explicit limit; no limit is invented for unknown models.
Effort combines thinking and reasoning intensity, scoped to the conversation.
**None** disables thinking and clears the explicit intensity; **Low**, **High**,
and **Max** enable thinking and set that effort together. **Default** clears both
overrides and uses project settings. Model support still applies; provider
rejections are surfaced rather than retrying with a different setting. Draft choices
stay local until the first send; existing-session changes are persisted before
sending another turn. Sidebar lineage/expand controls and conversation tool,
thinking, retry, and close controls use the bundled UnoCSS icons rather than
text glyphs.

Selecting a child session or agent opens an independent conversation pane.
At workspace widths of 1280 CSS pixels or more, it sits beside the parent;
drag the divider to resize it, or focus the divider and use Left/Right or
Home/End. Narrower windows show the child alone with a return-to-main button.
The parent remains mounted, retaining its draft, history and live stream.
Each pane has its own **Diagnosis** toggle in the conversation heading. The file explorer and
its toggle are available only in the main pane, not in subagent side chats;
read-only agent output refreshes while visible. Closing the pane does not stop
the agent. The child selection is retained in the route's `child` query.

The composer overlays the full-height message and file scrollers. Its measured
height reserves scrollable space after the content, including when controls or
attachments wrap, so the last message or file line can scroll above the input.
Files use a continuous reading surface rather than a separate composer section.
Switching documents retains the input element, draft, attachments and
model controls. Sending from a file returns to Conversation; quoting alone
keeps the file open. The Enter/Shift+Enter hint sits inside the input box, to
the left of Send, rather than below it.

Selecting conversation or file-preview text opens a **Quote / Copy** menu and keeps the browser's
native selection highlight. With that menu open, an unmodified **q** quotes
the text into the current message draft; unmodified **c** copies it. Quoting
neither sends a message nor creates a side conversation. It is disabled when
the current pane has no editable composer; Copy remains available. Escape,
scrolling or clicking elsewhere dismisses the menu. The old painted highlights,
implicit quoted-send mode and Ask BTW controls are removed.
File quotes include the workdir-relative path and source line range. Copy
preserves the selected text, including indentation, without adding that metadata.
Rendered Markdown reports the enclosing source block's lines, explicitly marked
as such; switch to **Source** for exact selected source lines. HTML also offers
**Source** for quoting without relaxing its preview sandbox. PDF viewer selections
and selections inside rendered HTML frames do not use this menu.

Working sessions have animated sidebar indicators: blue for model work and
amber for tool calls. The selected conversation also shows its activity in a
persistent strip above the composer. These follow polled runtime
phases and the active response stream, including when reopening a running session.
Idle/inactive indicators are static; unavailable status is not shown as working.
Animations respect the operating system's reduced-motion preference.

The right edge of conversation history shows one small horizontal marker per
user message. Hover or focus a marker to preview the message and its local
send time; click it to jump to that turn. System events, tool results, and
compaction summaries are excluded. Older records without timestamps display
**Time unavailable** rather than an inferred date.
User and assistant bubbles also show a compact local time in their footer;
hover to see the complete date and time zone. New streamed replies retain their
first-received time as text arrives. Reloaded history uses the recorded message
timestamp, shared by the in-memory history and JSONL/SQLite persistence.
Conversation bubbles omit role labels. Only group messages display human sender
names; assistant names stay hidden, including while streaming. New sender
envelopes record the group/direct distinction. Older histories without that
metadata show names only when distinct recorded sender IDs establish multiple
participants; ambiguous old records are not guessed to be group chats.

Frontend UI uses square corners, except for the circular mouse highlight, send button,
and loading spinner (including its center dot). The radius tokens in
`app/src/styles.css`, including controls, surfaces, overlays, badges, and
indicators, are all zero; UnoCSS rounded utilities use those same tokens.
This does not restyle native operating-system windows or sandboxed file content.
Conversation events, tool activity, and assistant replies share one responsive
maximum-width constraint rather than letting event bars span the entire pane.
Selecting a conversation highlights only its chat row, not its bot or folder
header. A folder is highlighted for a new folder draft when no chat is selected.
Tool **Arguments** and **Result** details use theme-aware JSON syntax highlighting
when their content is valid JSON; plain output and malformed legacy arguments
remain unchanged. Payload rendering and highlighting begin only when the tool
group and call are expanded, and a collapsed Result does not render or highlight
incoming updates. Diagnosis tool details use the same renderer when opened.
Highlighting failures retain the original text and offer **Retry**.

The **Files** explorer sits beside Projects and can be collapsed horizontally.
Drag the right edge of **Projects** or the docked **Files** sidebar to resize it.
Focused resize handles also support Left/Right arrows and Home/End. Widths stay
bounded to leave room for documents, survive mounted toggles, and do not apply
to the narrow-screen drawers.
The top document strip holds **Conversation** and closable file tabs.
Conversation is pinned outside the horizontally scrolling file strip.
Source and Changes documents for the same path can remain open independently.
The Conversation document has a **Diagnosis** button at the top right; click it
again to return to the conversation. There is no second Conversation/Diagnosis
tab row.
Project coordination and built-in learning browse the current Project's Home in
Files and Git, without changing the agent's execution workdir. Clicking an already
selected project's name does not reload or navigate its coordination conversation.
Opening it keeps the project name and keyboard focus stable while
preventing duplicate requests; failures still expose an inline retry action.
Other sessions show the current effective workdir in Files, including when
Conversation displays an older segment. Its root label shows the directory name;
hover or focus it to see the backend-resolved full path, including for empty
directories. Empty directories have no placeholder row. Folder conversations browse their registered folder directory,
while free chats browse their managed session directory under Home. Inherited
workdirs still use their owning session's directory. Chat history and shared
memory are separate from this file listing. Remote paths are display information,
never a local filesystem fallback.
Directories expand on demand; opening
and collapsing them preserves loaded child nodes and nested expansion state.
Refresh updates entries in place rather than replacing the whole tree; expanded
directories refresh immediately, and collapsed directories refresh when reopened.
Existing rows stay visible while refreshing or reporting a refresh error. Opening
the same path selects its existing tab. Arrow keys and Home/End navigate
document tabs; Delete closes a selected file. **Ctrl+Tab** cycles forward through
Conversation and open files, and **Ctrl+Shift+Tab** cycles backward, wrapping at
either end. These shortcuts target the active visible conversation pane, not
Diagnosis; plain Tab retains normal focus navigation. Hover the document strip
and use the wheel to scroll it horizontally without switching documents.
Middle-click a file tab to close it; Conversation cannot be closed.
**Ctrl+W** closes the selected source or diff file tab in the active pane, returning
to Conversation when the last file closes. Electron intercepts the shortcut even
when a file preview iframe has focus; it does not close the application window.
**Ctrl+Shift+W** closes all source and diff file tabs in the active conversation,
including when Conversation is selected, and returns to Conversation. Right-click
a file tab (or press Shift+F10 while it has focus) for **Close**, **Close others**,
and **Close all**. Close others keeps the clicked tab; Conversation always remains.
These actions do not affect other conversations or files on disk.
Open tabs are remembered per
conversation while the workspace is mounted. Narrow and split panes use a
collapsible explorer drawer so the content remains usable. Markdown
files (`.md` and `.markdown`) render headings, lists, tables and code blocks;
source previews use [Shiki](https://shiki.style/) syntax highlighting with
light/dark themes and lazily loaded languages.
Text previews offer an **Encoding** selector. Auto uses UTF-8 or a UTF-16 BOM;
invalid byte sequences show a warning rather than silently guessing a legacy
encoding. Select Shift-JIS for Japanese legacy text, GB18030 for Chinese text,
or the matching UTF-16/Windows-1252 encoding. This only changes the preview, not
the file bytes or filename. Garbled names already created during archive
extraction are not renamed or repaired by URL decoding. Remote encoding changes
remain unsupported and report an explicit error instead of using Main's files.
Files under `memory/events/*.jsonl` have a dedicated record view: events stay in file order
with actor, timestamp, description, context, references, and session provenance.
Source switches back to the unchanged JSONL. Invalid or truncated records remain
visible with an explanation; selection quotes retain the original source lines.
Syntax highlighting includes common code formats
and hidden configuration files such as `.gitmodules` and `.npmrc`. Selected
source text retains its original line endings and indentation for Copy/Quote.
Unknown languages and individual lines over 2,000 characters remain plaintext;
highlighting failures show a retry notice without hiding the source.
Unrecognized or missing extensions
(including `.node-version`) attempt text preview too; binary files still show
an explicit download-only message. Open raw remains available for the
original file. Rendered HTML is sanitized, and relative links/images resolve
inside the owning session's static file route. Refresh
reloads the tree. Remote filesystem failures stay explicit and never select a
Main-local folder as a fallback; remote preview formats depend on executor support.
The visible explorer loads automatically for existing sessions and registered
folder drafts. Folder drafts browse the registered folder by folder ID,
without creating a session; scratch drafts without a folder hide the explorer
and its toggle and make no file requests. Selecting a project or sending the
first message makes the explorer available without changing its expansion preference.
For a local Git workdir, Files colors changed paths and their parent folders,
with status badges such as **M**, **A**, **U**, **D**, and **R**. The adjacent
**Changes** view filters the same directory structure to all uncommitted changes,
including deleted paths. Opening one displays a unified **HEAD → working tree**
diff with old/new line numbers, syntax colors, and the shared overlay composer.
Staged and unstaged changes are combined; untracked files compare against empty
content. Diff quotes identify both sides' source lines. Binary or oversized
diffs report their limits rather than showing a misleading empty text diff.
Git reads refresh while the explorer or a diff is visible and never stage,
commit, or otherwise modify the repository. Non-Git folders keep ordinary Files
browsing. Paired remote workdirs use the same Changes tree and diff previews:
`workdir.git.status` and `workdir.git.diff` run Git on the owning Child, never on
Main's filesystem. Both Main and Child must be updated; missing Git, unavailable
nodes and unsupported older nodes report explicit errors. Remote results are
validated and bounded to 4 MiB, with chunked transport for large diffs.
Switching documents or toggling Diagnosis
preserves the composer draft, attachments, history position and active response
stream. The former System & Tools drawer is replaced by Diagnosis's **Trace**,
**System prompt** and **Tools** views; resend remains beside the composer.
Trace shows the displayed physical segment's recorded messages grouped by user
turn, searchable tool arguments/results, and Input / Model / Tools timing lanes.
The overview defaults to the latest five minutes of recorded activity, following
new activity until you move or zoom the window. Drag the window slider or use its
previous/next buttons to browse without shrinking the entire conversation;
**Latest 5 min** restores the default. Parallel calls occupy separate tracks.
Hover or keyboard-focus a timing bar for an in-app metadata popup. Select it to
read details directly below the graph: input content, or a matched tool call's
original JSON, formatted arguments and result, alongside span attributes and errors.
Model calls show their returned message, returned tool calls, visible reasoning
and usage. New calls capture that display content directly on the execution span
(not provider continuation/encrypted state), so compaction does not break the
association. Older calls can use history when the recorded input message count
and completion interval uniquely identify the response; the inspector labels
this historical match. Running calls show a waiting state, and failed or
unmatchable legacy calls explicitly report missing responses. Unmatched tool
calls are also marked unavailable. Turns and tool-call details can be folded in bulk, and search
matches all entered terms across text and metadata. The expandable all-spans
list includes nested execution spans.

Execution timing is fetched from `GET /projects/<id>/v1/query/session-spans` with an exact
logical session ID and physical segment filter. The trace UI follows the
`audit:read` visibility scope; the API inherits the gateway's existing configured
launch-credential authentication (UI scopes are not server authorization).
Visible Diagnosis refreshes every two seconds and includes
in-progress spans; switching away aborts its requests. Earlier execution spans
can be loaded explicitly. Duration is the union of loaded execution intervals,
not the age of the conversation or a sum of overlapping spans. Missing legacy
timing is marked unavailable; the current prompt and tool definitions are
not presented as historical per-call snapshots. Unsent drafts never fetch trace
data or materialize sessions. Inspect older segments through Conversation's
segment navigation before opening Diagnosis.

#### Agent-readable diagnosis

**Export for agent** downloads a versioned JSON snapshot of the selected physical
segment, independent of which rows are expanded or loaded in the UI. It contains
decoded persisted records (before conversation tool-pair repair), tool-call/result
references, execution spans, lineage, and explicit pagination and truncation
metadata. Exports are bounded to 500 records and 500 completed spans plus live
snapshots; a partial export is labelled, not presented as the complete session.
Missing tool results mean "not in this page", not a successful or failed call.

The same read-only collector is exposed at
`GET /projects/<id>/api/sessions/<encoded-logical-session-id>/diagnosis`.
It requires the existing Main authorization and folder-access checks, and does
not create a session or run an agent turn. Start with `view=summary` (the default)
for message/tool previews and error/live span details, then use `view=full` for
longer text and all loaded spans. Supported query parameters:

| Parameter | Meaning |
| --- | --- |
| `physicalId` | Exact segment belonging to this logical session; defaults to the current segment |
| `recordOffset`, `recordLimit` | Decoded record pagination; defaults 0/200, maximum limit 500 |
| `spanBeforeId` | Independent completed-span cursor from `trace.nextBeforeId` |
| `textLimit` | Maximum characters per string, 1–16000; defaults 240 for summary and 16000 for full |

Follow `history.nextOffset` and `trace.nextBeforeId` independently. Pin
`session.physicalId` on subsequent requests so a compaction cannot silently switch
segments. Fetch one record with `recordOffset=<index>&recordLimit=1&view=full`.
The snapshot is non-atomic: active work may append records or finish spans while
it is collected. Offline reads have no in-memory live spans or prompt captures.
This is observation, not a breakpoint debugger or an automatic repair executor.

For a stopped backend or a coding agent with local file access, the same collector
can read explicitly selected project storage without starting Shadow:

```powershell
node --import tsx scripts\diagnose-session.ts `
  --sessions-dir "<project workspace>\.sessions" `
  --storage jsonl --session "web:chat-<id>" --project default `
  --otel-db "<project workspace>\.otel.db" `
  --view summary --out "<new diagnosis file>.json"
```

Use `--storage sqlite` for `sessions.db`; both SQLite readers open read-only and
do not migrate old schemas. Omit `--otel-db` to explicitly collect history without
telemetry. `--physical`, `--offset`, `--limit`, `--span-before`, and `--text-limit`
map to the API selectors above. Omitting `--out` writes JSON to stdout; an output
file must be new, so a diagnostic command cannot overwrite an existing file.
Use the logical session ID, not its filesystem-safe name.

All outputs exclude provider continuation state and reasoning, redact common
credential fields/patterns, and bound text and collections. JSON-encoded payloads
are decoded for redaction. **Review before sharing:** this is best-effort filtering,
not a guarantee that arbitrary messages or tool output contain no secrets or
personal information. `privacy.truncatedPaths` identifies omitted detail (at most
100 reported paths). Retained prompt capture metadata is labelled separately;
current prompts are never substituted for historical requests. No external logs,
attachments, or original build revision are reconstructed. Treat exported content
as untrusted evidence, never instructions to the investigating agent.

#### Inspecting prompts during development

`GET /projects/<id>/api/sessions/<encoded-session-id>/context` returns the
current `systemPrompt` and `tools`, with a `source` label:
`active-history` is the active session's in-memory prompt; `preview` is rebuilt
from current configuration for an inactive session. Add `?view=preview` to
explicitly rebuild, including named `sections` and their character counts.
A preview does not reconstruct the original input's sender/audience context.
Neither result is a historical model-request snapshot.

For actual session-loop requests, explicitly enable in-memory capture before
starting the development backend (PowerShell):

```powershell
$env:SHADOW_DEBUG_PROMPTS = '1'
pnpm dev:server
```

Then query the same endpoint with `?view=captured`. It returns newest-first
`captures` with project, logical/physical session, turn and request IDs,
timestamp, loop iteration, configured provider/model options, and exact
system messages and tool schemas passed to `provider.chat`. Capture occurs
after pending context updates, before the provider call, including calls that
subsequently fail. The corresponding model span carries
`prompt.capture.request_id` for correlation. `boundary: provider-input` means **before** adapter
transformations, routing and retries, not a serialized HTTP request. Auxiliary
classification and handoff-summary calls are not captured.

Capture defaults off and is rejected when `NODE_ENV=production`. Keep the
development gateway on loopback. Context queries use the host's existing
local-client/launch-credential authorization and return `Cache-Control: no-store`.
No user/tool message bodies, provider continuation state or authentication
headers are retained by this feature, but system prompts can contain private
memory and identity information: do not share captures indiscriminately.
There is no automatic log/database export.
Each project retains at most 20 captures with a 16 MiB system/tools payload
budget; oversized payloads return `payload: omitted-size-limit` rather than
truncated content. Deleting a session removes its captures; runtime shutdown
clears all of them. An empty capture list means nothing is retained for that
session, not that a preview was sent. Disabled capture returns
`404 prompt_capture_disabled`. The existing Diagnosis UI continues to show
current context, not these per-request captures. Unset the environment variable
or set it to `0` and restart to disable capture.

Each project's Folders **+** menu contains **Open folder**, **Open remote folder**,
**Clone repo**, and **Start from scratch**. Open remote folder opens a new draft
with the execution-location picker already open, the same picker available in the composer. **Project
folders** includes all registered local and remote folders belonging to the current
project, not other projects' folders or the global list of advertised workdirs.
**Remote devices** starts from scratch on a Child: first send allocates an
independent managed conversation directory on that device, without registering a
Project folder. **This computer** starts a local managed conversation with no folder
selected. Merely opening the picker or changing selections allocates nothing.
Offline or unsupported remote locations are disabled; failures never fall back to
Main's filesystem. Existing remote folders remain selectable on compatible devices
even when those devices do not support managed scratch conversations.
Open folder registers an existing directory using
Electron's native folder picker (the browser accepts an explicit Main-local path).
Registered folders remain visible when empty. Each folder's own **+** opens a
draft associated with that folder. Its session is created on the first send;
filesystem tools and shell then use that folder as their working directory.
Collapse a folder to hide its conversations.

Folders, conversations and files use the shared `TreeRow.vue` component for
single-line labels, 12px nesting, 16px icons, disclosure and selected/focused
states. Conversation descriptions remain in the row tooltip. Folder/session
disclosure buttons stay separate from selection; file folders toggle when
their row is activated. The shared row supplies icon, metadata and action slots;
each caller retains its own data loading, lineage and actions.

### Project coordinator and durable topics

Each Project has exactly one coordinator, `web:orchestrator`, pinned in the UI
as the default routing entry. It reuses or creates topics and lets the user
continue directly in the appropriate topic. It is **not a structural parent**:
durable topics are root peers. The built-in `orchestrator` has a hard runtime
cap of `read`, `search`, `topic`, `message`, `initiative`, `project_config`, and `authoring_change`; it cannot use
`invoke_tool`, `exec`, `write`, or `subagent`.

`search({space: "sessions:", query, limit: 5, offset: 0})` discovers Project topics
by their briefs, returning title, goal, scope, nonGoals, folderId, initiativeId,
createdBySessionId, and status. The maximum page size is 20. Prefer reuse over
creating competing topics. Topic create/search/update receipts include
`conversationUrl` (`/projects/<encodedProjectId>/chat/<encodedLogicalSessionId>`).
Use the returned URL in a Markdown link with the topic title so the user can
continue directly there; do not reconstruct it from a display name.
Project topic search (`sessions:`) and typed Project
messaging also work from remote-workdir sessions as control-plane operations.
Other search spaces remain explicitly unsupported for remote workdirs.

`topic({action: "create", title, goal, scope, nonGoals?, folderId?, agentType?,
initiativeId?, initialMessage?, requestId?})` creates a `web:chat-UUID` root peer.
An optional kickoff is admitted, not awaited to completion. `requestId` retries
do not replay kickoff; `initialMessageStatus` is `accepted`, `not_requested`, or
`not_replayed`. Creating a topic or linking an Initiative never transfers an
Initiative assignment.

`topic({action: "update", sessionId, title, goal, scope, nonGoals})` replaces the
full brief; only the topic itself, coordinator, or authorized UI may update it.
Read `v:project/folders` to list registered folders.
`topic({action: "register_folder", path})` registers an existing Main-local folder
through the Project folder registry. A remote topic must never reinterpret a
display path as a Main-local path. One-shot task/call executions cannot create
or manage durable topics or register folders.

Authorized HTTP routes are `GET`/`POST /projects/:projectId/api/topics`,
`PATCH /projects/:projectId/api/topics/:key`, and
`POST /projects/:projectId/api/orchestrator`. Ensuring the coordinator does not
automatically start an LLM run. JSONL and SQLite migration flatten legacy reusable
structural children into peers while preserving context ancestry, fixed workdirs,
and `createdBySessionId` provenance. Compatibility data-location references do
not reestablish structural ownership.

### Change-based conversation agent authoring

The owner can create a Change in a durable developer topic or Project
coordination with `authoring_change`. Each Change starts from published
resources, has its own editable files and revision, and never silently imports
the legacy shared draft. Delegate explicit resource paths to a developer,
then **edit → check → propose** using the same `changeId`. Small prompt edits
can stay in coordination. No business source folder or copied bundle is needed;
`v:authoring` provides revision-checked virtual resource files. Hashes, check
evidence and diffs are saved automatically and retrieved by `runId`.

This is framework support, not a built-in feedback/GitHub bot. `propose` opens
an owner-only review in the originating topic and coordination, summarizing
changed files, affected bindings, permission changes and current-version checks.
Review the exact code, bindings and grants before confirming publication.
Approval pins both the candidate and published base; changed proposals require
fresh review. Pending reviews survive restart but never auto-confirm. Publishing
a Change leaves unrelated shared drafts untouched. `project_config` and
`/agent-publish <exact-draft-revision>` retain the older coordination-only draft
workflow; they do not automatically migrate existing work.
If an affected conversation is busy after approval, the review shows **waiting**
and activates at a safe idle boundary after revalidation. It does not interrupt
accepted work or ask for the same approval repeatedly.
`/agent-rollback <historical-revision> <current-revision>` restores a retained
release without discarding the draft.

The coordinator delegates substantial implementation to a durable local topic
with persisted Change edit scopes; it does not gain shell, arbitrary file
writes or subagent access. `check` supports validation, prompt assembly,
synthetic tool cases and actual model scenarios with synthetic tools.
Checks distinguish assertions from smoke execution and mark older source
versions as stale. Standalone developer topics can also invoke the catalog tool
`agent_tool_test` through `invoke_tool`: it runs exact JavaScript or erasable
TypeScript using the same shared script engine as published tools, checks
synthetic cases against expected JSON, and reports a source hash, policy/module
manifest and per-case actual/expected evidence. ESM `export async function run(args)`
runs inside a separate Node child process,
with exact skill `imports` constrained by the authored agent's `allowedModules`.
`@shadow/<grant-id>` exposes the corresponding approved service through a module
instead of a second capabilities declaration. Runtime selectors, legacy
`run(args, capabilities)` and executable metadata exports are unsupported;
the owner recreates old tools. Existing runtime data/configuration is not migrated.
HTTP mocks use the real
`{status, body}` envelope; non-2xx statuses throw the same safe error/status as
the broker. `{throws:{code,status?}}` and `{sequence:[receipts/errors]}` cover
failure paths and repeated requests without another VM harness.
This does not contact services or prove live access.
Synthetic tests permit only pure supported native modules and mocked named
modules. Explicit raw filesystem/network imports are live-only, have the child
OS user's authority, and are not restricted by `readFolders` or HTTP grants.
They require developer validation with disposable fixtures. VM import routing
and child-process fault isolation are not an OS sandbox.
Workers return a `changeId` and saved check references, not redundant reports or
checksum manifests. Their delegated edits/checks and review requests can continue
on peer-triggered turns, but worker messages cannot authorize publication.
For legacy shared drafts, the coordinator can use `project_config` **schema**, **inspect**, **read**,
**preview**, and synthetic **test**
while handling worker reports to retrieve missing baselines without asking the
owner to repeat "continue". Preview/tests may use an in-memory candidate `bundle`
without staging it. Other actions retain their direct-owner requirement.
Task materials sent through `message` should be non-silent: normal delivery
queues without interrupting work, while silent delivery only records context
and never wakes the recipient. If splitting context, send parts sequentially
and finish with a non-silent request.

For a controlled live check, `authoring_change request_probe` opens a one-use,
expiring GET-only approval in the current topic and coordination. The owner
reviews the exact source, arguments, origin/routes and credential references.
Only clicking approval executes it; a new connection can be tested before
publication without repeating the instruction in a different chat. The host
saves the run and sends its reference back to the author. This does not approve
production permissions, writes, native I/O or inbox delivery.

The legacy `project_config` action `probe` still runs the
**current draft**, or an in-memory candidate when `bundle` is supplied, using
unchanged existing approved HTTP `GET` grants. Publication is not required to
test new code. Only an explicit `target: "published"` tests the deployed version.
Optional `expectedRevision` pins the selected source; stale values fail rather
than silently testing another version. No bot turn, HTTP write, inbox delivery,
draft mutation or publication occurs. This legacy action cannot approve new
service permissions; use the explicit Change test review for a new connection.
Receipts distinguish tested source revision/hash from `authorizationRevision`,
and retain denied/failed calls, transport-attempt markers and HTTP status even
when the script catches errors. An attempted transport does not prove server
receipt. `httpVerified` requires a successful response, and does not prove
issue creation/commenting/wakeups or every business branch. Safe errors preserve
code/status without raw host errors or credential values.
Probes reject raw filesystem/network module declarations even if unused.

Published bindings replace the ordinary prompt and tool registry with the
selected custom role, selected skill bodies, explicitly granted folder reads and
owner-approved tools. They do not inherit private Project memory, dynamic tool
loading, shell/write tools or DM-admin management authority. `allowedTools: []`
means **no tools**. Disabled or removed previously bound conversations fail
closed rather than reverting to the general agent. Conversations that have
never been bound still follow their existing channel/agent behavior; this is not
an automatic lockdown of existing bots.

See [conversation agent authoring](docs/agent-authoring.md) for the resource
format, owner approval, credentials, HTTP/inbox grants and operational boundaries.

**Subagent execution modes.** `agent_type` selects the role and tool constraints;
`mode` selects the execution contract independently:

| Mode | Initial `task` | Context and result |
| --- | --- | --- |
| `task` | Required | One independent assignment, started on creation; completion is reported asynchronously. |
| `call` | Required | A snapshot of the caller's context; blocks that caller and returns the final result through the original tool invocation without copying back the internal trace. |

For example, `subagent(mode="task", agent_type="verify", description="Verify the fix",
task="Check the original acceptance criteria against the changed files.")` starts
verification directly; a separate initial `message` is unnecessary. Durable
sessions are created through topics, not `subagent(mode="session")`; the legacy
mode is rejected with topic-creation guidance. A call without `agent_type` inherits
the caller's role; selecting a mode does not grant additional tool capabilities.
Task creation is asynchronous: initial tool results acknowledge admission,
not model completion. The parent can continue independent work or finish its turn;
completion arrives as an event. Calls instead wait for the final result, without
a separate completion event. `report_to` can redirect task completion only.

Delegation follows a runtime-enforced hierarchy, further narrowed by role tools:
root/topic sessions may create task/call; tasks may create only explicit call;
calls cannot delegate. Omitted `mode` defaults to `task`, independent of the
selected role's default. Creator/context ancestry does not confer delegation ownership.

Calls cannot yield, send session messages, or schedule deferred coordination.
When a call needs input or permission, it returns a blocker with any partial work
and side effects; the caller decides or yields and can issue a new call. Cancelling
the caller cancels its blocking call. This does not roll back external side effects.

Subagent executions never create native platform threads. Temporary tasks/calls
remain internal; durable topics are web-visible peers. Platform thread support
never widens delegation permissions.

Blocking `subagent(mode="call")` must be invoked directly, not from exec/scripts or
`invoke_tool`. A call has a 120-second execution deadline; cancellation cleanup can
take up to another 10 seconds. Permitted local `exec` remains available inside the
call, but only in the foreground: `timeout_ms` is an integer from 1 to 120000,
defaulting to 120000. Zero is rejected, and timeout/abort terminates managed work
instead of returning a background task ID. Foreground call exec is currently
local-only; remote exec fails explicitly. Local session/task exec behavior is unchanged.

Session/task conversations bound to a connected Child workdir can run bounded
foreground OS-shell commands through `workdir.process.execute`. The Child resolves
the working directory from its configured capability root. Paired nodes are
trusted: supported commands and file operations run without per-operation
approval or grants. Omit `shell` to use the Child's default, not Main's detected shell.
Remote inline Node/TypeScript, background execution, and call-mode exec remain
unsupported. Shell commands run as the Child user: a workdir is not an OS sandbox.

Main's authenticated administrator API has a dedicated remote-conversation path:
`POST /projects/<id>/api/sessions/remote` with
`{"nodeId":"child-id","capabilityId":"workdir-id"}`.
This verifies remote folder ownership and creates or reuses the project's
folder before creating the conversation. An optional UUID `requestId` makes
retries refer to the same conversation; reusing it for a different capability
returns a conflict. The unscoped legacy endpoint targets Default.
For remote Start from scratch, send `{"nodeId":"child-id","requestId":"<uuid>"}`
without `capabilityId`; the UUID is required in this mode. A supporting Child allocates a private managed session
workdir; the returned opaque `workdir` is persisted with the owning Project's
session, with no `folderId` or Project folder registration. Retrying the same
request reuses the session and managed directory. Older Children return an explicit
unsupported error and must be updated before using this mode.
The Child retains these directories under `managed-session-workdirs-v1` in its
data directory, including across restarts and conversation deletion; deleting a
conversation does not automatically remove remote files. Configured static workdir
roots must not overlap this managed storage.
For an already registered folder, first send instead uses
`POST /projects/<id>/api/folders/<folder-id>/sessions`, also accepting
an optional UUID `requestId` (an empty body remains supported). Remote projects
revalidate their saved folder identity; retries reuse the conversation rather
than selecting a new capability, and a request ID owned by another project is
a `409` conflict.
The explicit-folder mode accepts only an online workdir capability, not an absolute/display path, and
returns `folderId`, `sessionId`, and `chatId` for the normal scoped chat endpoints. Its durable workdir
reference uses the existing JSONL/SQLite session state. Existing conversations are
not silently moved.

In the Main app, start a new conversation and choose **Execution location** next
to the model selector. Select a connected Child and its advertised workspace;
the selection remains a draft until the first message is sent. Offline/revoked
devices cannot be selected, and Main rechecks the capability when creating the
conversation. The session header identifies its owning device and workspace.
Switching the draft location does not move an existing conversation or transfer
local attachments. Remote file browsing is opened explicitly and loads directly
from the paired device; requests time out with a retryable message rather than
loading indefinitely. Remote Git status and diffs use the owning node's repository
and the same read-only inspection limits as local Git. Git staging, commits,
branch management and remote cloning are not added by this UI.
Pairing, connection authentication, revocation, workdir resolution and supported
operation validation remain in place. There is no additional node approval UI.
Execution approval policies, grants, pending requests, and the Child-local
approval API have been removed. Update Main and Child together: new wire
contracts reject the retired approval fields rather than silently bypassing an
old request's requirements. Saved registry snapshots automatically discard
legacy policy metadata while retaining paired identities and capability bindings.

For a blocked call outcome, the model returns raw JSON without Markdown fences:
`{"status":"blocked","reason":"Missing decision or permission","partialWork":"Actions already taken and side effects"}`.
For a failed outcome, it returns `{"status":"failed","error":"Failure, partial work and side effects"}`.
These produce explicit blocked/failed call receipts rather than an apparent success.
Normal successful calls may return their answer as text.

Durable topics appear as peers, not reusable children. Delegated tasks and calls
appear inline at their native `subagent` tool calls, starting before the tool
receipt arrives, with inspectable nested history rather than additional permanent
chats. Parallel calls are paired by tool-call ID, not arrival order or description.
Task completion is pushed into the conversation as an event with its result body
expanded; raw event metadata stays under Event details. Reopening the conversation
renders the same persisted event. A blocking call renders its returned result in
its original card, without a separate completion event. System self-reflection retains its
dedicated section. An asynchronous task does not make an idle parent appear busy;
a caller awaiting a blocking call is explicitly waiting rather than thinking or
waiting for human input. Call traces remain available for diagnostics while their
owning conversation exists, but only the final result crosses the caller's
context boundary. Deleting a conversation stops and recursively deletes its
delegated tasks and calls, including finished executions and nested call traces.
Ownership comes from each execution's persisted parent, not the optional child
list. Independent topics are retained; shared or ambiguous legacy histories are
still preserved for conversations that depend on them.

Agent definitions can set `defaultMode: session|task|call`. The old `ephemeral`
frontmatter is accepted with a deprecation warning (`true` maps to `task`, `false`
to `session`); replace it instead of supplying both fields. Existing session
history remains readable. Runtime describes the role and conversation audience
instead of injecting a generic Safety checklist; tool and execution contracts
still apply in every mode. `soul: false`
can explicitly omit SOUL context without changing execution lifetime.
Role defaults do not control `subagent` omission: it defaults to `task`.
Tasks must explicitly choose `call`; invalid choices fail rather than silently
changing execution behavior.

Session messages may include `intent: request|question|progress|handoff|acknowledgement`
and Project-validated `initiativeId`/`itemId`. Work references appear in the
first trusted sender envelope and provide context only. A receipt means admission,
not agreement to undertake work, completion, or ownership transfer.

**Yield decisions.** The `yield` tool pauses the current tool call with two
suggested options and one default. The model must not generate an Other/free-text
option: human custom entry is provided by the application. Root sessions ask the human; subagents ask their
stored parent, independently of `report_to`. The parent answers through the same
tool using `action: "answer"`, `request_id`, and an exact `option`; an ordinary
message does not resolve the request. Built-in agent types include this tool;
custom parents must enable it or the child receives an explicit error. Call mode
removes yield regardless of the role definition.

In the conversation UI, two-option decisions (such as yes/no) have direct answer
buttons plus a fixed **Write my own response...** entry. This opens a separate
text field and **Send response**, answering the pending tool call without touching
the chat draft or sending a new message. Legacy three-option questions retain
all radio choices and **Continue**, plus the same custom entry. The default
is preselected but not automatically submitted. Custom drafts survive polling
and failed submissions, but clear when the question/session changes or access is
revoked. Parent-directed questions are read-only to the human. Discord and Feishu
use native choices when supported by the current connection; a failed native send
falls back to `/yield <request-id> <1|2|3|cancel>` text instructions. QQ and iLink
currently use that text form. Humans can also use
`/yield <request-id> text <your response>` for custom text. Custom answers are
nonblank, at most 4000 characters, and returned in `option` with `custom: true`;
parent answers and timeouts still choose a preset. Questions are sent separately from progressive
response messages, so later output cannot overwrite their controls.

Channel answers and cancellation are bound to the human who initiated the turn,
not everyone able to see the message. Allowlisting, the exact pending request,
destination, and recipient are checked for both buttons and text commands;
expired, duplicate, and unrelated answers cannot resume another turn. External
root turns without an initiating human return a blocker instead of publishing an
unanswerable question. Parent-directed decisions and authenticated application
decision endpoints retain their existing behavior.

The default waiting policy is indefinite. Global `tools.yield.timeoutMs` accepts
`null` or a positive integer up to 2147483647 milliseconds. A session can override
it with `/config set yield wait` or `/config set yield 60000`; `/config unset yield`
restores the global policy. The equivalent session config PATCH is
`{"yield":{"timeoutMs":60000}}`, `{"yield":{"timeoutMs":null}}` for indefinite
waiting, or `{"yield":null}` to remove the override. Policy changes affect new
questions, not deadlines already in progress. On timeout the backend selects
the default and reports `answeredBy: "timeout"` to the agent. This is a decision
workflow, not a substitute for tool authorization or approval controls.

Question tool calls, answers and session policy overrides use the existing
JSONL/SQLite persistence. Active waiters and timers are in memory: cancellation,
session deletion and shutdown cancel them rather than adopting the default.
A backend restart does not restore a suspended tool call; interrupted tool
history is handled by the existing session recovery path.

Consecutive tool calls appear in a compact, collapsible activity list. Its
summary and file rows show green additions and red deletions from successful
`write` operations, including edit and append. Expand a row for the original
arguments and result. Counts sum each operation in the group (not a net Git
diff); multiple edits to the same path count as one file. Older results and
unreadable pre-write content show unavailable counts, and partial totals are
marked `*` rather than treating missing measurements as zero.

**Nodes** is the single device/capability view. Expand a device's **Capabilities**
to see actual resource types, names and availability. The former
`/workspaces` page redirects to `/nodes`; there is no separate Workspaces tab.
Nodes loads a read-only inventory from the backend, refreshes while visible, and
shows explicit connection/API errors rather than example devices. Unknown
versions, last-seen times, and remote paths are omitted. A capability is shown as
available only while its device is connected and the capability is online.
This does not add pairing/revocation controls or complete remote execution parity.
The retired Child Approvals route redirects to Nodes; paired devices need no
additional operation approvals.
After updating the backend, restart `pnpm desktop:dev` to enable the inventory API.
Internal capability IDs are not shown.

The composer's **+** menu offers **Add file** and **Add folder** in the local Main
desktop app. Native pickers support multiple selections; removable chips show
the selected context before sending. These are local path references included
in the message, not file uploads, recursive folder imports, or a change of
working directory. Reading them still uses the agent's filesystem tools and
their existing access controls. Native context selection is unavailable in the
browser and on Child installations; it does not imply remote file-transfer support.

Folder registrations persist in `<workspace>/folders.v2.json`; session
associations persist in the selected JSONL or SQLite store.
Reopening the same canonical folder reuses its project; existing unassociated
conversations remain under **Chats**. Start from scratch retains the managed
session-directory behavior and does not use the OS home directory. Session
history and uploaded attachments remain in Main's private session data, separate
from the selected project's working directory. This folder registry is distinct
from the agent `project` tool's named planning documents.
Upload API callers should preserve the returned `path` unchanged: new uploads
return absolute private-file references, while relative media paths refer to the
session's actual working directory.
An existing `restrictToWorkspace=true` policy still prevents the write tool from
writing outside Main; opening a project does not silently disable that policy.

Clone repo accepts a repository URL and a new child directory inside a selected
existing parent. Git runs on Main without a shell command string or new OAuth
flow, using the machine's existing noninteractive authentication. The UI supports
progress, errors, cancellation, and retry. A destination that already exists is
never overwritten; failed or cancelled clones keep partial files for inspection.
Only successful clones become projects. If registration fails after cloning,
recover the checkout with Open folder rather than cloning over it.
Accepted transports are credential-free HTTPS, SSH Git URLs, and local `file:`
URLs. Passwords, queries, fragments, and Git remote-helper command syntax are
rejected. Remote cloning requires Git and suitable existing credentials or SSH
configuration on Main.

The optional layout regression uses the built renderer in hidden Electron
windows with synthetic APIs and disposable project-local profiles. It does not
connect to a running Main or use saved credentials:

```sh
pnpm build:app
pnpm exec node --import tsx --test desktop/tests/layout.node-test.ts
```

The `app` renderer uses Vite 8 and Vue Router 5 with explicit routes. UnoCSS's
`presetWind3` retains the existing utility styles; `presetIcons` loads local
Lucide (general UI) and Simple Icons (brands) collections on demand. Icons are
compiled into CSS masks using `currentColor`, without a runtime icon CDN or
shipping the entire collections. Source scanning includes Vue templates and
TypeScript class maps before the first development stylesheet response, so
layout, spacing, typography and icons do not depend on route-load order or a
later HMR update. This includes System prompt and Tools cards in Diagnosis.
Project sidebars omit empty-conversation/folder guidance and hide empty Chats
and Automations sections; folder rows and creation actions remain available.
Loading, offline and retryable error states are still shown.

```html
<span class="i-lucide-folder-open w-4 h-4" aria-hidden="true"></span>
<span class="i-simple-icons-github w-4 h-4" aria-hidden="true"></span>
```

Keep full icon class names in source (including both branches of conditional
classes); do not construct names like `i-lucide-${name}` that the extractor
cannot see. Icon-only buttons still need an accessible label on the button.
Prefer Lucide for new UI controls; native window glyphs and custom illustrations
can retain their purpose-built SVGs. Add further collections as local development
dependencies and register them in `app/unocss.config.ts`.

Packaging uses `pnpm deploy --prod --node-linker hoisted` to include a portable
backend without development-tree symlinks; only built modules, runtime dependencies,
and assets are copied, never the local workspace
or credentials. Electron runs the backend module in a separate process using its own Node runtime
(`ELECTRON_RUN_AS_NODE=1`), not a Deno-compiled executable. The renderer is
sandboxed with Node integration disabled; a narrow preload bridge handles setup,
and the main process owns backend startup, authorization, and shutdown. The
distributed setup/Child flows remain WIP.

An explicit [Windows service mode](docs/release.md#opt-in-headless-windows-service)
uses the bundled WinSW host and Electron's Node mode. In this mode the desktop
attaches to an independently managed backend and does not stop it on exit.
Service registration is a separate, administrator-approved operation, never
performed by the build or automatically by ordinary desktop startup.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Backend and Vite together |
| `pnpm start` | Backend without watch or inspector |
| `pnpm build` / `pnpm build:app` | Backend / web build |
| `pnpm build:all` | Both production builds |
| `pnpm test` | Backend, script, and frontend logic tests using Node's test runner |
| `pnpm test:desktop` | Electron lifecycle and bootstrap tests |
| `pnpm test:release` | Focused build, packaging, service-mode and Electron release checks |
| `pnpm test:packaged` | Exercise a built Windows package after relocating it outside the repository |
| `pnpm typecheck` | Backend/scripts, desktop and Vue application typechecks |
| `pnpm desktop:dev` / `pnpm desktop` | Desktop development / Windows installer |
| `pnpm web:pair --connection <absolute-path>` | Issue a short-lived code for a browser session on a protected local backend |
| `pnpm migrate:sessions <directory>` | Explicit JSONL-to-SQLite history migration; retains source files |
| `pnpm dev:searxng` | Optional SearXNG service |
| `pnpm dev:docker:compose` | Development container with Chrome/Xpra and SearXNG |

Tests support targeted execution with
`pnpm exec node --import tsx --test src/runtime/backend-cli_test.ts`.
Use `pnpm test:update` only when snapshot changes are intentional.

## MCP and optional skills

Configured MCP servers stay in a lazy catalog, including after configuration
reloads; their tools are not added to the model's base function list.
`search({space: "tools:", query, limit?, offset?})` searches names/descriptions and returns
only matching tools' exact names, descriptions, parameters and `indexedAt`
timestamps (default 3, maximum 10).
Use `space: "tools:mail"` to select a source. Empty, whitespace or omitted query
lists tools in stable name order; pass `nextOffset` as `offset` to get the next
page (`null` means the end). The same `search` tool retains grep:/glob:/web:;
there is no separate tool-discovery function in the base tool list.
It uses keyword ranking, not embeddings. Global and targeted configured MCP
searches read the persistent index: no connections, `tools/list` RPCs, tool
execution or dynamic registration, including repeated searches offline.
Even 100 installed servers will not start from search. Missing, mismatched or
corrupt index records produce explicit source errors, never automatic connections;
read/save `v:config/mcp.json` to build missing metadata. Deferred built-in
browser/factory sources are explicit; selecting one may initialize live resources.
`read("v:tools")` remains a connection-free source listing.

Use `invoke_tool({name, args})` directly for a known tool ID. It connects lazily
and lists live tools, refreshing the index and validating arguments against the
current schema before execution, with no
separate import/disclosure round trip. Invalid arguments return the target
tool's contract without executing. Changed configuration/tool listings invalidate
old adapters; sleeping clears session connections, which known MCP IDs can recreate.
Indexed metadata can become stale; the live invocation contract wins.
There is no persisted "schema already seen" flag. Skills remain optional guidance
for MCP; skill-declared TypeScript tools require an exact skill read as below.

### Configure Project MCP servers

Use existing `read` and `write` tools on **`v:config/mcp.json`**, not application
configuration or source files. The dedicated `v:skills/mcp-config` skill explains
the workflow. Read the document first; it contains an opaque `revision` and an
`mcpServers` map. Secret values are redacted as placeholders; preserving an
unchanged placeholder preserves its stored value.

For example, add a stdio and HTTP server to the document returned by the read:

```js
read({ path: "v:config/mcp.json" })
```

Retain all unrelated entries and the actual returned revision; then write the
complete edited JSON string using `write({path, content})`:

```js
write({
  path: "v:config/mcp.json",
  content: JSON.stringify({
    revision: "<opaque revision from the read>",
    mcpServers: {
      // Include all existing entries that should remain.
      localApi: { command: "node", args: ["C:\\tools\\local-api\\server.js"] },
      teamApi: { type: "streamable-http", url: "https://mcp.example.com/mcp" }
    }
  })
})
```

Use actual server paths/endpoints and never submit the illustrative revision.
Add or edit map entries to configure servers; remove an entry to remove its
configuration. Stdio uses `command`, `args`, and optional `env`; HTTP uses
`type: "streamable-http"`, `url`, and optional `headers`. HTTP headers do not
automate OAuth login. Keep credentials out of committed files and chat.

Writes validate the whole document and persist atomically through
`ProjectConfigStore` in the **current Project**. A stale revision is rejected
with a reread instruction: reread, preserve concurrent edits, and reapply the
intended change. Before committing configuration, missing/new/config-changed
metadata is collected through temporary connections and paginated `tools/list`,
then the connections close. Indexing never executes tools or retains a runtime
connection. Matching cached records are reused; removal needs no new connection.
Indexing runs in batches of up to three with 60-second per-source timeouts.
Failure aborts the save, leaving prior configuration and runtime catalog unchanged.
An unchanged resave can index legacy configurations missing metadata.

Private, configuration-bound, content-addressed records are atomically persisted
under Project Home `.mcp-tool-index` before the configuration commit, without raw
configuration or credentials. Unreferenced records may remain for rollback;
configuration activation rollback still applies. Restart restores only the
source catalog with zero connections. Report servers as installed/indexed, not
guaranteed currently available or executable. Targeted search reads cached
metadata too; invocation is a separate operation with possible side effects.

Exact edits also use the existing `write` API: `{path, match, content}`, with
optional `flag: "g"` for all matches. They edit a remembered redacted read
snapshot scoped to the logical and physical session, require a prior read,
and remain revision-checked. Whole-document overwrite must carry the revision
explicitly. See the `mcp-config` skill for both write forms.

### Discover skills and activate script tools

Ordinary learning edits the shared Project Skill space directly; it does not
need an authoring Change, approval or publication. Discover `skill_read` and
`skill_save` with `search({space: "tools:", query: "skill"})`, then invoke them.
The Project coordinator has these scoped tools directly, without general
filesystem write or script-execution access.

```ts
invoke_tool({ name: "skill_read", args: { name: "csv-utils" } })
invoke_tool({ name: "skill_save", args: {
  name: "csv-utils",
  files: { "SKILL.md": "...complete updated content...", "tools/summary.ts": "...complete source..." }
} })
```

`skill_read` returns raw SKILL.md plus the file listing, or a named text resource
with `path`; `offset`/`limit` page long files without activating tools. The host
remembers the read baseline internally. Save new Skills directly; read existing
ones first. One save merges all supplied file edits, with `null` deleting a
resource, and validates the complete result before replacing the package.
Stale edits fail and must be reread/merged. Built-ins are read-only through this
API; adapt them with a different Project Skill name. There is **no automatic
backup, Git history or rollback**. Temporary transaction files are not history.
Packages are bounded to 256 regular files, 512 entries, 8 MiB total and 16 path
components; unsafe paths, symlinks/junctions and hard-linked files are rejected.
These package checks also apply when activating or invoking declared scripts.
Saving grants no execution permissions and does not deploy or pin resources
for Bots or fresh cron sessions; existing Bot publication stays separate.
The scoped edit tools currently require a durable local web topic/coordinator.

System-prompt Skill hints have a **1,200 estimated-token budget**, combining
capped core hints, this session's recently used Skills and Project recency.
Learned Skills are eligible. Only successful exact Skill reads and saves
promote usage; passive search/listing does not. Recency is in memory and resets
on restart. Omitted Skills remain searchable and readable; nothing is deleted,
and already activated tools are not evicted by this disclosure budget.

JavaScript/erasable TypeScript tools must belong to a discovered skill folder containing `SKILL.md`.
One skill declares one or many tools in its YAML frontmatter:

```yaml
---
name: csv-utils
description: Summarize and format CSV text
tools:
  csv_summary:
    source: tools/summary.ts
    description: Summarize CSV text
    parameters:
      type: object
      properties:
        text: { type: string }
      required: [text]
      additionalProperties: false
    imports: []
  csv_format:
    source: tools/format.ts
    description: Format CSV text
    parameters:
      type: object
      properties:
        text: { type: string }
      required: [text]
      additionalProperties: false
    imports: []
---
```

The skill body explains when to call each alias and its execution arguments.
Metadata lives only in `SKILL.md`: `source`, `description`, `parameters`, `imports`.
Source modules export `async function run(args)`. There are no metadata exports,
`init`, `execute`, source-path tool loading or legacy compatibility adapters.
Declared `@shadow/<tool-name>` imports expose module calls rather than a
`callTool` argument; invocation remains subject to session tool permissions.
Sources are relative to the owning skill directory only, with realpath
containment checks; absolute paths and standalone external modules are not
accepted. Keep source files in place; imports use the supported native/module
catalog, not arbitrary packages or source-file loaders.

```js
search({ space: "skills:", query: "CSV", limit: 5, offset: 0 })
read({ path: "v:skills/csv-utils" })
invoke_tool({ name: "csv_summary", args: { text: "name,count\napple,2" } })
```

Skill search returns names, descriptions, and read paths; `skills:<category>`
optionally narrows it. Search, index/category reads, and bundled resource reads
do **not** activate tools. Only the exact skill read registers its declarations
in the **current session**, without importing or executing source in Main.
After that read, direct invocation needs no additional preparation and validates
the declared parameter schema. After activation,
`search({space: "tools:csv_summary", query: ""})` reads metadata without executing
source. Invocation uses the shared child/VM engine with controlled imports;
host `exec` uses the same engine with host policy, not the tool import policy.
Neither policy nor the process boundary is an OS sandbox.
Rereading the exact skill refreshes changed instructions, declarations,
entrypoints and resources. Registration captures the current package content
fingerprint and executable text. Later imports and invocation validate that
fingerprint; changes require a fresh read instead of silently switching code.
This is change detection, not an execution snapshot: concurrent external edits
during execution may already have side effects before the post-execution check.
Registrations are not shared across sessions. Invalid tool declarations remain
discoverable with `toolsError`, but the exact skill read fails explicitly.

Declarations persist only in `SKILL.md`, not a Project tool-installation registry.
New sessions and sleep/reset require reading the owning skill again. MCP
configuration remains persistent Project state and is independent of this
session-only activation. No extra installation or explicit import tool is exposed.

MCP loading failures return a structured `mcp_error` diagnostic, including the failure
phase, available HTTP/RPC/OS codes, sanitized causes, and whether retry or user
help is appropriate. Tool discovery no longer silently reconnects and hides the
first failure. Agents are instructed to make only bounded recovery attempts and
ask for specific help when authentication, permissions or repeated failures
require it. This does not automate credential changes or retry tool side effects.

Use virtual configuration reads/writes for MCP, exact skill reads for skill-tool
activation, and `invoke_tool` for execution; no explicit import step is needed.
MCP calls preserve structured results, error flags, and non-text content blocks
as JSON when needed. These are still textual tool results, not native model
image/audio attachments. Valid JSON text has Unicode string escapes normalized
for readability, without changing values, numeric literals or nested strings
such as `rawResponse`. Existing stored traces are not rewritten.
See the [architecture reference](docs/architecture.md)
for session lifetime and execution boundaries.

## Scheduled conversations

Scheduling uses three dynamic tools: `cron_add`, `cron_list`, and `cron_remove`.
Discover them with `search({space: "tools:cron", query: ""})`, then call the
selected tool through `invoke_tool`; there is no `action` parameter.
`cron_add` requires `schedule` and `task` and supports two context modes:

| `session` | Execution context | Sidebar |
| --- | --- | --- |
| `existing` (default) | Append events to `targetSessionId`, or the current conversation when omitted | Ordinary conversation |
| `fresh` | Start an independent context for every run | One entry under Automations, with run history |

Existing jobs require durable source and target sessions in the same Project.
Scheduling another session requires permission to message it; access is checked
both when saving and before each tick. The target keeps its own agent, tools,
workdir and history, not the creator's configuration. Missing targets are errors,
not an instruction to create a new session. To give recurring work a dedicated
conversation, create a topic first and schedule its returned session ID.
`urgency` (`queue`, `steering`, `debounce`, `silent`) applies only to existing
jobs; `debounce_ms` requires `urgency: "debounce"`.
`cron_list` takes no arguments; `cron_remove` requires the job `id` and leaves
session history intact. All three remain dynamically loaded, not base tools.

Fresh jobs accept a readable `name` and an optional `agentType`. They retain the
origin's project/effective workdir reference, not its conversation transcript.
Remote workdir references remain capabilities and are revalidated; a missing
origin or unavailable workdir is not silently replaced by Main's filesystem.
Reflection, encapsulation, and soul reflection register managed fresh jobs on
the same project scheduler. Their activity gates and reflection watermark
remain in effect, so a check does not necessarily create a conversation.

Run identity and execution status are retained with session metadata in JSONL
and SQLite. Removed definitions with retained runs remain visible as inactive
history. Legacy built-in runs are narrowly classified by their original source
address and agent type; their outcome is shown as unknown, not inferred from
dispatch acceptance.

### Existing cron jobs

The Node scheduler uses standard cron weekdays: `0` (or `7`) is Sunday,
`1` is Monday, and names such as `SUN` and `MON` are supported. Deno used
`1` for Sunday, so old expressions must not be reused without review.

Cron storage now has the shape `{ "version": 1, "jobs": [...] }`. Startup
rejects the old unversioned array in `<workspace>/.cron/jobs.json` without
executing or overwriting it. Before upgrading an existing workspace, move that
file to a backup, then recreate the schedules with `cron_add` after confirming
their weekdays and timezone. Do not simply wrap the old array in the new format.
There is no automatic conversion or Deno scheduling compatibility layer.
The former `origin`/`isolated` modes and `isolated` boolean are no longer
accepted; no migration for those definitions is provided.

## Gateway and trust boundary

| Path | Purpose |
| --- | --- |
| `/api/*` | Configuration, sessions, providers, web chat, and runtime APIs |
| `/v1/traces`, `/v1/logs`, `/v1/metrics` | OTLP/HTTP JSON ingest |
| `/v1/query/*` | Stored telemetry queries |
| `/api/live` | Shared, cursor-based SSE for project-qualified chat, sessions, logs and spans |
| `/api/chat/send` | JSON message admission; live output uses `/api/live` |
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
