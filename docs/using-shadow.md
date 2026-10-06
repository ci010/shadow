# Using Shadow

Shadow is a personal, local-first agent. Its web UI and Electron window connect
to the same Node backend; Electron provides setup and native-window controls, not
a separate agent implementation. The [architecture reference](architecture.md)
explains the implementation and its limitations.

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
alongside Knowledge, project settings, agents and open files. **Coordinator**
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

There is no standalone **File changes** tab. Filesystem write history remains
recorded on the backend for future context-specific presentation, including
learning sessions that update memory. Records persist across restarts and session segments; a
fork's inherited parent conversation does not attribute the parent's writes to
the child. Direct writes and writes invoked through script tools are recorded.
Shell commands and virtual configuration/authoring transactions are not
filesystem write records.
If a file is written but saving its history fails, the turn stops with an
explicit error instead of automatically retrying and applying the write twice.

Older writes do not have complete before/after snapshots: an edit can retain its
requested replacement snippet, while an overwrite or append can retain only the
written content. These records identify their scope and never read the
current file to reconstruct history. Unreadable, oversized, or computationally
expensive diffs report their limit instead of inventing a diff. Stored previews
are bounded to 65,536 characters, with a 2,097,152-character input and 100 ms computation
limit; the history API returns pages of 30 writes. Todo/tool details, memory and
event-log presentation have not been redesigned as part of removing this tab.

Use the project's trash icon or **Project settings → General → Delete project**
to delete a non-Default project. Confirm by typing its name. Deletion removes
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

## Project knowledge

Use the book icon to open the current Project's **Knowledge** tab without
leaving the conversation. It browses memory files, Wiki pages, and effective
skills, and shows explicit references between entries; a graph edge is not a
semantic inference. Built-in skills are read-only. Deleting an entry removes
only that file, not its incoming references or already-loaded instructions.
Agent learning can later recreate deleted knowledge.

**Link health** scans Project knowledge for broken references; missing,
unavailable, and out-of-catalog targets have different meanings. **Preview
Wiki repair** and **Confirm repair** act on one eligible Wiki file after
revision checks, replacing confirmed missing links with label text rather
than guessing a new target. Scans do not rewrite content. Knowledge lives in
the Project Home, not a session's remote workdir.

## Conversation and files

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
drawings and GIS), Archive/Email, and Assets/Data. Image/media and text/code SDK
plugins and the XMind plugin are not registered; standalone files keep Shadow's
existing image, media, text, Markdown and HTML views. Common archive entries use
a small browser-native image/media and bounded plain-source preview instead of
loading a second syntax-highlighting or image-conversion engine.
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
history; a tool call without a saved result might run again after a crash.
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
