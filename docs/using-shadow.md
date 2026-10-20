# Using Shadow

Shadow is a personal, local-first agent. Its web UI and Electron window connect
to the same Node backend; Electron provides setup and native-window controls, not
a separate agent implementation. The [architecture reference](architecture.md)
explains the implementation and its limitations.

## Desktop setup

The recommended first-run path is **Get started → Connect a model service →
Start chatting**. You do not need to choose a deployment role or data directory:
Shadow defaults to running the workspace on this computer (Main), with local
execution enabled, and uses its saved data directory or the default `~/.shadow`.
Initialization runs automatically rather than asking for a separate confirmation.

The model-service step contains the real provider connection form, including
GitHub.com / GHE.com Copilot login, API-key providers, and local endpoints. The
backend starts for setup, but the wizard remains unfinished until the connection
is ready and you choose **Start chatting**. Already configured installations can
reuse their connection after a readiness check.

**Advanced settings (optional)** on the welcome page keeps the less common choices:

- **Choose a different data folder** opens the directory page. Keep the suggested
  path, enter another full path, or browse. No existing data is moved or deleted.
- **Also run tasks on this computer** controls Main's local execution capability.
  The choice is saved with setup progress and reused when Main launches or
  restarts. It is not a local-model/provider setting.
- **Connect to an existing workspace** selects Child for an additional device.
  Child executes supported remote tasks for an existing Main; it is not another
  independent workspace. It does not show a redundant local-executor toggle,
  and pairing still requires explicit execution consent.

With local execution turned off, Main still runs the model/session loop and
manages its data. Agent local commands, inline Node scripts, executable tool
imports (including MCP and browser tools), and local Quick Action runs are
blocked. Existing Quick Action definitions are retained. Supported remote
execution requires an explicitly selected Child workdir/capability; merely
connecting a Child does not automatically relocate a local session or make
every tool remote-capable. Unsupported tools report an error instead of
silently executing on Main. Remote inline Node scripts and remote leaf-call
execution remain unsupported.

This is a task-execution capability setting, **not an OS sandbox** or a way to
run the model on Child. Main retains file/network operations, installed
fixed-purpose search helpers, and provider/auth/channel infrastructure. Owner
configuration changes may still perform MCP discovery; agent-initiated virtual
MCP configuration writes are blocked before executable discovery.

There is no separate local-capabilities or initialization confirmation page.
Unfinished older setups retain their saved role, directory, and execution
preference. Setup retries continue from the saved stage; even a legacy launch
stage checks the provider connection instead of treating the former information
page as completed authentication. An older Desktop without the provider-setup
runtime command must be updated; setup does not silently skip the connection.

## Windows computer use

In a local Main conversation, open **Computer use** above the composer, refresh
available windows, and explicitly share one already-open application. Sharing
lasts up to 10 minutes; every modification requires its own **Approve once**
decision. **Stop all desktop access** revokes the host-wide lease without closing
the application. Browser work continues to use the existing browser tools.

This first version prefers Windows accessibility controls and window-only
screenshots. **Allow foreground keyboard and mouse** is a separate, default-off
sharing option; each input still needs approval, and coordinate reviews show
the exact screenshot. Foreground actions briefly activate the window; taking
over stops further input, not input already delivered. Elevated applications
and remote desktops remain unsupported. Window contents go to the configured model.
Read [computer use](computer-use.md) for privacy, recovery and compatibility
boundaries before sharing sensitive applications.

## Language

Choose **English**, **Simplified Chinese**, or **System language** using the
language selector in the window header, mobile navigation, or
**App settings > Language**. The selector is also available on browser/mobile
login screens and in desktop setup and recovery, before a backend connection
is established.

The default follows the browser/device language preferences, using the first
supported English or Chinese language and falling back to English. Chinese
variants currently use Simplified Chinese. Changing the selection updates UI
copy, accessible labels, and date/number formatting without reloading or
discarding unsent input.

The preference is saved locally for this browser profile and app origin, not
in a Project or on Main. Other tabs at the same origin synchronize the choice.
If local storage is unavailable, the app reports that the choice cannot be
saved but still applies it to the current window. UI language does not alter
agent responses, prompts, conversation history, filenames, or original
provider/tool output.

Messages between conversations identify their direction explicitly: **Received
message** (or its request, progress, handoff or acknowledgement intent) names the
source conversation; **Send to** names the target. An outgoing message retains
its delivery status: **Queued** is not completed work, and **Recorded silently**
does not wake the recipient.

## Completion notifications

In Electron, a successfully completed conversation turn produces a native system
notification when the Shadow window is not focused (including when minimized).
It names the conversation and Project; clicking it restores the window and opens
that conversation. Focused windows, failed/cancelled turns, internal task/call
agents and replayed history do not produce completion notifications. System
notifications work even when app sounds are muted or have not been unlocked.
Notification sounds remain governed by the app's sound settings; the system toast
itself is silent. Windows notification settings and Do Not Disturb may suppress
the toast. Restart Electron after upgrading to load its native notification bridge.

The web app uses the browser's system notification API. Use the **bell** button
in the app header (also available in mobile navigation), or **App settings >
Sounds > System notifications**, to enable it and grant permission. This choice
is saved for this browser/site, independently of sounds, and no permission prompt
appears automatically. Notifications use the same named completion and click
navigation as Electron, but require a supported browser and HTTPS or localhost.
If permission was denied, allow notifications in the browser's site settings
before enabling them again. The page must remain open and running; this is not
background Web Push for closed or suspended pages.

## Quick Actions and conversation Search

Open an existing chat and use **Actions** beside Search to create reusable
command buttons or import selected npm scripts. Each action saves an explicit
local Folder target; it does not inherit whichever chat is open. Pin the same
action to the Project Dashboard for quick access. Runs expose status, logs, and
Stop, and execute directly rather than starting a model conversation.

Search opens as an overlay without pushing the message view down. Escape or
clicking outside closes it; navigating search matches still scrolls deliberately.
See [Project Quick Actions](quick-actions.md) for execution risks and limitations.

## Projects, folders, and conversations

The sidebar displays multiple Projects at once; there is no global project
switcher. Each Project owns its Home, conversations, memory, bots, automations,
skills, and settings. Provider credentials and paired devices are shared at the
App level. Project isolation is **not an OS sandbox**: permitted host tools still
run with the backend user's permissions.

Use a Project's **+** menu to open a local folder, clone a repository, or start
from scratch without selecting a folder. A folder's **+** starts a conversation
in that folder. A new draft does not create a session until its first message is
sent. Selecting the Project name opens its **Dashboard** as a permanent tab,
alongside Knowledge, project settings, agents and open files. The Dashboard groups
recent focus by inferred shared purpose, then shows separate topics with their latest
reports and expandable evidence/decision history. Model interpretations are not
confirmed user intent; legacy topics without inference remain unclassified.
**Organize recent topics** explicitly calls the configured observation model once on
bounded recent saved notes, including existing notes. Opening the page does not call
it. Results show their time and source note versions; failed organization keeps previous
results. Errors distinguish busy/changed notes, invalid model JSON or citations,
model availability and a failed overview refresh; the latter may follow a successful save.
The main work views are **Dashboard** and an issue-style **Board**. Expanded topics
show saved goal/approach/task/finding roles, parent links, supports/requires/assumption
relations and dependencies (including cross-topic links). Missing roles or causal
relations are shown honestly, not inferred from model topic categories. The causal
map and relation graph are expandable local sections within the Dashboard, not
separate view entries. Native questions and decision history retain their navigation.
**Coordinator**
opens a separate, resizable right-hand panel; switching document tabs keeps its
conversation and unsent draft. On narrow screens, the panel uses the available
space until you close it to return to the selected tab. Folder and conversation
rows open their own views. **Automations** lists scheduled tasks
that start fresh conversations, with their run histories. Selecting an automation
opens its latest run directly in the ordinary conversation workbench, with the
same Conversation and document tabs and file-explorer behavior as other chats.
Use the conversation's **Previous**, **Next**, and **Current** history controls
to browse earlier runs, just like compacted conversation segments. Older pages
load when needed; a deep link to an older run keeps that conversation selected.
The current view follows new runs, while browsing history keeps the selected run
in place. Each run retains its own session ID and independent context; this
navigation does not merge transcripts or change scheduled execution.
Schedule, agent, dispatch state and prompt are available under the collapsed
**Automation details** disclosure in the conversation, not a separate runs
explorer or Configuration tab. An automation without runs shows an empty state.
Refreshing history retains the selected conversation when a refresh fails.
When the app becomes visible again, this list keeps its last loaded state while
refreshing. An already-empty section stays hidden unless loading fails; the
loading placeholder appears only before the first successful load in a Project.

Learning runs show **Applied**, **No change**, **Partial**, **Blocked**, or
**Draft only** independently of their execution status. Opening a run shows the
reason and recorded artifact/event/evaluation counts (artifacts are verified for
Applied results). **Unverified** means an
older completed run has no learning receipt, not that its effects were checked.
Retry/paused notices explain when configuration needs attention. Use
`/learn reflector`, `/learn encapsulator`, or `/learn soul-reflector` to explicitly
retry a paused batch; existing effects are retained rather than blindly replayed.
See [learning outcomes and recovery](tools-and-automations.md#learning-outcomes-and-recovery).

There is no standalone **File changes** tab. Expand a successful **Write**,
**Edit**, or **Append** tool call in the conversation to see its recorded
single-column file diff, with source syntax highlighting, line numbers and
added/removed lines. **Details** retains the original arguments and result.
The preview loads only when expanded and is matched by tool-call ID, not
reconstructed from the current file or Git working tree.
Filesystem write history remains recorded on the backend, including
learning sessions that update memory. Records persist across restarts and session segments; a
fork's inherited parent conversation does not attribute the parent's writes to
the child. Direct writes and writes invoked through script tools are recorded.
Shell commands and virtual configuration/authoring transactions are not
filesystem write records.
If a file is written but saving its history fails, the turn stops with an
explicit error instead of automatically retrying and applying the write twice.

Each `file_change` event stores a compact, headerless unified `patch` string in
the existing JSONL session log or SQLite `session_logs` table. Structured hunks
are parsed only for display, not stored alongside the patch. There is no separate
diff store and no reconstruction or compatibility reader for older hunk records.
The patch compares observed pre-write text with submitted write text, not a
post-write read-back; CRLF-only differences are ignored.

The model receives a short receipt such as `OK edit +2 -1 edit=<id>`, plus match
counts and any no-op, fuzzy-match, newline-normalization or unavailable-diff
notices. Source excerpts are not echoed. `view_edit({ "edit_id": "<id>" })`
returns only that edit's saved patch, on demand, from the current session's own
segments. It cannot select another session. Empty patches report no content
changes; unavailable or missing details report an explicit error.

Unreadable, oversized, or computationally expensive diffs report their limit
instead of inventing a diff; a bounded written-content fallback may be shown in
the UI. Stored patches are bounded to 65,536 characters, with a
2,097,152-character input and 100 ms computation limit; the history API returns
pages of 30 writes. Diff persistence failures after a write stop automatic retries.

Project settings hide the conversation input and its status controls so they do
not cover the settings form. Returning to the conversation restores the input
with its unsent draft intact.

Use **Project settings → General → Delete project** to delete a non-Default
project. Confirm by typing its name. Deletion removes
its Home (including conversation history, memory, skills, bots, automations and
settings) and releases folder registrations; actual working folders and their
files are kept. Stop active work and reconcile uncertain remote jobs first.
The Default project is required and cannot be deleted. If cleanup is interrupted,
the project stays unavailable; retry deletion or restart Main to resume cleanup,
rather than restarting it over partially deleted Home data.

The folder row's **...** menu can remove it or move its membership to another
Project. Neither action moves or deletes files. Existing conversations and
knowledge remain in the original Project and cannot keep using the former
folder. Stop active work before changing folder membership. Remote folder
registration requires a compatible, online Child; it never interprets a
remote display path as a local Main path. See
[Project ownership and storage](architecture.md#projects-ownership-storage-and-routing)
and [two-device pairing](desktop-pairing.md) for those boundaries.

Model, effort, and temperature preferences resolve independently from the
conversation, then Project, then App, then built-in defaults. Unset a preference
to inherit rather than copying the currently resolved value. Provider
connections belong to **App settings**, while Project defaults belong to
**Project settings → Models**.

[Multiple provider accounts](provider-instances.md) can share the same provider type.
Use stable instance IDs for model references and editable display names for labels.

For Copilot accounts on **GitHub Enterprise Cloud (`*.ghe.com`)**, open the
Copilot provider's sign-in form in **App settings**, choose **GitHub Enterprise
Cloud**, and enter the host where your account has its Copilot license (for
example, `msft.ghe.com` or `microsoft.ghe.com`). Complete the device authorization
at the enterprise address shown in the form. These hosts are separate sign-in
targets, not interchangeable aliases for `github.com`. The default GitHub.com
option continues to support existing personal and organization accounts.

A successful sign-in switches the installation's active Copilot host for all
projects. Pending, cancelled, or denied authorization does not switch it.
Credentials and model caches are separated by host, and the selected host is
remembered across restarts. Signing out removes the **active host's** local
credentials and model cache; it does not revoke browser/enterprise authorization,
activate another saved host, or remove credentials saved for other hosts.
Switching hosts requires using the sign-in form again. Enterprise SSO, a Copilot
license, and the enterprise's access policies still apply. Only GitHub.com and
single-tenant `*.ghe.com` hosts are supported, not arbitrary GitHub Enterprise
Server URLs. Shadow's provider login is separate from the official Copilot CLI
or the standalone A2A bridge's login.

Copilot `model_not_supported` means the requested model was rejected for that
request, not necessarily that the configuration file has a typo. The diagnostic
names the actual `model@copilot` and endpoint. Refresh the model list, check the
exact ID and account access, and inspect any conversation or agent override as
well as the Project default. Endpoint and reasoning-capability errors are also
reported explicitly. These failures do not silently switch models or replay the
generation request; learning pauses until configuration is corrected or retried
explicitly. A historical failure does not prove the current selection is invalid.

The **Agents** tab groups searchable role definitions by Built-in and Workspace.
**Overview** shows the selected definition's default mode, explicit model
overrides and tool filters. **Tools** and **System prompt** inspect the assembled
preview separately; tools expand to show parameters, and prompts can be read as
formatted text or exact raw text. Copy JSON exports all resolved tools, even
when the list is filtered.
**Preview channel** is available in those two inspection views. It changes the
preview's channel, not an existing conversation.
Previews do not create sessions or inherit a conversation's history, configuration,
published bot policy, or Work bindings. Real session context retains those checks.

## Discord configuration

Open **Project settings > Bots > your Discord Bot > Discord access** to
discover named servers, channels, roles and people; publish Agents; and review
channel/DM assignments and knowledge publication. One Bot may use different
Agents per channel. Unassigned channels/DMs are closed, including previously
configured legacy admin chats. Participant restrictions select callers, not
who can read the channel's replies.

Alternatively, ask the Project **Coordinator** to configure a named Discord
channel. Its `channel_config` tool discovers Bot connections and platform
resources, reads exact revisions and drafts changes. You still approve the
exact change in Discord access; the model cannot approve. Authorized Discord
management channels may submit only bounded proposals for their own Bot.
**Preview applied access for a person** shows the effective prompt/tools without
calling a model; generic Agent previews do not establish platform authorization.
See [Discord access](channels.md#discord-agents-and-channel-access) for thread/DM
rules, clean contexts, recovery, trusted-execution warnings and live-test limits.

## Project knowledge

Use the book icon to open the current Project's **Knowledge** tab without
leaving the conversation. It browses memory files, Wiki pages, and effective
skills, and shows explicit references between entries; a graph edge is not a
semantic inference. Built-in skills are read-only. Deleting an entry removes
only that file, not its incoming references or already-loaded instructions.
Agent learning can later recreate deleted knowledge.

This file-backed Project browser is an owner surface, not the scoped Discord
memory catalog. Restricted Discord Agents do not inherit its files, global
SOUL, indexes, events or other conversations. Their notes, summaries and learned
skills remain in a Conversation domain for the current authorization epoch.
Use **Discord access > Knowledge** to inspect domains, review fixed-copy sharing,
revoke access and inspect conversation-learning status. Reusing an Agent in
two channels does not share their memory. Deleting a legacy Project file is
not the same operation as revoking an approved Discord publication.

Markdown links in the preview open linked knowledge entries in the same
Project, including relative paths and `v:memory/` / `v:skills/` aliases.
Section links scroll to the matching heading; web links open separately.
Missing catalog targets show **Unresolved reference** rather than navigating
away from Shadow. Other unsupported local links show a message with guidance
to refresh or check **Link health**.

For requests about memory, Wiki or knowledge, agents first read the built-in
`v:skills/project-knowledge` Skill. The shared system prompt carries only this
loading cue; the Skill owns storage aliases, operation rules, safe imports,
references and coordinator delegation.

**Wiki is a category within the Project memory store, not a separate service.**
Agents read/list it through `read` on `v:memory/`, or use `search` with
`handler: "glob"` / `handler: "grep"` and `path: "v:memory"`. There is no `v:wiki`
mount or dedicated Wiki tool. Authorized local workers create/update shared
Wiki Markdown at paths such as `v:memory/topics/xmcl-ops.md`; the Knowledge UI
classifies those files as **Wiki**. Session memory, events, conventions and
internal state are different categories, not destinations for a Wiki import.
Saying "Wiki, not Memory" selects the shared knowledge category without changing
its canonical storage path. The coordinator can read/search it and delegate
edits; the alias does not grant new tool or workdir permissions.

**Link health** scans Project knowledge for broken references; missing,
unavailable, and out-of-catalog targets have different meanings. **Preview
Wiki repair** and **Confirm repair** act on one eligible Wiki file after
revision checks, replacing confirmed missing links with label text rather
than guessing a new target. Scans do not rewrite content. Knowledge lives in
the Project Home, not a session's remote workdir.

## Conversation and files

Press **Ctrl+N** (**Cmd+N** on macOS) in the project workspace to open a
new conversation draft in the current Project. If the selected conversation
belongs to a registered folder, the draft uses that same folder; otherwise it
starts **From scratch**. Opening a draft does not send a message or allocate a
session until the first send.

In the coordinator conversation, click the source session in a **Session
progress** message or the recipient in a **Message to** card to open that
conversation. Owned task/call executions open in the child pane; independent
sessions open as the selected conversation. Expanding message or tool details
does not navigate.

Text selection is opt-in across the web and desktop UI. Message bodies
(including streaming responses and expanded reasoning), tool arguments/results,
source and diff previews, knowledge/document content, and diagnostic details
remain selectable for copying. Navigation, buttons, tabs and disclosure headers
are not selectable. Text inputs and editable content retain normal selection
and editing. New reading surfaces should use the shared `selectable-text` class
on their content only; Markdown (`prose`), source blocks (`pre`) and definition
values (`dd`) already opt in. Nested controls stay non-selectable; use
`select-none` for non-content previews such as clickable file thumbnails.

Press **Ctrl+F** (**Cmd+F** on macOS), or use the conversation's search button,
to search message text across the entire conversation, including earlier
history segments. **Enter** / **Shift+Enter** moves between matches; **Esc**
closes search and restores keyboard focus. Matches are literal and
case-insensitive. Selecting an older match opens its segment and expands the
matching message; use segment navigation to return to the current conversation.
In a split view, the shortcut searches only the active conversation pane.
The search includes user/assistant message bodies, conversation summaries and
command output, not reasoning, tool arguments/results, attached file contents,
other conversations or diagnosis/file tabs. History loading failures are shown
with a retry action rather than presenting partial results as a complete search.

The Files explorer uses the conversation's effective workdir; Project
coordination and local learning runs browse the Project Home instead. A remote
workdir does not fall back to Main's filesystem. File tabs support source
previews and, for supported Git folders, a read-only **Changes** view. Git
inspection does not stage or commit changes. Files can be quoted into the
current conversation without sending a new message.

File tabs use [Open File Viewer](https://github.com/xushanpei/open-file-viewer)
for four groups: PDF/Office (including EPUB/OFD/XPS), Engineering (CAD, 3D,
drawings and GIS), Email, and Assets/Data. Image/media and text/code SDK
plugins and the XMind plugin are not registered; standalone files keep Shadow's
existing image, media, text, Markdown and HTML views.

Right-click a file, folder, or search result (or press Shift+F10 on a focused
row) to copy its full path or its path relative to the displayed workspace.
Electron also offers **Show in file explorer** for local files and folders;
this option is hidden in the web app, for remote workdirs, and for entries
inside archives. Clicking a file still opens its preview.

ZIP, 7z, RAR, TAR, GZIP, BZIP2 and XZ files expand in the file tree, including
compressed TAR containers (`.tar.gz`/`.tgz`, `.tar.bz2`, `.tar.xz`) and nested
archives. No archive is read until expanded. The first expansion fetches the
archive through its owning session/folder API and lists its metadata; inner
directories expand from that index, without extracting their files. Selecting
an entry fetches the archive again and extracts only that entry for the existing
file preview. Compressed TAR containers and solid archives may require decoding
earlier data to reach the requested entry; this is not HTTP range streaming.
Refresh invalidates expanded archive indexes. Path search searches workspace
files, not archive contents.

The locally bundled `7z-wasm` decoder runs in a disposable Web Worker; no native
7-Zip install, host extraction directory or external conversion service is used.
Production assets include its license, unRAR restriction and corresponding
upstream source/build links under `assets/7zip/`.
Collapsing a pending archive, changing source or leaving the view cancels its
operation. Limits are 128 MB per archive (also for decoded TAR containers),
32 MB per extracted entry, 50,000 directory entries, four member-path levels
and 30 seconds per decoder operation. Unsupported/encrypted files, links,
unsafe or ambiguous entry names and corrupt archives produce a retryable error.
The archive row's download action opens its download view. HTML and Markdown
entries show bounded source; linked workspace assets, quoting and image
annotation are disabled for archive members. Entry Blob URLs are released when
their preview is hidden or closed.

The pinned SDK patch removes its archive plugin from both ESM/CommonJS entry
points and declarations; pnpm overrides remove its exclusive `seek-bzip` and
`xz-decompress` dependencies. Keep that patch aligned when upgrading the SDK.
`jszip` and `pako` remain because Office and other registered viewers share them.
Production builds tree-shake the unregistered SDK plugin JavaScript and its
unused HEIC, HLS and Prism dependencies. Shared parsers remain where needed:
for example, Office uses the TIFF decoder for embedded PPTX images, and
Engineering uses Three.js. Installed transitive packages and the SDK's shared
stylesheet are not removed by JavaScript tree-shaking.
The SDK is loaded only when one of these files is opened. Files are read through
the owning session or registered folder API and passed to the viewer as local
bytes; no external document conversion service is configured. PDF workers,
fonts, CMaps and image decoders are bundled locally, including for the desktop renderer.
Existing text selection/quoting, Markdown, HTML, image annotation and media
controls remain unchanged; CSV/TSV continue to use the source preview. Viewer
chrome follows Shadow's theme, square controls, focus treatment and selected
rows; authored document fonts, colors, diagrams and map tiles are not recolored.
The extra formats are read-only previews, not editors, and do not support
Shadow's text quotes or image annotation. Rendering fidelity varies by format;
some proprietary formats provide only metadata or partial previews. DXF and
supported engineering formats use the built-in renderer; no optional high-fidelity
DWG engine or LibreDWG WASM is installed, so DWG may show only metadata. Multi-file
model references are not integrated. GIS is enabled and uses upstream Leaflet
stylesheet resources from jsDelivr and OpenStreetMap tiles; these requests expose
the viewed map area to the tile provider. The viewer displays a notice for GIS.
Files themselves are still read through the owning Shadow API. Failed
previews expose a retry action; **Download** always retains the original file.
Unavailable remote workdirs never fall back to Main's filesystem.

In a local web conversation, click the title or body of a file attachment card
(including agent `MEDIA:` output) to open the workdir file in a tab. Opening the
same file again selects its existing tab; **Download** remains a separate action.
Images retain their image viewer, and audio/video retain playback controls.
External URLs, private uploads outside the workdir, and remote attachments remain
on their existing media/download path rather than being treated as local files.

You can send follow-up guidance during an active turn or use **Stop request**
to cancel the targeted request. On desktop, **Enter** sends immediately,
**Ctrl+Enter** adds the message to the queue after the current turn without
interrupting or steering it, and **Shift+Enter** inserts a new line.
Holding **Ctrl** changes the send button to a distinct queue icon; clicking
it also queues the message. Queued messages remain after stopping a request.
On mobile, Enter keeps its native newline behavior; use the send button or
Ctrl/Cmd+Enter with a hardware keyboard.
Cancellation cannot undo completed side
effects. For stopped or interrupted work, **Continue** resumes from saved
history. Unfinished tools require acknowledgement because they may run again
and repeat side effects. Remote shell calls are different: Continue only
reconciles the Child's durable execution record. A missing or unavailable
receipt stays unknown and pauses the turn; it does not rerun that command.
Inspect partial effects before issuing a new execution request.
Unsent image edits and attachment selections are local draft state, not a
server-side backup.

Use **Diagnosis** for trace, current prompt, and tool details. The prompt shown
there is not a historical snapshot of every model request; for an export or
development capture, see [session diagnosis](diagnostics.md). Live updates
follow the [shared live transport](realtime-protocol.md); saved history remains
the source of truth after reconnection.

## Writing memory

Local sessions with the `write` tool, including Self reflection runs, can create
or overwrite Project wiki Markdown files at `v:memory/<group>/<name>.md`.
Use `match` and `content` for an exact edit after reading the file; ambiguous
matches require more context or `flag: "g"`. Virtual writes do not support append.
The destination is Project memory, independent of the session's working folder.
This does not grant the `write` tool to sessions that lack it.

Through this virtual entry point, `memory/sessions/`, `memory/events/`, hidden
state and non-Markdown files remain protected; use `log` to append events.
Remote-workdir and call-mode sessions retain their existing virtual-write
restrictions. These are entry-point checks, not an OS sandbox for host commands.

## Requests for input

Session details show cumulative reported token usage in two columns: **Total**
includes the conversation and all nested task/call agents; **Subagents** is the
delegated portion already included in that total. Compact token counts use
K/M/B units in both English and Chinese (for example, `12.3K` and `1.3M`).
All physical segments count,
even when viewing an older segment. Context usage remains the last reported
prompt size for the selected segment, not the cumulative total. Calls made by
Node `infer` and compaction also count. New model calls have independent durable
usage records in both JSONL and SQLite. Legacy calls with response IDs are
deduplicated; older snapshots without call identity retain one known call and
are labeled incomplete, as are calls whose provider did not report tokens.

The message box accepts pasted files as attachments, not just images. In the
Electron desktop app on Windows, copy one or more files in File Explorer and
paste into the message box. They appear in the attachment tray and are uploaded
only when you send. Plain text and text paths remain text; folders are not
attached. Native clipboard reads are limited to 100 files and 100 MiB in total.
Other desktop platforms support native file-URL clipboard lists when supplied
by their file manager; browser support depends on the files exposed by the paste
event. Local attachments are still unavailable for remote working directories.

When an agent asks a question in a direct web conversation, choose a suggested
option and **Continue**, or write your own answer in the ordinary message box
below the question. The box is explicitly labeled **Your answer** while a
user-directed question is pending; sending it answers that exact request,
not an ordinary chat message. Images, uploaded files, quotes, and local file
context use the existing composer controls. Images are delivered to the model
alongside the answer; file paths remain attached context. A response may also
consist only of attachments. **Ctrl+Enter** still queues a separate message
and does not answer the question.
Execution views without a message composer retain their dedicated
answer field (**Enter** submits; **Shift+Enter** inserts a new line). A
parent-directed request is read-only to the human and must be answered by the
parent session. The corresponding agent tools are `ask` and `reply`; there is
no `yield` tool alias. Where a channel cannot display native controls, use
`/reply <request-id> <choice>` or `/reply <request-id> text <response>`.
The default wait is indefinite; on timeout a decision can select its default,
but a plain input request fails rather than inventing an answer. These are
question workflows, **not permission or publication approvals**.

For tool discovery, skill editing, MCP configuration, and scheduled
conversations, see [tools and automations](tools-and-automations.md). For
publishing restricted conversation agents, see
[conversation agent authoring](agent-authoring.md). For project-owned bot
instances and QQ delivery limits, see [messaging channels](channels.md).

### Freeform questions in conversation history

An agent's `ask(kind=input)` appears as a separate **Question and answer** card
in the conversation. Reply using the existing message box; after a confirmed
answer receipt arrives, the card keeps the answer and its attachments beside the
original question. This is an information request, not a decision or permission
grant. User, parent-session and caller replies remain distinguished.

On refresh, cards are rebuilt from paired tool calls and results. Only a current
pending request shows a waiting state. A missing or unrecognized receipt means
**No confirmed answer**, not an active wait or success; explicit failure or
cancellation remains unconfirmed. Raw question records remain available in the
card disclosure. Historical records without a tool call in the loaded segment
are not reconstructed from a separate input-history service.

## Project usage statistics

Open **Project Dashboard → Usage** for Project-wide all-time, today, past-seven-day
and current-month tokens, estimated costs, and provider time. Daily details show
recent 31 calendar days (including inactive days) and older active dates, with bars
for known tokens. **Refresh** recomputes the statistics; opening this view does not
make model requests. The summary defaults to **Past 7 days**; choose a period to
update the four cards (tokens, estimated cost, model call time, and call count).
Large values are compact; hover a value for its precise known subtotal. Currency
and credit amounts stay on separate lines. The trend charts have their own **7/30
day** window, independent of the summary selection. **Data completeness** expands
missing-call counts and tracking coverage; **How usage is measured** expands the
statistical definitions below. Both are collapsed initially.

- All dates and boundaries use **UTC**. Seven days means today plus the previous six
  calendar dates, not a rolling 168-hour window. Events completed before the shown
  “as of” instant are included, and charged entirely to their completion date.
- Tokens and costs come from persisted `model_usage` source events, deduplicated
  across physical segments within each logical conversation. Project conversations,
  child calls and automations are included once; inherited assistant snapshots are
  not summed. No other Project's history is included.
- Costs reuse the provider/model estimates recorded at call time, not today's price
  list. They are not invoices; USD, CNY and AI credits remain separate. Unpriced or
  incompletely priced calls are marked partial. Missing estimates are not zero.
- Provider time is the sum of elapsed model-call durations, including failed calls,
  excluding tool execution, user waiting and persistence. Concurrent calls overlap,
  so this is **not elapsed Project work time**. New calls record duration in both
  JSONL and SQLite; older events without duration remain unavailable/partial.
- Values are known subtotals, not reconstructed historical bills. Historical
  sessions without source tracking, undated events and scans capped at 100,000
  source records are disclosed. Capped aggregates are lower bounds; calls without
  usage or duration remain unknown. Inactive dates with no recorded calls show
  no known token/cost/time value, rather than implying complete telemetry.

The Project-bound `GET /api/project/usage` endpoint requires the same context-read
permission as session profiles, rejects requests when authorization is unavailable,
forwards request cancellation, and returns `Cache-Control: no-store`. It accepts no
Project selector or pricing overrides. The gateway's existing Project route selects
the runtime; statistics are computed from that runtime's SessionManager/store.

### Daily usage pagination

The summary endpoint returns only the latest 31 UTC calendar dates for charts,
while cumulative totals still include historical source events. Daily history is
loaded only after **Load daily history**, via the context-authorized, Project-bound
`GET /api/project/usage/daily?page=1` endpoint (10 dates per page, newest first).
Completeness details use that same current page, never all history. Refresh and
Project switching clear the page. Page responses include total dates, hasMore and
snapshot asOf; no HTTP caching is permitted. Valid pages are decimal integers
1–100000; beyond-end pages are empty and have hasMore=false.

Aggregation still scans up to 100,000 source-log records, explicitly reporting
truncation. An in-memory snapshot per store/Project (up to eight Projects, 60-second
TTL) avoids rescanning source logs on every page. Refresh rebuilds it; expired
snapshots can shift pages as new records arrive. No persistent index/migration is
introduced. Recent zero-activity dates and older active dates comprise daily history.
