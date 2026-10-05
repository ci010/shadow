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
sent. Project coordination opens by selecting the Project name; folder and
conversation rows open their own views. **Automations** lists scheduled tasks
that start fresh conversations, with their run histories.

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

You can send follow-up guidance during an active turn or use **Stop request**
to cancel the targeted request. Cancellation cannot undo completed side
effects. For stopped or interrupted work, **Continue** resumes from saved
history; a tool call without a saved result might run again after a crash.
Unsent image edits and attachment selections are local draft state, not a
server-side backup.

Use **Diagnosis** for trace, current prompt, and tool details. The prompt shown
there is not a historical snapshot of every model request; for an export or
development capture, see [session diagnosis](diagnostics.md). Live updates
follow the [shared live transport](realtime-protocol.md); saved history remains
the source of truth after reconnection.

## Requests for input

When an agent asks a question, answer the pending request in its separate
control, not by sending an ordinary chat message. Decisions offer suggested
choices and a custom-response field; plain input requests ask for text. A
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
