# Project Quick Actions

Quick Actions are project-owned, reusable command buttons. Open an existing
conversation and use **Actions** beside conversation Search. Actions are
not attached to that conversation: each definition saves an explicit registered
local Folder as its execution target. Switching chats does not change that target.
There are no Quick Action launch icons on Folder rows.

## Create and pin

Create an action with a name, command, and target Folder, or discover scripts
from that Folder's root `package.json` and import the ones you want. Discovery
only lists candidates; it neither creates buttons nor starts commands by itself.
Imported scripts run through the declared `packageManager` (`npm`, `pnpm`, `yarn`,
or `bun`) using `<manager> run <script>`, preserving that runner's script environment
and lifecycle behavior. Without a supported declaration, discovery uses an
unambiguous lockfile in the target Folder; absent or conflicting lockfiles fall
back to npm. Runner names are allowlisted; package metadata is never executed.
Unusual script names that cannot safely be used in the command are reported as
unsupported. No runner or package installation is performed automatically.

You can also save an ordinary CLI command directly, for example `pnpm run build`
or `node scripts/check.cjs --verbose`; an action need not be a package script.
Commands use the host's default managed shell (`sh` on POSIX, `cmd` on Windows)
and inherited backend environment/PATH, not an interactive terminal profile.
The selected CLI must already be installed and reachable by that backend.

Pin an action to show the same definition on the Project Board. Editing or
unpinning it changes the shared definition, not a separate Board copy.
Actions can be edited and deleted from the conversation entry point.

## Agent management

Eligible owning local durable Web sessions can import `project_action` through
tool discovery to list actions, discover package scripts, create definitions, patch
them, or delete them. This is the same Project catalog used by the UI. Saving an
action does not execute it. The tool is not available to managed conversations,
remote working directories, temporary calls, or sessions from another Project,
and exposes no run operation. There is no automatic background import of every
repository script.

## Run and stop

Review the saved command and target before confirming execution. A run starts a
managed host command directly, without asking a model to interpret the action or
creating an Agent conversation. It has the backend user's host permissions;
Project scoping is not an OS sandbox. Treat imported scripts as repository code,
not as inherently safe commands.

The UI shows running/stopping/succeeded/failed/stopped status, stdout/stderr, and
Stop for ongoing runs. Logs are bounded and refreshed while the panel is active.
Deleting an action does not automatically stop a run that has already started.
Definitions persist in the Project Home; current run history and process handles
are in memory. Restarting the backend does not rerun saved actions, and Project
shutdown stops its active action processes.

The initial implementation supports registered **local** folders only. Remote
folder display paths must not be executed or inspected on Main. Remote Windows
folders and LayerFS folders are not supported by this execution route; they are
rejected rather than falling back to Main. Main coordinator-only mode also denies
local runs. It does not yet provide multi-folder workflows or automatic service-URL
discovery.

## Stable conversation Search

Conversation Search is an overlay below the conversation toolbar. Opening or
closing it does not reserve space above the message view or resize the message
viewport. Search still supports full conversation history and match navigation;
navigating to a match intentionally scrolls the conversation. Escape or clicking
outside dismisses the overlay. Search and Quick Actions do not remain open over
one another.

## API and storage

Owner-authorized endpoints live under /projects/:projectId/api/actions.
GET lists definitions; POST creates; PATCH/DELETE /:id update/remove.
GET /scripts?folderId=... discovers package-script candidates and their runner. POST /:id/run starts a
run, GET /runs or /runs/:runId reads state and logs, and POST
/runs/:runId/stop stops it. Definitions are stored as the versioned
user-actions.v1.json in the owning Project Home, never in a selected repository.

Runs retain up to 128,000 characters per output stream, up to 100 total
run records after completed records are evicted (active runs are not evicted),
and allow at most 20 concurrent starts/runs.
The catalog permits at most 500 definitions. These are initial implementation
limits, not a job queue or durable execution journal.
