# Shadow

Shadow is a personal LLM agent with persistent sessions, tools, memory, reusable
skills, subagents, messaging integrations, and a Vue web UI. It runs on **Node.js**
and can be hosted inside an **Electron** desktop application.

**Multi-device infrastructure is work in progress.** Main/Child runtime roles,
pairing, execution capabilities, and product UI scaffolding exist, but they do
not imply a production-ready distributed system.

## Organizations

Organizations are persistent ownership boundaries, not just sidebar folders.
The sidebar shows multiple organization groups together: **there is no global
organization switcher**. Their conversations, bots, and background runtimes can
run concurrently; selecting a conversation does not retarget another group's
work. Each group has projects, retained **Start from scratch** chats, and
**Self reflection** activity.

Each organization owns its Home, sessions, context, memory, identity/Soul,
workspace skills and agent overrides, learning, bots, and diagnostics.
**Self reflection** is a UI grouping within that ownership boundary, not a
separate organization. A session belongs to one organization and at most one
folder project. Local folder registration rejects another organization's folder
and overlapping parent/child paths; project code stays in its original folder.
Agent messaging, forks, and delegation cannot target another organization's
sessions. This is application data/context isolation, **not an OS sandbox**:
`exec`, imported code, and MCP still have the backend user's host permissions.

Provider connections/credentials and device pairing remain App-wide.
Organization settings (the gear beside its name) control **General**, **Models**,
**Bots**, and **Learning**. Model defaults/parameters are independent per
organization; conversation overrides remain local to that conversation.
Changing shared provider credentials does not overwrite other organizations'
model preferences. A failed organization reports its own startup error with
**Retry organization startup**; healthy organizations remain usable.

The Organizations sidebar resizes from its right edge (or with arrow keys on
the resize handle) and collapses into a narrow organization-icon rail. Width
and collapsed state are remembered on this installation. Selecting a rail icon
expands that organization's group without changing the current conversation.

Use a folder row's **...** menu, or right-click the row, to **Remove folder**
or **Move to organization...**. Both actions change membership only: they never
move or delete files on disk. Existing conversations, memory, and learning stay
in the original organization; those conversations lose access to that folder.
The destination starts with a new project identity, not transferred history.
Stop active work in the source organization first; busy checks conservatively
cover the whole source organization. Overlapping folder ownership and remote
jobs whose termination is unconfirmed can also block the change. Unconfirmed
remote jobs remain blocked across restart; automatic recovery is not yet
implemented. These controls do not delete or merge organizations.

### Existing data and storage

At first startup, the stopped legacy Home is copied and verified into the
renameable **Default** organization (`default`); old Home content, session
history/IDs, memory, learned skills/identity, learning watermarks, and legacy bot
configuration are retained there, not copied into every new organization.
JSONL and SQLite session metadata receive the organization identity without
regenerating conversation history. Fresh organizations start without inherited
memory or bots, using shipped built-in skills/agent definitions.

The actual host storage root is a **sibling** of the configured legacy Home:
`${legacyHome}.organizations`. Each organization uses
`organizations/<id>/workspace` under that root, with adjacent
`config/organization.json` and `config/bots.v1.json`. The original Home is **not
deleted**; shared provider credentials and the device registry retain their
existing locations. Stop legacy writers before migration and back up real data.
External symlinks/junctions inside Home are unsupported by automatic migration:
startup stops for manual review rather than following them or silently dropping
content. Conflicting targets, invalid recovery metadata, or a changed source
also require review; do not delete the original Home or migration metadata to
bypass the error. See [organization storage and routing](docs/architecture.md#organizations-ownership-storage-and-routing)
for the layout and recovery boundary.

Organization content requests use `/organizations/<id>/` plus their existing
`api/...` or `v1/...` suffixes. The App catalog is `/api/organizations`; shared
provider/device routes remain at the root. Unscoped legacy content routes always
refer to **Default**, never whichever conversation happens to be visible.

**Remote organization projects:** an updated Child advertising `workdir.identity`
can verify and register its selected folder in the owning organization before
the first session is created. Main checks Child-reported directory/ancestor
identities, never canonicalizing a remote display path on Main. Another
organization cannot claim an identical, aliased, or overlapping folder on that
node. Existing migrated remote sessions retain their capability references and
reserve ownership for Default; those reservations must be verified before new
projects are opened on the same node.
Registration and access to registered projects revalidate every saved claim and
project on that device. An unavailable or retargeted **other** saved capability
can therefore also block opening a new session in an existing project or reading
its project resources. Ownership checks intentionally fail closed: restore and
revalidate the affected capability, not a Main-local fallback. Existing session
records remain preserved.

Older Children without this operation return
`409 remote_workdir_identity_unsupported` with `upgrade_node` for new project
actions; existing remote sessions retain their supported execution paths.
An unavailable device/workdir returns `503 remote_workdir_unavailable`.
Update Main and Child, then reconnect. The Mac/WSL SSH test environments also
need that Child rollout; they are not portable, autostart-capable releases.
Passing native tests does not upgrade or restart already-running Child processes.
Remote project listings, UTF-8 text previews, and Git inspection use the owning
Child. Raw/static remote media remains unsupported (`501`), as does remote
cloning. These additions do not complete distributed release hardening.

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

## Electron

```sh
pnpm desktop:dev
pnpm desktop
```

The development command builds the backend and Electron main/preload, starts
Vite, and launches Electron. The packaging command additionally builds the
production UI and creates a Windows NSIS installer in `desktop/release`.

Desktop development uses a separate profile at `.tmp/desktop-dev/user-data` in
the worktree, rather than the installed application's profile. An absolute
`SHADOW_DESKTOP_USER_DATA` path can override it. In packaged applications, the
Main directory defaults to the OS home directory's `.shadow` folder (shown as
an expanded path); it can be edited or selected with Browse. Existing saved
Main directories are preserved. Development instead defaults Main to
`.tmp/desktop-dev/data` to avoid using personal data during smoke tests. The
absolute `SHADOW_DESKTOP_DEV_MAIN_DIRECTORY` override applies only to development.

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
Saving updates the shared provider connection; organization model defaults are
managed separately. A card marked **Configured**
means settings exist, not that its connection has been checked.

**Organization settings → Bots** configures **QQ, Feishu, and Discord** bot
instances. An organization can have several bots on the same platform, each with
its own name, credentials, sender policy, and runtime lifecycle. Each bot shows
configuration and runtime status separately, with
setup instructions, **Save and connect**, **Connect**, and **Disconnect** actions.
Advanced settings include sender allowlists and trusted admin group IDs. Saved
credentials are never returned to the form; leave a password field blank to keep
its existing value. Changes are saved on Main, not in browser storage. Only Main
administrators can manage these settings. Bot setup remains accessible before
a model provider is ready; answering messages still requires a working provider.
Legacy WeChat/iLink adapters are not started by organization runtimes; their
retained configuration is not a connected bot. Old `/providers` links
redirect to `/settings/providers`; `/settings/channels` opens Default's Bots.
QQ and Discord show **Connected** only after gateway readiness. Feishu shows
**Running · connection unverified** because its SDK cannot confirm readiness to
the UI. A saved configuration is not proof that platform credentials, event
permissions, or message delivery work. Editing configuration outside Channels
may require reapplying it here or restarting Main.

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
High, XHigh, Max**, plus **Default** to inherit organization settings. Explicit levels
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
Unset controls inherit configuration, then DeepSeek's enabled/high defaults.
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

The composer exposes **Stop request** while a request is being prepared or is
running. Stop cancels the targeted request through the session's provider/tool
abort path, rather than merely hiding streamed output. A late cancellation
cannot stop a newer request; other queued messages are preserved. Pending
cancellation and failures remain visible. Cancellation is cooperative: it does
not undo completed side effects, and non-cooperative tools can delay cleanup.

Stopped, failed, or restart-interrupted conversations show a **Continue** banner
above the composer. It continues from saved history instead of resending the
original message. Restart recovery marks interrupted work but does not start a
model request until you choose Continue. Saved tool results remain intact;
missing results are marked as unknown outcomes, not replayed automatically.
External effects whose results were not saved cannot be guaranteed exactly-once.
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
On desktop, Projects can collapse into a 64px icon rail. Root projects and chats
show component-based information cards on hover or keyboard focus, including
conversation navigation and new-conversation actions. Expanding restores the
previous sidebar width. Narrow-screen project drawers remain full-width.
Tree information and file navigation hints use these components, not native
browser title tooltips.
Conversation information cards clamp long titles and descriptions without
changing saved text. **Self reflection** groups reflector and soul-reflector
sessions, including their descendants, separately from projects and Chats.
The section starts collapsed in both the full sidebar and icon rail; session
refreshes preserve the user's expansion choice and do not insert loading rows
above existing conversations.
For local Self reflection sessions and their descendants, the file browser
shows **Home**, not the session's managed workdir. Listing, previews, downloads,
and Git Changes share that root; this does not change the agent's execution cwd.
Quotes from Home use absolute source paths. Remote or unavailable workdirs never
fall back to local Home.
Switching between reflector sessions retains the loaded Home tree and nested
expansion state while validating the next session's browsing root. Rows cannot
be opened during that check. Only a confirmed matching local Home reuses the
tree; another root, Main, project, or remote workdir never shares its identity.
Failed validation clears the retained rows and reports an error.

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
Project drafts prominently show the folder name and path above the input;
scratch drafts explicitly say that no project folder is selected.
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
The composer has one compact model button showing the model and effort. Its menu
contains only **Model** and **Effort**; each opens a submenu in the same popover.
Model retains searchable options, provider labels, and the current selection
marked. Back/Left returns to the two-row menu; Escape returns from a submenu,
then closes the menu. Model selection is scoped to the conversation/draft;
organization defaults are available in Organization settings → Models.
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
overrides and uses organization settings. Model support still applies; provider
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

Frontend UI uses square corners, except for the circular mouse highlight and send button. The radius tokens in
`app/src/styles.css`, including controls, surfaces, overlays, badges, and
indicators, are all zero; UnoCSS rounded utilities use those same tokens.
This does not restyle native operating-system windows or sandboxed file content.
Conversation events, tool activity, and assistant replies share one responsive
maximum-width constraint rather than letting event bars span the entire pane.

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
Except for Self reflection's Home view, Files shows the current effective workdir of that logical session, including when
Conversation displays an older segment. Its root label shows the directory name;
hover or focus it to see the backend-resolved full path, including for empty
directories. Empty directories have no placeholder row. Folder conversations browse their registered project directory,
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
project drafts. Project drafts browse the registered folder by project ID,
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
Select a timing bar to inspect attributes, errors and matched tool results.
Zoom and pan the overview to inspect dense activity; parallel calls occupy
separate tracks. Turns and tool-call details can be folded in bulk, and search
matches all entered terms across text and metadata. The expandable all-spans
list includes nested execution spans.

Execution timing is fetched from `GET /organizations/<id>/v1/query/session-spans` with an exact
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

Each organization's Projects **+** menu contains **Open folder**, **Open remote folder**,
**Clone repo**, and **Start from scratch**. Open remote folder opens a new draft
with the remote-device picker already open. Choose a connected Child's advertised
workspace; selection does not create a session before the first send. It does not
register arbitrary paths on another machine. On send, Main verifies the Child's
folder identity and registers the project in that organization; unsupported
Children or ownership conflicts return an explicit error rather than using Main.
Open folder registers an existing directory using
Electron's native folder picker (the browser accepts an explicit Main-local path).
Registered folders remain visible when empty. Each folder's own **+** opens a
draft associated with that project. Its session is created on the first send;
filesystem tools and shell then use that folder as their working directory.
Collapse a folder to hide its conversations.

Projects, conversations and files use the shared `TreeRow.vue` component for
single-line labels, 12px nesting, 16px icons, disclosure and selected/focused
states. Conversation descriptions remain in the row tooltip. Project/session
disclosure buttons stay separate from selection; file folders toggle when
their row is activated. The shared row supplies icon, metadata and action slots;
each caller retains its own data loading, lineage and actions.

**Subagent execution modes.** `agent_type` selects the role and tool constraints;
`mode` selects the execution contract independently:

| Mode | Initial `task` | Context and result |
| --- | --- | --- |
| `session` | Optional | Reusable independent conversation; use `message` for later assignments. |
| `task` | Required | One independent assignment, started on creation; completion is reported asynchronously. |
| `call` | Required | A snapshot of the caller's context; blocks that caller and returns the final result through the original tool invocation without copying back the internal trace. |

For example, `subagent(mode="task", agent_type="verify", description="Verify the fix",
task="Check the original acceptance criteria against the changed files.")` starts
verification directly; a separate initial `message` is unnecessary. Session
creation without a task remains supported. A call without `agent_type` inherits
the caller's role; selecting a mode does not grant additional tool capabilities.
Session/task creation is asynchronous: initial tool results acknowledge admission,
not model completion. The parent can continue independent work or finish its turn;
completion arrives as an event. Calls instead wait for the final result, without
a separate completion event. `report_to` can redirect session/task completion only.

Delegation follows a runtime-enforced hierarchy, further narrowed by role tools:
root sessions may create session/task; reusable sub-sessions may create task/call;
tasks may create only call; calls cannot delegate. Root versus sub-session refers
to delegation ownership, not the agent type's `root` visibility flag.

Calls cannot yield, send session messages, or schedule deferred coordination.
When a call needs input or permission, it returns a blocker with any partial work
and side effects; the caller decides or yields and can issue a new call. Cancelling
the caller cancels its blocking call. This does not roll back external side effects.

Only reusable `session` children request a native platform thread/topic, and only
when the connected adapter verifies that the destination supports it. Tasks and
calls never create native threads. If an external channel cannot create a thread,
the child uses an internal virtual session instead of sending to a made-up platform
address; the browser still keeps reusable children in its conversation tree.
Platform thread placement never widens delegation permissions.

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
`POST /organizations/<id>/api/sessions/remote` with
`{"nodeId":"child-id","capabilityId":"workdir-id"}`.
This verifies remote folder ownership and creates or reuses the organization's
project before creating the conversation. An optional UUID `requestId` makes
retries refer to the same conversation; reusing it for a different capability
returns a conflict. The unscoped legacy endpoint targets Default.
For an already registered project, first send instead uses
`POST /organizations/<id>/api/projects/<project-id>/sessions`, also accepting
an optional UUID `requestId` (an empty body remains supported). Remote projects
revalidate their saved folder identity; retries reuse the conversation rather
than selecting a new capability, and a request ID owned by another project is
a `409` conflict.
It accepts only an online workdir capability, not an absolute/display path, and
returns `projectId`, `sessionId`, and `chatId` for the normal scoped chat endpoints. Its durable workdir
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
Update both Main and Child to use the `none` approval-policy contract; older
Child versions may still require their legacy local approvals.

For a blocked call outcome, the model returns raw JSON without Markdown fences:
`{"status":"blocked","reason":"Missing decision or permission","partialWork":"Actions already taken and side effects"}`.
For a failed outcome, it returns `{"status":"failed","error":"Failure, partial work and side effects"}`.
These produce explicit blocked/failed call receipts rather than an apparent success.
Normal successful calls may return their answer as text.

Reusable child sessions remain in the conversation tree. Delegated tasks and calls
appear inline at their native `subagent` tool calls, starting before the tool
receipt arrives, with inspectable nested history rather than additional permanent
chats. Parallel calls are paired by tool-call ID, not arrival order or description.
Task completion is pushed into the conversation as an event with its result body
expanded; raw event metadata stays under Event details. Reopening the conversation
renders the same persisted event. A blocking call renders its returned result in
its original card, without a separate completion event. System self-reflection retains its
dedicated section. An asynchronous task does not make an idle parent appear busy;
a caller awaiting a blocking call is explicitly waiting rather than thinking or
waiting for human input. Call traces remain available for diagnostics, but only
the final result crosses the caller's context boundary.

Agent definitions can set `defaultMode: session|task|call`. The old `ephemeral`
frontmatter is accepted with a deprecation warning (`true` maps to `task`, `false`
to `session`); replace it instead of supplying both fields. Existing session
history remains readable. Safety guidance applies in every mode; `soul: false`
can explicitly omit SOUL context without changing execution lifetime.
Root callers may omit `mode` only when the selected role's default is allowed.
Sub-sessions and tasks must select `mode` explicitly; invalid choices fail rather
than silently changing execution behavior.

**Yield decisions.** The `yield` tool pauses the current tool call with exactly
three options and one default. Root sessions ask the human; subagents ask their
stored parent, independently of `report_to`. The parent answers through the same
tool using `action: "answer"`, `request_id`, and an exact `option`; an ordinary
message does not resolve the request. Built-in agent types include this tool;
custom parents must enable it or the child receives an explicit error. Call mode
removes yield regardless of the role definition.

In the conversation UI, the default is preselected but not automatically
submitted. Parent-directed questions are read-only to the human. Discord and Feishu
use native choices when supported by the current connection; a failed native send
falls back to `/yield <request-id> <1|2|3|cancel>` text instructions. QQ and iLink
currently use that text form. Questions are sent separately from progressive
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
Internal capability IDs and unconnected approval policies are not shown.

The composer's **+** menu offers **Add file** and **Add folder** in the local Main
desktop app. Native pickers support multiple selections; removable chips show
the selected context before sending. These are local path references included
in the message, not file uploads, recursive folder imports, or a change of
working directory. Reading them still uses the agent's filesystem tools and
their existing access controls. Native context selection is unavailable in the
browser and on Child installations; it does not imply remote file-transfer support.

Folder registrations persist in `<workspace>/projects.v1.json`; session
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
shipping the entire collections.

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

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Backend and Vite together |
| `pnpm start` | Backend without watch or inspector |
| `pnpm build` / `pnpm build:app` | Backend / web build |
| `pnpm build:all` | Both production builds |
| `pnpm test` | Backend, script, and frontend logic tests using Node's test runner |
| `pnpm test:desktop` | Electron lifecycle and bootstrap tests |
| `pnpm test:packaged` | Exercise a built Windows package after relocating it outside the repository |
| `pnpm typecheck` | Backend/scripts and desktop TypeScript checks |
| `pnpm desktop:dev` / `pnpm desktop` | Desktop development / Windows installer |
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
only matching tools' exact names and complete schemas (default 3, maximum 10).
Use `space: "tools:mail"` to select a source. Empty, whitespace or omitted query
lists tools in stable name order; pass `nextOffset` as `offset` to get the next
page (`null` means the end). The same `search` tool retains grep:/glob:/web:;
there is no separate tool-discovery function in the base tool list.
It uses keyword ranking, not embeddings. Search discovers metadata from
configured servers without executing their tools. Failures and deferred
browser/factory sources are explicit; select a deferred source to initialize it.
`read("v:tools")` remains a connection-free source listing.

Use `invoke_tool({name, args})` directly for a known tool ID. It connects lazily
and validates arguments against the current schema before execution, with no
separate import/disclosure round trip. Invalid arguments return the target
tool's contract without executing. Changed configuration/tool listings invalidate
old adapters; sleeping clears session imports, which known IDs can recreate.
There is no persisted "schema already seen" flag. Skills remain optional workflow
guidance, not a prerequisite for search or invocation.

Both main configuration and imported MCP JSON accept `type` or `transport`
(`stdio`, `sse`, or `streamable-http`); conflicting values are rejected. Standard
`mcpServers` JSON imports all entries by default, or selects one with the
`import_tool` `server` argument. Extra CLI arguments apply only to stdio servers.
HTTP transports accept configured headers, but do not automate OAuth login.
Keep credentials out of committed configuration.

Import failures return a structured `mcp_error` diagnostic, including the failure
phase, available HTTP/RPC/OS codes, sanitized causes, and whether retry or user
help is appropriate. Tool discovery no longer silently reconnects and hides the
first failure. Agents are instructed to make only bounded recovery attempts and
ask for specific help when authentication, permissions or repeated failures
require it. This does not automate credential changes or retry tool side effects.

`import_tool` remains available for JSON/script imports and custom connection
arguments, but loading an entire server is no longer the normal discovery path.
MCP calls preserve structured results, error flags, and non-text content blocks
as JSON when needed. These are still textual tool results, not native model
image/audio attachments. Valid JSON text has Unicode string escapes normalized
for readability, without changing values, numeric literals or nested strings
such as `rawResponse`. Existing stored traces are not rewritten.
See the [architecture reference](docs/architecture.md)
for session lifetime and execution boundaries.

## Existing cron jobs

The Node scheduler uses standard cron weekdays: `0` (or `7`) is Sunday,
`1` is Monday, and names such as `SUN` and `MON` are supported. Deno used
`1` for Sunday, so old expressions must not be reused without review.

Cron storage now has the shape `{ "version": 1, "jobs": [...] }`. Startup
rejects the old unversioned array in `<workspace>/.cron/jobs.json` without
executing or overwriting it. Before upgrading an existing workspace, move that
file to a backup, then recreate the schedules with the cron tool after confirming
their weekdays and timezone. Do not simply wrap the old array in the new format.
There is no automatic conversion or Deno scheduling compatibility layer.

## Gateway and trust boundary

| Path | Purpose |
| --- | --- |
| `/api/*` | Configuration, sessions, providers, web chat, and runtime APIs |
| `/v1/traces`, `/v1/logs`, `/v1/metrics` | OTLP/HTTP JSON ingest |
| `/v1/query/*` | Stored telemetry queries |
| `/v1/stream/{spans,logs}` | Live telemetry over SSE |
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
